/*
 * add-objectives.js — give a slice of the deep campaign a COLLECT objective
 * instead of a score target, without regenerating a single board.
 *
 * WHY THIS SHAPE
 *   Every Depth used to ask the same question: "bank N points in M moves."
 *   Objective variety is the cheapest real retention lever in a match-3, but it
 *   must not cost the correctness guarantee. So: boards, refill queues and move
 *   budgets are left EXACTLY as shipped, and only the win condition changes —
 *   from "score >= target" to "clear N creatures of one colour".
 *
 * HOW THE GOAL IS CHOSEN (and why it is always winnable)
 *   solver.bestProgress() returns the maximum number of a given colour any line
 *   can clear within the budget, under a named technique. For each candidate
 *   colour we measure the same three ceilings the tier ladder already uses:
 *
 *     Sg = greedy's collect count (myopic: grab the most of that colour now)
 *     Sn = exhaustive max with specials FORBIDDEN
 *     Sf = exhaustive max with specials ALLOWED          (Sg <= Sn <= Sf)
 *
 *   The goal is then placed inside the band for the Depth's EXISTING wave tier:
 *
 *     easy   goal <= Sg                    (greedy alone gets there)
 *     medium Sg <  goal <= Sn              (greedy provably fails; planning works)
 *     hard   Sn <  goal <= Sf              (requires creating/firing a special)
 *
 *   with a forgiving 0.4 step into the band rather than sitting on its ceiling.
 *   Because every goal is <= Sf, and Sf is an EXHIBITED line (not an estimate),
 *   the objective is reachable by construction — and solver.analyze() then
 *   re-certifies the whole thing and replays the winning line through the real
 *   rules before the Depth is written out.
 *
 *   A colour is only usable if its band is non-empty (e.g. a "hard" collect
 *   needs Sn < Sf — a colour whose ceiling specials don't raise cannot express a
 *   hard collect).
 *
 * OVERFLOW, AND WHY ONLY HARD PAYS FOR IT
 *   A capped search returns a LOWER BOUND on the maximum. A lower bound is still
 *   an EXHIBITED line — the solver found it and can replay it — so it fully
 *   supports SUFFICIENCY ("this goal is reachable"). What a capped search cannot
 *   support is NECESSITY ("no cheaper technique reaches it"), because that is a
 *   claim about lines it never explored. Splitting the tiers on that distinction
 *   is what makes this script practical:
 *
 *     easy   — asserts only "greedy gets there". Greedy is one deterministic
 *              playthrough, so NO search runs at all. Instant.
 *     medium — necessity is "greedy fails" (again, no search); sufficiency needs
 *              one exhibited no-special line, which a capped Sn provides. ~20-80s.
 *     hard   — necessity is "the no-special search PROVABLY fails", which is
 *              exactly the claim a cap invalidates. Only here is an exhaustive
 *              search required, and only here is overflow a rejection. ~1-2 min.
 *
 *   Depths where no colour offers a band at the required tier are left as score
 *   Depths and reported, never silently downgraded to an easier claim.
 *
 * Run:  node scripts/add-objectives.js                    # every 5th Depth from 27
 *       node scripts/add-objectives.js --depths 26,28,33  # an explicit list
 *       node scripts/add-objectives.js --depths 27 --force  # recompute one
 */
"use strict";

var fs = require("fs");
var path = require("path");
var solver = require("../src/solver.js");

var argv = process.argv.slice(2);
function argVal(flag, dflt) {
  var i = argv.indexOf(flag);
  return (i >= 0 && argv[i + 1]) ? argv[i + 1] : dflt;
}
var EVERY = parseInt(argVal("--every", "5"), 10);
var FROM = parseInt(argVal("--from", "27"), 10);
// --depths 26,30,36 targets an explicit list instead of the from/every stride.
// Hard Depths cost ~2 min each to certify (three exhaustive searches per colour),
// easy/medium a few seconds — so the shipped mix is picked by list, not stride.
var DEPTHS = argVal("--depths", "");
var NODE_CAP = 400000;
var STEP = 0.4;          // how far into the tier band the goal sits
var MIN_GOAL = 4;        // below this a collect objective reads as trivial
// Each candidate colour costs TWO full enumerations (no-special and full), and a
// full enumeration is the expensive kind of search — it cannot short-circuit,
// because "the maximum reachable" is only known once every line is explored.
// Testing all 4-6 colours per Depth made this script take longer than the whole
// campaign build, so we test only the most abundant colours: a colour that
// barely appears cannot support a meaningful collect goal anyway.
var CANDIDATE_COLOURS = 2;

var file = path.join(__dirname, "..", "js", "levels.js");
global.window = {};
require(file);
var levels = window.CANDY_LEVELS;

