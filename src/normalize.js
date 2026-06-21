'use strict';

/**
 * One canonical form for every query and prefix that enters the system.
 *
 * Lower-casing + trimming means "  iPhone " and "iphone" map to the same row in
 * SQLite and the same cache key, which is exactly the "mixed-case / stray
 * whitespace" handling the spec asks for. Do this once, at the edge, and the
 * rest of the code can assume clean input.
 */
function normalize(input) {
  if (input == null) return '';
  return String(input).trim().toLowerCase();
}

module.exports = { normalize };
