/*
 * solver.js — SOUND search solver + difficulty grader for the Candy-Crush dupe.
 *
 * Pure logic, zero DOM. Node (module.exports) + browser (root.CandySolver).
 *
 * The state space is deterministic and enumerable: refills are drawn from FIXED
 * per-column queues, and every move is a legal adjacent swap applied by the real
 * rule (logic.applyMove). "Sound" here means the solver only ever reports a WIN
 * it can exhibit as a concrete move sequence, and every reported win is
 * re-verified by REPLAYING it through applyMove (checkAgainstTruth). It never
 * guesses: "unwinnable at target" is only asserted after an EXHAUSTIVE search
 * (no node-cap overflow) proves no sequence reaches the target.
 *
 * ---------------------------------------------------------------------------
 * THE TECHNIQUE LADDER  (graded by the MINIMUM planning power a level requires)
 * ---------------------------------------------------------------------------
 * The engine of every judgment is bestScore(): the EXACT maximum score
 * reachable within the move budget under a given technique (exhaustive DFS with
 * transposition memo on movesLeft|board|pointers; node-capped -> overflow makes
 * the returned score a LOWER bound, flagged). Let
 *   Sg = the greedy player's score (highest-immediate-score legal swap, no
 *        specials, no lookahead),
 *   Sn = bestScore with specials FORBIDDEN (plain 3-matches + cascade ordering),
 *   Sf = bestScore with specials ALLOWED (match-4 stripes / match-5 bombs).
 * Note Sg <= Sn <= Sf. Against a target T:
 *   easy       — Sg >= T           (greedy wins).
 *   medium     — Sg < T <= Sn      (greedy fails; a no-special plan reaches T).
 *   hard       — Sn < T <= Sf      (the no-special search PROVABLY (exhaustively)
 *                                   fails, yet a special-using line reaches T:
 *                                   any T-reaching line must beat Sn, so it MUST
 *                                   create/fire a special).
 *   unwinnable — Sf < T            (no line reaches T at all).
 *   overflow   — a decisive "no" (Sn<T for hard, or Sf<T) rests on a search that
 *                hit the node cap, so its max is only a lower bound and the "no"
 *                cannot be certified. The generator discards these.
 *
 * Each tier is both NECESSARY (the cheaper technique is proved to fail — greedy
 * deterministically, the no-special search by exhausting every plain-match line)
 * and SUFFICIENT (the named plan is exhibited as a concrete sequence and
 * re-certified by replaying it through the real rules).
 */
