/*
 * endless.js — "The Trench": the campaign's content ceiling, removed.
 *
 * 100 Depths is a weekend for a committed player, and there is nothing after
 * Depth 100. The Trench keeps generating: every rung is produced on-device by
 * the same solver-gated pipeline that built the campaign (see endless-worker.js),
 * so it is endless WITHOUT becoming the random slot machine the whole project
 * exists to avoid — each rung is still provably winnable at its stated tier.
 *
 * THE BUFFER
 *   Certifying a level takes seconds, so levels are generated ahead of the
 *   player and parked in localStorage. The player descends into rungs that were
 *   certified minutes ago; the worker refills behind them while they play. If
 *   the buffer ever runs dry the UI says "the trench is still forming" rather
 *   than freezing on a solver call — the one thing it must never do is block.
 *
 * THE RAMP
 *   Rung 1-3 easy, 4-9 medium, 10+ hard, with the forgiving fraction of the
 *   certified target tightening as you go (0.55 -> 0.85). Descent is one-way:
 *   losing ends the run and banks your best. That is the whole scoring system —
 *   how deep did you get before the tide took you.
 */
(function (root) {
  "use strict";

  var BUFFER_TARGET = 3;          // rungs kept certified and ready
  var STORE = "tp-trench";        // { best, runs, buffer:[level], nextSeed }

  function lsGet(k, fb) {
    try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : fb; }
    catch (e) { return fb; }
  }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

  var state = Object.assign(
    { best: 0, runs: 0, buffer: [], nextSeed: 1 },
    lsGet(STORE, {})
  );
  if (!Array.isArray(state.buffer)) state.buffer = [];
  function save() { lsSet(STORE, state); }

  // ---------------------------------------------------------------- ramp --
  function tierForRung(rung) {
    if (rung <= 3) return "easy";
    if (rung <= 9) return "medium";
    return "hard";
  }
  // Extra moves early so the first rungs teach rather than punish.
  function budgetFor(tier, rung) {
    var base = { easy: 5, medium: 6, hard: 5 }[tier];
    var bonus = rung <= 2 ? 3 : rung <= 5 ? 2 : rung <= 12 ? 1 : 0;
    if (tier === "hard") bonus += 1;      // hard boards are unfair at 5 moves
    return base + bonus;
  }
  // How much of the certified (perfect-play) target the player must actually
  // reach. Tightens with depth; never reaches 1.0, which would demand the
  // optimal line move for move.
  function forgivenessFor(rung) {
    var f = 0.55 + 0.03 * (rung - 1);
    return Math.min(0.85, f);
  }

  // -------------------------------------------------------------- worker --
  var worker = null, pending = {}, jobId = 0, broken = false;
  function getWorker() {
    if (worker || broken) return worker;
    try {
      worker = new Worker("js/endless-worker.js");
      worker.onmessage = function (e) {
        var d = e.data || {};
        var job = pending[d.id];
        delete pending[d.id];
        if (d.type === "level") {
          state.buffer.push(d.level);
          save();
          if (job && job.onDone) job.onDone(d.level);
          fill();                              // keep topping up
        } else {
          // a rejected candidate is normal (empty tier window); just try again
          if (job && job.rung) requestRung(job.rung, job.onDone);
        }
      };
      worker.onerror = function () { broken = true; worker = null; };
    } catch (e) { broken = true; worker = null; }
    return worker;
  }

  function requestRung(rung, onDone) {
    var w = getWorker();
    if (!w) return false;
    var tier = tierForRung(rung);
    var id = ++jobId;
    pending[id] = { rung: rung, onDone: onDone };
    state.nextSeed = (state.nextSeed || 1) + 1;
    save();
    try {
      w.postMessage({ type: "generate", id: id, tier: tier,
                      seed: state.nextSeed * 7919 + rung,
                      budget: budgetFor(tier, rung),
                      forgiveness: forgivenessFor(rung) });
      return true;
    } catch (e) { delete pending[id]; return false; }
  }

  // Top the buffer up toward BUFFER_TARGET. Safe to call often.
  function fill(rungHint) {
    var inFlight = Object.keys(pending).length;
    var have = state.buffer.length + inFlight;
    var rung = rungHint || (state.best + 1);
    for (var i = have; i < BUFFER_TARGET; i++) requestRung(rung + i, null);
  }

  // Take the next certified rung, or null if the buffer is still filling.
  function take() {
    if (!state.buffer.length) { fill(); return null; }
    var lvl = state.buffer.shift();
    save();
    fill();
    return lvl;
  }

  function ready() { return state.buffer.length; }
  function best() { return state.best || 0; }
  function runs() { return state.runs || 0; }
  function recordRun(rungsCleared) {
    state.runs = (state.runs || 0) + 1;
    if (rungsCleared > (state.best || 0)) state.best = rungsCleared;
    save();
    return state.best;
  }

  root.TideTrench = {
    fill: fill,
    take: take,
    ready: ready,
    best: best,
    runs: runs,
    recordRun: recordRun,
    tierForRung: tierForRung,
    available: function () { return !broken; }
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
