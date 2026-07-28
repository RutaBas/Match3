/*
 * endless-worker.js — generate and CERTIFY Trench levels off the main thread.
 *
 * The Trench is endless, so its levels cannot be pre-baked. They are generated
 * on the device by the exact same generate-and-gate pipeline the campaign was
 * built with — solver.analyze() must certify the requested tier, and the winning
 * line is replayed through the real rules — so an endless Depth carries the same
 * guarantee as a shipped one: provably winnable, at the tier it claims.
 *
 * That costs seconds per level, which is why this runs in a Worker and why
 * js/endless.js keeps a buffer generated well ahead of the player. The UI never
 * waits on the solver; it waits on a buffer that was filled while the player was
 * reading the home screen or playing the previous dive.
 */
"use strict";

importScripts("../src/rng.js", "../src/logic.js", "../src/solver.js", "../src/generator.js");

self.onmessage = function (e) {
  var d = e.data || {};
  if (d.type !== "generate") return;
  var G = self.CandyGenerator, S = self.CandySolver;
  try {
    var level = G.generate(d.tier, d.seed, { budget: d.budget });

    // belt-and-suspenders, exactly as scripts/build-levels.js does it
    var info = S.analyze(level, { nodeCap: G.TIERS[d.tier].nodeCap });
    if (info.tier !== d.tier) {
      throw new Error("certified " + info.tier + ", wanted " + d.tier);
    }
    var rep = S.replaySequence(level, info.sequence);
    if (!rep.win) throw new Error("winning line failed replay");

    // The player's win bar is a forgiving fraction of the certified floor, the
    // same idea as the campaign's ramped targets: the certified target means
    // "played the optimal line perfectly", which is not a fair ask.
    var winTarget = Math.round((level.target * d.forgiveness) / 60) * 60;
    if (winTarget < 60) winTarget = 60;
    if (winTarget > level.target) winTarget = level.target;

    var max = S.bestScore(level, { allowSpecials: true, nodeCap: 60000 });
    var reachable = Math.max(max.score, level.target);
    var star2 = Math.min(Math.round(winTarget * 1.15 / 60) * 60, reachable);
    var star3 = Math.min(Math.round(winTarget * 1.35 / 60) * 60, reachable);
    if (star2 <= winTarget) star2 = winTarget + 60;
    if (star3 <= star2) star3 = star2 + 60;

    self.postMessage({
      type: "level", id: d.id,
      level: {
        tier: d.tier,
        rows: level.rows, cols: level.cols, colorCount: level.colorCount,
        moves: level.moves,
        target: winTarget,
        certTarget: level.target,
        star2: star2, star3: star3,
        maxScore: reachable,
        par: info.sequence.length,
        board: level.board,
        refill: level.refill,
        seed: d.seed
      }
    });
  } catch (err) {
    self.postMessage({ type: "error", id: d.id,
                       message: String((err && err.message) || err) });
  }
};
