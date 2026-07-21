/*
 * selfcheck-phase3.js — hand-built fixtures for the Phase-3 ruleset:
 * urchins (L/T wrapped special) + special+special activation combos.
 *
 * Every expected clear set is HAND-COUNTED in the fixture comments and built
 * cell-by-cell in the test, independent of the engine's own union code paths
 * wherever the geometry allows. Run:  node scripts/selfcheck-phase3.js
 * Exit code 0 = all checks passed.
 *
 * Board notation (mirrors logic.js serialize()):
 *   '1'..'6' normal | 'a'..'f' stripe-h | 'A'..'F' stripe-v |
 *   'g'..'l' urchin | '*' bomb.
 */
"use strict";

var path = require("path");
var logic = require(path.join(__dirname, "..", "src", "logic.js"));
var generator = require(path.join(__dirname, "..", "src", "generator.js"));

var failures = 0, checks = 0;
function ok(cond, label) {
  checks++;
  if (cond) { console.log("  ok  " + label); }
  else { failures++; console.log("  FAIL " + label); }
}
function key(r, c) { return r + "," + c; }

// ---- fixture helpers --------------------------------------------------------

function parseCell(ch) {
  if (ch === ".") return null;
  if (ch === "*") return logic.makeCandy(0, "bomb");
  var code = ch.charCodeAt(0);
  if (ch >= "1" && ch <= "6") return logic.makeCandy(code - 48, "normal");
  if (ch >= "a" && ch <= "f") return logic.makeCandy(code - 96, "stripe-h");
  if (ch >= "A" && ch <= "F") return logic.makeCandy(code - 64, "stripe-v");
  if (ch >= "g" && ch <= "l") return logic.makeCandy(code - 102, "urchin");
  throw new Error("bad cell char: " + ch);
}
function boardOf(rows) {
  var b = logic.makeEmptyBoard(rows.length, rows[0].length);
  for (var r = 0; r < rows.length; r++)
    for (var c = 0; c < rows[0].length; c++)
      b.grid[r][c] = parseCell(rows[r][c]);
  return b;
}
// Benign refill: two-color alternation per column (never matters for step-0
// assertions; keeps everything deterministic).
function refillFor(b) {
  var refill = [];
  for (var c = 0; c < b.cols; c++) {
    var q = [];
    for (var i = 0; i < 40; i++) q.push(c % 2 === 0 ? (i % 2 ? 6 : 5) : (i % 2 ? 2 : 1));
    refill.push(q);
  }
  return refill;
}
function zeros(n) { var a = []; for (var i = 0; i < n; i++) a.push(0); return a; }

function apply(b, move) {
  var trace = [];
  var res = logic.applyMove(b, refillFor(b), zeros(b.cols), move,
    { allowSpecials: true, trace: trace });
  res.trace = trace;
  return res;
}
function cellSet(cells) {
  var s = {};
  for (var i = 0; i < cells.length; i++) s[key(cells[i].r, cells[i].c)] = 1;
  return s;
}
function sameSet(cells, expectedKeys) {
  var s = cellSet(cells);
  var e = {};
  for (var i = 0; i < expectedKeys.length; i++) e[expectedKeys[i]] = 1;
  var k;
  for (k in s) if (!e[k]) return false;
  for (k in e) if (!s[k]) return false;
  return true;
}

// ---- 1. L/T mints an urchin at the intersection -----------------------------
// Swap (2,0)<->(2,1) turns row2 into 4,1,1,1 and col1 into 1,1,1: an L of 5
// distinct cells intersecting at (2,1) — which is also the swap destination,
// so swap-cell bias and intersection coincide. Expect: urchin(color1) minted
// at (2,1); cleared = the other 4 run cells (0,1),(1,1),(2,2),(2,3); 4*60=240.
console.log("\n[1] L/T creation mints an urchin at the intersection");
(function () {
  var b = boardOf([
    "21345",
    "31452",
    "14113",
    "23524",
    "42341"
  ]);
  ok(!logic.hasMatch(b), "fixture board has no pre-existing match");
  var res = apply(b, { r1: 2, c1: 0, r2: 2, c2: 1 });
  ok(res.legal, "swap is legal");
  var st = res.trace[0];
  ok(st.creations.length === 1 &&
     st.creations[0].kind === "urchin" &&
     st.creations[0].color === 1 &&
     st.creations[0].r === 2 && st.creations[0].c === 1,
     "one creation: urchin color-1 at (2,1)");
  ok(sameSet(st.cleared, ["0,1", "1,1", "2,2", "2,3"]),
     "step-0 clears exactly the 4 non-creation run cells");
  ok(st.score === 240, "step-0 score 240 (creation cell not scored)");
  var after = st.boardAfter.grid[2][1];
  ok(after !== null && after.kind === "urchin" && after.color === 1,
     "urchin survives at (2,1) after gravity");
  ok(res.specialCreated === true, "specialCreated flag set");
})();