(function (root, factory) {
  "use strict";
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory(require("./logic.js"));
  } else {
    root.CandySolver = factory(root.CandyLogic);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (logic) {
  "use strict";

  var DEFAULT_NODE_CAP = 1500000;

  function zeros(n) { var a = []; for (var i = 0; i < n; i++) a.push(0); return a; }
  function startPointers(level) {
    return level.pointers ? level.pointers.slice() : zeros(level.board.cols);
  }

  // ------------------------------------------------------------ objectives --
  //
  // What the player must achieve within the move budget:
  //   { type:"score",   amount:N }           — bank N points (the classic Depth)
  //   { type:"collect", color:k, amount:N }  — clear N creatures of colour k
  //
  // The whole search is written against a scalar PROGRESS metric rather than
  // score specifically. That is what makes a new objective type sound for free:
  // the DFS, its short-circuit, and its transposition memo only ever assume that
  // progress is (a) non-negative per move and (b) additive along a line, so "the
  // maximum additional progress reachable from this state" stays a property of
  // the state alone — exactly the invariant the memo relies on. Any objective
  // expressible as a sum of per-move contributions inherits the existing
  // soundness proof unchanged.
  //
  // Score remains tracked alongside progress on every path, because stars are
  // still awarded on score even when the win condition is something else.
  function objectiveOf(level) {
    return level.objective || { type: "score", amount: level.target };
  }
  function progressFn(objective) {
    if (objective && objective.type === "collect") {
      var k = objective.color;
      return function (res) { return (res.collected && res.collected[k]) || 0; };
    }
    return function (res) { return res.scoreGained; };
  }
  function objectiveLabel(objective) {
    if (objective && objective.type === "collect") {
      return "collect " + objective.amount + " of colour " + objective.color;
    }
    return "score " + (objective ? objective.amount : "?");
  }

  // ---------------------------------------------------------------- search --

  // The single search engine. DFS over legal-swap sequences bounded by the move
  // budget, transposition-memoized on (movesLeft | board | pointers).
  //
  //   opts: { allowSpecials(=true), target(=Infinity), nodeCap }
  //
  // With a FINITE target it SHORT-CIRCUITS: it returns as soon as a line's
  // cumulative score reaches target (fast wins). With target=Infinity it never
  // wins and instead fully enumerates, returning the EXACT maximum additional
  // score (used to derive tier boundaries).
  //
  // returns { win, score, sequence, overflow }:
  //   win     — a line reaching target was exhibited (sequence is that line).
  //   score   — if !win: the max reachable score; EXACT when !overflow, else a
  //             lower bound. (When win, score is the witnessing line's score.)
  //   overflow— the node cap was hit, so a "score < target" (i.e. !win) verdict
  //             is only a lower bound and CANNOT be trusted as a proof.
  //
  // Soundness of the memo: for a FULLY-EXPLORED, non-winning node we store the
  // exact max additional score (a property of the state alone, independent of
  // how much score was already banked) plus the argmax line; winning nodes and
  // cap-truncated nodes are never memoized. A memo hit with storedMax >= need
  // therefore yields a genuine winning line whose every node was fully explored.
  function search(level, opts) {
    opts = opts || {};
    var noSpecial = opts.allowSpecials === false;
    var target = (opts.target === undefined) ? Infinity : opts.target;
    var nodeCap = opts.nodeCap || DEFAULT_NODE_CAP;
    // progress metric — score by default, or whatever the objective measures
    var gain = opts.gain || progressFn(opts.objective || objectiveOf(level));
    var refill = level.refill;
    var budget = level.moves;
    var memo = {};
    var st = { nodes: 0, overflow: false };

    // need = remaining score to reach target from this node.
    function dfs(board, pointers, movesLeft, need) {
      if (need <= 0) return { win: true, seq: [] };
      if (movesLeft === 0) return { win: false, max: 0, seq: [] };
      if (st.nodes++ >= nodeCap) { st.overflow = true; return { win: false, max: 0, seq: [], capped: true }; }
      var k = movesLeft + "|" + logic.serialize(board) + "|" + pointers.join(",");
      var m = memo[k];
      if (m !== undefined) {
        if (m.max >= need) return { win: true, seq: m.seq };
        return { win: false, max: m.max, seq: m.seq };
      }

      var moves = logic.legalMoves(board, refill, pointers, { noSpecial: noSpecial });
      var best = { max: 0, seq: [] };
      var completed = true;
      for (var i = 0; i < moves.length; i++) {
        var res = moves[i].res;
        var g = gain(res);
        var child = dfs(res.board, res.pointers, movesLeft - 1, need - g);
        if (child.win) {
          return { win: true, seq: [moves[i].move].concat(child.seq) };
        }
        var tot = g + child.max;
        if (tot > best.max) best = { max: tot, seq: [moves[i].move].concat(child.seq) };
        if (child.capped || st.overflow) { completed = false; break; }
      }
      if (completed && !st.overflow) memo[k] = best; // exact-max, safe to reuse
      return { win: false, max: best.max, seq: best.seq };
    }

    var pointers = opts.initialPointers ? opts.initialPointers.slice() : startPointers(level);
    var r = dfs(logic.cloneBoard(level.board), pointers, budget, target);
    if (r.win) return { win: true, score: r.max === undefined ? target : r.max,
                        sequence: r.seq, overflow: st.overflow };
    return { win: false, score: r.max, sequence: r.seq, overflow: st.overflow };
  }

  // EXACT maximum score reachable within the budget (target=Infinity => full
  // enumeration). returns { score, sequence, overflow }.
  function bestScore(level, opts) {
    opts = opts || {};
    var r = search(level, { allowSpecials: opts.allowSpecials !== false,
                            target: Infinity, nodeCap: opts.nodeCap,
                            initialPointers: opts.initialPointers,
                            gain: opts.gain, objective: opts.objective });
    return { score: r.score, sequence: r.sequence, overflow: r.overflow };
  }

  // EXACT maximum progress toward `objective` reachable within the budget.
  // For a collect objective this is "the most creatures of that colour any line
  // can clear" — the number the generator sets a forgiving goal underneath, so
  // the goal is always backed by an exhibited line. Same overflow caveat as
  // bestScore: capped => the returned figure is a safe LOWER bound.
  function bestProgress(level, objective, opts) {
    opts = opts || {};
    return bestScore(level, { allowSpecials: opts.allowSpecials !== false,
                              nodeCap: opts.nodeCap,
                              initialPointers: opts.initialPointers,
                              objective: objective });
  }

  // Can a line reach `target` (default level.target) under the technique?
  // Short-circuits. returns { win, score, sequence, overflow }.
  function canReach(level, opts) {
    opts = opts || {};
    var objective = opts.objective || objectiveOf(level);
    var target = opts.target === undefined ? objective.amount : opts.target;
    return search(level, { allowSpecials: opts.allowSpecials !== false,
                           target: target, nodeCap: opts.nodeCap,
                           initialPointers: opts.initialPointers,
                           objective: objective, gain: opts.gain });
  }

  // ------------------------------------------------------- ground truth --

  // Replay a claimed sequence through the REAL rules from the level's start,
  // drawing refills from the fixed queues. Verifies each move is legal, sums the
  // score, and reports the winning PREFIX (first move whose cumulative score
  // reaches target). Returns { win, valid, score, movesUsed, sequence, board,
  // steps, reason }. The solver relies on this to certify every win it reports.
  // `objective` defaults to the level's own. `progress` in the result is the
  // objective metric (== score for a score objective); `score` is always the
  // banked points, because stars ride on score whatever the win condition is.
  function replaySequence(level, sequence, objective) {
    objective = objective || objectiveOf(level);
    var gain = progressFn(objective);
    var goal = objective.amount;
    var board = logic.cloneBoard(level.board);
    var pointers = startPointers(level);
    var score = 0, progress = 0, steps = [];
    for (var i = 0; i < sequence.length; i++) {
      var mv = sequence[i];
      var res = logic.applyMove(board, level.refill, pointers, mv, { allowSpecials: true });
      if (!res.legal) {
        return { win: false, valid: false, score: score, progress: progress, movesUsed: i,
                 sequence: sequence.slice(0, i), board: board, steps: steps,
                 reason: "move " + i + " is illegal" };
      }
      board = res.board;
      pointers = res.pointers;
      score += res.scoreGained;
      progress += gain(res);
      steps.push({ move: mv, scoreGained: res.scoreGained, cascades: res.cascades,
                   specialCreated: res.specialCreated, specialFired: res.specialFired,
                   collected: res.collected });
      if (progress >= goal) {
        return { win: true, valid: true, score: score, progress: progress, movesUsed: i + 1,
                 sequence: sequence.slice(0, i + 1), board: board, steps: steps };
      }
    }
    return { win: progress >= goal, valid: true, score: score, progress: progress,
             movesUsed: sequence.length, sequence: sequence.slice(), board: board,
             steps: steps };
  }

  // Trim a max-progress line to its winning prefix (first move crossing goal).
  function trimToTarget(level, sequence, objective) {
    var rep = replaySequence(level, sequence, objective);
    return rep.win ? rep.sequence : null;
  }

  // ------------------------------------------------------------- greedy --

  // A myopic player: each move takes the highest-immediate-score legal,
  // NON-special swap (ties -> earliest in row-major move order). No lookahead.
  // Deterministic. Returns { win, sequence, score }.
  // Greedy is measured in the SAME currency as the objective: on a collect
  // Depth the myopic player grabs the swap that clears the most of the wanted
  // colour, not the highest-scoring one. (Grading greedy on score while the win
  // condition was collect would mis-tier every collect level.)
  function greedy(level, objective) {
    objective = objective || objectiveOf(level);
    var gain = progressFn(objective);
    var goal = objective.amount;
    var board = logic.cloneBoard(level.board);
    var pointers = startPointers(level);
    var seq = [], score = 0, progress = 0;
    for (var m = 0; m < level.moves; m++) {
      if (progress >= goal) return { win: true, sequence: seq, score: score, progress: progress };
      var moves = logic.legalMoves(board, level.refill, pointers, { noSpecial: true });
      var best = null, bestGain = -1;
      for (var i = 0; i < moves.length; i++) {
        var g = gain(moves[i].res);
        if (best === null || g > bestGain) { best = moves[i]; bestGain = g; }
      }
      if (best === null) break; // stuck: no non-special legal move
      board = best.res.board;
      pointers = best.res.pointers;
      score += best.res.scoreGained;
      progress += bestGain;
      seq.push(best.move);
      if (progress >= goal) return { win: true, sequence: seq, score: score, progress: progress };
    }
    return { win: progress >= goal, sequence: seq, score: score, progress: progress };
  }

  // ------------------------------------------------------------- solve --

  // Public solve: does a line reach target under the given technique?
  //   opts: { allowSpecials(=true), nodeCap, checkAgainstTruth(=true) }
  // returns { win, sequence, score, overflow }.
  function solve(level, opts) {
    opts = opts || {};
    var objective = opts.objective || objectiveOf(level);
    var r = canReach(level, { allowSpecials: opts.allowSpecials !== false,
                              nodeCap: opts.nodeCap, objective: objective });
    var seq = r.win ? trimToTarget(level, r.sequence, objective) : null;
    if (r.win && opts.checkAgainstTruth !== false) {
      var rep = replaySequence(level, seq, objective);
      if (!rep.win) {
        throw new Error("SOLVER UNSOUND: certified sequence does not reach target");
      }
    }
    return { win: r.win, sequence: seq, score: r.score, overflow: r.overflow };
  }

  // ------------------------------------------------------------ classify --

  function classify(level, opts) {
    return analyze(level, opts).tier;
  }

  // Detailed classification bundle (the generator's gate). Tiers:
  //   easy | medium | hard | unwinnable | overflow  (see the header ladder).
  function analyze(level, opts) {
    opts = opts || {};
    var nodeCap = opts.nodeCap || DEFAULT_NODE_CAP;
    var check = opts.checkAgainstTruth !== false;
    var objective = opts.objective || objectiveOf(level);

    // easy — greedy wins.
    var g = greedy(level, objective);
    if (g.win) {
      var seqE = trimToTarget(level, g.sequence, objective);
      certify(level, seqE, check, objective);
      return { tier: "easy", sequence: seqE, greedy: g };
    }

    // medium — greedy failed; a no-special line reaches target (short-circuit).
    var sn = canReach(level, { allowSpecials: false, nodeCap: nodeCap, objective: objective });
    if (sn.win) {
      var seqM = trimToTarget(level, sn.sequence, objective);
      certify(level, seqM, check, objective);
      return { tier: "medium", sequence: seqM, greedy: g, nospec: sn };
    }
    // The no-special search failed. Trust "no" only if it was EXHAUSTIVE.
    if (sn.overflow) return { tier: "overflow", greedy: g, nospec: sn };

    // hard — no-special provably fails; a special-using line reaches target.
    var sf = canReach(level, { allowSpecials: true, nodeCap: nodeCap, objective: objective });
    if (sf.win) {
      var seqH = trimToTarget(level, sf.sequence, objective);
      certify(level, seqH, check, objective);
      return { tier: "hard", sequence: seqH, greedy: g, nospec: sn, full: sf };
    }
    if (sf.overflow) return { tier: "overflow", greedy: g, nospec: sn, full: sf };
    return { tier: "unwinnable", greedy: g, nospec: sn, full: sf };
  }

  function certify(level, sequence, check, objective) {
    if (!check) return;
    objective = objective || objectiveOf(level);
    var rep = replaySequence(level, sequence, objective);
    if (!rep.win) {
      throw new Error("SOLVER UNSOUND: certified " + JSON.stringify(sequence) +
        " does not meet objective [" + objectiveLabel(objective) + "] (" +
        rep.progress + "/" + objective.amount + ")");
    }
  }

  // ---------------------------------------------------------------- hint --

  // The next swap on a known winning path (full technique). null if none.
  function hint(level, opts) {
    var res = solve(level, opts);
    return res.win && res.sequence.length ? res.sequence[0] : null;
  }

  return {
    DEFAULT_NODE_CAP: DEFAULT_NODE_CAP,
    search: search,
    objectiveOf: objectiveOf,
    progressFn: progressFn,
    objectiveLabel: objectiveLabel,
    bestProgress: bestProgress,
    bestScore: bestScore,
    canReach: canReach,
    solve: solve,
    replaySequence: replaySequence,
    trimToTarget: trimToTarget,
    greedy: greedy,
    classify: classify,
    analyze: analyze,
    hint: hint
  };
});
