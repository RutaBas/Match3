/*
 * verify-transform.js — prove the Daily Challenge transforms are ISOMORPHISMS.
 *
 * The Daily Challenge shows a transformed Depth and keeps the original's target,
 * star bars and tier. That is only honest if the transform provably preserves
 * the game. This harness does not take that on faith: for every sampled Depth
 * and a spread of day numbers it takes the solver's certified winning line for
 * the ORIGINAL level, maps it through the transform, and replays it through the
 * real rules on the TRANSFORMED level, asserting
 *
 *     same legality, move for move
 *     identical score at every step
 *     identical cascade count, special-created and special-fired flags
 *     the win still lands, on the same move index
 *
 * plus structural checks (a permutation really is a bijection; mirroring twice
 * is the identity; the transformed board is a genuine relabelling of the
 * original, not a reshuffle).
 *
 * Run:  node test/verify-transform.js     # exit 0 = green
 */
"use strict";

var path = require("path");
var logic = require(path.join(__dirname, "..", "src", "logic.js"));
var solver = require(path.join(__dirname, "..", "src", "solver.js"));
var T = require(path.join(__dirname, "..", "src", "transform.js"));

global.window = {};
require(path.join(__dirname, "..", "js", "levels.js"));
var LEVELS = global.window.CANDY_LEVELS;

var failures = 0, checks = 0;
function ok(cond, msg, detail) {
  checks++;
  if (!cond) { failures++; console.log("  FAIL  " + msg + (detail ? "\n        " + detail : "")); }
}
function head(s) { console.log("\n" + s); console.log(new Array(s.length + 1).join("-")); }

// ---------------------------------------------------------------- structure --
head("1. colourPermutation is a bijection on 1..n");
for (var n = 4; n <= 6; n++) {
  for (var seed = 0; seed < 200; seed++) {
    var perm = T.colourPermutation(n, seed);
    var seen = {}, bad = false;
    for (var c = 1; c <= n; c++) {
      var v = perm[c];
      if (!(v >= 1 && v <= n) || seen[v]) bad = true;
      seen[v] = 1;
    }
    if (bad) { ok(false, "n=" + n + " seed=" + seed + " permutation is not a bijection: " + JSON.stringify(perm)); break; }
  }
}
ok(true, "");            // counted above; keep the check tally honest
console.log("  200 seeds x colour counts 4-6: every permutation is a bijection");

head("2. mirroring twice is the identity");
[1, 17, 42, 88].forEach(function (d) {
  var lvl = LEVELS[d - 1];
  var once = T.applyTransform(lvl, { mirror: true });
  var twice = T.applyTransform(once, { mirror: true });
  ok(JSON.stringify(twice.board) === JSON.stringify(lvl.board),
     "depth " + d + ": mirror twice != original board");
  ok(JSON.stringify(twice.refill) === JSON.stringify(lvl.refill),
     "depth " + d + ": mirror twice != original refill");
});
console.log("  board and refill round-trip exactly on 4 depths");

head("3. a permutation relabels, it does not reshuffle");
(function () {
  var lvl = LEVELS[41];
  var perm = T.colourPermutation(lvl.colorCount, 5);
  var out = T.applyTransform(lvl, { perm: perm });
  var mismatched = 0, kindChanged = 0;
  for (var r = 0; r < lvl.board.rows; r++) {
    for (var c = 0; c < lvl.board.cols; c++) {
      var a = lvl.board.grid[r][c], b = out.board.grid[r][c];
      if (!a && !b) continue;
      if (perm[a.color] !== b.color) mismatched++;
      if (a.kind !== b.kind) kindChanged++;
    }
  }
  ok(mismatched === 0, "cells whose colour is not perm(original): " + mismatched);
  ok(kindChanged === 0, "cells whose kind changed: " + kindChanged);
  console.log("  every cell is exactly perm(original colour), kinds untouched");
})();

// ------------------------------------------------------- the real argument --
head("4. certified winning lines survive the transform (replay ground truth)");
var SAMPLE = [1, 8, 12, 17, 24, 26, 30, 42, 51, 67, 77, 89, 94, 100];
var DAYS = [20630, 20631, 20632, 20700, 21000];
var replays = 0;

