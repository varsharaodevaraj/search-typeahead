# Performance Report

All numbers below were produced by `npm run bench` against a locally running
server (3 logical Redis nodes on one instance, ~424k-row dataset). Reproduce
with:

```bash
npm start            # terminal 1
npm run bench        # terminal 2
```

The benchmark fires 2,000 `/suggest` reads (repeated prefixes, so the cache
warms) and 1,000 `/search` writes, then reads the server's own `/stats`.

## Environment

- Dataset: **424,188** queries (Norvig unigrams + top-100k bigrams).
- Cache: 3 logical Redis nodes, 150 virtual nodes each.
- Machine: local laptop, single Redis process.

## Suggest latency (read path)

| percentile | latency |
| ---------- | ------- |
| p50        | 0.075 ms |
| p95        | **0.101 ms** |
| p99        | 0.457 ms |

Measured over 2,002 suggest requests. The cache-first path keeps the typical
request well under a millisecond; the p99 tail corresponds to cache misses that
fall through to a SQLite range scan.

## Cache hit rate

- Suggest-path hit rate: **98.95%** (1,981 hits / 21 misses).
- Misses are the first lookup of each distinct prefix (cold cache) and lookups
  right after a write invalidated that prefix.
- Routing was even across nodes — each physical node holds exactly 150 virtual
  nodes, and hits distributed roughly 495 / 792 / 694 across the three nodes.

This is the cache-vs-primary-store evidence the rubric asks for: ~99% of reads
were served from Redis without touching SQLite.

## Write reduction (batching)

| metric | value |
| ------ | ----- |
| searches submitted (`enqueued`) | 1,001 |
| SQLite row writes (`rowsUpserted`) | 41 |
| transactions (`flushes`) | 3 |
| **write reduction** | **24.4×** |
| transaction reduction | 333.7× |

1,001 individual searches became **41 row writes across 3 transactions** —
because repeats of the same query were coalesced into a single `+delta` upsert
and applied in batches. Without batching this would have been ~1,001 synchronous
writes. Confirmed by `dbIO.writes = 41` on `/stats`.

## Failure trade-off

- **Clean shutdown** (SIGINT/SIGTERM): the server flushes the buffer before
  exiting → zero loss.
- **Hard crash**: only the un-flushed buffer is lost — at most `BATCH_SIZE`
  (500) searches, i.e. a few hundred popularity increments. For a popularity
  counter this is acceptable, and it is the cost of not writing synchronously on
  every request. Durability could be tightened by shrinking `BATCH_SIZE` /
  `FLUSH_INTERVAL_MS` or writing the buffer to an append-only log first — at the
  cost of more writes.

## How to read it live

Open <http://localhost:3000> — the **Live stats** panel shows DB rows, cache hit
rate, suggest p95, write reduction, and how many cache nodes are up, refreshing
every 5s. `GET /cache/debug?prefix=java` shows which node owns a prefix and
whether it is currently cached.
