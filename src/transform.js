/*
 * transform.js — structure-preserving level transforms.
 *
 * WHY
 *   The Daily Challenge used to be a straight replay of an existing Depth. That
 *   is not a daily puzzle, it is a re-run: a player who cleared Depth 42 last
 *   week already knows the board. But generating a genuinely new level per day
 *   costs 2-6s of solver time, which is far too slow on-device, and shipping 365
 *   pre-baked challenge levels is a lot of bytes for something seen once.
 *
 *   So instead we transform a certified Depth by a map that provably preserves
 *   the ENTIRE game structure. The board looks new to the player, and the
 *   solver's certificate — target, star bars, the winning line, the tier — all
 *   remain valid without re-running the solver at all.
 *
 * THE SAFE TRANSFORM: COLOUR PERMUTATION
 *   Relabelling creature colours by a bijection maps matches to matches (a run
 *   of three 4s becomes a run of three P(4)s) and leaves every other rule
 *   untouched — gravity, refills, specials and scoring never look at WHICH
 *   colour a creature is, only at whether two creatures are the same colour.
 *   A true isomorphism, and test/verify-transform.js replays certified lines
 *   through permuted levels step-for-step to prove it.
 *
 *   Specials survive: a striped current still sweeps its row or column, an
 *   urchin still blasts its 3x3, a pearl still clears one colour (the permuted
 *   one). Kinds are carried through unchanged.
 *
 * WHY THERE IS NO MIRROR (a fixed bug, kept as a warning)
 *   A horizontal mirror LOOKS safe by the same argument: reflecting columns maps
 *   runs to runs, and gravity is vertical so each column travels with its own
 *   refill queue. It is not safe, and the harness caught it — mirrored replays
 *   of certified lines diverged on Depths 24 and 67 (Depth 24: score 7380 vs the
 *   certified 14100, move 5 turning illegal).
 *
 *   The reason is that the ENGINE, not the ruleset, is order-dependent: findRuns
 *   scans row-major and computeCreations resolves competing runs by scan order,
 *   so which cell a special is created in depends on left-to-right order. Mirror
 *   the board and a tie that used to resolve left now resolves right — a
 *   genuinely different game state, not the same state reflected.
 *
 *   applyTransform still accepts { mirror } because it is useful for testing
 *   that very asymmetry, but dailyTransform never uses it. Do not reach for it
 *   to add variety without first making the engine's tie-breaks symmetric.
 *
 * WHAT THIS BUYS
 *   dailyTransform(level, dayNumber) is deterministic from the date alone, so
 *   every player gets the same challenge on the same day with no backend, and
 *   the level is provably winnable at its stored target because it is the same
 *   level wearing different paint. test/verify-transform.js proves exactly that
 *   by replaying each certified line through its transformed level.
 */
(function (root, factory) {
  "use strict";
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory();
  } else {
    root.TideTransform = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function hash32(x) { return ((x * 2654435761) >>> 0); }

  // A deterministic permutation of colours 1..n from a seed (Fisher-Yates driven
  // by a cheap LCG so it is identical in Node and every browser).
  function colourPermutation(n, seed) {
    var order = [];
    var i;
    for (i = 1; i <= n; i++) order.push(i);
    var s = hash32(seed + 1) || 1;
    for (i = order.length - 1; i > 0; i--) {
      s = (1103515245 * s + 12345) >>> 0;
      var j = s % (i + 1);
      var t = order[i]; order[i] = order[j]; order[j] = t;
    }
    var perm = [0];                       // perm[oldColour] = newColour
    for (i = 0; i < order.length; i++) perm[i + 1] = order[i];
    return perm;
  }

  function permuteCandy(cd, perm) {
    if (cd === null || cd === undefined) return null;
    var colour = perm[cd.color] || cd.color;
    return { color: colour, kind: cd.kind };
  }

  // Apply { perm, mirror } to a level, returning a NEW level object. The input
  // is never mutated (campaign levels are shared, frozen data).
  function applyTransform(level, opts) {
    opts = opts || {};
    var perm = opts.perm || null;
    var mirror = !!opts.mirror;
    var rows = level.board.rows, cols = level.board.cols;

    var grid = [];
    for (var r = 0; r < rows; r++) {
      var row = [];
      for (var c = 0; c < cols; c++) {
        var src = level.board.grid[r][mirror ? (cols - 1 - c) : c];
        row.push(perm ? permuteCandy(src, perm) : (src === null ? null :
          { color: src.color, kind: src.kind }));
      }
      grid.push(row);
    }

    // A column's refill queue travels with the column it feeds.
    var refill = [];
    for (var c2 = 0; c2 < cols; c2++) {
      var q = level.refill[mirror ? (cols - 1 - c2) : c2] || [];
      var nq = [];
      for (var k = 0; k < q.length; k++) nq.push(perm ? (perm[q[k]] || q[k]) : q[k]);
      refill.push(nq);
    }

    var pointers = null;
    if (level.pointers) {
      pointers = [];
      for (var c3 = 0; c3 < cols; c3++) {
        pointers.push(level.pointers[mirror ? (cols - 1 - c3) : c3]);
      }
    }

    var out = {};
    for (var key in level) if (Object.prototype.hasOwnProperty.call(level, key)) out[key] = level[key];
    out.board = { rows: rows, cols: cols, grid: grid };
    out.refill = refill;
    if (pointers) out.pointers = pointers;
    if (level.objective && perm && level.objective.type === "collect") {
      out.objective = { type: "collect",
                        color: perm[level.objective.color] || level.objective.color,
                        amount: level.objective.amount };
    }
    return out;
  }

  // Map a move from the ORIGINAL level's coordinates into the transformed one.
  // (Colour permutation does not move anything; only the mirror does.)
  function mapMove(move, cols, mirror) {
    if (!mirror) return { r1: move.r1, c1: move.c1, r2: move.r2, c2: move.c2 };
    return { r1: move.r1, c1: cols - 1 - move.c1,
             r2: move.r2, c2: cols - 1 - move.c2 };
  }
  function mapSequence(sequence, cols, mirror) {
    var out = [];
    for (var i = 0; i < sequence.length; i++) out.push(mapMove(sequence[i], cols, mirror));
    return out;
  }

  // The day's transform: deterministic from the day number, so every player sees
  // the same challenge and no state has to be shared.
  // Colour permutation only — see the header on why mirroring is unsound here.
  function dailyTransform(level, dayNumber) {
    var perm = colourPermutation(level.colorCount, dayNumber);
    var out = applyTransform(level, { perm: perm, mirror: false });
    out.transform = { perm: perm, mirror: false, day: dayNumber };
    return out;
  }

  return {
    colourPermutation: colourPermutation,
    applyTransform: applyTransform,
    mapMove: mapMove,
    mapSequence: mapSequence,
    dailyTransform: dailyTransform
  };
});
