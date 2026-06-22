'use strict';

const batch = require('./batch');
const { normalize } = require('./normalize');

/**
 * Write path. A submitted search is normalised and ENQUEUED into the batch
 * buffer — we never touch SQLite synchronously on the request. The dummy
 * "Searched" response can therefore return instantly; the count update (and the
 * insert of a brand-new query) is applied on the next batch flush and then
 * shows up in suggestions and trending. We return the normalised query so the
 * caller can echo exactly what was recorded.
 */
function recordSearch(rawQuery) {
  const query = normalize(rawQuery);
  if (!query) return { recorded: false, query: '' };
  batch.enqueue(query);
  return { recorded: true, query };
}

module.exports = { recordSearch };
