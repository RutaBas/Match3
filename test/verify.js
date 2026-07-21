/*
 * Adversarial verification gate for the Candy-Crush-dupe logic core.
 * Run: node test/verify.js   (exit 0 only if EVERY check passes)
 *
 * Philosophy: the solver is assumed WRONG until independent numbers say so.
 * Ground truth is recomputed HERE, never borrowed from the code under test:
 *   - matches: our own maximal H/V run scan over matchColor semantics;
 *   - gravity/refill: our own column-collapse + top-refill with pointer draws;
 *   - cascades + combo scoring: our own clear->gravity->refill->rematch loop;
 *   - specials: hand-built boards with hand-counted expected clears;
 *   - every certified winning sequence is REPLAYED here through logic.applyMove
 *     (NOT solver.replaySequence) and judged score>=target.
 * A single soundness violation fails the build.
 *
 * PHASE 3 (checks 11-18): urchins (L/T special) + special+special activation
 * combos. Ground truth again recomputed HERE:
 *   - L/T detection + creation priority (pearl > urchin > stripe) via
 *     hand-built shape fixtures with hand-counted clears/scores;
 *   - urchin 3x3 geometry (center + edge/corner clipping) hand-counted;
 *   - every combo's exact cell union + score hand-counted on fixture boards
 *     (cross, 3-rows+3-cols, 5x5, bomb-convert parity, bomb-3x3, whole board),
 *     including consumed-special suppression and caught-special chaining;
 *   - a FULL independent Phase-3 engine (runs, creations w/ priority passes,
 *     fire expansion, combo unions, cascade loop) re-derived from SPEC 3/3b,
 *     swept against logic.applyMove over hundreds of random boards;
 *   - serialization round-trip incl. urchin chars 'g'..'l';
 *   - campaign spot-check: sampled shipped depths re-solved to their stored
 *     target under the new rules, witness replayed independently.
 */
"use strict";

var path = require("path");
var L = require(path.join(__dirname, "..", "src", "logic.js"));
var S = require(path.join(__dirname, "..", "src", "solver.js"));
var G = require(path.join(__dirname, "..", "src", "generator.js"));
var RNG = require(path.join(__dirname, "..", "src", "rng.js"));

var BASE = L.BASE_SCORE; // 60

// ------------------------------------------------------------ harness core --

var results = [];
function check(name, fn) {
  var t0 = Date.now();
  var r;
  try { r = fn(); }
  catch (e) { r = { pass: false, detail: "EXCEPTION: " + (e && e.stack || e) }; }
  r.ms = Date.now() - t0;
  r.name = name;
  results.push(r);
  console.log((r.pass ? "PASS" : "FAIL") + "  " + name + "  [" + r.ms + " ms]");
  console.log("      " + r.detail.split("\n").join("\n      "));
  return r;
}

// ----------------------------------------- independent ground-truth engine --
// Reimplemented from the SPEC, deliberately NOT calling logic's matcher/gravity.

function mc(cd) {                       // matchColor, recomputed
  if (cd === null) return -1;
  if (cd.kind === "bomb") return 0;     // wildcard: never groups
  return cd.color;
}

// Every maximal H/V run of >=3 equal real colors, as normalized strings.
function indepRuns(board) {
  var runs = [], cellset = {};
  var r, c;
  for (r = 0; r < board.rows; r++) {
    c = 0;
    while (c < board.cols) {
      var v = mc(board.grid[r][c]);
      if (v >= 1) {
        var c2 = c + 1;
        while (c2 < board.cols && mc(board.grid[r][c2]) === v) c2++;
        if (c2 - c >= 3) {
          var cells = [];
          for (var cc = c; cc < c2; cc++) { cells.push(r + "," + cc); cellset[r + "," + cc] = 1; }
          runs.push("h:" + (c2 - c) + ":" + v + ":" + cells.slice().sort().join("|"));
        }
        c = c2;
      } else c++;
    }
  }
  for (c = 0; c < board.cols; c++) {
    r = 0;
    while (r < board.rows) {
      var w = mc(board.grid[r][c]);
      if (w >= 1) {
        var r2 = r + 1;
        while (r2 < board.rows && mc(board.grid[r2][c]) === w) r2++;
        if (r2 - r >= 3) {
          var cellsv = [];
          for (var rr = r; rr < r2; rr++) { cellsv.push(rr + "," + c); cellset[rr + "," + c] = 1; }
          runs.push("v:" + (r2 - r) + ":" + w + ":" + cellsv.slice().sort().join("|"));
        }
        r = r2;
      } else r++;
    }
  }
  return { runs: runs.slice().sort(), cellset: cellset };
}
function indepHasMatch(board) {
  var ir = indepRuns(board);
  return ir.runs.length > 0;
}

// Independent gravity + top-refill; returns { grid (as serialized), ptr }.
// Draws are cyclic on the fixed per-column queue (q[ptr%len]).
function indepGravity(board, refill, pointers) {
  var b = L.cloneBoard(board);
  var ptr = pointers.slice();
  for (var c = 0; c < b.cols; c++) {
    var survivors = [];
    for (var r = b.rows - 1; r >= 0; r--) if (b.grid[r][c] !== null) survivors.push(b.grid[r][c]);
    var idx = 0;
    for (var rr = b.rows - 1; rr >= 0; rr--) {
      if (idx < survivors.length) b.grid[rr][c] = survivors[idx++];
      else {
        var q = refill[c];
        var color = (q && q.length) ? q[ptr[c] % q.length] : 1;
        ptr[c]++;
        b.grid[rr][c] = L.makeCandy(color, "normal");
      }
    }
  }
  return { grid: L.serialize(b), ptr: ptr };
}

// Independent NO-SPECIAL cascade sim on an already-set board (post-swap or raw).
// Returns { score, board(serialized), steps, specialsSeen }. If any run of >=4
// forms OR any existing special is present, sets specialsSeen and bails (the
// caller then skips the sample: specials are covered by the hand-built tests).
function indepResolveNoSpecial(board, refill, pointers) {
  var b = L.cloneBoard(board);
  var ptr = pointers.slice();
  // any pre-existing special makes this unsuitable for the plain-match sim
  for (var r0 = 0; r0 < b.rows; r0++)
    for (var c0 = 0; c0 < b.cols; c0++)
      if (b.grid[r0][c0] !== null && b.grid[r0][c0].kind !== "normal")
        return { specialsSeen: true };

  var score = 0, combo = 1, steps = 0;
  while (steps < 500) {
    var ir = indepRuns(b);
    if (ir.runs.length === 0) break;
    // detect a >=4 run (would mint a special) -> out of scope for this sim
    for (var i = 0; i < ir.runs.length; i++) {
      if (parseInt(ir.runs[i].split(":")[1], 10) >= 4) return { specialsSeen: true };
    }
    var keys = Object.keys(ir.cellset);
    var cleared = 0;
    for (i = 0; i < keys.length; i++) {
      var p = keys[i].split(","), rr = +p[0], cc = +p[1];
      if (b.grid[rr][cc] !== null) { b.grid[rr][cc] = null; cleared++; }
    }
    score += cleared * BASE * combo;
    // gravity + refill (mutate b, advance ptr) -- reuse our indep routine
    var g = indepGravityMutate(b, refill, ptr);
    ptr = g;
    combo++;
    steps++;
  }
  return { score: score, board: L.serialize(b), steps: steps, specialsSeen: false };
}
// in-place variant used by the cascade sim
function indepGravityMutate(b, refill, ptr) {
  for (var c = 0; c < b.cols; c++) {
    var survivors = [];
    for (var r = b.rows - 1; r >= 0; r--) if (b.grid[r][c] !== null) survivors.push(b.grid[r][c]);
    var idx = 0;
    for (var rr = b.rows - 1; rr >= 0; rr--) {
      if (idx < survivors.length) b.grid[rr][c] = survivors[idx++];
      else {
        var q = refill[c];
        var color = (q && q.length) ? q[ptr[c] % q.length] : 1;
        ptr[c]++;
        b.grid[rr][c] = L.makeCandy(color, "normal");
      }
    }
  }
  return ptr;
}

function zeros(n) { var a = []; for (var i = 0; i < n; i++) a.push(0); return a; }
function startPtr(level) { return level.pointers ? level.pointers.slice() : zeros(level.board.cols); }

// INDEPENDENT replay of a move sequence through logic.applyMove (NOT
// solver.replaySequence). Sums scoreGained; wins at first prefix >= target.
function myReplay(level, seq) {
  var board = L.cloneBoard(level.board);
  var ptr = startPtr(level);
  var score = 0;
  for (var i = 0; i < seq.length; i++) {
    var res = L.applyMove(board, level.refill, ptr, seq[i], { allowSpecials: true });
    if (!res.legal) return { win: false, valid: false, score: score, illegalAt: i };
    board = res.board; ptr = res.pointers; score += res.scoreGained;
    if (score >= level.target) return { win: true, valid: true, score: score, movesUsed: i + 1 };
  }
  return { win: score >= level.target, valid: true, score: score, movesUsed: seq.length };
}

// INDEPENDENT greedy (myopic, no-special). target=Infinity => play full budget.
function myGreedy(level) {
  var board = L.cloneBoard(level.board);
  var ptr = startPtr(level);
  var score = 0, seq = [];
  var target = level.target;
  for (var m = 0; m < level.moves; m++) {
    if (score >= target) break;
    var best = null;
    for (var r = 0; r < board.rows; r++) {
      for (var c = 0; c < board.cols; c++) {
        var dirs = [[r, c + 1], [r + 1, c]];
        for (var d = 0; d < dirs.length; d++) {
          var nr = dirs[d][0], nc = dirs[d][1];
          if (nr >= board.rows || nc >= board.cols) continue;
          var mv = { r1: r, c1: c, r2: nr, c2: nc };
          var res = L.applyMove(board, level.refill, ptr, mv, { allowSpecials: false });
          if (!res.legal) continue;
          if (res.specialCreated || res.specialFired) continue; // no-special player
          if (best === null || res.scoreGained > best.res.scoreGained) best = { mv: mv, res: res };
        }
      }
    }
    if (best === null) break;
    board = best.res.board; ptr = best.res.pointers; score += best.res.scoreGained; seq.push(best.mv);
  }
  return { score: score, seq: seq };
}

// Random RAW board (may contain holes and, optionally, specials) for stress.
function randRawBoard(rows, cols, colors, rng, holeProb, specialProb) {
  var b = L.makeEmptyBoard(rows, cols);
  for (var r = 0; r < rows; r++) {
    for (var c = 0; c < cols; c++) {
      if (rng() < holeProb) { b.grid[r][c] = null; continue; }
      var color = 1 + RNG.randInt(rng, colors);
      var kind = "normal";
      if (specialProb && rng() < specialProb) {
        // Phase 3: urchins join the random-kind pool (a strengthening — the
        // run scan must treat them exactly like colored candies).
        var k = RNG.randInt(rng, 4);
        kind = k === 0 ? "stripe-h" : k === 1 ? "stripe-v" : k === 2 ? "urchin" : "bomb";
      }
      b.grid[r][c] = L.makeCandy(kind === "bomb" ? 0 : color, kind);
    }
  }
  return b;
}

// Tiny random *level* (no pre-existing match, has an opening) for soundness.
function randLevel(rng, rows, cols, colors, budget, target) {
  var cfg = { rows: rows, cols: cols, colors: colors, budget: budget };
  var board = null, tries = 0;
  while (!board && tries < 60) { board = G.buildStartBoard(cfg, rng); tries++; }
  if (!board) return null;
  var refill = G.buildRefill(cfg, rng);
  var lvl = { board: board, refill: refill, moves: budget, colorCount: colors, target: target };
  if (!L.hasAnyLegalMove(board, refill, zeros(cols))) return null;
  return lvl;
}

// ---------------------------------------------------------------- gen pool --

var GENCOUNT = { easy: 10, medium: 8, hard: 4 };
var POOL = { easy: [], medium: [], hard: [] };
var GEN_MS = 0;
(function prime() {
  var t0 = Date.now();
  var tiers = ["easy", "medium", "hard"];
  for (var t = 0; t < tiers.length; t++) {
    var tier = tiers[t];
    for (var i = 0; i < GENCOUNT[tier]; i++) POOL[tier].push(G.generate(tier, 2000 + i));
  }
  GEN_MS = Date.now() - t0;
})();

// analyze() is expensive (esp. hard); cache one result per level.
var ANALYZE = { easy: [], medium: [], hard: [] };
function analyzeCached(tier, i) {
  if (!ANALYZE[tier][i]) {
    var lvl = POOL[tier][i];
    ANALYZE[tier][i] = S.analyze(lvl, { nodeCap: G.configForTier(tier).nodeCap });
  }
  return ANALYZE[tier][i];
}

// ================================================================ CHECK 1 ==
// MATCH DETECTION: logic.findRuns == our independent maximal-run scan, on
// thousands of random boards (incl. stripes that DO group and bombs that don't).

