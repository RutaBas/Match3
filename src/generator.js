/*
 * generator.js — generate-and-gate level builder for the Candy-Crush dupe.
 *
 * Pure logic, zero DOM. Node (module.exports) + browser (root.CandyGenerator).
 *
 * THE SOLVER IS THE ARBITER. Every candidate (seeded RNG, reproducible) is a
 * fixed start board + fixed per-column refill queues + a move budget. The TARGET
 * is not guessed — it is derived from the solver's own exact best-score analysis
 * so the level lands PRECISELY in the requested tier's window:
 *
 *   Sg = greedy score, Sn = no-special best score, Sf = full best score.
 *   easy   -> target = Sg           (greedy reaches it => tier easy).
 *   medium -> target = Sn (require Sn > Sg)   (greedy fails, no-special reaches).
 *   hard   -> target = Sf (require Sf > Sn)   (no-special provably fails, a
 *                                              special-using line reaches it).
 *
 * A candidate is rejected when the needed window is empty (e.g. planning buys
 * nothing, so Sn == Sg; or specials buy nothing, so Sf == Sn) or when any
 * decisive search overflowed the node cap. The chosen level is then re-run
 * through solver.analyze() and REQUIRED to certify the exact requested tier,
 * and its winning line re-verified by replaySequence() before shipping.
 *
 * Opening validity: the start board is filled cell-by-cell forbidding any color
 * that would complete a 3-run, so it carries NO pre-existing match; the
 * candidate is also required to have at least one legal opening swap.
 */