function bandGoal(tier, Sg, Sn, Sf) {
  if (tier === "easy") {
    if (Sg < MIN_GOAL) return null;
    var ge = Math.round(Sg * 0.85);                  // comfortably under greedy
    if (ge >= Sg) ge = Sg - 1;                        // never demand a perfect greedy run
    return ge >= MIN_GOAL ? ge : null;
  }
  if (tier === "medium") {
    if (Sn <= Sg) return null;                        // empty band
    var gm = Sg + Math.max(1, Math.ceil((Sn - Sg) * STEP));
    return (gm > Sg && gm <= Sn && gm >= MIN_GOAL) ? gm : null;
  }
  if (tier === "hard") {
    if (Sf <= Sn) return null;                        // empty band
    var gh = Sn + Math.max(1, Math.ceil((Sf - Sn) * STEP));
    return (gh > Sn && gh <= Sf && gh >= MIN_GOAL) ? gh : null;
  }
  return null;
}

// The colours worth testing: most plentiful across the start board AND the
// refill queues, since both feed what a player can actually clear.
function abundantColours(level, n) {
  var count = [];
  var i;
  for (i = 0; i <= level.colorCount; i++) count.push(0);
  for (var r = 0; r < level.board.rows; r++) {
    for (var c = 0; c < level.board.cols; c++) {
      var cell = level.board.grid[r][c];
      if (cell && cell.color <= level.colorCount) count[cell.color]++;
    }
  }
  for (var q = 0; q < level.refill.length; q++) {
    var queue = level.refill[q] || [];
    for (var k = 0; k < queue.length; k++) {
      if (queue[k] <= level.colorCount) count[queue[k]]++;
    }
  }
  var order = [];
  for (i = 1; i <= level.colorCount; i++) order.push(i);
  order.sort(function (a, b) { return count[b] - count[a] || a - b; });
  return order.slice(0, n);
}

function tryColour(level, colour) {
  var probe = { type: "collect", color: colour, amount: 1 };
  var g = solver.greedy(level, { type: "collect", color: colour, amount: Infinity });
  var Sg = g.progress;

  // EASY needs no enumeration at all. The claim is "greedy alone gets there",
  // and greedy is a single deterministic playthrough — so a goal at or below Sg
  // is certified by an exhibited line for free. The full enumerations exist to
  // prove the NECESSITY half (greedy/no-special provably FAIL), which an easy
  // Depth does not assert. Skipping them here is what makes assigning objectives
  // to the easy wave slots practical: those deep 7-move boards overflow even a
  // 400k-node exhaustive search, which is why every one of them was being
  // rejected with "full search capped".
  if (level.tier === "easy") {
    var ge = bandGoal("easy", Sg, Sg, Sg);
    if (ge === null) return { rejected: "greedy only collects " + Sg + " of colour " + colour };
    return { colour: colour, goal: ge, Sg: Sg, Sn: Sg, Sf: Sg };
  }

  // MEDIUM needs no exhaustive search either, and this is the crux: a capped
  // search returns a LOWER BOUND on the maximum, and a lower bound is still an
  // EXHIBITED line — the solver found it and can replay it. Overflow only
  // destroys claims of the form "no line can do better", i.e. NECESSITY.
  //
  //   medium sufficiency: "a no-special line reaches the goal"  -> needs an
  //     exhibited line. A capped Ln works.
  //   medium necessity:   "greedy fails"                        -> greedy is one
  //     deterministic playthrough. No search at all.
  //
  // So placing the goal in (Sg, Ln] certifies medium soundly on a capped search.
  // The same applies to the star ceiling for every tier: stars are clamped to an
  // achievable figure, never to a "nothing beats this" claim.
  if (level.tier === "medium") {
    var ln = solver.bestProgress(level, probe, { allowSpecials: false, nodeCap: NODE_CAP });
    if (ln.score <= Sg) {
      return { rejected: "planning buys nothing for colour " + colour +
                         " (greedy " + Sg + ", no-special " + ln.score + ")" };
    }
    var gm = Sg + Math.max(1, Math.ceil((ln.score - Sg) * STEP));
    if (gm > ln.score) gm = ln.score;
    if (gm < MIN_GOAL) return { rejected: "band too low (Sg=" + Sg + " Ln=" + ln.score + ")" };
    return { colour: colour, goal: gm, Sg: Sg, Sn: ln.score, Sf: ln.score,
             capped: !!ln.overflow };
  }

  // HARD is the one tier that genuinely needs exhaustion: its claim is that the
  // no-special search PROVABLY fails, which a capped search cannot establish.
  var sn = solver.bestProgress(level, probe, { allowSpecials: false, nodeCap: NODE_CAP });
  if (sn.overflow) return { rejected: "no-special search capped" };
  var sf = solver.bestProgress(level, probe, { allowSpecials: true, nodeCap: NODE_CAP });
  if (sf.overflow) return { rejected: "full search capped" };
  var goal = bandGoal(level.tier, Sg, sn.score, sf.score);
  if (goal === null) return { rejected: "no goal in the " + level.tier + " band (Sg=" + Sg + " Sn=" + sn.score + " Sf=" + sf.score + ")" };
  return { colour: colour, goal: goal, Sg: Sg, Sn: sn.score, Sf: sf.score };
}