check("1. MATCH DETECTION: logic.findRuns == independent run scan", function () {
  var rng = RNG.makeRng("candy-match-1");
  var boards = 0, mism = 0, totalRuns = 0, samples = [];
  for (var it = 0; it < 3000; it++) {
    var rows = 3 + RNG.randInt(rng, 6), cols = 3 + RNG.randInt(rng, 6);
    var colors = 3 + RNG.randInt(rng, 4);
    var b = randRawBoard(rows, cols, colors, rng, 0.12, 0.10);
    boards++;
    var got = L.findRuns(b).map(function (run) {
      var cells = run.cells.map(function (x) { return x.r + "," + x.c; }).sort().join("|");
      return run.dir + ":" + run.len + ":" + run.color + ":" + cells;
    }).sort();
    var exp = indepRuns(b).runs;
    totalRuns += exp.length;
    if (got.join("#") !== exp.join("#")) {
      mism++;
      if (samples.length < 4) samples.push(rows + "x" + cols + " got[" + got.join(" ") + "] exp[" + exp.join(" ") + "]");
    }
  }
  return {
    pass: boards > 0 && mism === 0,
    detail: [
      "random boards=" + boards + " (with holes + stripes + bombs)",
      "independent runs found=" + totalRuns + ", run-set mismatches=" + mism,
      samples.length ? samples.join("\n") : "every board's run set matches exactly"
    ].join("\n")
  };
});

// ================================================================ CHECK 2 ==
// GRAVITY + REFILL: logic.gravityAndRefill (board + advanced pointers) == our
// independent column-collapse + top-refill with pointer draws (incl. wrap).

check("2. GRAVITY + REFILL: board + advanced pointers match independent sim", function () {
  var rng = RNG.makeRng("candy-gravity-2");
  var boards = 0, gridMism = 0, ptrMism = 0, wrapHit = 0, samples = [];
  for (var it = 0; it < 3000; it++) {
    var rows = 3 + RNG.randInt(rng, 6), cols = 3 + RNG.randInt(rng, 6);
    var colors = 3 + RNG.randInt(rng, 4);
    var b = randRawBoard(rows, cols, colors, rng, 0.45, 0);       // lots of holes
    // short queues sometimes -> exercises the cyclic wrap fallback
    var refill = [];
    for (var c = 0; c < cols; c++) {
      var qlen = 1 + RNG.randInt(rng, rows + 1);
      var q = [];
      for (var k = 0; k < qlen; k++) q.push(1 + RNG.randInt(rng, colors));
      refill.push(q);
    }
    var pointers = [];
    for (c = 0; c < cols; c++) pointers.push(RNG.randInt(rng, 3));

    var indep = indepGravity(b, refill, pointers);
    var logicBoard = L.cloneBoard(b);
    var gotPtr = L.gravityAndRefill(logicBoard, refill, pointers);
    boards++;
    // did any column need more draws than its queue length? (wrap exercised)
    for (c = 0; c < cols; c++) if (gotPtr[c] > refill[c].length) { wrapHit++; break; }

    if (L.serialize(logicBoard) !== indep.grid) {
      gridMism++;
      if (samples.length < 4) samples.push("grid " + rows + "x" + cols + " got[" + L.serialize(logicBoard) + "] exp[" + indep.grid + "]");
    }
    if (gotPtr.join(",") !== indep.ptr.join(",")) {
      ptrMism++;
      if (samples.length < 4) samples.push("ptr " + rows + "x" + cols + " got[" + gotPtr.join(",") + "] exp[" + indep.ptr.join(",") + "]");
    }
  }
  return {
    pass: boards > 0 && gridMism === 0 && ptrMism === 0,
    detail: [
      "random boards=" + boards + " (45% holes, short queues to force wrap)",
      "board mismatches=" + gridMism + ", pointer mismatches=" + ptrMism + ", boards exercising queue-wrap=" + wrapHit,
      samples.length ? samples.join("\n") : "board + advanced pointers match on every board"
    ].join("\n")
  };
});

// ================================================================ CHECK 3 ==
// CASCADE + COMBO SCORING: on no-pre-match boards, for every legal PLAIN-match
// swap (no special created/fired) the resolved board AND the combo-multiplier
// score match our own clear->gravity->refill->rematch loop. Multi-step cascades
// (combo>1) are asserted to actually occur so the multiplier is exercised.

check("3. CASCADE + SCORING: resolve board & combo score == independent loop", function () {
  var rng = RNG.makeRng("candy-cascade-3");
  var boards = 0, samplesTested = 0, gridMism = 0, scoreMism = 0, multiStep = 0, skippedSpecial = 0, ex = [];
  for (var it = 0; it < 260; it++) {
    var rows = 4 + RNG.randInt(rng, 4), cols = 4 + RNG.randInt(rng, 4);
    var colors = 3 + RNG.randInt(rng, 3);
    var cfg = { rows: rows, cols: cols, colors: colors, budget: 4 };
    var board = G.buildStartBoard(cfg, rng);
    if (!board) continue;
    var refill = G.buildRefill(cfg, rng);
    boards++;
    var ptr = zeros(cols);
    // enumerate every adjacent swap once (right + down)
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        var dirs = [[r, c + 1], [r + 1, c]];
        for (var d = 0; d < dirs.length; d++) {
          var nr = dirs[d][0], nc = dirs[d][1];
          if (nr >= rows || nc >= cols) continue;
          // build the post-swap board independently and check IT has a match
          var sw = L.cloneBoard(board);
          var A = sw.grid[r][c], B = sw.grid[nr][nc];
          sw.grid[r][c] = B; sw.grid[nr][nc] = A;
          if (!indepHasMatch(sw)) continue;
          // independent resolve from the swapped board
          var indep = indepResolveNoSpecial(sw, refill, ptr);
          if (indep.specialsSeen) { skippedSpecial++; continue; }
          // logic resolve via applyMove (full pipeline)
          var res = L.applyMove(board, refill, ptr, { r1: r, c1: c, r2: nr, c2: nc }, { allowSpecials: true });
          if (!res.legal) { gridMism++; if (ex.length < 4) ex.push("logic rejected a swap our scan says matches @" + r + "," + c); continue; }
          if (res.specialCreated || res.specialFired) { skippedSpecial++; continue; }
          samplesTested++;
          if (indep.steps > 1) multiStep++;
          if (L.serialize(res.board) !== indep.board) {
            gridMism++; if (ex.length < 4) ex.push("board mismatch @" + r + "," + c + " got[" + L.serialize(res.board) + "] exp[" + indep.board + "]");
          }
          if (res.scoreGained !== indep.score) {
            scoreMism++; if (ex.length < 4) ex.push("score mismatch @" + r + "," + c + " got=" + res.scoreGained + " exp=" + indep.score);
          }
        }
      }
    }
  }
  var pass = samplesTested > 0 && gridMism === 0 && scoreMism === 0 && multiStep > 0;
  return {
    pass: pass,
    detail: [
      "no-pre-match boards=" + boards + ", plain-match swaps compared=" + samplesTested + " (special swaps skipped=" + skippedSpecial + ")",
      "board mismatches=" + gridMism + ", combo-score mismatches=" + scoreMism,
      "multi-cascade (combo>1) samples exercised=" + multiStep + " (must be >0)",
      ex.length ? ex.join("\n") : "resolved board + combo score agree on every plain-match swap"
    ].join("\n")
  };
});

// ================================================================ CHECK 4 ==
// SPECIALS: hand-built boards with HAND-COUNTED expected clears.
//  (a) match-4 swap mints the right stripe (kind + orientation) & flags created.
//  (b) a stripe-h caught in a 3-run FIRES its full ROW  (5 cleared -> 300).
//  (c) a stripe-v caught in a 3-run FIRES its full COL  (5 cleared -> 300).
//  (d) a match-5 mints a BOMB (survives; 4 cleared -> 240).
//  (e) bomb-swap clears exactly the PARTNER color (4 cleared -> 240; color gone).
//  (f) bomb+bomb swap clears the whole board (>= cells*60).

check("4. SPECIALS: stripe/bomb creation + firing vs hand-counted clears", function () {
  var f = [];
  function candy(ch) { return ch; }

  // (a) match-4 horizontal -> stripe-h at the swap cell; specialCreated true.
  //   row0: 1 1 1 2 ; (1,3)=1. swap (0,3)<->(1,3) => row0 = 1 1 1 1 (run4).
  var a = L.makeEmptyBoard(4, 4);
  a.grid[0][0] = L.makeCandy(1); a.grid[0][1] = L.makeCandy(1); a.grid[0][2] = L.makeCandy(1);
  a.grid[0][3] = L.makeCandy(2); a.grid[1][3] = L.makeCandy(1);
  // fill the rest with a no-op checkerboard so nothing else matches pre-swap
  for (var rr = 1; rr < 4; rr++) for (var cc = 0; cc < 4; cc++) if (a.grid[rr][cc] === null) a.grid[rr][cc] = L.makeCandy(((rr + cc) % 2) ? 3 : 4);
  var refA = []; for (var c = 0; c < 4; c++) refA.push([5, 6, 5, 6, 5, 6]);
  var ra = L.applyMove(a, refA, zeros(4), { r1: 0, c1: 3, r2: 1, c2: 3 }, { allowSpecials: true });
  if (!ra.legal) f.push("(a) match-4 swap rejected");
  if (!ra.specialCreated) f.push("(a) specialCreated flag false for a run of 4");
  var stripeH = 0, stripeV = 0, bombs = 0;
  for (rr = 0; rr < 4; rr++) for (cc = 0; cc < 4; cc++) {
    var cd = ra.board.grid[rr][cc];
    if (cd && cd.kind === "stripe-h") stripeH++;
    if (cd && cd.kind === "stripe-v") stripeV++;
    if (cd && cd.kind === "bomb") bombs++;
  }
  if (stripeH !== 1 || stripeV !== 0 || bombs !== 0) f.push("(a) expected exactly 1 stripe-h, got h=" + stripeH + " v=" + stripeV + " bomb=" + bombs);

  // (b) stripe-h FIRES its full row. row2: [Sh1,1,1,3,4], rows0/1 empty.
  //   3-run (color1) catches the stripe -> whole row (5 cells) clears; refill
  //   is a 2/3 checkerboard so NO cascade -> scoreGained == 5*60 == 300.
  var b = L.makeEmptyBoard(3, 5);
  b.grid[2][0] = L.makeCandy(1, "stripe-h");
  b.grid[2][1] = L.makeCandy(1); b.grid[2][2] = L.makeCandy(1);
  b.grid[2][3] = L.makeCandy(3); b.grid[2][4] = L.makeCandy(4);
  // queues (bottom-first): produce a 2/3 checkerboard board with no triple
  var refB = [[2, 3, 2], [3, 2, 3], [2, 3, 2], [3, 2, 3], [2, 3, 2]].map(function (q) { return q.concat(q); });
  var rb = L.resolveInternal(b, refB, zeros(5), { type: "match", swapCells: [] });
  if (rb.scoreGained !== 5 * BASE) f.push("(b) stripe-h fire scored " + rb.scoreGained + " expected " + (5 * BASE) + " (full row=5)");
  if (!rb.specialFired) f.push("(b) specialFired false when a stripe-h was caught");
  if (indepHasMatch(rb.board)) f.push("(b) post-fire board unexpectedly has a match (cascade leaked)");

  // (c) stripe-v FIRES its full column. col0 = [Sv1,1,1,5,6], other cols empty.
  var cc0 = L.makeEmptyBoard(5, 3);
  cc0.grid[0][0] = L.makeCandy(1, "stripe-v");
  cc0.grid[1][0] = L.makeCandy(1); cc0.grid[2][0] = L.makeCandy(1);
  cc0.grid[3][0] = L.makeCandy(5); cc0.grid[4][0] = L.makeCandy(6);
  // bottom-first queues for a 2/3 checkerboard (rows 0..4 by (r+c) parity)
  var refC = [
    [2, 3, 2, 3, 2], // col0
    [3, 2, 3, 2, 3], // col1
    [2, 3, 2, 3, 2]  // col2
  ].map(function (q) { return q.concat(q); });
  var rc = L.resolveInternal(cc0, refC, zeros(3), { type: "match", swapCells: [] });
  if (rc.scoreGained !== 5 * BASE) f.push("(c) stripe-v fire scored " + rc.scoreGained + " expected " + (5 * BASE) + " (full col=5)");
  if (!rc.specialFired) f.push("(c) specialFired false when a stripe-v was caught");
  if (indepHasMatch(rc.board)) f.push("(c) post-fire board unexpectedly has a match (cascade leaked)");

  // (d) match-5 -> BOMB minted at run midpoint; it SURVIVES so only 4 clear.
  //   row0 = [1,1,1,1,1], rows1/2 empty; 2/3 checkerboard refill, bomb parks at
  //   (2,2). scoreGained == 4*60 == 240, exactly one bomb on the board.
  var dd = L.makeEmptyBoard(3, 5);
  for (c = 0; c < 5; c++) dd.grid[0][c] = L.makeCandy(1);
  var refD = [[2, 3, 2], [3, 2, 3], [3, 2], [3, 2, 3], [2, 3, 2]].map(function (q) { return q.concat(q).concat(q); });
  var rd = L.resolveInternal(dd, refD, zeros(5), { type: "match", swapCells: [] });
  if (rd.scoreGained !== 4 * BASE) f.push("(d) match-5 scored " + rd.scoreGained + " expected " + (4 * BASE) + " (5 run, 1 survives as bomb)");
  if (!rd.specialCreated) f.push("(d) specialCreated false for a run of 5");
  var bombCount = 0;
  for (rr = 0; rr < 3; rr++) for (cc = 0; cc < 5; cc++) if (rd.board.grid[rr][cc] && rd.board.grid[rr][cc].kind === "bomb") bombCount++;
  if (bombCount !== 1) f.push("(d) expected exactly 1 bomb minted, got " + bombCount);

  // (e) bomb-swap clears exactly the PARTNER color. bomb@(0,0), color2@(0,1);
  //   color2 also at (1,2),(2,0). swap (0,0)<->(0,1): partner=2 -> clear
  //   {bomb,(0,1),(1,2),(2,0)} = 4 cells; refill leaves no cascade -> 240.
  var e = L.makeEmptyBoard(3, 3);
  e.grid[0][0] = L.makeCandy(0, "bomb"); e.grid[0][1] = L.makeCandy(2); e.grid[0][2] = L.makeCandy(3);
  e.grid[1][0] = L.makeCandy(3); e.grid[1][1] = L.makeCandy(4); e.grid[1][2] = L.makeCandy(2);
  e.grid[2][0] = L.makeCandy(2); e.grid[2][1] = L.makeCandy(5); e.grid[2][2] = L.makeCandy(3);
  var refE = [[5, 4], [6], [5]].map(function (q) { return q.concat([2, 5, 4, 6, 3]); });
  var re = L.applyMove(e, refE, zeros(3), { r1: 0, c1: 0, r2: 0, c2: 1 }, { allowSpecials: true });
  if (!re.legal) f.push("(e) bomb activation swap rejected");
  if (re.scoreGained !== 4 * BASE) f.push("(e) bomb-swap scored " + re.scoreGained + " expected " + (4 * BASE) + " (partner-color count=4)");
  var leftover2 = 0;
  for (rr = 0; rr < 3; rr++) for (cc = 0; cc < 3; cc++) if (re.board.grid[rr][cc] && re.board.grid[rr][cc].color === 2 && re.board.grid[rr][cc].kind !== "bomb") leftover2++;
  // partner color removed from the ORIGINAL cells; refill could re-introduce 2s,
  // so instead assert the exact score (4 clears) which pins the partner-only set.
  if (!re.specialFired) f.push("(e) specialFired false on bomb activation");

  // (f) bomb + bomb clears the entire board -> score >= cells*60.
  var ff = L.makeEmptyBoard(3, 3);
  ff.grid[0][0] = L.makeCandy(0, "bomb"); ff.grid[0][1] = L.makeCandy(0, "bomb");
  for (rr = 0; rr < 3; rr++) for (cc = 0; cc < 3; cc++) if (ff.grid[rr][cc] === null) ff.grid[rr][cc] = L.makeCandy(((rr + cc) % 2) ? 3 : 4);
  var refF = []; for (c = 0; c < 3; c++) refF.push([5, 6, 5, 6, 5, 6, 5, 6, 5]);
  var rf = L.applyMove(ff, refF, zeros(3), { r1: 0, c1: 0, r2: 0, c2: 1 }, { allowSpecials: true });
  if (!rf.legal) f.push("(f) bomb+bomb swap rejected");
  if (rf.scoreGained < 9 * BASE) f.push("(f) bomb+bomb scored " + rf.scoreGained + " expected >= " + (9 * BASE) + " (whole board=9)");
  if (!rf.specialFired) f.push("(f) specialFired false on bomb+bomb");

  return {
    pass: f.length === 0,
    detail: [
      "(a) match-4 -> stripe-h created=" + ra.specialCreated + " (h=" + stripeH + ")",
      "(b) stripe-h fire score=" + rb.scoreGained + " (want 300)   (c) stripe-v fire score=" + rc.scoreGained + " (want 300)",
      "(d) match-5 -> bomb, score=" + rd.scoreGained + " (want 240) bombs=" + bombCount,
      "(e) bomb-swap partner-clear score=" + re.scoreGained + " (want 240)   (f) bomb+bomb score=" + rf.scoreGained + " (want >=540)",
      f.length ? f.join("\n") : "all specials fire/mint exactly as hand-counted"
    ].join("\n")
  };
});

