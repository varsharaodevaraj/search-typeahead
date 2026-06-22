'use strict';

const db = require('./db');
const cache = require('./cache');
const trending = require('./trending');
const metrics = require('./metrics');
const { normalize } = require('./normalize');
const config = require('./config');

/**
 * Read path — CACHE-FIRST.
 *
 *   1. normalise the prefix
 *   2. look up  suggest:<mode>:<prefix>  on the prefix's cache node
 *   3. HIT  -> return immediately (sub-millisecond)
 *      MISS -> compute from SQLite (basic = by count, trending = decay + blend),
 *              write the result back into the cache, then return
 *
 * Empty/missing prefixes short-circuit to an empty list with no DB or cache work.
 */
async function suggest(rawPrefix, mode = 'trending') {
  const t0 = process.hrtime.bigint();
  const prefix = normalize(rawPrefix);
  mode = mode === 'basic' ? 'basic' : 'trending';
  const node = cache.ownerId(prefix);

  if (!prefix) {
    return { query: '', mode, cache: 'skip', node, count: 0, suggestions: [] };
  }

  // 1) cache
  const cached = await cache.get(mode, prefix);
  if (cached) {
    metrics.recordSuggest(elapsedMs(t0), true);
    return { query: prefix, mode, cache: 'hit', node, count: cached.length, suggestions: cached };
  }

  // 2) miss → source of truth
  const suggestions =
    mode === 'basic'
      ? db.suggestByCount(prefix, config.MAX_SUGGESTIONS).map((r) => ({ query: r.query, count: r.count }))
      : trending.rankPrefix(prefix);

  // 3) refill (best effort)
  await cache.set(mode, prefix, suggestions);

  metrics.recordSuggest(elapsedMs(t0), false);
  return { query: prefix, mode, cache: 'miss', node, count: suggestions.length, suggestions };
}

const elapsedMs = (t0) => Number(process.hrtime.bigint() - t0) / 1e6;

module.exports = { suggest };
