'use strict';

const redis = require('redis');
const config = require('./config');
const { HashRing } = require('./ring');

/**
 * Distributed cache layer.
 *
 *  - N logical Redis nodes (default: three DBs on one Redis) sit behind a
 *    consistent-hash ring. We hash the PREFIX, not the whole cache key, so a
 *    prefix's "basic" and "trending" entries always live on the SAME node and
 *    can be invalidated together in one hit.
 *  - Key layout:  suggest:<mode>:<prefix>  ->  JSON array of top-10 suggestions.
 *  - GRACEFUL DEGRADATION: every Redis call is wrapped in try/catch. If a node
 *    is down (or Redis isn't even installed) we record a miss and return null,
 *    so the read path quietly falls back to SQLite. The system slows, it never
 *    breaks — which is exactly what a cache should do.
 */

const ring = new HashRing(config.REDIS_NODES.map((n) => n.id), config.VNODES_PER_NODE);
const clients = new Map(); // id -> { client, node, ready }
const stats = {}; // id -> { hits, misses }

const keyFor = (mode, prefix) => `suggest:${mode}:${prefix}`;
const ownerId = (prefix) => ring.getNode(prefix);

async function connect() {
  await Promise.all(
    config.REDIS_NODES.map(async (node) => {
      stats[node.id] = { hits: 0, misses: 0 };
      const client = redis.createClient({
        socket: {
          host: node.host,
          port: node.port,
          connectTimeout: 1000,
          reconnectStrategy: (retries) => Math.min(retries * 200, 2000),
        },
        database: node.db,
        // With offline queueing disabled, commands to a down node reject
        // immediately instead of piling up — so get()/set() fall straight
        // through to SQLite rather than hanging the request.
        disableOfflineQueue: true,
      });

      const entry = { client, node, ready: false };
      clients.set(node.id, entry);

      client.on('error', () => {}); // swallow — we degrade, we don't crash
      client.on('ready', () => { entry.ready = true; });
      client.on('end', () => { entry.ready = false; });

      // A down node would make connect() hang forever (it keeps retrying), so
      // we cap the initial wait and carry on in degraded mode. The client keeps
      // trying in the background and flips back to ready when Redis returns.
      client.connect().catch(() => {});
      await Promise.race([
        new Promise((res) => client.once('ready', res)),
        new Promise((res) => setTimeout(res, 1500)),
      ]);
    })
  );

  const up = [...clients.values()].filter((c) => c.ready).length;
  console.log(
    `Cache: ${up}/${config.REDIS_NODES.length} node(s) connected` +
      (up === 0 ? ' — DEGRADED mode, all reads fall back to SQLite.' : '.')
  );
}

async function get(mode, prefix) {
  const id = ownerId(prefix);
  try {
    const raw = await clients.get(id).client.get(keyFor(mode, prefix));
    if (raw == null) {
      stats[id].misses++;
      return null;
    }
    stats[id].hits++;
    return JSON.parse(raw);
  } catch {
    stats[id].misses++; // node down → count as a miss
    return null;
  }
}

async function set(mode, prefix, suggestions) {
  const id = ownerId(prefix);
  try {
    await clients.get(id).client.set(keyFor(mode, prefix), JSON.stringify(suggestions), {
      EX: config.CACHE_TTL_SECONDS,
    });
  } catch {
    /* best effort; the TTL and re-computation are the backstops */
  }
}

/**
 * Drop the cached entries for a set of prefixes (both modes). Keys are grouped
 * by owning node so each node receives a single DEL command.
 */
async function invalidate(prefixes, modes = ['basic', 'trending']) {
  const byNode = new Map();
  for (const p of prefixes) {
    const id = ownerId(p);
    if (!byNode.has(id)) byNode.set(id, []);
    for (const m of modes) byNode.get(id).push(keyFor(m, p));
  }
  await Promise.all(
    [...byNode.entries()].map(async ([id, keys]) => {
      try {
        if (keys.length) await clients.get(id).client.del(keys);
      } catch {
        /* TTL is the backstop */
      }
    })
  );
}

// Powers GET /cache/debug — which node owns a prefix, and is it cached there?
async function debug(prefix, modes = ['basic', 'trending']) {
  const id = ownerId(prefix);
  const { node } = clients.get(id);
  const out = { prefix, owner: { id, host: node.host, port: node.port, db: node.db }, state: {} };
  for (const m of modes) {
    try {
      out.state[m] = (await clients.get(id).client.exists(keyFor(m, prefix))) ? 'hit' : 'miss';
    } catch {
      out.state[m] = 'node-down';
    }
  }
  return out;
}

function getStats() {
  let hits = 0;
  let misses = 0;
  const perNode = {};
  const vcounts = ring.vnodeCounts();
  for (const [id, s] of Object.entries(stats)) {
    hits += s.hits;
    misses += s.misses;
    const entry = clients.get(id);
    perNode[id] = {
      host: entry.node.host,
      port: entry.node.port,
      db: entry.node.db,
      status: entry.ready ? 'up' : 'down',
      hits: s.hits,
      misses: s.misses,
      vnodes: vcounts[id] || 0,
    };
  }
  const total = hits + misses;
  return {
    hitRate: total ? Number((hits / total).toFixed(4)) : null,
    hits,
    misses,
    total,
    vnodesPerNode: config.VNODES_PER_NODE,
    perNode,
  };
}

async function quit() {
  await Promise.all(
    [...clients.values()].map(async (e) => {
      try {
        await e.client.quit();
      } catch {
        /* ignore */
      }
    })
  );
}

module.exports = { connect, get, set, invalidate, debug, getStats, quit, ownerId, ring };
