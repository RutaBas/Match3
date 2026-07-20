/*
 * hint-worker.js — off-main-thread solver hints.
 *
 * The solver's hint runs an exhaustive search over the move tree; on Hard that
 * can take a couple of seconds. Running it in a Worker keeps the board fully
 * responsive (the UI shows a brief "thinking" state instead of freezing).
 *
 * The verified engine is imported AS-IS (no rules reimplemented). The main
 * thread posts the CURRENT mid-game sub-level — current board, current per-column
 * refill pointers, moves remaining, and the REMAINING target (target minus score
 * already banked) — and we return solver.hint()'s next winning swap (or null).
 */
"use strict";

importScripts("../src/rng.js", "../src/logic.js", "../src/solver.js");

self.onmessage = function (e) {
  var d = e.data || {};
  if (d.type !== "hint") return;
  try {
    var move = self.CandySolver.hint(d.level, { nodeCap: d.nodeCap });
    self.postMessage({ type: "hint", id: d.id, move: move || null });
  } catch (err) {
    self.postMessage({ type: "error", id: d.id, message: String((err && err.message) || err) });
  }
};