// ================================================================ CHECK 5 ==
// LEGAL-SWAP RULE: for boards of only normal candies, applyMove(...).legal must
// equal "the post-swap board has an independent >=3 match" -- both swap
// directions, thousands of adjacent pairs.

check("5. LEGAL-SWAP RULE: legal iff swap creates a match (independent)", function () {
  var rng = RNG.makeRng("candy-legal-5");
  var boards = 0, swaps = 0, disagree = 0, acceptedMatches = 0, ex = [];
  for (var it = 0; it < 1200; it++) {
    var rows = 4 + RNG.randInt(rng, 4), cols = 4 + RNG.randInt(rng, 4);
    var colors = 3 + RNG.randInt(rng, 3);
    var b = randRawBoard(rows, cols, colors, rng, 0.06, 0); // normals only, few holes
    var refill = []; for (var c = 0; c < cols; c++) refill.push([1 + RNG.randInt(rng, colors)]);
    boards++;
    // pick a handful of random adjacent pairs per board
    for (var s = 0; s < 8; s++) {
      var r = RNG.randInt(rng, rows), cc = RNG.randInt(rng, cols);
      var horiz = RNG.randInt(rng, 2);
      var nr = horiz ? r : r + 1, nc = horiz ? cc + 1 : cc;
      if (nr >= rows || nc >= cols) continue;
      if (b.grid[r][cc] === null || b.grid[nr][nc] === null) continue;
      swaps++;
      var sw = L.cloneBoard(b);
      var A = sw.grid[r][cc], B = sw.grid[nr][nc];
      sw.grid[r][cc] = B; sw.grid[nr][nc] = A;
      var expLegal = indepHasMatch(sw);
      if (expLegal) acceptedMatches++;
      var res = L.applyMove(b, refill, zeros(cols), { r1: r, c1: cc, r2: nr, c2: nc }, { allowSpecials: true });
      if (!!res.legal !== expLegal) {
        disagree++;
        if (ex.length < 5) ex.push((horiz ? "H" : "V") + " swap @(" + r + "," + cc + ") logic.legal=" + res.legal + " indep.match=" + expLegal);
      }
    }
  }
  return {
    pass: boards > 0 && swaps > 0 && disagree === 0,
    detail: [
      "normal-only boards=" + boards + ", adjacent swaps tested=" + swaps + " (both orientations)",
      "swaps that independently create a match=" + acceptedMatches + ", legality disagreements=" + disagree,
      ex.length ? ex.join("\n") : "logic accepts a swap iff it independently creates a match"
    ].join("\n")
  };
});

// ================================================================ CHECK 6 ==
// SOLVER SOUNDNESS (independent-of-solver): thousands of random tiny levels
// solved in checkAgainstTruth mode; every reported win is REPLAYED here through
// applyMove and asserted score>=target. Plus: the generated pool's certified
// sequences all independently clear their target. ZERO violations tolerated.

check("6. SOLVER SOUNDNESS: every certified win independently reaches target", function () {
  var rng = RNG.makeRng("candy-sound-6");
  var levelsChecked = 0, deductionsChecked = 0, violations = 0, wins = 0, ex = [];

  // (A) random tiny levels, checkAgainstTruth ON (solver self-throws if unsound)
  for (var it = 0; it < 2500; it++) {
    var rows = 3 + RNG.randInt(rng, 2), cols = 3 + RNG.randInt(rng, 2);
    var colors = 3 + RNG.randInt(rng, 2), budget = 2 + RNG.randInt(rng, 2);
    var lvl = randLevel(rng, rows, cols, colors, budget, 60 * (2 + RNG.randInt(rng, 3)));
    if (!lvl) continue;
    levelsChecked++;
    var res = S.solve(lvl, { checkAgainstTruth: true }); // throws on internal unsoundness
    if (res.win) {
      wins++;
      deductionsChecked++;
      var rep = myReplay(lvl, res.sequence); // INDEPENDENT replay through applyMove
      if (!rep.win || rep.score < lvl.target) {
        violations++;
        if (ex.length < 5) ex.push("random#" + it + ": solver 'win' replays to " + rep.score + "/" + lvl.target);
      }
    }
  }

  // (B) generated pool: replay each stored certified sequence independently.
  var tiers = ["easy", "medium", "hard"];
  var poolShots = 0;
  for (var t = 0; t < tiers.length; t++) {
    var tier = tiers[t];
    for (var i = 0; i < POOL[tier].length; i++) {
      var pl = POOL[tier][i];
      deductionsChecked++;
      var pr = myReplay(pl, pl.sequence);
      if (!pr.win || pr.score < pl.target) {
        violations++;
        if (ex.length < 8) ex.push(tier + "#" + i + ": pool sequence replays to " + pr.score + "/" + pl.target);
      } else poolShots += pr.movesUsed;
    }
  }

  var pass = violations === 0 && deductionsChecked > 0 && wins > 0;
  return {
    pass: pass,
    detail: [
      "(A) random tiny levels solved (checkAgainstTruth ON)=" + levelsChecked + ", certified wins=" + wins,
      "(B) pool certified sequences replayed=" + (POOL.easy.length + POOL.medium.length + POOL.hard.length) + ", swaps=" + poolShots,
      "TOTAL independent deductions checked=" + deductionsChecked + ", SOUNDNESS VIOLATIONS=" + violations + " (ANY>0 == a lie)",
      ex.length ? ex.join("\n") : "every certified winning line independently reaches its target"
    ].join("\n")
  };
});

// ================================================================ CHECK 7 ==
// GATE NECESSARY: the cheaper technique is PROVED to fail at the harder tier.
//   MEDIUM: independent greedy score < target (greedy provably fails).
//   HARD:   exact no-special ceiling < target AND that search did NOT overflow
//           (so a special is genuinely required), plus greedy < target.
//   Also measure that random boards force >greedy at a nonzero rate (gate isn't
//   a no-op).

check("7. GATE NECESSARY: greedy fails Medium; no-special ceiling fails Hard", function () {
  var f = [];

  // MEDIUM -- independent greedy must not reach target.
  var medChecked = 0, medGreedyWon = 0;
  for (var i = 0; i < POOL.medium.length; i++) {
    var ml = POOL.medium[i];
    medChecked++;
    var g = myGreedy(ml);            // independent greedy
    if (g.score >= ml.target) { medGreedyWon++; f.push("medium#" + i + ": independent greedy reached target (" + g.score + "/" + ml.target + ")"); }
  }

  // HARD -- exact no-special ceiling < target, not overflow; greedy < target.
  var hardChecked = 0, hardNoSpecReached = 0, hardOverflow = 0, hardGreedyWon = 0;
  for (i = 0; i < POOL.hard.length; i++) {
    var hl = POOL.hard[i];
    hardChecked++;
    var gg = myGreedy(hl);
    if (gg.score >= hl.target) { hardGreedyWon++; f.push("hard#" + i + ": greedy reached target"); }
    var sn = S.bestScore(hl, { allowSpecials: false, nodeCap: G.configForTier("hard").nodeCap });
    if (sn.overflow) { hardOverflow++; f.push("hard#" + i + ": no-special ceiling search OVERFLOWED (can't certify hard)"); }
    if (sn.score >= hl.target) { hardNoSpecReached++; f.push("hard#" + i + ": no-special ceiling " + sn.score + " >= target " + hl.target + " (special NOT required)"); }
  }

  // gate-isn't-a-no-op: random boards where planning beats greedy at rate>0.
  var rng = RNG.makeRng("candy-gate-7");
  var probes = 0, planningHelps = 0;
  for (i = 0; i < 200; i++) {
    var lvl = randLevel(rng, 4, 4, 3, 3, Infinity);
    if (!lvl) continue;
    probes++;
    var sg = myGreedy({ board: lvl.board, refill: lvl.refill, moves: lvl.moves, target: Infinity }).score;
    var sfn = S.bestScore(lvl, { allowSpecials: false, nodeCap: 200000 });
    if (!sfn.overflow && sfn.score > sg) planningHelps++;
  }

  var pass = f.length === 0 && medChecked > 0 && hardChecked > 0 && planningHelps > 0;
  return {
    pass: pass,
    detail: [
      "MEDIUM: " + medChecked + " levels, independent greedy reached target " + medGreedyWon + " (must be 0)",
      "HARD: " + hardChecked + " levels, no-special ceiling reached target " + hardNoSpecReached + ", overflowed " + hardOverflow + ", greedy won " + hardGreedyWon + " (all must be 0)",
      "gate-non-trivial: of " + probes + " random boards, planning>greedy on " + planningHelps + " (must be >0)",
      f.length ? f.slice(0, 8).join("\n") : "cheaper technique provably insufficient at every harder tier"
    ].join("\n")
  };
});

