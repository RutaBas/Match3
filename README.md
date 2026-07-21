# Tide Pool 🫧

A **solver-gated match-3 puzzle** (a Candy Crush dupe) with a twist you won't find in the
original: every level is **proven winnable at its target difficulty by code that runs**, not by
eyeballing. Set in a dusk rockpool, you swap sea creatures — anemones, urchins, plankton — to
line up matches, dive **Depth** by **Depth**, and unlock the next only by clearing the current.

Vanilla HTML/CSS/JS, single-page, mobile-first for iPhone portrait, no backend, installable as a
PWA. Built to Ruta's puzzle-game playbook.

## How to play
- **Swap** two neighbouring creatures (tap one then an adjacent one, or swipe). A swap is only
  allowed if it makes a line of **3+** of the same kind.
- Matches clear and **score**; creatures above fall and refill, and new matches **cascade** for
  bonus combo points.
- Make a **4-in-a-row** for a **striped current** (clears a whole row/column); a **5-in-a-row**
  for a **pearl** (color bomb — clears every creature of one color).
- **Win** a Depth by reaching its **target score** before you run out of **moves**. Winning
  unlocks the next Depth. Earn up to **3 stars** for beating the target with room to spare.
- **Undo** takes back your last move; **Hint** (solver-powered) glows the next winning swap.
- **Shells 🐚** are earned by winning (more for stars, a Daily Dive bonus for your first win
  each day, and star-milestone payouts) and spent on boosters: the **Crab Claw** (pop any one
  creature), the **Rip Current** (reshuffle the board), and **Second Wind** (+5 moves when
  you'd otherwise wash out). Win streaks also earn **Tide's Favor** — free specials pre-placed
  at the start of your next dive (reset on a loss). Every level is still provably winnable
  without spending a single shell.

## The idea that makes it a puzzle, not a slot machine
Real Candy Crush refills candies **randomly**, so "is this level winnable?" is meaningless. Tide
Pool makes refills **deterministic** — each column carries a fixed queue of incoming creatures.
Given a start board and a move sequence, the whole game (cascades included) is fully
reproducible. That determinism is what lets a **solver search the move tree** and grade every
level, so the generator can ship only levels that are genuinely winnable at the intended
difficulty.

**Difficulty is graded by the minimum technique the solver needs** (not by feel), with
`Sg` = greedy best, `Sn` = best with specials forbidden, `Sf` = best with specials allowed:
- **Easy** — a greedy player (always take the highest-scoring immediate swap) reaches target.
- **Medium** — greedy provably fails, but planning with plain 3-matches + cascade ordering
  (no special candies) still reaches target.
- **Hard** — even the exhaustive no-special search falls short, so reaching target **requires**
  creating and/or firing a special (a striped current or a pearl).

Every level the generator emits is re-certified by the solver, and every winning line is
re-verified by replaying it through the real rules. See [SPEC.md](SPEC.md) for the full ruleset.

## Project structure
```
candy-crush/
├── index.html              # single page: home / game / win / lose screens
├── css/style.css           # Tide Pool "Kelp Forest" look (see design-brief.md)
├── js/
│   ├── game.js             # UI controller — DOM only ever reflects engine state
│   ├── sound.js            # "Marimba Tide" Web-Audio sounds (no asset files)
│   ├── hint-worker.js      # runs the solver off the main thread for hints
│   └── levels.js           # the pre-generated, pre-verified 24-Depth campaign
├── src/                    # the verified logic core (pure, no DOM, runs under Node)
│   ├── logic.js            # swap / match / gravity / refill / cascade / specials + scoring
│   ├── solver.js           # sound graded solver (+ replay-certified wins), powers hints
│   ├── generator.js        # solver-gated level generator
│   └── rng.js              # seeded RNG
├── scripts/build-levels.js # regenerates js/levels.js (the campaign) via the generator
├── test/verify.js          # the adversarial correctness harness
├── icons/                  # app icons + generate-icons.js
├── manifest.webmanifest    # PWA manifest (theme #17292A)
├── sw.js                   # service worker — offline app shell
├── SPEC.md                 # intake spec / ruleset
└── design-brief.md         # the signed-off 8-stage design
```
Logic is deliberately separate from the DOM, so the exact same solver that grades levels also
powers in-game hints.

## Run the tests (the correctness gate)
```bash
node test/verify.js          # must print "ALL CHECKS GREEN" and exit 0
```
It recomputes match detection, gravity, refill, cascade scoring and special candies from
independent ground truth, checks solver soundness by replaying certified wins through the real
rules, and confirms each generated Depth matches its requested tier.

## Regenerate / extend the campaign
```bash
node scripts/build-levels.js   # re-emits js/levels.js (24 Depths: 8 easy, 8 medium, 8 hard)
node icons/generate-icons.js   # re-emits the app icons
```

## Deploy & install on iPhone
1. Publish this folder to a static host (e.g. **Netlify** — drag-and-drop the `candy-crush`
   folder, or connect the GitHub repo). No build step is required.
2. On your iPhone, open the deployed URL in **Safari**.
3. Tap **Share → Add to Home Screen**. It installs as a full-screen offline app (Tide Pool
   icon, no browser chrome, safe-area aware).
