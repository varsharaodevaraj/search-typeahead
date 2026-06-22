'use strict';

/**
 * Performance benchmark — generates the numbers for the performance report
 * (suggest latency incl. p95, cache hit rate, and write reduction from
 * batching). Run the server first, then: `npm run bench`.
 *
 * What it does:
 *   1. Fires a mix of prefix lookups (some repeated, so the cache warms up)
 *      against /suggest and records client-side latency + cache hit/miss.
 *   2. Submits a burst of /search writes to exercise the batch writer.
 *   3. Prints the percentile latencies it measured, then the server's own
 *      /stats so cache hit rate and write reduction can be cited directly.
 */

const BASE = process.env.BASE || 'http://localhost:3000';
const PREFIXES = ['ip', 'iph', 'java', 'jav', 'sea', 'goo', 'face', 'ama', 'net', 'how',
  'wha', 'best', 'che', 'pri', 'red', 'nod', 'pyt', 'mac', 'win', 'lin'];
const SUGGEST_REQUESTS = 2000;
const SEARCH_REQUESTS = 1000;

function pct(sortedMs, p) {
  if (!sortedMs.length) return null;
  const idx = Math.min(sortedMs.length - 1, Math.floor((p / 100) * sortedMs.length));
  return Number(sortedMs[idx].toFixed(3));
}

const pick = (i) => PREFIXES[i % PREFIXES.length];

async function benchSuggest() {
  const latencies = [];
  let hits = 0;
  let misses = 0;
  for (let i = 0; i < SUGGEST_REQUESTS; i++) {
    const q = pick(i);
    const t0 = process.hrtime.bigint();
    const res = await fetch(`${BASE}/suggest?q=${encodeURIComponent(q)}&mode=trending`);
    const data = await res.json();
    latencies.push(Number(process.hrtime.bigint() - t0) / 1e6);
    if (data.cache === 'hit') hits++;
    else misses++;
  }
  latencies.sort((a, b) => a - b);
  return { latencies, hits, misses };
}

async function benchSearch() {
  for (let i = 0; i < SEARCH_REQUESTS; i++) {
    const q = pick(i) + (i % 5 === 0 ? ' pro' : '');
    await fetch(`${BASE}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q }),
    });
  }
}

async function main() {
  console.log(`Benchmarking ${BASE}`);
  console.log(`\n[1/3] ${SUGGEST_REQUESTS} /suggest requests (client-measured) ...`);
  const s = await benchSuggest();
  const total = s.hits + s.misses;
  console.log(`  client-side hit rate : ${((s.hits / total) * 100).toFixed(1)}%  (${s.hits} hit / ${s.misses} miss)`);
  console.log(`  latency p50 / p95 / p99 : ${pct(s.latencies, 50)} / ${pct(s.latencies, 95)} / ${pct(s.latencies, 99)} ms`);

  console.log(`\n[2/3] ${SEARCH_REQUESTS} /search writes (exercise the batch writer) ...`);
  await benchSearch();
  await new Promise((r) => setTimeout(r, 2500)); // let the final batch flush

  console.log('\n[3/3] server /stats:');
  const stats = await (await fetch(`${BASE}/stats`)).json();
  console.log(JSON.stringify(stats, null, 2));

  console.log('\nHeadline numbers for the report:');
  console.log(`  suggest p95 latency : ${stats.suggest.latencyMs.p95} ms (server-side)`);
  console.log(`  cache hit rate      : ${stats.cache.hitRate != null ? (stats.cache.hitRate * 100).toFixed(1) + '%' : 'n/a'}`);
  console.log(`  write reduction     : ${stats.batch.writeReduction != null ? stats.batch.writeReduction + '×' : 'n/a'} (${stats.batch.enqueued} searches → ${stats.batch.rowsUpserted} row writes)`);
}

main().catch((err) => {
  console.error('bench failed (is the server running?):', err.message);
  process.exit(1);
});