// ================================================================ CHECK 8 ==
// GATE SUFFICIENT / GRADING REAL: analyze() classifies every generated level as
// EXACTLY its requested tier (100%), the certified sequence independently
// clears, and each harder tier genuinely REQUIRES its technique (medium needs
// planning: nospec ceiling exactly == target-ish and > greedy; hard fires/mints
// a special somewhere on its certified line).

check("8. GRADING REAL: analyze tier==requested & harder tiers require technique", function () {
  var tiers = ["easy", "medium", "hard"];
  var checked = 0, mismatch = 0, replayFail = 0, ex = [];
  var counts = { easy: 0, medium: 0, hard: 0 };
  var hardUsesSpecial = 0, hardTotal = 0;

  for (var t = 0; t < tiers.length; t++) {
    var tier = tiers[t];
    for (var i = 0; i < POOL[tier].length; i++) {
      var lvl = POOL[tier][i];
      checked++;
      var A = analyzeCached(tier, i);
      if (A.tier !== tier) { mismatch++; if (ex.length < 6) ex.push(tier + "#" + i + ": analyze=" + A.tier); }
      else counts[tier]++;
      var rep = myReplay(lvl, A.sequence); // independent replay of analyze's own line
      if (!rep.win) { replayFail++; if (ex.length < 6) ex.push(tier + "#" + i + ": analyze sequence replay=" + rep.score + "/" + lvl.target); }

      if (tier === "hard") {
        hardTotal++;
        // Prove hard truly USES a special: replay the certified line via
        // applyMove and require some step reports specialCreated || specialFired.
        var board = L.cloneBoard(lvl.board), ptr = startPtr(lvl), usedSpecial = false;
        for (var s = 0; s < A.sequence.length; s++) {
          var res = L.applyMove(board, lvl.refill, ptr, A.sequence[s], { allowSpecials: true });
          if (!res.legal) break;
          if (res.specialCreated || res.specialFired) usedSpecial = true;
          board = res.board; ptr = res.pointers;
        }
        if (usedSpecial) hardUsesSpecial++;
        else ex.push("hard#" + i + ": certified line uses NO special (spec violation)");
      }
    }
  }
  var pass = checked > 0 && mismatch === 0 && replayFail === 0 && hardUsesSpecial === hardTotal && hardTotal > 0;
  return {
    pass: pass,
    detail: [
      "levels analyzed=" + checked + " (easy=" + POOL.easy.length + " medium=" + POOL.medium.length + " hard=" + POOL.hard.length + ")",
      "tier matches: easy=" + counts.easy + " medium=" + counts.medium + " hard=" + counts.hard + ", mismatches=" + mismatch,
      "independent replay failures=" + replayFail,
      "HARD levels whose certified line fires/mints a special=" + hardUsesSpecial + "/" + hardTotal + " (must be all)",
      ex.length ? ex.join("\n") : "every level graded exactly at its tier and requires its technique"
    ].join("\n")
  };
});

// ================================================================ CHECK 9 ==
// STARTING BOARD INVARIANTS: no pre-existing match & an opening swap exists on
// every generated board (recomputed independently).

check("9. START BOARD: no pre-match + opening move exists (independent)", function () {
  var tiers = ["easy", "medium", "hard"];
  var checked = 0, preMatch = 0, noOpening = 0, ex = [];
  for (var t = 0; t < tiers.length; t++) {
    var tier = tiers[t];
    for (var i = 0; i < POOL[tier].length; i++) {
      var lvl = POOL[tier][i];
      var board = lvl.board;
      checked++;
      if (indepHasMatch(board)) { preMatch++; if (ex.length < 6) ex.push(tier + "#" + i + ": pre-existing match"); }
      // independent opening test: some adjacent swap yields an independent match
      var opening = false;
      for (var r = 0; r < board.rows && !opening; r++) {
        for (var c = 0; c < board.cols && !opening; c++) {
          var dirs = [[r, c + 1], [r + 1, c]];
          for (var d = 0; d < dirs.length; d++) {
            var nr = dirs[d][0], nc = dirs[d][1];
            if (nr >= board.rows || nc >= board.cols) continue;
            var sw = L.cloneBoard(board);
            var A = sw.grid[r][c], B = sw.grid[nr][nc];
            if (A === null || B === null) continue;
            sw.grid[r][c] = B; sw.grid[nr][nc] = A;
            if (indepHasMatch(sw)) { opening = true; break; }
          }
        }
      }
      if (!opening) { noOpening++; if (ex.length < 6) ex.push(tier + "#" + i + ": no opening swap"); }
    }
  }
  return {
    pass: checked > 0 && preMatch === 0 && noOpening === 0,
    detail: [
      "boards checked=" + checked,
      "boards with a pre-existing match=" + preMatch + " (must be 0), boards with no opening swap=" + noOpening + " (must be 0)",
      ex.length ? ex.join("\n") : "every start board is match-free and has a legal opening"
    ].join("\n")
  };
});

// ================================================================ CHECK 10 =
// DETERMINISM: (tier,seed) -> byte-identical level; replaying a sequence twice
// yields identical board + score.

check("10. DETERMINISM: same (tier,seed) identical; replay repeatable", function () {
  var f = [];
  var tiers = ["easy", "medium", "hard"];
  for (var t = 0; t < tiers.length; t++) {
    var tier = tiers[t];
    var a = G.generate(tier, 909);
    var b = G.generate(tier, 909);
    if (L.serialize(a.board) !== L.serialize(b.board)) f.push(tier + ": board differs across identical (tier,seed)");
    if (JSON.stringify(a.refill) !== JSON.stringify(b.refill)) f.push(tier + ": refill differs");
    if (a.target !== b.target || a.moves !== b.moves) f.push(tier + ": target/moves differ");
    if (JSON.stringify(a.sequence) !== JSON.stringify(b.sequence)) f.push(tier + ": certified sequence differs");
    // replay twice -> identical final board + score
    var r1 = myReplay(a, a.sequence), r2 = myReplay(a, a.sequence);
    if (r1.score !== r2.score) f.push(tier + ": replay score not repeatable");
  }
  return {
    pass: f.length === 0,
    detail: [
      "regenerated easy/medium/hard at seed 909 twice; compared board+refill+target+moves+sequence",
      "replayed each certified line twice; compared score",
      f.length ? f.join("\n") : "generation and replay are fully deterministic"
    ].join("\n")
  };
});

// ============================================================================
// PHASE 3 — urchins + activation combos. Everything below recomputes its own
// expected values (hand-counted fixtures, or the independent engine derived
// from SPEC sections 3/3b + logic.js's documented deterministic ordering).
// ============================================================================

function ikey(r, c) { return r + "," + c; }

// ---- fixture helpers (independent parser: doc mapping, NOT logic.cellChar) --
// '.' empty | '1'..'6' normal | 'a'..'f' stripe-h | 'A'..'F' stripe-v |
// 'g'..'l' urchin | '*' bomb.
function pcell(ch) {
  if (ch === ".") return null;
  if (ch === "*") return { color: 0, kind: "bomb" };
  var code = ch.charCodeAt(0);
  if (ch >= "1" && ch <= "6") return { color: code - 48, kind: "normal" };
  if (ch >= "a" && ch <= "f") return { color: code - 96, kind: "stripe-h" };
  if (ch >= "A" && ch <= "F") return { color: code - 64, kind: "stripe-v" };
  if (ch >= "g" && ch <= "l") return { color: code - 102, kind: "urchin" };
  throw new Error("bad cell char: " + ch);
}
function boardRows(rows) {
  var b = { rows: rows.length, cols: rows[0].length, grid: [] };
  for (var r = 0; r < rows.length; r++) {
    var row = [];
    for (var c = 0; c < rows[0].length; c++) row.push(pcell(rows[r][c]));
    b.grid.push(row);
  }
  return b;
}
// Match-free bases (adjacent cells always differ along rows AND columns):
//   diag6(r,c) = ((r+c)%6)+1   (colors 1..6)
//   base4(r,c) = ((r+c)%4)+2   (colors 2..5)
//   cyc4(r,c)  = [1,2,4,5][(r+c)%4]  (color 3 deliberately absent)
function mkRows(rows, cols, baseFn, overrides) {
  var out = [];
  for (var r = 0; r < rows; r++) {
    var s = "";
    for (var c = 0; c < cols; c++) s += (overrides && overrides[ikey(r, c)]) || baseFn(r, c);
    out.push(s);
  }
  return out;
}
function diag6(r, c) { return String(((r + c) % 6) + 1); }
function base4(r, c) { return String(((r + c) % 4) + 2); }
function cyc4(r, c) { return ["1", "2", "4", "5"][(r + c) % 4]; }

function quietRefill(cols) {
  var refill = [];
  for (var c = 0; c < cols; c++) {
    var q = [];
    for (var i = 0; i < 40; i++) q.push(c % 2 === 0 ? (i % 2 ? 6 : 5) : (i % 2 ? 2 : 1));
    refill.push(q);
  }
  return refill;
}
function traceApply(b, move) {
  var trace = [];
  var res = L.applyMove(b, quietRefill(b.cols), zeros(b.cols), move,
    { allowSpecials: true, trace: trace });
  res.trace = trace;
  return res;
}
function traceResolve(b, initial) {
  var trace = [];
  var res = L.resolveInternal(b, quietRefill(b.cols), zeros(b.cols), initial, trace);
  res.trace = trace;
  return res;
}
function cellSet(cells) {
  var s = {};
  for (var i = 0; i < cells.length; i++) s[ikey(cells[i].r, cells[i].c)] = 1;
  return s;
}
// Exact set equality with a diff string for failure messages.
function diffSet(cells, expectedKeys) {
  var got = cellSet(cells), exp = {}, extra = [], missing = [], k;
  for (var i = 0; i < expectedKeys.length; i++) exp[expectedKeys[i]] = 1;
  for (k in got) if (!exp[k]) extra.push(k);
  for (k in exp) if (!got[k]) missing.push(k);
  if (!extra.length && !missing.length) return null;
  return "extra[" + extra.join(" ") + "] missing[" + missing.join(" ") + "]";
}

// ---- independent Phase-3 engine (SPEC 3/3b + documented ordering) ----------

function icloneB(board) {
  var g = [];
  for (var r = 0; r < board.rows; r++) {
    var row = [];
    for (var c = 0; c < board.cols; c++) {
      var cd = board.grid[r][c];
      row.push(cd === null ? null : { color: cd.color, kind: cd.kind });
    }
    g.push(row);
  }
  return { rows: board.rows, cols: board.cols, grid: g };
}
function boardsEqual(a, b) {
  if (a.rows !== b.rows || a.cols !== b.cols) return false;
  for (var r = 0; r < a.rows; r++) {
    for (var c = 0; c < a.cols; c++) {
      var x = a.grid[r][c], y = b.grid[r][c];
      if ((x === null) !== (y === null)) return false;
      if (x !== null && (x.color !== y.color || x.kind !== y.kind)) return false;
    }
  }
  return true;
}

// Maximal H/V runs, same scan order as documented (h row-major, then v
// col-major) — the order feeds the deterministic creation passes.
function indepRunsStruct(board) {
  var runs = [], r, c;
  for (r = 0; r < board.rows; r++) {
    c = 0;
    while (c < board.cols) {
      var v = mc(board.grid[r][c]);
      if (v >= 1) {
        var c2 = c + 1;
        while (c2 < board.cols && mc(board.grid[r][c2]) === v) c2++;
        if (c2 - c >= 3) {
          var cells = [];
          for (var cc = c; cc < c2; cc++) cells.push({ r: r, c: cc });
          runs.push({ cells: cells, dir: "h", len: c2 - c, color: v });
        }
        c = c2;
      } else c++;
    }
  }
  for (c = 0; c < board.cols; c++) {
    r = 0;
    while (r < board.rows) {
      var w = mc(board.grid[r][c]);
      if (w >= 1) {
        var r2 = r + 1;
        while (r2 < board.rows && mc(board.grid[r2][c]) === w) r2++;
        if (r2 - r >= 3) {
          var cellsv = [];
          for (var rr = r; rr < r2; rr++) cellsv.push({ r: rr, c: c });
          runs.push({ cells: cellsv, dir: "v", len: r2 - r, color: w });
        }
        r = r2;
      } else r++;
    }
  }
  return runs;
}

