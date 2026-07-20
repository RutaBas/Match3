/*
 * rng.js — tiny seeded PRNG for the Candy-Crush dupe.
 *
 * Pure logic, zero DOM. Runs under Node (module.exports) and in the browser as
 * a plain <script> (exposes root.CandyRng). Deterministic: the same seed always
 * yields the same stream, so generated levels are reproducible. All randomness
 * in level generation flows through here; the logic engine has none.
 */
(function (root, factory) {
  "use strict";
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory();
  } else {
    root.CandyRng = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // Classic mulberry32 — 32-bit state, good enough for level generation.
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // FNV-1a + Murmur-style avalanche so near-identical seed strings
  // ("...-attempt-1" vs "...-attempt-2") diverge wildly.
  function hashStringToSeed(str) {
    str = String(str);
    var h = 2166136261 >>> 0;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    h ^= h >>> 16;
    h = Math.imul(h, 0x45d9f3b);
    h ^= h >>> 16;
    h = Math.imul(h, 0x45d9f3b);
    h ^= h >>> 16;
    return h >>> 0;
  }

  function makeRng(seed) {
    if (typeof seed === "string") seed = hashStringToSeed(seed);
    return mulberry32(seed >>> 0);
  }

  function randInt(rng, n) { return Math.floor(rng() * n); }

  function shuffle(arr, rng) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = randInt(rng, i + 1);
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  return {
    mulberry32: mulberry32,
    hashStringToSeed: hashStringToSeed,
    makeRng: makeRng,
    randInt: randInt,
    shuffle: shuffle
  };
});