// ---- 2. urchin fire = exactly its 3x3 --------------------------------------
// Urchin(color1) at (2,2); swap (1,3)<->(2,3) makes row2 = 1,1(urchin),1 —
// the urchin sits IN the color run (keeps its color), is caught, and fires
// its 3x3: rows1-3 x cols1-3 = 9 cells (the run is inside the block).
console.log("\n[2] urchin caught in a clear fires exactly its 3x3");
(function () {
  var b = boardOf([
    "23452",
    "52314",
    "31g45",
    "24523",
    "43241"
  ]);
  ok(!logic.hasMatch(b), "fixture board has no pre-existing match");
  var res = apply(b, { r1: 1, c1: 3, r2: 2, c2: 3 });
  ok(res.legal, "swap is legal (urchin participates in the color run)");
  var st = res.trace[0];
  var expect = [];
  for (var r = 1; r <= 3; r++) for (var c = 1; c <= 3; c++) expect.push(key(r, c));
  ok(sameSet(st.cleared, expect), "step-0 clears exactly the 3x3 block (1..3)x(1..3)");
  ok(st.score === 9 * 60, "step-0 score 540");
  ok(res.specialFired === true, "specialFired flag set");
})();

// Base 6x6 with zero matches anywhere: grid[r][c] = ((r+c)%6)+1.
function diagRows(overrides) {
  var rows = [];
  for (var r = 0; r < 6; r++) {
    var s = "";
    for (var c = 0; c < 6; c++) {
      s += (overrides && overrides[key(r, c)]) || String(((r + c) % 6) + 1);
    }
    rows.push(s);
  }
  return rows;
}

// ---- 3. stripe + stripe -> cross --------------------------------------------
// stripe-v(3) at (2,2) + stripe-v(4) at (2,3); swap dest (2,3). Expect row 2
// + column 3 = 6+6-1 = 11 cells. Both stripes CONSUMED: the stripe-v at (2,2)
// must NOT fire column 2 (suppression) — (0,2) etc. stay put.
console.log("\n[3] stripe+stripe activation clears the cross (11 cells)");
(function () {
  var b = boardOf(diagRows({ "2,2": "C", "2,3": "D" }));
  ok(!logic.hasMatch(b), "fixture board has no pre-existing match");
  var res = apply(b, { r1: 2, c1: 2, r2: 2, c2: 3 });
  ok(res.legal, "special+special swap is legal without a match");
  var st = res.trace[0];
  var expect = [];
  for (var c = 0; c < 6; c++) expect.push(key(2, c));
  for (var r = 0; r < 6; r++) if (r !== 2) expect.push(key(r, 3));
  ok(sameSet(st.cleared, expect), "step-0 clears exactly row 2 + col 3 (11 cells)");
  ok(st.score === 11 * 60, "step-0 score 660");
  var s = cellSet(st.cleared);
  ok(!s["0,2"] && !s["1,2"] && !s["3,2"] && !s["4,2"] && !s["5,2"],
     "consumed stripe-v at (2,2) did NOT fire its own column (suppression)");
  ok(res.specialFired === true, "specialFired flag set");

  // legalMoves integration on the same board:
  var lm = logic.legalMoves(b, refillFor(b), zeros(b.cols), {});
  var found = lm.some(function (m) {
    return m.move.r1 === 2 && m.move.c1 === 2 && m.move.r2 === 2 && m.move.c2 === 3;
  });
  ok(found, "legalMoves (default) includes the always-legal combo swap");
  var lmNo = logic.legalMoves(b, refillFor(b), zeros(b.cols), { noSpecial: true });
  var foundNo = lmNo.some(function (m) {
    return m.move.r1 === 2 && m.move.c1 === 2 && m.move.r2 === 2 && m.move.c2 === 3;
  });
  ok(!foundNo, "legalMoves {noSpecial} excludes the combo swap");

  // stripe + NORMAL with no resulting match stays ILLEGAL (match-required):
  var bad = logic.applyMove(b, refillFor(b), zeros(b.cols),
    { r1: 2, c1: 2, r2: 3, c2: 2 }, { allowSpecials: true });
  ok(bad.legal === false, "stripe+normal swap without a match is still illegal");
})();

