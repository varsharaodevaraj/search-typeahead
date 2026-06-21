'use strict';

const crypto = require('crypto');

/**
 * Consistent-hash ring (the same idea Ketama / memcached clients use).
 *
 * Why not just `hash(key) % N`? Because changing N (a cache node is added or
 * dies) reshuffles almost every key to a new node — a cache-wide miss storm.
 * A consistent-hash ring instead places each node at fixed points on a circle
 * of size 2^32; a key is owned by the first node found going CLOCKWISE from
 * hash(key). Adding/removing a node only moves the keys in one arc — about 1/N
 * of them — leaving the rest where they were.
 *
 * Each physical node is scattered as `vnodes` VIRTUAL points around the ring so
 * the arcs are many and small, which keeps the load evenly balanced.
 */

// First 4 bytes of an MD5 digest, read as a big-endian uint32 → a point on the ring.
function hash32(str) {
  return crypto.createHash('md5').update(String(str)).digest().readUInt32BE(0);
}

class HashRing {
  constructor(nodeIds = [], vnodes = 150) {
    this.vnodes = vnodes;
    this.ring = []; // sorted [{ point, id }, …]
    this.nodes = new Set();
    for (const id of nodeIds) this.addNode(id);
  }

  addNode(id) {
    if (this.nodes.has(id)) return;
    this.nodes.add(id);
    for (let i = 0; i < this.vnodes; i++) {
      this.ring.push({ point: hash32(`${id}#${i}`), id });
    }
    this.ring.sort((a, b) => a.point - b.point);
  }

  removeNode(id) {
    if (!this.nodes.has(id)) return;
    this.nodes.delete(id);
    this.ring = this.ring.filter((e) => e.id !== id);
  }

  /**
   * Owner of a key: binary-search for the first ring point >= hash(key),
   * wrapping around to the first point when the key sits past the last one.
   */
  getNode(key) {
    if (this.ring.length === 0) return null;
    const h = hash32(key);
    if (h > this.ring[this.ring.length - 1].point) return this.ring[0].id;
    let lo = 0;
    let hi = this.ring.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.ring[mid].point >= h) hi = mid;
      else lo = mid + 1;
    }
    return this.ring[lo].id;
  }

  // Diagnostic: virtual-node count per physical node (should be ~even).
  vnodeCounts() {
    const c = {};
    for (const e of this.ring) c[e.id] = (c[e.id] || 0) + 1;
    return c;
  }

  nodeIds() {
    return [...this.nodes];
  }
}

module.exports = { HashRing, hash32 };
