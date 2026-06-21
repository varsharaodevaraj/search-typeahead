'use strict';

const path = require('path');

/**
 * Single place for every tunable in the system.
 *
 * Keeping all the knobs here (instead of sprinkling magic numbers through the
 * code) makes it easy to point at one value during the viva and explain why it
 * is set the way it is. Anything here can be overridden with an env var.
 */
module.exports = {
  PORT: Number(process.env.PORT) || 3000,

  // ---------- SQLite: the durable store of query counts ----------
  DB_PATH: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'typeahead.db'),

  // ---------- Redis distributed cache ----------
  // We model THREE logical cache nodes. By default they are three separate
  // databases (0, 1, 2) on a single local Redis, so a grader only needs one
  // `redis-server` running. To use three real Redis processes instead, give
  // each node its own port (see docker-compose.yml) — nothing else changes,
  // because the consistent-hash ring treats them as opaque node ids.
  REDIS_NODES: [
    { id: 'cache-node-0', host: '127.0.0.1', port: 6379, db: 0 },
    { id: 'cache-node-1', host: '127.0.0.1', port: 6379, db: 1 },
    { id: 'cache-node-2', host: '127.0.0.1', port: 6379, db: 2 },
  ],
  CACHE_TTL_SECONDS: 300, // 5 min safety expiry; explicit invalidation is the precise path

  // ---------- Consistent-hash ring ----------
  VNODES_PER_NODE: 150, // virtual nodes per physical node → even spread + ~1/N remap on change

  // ---------- Suggestions ----------
  MAX_SUGGESTIONS: 10,
  CANDIDATE_POOL: 100, // for trending: pull top-100 by count and top-100 by recency, then blend

  // ---------- Trending (recency-aware ranking) ----------
  TREND_HALF_LIFE_MS: 60 * 60 * 1000, // a recency burst halves every 1 hour
  TREND_ALPHA: 0.5, // blend: score = alpha*popularity + (1-alpha)*recency
  TREND_EPSILON: 0.01, // recency below this counts as 0 (old spikes can't rank forever)

  // ---------- Batch writes ----------
  BATCH_SIZE: 500, // flush once this many searches are buffered...
  FLUSH_INTERVAL_MS: 2000, // ...or every 2s, whichever happens first
  INITIAL_COUNT: 1, // count given to a brand-new query the first time it is searched

  // ---------- Dataset loader ----------
  COUNT_SCALE: 1000, // raw corpus counts are enormous; scale down so a live +1 matters
  TOP_BIGRAMS: 100000, // keep this many of the most frequent two-word phrases
};
