'use strict';

/**
 * Tiny latency + hit/miss recorder for the /suggest read path.
 *
 * We keep the last few thousand latency samples in a ring buffer and compute
 * percentiles on demand, so /stats and the benchmark script can report
 * p50/p95/p99 without pulling in any dependency. (The spec specifically asks for
 * p95 latency and cache hit rate.)
 */

const MAX_SAMPLES = 5000;

const samples = [];
let writeIdx = 0;
const counters = { suggestRequests: 0, cacheHits: 0, cacheMisses: 0 };

function recordSuggest(latencyMs, hit) {
  counters.suggestRequests++;
  if (hit) counters.cacheHits++;
  else counters.cacheMisses++;

  if (samples.length < MAX_SAMPLES) samples.push(latencyMs);
  else {
    samples[writeIdx] = latencyMs;
    writeIdx = (writeIdx + 1) % MAX_SAMPLES;
  }
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return Number(sorted[idx].toFixed(3));
}

function snapshot() {
  const sorted = [...samples].sort((a, b) => a - b);
  const total = counters.cacheHits + counters.cacheMisses;
  return {
    suggestRequests: counters.suggestRequests,
    cacheHits: counters.cacheHits,
    cacheMisses: counters.cacheMisses,
    hitRate: total ? Number((counters.cacheHits / total).toFixed(4)) : null,
    latencyMs: {
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
      samples: sorted.length,
    },
  };
}

module.exports = { recordSuggest, snapshot };
