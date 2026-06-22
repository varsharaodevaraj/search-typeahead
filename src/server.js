'use strict';

const path = require('path');
const express = require('express');

const config = require('./config');
const db = require('./db');
const cache = require('./cache');
const metrics = require('./metrics');
const batch = require('./batch');
const trending = require('./trending');
const { suggest } = require('./suggest');
const { recordSearch } = require('./search');
const { normalize } = require('./normalize');

async function start() {
  db.init();
  if (db.rowCount() === 0) {
    console.warn('⚠ Database is empty — run `npm run load-data` first.');
  }
  await cache.connect();

  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // GET /suggest?q=<prefix>&mode=basic|trending → up to 10 suggestions
  app.get('/suggest', async (req, res) => {
    const q = req.query.q ?? '';
    const mode = req.query.mode === 'basic' ? 'basic' : 'trending';
    try {
      res.json(await suggest(q, mode));
    } catch (err) {
      res.status(500).json({ error: 'suggest_failed', message: err.message });
    }
  });

  // POST /search { query } → dummy "Searched", records the query (batched)
  app.post('/search', (req, res) => {
    const q = (req.body && req.body.query) ?? req.query.q ?? '';
    try {
      const r = recordSearch(q);
      res.json({ message: 'Searched', query: r.query, recorded: r.recorded });
    } catch (err) {
      res.status(500).json({ error: 'search_failed', message: err.message });
    }
  });

  // GET /trending?limit=N → global hot feed for the UI panel
  app.get('/trending', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || config.MAX_SUGGESTIONS, 50);
    res.json(trending.globalTrending(limit));
  });

  // GET /cache/debug?prefix=<p> → which node owns it + hit/miss state
  app.get('/cache/debug', async (req, res) => {
    const prefix = normalize(req.query.prefix ?? req.query.q ?? '');
    if (!prefix) return res.status(400).json({ error: 'missing prefix' });
    try {
      res.json(await cache.debug(prefix));
    } catch (err) {
      res.status(500).json({ error: 'debug_failed', message: err.message });
    }
  });

  // GET /stats → DB rows + IO, cache hit rate, suggest latency, batching numbers
  app.get('/stats', (req, res) => {
    res.json({
      dbRows: db.rowCount(),
      dbIO: db.getCounters(),
      suggest: metrics.snapshot(),
      cache: cache.getStats(),
      batch: batch.getStats(),
    });
  });

  const server = app.listen(config.PORT, () => {
    console.log(`Typeahead server → http://localhost:${config.PORT}`);
  });

  // Graceful shutdown: flush the batch buffer BEFORE exiting (zero loss).
  let shuttingDown = false;
  async function shutdown(sig) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${sig} received — flushing batch buffer ...`);
    try {
      const r = await batch.flush('shutdown');
      console.log(`  flushed ${r.upserts || 0} rows, invalidated ${r.prefixes || 0} prefixes.`);
    } catch (err) {
      console.error('  flush failed:', err.message);
    }
    batch.stop();
    server.close();
    await cache.quit();
    db.close();
    process.exit(0);
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return server;
}

if (require.main === module) {
  start().catch((err) => {
    console.error('failed to start:', err);
    process.exit(1);
  });
}

module.exports = { start };
