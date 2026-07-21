/*
 * reverify-campaign.js — re-certify the SHIPPED campaign under the Phase-3
 * ruleset (urchins + special+special activation combos).
 *
 * The shipped js/levels.js was certified under the pre-urchin rules. Phase 3
 * mostly ADDS player power (new special, always-legal combo swaps), so levels
 * should stay winnable — but that must be proved, not assumed. For EVERY depth
 * this script asks the solver, under the NEW rules:
 *
 *     canReach(level, { allowSpecials: true, target: level.target,
 *                       nodeCap: <generous> })
 *
 * where level.target is the player-facing WIN target. A PASS additionally
 * replays the witnessing move sequence through the real rules (trimToTarget /
 * replaySequence) so every "winnable" verdict is ground-truth-certified. A
 * FAIL is reported as PROVEN-UNWINNABLE only when the search exhausted without
 * hitting the node cap; a capped search that found no win prints UNPROVEN.
 *
 * READ-ONLY with respect to js/levels.js. Run:  node scripts/reverify-campaign.js
 */
"use strict";

var path = require("path");

// js/levels.js is a browser-global file: stub window, then load it.
global.window = {};
require(path.join(__dirname, "..", "js", "levels.js"));
var levels = global.window.CANDY_LEVELS;
if (!levels || !levels.length) {
  console.error("Could not load window.CANDY_LEVELS from js/levels.js");
  process.exit(2);
}

var solver = require(path.join(__dirname, "..", "src", "solver.js"));

var NODE_CAP = 3000000; // generous: well above every tier's certification cap

console.log("Tide Pool campaign re-verification under Phase-3 rules");
console.log("Depths: " + levels.length + "   nodeCap: " + NODE_CAP);
console.log(new Array(72).join("="));

var fails = [], unproven = [], t0 = Date.now();

for (var i = 0; i < levels.length; i++) {
  var L = levels[i];
  var lvl = { board: L.board, refill: L.refill, moves: L.moves, target: L.target };
  var d0 = Date.now();
  var r = solver.canReach(lvl, { allowSpecials: true, target: L.target, nodeCap: NODE_CAP });
  var verdict, extra = "";
  if (r.win) {
    // ground-truth: replay the witnessing line through the real rules.
    var seq = solver.trimToTarget(lvl, r.sequence);
    if (seq) {
      verdict = "PASS";
      extra = "win in " + seq.length + " moves";
    } else {
      verdict = "FAIL";
      extra = "UNSOUND: witness sequence failed replay";
      fails.push(L.depth);
    }
  } else if (r.overflow) {
    verdict = "FAIL";
    extra = "UNPROVEN (node cap hit; best found " + r.score + "/" + L.target + ")";
    unproven.push(L.depth);
  } else {
    verdict = "FAIL";
    extra = "PROVEN unwinnable (exhaustive max " + r.score + " < " + L.target + ")";
    fails.push(L.depth);
  }
  console.log(
    "Depth " + pad(L.depth, 2) + "  " + rpad(L.tier, 6) +
    " " + L.rows + "x" + L.cols + " mv" + pad(L.moves, 2) +
    "  target " + pad(L.target, 6) +
    "  " + rpad(verdict, 4) + "  " + extra +
    "  (" + (Date.now() - d0) + "ms)"
  );
}

console.log(new Array(72).join("="));
var passCount = levels.length - fails.length - unproven.length;
console.log("Summary: " + passCount + "/" + levels.length + " PASS" +
  "   proven-fail depths: " + (fails.length ? fails.join(", ") : "none") +
  "   unproven depths: " + (unproven.length ? unproven.join(", ") : "none") +
  "   total " + ((Date.now() - t0) / 1000).toFixed(1) + "s");

process.exitCode = (fails.length || unproven.length) ? 1 : 0;

function pad(n, w) { var s = String(n); while (s.length < w) s = " " + s; return s; }
function rpad(s, w) { s = String(s); while (s.length < w) s = s + " "; return s; }
