'use strict';

const db = require('./db');
const cache = require('./cache');
const config = require('./config');

/**
 * Batch writer — the answer to "don't write to the primary store on every
 * search". Instead of one SQLite UPDATE per request, we buffer search hits and
 * apply them in periodic transactions.
 *
 *  - `buffer` is a Map<query, summed delta>, so searching "iphone" 200 times in
 *    a window collapses into a single (+200) row write — repeats are aggregated.
 *  - Flush triggers: buffered count reaches BATCH_SIZE, OR a FLUSH_INTERVAL_MS
 *    timer fires — whichever comes first.
 *  - SNAPSHOT-THEN-WRITE: we swap the buffer for a fresh Map synchronously,
 *    before any `await`, so searches that land mid-flush are neither lost nor
 *    double-counted. The whole snapshot goes in as one transaction.
 *  - Cache invalidation runs AFTER the commit, so a concurrent read cannot
 *    refill the cache with about-to-be-stale data.
 *
 * Failure trade-off (the spec asks us to discuss this): on a clean shutdown we
 * flush first, so nothing is lost. On a hard crash we lose only the un-flushed
 * buffer — at most BATCH_SIZE searches, i.e. a few popularity counts. That is an
 * acceptable price for a popularity counter and is the cost of not writing
 * synchronously.
 */

let buffer = new Map();
let bufferedSearches = 0; // includes repeats
let timer = null;

const stats = { enqueued: 0, flushes: 0, rowsUpserted: 0, prefixesInvalidated: 0 };

function armTimer() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    flush('timer').catch((e) => console.error('flush(timer) failed:', e.message));
  }, config.FLUSH_INTERVAL_MS);
  if (timer.unref) timer.unref();
}

function enqueue(query) {
  buffer.set(query, (buffer.get(query) || 0) + 1);
  bufferedSearches++;
  stats.enqueued++;
  if (bufferedSearches >= config.BATCH_SIZE) {
    flush('size').catch((e) => console.error('flush(size) failed:', e.message));
  } else {
    armTimer();
  }
}

// Every prefix of a query — these are the cache keys its new count can affect.
function prefixesOf(query) {
  const out = [];
  for (let i = 1; i <= query.length; i++) out.push(query.slice(0, i));
  return out;
}

async function flush(reason = 'manual') {
  if (buffer.size === 0) return { upserts: 0, prefixes: 0, reason };

  // --- snapshot synchronously, before any await ---
  const snapshot = buffer;
  const snapshotSearches = bufferedSearches;
  buffer = new Map();
  bufferedSearches = 0;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }

  const entries = [...snapshot.entries()];
  const flushTs = Date.now();

  // --- one transaction for the whole batch ---
  let upserts;
  try {
    upserts = db.flushBatch(entries, flushTs, config.TREND_HALF_LIFE_MS);
  } catch (err) {
    // Fold the snapshot back in so no counts are lost, then retry next tick.
    for (const [q, d] of entries) buffer.set(q, (buffer.get(q) || 0) + d);
    bufferedSearches += snapshotSearches;
    armTimer();
    throw err;
  }

  // --- invalidate every affected prefix AFTER the commit ---
  const affected = new Set();
  for (const [q] of entries) for (const p of prefixesOf(q)) affected.add(p);
  await cache.invalidate([...affected]);

  stats.flushes++;
  stats.rowsUpserted += upserts;
  stats.prefixesInvalidated += affected.size;

  // If traffic kept arriving during the flush, keep draining.
  if (bufferedSearches >= config.BATCH_SIZE) {
    flush('size').catch((e) => console.error('flush(size) failed:', e.message));
  } else if (buffer.size > 0) {
    armTimer();
  }

  return { upserts, prefixes: affected.size, searches: snapshotSearches, reason };
}

function getStats() {
  return {
    enqueued: stats.enqueued,
    flushes: stats.flushes,
    rowsUpserted: stats.rowsUpserted,
    prefixesInvalidated: stats.prefixesInvalidated,
    pendingSearches: bufferedSearches,
    pendingDistinct: buffer.size,
    batchSize: config.BATCH_SIZE,
    flushIntervalMs: config.FLUSH_INTERVAL_MS,
    // Evidence for the report: how many synchronous writes we avoided.
    writeReduction: stats.rowsUpserted ? Number((stats.enqueued / stats.rowsUpserted).toFixed(2)) : null,
    txnReduction: stats.flushes ? Number((stats.enqueued / stats.flushes).toFixed(2)) : null,
  };
}

function stop() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

module.exports = { enqueue, flush, getStats, stop, prefixesOf };
