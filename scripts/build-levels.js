/*
 * build-levels.js — pre-generate the Tide Pool "Depths" campaign at build time.
 *
 * Runtime generation of Hard levels is ~2-6s each (the solver runs an exhaustive
 * search per candidate), which is far too slow on-device. So we bake the whole
 * campaign here, once, into a static js/levels.js that the game loads instantly
 * and plays fully offline.
 *
 * WHAT IT DOES
 *   1. Generates a ramped set of Depths with generator.generate(tier, seed):
 *        Depths  1- 8 : easy   (6x6, 4 colors, 5 moves)
 *        Depths  9-16 : medium (7x7, 5 colors, 6 moves)
 *        Depths 17-24 : hard   (7x8, 6 colors, 5 moves)
 *        Depths 25+   : a repeating 10-Depth wave, E M H M H E M H M H
 *                       (see tierForDepth) — 2 easy / 4 medium / 4 hard per ten
 *      generate() already certifies the tier internally (greedy fails / no-special
 *      search fails, etc.) and re-verifies its winning line by replay.
 *   2. RE-verifies every Depth with solver.analyze() and asserts the certified
 *      tier matches the requested tier (a belt-and-suspenders gate).
 *   3. Computes per-Depth STAR thresholds from each level's own achievable
 *      headroom (see star-rating note below).
 *   4. Emits js/levels.js exposing the browser global CANDY_LEVELS.
 *
 * STAR RATING (documented, per-level, always reachable)
 *   Targets sit right at a tier boundary, so the score headroom above target
 *   differs a lot between tiers (easy has ~3-4x room, hard barely 1.5x). A fixed
 *   multiplier would make 3 stars trivial on easy and impossible on hard. So each
 *   Depth gets thresholds scaled to ITS OWN reachable maximum score `M`
 *   (solver.bestScore, specials allowed; a concrete achievable line):
 *       gap   = M - target
 *       star1 = target                         (reach target => you win)
 *       star2 = target + round(0.35 * gap)     (comfortably above target)
 *       star3 = target + round(0.75 * gap)     (well above; near the best line)
 *   Thresholds are rounded to the 60-pt match unit. Because M is an exhibited,
 *   in-budget line, star3 is always genuinely reachable. (If the bounded search
 *   overflows, M is a safe LOWER bound on the true max — still achievable.)
 *
 * REGENERATE / EXTEND
 *   node scripts/build-levels.js --count 250 --from 101   # EXTEND (keeps 1-100)
 *   node scripts/build-levels.js --count 250              # full rebuild — see the
 *                                                         # freeze warning below
 *   node scripts/build-levels.js                 # defaults to 40 Depths
 *   Deterministic: Depth N always uses seed N within its tier band, so a rebuild
 *   reproduces the same campaign. To change the ramp, edit tierForDepth() below.
 */
"use strict";

var fs = require("fs");
var path = require("path");
var logic = require("../src/logic.js");
var solver = require("../src/solver.js");
var generator = require("../src/generator.js");

// ---- campaign shape ---------------------------------------------------------
var argv = process.argv.slice(2);
function argVal(flag, dflt) {
  var i = argv.indexOf(flag);
  return (i >= 0 && argv[i + 1]) ? argv[i + 1] : dflt;
}
var TOTAL = parseInt(argVal("--count", "40"), 10);
// --from N  : EXTEND mode. Depths below N are carried over verbatim from the
//             existing js/levels.js (objectives and all) and only N..TOTAL are
//             generated. This is how the campaign grows without re-grading — and
//             without silently regenerating shipped Depths, which is a mistake
//             this file's header exists to warn about.
// --out PATH: write somewhere other than js/levels.js, so a long extension run
//             can proceed while another script edits the live campaign.
var FROM = parseInt(argVal("--from", "1"), 10);
var OUT = argVal("--out", "");

// Depth -> tier band.
// Depths 1-24 are the ORIGINAL campaign and their structure is FROZEN (equal
// thirds of 24).
//
// !! The "a rebuild reproduces them byte-identically" claim this comment used to
// make is NO LONGER TRUE, and hasn't been since Phase 3. The boards and refill
// queues do still reproduce exactly (same seed, same tier, same budget), but the
// shipped Depths 1-24 were CERTIFIED under the pre-urchin ruleset; today's solver
// re-grades them with urchins + special-combos available and arrives at a
// different certTarget — which then moves target and both star bars. Measured on
// 2026-07-27: 23 of the 24 shifted, generally EASIER (Depth 12 star3 9180 ->
// 5040, Depth 24 target 15000 -> 12480).
//
// So a plain rebuild silently rebalances shipped levels out from under existing
// players. js/levels.js therefore carries the shipped 1-24 spliced in verbatim.
// If you rebuild the whole campaign, restore Depths 1-24 from the previous
// js/levels.js afterwards — or decide deliberately to adopt the Phase-3 regrade
// for them, which is a balance change worth making on purpose, not by accident.
//
// Depths 25+ ride a repeating 10-Depth WAVE. The old extension (one medium
// breather then three hard) graded out at 65 hard / 27 medium / 8 easy across
// 100 Depths — effectively a flat wall from 25 on, which is the shape players
// quit on. The wave gives every ten Depths a real rhythm: two easy exhales,
// four mediums, four hards, and never two hards back to back within a block.
//
//   offset in block: 0  1  2  3  4  5  6  7  8  9
//   tier:            E  M  H  M  H  E  M  H  M  H
var WAVE = ["easy", "medium", "hard", "medium", "hard",
            "easy", "medium", "hard", "medium", "hard"];