// ---- 4. stripe + urchin -> 3 rows + 3 cols ----------------------------------
// stripe-v(3) at (2,2) + urchin(4) at (2,3); dest (2,3). Rows 1-3 + cols 2-4:
// 3*6 + 3*6 - 9 = 27 cells.
console.log("\n[4] stripe+urchin activation clears 3 rows + 3 cols (27 cells)");
(function () {
  var b = boardOf(diagRows({ "2,2": "C", "2,3": "j" }));
  ok(!logic.hasMatch(b), "fixture board has no pre-existing match");
  var res = apply(b, { r1: 2, c1: 2, r2: 2, c2: 3 });
  ok(res.legal, "swap legal");
  var st = res.trace[0];
  var expect = [];
  for (var r = 0; r < 6; r++) {
    for (var c = 0; c < 6; c++) {
      if ((r >= 1 && r <= 3) || (c >= 2 && c <= 4)) expect.push(key(r, c));
    }
  }
  ok(expect.length === 27, "hand count: 27 expected cells");
  ok(sameSet(st.cleared, expect), "step-0 clears exactly rows 1-3 + cols 2-4");
  ok(st.score === 27 * 60, "step-0 score 1620");
})();

// ---- 5. urchin + urchin -> 5x5 blast ----------------------------------------
// urchin(1) at (2,2) + urchin(2) at (2,3); dest (2,3). 5x5 centered (2,3),
// clipped: rows 0-4 x cols 1-5 = 25 cells.
console.log("\n[5] urchin+urchin activation clears the 5x5 blast (25 cells)");
(function () {
  var b = boardOf(diagRows({ "2,2": "g", "2,3": "h" }));
  ok(!logic.hasMatch(b), "fixture board has no pre-existing match");
  var res = apply(b, { r1: 2, c1: 2, r2: 2, c2: 3 });
  ok(res.legal, "swap legal");
  var st = res.trace[0];
  var expect = [];
  for (var r = 0; r <= 4; r++) for (var c = 1; c <= 5; c++) expect.push(key(r, c));
  ok(sameSet(st.cleared, expect), "step-0 clears exactly rows 0-4 x cols 1-5");
  ok(st.score === 25 * 60, "step-0 score 1500");
})();

// Base 6x6 on palette {1,2,4,5} (no color 3): grid[r][c] = [1,2,4,5][(r+c)%4].
function cyc4Rows(overrides) {
  var pal = ["1", "2", "4", "5"], rows = [];
  for (var r = 0; r < 6; r++) {
    var s = "";
    for (var c = 0; c < 6; c++) {
      s += (overrides && overrides[key(r, c)]) || pal[(r + c) % 4];
    }
    rows.push(s);
  }
  return rows;
}

// ---- 6. pearl + stripe -> convert-and-fire ----------------------------------
// bomb at (2,2), stripe-h(3) at (2,3). Color-3 cells: (0,4) sum 4 even -> ROW 0;
// (2,3) sum 5 odd -> COL 3; (4,1) sum 5 odd -> COL 1. Union: row0 + col3 + col1
// = 6+5+5 = 16 (overlaps (0,3),(0,1)) + bomb (2,2) = 17 cells; 17*60 = 1020.
// (5,3) is NOT color 3 yet clears — proves the converts FIRE, not just color-clear.
console.log("\n[6] pearl+stripe converts every color-3 candy to a firing stripe");
(function () {
  var b = boardOf(cyc4Rows({ "2,2": "*", "2,3": "c", "4,1": "3", "0,4": "3" }));
  ok(!logic.hasMatch(b), "fixture board has no pre-existing match");
  var res = apply(b, { r1: 2, c1: 2, r2: 2, c2: 3 });
  ok(res.legal, "swap legal");
  var st = res.trace[0];
  var expect = [];
  for (var c = 0; c < 6; c++) expect.push(key(0, c));            // row 0
  for (var r = 1; r < 6; r++) expect.push(key(r, 3));            // col 3 (minus (0,3))
  for (var r2 = 1; r2 < 6; r2++) expect.push(key(r2, 1));        // col 1 (minus (0,1))
  expect.push(key(2, 2));                                        // the consumed bomb
  ok(expect.length === 17, "hand count: 17 expected cells");
  ok(sameSet(st.cleared, expect), "step-0 clears exactly row0 + col1 + col3 + bomb");
  ok(st.score === 17 * 60, "step-0 score 1020");
  var s = cellSet(st.cleared);
  ok(s["5,3"] === 1, "(5,3), not color 3, cleared by the converted stripe's column");
  ok(s["2,2"] === 1, "bomb consumed");
  ok(!s["3,0"], "cells off the fired lines untouched");
})();