(function (root, factory) {
  "use strict";
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory(require("./rng.js"), require("./logic.js"), require("./solver.js"));
  } else {
    root.CandyGenerator = factory(root.CandyRng, root.CandyLogic, root.CandySolver);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (rng, logic, solver) {
  "use strict";

  // Sizes per SPEC; colors & budget are difficulty levers. nodeCap bounds the
  // exhaustive searches — candidates whose decisive search overflows are dropped.
  var TIERS = {
    easy:   { name: "Easy",   rows: 6, cols: 6, colors: 4, budget: 5, nodeCap: 250000 },
    medium: { name: "Medium", rows: 7, cols: 7, colors: 5, budget: 6, nodeCap: 500000 },
    hard:   { name: "Hard",   rows: 7, cols: 8, colors: 6, budget: 5, nodeCap: 500000 }
  };

  function configForTier(tier) {
    var cfg = TIERS[tier];
    if (!cfg) throw new Error("Unknown tier: " + tier);
    return cfg;
  }

  // Fill a board with NO 3-run: when placing (r,c) forbid a color equal to the
  // two cells to its left or the two cells above.
  function buildStartBoard(cfg, rand) {
    var board = logic.makeEmptyBoard(cfg.rows, cfg.cols);
    for (var r = 0; r < cfg.rows; r++) {
      for (var c = 0; c < cfg.cols; c++) {
        var forbidden = {};
        if (c >= 2) {
          var l1 = board.grid[r][c - 1], l2 = board.grid[r][c - 2];
          if (l1 && l2 && l1.color === l2.color) forbidden[l1.color] = 1;
        }
        if (r >= 2) {
          var u1 = board.grid[r - 1][c], u2 = board.grid[r - 2][c];
          if (u1 && u2 && u1.color === u2.color) forbidden[u1.color] = 1;
        }
        var choices = [];
        for (var col = 1; col <= cfg.colors; col++) if (!forbidden[col]) choices.push(col);
        if (choices.length === 0) return null; // over-constrained; reseed
        var pick = choices[rng.randInt(rand, choices.length)];
        board.grid[r][c] = logic.makeCandy(pick, "normal");
      }
    }
    if (logic.hasMatch(board)) return null;
    return board;
  }

  // Per-column refill queue, long enough to cover the worst case (each move can
  // refill at most rows cells per column; add slack for cascades).
  function buildRefill(cfg, rand) {
    var refill = [];
    var len = cfg.rows * (cfg.budget + 2);
    for (var c = 0; c < cfg.cols; c++) {
      var q = [];
      for (var i = 0; i < len; i++) q.push(1 + rng.randInt(rand, cfg.colors));
      refill.push(q);
    }
    return refill;
  }

  var STEP = logic.BASE_SCORE; // one minimal match's worth of headroom above a ceiling

  // Derive the tier-appropriate target from the solver's own analysis so the
  // level lands PRECISELY in the requested tier's window. Returns { target } or
  // null if this candidate cannot serve the tier.
  //
  //   easy   : target = Sg               (greedy's own score => greedy wins).
  //   medium : target = Sg + STEP, gated by a no-special WIN search (fast
  //            short-circuit): a plain-match line must beat greedy by a match.
  //   hard   : target = Sn + STEP where Sn is the EXACT no-special ceiling
  //            (one exhaustive search); gated by a full WIN search so a
  //            special-using line clears the bar the no-special ceiling cannot.
  function chooseTarget(tier, cfg, board, refill) {
    var probe = { board: board, refill: refill, moves: cfg.budget,
                  colorCount: cfg.colors, target: Infinity };

    var Sg = solver.greedy(probe).score;   // greedy plays full budget (target=Inf)
    if (Sg <= 0) return null;

    if (tier === "easy") return { target: Sg };

    if (tier === "medium") {
      var t = Sg + STEP;
      var mw = solver.canReach(probe, { allowSpecials: false, target: t, nodeCap: cfg.nodeCap });
      if (!mw.win) return null;            // no plain-match line beats greedy => not medium
      return { target: t };
    }

    // hard: exact no-special ceiling, then require specials to clear the next bar.
    var sn = solver.bestScore(probe, { allowSpecials: false, nodeCap: cfg.nodeCap });
    if (sn.overflow) return null;          // couldn't certify the ceiling
    var th = sn.score + STEP;
    var hw = solver.canReach(probe, { allowSpecials: true, target: th, nodeCap: cfg.nodeCap });
    if (!hw.win) return null;              // specials buy nothing above the ceiling
    return { target: th };
  }

  var MAX_ATTEMPTS = 6000;

  // generate(tier, seed): first seeded candidate whose certified class === tier.
  // Deterministic for (tier, seed): attempt k uses "candy-<tier>-<seed>-attempt-<k>".
  function generate(tier, seed, opts) {
    opts = opts || {};
    var cfg = configForTier(tier);
    // Optional move-budget override (e.g. to give early campaign levels more
    // moves). Additive: target selection, certification and level all use it.
    if (opts.budget) cfg = { name: cfg.name, rows: cfg.rows, cols: cfg.cols,
      colors: cfg.colors, budget: opts.budget, nodeCap: cfg.nodeCap };
    var maxAttempts = opts.maxAttempts || MAX_ATTEMPTS;
    var counts = { easy: 0, medium: 0, hard: 0, unwinnable: 0, overflow: 0,
                   buildFail: 0, noMove: 0, windowFail: 0, tierMismatch: 0 };

    for (var k = 0; k < maxAttempts; k++) {
      var rand = rng.makeRng("candy-" + tier + "-" + seed + "-attempt-" + k);
      var board = buildStartBoard(cfg, rand);
      if (!board) { counts.buildFail++; continue; }
      var refill = buildRefill(cfg, rand);

      var pointers = [];
      for (var pc = 0; pc < cfg.cols; pc++) pointers.push(0);
      if (!logic.hasAnyLegalMove(board, refill, pointers)) { counts.noMove++; continue; }

      var tsel = chooseTarget(tier, cfg, board, refill);
      if (!tsel) { counts.windowFail++; continue; }

      var level = { tier: tier, name: cfg.name, seed: seed,
                    rows: cfg.rows, cols: cfg.cols, colorCount: cfg.colors,
                    board: board, refill: refill, moves: cfg.budget,
                    target: tsel.target };

      var info = solver.analyze(level, { nodeCap: cfg.nodeCap });
      counts[info.tier] = (counts[info.tier] || 0) + 1;
      if (info.tier !== tier) { counts.tierMismatch++; continue; }

      var rep = solver.replaySequence(level, info.sequence);
      if (!rep.win) { counts.tierMismatch++; continue; }

      level.sequence = info.sequence;
      level.attempt = k;
      level.stats = {
        attempts: k + 1,
        target: tsel.target,
        movesUsed: rep.movesUsed,
        seqLength: info.sequence.length,
        finalScore: rep.score,
        rejects: counts
      };
      return level;
    }
    throw new Error("generate(" + tier + "," + seed + "): exhausted " +
      maxAttempts + " attempts. rejects=" + JSON.stringify(counts));
  }

  function generateSet(tier, count, startSeed) {
    startSeed = startSeed || 1;
    var out = [];
    for (var i = 0; i < count; i++) out.push(generate(tier, startSeed + i));
    return out;
  }

  var api = {
    TIERS: TIERS,
    configForTier: configForTier,
    buildStartBoard: buildStartBoard,
    buildRefill: buildRefill,
    chooseTarget: chooseTarget,
    generate: generate,
    generateSet: generateSet
  };

  // ------------------------------------------------------ self-check main --
  // `node src/generator.js` — one level per tier: certified class + solved line.
  if (typeof require !== "undefined" && typeof module !== "undefined" && require.main === module) {
    var tiers = ["easy", "medium", "hard"];
    console.log("Candy-Crush generator self-check\n" + Array(41).join("="));
    for (var ti = 0; ti < tiers.length; ti++) {
      var tier = tiers[ti];
      var t0 = Date.now();
      try {
        var lvl = generate(tier, 42);
        var cls = solver.classify(lvl, { nodeCap: configForTier(tier).nodeCap });
        console.log("\n[" + tier.toUpperCase() + "] " + lvl.rows + "x" + lvl.cols +
          "  colors=" + lvl.colorCount + "  budget=" + lvl.moves +
          "  target=" + lvl.target);
        console.log("  certified class : " + cls + "   (requested " + tier + ")");
        console.log("  winning seq len : " + lvl.stats.seqLength +
          " swaps (reached " + lvl.stats.finalScore + " in " + lvl.stats.movesUsed + ")");
        console.log("  found on attempt: " + lvl.attempt);
        console.log("  elapsed         : " + (Date.now() - t0) + "ms");
      } catch (e) {
        console.log("\n[" + tier.toUpperCase() + "] FAILED: " + e.message +
          "  (" + (Date.now() - t0) + "ms)");
      }
    }
  }

  return api;
});