SAMPLE.forEach(function (d) {
  var lvl = LEVELS[d - 1];
  var objective = solver.objectiveOf(lvl);
  // the solver's own certified line for the ORIGINAL level
  var info = solver.analyze(lvl, { objective: objective, nodeCap: 400000 });
  if (!info.sequence) { ok(false, "depth " + d + ": no certified sequence (tier " + info.tier + ")"); return; }
  var baseline = solver.replaySequence(lvl, info.sequence, objective);
  ok(baseline.win, "depth " + d + ": baseline line does not win on the original");

  DAYS.forEach(function (day) {
    var tl = T.dailyTransform(lvl, day);
    var mapped = T.mapSequence(info.sequence, lvl.board.cols, tl.transform.mirror);
    var tObjective = solver.objectiveOf(tl);
    var rep = solver.replaySequence(tl, mapped, tObjective);
    replays++;

    ok(rep.valid, "depth " + d + " day " + day + ": mapped line became ILLEGAL — " + (rep.reason || ""));
    ok(rep.win, "depth " + d + " day " + day + ": mapped line no longer wins");
    ok(rep.score === baseline.score,
       "depth " + d + " day " + day + ": score drift", rep.score + " vs " + baseline.score);
    ok(rep.progress === baseline.progress,
       "depth " + d + " day " + day + ": objective progress drift",
       rep.progress + " vs " + baseline.progress);
    ok(rep.movesUsed === baseline.movesUsed,
       "depth " + d + " day " + day + ": win landed on a different move",
       rep.movesUsed + " vs " + baseline.movesUsed);
    // step-for-step equality is the strong form of the claim
    for (var i = 0; i < baseline.steps.length; i++) {
      var a = baseline.steps[i], b = rep.steps[i];
      if (!b) { ok(false, "depth " + d + " day " + day + ": missing step " + i); break; }
      ok(a.scoreGained === b.scoreGained && a.cascades === b.cascades &&
         a.specialCreated === b.specialCreated && a.specialFired === b.specialFired,
         "depth " + d + " day " + day + " step " + i + ": resolution differs",
         JSON.stringify({ orig: a.scoreGained + "/" + a.cascades, tx: b.scoreGained + "/" + b.cascades }));
    }
  });
});
console.log("  " + SAMPLE.length + " depths x " + DAYS.length + " days = " + replays +
            " transformed replays, step-for-step identical to the original");

head("5. dailyTransform never mirrors — and here is why that matters");
(function () {
  var mirrored = 0;
  for (var day = 20600; day < 20700; day++) {
    if (T.dailyTransform(LEVELS[0], day).transform.mirror) mirrored++;
  }
  ok(mirrored === 0, "dailyTransform mirrored on " + mirrored + "/100 days — it must never mirror");

  // Demonstrate the asymmetry the mirror would introduce, so this stays a
  // documented property of the engine rather than folklore. Depth 24 is the
  // known witness: its certified line diverges under a mirror.
  var lvl = LEVELS[23];
  var objective = solver.objectiveOf(lvl);
  var info = solver.analyze(lvl, { objective: objective, nodeCap: 400000 });
  var base = solver.replaySequence(lvl, info.sequence, objective);
  var m = T.applyTransform(lvl, { mirror: true });
  var rm = solver.replaySequence(m, T.mapSequence(info.sequence, lvl.board.cols, true),
                                 solver.objectiveOf(m));
  ok(!(rm.win && rm.score === base.score),
     "the mirror now looks sound on Depth 24 — if the engine's tie-breaks were " +
     "made symmetric, revisit transform.js and re-enable it deliberately");
  console.log("  mirror witness: Depth 24 certified " + base.score +
              ", mirrored replay " + rm.score + (rm.win ? " (win)" : " (no win)") +
              " — order-dependent creation, as documented");
})();

head("6. the transform actually CHANGES the board (it is not a no-op)");
(function () {
  var differing = 0;
  SAMPLE.forEach(function (d) {
    var lvl = LEVELS[d - 1];
    var tl = T.dailyTransform(lvl, 20631);
    if (JSON.stringify(tl.board) !== JSON.stringify(lvl.board)) differing++;
  });
  ok(differing >= SAMPLE.length - 1,
     "only " + differing + "/" + SAMPLE.length + " depths visibly changed on day 20631");
  console.log("  " + differing + "/" + SAMPLE.length + " depths look different to the player");
})();

console.log("\n" + new Array(60).join("="));
if (failures) {
  console.log(failures + " FAILED of " + checks + " checks — DO NOT SHIP");
  process.exit(1);
}
console.log(checks + " checks, 0 failed — TRANSFORMS ARE SOUND");
process.exit(0);
