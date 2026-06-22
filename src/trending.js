'use strict';

const db = require('./db');
const config = require('./config');

/**
 * Recency-aware ("trending") ranking — the +20% part of the spec.
 *
 * Every row stores a `trend_score` that is decayed LAZILY: whenever a query is
 * touched by a batch flush we first age its stored score to "now" and then add
 * the new activity (see db.flushBatch):
 *
 *     trend_score = trend_score * 0.5^(elapsed / HALF_LIFE) + delta
 *
 * So reads never need a background timer. At query time we decay once more to
 * the read instant and blend recency with all-time popularity:
 *
 *     score = alpha * normCount + (1 - alpha) * normRecency      (alpha = 0.5)
 *
 * normCount and normRecency are min-max normalised to [0,1] WITHIN the
 * candidate pool, so two very different scales (counts in the thousands vs.
 * recency in single digits) get an equal say. This answers the spec's four
 * questions: recent searches are tracked via trend_score; recency raises rank
 * through the blend; a brief spike cannot rank forever because its recency
 * decays below TREND_EPSILON and drops out; and the cache is invalidated on
 * every flush so rankings stay fresh.
 */

function decayedRecency(row, now) {
  if (!row.last_updated || row.last_updated <= 0) return 0;
  const dt = Math.max(0, now - row.last_updated);
  const v = row.trend_score * Math.pow(0.5, dt / config.TREND_HALF_LIFE_MS);
  return v < config.TREND_EPSILON ? 0 : v;
}

function blend(rows, now) {
  if (!rows.length) return [];
  const alpha = config.TREND_ALPHA;

  const enriched = rows.map((r) => ({
    query: r.query,
    count: r.count,
    recency: decayedRecency(r, now),
  }));

  const maxCount = Math.max(1, ...enriched.map((e) => e.count));
  const maxRec = Math.max(0, ...enriched.map((e) => e.recency));

  for (const e of enriched) {
    const nc = e.count / maxCount;
    const nr = maxRec > 0 ? e.recency / maxRec : 0;
    e.score = alpha * nc + (1 - alpha) * nr;
  }

  enriched.sort((a, b) => b.score - a.score || b.count - a.count);
  return enriched;
}

// Trending suggestions for a prefix: blend over the candidate pool, take top-N.
function rankPrefix(prefix, now = Date.now()) {
  return blend(db.candidatePool(prefix), now)
    .slice(0, config.MAX_SUGGESTIONS)
    .map((e) => ({ query: e.query, count: e.count, score: Number(e.score.toFixed(4)) }));
}

// Global trending feed for the UI panel: live-recency rows, hottest first.
// Falls back to all-time top when nothing has been searched yet.
function globalTrending(limit = config.MAX_SUGGESTIONS, now = Date.now()) {
  const hot = db
    .globalRecentPool(config.CANDIDATE_POOL * 2)
    .map((r) => ({ query: r.query, count: r.count, score: decayedRecency(r, now) }))
    .filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((e) => ({ query: e.query, count: e.count, score: Number(e.score.toFixed(3)) }));

  if (hot.length) return { mode: 'trending', trending: hot };
  return { mode: 'count', trending: db.topByCount(limit) };
}

module.exports = { rankPrefix, globalTrending, decayedRecency, blend };