function tierForDepth(depth) {
  if (depth <= 8) return "easy";
  if (depth <= 16) return "medium";
  if (depth <= 24) return "hard";
  return WAVE[(depth - 25) % WAVE.length];
}

// Star max search: bounded so the build stays quick. The returned score is a
// concrete achievable line (exact when !overflow, a safe lower bound otherwise).
var STAR_NODE_CAP = 60000;

function round60(x) { return Math.round(x / 60) * 60; }

// The generator sets `level.target` to the FLOOR of what its technique can score
// (that's what certifies the tier). Hitting that floor means playing the optimal
// line perfectly — far too hard for a casual player, especially early. So the
// player's WIN target is a forgiving fraction of the certified target that ramps
// up as you descend: gentle at Depth 1, full-challenge by the last Depth. Because
// winTarget <= certified target <= an exhibited achievable line, every Depth stays
// provably winnable; the certification (tier grading) still uses the certified target.
function winTargetFor(certTarget, depth, tier) {
  // FROZEN ramp: 0.35 at Depth 1 -> 1.0 at Depth 24, anchored to 24 forever so
  // extending the campaign never changes shipped targets.
  //
  // Depths 25+ scale the demand to the WAVE tier, so a breather actually
  // breathes: an easy Depth at 0.9 of its certified line is not a rest, it is a
  // hard level on a small board. (A softer 0.85/0.80 cap for hard was prototyped
  // and PAUSED at Ruta's request 2026-07-20 — hard stays at 0.9 here; the relief
  // now comes from the tier mix instead.)
  var DEEP_FACTOR = { easy: 0.60, medium: 0.80, hard: 0.90 };
  var f = (depth > 24) ? (DEEP_FACTOR[tier] || 0.9)
                       : (0.35 + 0.65 * (depth - 1) / 23);
  var wt = round60(certTarget * f);
  if (wt < 60) wt = 60;
  if (wt > certTarget) wt = certTarget;
  return wt;
}

// Star thresholds, anchored to the WIN target (not the certified score).
// History: v1 anchored stars toward the theoretical max (near-impossible);
// v2 anchored toward certTarget (still "played nearly optimally" territory —
// players cleared levels and got 1 star). v3: stars are a fixed, predictable
// margin above what you needed to win:
//   star1 = winTarget (you win)  ·  star2 = 1.15x win  ·  star3 = 1.35x win
// clamped to the exhibited reachable max M so 3 stars is always provably
// attainable, and to the certified score so it never demands perfect play.
function starThresholds(level, winTarget) {
  var cap = Math.min(generator.TIERS[level.tier].nodeCap, STAR_NODE_CAP);
  var bs = solver.bestScore(level, { allowSpecials: true, nodeCap: cap });
  var M = Math.max(bs.score, level.target); // exhibited reachable max (>= certTarget)
  var star2 = round60(winTarget * 1.15);
  var star3 = round60(winTarget * 1.35);
  var ceil = Math.min(M, level.target);     // never above "good play", never above max
  if (star3 > ceil) star3 = round60(ceil);
  if (star2 >= star3) star2 = star3 - 60;
  // keep strictly ascending above the win bar
  if (star2 <= winTarget) star2 = winTarget + 60;
  if (star3 <= star2) star3 = star2 + 60;
  if (star3 > M) star3 = round60(M);
  if (star2 > star3) star2 = star3;
  return { star2: star2, star3: star3, maxScore: M, overflow: !!bs.overflow };
}

