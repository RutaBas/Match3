/* retarget-levels.js — lower shipped win targets that sit too close to the
 * ceiling, WITHOUT re-generating anything.
 *
 * WHY THIS IS NOT A REBUILD
 *   build-levels.js re-runs the solver and re-grades, which moves boards, tiers
 *   and star bars out from under existing saves — its own header warns about it.
 *   Nothing here needs that. The winnability guarantee is
 *       winTarget <= certTarget <= maxScore
 *   and every one of those numbers is already stored in js/levels.js. LOWERING
 *   winTarget preserves the inequality for free: the same certified line still
 *   clears the lower bar. So this is pure arithmetic on the shipped file —
 *   boards, refill queues, moves, tiers and certTargets are untouched, and the
 *   script asserts that no target ever goes UP.
 *
 *   Star bands are then re-derived from the new bar with the generator's own v3
 *   rule (1.15x / 1.35x, clamped to certTarget and maxScore), so a Depth whose
 *   target moved does not keep star bars anchored to the old one.
 *
 * SCOPE
 *   Score Depths only. A collect Depth wins on `objective.amount`, and its
 *   stored maxScore is in points while its goal is in creatures — clamping one
 *   against the other would be meaningless.
 *
 * Usage: node scripts/retarget-levels.js [--fraction 0.55] [--write]
 *        (dry run by default; --write edits js/levels.js in place)
 */
var fs = require("fs");
var path = require("path");

var argv = process.argv.slice(2);
function argVal(flag, dflt) {
  var i = argv.indexOf(flag);
  return (i >= 0 && argv[i + 1]) ? argv[i + 1] : dflt;
}
var FRACTION = parseFloat(argVal("--fraction", "0.55"));
var WRITE = argv.indexOf("--write") >= 0;
var LEVELS_PATH = path.join(__dirname, "..", "js", "levels.js");

function round60(x) { return Math.round(x / 60) * 60; }

global.window = {};
require(LEVELS_PATH);
var levels = global.window.CANDY_LEVELS;
if (!levels || !levels.length) throw new Error("no levels loaded from " + LEVELS_PATH);

// The generator's v3 star rule, re-derived from the new win bar.
function starsFor(level, winTarget) {
  var M = level.maxScore;
  var star2 = round60(winTarget * 1.15);
  var star3 = round60(winTarget * 1.35);
  var ceil = Math.min(M, level.certTarget);
  if (star3 > ceil) star3 = round60(ceil);
  if (star2 >= star3) star2 = star3 - 60;
  if (star2 <= winTarget) star2 = winTarget + 60;
  if (star3 <= star2) star3 = star2 + 60;
  if (star3 > M) star3 = round60(M);
  if (star2 > star3) star2 = star3;
  return { star2: star2, star3: star3 };
}

var changed = [];
levels.forEach(function (lv) {
  if (lv.objective) return;               // wins on creatures, not points
  if (!lv.maxScore) return;
  var ceiling = Math.max(60, round60(lv.maxScore * FRACTION));
  if (lv.target <= ceiling) return;

  var before = { target: lv.target, star2: lv.star2, star3: lv.star3 };
  // Remember what this Depth used to ask for. A mid-level save written before the
  // rebalance carries a signature hashed over the OLD target, so without this the
  // game cannot recognise it and throws away a legitimate in-progress game. The
  // resume path accepts a signature built from prevTarget for exactly that reason.
  // Only ever set once: a re-run that changes nothing must not overwrite it.
  if (lv.prevTarget === undefined) lv.prevTarget = before.target;
  lv.target = ceiling;
  var st = starsFor(lv, lv.target);
  lv.star2 = st.star2;
  lv.star3 = st.star3;
  changed.push({ depth: lv.depth, tier: lv.tier, before: before,
                 after: { target: lv.target, star2: lv.star2, star3: lv.star3 },
                 max: lv.maxScore });
});

// ---- invariants. Any failure here means the edit was not safe; refuse to write.
var problems = [];
levels.forEach(function (lv) {
  if (lv.objective || !lv.maxScore) return;
  if (lv.target > lv.certTarget) problems.push("Depth " + lv.depth + ": target > certTarget");
  if (lv.target > lv.maxScore) problems.push("Depth " + lv.depth + ": target > maxScore");
  if (lv.star2 <= lv.target) problems.push("Depth " + lv.depth + ": star2 <= target");
  if (lv.star3 <= lv.star2) problems.push("Depth " + lv.depth + ": star3 <= star2");
  if (lv.star3 > lv.maxScore) problems.push("Depth " + lv.depth + ": star3 > maxScore");
});
changed.forEach(function (c) {
  if (c.after.target > c.before.target) problems.push("Depth " + c.depth + ": target went UP");
});

console.log("clamp: target <= " + Math.round(FRACTION * 100) + "% of maxScore");
console.log("Depths retargeted: " + changed.length + " of " + levels.length);
changed.forEach(function (c) {
  console.log("  Depth " + String(c.depth).padEnd(5) + c.tier.padEnd(7) +
    "target " + String(c.before.target).padEnd(7) + "-> " + String(c.after.target).padEnd(7) +
    "(" + Math.round(c.before.target / c.max * 100) + "% -> " +
    Math.round(c.after.target / c.max * 100) + "% of max)   stars " +
    c.before.star2 + "/" + c.before.star3 + " -> " + c.after.star2 + "/" + c.after.star3);
});

if (problems.length) {
  console.error("\nINVARIANTS FAILED — refusing to write:");
  problems.forEach(function (p) { console.error("  " + p); });
  process.exit(1);
}
console.log("\ninvariants OK (target <= certTarget <= maxScore, stars ascending, nothing raised)");

if (!WRITE) { console.log("dry run — pass --write to apply"); return; }

var src = fs.readFileSync(LEVELS_PATH, "utf8");
var header = src.slice(0, src.indexOf("window.CANDY_LEVELS"));
fs.writeFileSync(LEVELS_PATH, header + "window.CANDY_LEVELS = " + JSON.stringify(levels) + ";\n");
console.log("wrote " + LEVELS_PATH);