// Creation priority per SPEC: straight-5 pearl > urchin (L/T) > stripe, in
// three deterministic passes; a run consumed by an earlier pass cannot mint.
function indepCreations(runs, swapCells) {
  var creations = [], used = {}, consumed = new Array(runs.length), i, j;
  function on(cells, r, c) {
    for (var t = 0; t < cells.length; t++) if (cells[t].r === r && cells[t].c === c) return true;
    return false;
  }
  function pick(cells, fb) {
    if (swapCells) {
      for (var s = 0; s < swapCells.length; s++) {
        if (on(cells, swapCells[s].r, swapCells[s].c)) return { r: swapCells[s].r, c: swapCells[s].c };
      }
    }
    return fb;
  }
  function mid(run) { return run.cells[Math.floor((run.len - 1) / 2)]; }
  var order = [];
  for (i = 0; i < runs.length; i++) order.push(i);
  order.sort(function (a, b) { return runs[b].len - runs[a].len || a - b; });
  // pass 1: pearls (straight >=5), longest first
  for (i = 0; i < order.length; i++) {
    var br = runs[order[i]];
    if (br.len < 5) continue;
    var bc = pick(br.cells, mid(br));
    if (used[ikey(bc.r, bc.c)]) continue;
    used[ikey(bc.r, bc.c)] = 1;
    consumed[order[i]] = 1;
    creations.push({ r: bc.r, c: bc.c, kind: "bomb", color: 0 });
  }
  // pass 2: urchins (L/T) — h-runs in scan order, first unconsumed same-color
  // v-run sharing the (h.row, v.col) cell; BOTH runs consumed.
  for (i = 0; i < runs.length; i++) {
    if (consumed[i] || runs[i].dir !== "h") continue;
    for (j = 0; j < runs.length; j++) {
      if (consumed[j] || runs[j].dir !== "v" || runs[j].color !== runs[i].color) continue;
      var ir = runs[i].cells[0].r, ic = runs[j].cells[0].c;
      if (!on(runs[i].cells, ir, ic) || !on(runs[j].cells, ir, ic)) continue;
      if (runs[i].len + runs[j].len - 1 < 5) continue;
      var uc = pick(runs[i].cells.concat(runs[j].cells), { r: ir, c: ic });
      if (used[ikey(uc.r, uc.c)]) continue;
      used[ikey(uc.r, uc.c)] = 1;
      consumed[i] = 1;
      consumed[j] = 1;
      creations.push({ r: uc.r, c: uc.c, kind: "urchin", color: runs[i].color });
      break;
    }
  }
  // pass 3: stripes (exactly 4, unconsumed)
  for (i = 0; i < order.length; i++) {
    var idx = order[i], sr = runs[idx];
    if (consumed[idx] || sr.len !== 4) continue;
    var sc = pick(sr.cells, mid(sr));
    if (used[ikey(sc.r, sc.c)]) continue;
    used[ikey(sc.r, sc.c)] = 1;
    consumed[idx] = 1;
    creations.push({ r: sc.r, c: sc.c, kind: sr.dir === "h" ? "stripe-h" : "stripe-v", color: sr.color });
  }
  return creations;
}

// Fire expansion: stripe-h -> row, stripe-v -> col, urchin -> clipped 3x3,
// bomb -> nothing (swap-activation only); chains; `suppress` marks consumed
// specials that clear WITHOUT firing.
function indepExpand(board, cells, suppress, stats) {
  var inSet = {}, queue = [], out = [], fired = false, i;
  for (i = 0; i < cells.length; i++) {
    var kk = ikey(cells[i].r, cells[i].c);
    if (!inSet[kk]) { inSet[kk] = 1; queue.push(cells[i]); }
  }
  var head = 0;
  while (head < queue.length) {
    var cell = queue[head++];
    out.push(cell);
    var cd = board.grid[cell.r][cell.c];
    if (cd !== null && cd.kind !== "normal" && !(suppress && suppress[ikey(cell.r, cell.c)])) {
      fired = true;
      var add = [];
      if (cd.kind === "stripe-h") {
        for (var c = 0; c < board.cols; c++) if (board.grid[cell.r][c] !== null) add.push({ r: cell.r, c: c });
      } else if (cd.kind === "stripe-v") {
        for (var rr = 0; rr < board.rows; rr++) if (board.grid[rr][cell.c] !== null) add.push({ r: rr, c: cell.c });
      } else if (cd.kind === "urchin") {
        if (stats) stats.urchinFires++;
        for (var dr = -1; dr <= 1; dr++) {
          for (var dc = -1; dc <= 1; dc++) {
            var ur = cell.r + dr, uc = cell.c + dc;
            if (ur >= 0 && ur < board.rows && uc >= 0 && uc < board.cols &&
                board.grid[ur][uc] !== null) add.push({ r: ur, c: uc });
          }
        }
      }
      for (i = 0; i < add.length; i++) {
        var ak = ikey(add[i].r, add[i].c);
        if (!inSet[ak]) { inSet[ak] = 1; queue.push(add[i]); }
      }
    }
  }
  return { cells: out, fired: fired };
}

// Activation unions per SPEC 3b, centered on the swap DESTINATION d; both
// participants consumed (suppressed). null => not an activation swap.
function indepComboClear(board, a, d, A, B) {
  var cells = [], have = {}, suppress = {}, r, c, cd;
  function add(r2, c2) {
    if (board.grid[r2][c2] === null) return;
    var kk = ikey(r2, c2);
    if (!have[kk]) { have[kk] = 1; cells.push({ r: r2, c: c2 }); }
  }
  function addRow(r2) { if (r2 < 0 || r2 >= board.rows) return; for (var cc = 0; cc < board.cols; cc++) add(r2, cc); }
  function addCol(c2) { if (c2 < 0 || c2 >= board.cols) return; for (var rr = 0; rr < board.rows; rr++) add(rr, c2); }
  function addBlock(cr, cc, rad) {
    for (var rr = cr - rad; rr <= cr + rad; rr++) {
      for (var c3 = cc - rad; c3 <= cc + rad; c3++) {
        if (rr >= 0 && rr < board.rows && c3 >= 0 && c3 < board.cols) add(rr, c3);
      }
    }
  }
  if (A.kind === "bomb" || B.kind === "bomb") {
    var bombCell = A.kind === "bomb" ? a : d;
    var other = A.kind === "bomb" ? B : A;
    if (other.kind === "bomb") {
      for (r = 0; r < board.rows; r++) for (c = 0; c < board.cols; c++) add(r, c);
      return { cells: cells, suppress: suppress };
    }
    if (other.kind !== "normal") {
      var asU = other.kind === "urchin";
      for (r = 0; r < board.rows; r++) {
        for (c = 0; c < board.cols; c++) {
          cd = board.grid[r][c];
          if (cd === null || cd.kind === "bomb" || cd.color !== other.color) continue;
          suppress[ikey(r, c)] = 1;
          add(r, c);
          if (asU) addBlock(r, c, 1);
          else if ((r + c) % 2 === 0) addRow(r);
          else addCol(c);
        }
      }
      suppress[ikey(bombCell.r, bombCell.c)] = 1;
      add(bombCell.r, bombCell.c);
      return { cells: cells, suppress: suppress };
    }
    for (r = 0; r < board.rows; r++) {
      for (c = 0; c < board.cols; c++) {
        cd = board.grid[r][c];
        if (cd !== null && cd.kind !== "bomb" && cd.color === other.color) add(r, c);
      }
    }
    add(a.r, a.c);
    add(d.r, d.c);
    return { cells: cells, suppress: suppress };
  }
  if (A.kind !== "normal" && B.kind !== "normal") {
    var urchins = (A.kind === "urchin" ? 1 : 0) + (B.kind === "urchin" ? 1 : 0);
    suppress[ikey(a.r, a.c)] = 1;
    suppress[ikey(d.r, d.c)] = 1;
    add(a.r, a.c);
    add(d.r, d.c);
    if (urchins === 0) { addRow(d.r); addCol(d.c); }
    else if (urchins === 1) {
      addRow(d.r - 1); addRow(d.r); addRow(d.r + 1);
      addCol(d.c - 1); addCol(d.c); addCol(d.c + 1);
    } else addBlock(d.r, d.c, 2);
    return { cells: cells, suppress: suppress };
  }
  return null;
}

var INDEP_MAX_CASCADES = 200; // mirror of the documented determinism guard

function indepResolveFull(board, refill, pointers, initial, stats) {
  var b = icloneB(board), ptr = pointers.slice();
  var score = 0, cascades = 0, combo = 1, created = false, fired = false, first = true;
  while (cascades < INDEP_MAX_CASCADES) {
    var clearCells, creations;
    if (first && initial.type === "clear") {
      clearCells = initial.cells.slice();
      creations = [];
    } else {
      var runs = indepRunsStruct(b);
      if (runs.length === 0) break;
      var seen = {}, union = [];
      for (var ri = 0; ri < runs.length; ri++) {
        for (var ci = 0; ci < runs[ri].cells.length; ci++) {
          var kk = ikey(runs[ri].cells[ci].r, runs[ri].cells[ci].c);
          if (!seen[kk]) { seen[kk] = 1; union.push(runs[ri].cells[ci]); }
        }
      }
      clearCells = union;
      creations = indepCreations(runs, first ? initial.swapCells : null);
    }
    var exp = indepExpand(b, clearCells,
      (first && initial.type === "clear") ? initial.suppress : null, stats);
    if (exp.fired) fired = true;
    clearCells = exp.cells;
    var ck = {}, cr;
    for (cr = 0; cr < creations.length; cr++) ck[ikey(creations[cr].r, creations[cr].c)] = 1;
    var cleared = 0;
    for (var ii = 0; ii < clearCells.length; ii++) {
      var cell = clearCells[ii];
      if (ck[ikey(cell.r, cell.c)]) continue;
      if (b.grid[cell.r][cell.c] !== null) { b.grid[cell.r][cell.c] = null; cleared++; }
    }
    score += cleared * BASE * combo;
    for (cr = 0; cr < creations.length; cr++) {
      b.grid[creations[cr].r][creations[cr].c] = { color: creations[cr].color, kind: creations[cr].kind };
      created = true;
      if (stats && creations[cr].kind === "urchin") stats.urchinCreations++;
    }
    ptr = indepGravityMutate(b, refill, ptr);
    cascades++;
    combo++;
    first = false;
  }
  return { board: b, pointers: ptr, scoreGained: score, cascades: cascades,
           specialCreated: created, specialFired: fired };
}

function indepApplyFull(board, refill, pointers, move, stats) {
  var a = { r: move.r1, c: move.c1 }, d = { r: move.r2, c: move.c2 };
  if (a.r < 0 || a.r >= board.rows || a.c < 0 || a.c >= board.cols ||
      d.r < 0 || d.r >= board.rows || d.c < 0 || d.c >= board.cols) return { legal: false };
  if (Math.abs(a.r - d.r) + Math.abs(a.c - d.c) !== 1) return { legal: false };
  var A = board.grid[a.r][a.c], B = board.grid[d.r][d.c];
  if (A === null || B === null) return { legal: false };
  var combo = indepComboClear(board, a, d, A, B);
  if (combo) {
    if (stats) {
      if (A.kind === "bomb" || B.kind === "bomb") stats.bombActs++;
      else stats.pairActs++;
    }
    var res = indepResolveFull(board, refill, pointers,
      { type: "clear", cells: combo.cells, suppress: combo.suppress }, stats);
    res.specialFired = true;
    res.legal = true;
    return res;
  }
  var b = icloneB(board);
  b.grid[a.r][a.c] = B;
  b.grid[d.r][d.c] = A;
  if (indepRunsStruct(b).length === 0) {
    if (stats && (A.kind !== "normal" || B.kind !== "normal")) stats.specialNormalIllegal++;
    return { legal: false };
  }
  var r = indepResolveFull(b, refill, pointers,
    { type: "match", swapCells: [{ r: a.r, c: a.c }, { r: d.r, c: d.c }] }, stats);
  r.legal = true;
  if (stats) stats.matchSwaps++;
  return r;
}

// ================================================================ CHECK 11 =
// URCHIN CREATION (L/T): all 4 L orientations + T + plus mint an urchin at the
// intersection; swap-cell bias over the union; creation priority
// (straight-5 pearl > urchin > stripe; consumed runs cannot double-mint).
// Every expected clear set and score is hand-counted in the comments.

