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
        var k = RNG.randInt(rng, 3);
        kind = k === 0 ? "stripe-h" : k === 1 ? "stripe-v" : "bomb";
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