function build() {
  var levels = [];
  var t0 = Date.now();

  if (FROM > 1) {
    global.window = {};
    require(path.join(__dirname, "..", "js", "levels.js"));
    var existing = global.window.CANDY_LEVELS || [];
    if (existing.length < FROM - 1) {
      throw new Error("--from " + FROM + " needs at least " + (FROM - 1) +
        " existing Depths, found " + existing.length);
    }
    levels = existing.slice(0, FROM - 1);
    console.log("Extending the campaign: keeping Depths 1-" + (FROM - 1) +
      " verbatim, generating " + FROM + "-" + TOTAL);
  } else {
    console.log("Building Tide Pool campaign — " + TOTAL + " Depths");
  }
  console.log(new Array(52).join("="));

  for (var depth = FROM; depth <= TOTAL; depth++) {
    var tier = tierForDepth(depth, TOTAL);
    var seed = depth; // deterministic per Depth within the tier band
    var d0 = Date.now();

    // The opening Depths are meant to be gentle & teach the mechanic, so grant
    // bonus moves that taper off: +3 (Depths 1-2), +2 (3-4), +1 (5-6), +0 after.
    var moveBonus = Math.max(0, 4 - Math.ceil(depth / 2));
    // Hard-band rebalance (players were stuck at 5 moves): 18: +3 (8 mv),
    // 19-20: +2 (7 mv), 21-24: +1 (6 mv). Depths 1-17 are DELIBERATELY
    // untouched so a rebuild reproduces them byte-identically and existing
    // players' records stay true.
    if (depth === 18) moveBonus += 3;
    else if (depth >= 19 && depth <= 20) moveBonus += 2;
    else if (depth >= 21 && depth <= 24) moveBonus += 1;
    // Extension (25+): hard levels keep the post-rebalance 6-move budget
    // (never back to 5); the easy/medium wave slots get a little air so the
    // breather reads as a breather.
    if (depth >= 25) {
      if (tier === "hard") moveBonus += 1;
      else if (tier === "medium") moveBonus += 1;
      else moveBonus += 2;               // easy exhale
    }
    var budget = generator.TIERS[tier].budget + moveBonus;

    var lvl = generator.generate(tier, seed, { budget: budget });

    // belt-and-suspenders: re-certify tier and re-verify the winning line.
    var info = solver.analyze(lvl, { nodeCap: generator.TIERS[tier].nodeCap });
    if (info.tier !== tier) {
      throw new Error("Depth " + depth + " certified as " + info.tier +
        " but requested " + tier);
    }
    var rep = solver.replaySequence(lvl, info.sequence);
    if (!rep.win) {
      throw new Error("Depth " + depth + " winning line failed replay");
    }

    var winTarget = winTargetFor(lvl.target, depth, tier);
    var st = starThresholds(lvl, winTarget);

    levels.push({
      depth: depth,
      tier: tier,
      rows: lvl.rows,
      cols: lvl.cols,
      colorCount: lvl.colorCount,
      moves: lvl.moves,
      target: winTarget,        // the forgiving, ramped WIN target the player sees
      certTarget: lvl.target,   // the certified technique floor (for grading/reference)
      star2: st.star2,
      star3: st.star3,
      maxScore: st.maxScore,
      par: info.sequence.length,
      board: lvl.board,
      refill: lvl.refill
    });

    console.log(
      "Depth " + pad(depth, 2) + "  " + rpad(tier, 6) + " " +
      lvl.rows + "x" + lvl.cols + " c" + lvl.colorCount + " mv" + lvl.moves +
      "  win " + pad(winTarget, 6) + " (cert " + pad(lvl.target, 6) + ")" +
      "  stars " + pad(st.star2, 6) + "/" + pad(st.star3, 6) +
      "  max " + pad(st.maxScore, 6) + (st.overflow ? "~" : " ") +
      "  " + (Date.now() - d0) + "ms"
    );
  }

  var header =
    "/* AUTO-GENERATED by scripts/build-levels.js — do not edit by hand.\n" +
    " * The Tide Pool \"Depths\" campaign, pre-verified by the solver.\n" +
    " * Each entry: { depth, tier, rows, cols, colorCount, moves, target,\n" +
    " *   star2, star3, maxScore, par, board:{rows,cols,grid}, refill:[[...]] }.\n" +
    " * Per-column refill pointers default to all-zero at runtime.\n" +
    " * Regenerate: node scripts/build-levels.js  (see that file's header). */\n";
  var body = "window.CANDY_LEVELS = " + JSON.stringify(levels) + ";\n";

  var outPath = OUT ? path.resolve(OUT) : path.join(__dirname, "..", "js", "levels.js");
  fs.writeFileSync(outPath, header + body);

  var byTier = { easy: 0, medium: 0, hard: 0 };
  levels.forEach(function (l) { byTier[l.tier]++; });
  console.log(new Array(52).join("="));
  console.log("Wrote " + outPath);
  console.log("Depths: " + levels.length +
    "  (easy " + byTier.easy + " / medium " + byTier.medium + " / hard " + byTier.hard + ")");
  console.log("Total build time: " + ((Date.now() - t0) / 1000).toFixed(1) + "s");
}

function pad(n, w) { var s = String(n); while (s.length < w) s = " " + s; return s; }
function rpad(s, w) { s = String(s); while (s.length < w) s = s + " "; return s; }

build();