check("11. URCHIN CREATION: L/T shapes, swap bias, pearl>urchin>stripe priority", function () {
  var f = [], shapesTested = 0;

  // (a) swap-created L on a hand-written 5x5 (verified match-free by hand):
  //   swap (0,1)v(1,1) drops the 1 into (1,1) => h-run (1,1..3) + v-run
  //   (1..3,1), intersection (1,1) == swap destination. Urchin color-1 at
  //   (1,1); cleared = the other 4 union cells; 4*60 = 240.
  var a = boardRows(["21345", "34112", "41253", "21432", "53241"]);
  if (indepHasMatch(a)) f.push("(a) fixture has a pre-existing match");
  var ra = traceApply(a, { r1: 0, c1: 1, r2: 1, c2: 1 });
  if (!ra.legal) f.push("(a) L-swap rejected");
  else {
    var st = ra.trace[0];
    if (!(st.creations.length === 1 && st.creations[0].kind === "urchin" &&
          st.creations[0].color === 1 && st.creations[0].r === 1 && st.creations[0].c === 1)) {
      f.push("(a) expected exactly one urchin color1 @(1,1), got " + JSON.stringify(st.creations));
    }
    var d = diffSet(st.cleared, ["1,2", "1,3", "2,1", "3,1"]);
    if (d) f.push("(a) cleared set wrong: " + d);
    if (st.score !== 4 * BASE) f.push("(a) step-0 score " + st.score + " != 240");
    // gravity: col1 survivors bottom-up are (4,1)=3, urchin, (0,1)=4
    var g1 = st.boardAfter.grid[3][1], g2 = st.boardAfter.grid[4][1], g3 = st.boardAfter.grid[2][1];
    if (!(g1 && g1.kind === "urchin" && g1.color === 1)) f.push("(a) urchin did not settle at (3,1)");
    if (!(g2 && g2.kind === "normal" && g2.color === 3)) f.push("(a) (4,1) should be normal 3");
    if (!(g3 && g3.kind === "normal" && g3.color === 4)) f.push("(a) (2,1) should be the swapped-out 4");
    if (!ra.specialCreated) f.push("(a) specialCreated flag false");
  }

  // (b) all 4 L orientations + T + plus, pre-formed on a match-free base4 5x5,
  //   resolved via resolveInternal (no swap cells => intersection fallback).
  //   Each: 5 distinct cells, urchin at the corner, 4 cleared, 240.
  var shapes = [
    { name: "L-TL", cells: ["1,1", "1,2", "1,3", "2,1", "3,1"], corner: "1,1" },
    { name: "L-TR", cells: ["1,1", "1,2", "1,3", "2,3", "3,3"], corner: "1,3" },
    { name: "L-BL", cells: ["3,1", "3,2", "3,3", "1,1", "2,1"], corner: "3,1" },
    { name: "L-BR", cells: ["3,1", "3,2", "3,3", "1,3", "2,3"], corner: "3,3" },
    { name: "T",    cells: ["1,1", "1,2", "1,3", "2,2", "3,2"], corner: "1,2" },
    { name: "PLUS", cells: ["2,1", "2,2", "2,3", "1,2", "3,2"], corner: "2,2" }
  ];
  for (var s = 0; s < shapes.length; s++) {
    var sh = shapes[s], ov = {};
    for (var i = 0; i < sh.cells.length; i++) ov[sh.cells[i]] = "1";
    var b = boardRows(mkRows(5, 5, base4, ov));
    var rb = traceResolve(b, { type: "match" });
    shapesTested++;
    var stb = rb.trace[0];
    var cp = sh.corner.split(",");
    if (!(stb.creations.length === 1 && stb.creations[0].kind === "urchin" &&
          stb.creations[0].color === 1 &&
          stb.creations[0].r === +cp[0] && stb.creations[0].c === +cp[1])) {
      f.push("(b) " + sh.name + ": expected urchin @" + sh.corner + ", got " + JSON.stringify(stb.creations));
    }
    var expClear = sh.cells.filter(function (k) { return k !== sh.corner; });
    var db = diffSet(stb.cleared, expClear);
    if (db) f.push("(b) " + sh.name + " cleared set wrong: " + db);
    if (stb.score !== 4 * BASE) f.push("(b) " + sh.name + " step-0 score " + stb.score + " != 240");
  }

  // (c) swap-cell bias over the UNION: same plus shape, but resolveInternal is
  //   told the swap cell was (2,3) (h-run end, on the union, NOT the
  //   intersection) => urchin minted at (2,3). A swap cell OFF the union
  //   ((0,0)) falls back to the intersection (2,2).
  var ovP = { "2,1": "1", "2,2": "1", "2,3": "1", "1,2": "1", "3,2": "1" };
  var bBias = boardRows(mkRows(5, 5, base4, ovP));
  var rBias = traceResolve(bBias, { type: "match", swapCells: [{ r: 2, c: 3 }] });
  var stBias = rBias.trace[0];
  if (!(stBias.creations.length === 1 && stBias.creations[0].kind === "urchin" &&
        stBias.creations[0].r === 2 && stBias.creations[0].c === 3)) {
    f.push("(c) swap-cell bias: expected urchin @(2,3), got " + JSON.stringify(stBias.creations));
  }
  var dBias = diffSet(stBias.cleared, ["2,1", "2,2", "1,2", "3,2"]);
  if (dBias) f.push("(c) bias cleared set wrong: " + dBias);
  var bFall = boardRows(mkRows(5, 5, base4, ovP));
  var rFall = traceResolve(bFall, { type: "match", swapCells: [{ r: 0, c: 0 }] });
  var stFall = rFall.trace[0];
  if (!(stFall.creations.length === 1 && stFall.creations[0].r === 2 && stFall.creations[0].c === 2)) {
    f.push("(c) off-union swap cell should fall back to intersection (2,2), got " + JSON.stringify(stFall.creations));
  }

  // (d) PRIORITY A — straight-5 beats the L: h-run row2 cols0-4 (len 5) +
  //   v-run (2..4,2) (len 3) share (2,2). Pearl minted at the 5-run's midpoint
  //   (2,2), consuming the h-run => NO urchin, NO stripe; v-run just clears.
  //   Cleared = union(7) - creation = 6 cells => 360.
  var ovA = { "2,0": "1", "2,1": "1", "2,2": "1", "2,3": "1", "2,4": "1", "3,2": "1", "4,2": "1" };
  var bA = boardRows(mkRows(6, 6, base4, ovA));
  var rA = traceResolve(bA, { type: "match" });
  var stA = rA.trace[0];
  if (!(stA.creations.length === 1 && stA.creations[0].kind === "bomb" &&
        stA.creations[0].r === 2 && stA.creations[0].c === 2)) {
    f.push("(d) priority A: expected only a pearl @(2,2), got " + JSON.stringify(stA.creations));
  }
  var dA = diffSet(stA.cleared, ["2,0", "2,1", "2,3", "2,4", "3,2", "4,2"]);
  if (dA) f.push("(d) priority A cleared set wrong: " + dA);
  if (stA.score !== 6 * BASE) f.push("(d) priority A score " + stA.score + " != 360");

  // (e) PRIORITY B — urchin consumes the 4-run: h-run row2 cols1-4 (len 4) +
  //   v-run (2..4,1) share (2,1). Urchin minted there; the 4-run must NOT also
  //   mint a stripe. Cleared = union(6) - 1 = 5 => 300.
  var ovB = { "2,1": "1", "2,2": "1", "2,3": "1", "2,4": "1", "3,1": "1", "4,1": "1" };
  var bB = boardRows(mkRows(6, 6, base4, ovB));
  var rB = traceResolve(bB, { type: "match" });
  var stB = rB.trace[0];
  if (!(stB.creations.length === 1 && stB.creations[0].kind === "urchin" &&
        stB.creations[0].color === 1 && stB.creations[0].r === 2 && stB.creations[0].c === 1)) {
    f.push("(e) priority B: expected only an urchin @(2,1), got " + JSON.stringify(stB.creations));
  }
  var dB = diffSet(stB.cleared, ["2,2", "2,3", "2,4", "3,1", "4,1"]);
  if (dB) f.push("(e) priority B cleared set wrong: " + dB);
  if (stB.score !== 5 * BASE) f.push("(e) priority B score " + stB.score + " != 300");

  // (f) PRIORITY C — pearl consumes the h-run, leftover v-run of 4 still
  //   stripes: h len5 row2 cols0-4 + v (2..5,2) len4. Pearl @(2,2) (mid),
  //   stripe-v color1 @(3,2) (v-run midpoint, cells[1]). Cleared =
  //   union(8) - 2 creations = 6 => 360.
  var ovC = { "2,0": "1", "2,1": "1", "2,2": "1", "2,3": "1", "2,4": "1",
              "3,2": "1", "4,2": "1", "5,2": "1" };
  var bC = boardRows(mkRows(6, 6, base4, ovC));
  var rC = traceResolve(bC, { type: "match" });
  var stC = rC.trace[0];
  var kinds = stC.creations.map(function (x) { return x.kind + "@" + x.r + "," + x.c; }).sort().join(" ");
  if (kinds !== "bomb@2,2 stripe-v@3,2") {
    f.push("(f) priority C: expected pearl@(2,2)+stripe-v@(3,2), got [" + kinds + "]");
  }
  var dC = diffSet(stC.cleared, ["2,0", "2,1", "2,3", "2,4", "4,2", "5,2"]);
  if (dC) f.push("(f) priority C cleared set wrong: " + dC);
  if (stC.score !== 6 * BASE) f.push("(f) priority C score " + stC.score + " != 360");

  return {
    pass: f.length === 0,
    detail: [
      "swap-created L: urchin @intersection, 4 cleared, 240 pts, settles under gravity",
      "pre-formed shapes tested=" + shapesTested + " (4 L orientations + T + plus), each: urchin @corner, 240 pts",
      "swap-bias: on-union swap cell wins, off-union falls back to intersection",
      "priority: pearl>urchin (no double-mint), urchin consumes its 4-run (no stripe), pearl+leftover-stripe coexist",
      f.length ? f.join("\n") : "all L/T creations + priorities exactly as hand-counted"
    ].join("\n")
  };
});

// ================================================================ CHECK 12 =
// URCHIN FIRE GEOMETRY: exactly the 3x3 block centered on the urchin, clipped
// at edges/corners. Hand-counted unions on match-free base4 5x5 boards.

check("12. URCHIN FIRE: 3x3 at center, clipped at corner and edge", function () {
  var f = [];

  // (a) center: urchin1 @(2,2); swap (3,3)v(3,2) completes v-run (2..4,2).
  //   Fire = rows1-3 x cols1-3 (9) plus run cell (4,2) => 10 cells, 600.
  var a = boardRows(mkRows(5, 5, base4, { "2,2": "g", "4,2": "1", "3,3": "1" }));
  if (indepHasMatch(a)) f.push("(a) fixture has a pre-existing match");
  var ra = traceApply(a, { r1: 3, c1: 3, r2: 3, c2: 2 });
  if (!ra.legal) f.push("(a) center swap rejected");
  else {
    var expA = ["4,2"];
    for (var r = 1; r <= 3; r++) for (var c = 1; c <= 3; c++) expA.push(ikey(r, c));
    var dA = diffSet(ra.trace[0].cleared, expA);
    if (dA) f.push("(a) center 3x3 cleared set wrong: " + dA);
    if (ra.trace[0].score !== 10 * BASE) f.push("(a) score " + ra.trace[0].score + " != 600");
    if (!ra.specialFired) f.push("(a) specialFired false");
  }

  // (b) corner clip: urchin1 @(0,0); swap (0,2)v(1,2) completes h-run
  //   (0,0..2). Fire block clips to rows0-1 x cols0-1 (4); union with the run
  //   = {(0,0),(0,1),(0,2),(1,0),(1,1)} => 5 cells, 300.
  var b = boardRows(mkRows(5, 5, base4, { "0,0": "g", "0,1": "1", "1,2": "1" }));
  if (indepHasMatch(b)) f.push("(b) fixture has a pre-existing match");
  var rb = traceApply(b, { r1: 0, c1: 2, r2: 1, c2: 2 });
  if (!rb.legal) f.push("(b) corner swap rejected");
  else {
    var dB = diffSet(rb.trace[0].cleared, ["0,0", "0,1", "0,2", "1,0", "1,1"]);
    if (dB) f.push("(b) corner-clipped cleared set wrong: " + dB);
    if (rb.trace[0].score !== 5 * BASE) f.push("(b) score " + rb.trace[0].score + " != 300");
  }

  // (c) bottom-edge clip: urchin1 @(4,2); swap (3,3)v(4,3) completes h-run
  //   (4,1..3). Fire block clips to rows3-4 x cols1-3 (6); the run is inside
  //   it => 6 cells, 360.
  var cB = boardRows(mkRows(5, 5, base4, { "4,1": "1", "4,2": "g", "3,3": "1" }));
  if (indepHasMatch(cB)) f.push("(c) fixture has a pre-existing match");
  var rc = traceApply(cB, { r1: 3, c1: 3, r2: 4, c2: 3 });
  if (!rc.legal) f.push("(c) edge swap rejected");
  else {
    var dC = diffSet(rc.trace[0].cleared, ["3,1", "3,2", "3,3", "4,1", "4,2", "4,3"]);
    if (dC) f.push("(c) edge-clipped cleared set wrong: " + dC);
    if (rc.trace[0].score !== 6 * BASE) f.push("(c) score " + rc.trace[0].score + " != 360");
  }

  return {
    pass: f.length === 0,
    detail: [
      "center: 3x3 + run tail = 10 cells / 600   corner: clipped to 5 cells / 300   edge: clipped to 6 cells / 360",
      f.length ? f.join("\n") : "urchin fires exactly its clipped 3x3 in all three placements"
    ].join("\n")
  };
});

// ================================================================ CHECK 13 =
// ACTIVATION COMBOS: every pair's exact hand-counted cell union + score at
// cascade step 0 (combo x1), destination-centering, consumed-special
// suppression, and caught-special chaining. Bases are match-free by
// construction (adjacent cells always differ).

