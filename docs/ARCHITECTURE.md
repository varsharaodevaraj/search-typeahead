# Architecture

## Overview

Two request paths share one data store.

```
                         ┌──────────────────────────────────────────┐
                         │                Browser UI                 │
                         │  debounced typing · keyboard nav · panels  │
                         └───────────────┬───────────────┬───────────┘
              GET /suggest?q=&mode=       │               │  POST /search {query}
                         ┌────────────────▼──────┐   ┌────▼─────────────────────┐
                         │   READ PATH (fast)     │   │   WRITE PATH (deferred)  │
                         │   suggest.js           │   │   search.js → batch.js   │
                         └───────────┬────────────┘   └───────────┬──────────────┘
                  cache-first        │                            │  enqueue + coalesce
                         ┌───────────▼────────────┐               │
                         │  Cache layer (cache.js) │               │ flush every
                         │  consistent-hash ring   │               │ 500 writes / 2s
                         │  3 logical Redis nodes  │               │ (one txn)
                         └───────────┬────────────┘               │
                            miss     │  refill            invalidate affected
                         ┌───────────▼─────────────────────────────▼──────────────┐
                         │                  SQLite (db.js)                          │
                         │       queries(query PK, count, trend_score, last_updated)│
                         │       source of truth · prefix = range scan on PK index  │
                         └──────────────────────────────────────────────────────────┘
```

## Components

### `db.js` — SQLite source of truth
Single table `queries(query PRIMARY KEY, count, trend_score, last_updated)`.
Prefix matching is a **range scan**: every string starting with prefix `p` sorts
inside `[p, p + '￿')`, where `'￿'` is the largest UTF-16 code unit. The scan
rides the primary-key B-tree — no separate trie to build or lose on restart.
Indexes on `count` and `last_updated` make the "top by count" and "top by recency"
pulls cheap. Read/write counters back the `/stats` endpoint.

### `ring.js` — consistent-hash ring
Each physical node is hashed to **150 virtual points** on a `0..2^32` ring
(`md5(node#i)`). A key's owner is the first virtual node clockwise from
`md5(key)`, found by binary search. Virtual nodes even out the load; consistent
hashing means adding/removing a node only remaps ~1/N of keys instead of nearly
all (which `hash % N` would).

### `cache.js` — distributed cache
N logical Redis nodes (default: DBs 0/1/2 on one Redis) behind the ring. Key is
`suggest:<mode>:<prefix>`; we hash the **prefix** so a prefix's `basic` and
`trending` entries co-locate and invalidate together. A 5-minute TTL is a safety
net; the precise mechanism is explicit invalidation on write. Every Redis call
is wrapped — a down node is counted as a miss and the read falls through to
SQLite (**graceful degradation**).

### `suggest.js` — read path
`normalize → cache.get → (hit) return | (miss) compute from SQLite + cache.set`.
Basic mode = top-N by count; trending = decay + blend (below).

### `batch.js` — write path
A `Map<query, summed delta>` coalesces repeats. Flush on `BATCH_SIZE` (500) or a
`FLUSH_INTERVAL_MS` (2s) timer. **Snapshot-then-write**: the buffer is swapped
for a fresh map synchronously before any `await`, so mid-flush searches are
never lost or double-counted; the snapshot is applied in one transaction, and
affected prefixes are invalidated *after* the commit.

### `trending.js` — recency-aware ranking
Each row's `trend_score` is **lazily** decayed on every touch:
`score = score · 0.5^(Δt / HALF_LIFE) + delta`. At read time we decay once more
and blend with popularity: `α·normCount + (1-α)·normRecency`, normalized within
the candidate pool. Spikes decay below `TREND_EPSILON` and stop ranking, so
nothing is over-ranked forever.

### `server.js` — API + lifecycle
Express routes (`/suggest`, `/search`, `/trending`, `/cache/debug`, `/stats`)
plus a graceful shutdown that flushes the batch buffer before exit (zero loss on
a clean stop).

## Data flow summary

1. **Type** → debounced `GET /suggest` → cache hit (sub-ms) or SQLite + refill.
2. **Submit** → `POST /search` → enqueue → instant `"Searched"` → batched count
   update → cache invalidation → next suggest reflects it.