function main() {
  var changed = [], skipped = [];
  var queue = [];
  if (DEPTHS) {
    DEPTHS.split(",").forEach(function (s) {
      var n = parseInt(s.trim(), 10);
      if (n >= 1 && n <= levels.length) queue.push(n);
    });
    console.log("Assigning collect objectives — Depths " + queue.join(", "));
  } else {
    for (var q = FROM; q <= levels.length; q += EVERY) queue.push(q);
    console.log("Assigning collect objectives — every " + EVERY + " Depths from " + FROM);
  }
  console.log(new Array(72).join("="));

  for (var qi = 0; qi < queue.length; qi++) {
    var d = queue[qi];
    var level = levels[d - 1];
    if (level.objective && argv.indexOf("--force") < 0) {
      skipped.push(d + " (already has an objective)"); continue;
    }
    var t0 = Date.now();
    var best = null, reasons = [];
    var candidates = abundantColours(level, CANDIDATE_COLOURS);
    for (var ci = 0; ci < candidates.length; ci++) {
      var colour = candidates[ci];
      var got = tryColour(level, colour);
      if (got.rejected) { reasons.push("c" + colour + ": " + got.rejected); continue; }
      // prefer the colour with the most headroom above the goal — the least
      // knife-edge version of the objective
      if (!best || (got.Sf - got.goal) > (best.Sf - best.goal)) best = got;
    }
    if (!best) {
      skipped.push(d + " — " + reasons.join("; "));
      console.log("Depth " + pad(d, 3) + "  " + rpad(level.tier, 6) + "  SKIPPED (stays a score Depth)");
      continue;
    }

    var objective = { type: "collect", color: best.colour, amount: best.goal };
    // belt-and-suspenders: re-certify the tier under the objective and replay
    var info = solver.analyze(level, { objective: objective, nodeCap: NODE_CAP });
    if (info.tier !== level.tier) {
      skipped.push(d + " — certified " + info.tier + ", wanted " + level.tier);
      console.log("Depth " + pad(d, 3) + "  " + rpad(level.tier, 6) +
        "  REJECTED (certified " + info.tier + ")");
      continue;
    }
    var rep = solver.replaySequence(level, info.sequence, objective);
    if (!rep.win) throw new Error("Depth " + d + ": certified collect line failed replay");

    // Stars for a collect Depth ride on OVERSHOOT of the goal, mirroring the v3
    // score rule (star2 1.15x / star3 1.35x) and clamped to Sf — the exhibited
    // ceiling — so 3 stars stays provably attainable. Score-based stars would be
    // wrong here: a player can meet a collect goal with a modest score and would
    // be stuck at 1 star no matter how well they played the objective.
    var oStar2 = Math.min(Math.round(best.goal * 1.15), best.Sf);
    var oStar3 = Math.min(Math.round(best.goal * 1.35), best.Sf);
    if (oStar2 <= best.goal) oStar2 = Math.min(best.goal + 1, best.Sf);
    if (oStar3 <= oStar2) oStar3 = Math.min(oStar2 + 1, best.Sf);

    level.objective = objective;
    level.objPar = info.sequence.length;
    level.objStar2 = oStar2;
    level.objStar3 = oStar3;
    level.objMax = best.Sf;
    changed.push(d);
    console.log("Depth " + pad(d, 3) + "  " + rpad(level.tier, 6) +
      "  collect " + pad(best.goal, 3) + " of colour " + best.colour +
      "   (Sg " + pad(best.Sg, 3) + " / Sn " + pad(best.Sn, 3) + " / Sf " + pad(best.Sf, 3) + ")" +
      "  par " + info.sequence.length + "  " + (Date.now() - t0) + "ms");
  }

  var header =
    "/* AUTO-GENERATED by scripts/build-levels.js — do not edit by hand.\n" +
    " * The Tide Pool \"Depths\" campaign, pre-verified by the solver.\n" +
    " * Depths 1-24: the original campaign, REGRADED under the Phase-3 ruleset.\n" +
    " * Depths 25-100: the 10-Depth tier wave E M H M H E M H M H.\n" +
    " * Some deep Depths carry `objective` (a COLLECT goal) assigned by\n" +
    " *   scripts/add-objectives.js — the win condition is that objective, not\n" +
    " *   `target`; the goal is certified inside the Depth's own tier band.\n" +
    " * Star thresholds follow the v3 rule (star2 1.15x / star3 1.35x win target).\n" +
    " * Each entry: { depth, tier, rows, cols, colorCount, moves, target,\n" +
    " *   certTarget, star2, star3, maxScore, par, board:{rows,cols,grid},\n" +
    " *   refill:[[...]], objective?:{type,color,amount}, objPar? }.\n" +
    " * Extend: node scripts/build-levels.js --count N --from <existing+1> */\n";
  fs.writeFileSync(file, header + "window.CANDY_LEVELS = " + JSON.stringify(levels) + ";\n");

  console.log(new Array(72).join("="));
  console.log("Collect Depths: " + changed.length + "  -> " + changed.join(", "));
  if (skipped.length) {
    console.log("Left as score Depths (" + skipped.length + "):");
    skipped.forEach(function (s) { console.log("   " + s); });
  }
}

function pad(n, w) { var s = String(n); while (s.length < w) s = " " + s; return s; }
function rpad(s, w) { s = String(s); while (s.length < w) s = s + " "; return s; }

main();