check("13. COMBOS: exact unions/scores for every special+special swap", function () {
  var f = [];
  function step0(nameTag, rows, move, expKeys, expScore) {
    var b = boardRows(rows);
    if (indepHasMatch(b)) { f.push(nameTag + ": fixture has a pre-existing match"); return null; }
    var res = traceApply(b, move);
    if (!res.legal) { f.push(nameTag + ": combo swap rejected"); return null; }
    var st = res.trace[0];
    var d = diffSet(st.cleared, expKeys);
    if (d) f.push(nameTag + " cleared set wrong: " + d);
    if (st.score !== expScore) f.push(nameTag + " step-0 score " + st.score + " != " + expScore);
    if (!res.specialFired) f.push(nameTag + ": specialFired false");
    return { res: res, st: st, set: cellSet(st.cleared) };
  }
  var r, c, exp;

  // (a) stripe+stripe -> cross through d=(2,3): row2 (6) + col3 (5 more) = 11
  //     cells, 660. The consumed stripe-h @(2,2) contributes NOTHING extra;
  //     col2's other cells must survive step 0 (no re-fire).
  exp = [];
  for (c = 0; c < 6; c++) exp.push(ikey(2, c));
  for (r = 0; r < 6; r++) if (r !== 2) exp.push(ikey(r, 3));
  var A = step0("(a) stripe+stripe", mkRows(6, 6, diag6, { "2,2": "e", "2,3": "f" }),
    { r1: 2, c1: 2, r2: 2, c2: 3 }, exp, 11 * BASE);
  if (A) {
    for (r = 0; r < 6; r++) {
      if (r !== 2 && A.set[ikey(r, 2)]) f.push("(a) consumed stripe re-fired: (" + r + ",2) cleared");
    }
  }

  // (b) same but swapped the OTHER way (d=(2,2)): cross must move to col2.
  exp = [];
  for (c = 0; c < 6; c++) exp.push(ikey(2, c));
  for (r = 0; r < 6; r++) if (r !== 2) exp.push(ikey(r, 2));
  var Bx = step0("(b) destination-centering", mkRows(6, 6, diag6, { "2,2": "e", "2,3": "f" }),
    { r1: 2, c1: 3, r2: 2, c2: 2 }, exp, 11 * BASE);
  if (Bx && Bx.set[ikey(0, 3)]) f.push("(b) union wrongly centered on the source cell");

  // (c) stripe+stripe cross CATCHES a third special which chains: stripe-v
  //     color2 @(2,5) sits on row2 => fires col5 (5 more cells) => 16, 960.
  exp = [];
  for (c = 0; c < 6; c++) exp.push(ikey(2, c));
  for (r = 0; r < 6; r++) if (r !== 2) { exp.push(ikey(r, 3)); exp.push(ikey(r, 5)); }
  var Cx = step0("(c) chain via caught stripe", mkRows(6, 6, diag6, { "2,2": "e", "2,3": "f", "2,5": "B" }),
    { r1: 2, c1: 2, r2: 2, c2: 3 }, exp, 16 * BASE);
  if (Cx) {
    if (!Cx.set[ikey(0, 5)]) f.push("(c) caught stripe-v did not chain col5");
    if (Cx.set[ikey(0, 2)]) f.push("(c) consumed stripe-h re-fired col2");
  }

  // (d) stripe+urchin -> 3 rows + 3 cols centered d=(2,3): rows1-3 u cols2-4
  //     = 18+18-9 = 27 cells, 1620.
  exp = [];
  for (r = 0; r < 6; r++) for (c = 0; c < 6; c++) {
    if ((r >= 1 && r <= 3) || (c >= 2 && c <= 4)) exp.push(ikey(r, c));
  }
  if (exp.length !== 27) f.push("(d) hand count broken: " + exp.length + " != 27");
  step0("(d) stripe+urchin", mkRows(6, 6, diag6, { "2,2": "e", "2,3": "l" }),
    { r1: 2, c1: 2, r2: 2, c2: 3 }, exp, 27 * BASE);

  // (e) stripe+urchin clipped at the top edge (d=(0,3)): rows -1,0,1 -> 0,1;
  //     cols2-4. Union = rows0-1 (12) + cols2-4 rows2-5 (12) = 24 cells, 1440.
  exp = [];
  for (r = 0; r < 6; r++) for (c = 0; c < 6; c++) {
    if (r <= 1 || (c >= 2 && c <= 4)) exp.push(ikey(r, c));
  }
  if (exp.length !== 24) f.push("(e) hand count broken: " + exp.length + " != 24");
  step0("(e) stripe+urchin edge-clip", mkRows(6, 6, diag6, { "0,2": "c", "0,3": "j" }),
    { r1: 0, c1: 2, r2: 0, c2: 3 }, exp, 24 * BASE);

  // (f) urchin+urchin -> 5x5 on d=(2,3), clipped: rows0-4 x cols1-5 = 25, 1500.
  exp = [];
  for (r = 0; r <= 4; r++) for (c = 1; c <= 5; c++) exp.push(ikey(r, c));
  step0("(f) urchin+urchin", mkRows(6, 6, diag6, { "2,2": "k", "2,3": "l" }),
    { r1: 2, c1: 2, r2: 2, c2: 3 }, exp, 25 * BASE);

  // (g) urchin+urchin at the corner (d=(0,1)): 5x5 clips to rows0-2 x cols0-3
  //     = 12 cells, 720.
  exp = [];
  for (r = 0; r <= 2; r++) for (c = 0; c <= 3; c++) exp.push(ikey(r, c));
  step0("(g) urchin+urchin corner-clip", mkRows(6, 6, diag6, { "0,0": "g", "0,1": "h" }),
    { r1: 0, c1: 0, r2: 0, c2: 1 }, exp, 12 * BASE);

  // (h) bomb+stripe on cyc4 (color 3 only where planted): color-3 candies are
  //     the stripe (2,3) [odd sum -> COL 3], (3,3) [even -> ROW 3], (4,1)
  //     [odd -> COL 1]. Union = col3 + row3 + col1 (- overlaps (3,3),(3,1))
  //     + bomb(2,2) = 6+5+5+1 = 17 cells, 1020. Row2 must NOT fire (the
  //     stripe-h original is converted+consumed, not re-fired).
  exp = [ikey(2, 2)];
  for (r = 0; r < 6; r++) { exp.push(ikey(r, 3)); exp.push(ikey(r, 1)); }
  for (c = 0; c < 6; c++) if (c !== 1 && c !== 3) exp.push(ikey(3, c));
  if (exp.length !== 17) f.push("(h) hand count broken: " + exp.length + " != 17");
  var H = step0("(h) bomb+stripe parity", mkRows(6, 6, cyc4, { "2,2": "*", "2,3": "c", "3,3": "3", "4,1": "3" }),
    { r1: 2, c1: 2, r2: 2, c2: 3 }, exp, 17 * BASE);
  if (H) {
    if (!H.set[ikey(5, 3)]) f.push("(h) converted stripe did not FIRE its column ((5,3) is not color 3)");
    if (H.set[ikey(2, 4)]) f.push("(h) consumed stripe-h original re-fired row2");
    if (!H.set[ikey(3, 0)]) f.push("(h) even-parity (3,3) failed to fire ROW 3");
  }

  // (i) bomb+urchin on cyc4: color-3 candies (2,3) urchin, (0,0), (5,5).
  //     Disjoint 3x3 blocks: rows1-3xcols2-4 (9, holds the bomb), rows0-1x
  //     cols0-1 (4), rows4-5xcols4-5 (4) => 17 cells, 1020.
  exp = [];
  for (r = 1; r <= 3; r++) for (c = 2; c <= 4; c++) exp.push(ikey(r, c));
  for (r = 0; r <= 1; r++) for (c = 0; c <= 1; c++) exp.push(ikey(r, c));
  for (r = 4; r <= 5; r++) for (c = 4; c <= 5; c++) exp.push(ikey(r, c));
  if (exp.length !== 17) f.push("(i) hand count broken: " + exp.length + " != 17");
  step0("(i) bomb+urchin", mkRows(6, 6, cyc4, { "2,2": "*", "2,3": "i", "0,0": "3", "5,5": "3" }),
    { r1: 2, c1: 2, r2: 2, c2: 3 }, exp, 17 * BASE);

  // (j) bomb+bomb -> whole 6x6 board: 36 cells, 2160.
  exp = [];
  for (r = 0; r < 6; r++) for (c = 0; c < 6; c++) exp.push(ikey(r, c));
  step0("(j) bomb+bomb", mkRows(6, 6, diag6, { "2,2": "*", "2,3": "*" }),
    { r1: 2, c1: 2, r2: 2, c2: 3 }, exp, 36 * BASE);

  // (k) bomb+normal (unchanged rule, always legal even matchless): partner
  //     color2 on cyc4 has 10 cells ((r+c)%4==1: 2+6+2), + bomb = 11, 660.
  exp = [ikey(2, 2)];
  for (r = 0; r < 6; r++) for (c = 0; c < 6; c++) {
    if ((r + c) % 4 === 1) exp.push(ikey(r, c));
  }
  if (exp.length !== 11) f.push("(k) hand count broken: " + exp.length + " != 11");
  step0("(k) bomb+normal", mkRows(6, 6, cyc4, { "2,2": "*" }),
    { r1: 2, c1: 2, r2: 2, c2: 3 }, exp, 11 * BASE);

  return {
    pass: f.length === 0,
    detail: [
      "cross=11/660 (both directions), chain-catch=16/960, 3rows+3cols=27/1620 (+edge clip 24/1440),",
      "5x5=25/1500 (+corner clip 12/720), bomb+stripe parity=17/1020, bomb+urchin=17/1020,",
      "bomb+bomb=36/2160, bomb+normal=11/660 — all step-0 unions exact, both specials scored, no re-fires",
      f.length ? f.join("\n") : "every combo clears exactly its hand-counted union"
    ].join("\n")
  };
});

// ================================================================ CHECK 14 =
// ACTIVATION LEGALITY: special+special swaps are always legal and appear in
// legalMoves; noSpecial excludes them; stripe/urchin + NORMAL without a match
// stays illegal; bomb+normal is legal even without a match.

check("14. ACTIVATION LEGALITY: combos always legal, special+normal match-required", function () {
  var f = [];
  var b = boardRows(mkRows(6, 6, diag6, { "2,2": "e", "2,3": "f" }));
  var refill = quietRefill(6);
  var lm = L.legalMoves(b, refill, zeros(6), {});
  var has = lm.some(function (m) { return m.move.r1 === 2 && m.move.c1 === 2 && m.move.r2 === 2 && m.move.c2 === 3; });
  if (!has) f.push("legalMoves(default) omits the stripe+stripe combo");
  var lmNo = L.legalMoves(b, refill, zeros(6), { noSpecial: true });
  var hasNo = lmNo.some(function (m) { return m.move.r1 === 2 && m.move.c1 === 2 && m.move.r2 === 2 && m.move.c2 === 3; });
  if (hasNo) f.push("legalMoves({noSpecial}) still contains the combo swap");
  if (lmNo.some(function (m) { return m.res.specialCreated || m.res.specialFired; })) {
    f.push("a noSpecial legal move creates/fires a special");
  }

  // stripe + normal, no match created (hand-verified): must be ILLEGAL.
  var r1 = L.applyMove(b, refill, zeros(6), { r1: 2, c1: 2, r2: 3, c2: 2 }, { allowSpecials: true });
  if (r1.legal !== false) f.push("stripe+normal without a match was accepted");

  // urchin + normal, no match created: must be ILLEGAL.
  var bu = boardRows(mkRows(6, 6, diag6, { "2,2": "k", "2,3": "l" }));
  var r2 = L.applyMove(bu, refill, zeros(6), { r1: 2, c1: 2, r2: 1, c2: 2 }, { allowSpecials: true });
  if (r2.legal !== false) f.push("urchin+normal without a match was accepted");

  // bomb + normal, no match created: must be LEGAL (activation).
  var bb = boardRows(mkRows(6, 6, cyc4, { "2,2": "*" }));
  var r3 = L.applyMove(bb, refill, zeros(6), { r1: 2, c1: 2, r2: 2, c2: 3 }, { allowSpecials: true });
  if (r3.legal !== true) f.push("bomb+normal activation was rejected");

  return {
    pass: f.length === 0,
    detail: [
      "combo in legalMoves(default)=" + has + ", excluded by noSpecial=" + !hasNo,
      "stripe+normal matchless illegal, urchin+normal matchless illegal, bomb+normal matchless legal",
      f.length ? f.join("\n") : "activation legality exactly per SPEC 3b"
    ].join("\n")
  };
});

// ================================================================ CHECK 15 =
// FULL-RULES RANDOM SWEEP: the independent Phase-3 engine (runs + priority
// creations + fire expansion + combo unions + cascade loop, all re-derived
// from the SPEC) must agree with logic.applyMove on LEGALITY and the ENTIRE
// outcome (board, pointers, score, cascades, flags) for every adjacent swap on
// hundreds of random boards seeded with stripes/urchins/bombs.

