# Search Typeahead System

A working search-typeahead (autocomplete) backend + UI. As you type, it suggests
popular queries; when you submit a search it records the query and updates its
popularity. The focus is the **data-system design**: how query counts are
stored, how suggestions are served with low latency, how the cache is
distributed with **consistent hashing**, and how **write pressure is reduced**
with batching.

```
Browser (debounced input)
   │  GET /suggest?q=<prefix>&mode=basic|trending
   ▼
Express API ──► Cache layer (cache-first)
   │               │  N logical Redis nodes behind a consistent-hash ring
   │               │  key = suggest:<mode>:<prefix>, owned by hash(prefix)
   │               ▼
   │            HIT → return (sub-ms)
   │            MISS → compute from SQLite, refill cache, return
   │
   │  POST /search { query }   (dummy "Searched")
   ▼
Batch writer (buffer + coalesce) ──flush every 500 writes / 2s──► SQLite
                                                                    (source of truth)
```

## Tech stack

- **Node.js + Express** — API server and static file host.
- **SQLite** (`better-sqlite3`) — durable source of truth for query counts.
- **Redis** (`redis`) — distributed cache, modelled as **3 logical nodes** behind
  a consistent-hash ring.
- **Vanilla HTML/CSS/JS** — the search UI (no framework, easy to read).

## Setup

```bash
# 1. install dependencies
npm install

# 2. start Redis (the cache). On macOS with Homebrew:
brew services start redis          # or: redis-server
#    (the app still runs without Redis — it degrades to SQLite-only)

# 3. load the dataset into SQLite (downloads Norvig n-grams, ~424k queries)
npm run load-data

# 4. run the server
npm start
#    → http://localhost:3000
```

Open <http://localhost:3000>, start typing (`ip`, `java`, `sea`), use ↑/↓ to
navigate, and press Enter or click **Search** to submit.

## Dataset

Source: Peter Norvig's public word-frequency lists, derived from the Google Web
Trillion Word Corpus.

- `count_1w.txt` — ~333k single words
- `count_2w.txt` — ~286k two-word phrases

`npm run load-data` downloads these, merges the unigrams with the top-100k
bigrams, scales the raw counts down (so a live `+1` from a search is meaningful),
and bulk-inserts. Result: **424,188 rows** (≫ the 100k minimum). If the network
is down, it falls back to a synthetic Zipf-distributed dataset so the loader
never hard-fails.

Expected input shape:

| query          | count  |
| -------------- | ------ |
| iphone         | 100000 |
| iphone 15      | 85000  |
| iphone charger | 60000  |

## API

| Method & path                       | Purpose          | Behavior |
| ----------------------------------- | ---------------- | -------- |
| `GET /suggest?q=<prefix>&mode=`     | fetch suggestions | up to 10 prefix matches. `mode=basic` → by all-time count; `mode=trending` (default) → recency-aware blend. Returns `{query, mode, cache:hit\|miss, node, suggestions[]}`. |
| `POST /search` `{ query }`          | submit a search   | returns `{message:"Searched", query, recorded}` and enqueues a batched count update. |
| `GET /trending?limit=N`             | global hot feed   | currently-trending queries (or all-time top before any activity). |
| `GET /cache/debug?prefix=<p>`       | debug routing     | which cache node owns the prefix and whether it is currently a hit/miss. |
| `GET /stats`                        | live metrics      | DB rows + read/write counts, cache hit rate per node, suggest p50/p95/p99 latency, batch write-reduction. |

Quick check:

```bash
curl "http://localhost:3000/suggest?q=iph&mode=basic"
curl -X POST localhost:3000/search -H 'Content-Type: application/json' -d '{"query":"iphone 15"}'
curl "http://localhost:3000/cache/debug?prefix=java"
```

## Design choices & trade-offs

- **SQLite + range scan instead of a trie.** A prefix `p` matches exactly the
  rows in `[p, p+'￿')`, so prefix lookup is a range scan on the primary-key
  index — correct, durable across restarts, and it lets us count DB reads/writes
  for the report. A trie would be faster in memory but lost on restart and
  harder to measure.
- **Cache-first reads.** Every `/suggest` checks Redis first; only a miss touches
  SQLite, and the result is written back. This is what keeps p95 latency
  sub-millisecond.
- **Consistent hashing on the prefix.** Keys are placed on a 2^32 ring with 150
  virtual nodes per physical node, so load is even and adding/removing a node
  remaps only ~1/N of keys (not all of them, as `hash % N` would). Hashing the
  *prefix* keeps both `basic` and `trending` entries for a prefix on the same
  node, so invalidation is a single-node operation.
- **Batched writes.** Searches are buffered and coalesced (repeats summed) and
  applied in one transaction every 500 writes or 2s. **Trade-off:** on a clean
  shutdown we flush first (zero loss); on a hard crash we lose only the unflushed
  buffer (≤ a few hundred popularity counts) — acceptable for a popularity
  counter, and the price of not writing synchronously on every request.
- **Recency-aware trending.** Each row keeps a lazily exponentially-decayed
  `trend_score`; at query time we blend normalized popularity with normalized
  recency (α = 0.5). A short-lived spike decays back below a floor and stops
  ranking, so nothing is over-ranked forever.
- **Graceful degradation.** If Redis is down the cache calls just return misses
  and reads fall back to SQLite — the system slows, it never breaks.

## Performance

See [docs/PERFORMANCE.md](docs/PERFORMANCE.md). Headline numbers from
`npm run bench` on this machine:

- suggest **p95 ≈ 0.10 ms**, **hit rate ≈ 99%**
- batching gave **~24× fewer DB writes** (1001 searches → 41 row writes)

## Docs

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — component-by-component design.
- [docs/PERFORMANCE.md](docs/PERFORMANCE.md) — measured latency, hit rate, write reduction.

## Project layout

```
src/
  config.js      all tunables in one place
  normalize.js   canonical lower-case/trim for queries & prefixes
  db.js          SQLite source of truth + prefix range scan
  ring.js        consistent-hash ring (Ketama-style, 150 vnodes/node)
  cache.js       distributed Redis cache + graceful degradation
  suggest.js     cache-first read path
  search.js      write path (enqueue to batch)
  batch.js       buffer + coalesce + periodic flush
  trending.js    recency-aware ranking (lazy decay + blend)
  metrics.js     latency percentiles + hit/miss counters
  server.js      Express routes + graceful shutdown
scripts/
  load-data.js   dataset downloader/loader
  perf-bench.js  benchmark for the performance report
public/          search UI (index.html, app.js, style.css)
```
