# Candy Crush dupe — Spec (intake)

A **solver-gated match-3 puzzle**, not an endless arcade time-waster. Every level is a
**fixed starting board** plus a **fixed, per-column refill queue** plus a **move budget**
and a **target score**. The player wins by reaching the target score before the moves run
out. A real solver proves each generated level is winnable *at its target difficulty* before
it ships — correctness proven by code that runs, never eyeballed (Ruta's puzzle playbook).

The one non-negotiable adaptation of Candy Crush for a *solver*: **refills are deterministic**,
not random. Each column carries a fixed queue of upcoming candies. Given a starting board and
a move sequence, the entire game — cascades and all — is fully reproducible. That determinism
is exactly what lets a solver search the move tree and grade the level. (Random refills would
make "prove this level is winnable" meaningless.)

## Board & pieces
- **Grid:** square, portrait-friendly. Easy 6×6, Medium 7×7, Hard 7×8 (rows×cols; ≥44px
  tap targets at ~390px width). The board dominates the screen; chrome recedes.
- **Candies (colors):** the count is a difficulty lever. Easy 4, Medium 5, Hard 6. Fewer
  colors → more incidental matches → easier; more colors → sparser matches → harder.
- **Refill queue:** each column has a fixed, visible-in-spirit sequence of incoming candies
  drawn from the top as cells empty. Deterministic ⇒ replayable ⇒ solvable.
- **Move budget:** a fixed number of swaps. A tight budget is a difficulty lever.
- **Target score:** the win threshold. Grading is done against *this* target.

## Rules (the logic the solver reasons over)
1. **Swap:** exchange two orthogonally-adjacent candies. A swap is **legal only if it
   creates at least one match** (a run of ≥3 same-color in a row or column). Illegal swaps
   are rejected (no move spent).
2. **Match & clear:** find every maximal horizontal/vertical run of ≥3 same color; clear all
   matched candies and **score** them. Overlapping runs clear together.
3. **Specials (the CC feel, and the hard-tier technique):**
   - A run of **4** creates a **striped** candy. Clearing/activating it wipes its full
     **row or column**.
   - A run of **5 in a line** creates a **color bomb**. Activating it (swap against a normal
     candy) clears **every candy of that color**.
   Specials are created at the swap cell and fire when matched or swapped. They are part of
   the real rules AND the grading ladder.
4. **Gravity:** after clears, candies fall down within their column to fill gaps.
5. **Refill:** empty cells at the top of each column fill from that column's fixed queue.
6. **Cascade:** falls/refills that form new matches auto-resolve, chaining. Each chained
   resolve raises a **combo multiplier**, so cascades score more. Repeat until stable.
7. **Win:** score ≥ target before the move budget is spent. **Lose:** moves exhausted with
   score < target.

## Difficulty graded by the technique the solver needs (not by feel)
The solver classifies a level by the **minimum planning power required** to reach the target,
and the generator only keeps a level whose class matches the requested tier.

- **Tier 1 — Easy:** a **greedy** player wins — each move just takes the highest-scoring
  immediate legal swap; no lookahead, no specials needed. 4 colors, roomy budget.
- **Tier 2 — Medium:** greedy **fails**, but a bounded search that **never creates or fires a
  special** still reaches the target — i.e. the level needs *planning / cascade-ordering with
  plain 3-matches*, not special candies. 5 colors, moderate budget.
- **Tier 3 — Hard:** the no-special bounded search **provably fails** (exhausted, not capped),
  yet the full search wins — reaching the target **requires creating and/or firing a special
  candy** (a match-4 stripe or match-5 color bomb) or an equivalently deep planned cascade.
  6 colors, lean budget.

Each tier is **necessary** (the cheaper technique is *proved* to fail — greedy
deterministically, the no-special search by exhaustion) and **sufficient** (the named plan is
exhibited as a concrete move sequence and re-certified by replay through the real rules).

## Features
Undo, moves-remaining + score + target, next-refill peek (per column), auto-save
(localStorage), solver-powered **hint** (next winning swap), per-difficulty stats + streak,
share summary, custom **win screen** and **lose screen**. PWA / Add to Home Screen.

## Correctness gate (before any UI) — `test/verify.js`, must run green
Asserts, against ground truth recomputed independently of the solver:
- match detection, gravity, refill, and cascade resolution are correct;
- **solver soundness** — every certified winning move sequence really reaches the target when
  replayed through the real rules;
- the difficulty class is **necessary** (greedy fails Tier-2/3; the no-special search fails
  Tier-3) and **sufficient** (the certified technique does reach the target);
- generator output matches the requested tier for 100% of a sample.

## Design gate (before any UI) — signed off by Ruta
`design-brief.md` (8 stages) + `design-moodboard.html` (2–3 directions) → Ruta picks a
direction + difficulty-name ladder; then `design-screens.html` (home w/ unique background +
win + lose) + `design-sound.html` (pick a sound set) → Ruta signs off.