check("15. FULL-RULES SWEEP: independent engine == logic.applyMove everywhere", function () {
  var rng = RNG.makeRng("candy-phase3-sweep-15");
  var stats = { matchSwaps: 0, pairActs: 0, bombActs: 0, urchinCreations: 0,
                urchinFires: 0, specialNormalIllegal: 0 };
  var boards = 0, swaps = 0, legalMismatch = 0, outcomeMismatch = 0, multiCascade = 0, ex = [];

  function sweepBoard(b, colors) {
    var refill = [];
    for (var c = 0; c < b.cols; c++) {
      var q = [];
      for (var k = 0; k < b.rows * 3; k++) q.push(1 + RNG.randInt(rng, colors));
      refill.push(q);
    }
    var ptr = zeros(b.cols);
    for (var r = 0; r < b.rows; r++) {
      for (var cc = 0; cc < b.cols; cc++) {
        var dirs = [[r, cc + 1], [r + 1, cc]];
        for (var d = 0; d < dirs.length; d++) {
          var nr = dirs[d][0], nc = dirs[d][1];
          if (nr >= b.rows || nc >= b.cols) continue;
          var mv = { r1: r, c1: cc, r2: nr, c2: nc };
          swaps++;
          var mine = indepApplyFull(b, refill, ptr, mv, stats);
          var got = L.applyMove(b, refill, ptr, mv, { allowSpecials: true });
          if (!!mine.legal !== !!got.legal) {
            legalMismatch++;
            if (ex.length < 5) ex.push("legality @" + r + "," + cc + "->" + nr + "," + nc +
              " mine=" + mine.legal + " logic=" + got.legal + " on " + L.serialize(b));
            continue;
          }
          if (!mine.legal) continue;
          if (mine.cascades > 1) multiCascade++;
          var bad = null;
          if (!boardsEqual(mine.board, got.board)) bad = "board";
          else if (mine.pointers.join(",") !== got.pointers.join(",")) bad = "pointers";
          else if (mine.scoreGained !== got.scoreGained) bad = "score " + mine.scoreGained + " vs " + got.scoreGained;
          else if (mine.cascades !== got.cascades) bad = "cascades " + mine.cascades + " vs " + got.cascades;
          else if (!!mine.specialCreated !== !!got.specialCreated) bad = "specialCreated";
          else if (!!mine.specialFired !== !!got.specialFired) bad = "specialFired";
          if (bad) {
            outcomeMismatch++;
            if (ex.length < 5) ex.push("outcome(" + bad + ") @" + r + "," + cc + "->" + nr + "," + nc +
              " on " + L.serialize(b));
          }
        }
      }
    }
  }

  // (A) raw random boards (may hold pre-existing matches + any special kind)
  for (var it = 0; it < 130; it++) {
    var rows = 5 + RNG.randInt(rng, 3), cols = 5 + RNG.randInt(rng, 3);
    var colors = 3 + RNG.randInt(rng, 3);
    var b = randRawBoard(rows, cols, colors, rng, 0.04, 0.12);
    boards++;
    sweepBoard(b, colors);
  }
  // (B) structured match-free boards (generator start boards with specials
  //     sprinkled in-place, colors preserved => still match-free) — realistic
  //     swap-created urchins/stripes and match-required special+normal swaps.
  for (it = 0; it < 130; it++) {
    var colors2 = 4 + RNG.randInt(rng, 2);
    var cfg = { rows: 6, cols: 6, colors: colors2, budget: 3 };
    var sb = G.buildStartBoard(cfg, rng);
    if (!sb) continue;
    for (var r2 = 0; r2 < sb.rows; r2++) {
      for (var c2 = 0; c2 < sb.cols; c2++) {
        if (rng() < 0.15) {
          var kk = RNG.randInt(rng, 4);
          var cd = sb.grid[r2][c2];
          if (kk === 3) sb.grid[r2][c2] = { color: 0, kind: "bomb" };
          else sb.grid[r2][c2] = { color: cd.color, kind: kk === 0 ? "stripe-h" : kk === 1 ? "stripe-v" : "urchin" };
        }
      }
    }
    boards++;
    sweepBoard(sb, colors2);
  }

  var covered = stats.matchSwaps > 0 && stats.pairActs > 0 && stats.bombActs > 0 &&
                stats.urchinCreations > 0 && stats.urchinFires > 0 &&
                stats.specialNormalIllegal > 0 && multiCascade > 0;
  return {
    pass: swaps > 0 && legalMismatch === 0 && outcomeMismatch === 0 && covered,
    detail: [
      "boards=" + boards + " (raw + structured), adjacent swaps compared=" + swaps,
      "legality mismatches=" + legalMismatch + ", outcome mismatches=" + outcomeMismatch + " (board/ptr/score/cascades/flags)",
      "coverage: match-swaps=" + stats.matchSwaps + " pair-combos=" + stats.pairActs +
        " bomb-activations=" + stats.bombActs + " urchins minted=" + stats.urchinCreations +
        " urchin fires=" + stats.urchinFires + " special+normal rejected=" + stats.specialNormalIllegal +
        " multi-cascade=" + multiCascade + " (all must be >0)",
      ex.length ? ex.join("\n") : "independent engine agrees with logic on every swap"
    ].join("\n")
  };
});

// ================================================================ CHECK 16 =
// SERIALIZATION: the documented char map ('g'..'l' urchins) is exact and
// injective; serialize round-trips through OUR independent parser on random
// boards containing every kind.

check("16. SERIALIZATION: urchin chars, injective map, round-trip", function () {
  var f = [];
  // (a) exact expected string for a board holding every (kind,color) + bomb +
  //     empty, built cell-by-cell and serialized against OUR mapping table.
  var kinds = ["normal", "stripe-h", "stripe-v", "urchin"];
  var b = { rows: 5, cols: 6, grid: [] };
  var expRows = [];
  for (var k = 0; k < 4; k++) {
    var row = [], srow = "";
    for (var col = 1; col <= 6; col++) {
      row.push({ color: col, kind: kinds[k] });
      srow += (k === 0 ? String(col) :
               k === 1 ? String.fromCharCode(96 + col) :
               k === 2 ? String.fromCharCode(64 + col) :
                         String.fromCharCode(102 + col));
    }
    b.grid.push(row);
    expRows.push(srow);
  }
  b.grid.push([{ color: 0, kind: "bomb" }, null, null, null, null, null]);
  expRows.push("*.....");
  var expected = "5x6:" + expRows.join(",");
  var got = L.serialize(b);
  if (got !== expected) f.push("serialize mismatch:\n got " + got + "\n exp " + expected);
  if (expRows[3] !== "ghijkl") f.push("urchin chars are not g..l: " + expRows[3]);
  // injectivity across the 26-char alphabet (each distinct cell STATE gets a
  // distinct char; the board rows above repeat '.' as padding, so test the
  // alphabet itself: 24 colored kinds + bomb + empty)
  var alphabet = expRows[0] + expRows[1] + expRows[2] + expRows[3] + "*.";
  var chars = {}, dup = 0, i, j;
  for (i = 0; i < alphabet.length; i++) {
    if (chars[alphabet[i]]) dup++;
    chars[alphabet[i]] = 1;
  }
  if (alphabet.length !== 26) f.push("alphabet size " + alphabet.length + " != 26");
  if (dup > 0) f.push("cell-char map is not injective (" + dup + " duplicates)");

  // (b) round-trip: serialize -> OUR parser -> cell-by-cell equality, on 300
  //     random boards with all special kinds.
  var rng = RNG.makeRng("candy-serialize-16");
  var rt = 0, rtFail = 0;
  for (i = 0; i < 300; i++) {
    var rows = 3 + RNG.randInt(rng, 5), cols = 3 + RNG.randInt(rng, 5);
    var rb = randRawBoard(rows, cols, 3 + RNG.randInt(rng, 4), rng, 0.1, 0.3);
    var ser = L.serialize(rb);
    var body = ser.split(":")[1].split(",");
    var parsed = boardRows(body);
    rt++;
    if (!boardsEqual(rb, parsed)) { rtFail++; if (f.length < 5) f.push("round-trip failed: " + ser); }
  }

  return {
    pass: f.length === 0,
    detail: [
      "full-alphabet board serializes to the exact documented string (urchins 'g'..'l'), 26 chars injective",
      "round-trips through the independent parser: " + rt + " random boards, failures=" + rtFail,
      f.length ? f.join("\n") : "serialization exact + reversible"
    ].join("\n")
  };
});

// ================================================================ CHECK 17 =
// CAMPAIGN SPOT-CHECK: sampled shipped depths (across tiers) must still reach
// their stored player-facing target under the Phase-3 rules, with the witness
// replayed HERE through applyMove (not the solver's replay).

check("17. CAMPAIGN: sampled depths still winnable under Phase-3 (replay-certified)", function () {
  global.window = global.window || {};
  require(path.join(__dirname, "..", "js", "levels.js"));
  var all = global.window.CANDY_LEVELS || [];
  if (!all.length) return { pass: false, detail: "could not load js/levels.js" };
  var byDepth = {};
  for (var i = 0; i < all.length; i++) byDepth[all[i].depth] = all[i];

  var sample = [1, 5, 8, 9, 25, 53, 17, 51, 68, 100]; // 3 easy, 3 medium, 4 hard
  var f = [], lines = [], checked = 0;
  for (i = 0; i < sample.length; i++) {
    var lv = byDepth[sample[i]];
    if (!lv) { f.push("depth " + sample[i] + " missing from levels.js"); continue; }
    var lvl = { board: lv.board, refill: lv.refill, moves: lv.moves, target: lv.target };
    var t0 = Date.now();
    var r = S.canReach(lvl, { allowSpecials: true, target: lv.target, nodeCap: 3000000 });
    checked++;
    if (!r.win) {
      f.push("depth " + lv.depth + " (" + lv.tier + "): NOT winnable under Phase-3 (" +
        (r.overflow ? "search capped" : "proven, max " + r.score) + " vs " + lv.target + ")");
      continue;
    }
    var rep = myReplay(lvl, r.sequence); // independent ground-truth replay
    if (!rep.win) {
      f.push("depth " + lv.depth + ": witness fails independent replay (" + rep.score + "/" + lv.target + ")");
    } else {
      lines.push("depth " + lv.depth + " " + lv.tier + ": win in " + rep.movesUsed +
        "/" + lv.moves + " moves (" + (Date.now() - t0) + "ms)");
    }
  }
  return {
    pass: f.length === 0 && checked === sample.length,
    detail: [
      "depths sampled=" + checked + "/" + sample.length + " across tiers, target = stored player-facing target",
      lines.join("; "),
      f.length ? f.join("\n") : "every sampled depth re-certified winnable by independent replay"
    ].join("\n")
  };
});

// ================================================================ CHECK 18 =
// DETERMINISM WITH COMBOS: an activation swap (incl. bomb-convert, the only
// combo whose union depends on board-wide state) run twice from identical
// inputs yields byte-identical boards, scores, pointers, and traces.

check("18. DETERMINISM: combo moves fully repeatable (board+score+trace)", function () {
  var f = [];
  function fingerprint(rows, move) {
    var b = boardRows(rows);
    var res = traceApply(b, move);
    return JSON.stringify({
      legal: res.legal, board: L.serialize(res.board), score: res.scoreGained,
      cascades: res.cascades, pointers: res.pointers,
      trace: res.trace.map(function (t) {
        return { cleared: t.cleared, creations: t.creations, score: t.score,
                 boardAfter: L.serialize(t.boardAfter) };
      })
    });
  }
  var cases = [
    ["bomb+stripe", mkRows(6, 6, cyc4, { "2,2": "*", "2,3": "c", "3,3": "3", "4,1": "3" }), { r1: 2, c1: 2, r2: 2, c2: 3 }],
    ["urchin+urchin", mkRows(6, 6, diag6, { "2,2": "k", "2,3": "l" }), { r1: 2, c1: 2, r2: 2, c2: 3 }],
    ["swap-minted urchin", ["21345", "34112", "41253", "21432", "53241"], { r1: 0, c1: 1, r2: 1, c2: 1 }]
  ];
  for (var i = 0; i < cases.length; i++) {
    var a = fingerprint(cases[i][1], cases[i][2]);
    var b = fingerprint(cases[i][1], cases[i][2]);
    if (a !== b) f.push(cases[i][0] + ": two identical runs diverged");
  }
  return {
    pass: f.length === 0,
    detail: [
      "3 combo/creation moves executed twice each; compared full result incl. per-step trace",
      f.length ? f.join("\n") : "combo resolution is byte-for-byte deterministic"
    ].join("\n")
  };
});

// ================================================================= verdict ==

console.log("");
console.log("(pool generated in " + GEN_MS + " ms: easy=" + POOL.easy.length + " medium=" + POOL.medium.length + " hard=" + POOL.hard.length + ")");
var failed = results.filter(function (r) { return !r.pass; });
var totalMs = results.reduce(function (s, r) { return s + r.ms; }, 0) + GEN_MS;
console.log("==================================================================");
console.log(results.length + " checks, " + failed.length + " failed, total " + totalMs + " ms");
console.log(failed.length === 0 ? "VERDICT: ALL CHECKS GREEN" : "VERDICT: RED — DO NOT SHIP");
console.log("==================================================================");
process.exit(failed.length === 0 ? 0 : 1);