// ---- 7. pearl + urchin -> every color-3 candy blasts 3x3 --------------------
// bomb at (2,2), urchin(3) at (2,3). Color-3 cells: (2,3),(5,0),(0,5).
// Blocks: (2,3)->rows1-3 x cols2-4 (9, contains the bomb); (5,0)->rows4-5 x
// cols0-1 (4); (0,5)->rows0-1 x cols4-5 (4). Overlap: (1,4) in blocks 1&3.
// Union = 9+4+4-1 = 16 cells; 16*60 = 960.
console.log("\n[7] pearl+urchin blasts a 3x3 at every color-3 candy");
(function () {
  var b = boardOf(cyc4Rows({ "2,2": "*", "2,3": "i", "5,0": "3", "0,5": "3" }));
  ok(!logic.hasMatch(b), "fixture board has no pre-existing match");
  var res = apply(b, { r1: 2, c1: 2, r2: 2, c2: 3 });
  ok(res.legal, "swap legal");
  var st = res.trace[0];
  var e = {};
  var centers = [[2, 3], [5, 0], [0, 5]];
  for (var i = 0; i < centers.length; i++) {
    for (var r = centers[i][0] - 1; r <= centers[i][0] + 1; r++) {
      for (var c = centers[i][1] - 1; c <= centers[i][1] + 1; c++) {
        if (r >= 0 && r < 6 && c >= 0 && c < 6) e[key(r, c)] = 1;
      }
    }
  }
  e[key(2, 2)] = 1; // bomb (already inside block 1)
  var expect = Object.keys(e);
  ok(expect.length === 16, "hand count: 16 expected cells");
  ok(sameSet(st.cleared, expect), "step-0 clears exactly the three 3x3 blocks + bomb");
  ok(st.score === 16 * 60, "step-0 score 960");
})();

// ---- 8. pearl + pearl -> whole board (unchanged) ----------------------------
console.log("\n[8] pearl+pearl still clears the whole board");
(function () {
  var b = boardOf(diagRows({ "2,2": "*", "2,3": "*" }));
  var res = apply(b, { r1: 2, c1: 2, r2: 2, c2: 3 });
  ok(res.legal, "swap legal");
  ok(res.trace[0].cleared.length === 36, "step-0 clears all 36 cells");
  ok(res.trace[0].score === 36 * 60, "step-0 score 2160");
})();

// ---- 9. determinism ---------------------------------------------------------
console.log("\n[9] determinism: identical inputs -> identical full results");
(function () {
  function runOnce() {
    var b = boardOf(cyc4Rows({ "2,2": "*", "2,3": "c", "4,1": "3", "0,4": "3" }));
    var res = apply(b, { r1: 2, c1: 2, r2: 2, c2: 3 });
    return JSON.stringify({
      board: logic.serialize(res.board),
      score: res.scoreGained,
      cascades: res.cascades,
      pointers: res.pointers,
      trace: res.trace.map(function (t) {
        return { cleared: t.cleared, creations: t.creations, score: t.score,
                 boardAfter: logic.serialize(t.boardAfter) };
      })
    });
  }
  ok(runOnce() === runOnce(), "same combo move twice gives byte-identical results");
})();

// ---- 10. generator still certifies under the new rules ----------------------
console.log("\n[10] generator.generate('hard', seed) under Phase-3 rules");
(function () {
  var seeds = [11, 12, 13];
  for (var i = 0; i < seeds.length; i++) {
    var t0 = Date.now();
    try {
      var lvl = generator.generate("hard", seeds[i]);
      console.log("  seed " + seeds[i] + ": certified hard on attempt " +
        lvl.attempt + " (" + lvl.stats.attempts + " candidates, target " +
        lvl.target + ", " + (Date.now() - t0) + "ms)");
      ok(lvl.tier === "hard", "seed " + seeds[i] + " certified at tier hard");
    } catch (e) {
      ok(false, "seed " + seeds[i] + " generate failed: " + e.message);
    }
  }
})();

// ---- summary ----------------------------------------------------------------
console.log("\n" + new Array(60).join("="));
console.log(failures === 0
  ? "ALL " + checks + " CHECKS PASSED"
  : failures + " OF " + checks + " CHECKS FAILED");
process.exitCode = failures === 0 ? 0 : 1;
