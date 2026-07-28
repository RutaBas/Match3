# Tide Pool 🫧

A **solver-gated match-3 puzzle** (a Candy Crush dupe) with a twist you won't find in the
original: every level is **proven winnable at its target difficulty by code that runs**, not by
eyeballing. Set in a dusk rockpool, you swap sea creatures — anemones, urchins, plankton — to
line up matches, dive **Depth** by **Depth** through a **250-Depth campaign**, and unlock the
next only by clearing the current.

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
- Some Depths ask for a **catch** instead of a score — *collect 20 anemones* — and are graded
  and starred in that currency. The win condition is the objective, not the points.
- If the pool ever runs out of legal swaps, the tide turns it over **free**: no move spent, no
  shells. Deadlock is never a paywall.
- Tapping a Depth on the map opens its **card**: what it asks for, your best result, and the
  exact score each star needs — so chasing a third star on an old Depth is an informed choice
  rather than a blind re-dive.
- Your **first ever dive is coached**: the board dims, the one swap that works glows, and two
  taps in you have made a match. No manual, no reading.
- Lose and the screen tells you **why**, not just by how much — "one more move like your best
  would have surfaced you", or, if the solver finds a win was still available on your last
  swap, "a different final swap would have got you there". It says nothing when no line
  existed, so the read is always true.
- Clearing certain Depths logs a species in your **field album** — 30 of them, from the
  periwinkle in the shallows to whatever is at the bottom of the trench, each with a one-line
  field note. Discovery is read straight from your cleared Depths, so the album is already
  filled in for a campaign you started long before it existed.
- Shells also buy **your rockpool**: anemone beds, a coral fan, drifting jellies, glowing
  plankton. Purely cosmetic, permanent, and the reason shells still matter to a player who
  never touches a booster. Buy up to **three of each** — a second and third anemone bed sit at
  their own spots, smaller and dimmer, so a stack reads as depth rather than duplicates. A
  stepper on each row sets how many are out; taking one in and putting it back is always free.
- The map is split into ten named **zones** — Shallows, Tide Line, Kelp Forest … The Abyss.
  Tap one to jump straight there; each chip shows the stars you've collected in that stretch,
  so you can see where you left stars behind without scrolling for them. A **Back to Depth N**
  pill returns you to where you were.
- **Undo** takes back your last move; **Hint** (solver-powered) glows the next winning swap.
- **Shells 🐚** are earned by winning (more for stars, star-milestone payouts, a **Daily Dive
  chest** that opens on your first visit each day and grows richer over a 7-day login streak,
  the **Daily Tide** — one board a day, identical for every player and recoloured so it is
  nobody's re-run, worth +100 plus +25 per day of streak — and
  the **Weekly Tide**: seven featured Depths, one rising each day Monday to Sunday, +60 shells
  each and **+400 for clearing all seven** before the week turns)
  and spent on boosters: the **Crab Claw** (pop any one
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

**The campaign rides a wave, not a ramp.** Depths 1–24 climb through the three tiers in order
(the original campaign). From Depth 25 the tiers repeat in a 10-Depth wave —
`E M H M H E M H M H` — so every ten Depths give you two easy exhales between the hard dives,
and no two hard Depths ever land back to back. A flat wall of hard levels is what players quit
on; the wave is the rhythm. Across all 250 Depths that lands at **54 easy / 98 medium /
98 hard**, and **34 of them ask for a catch instead of a score**.

**Objectives are graded the same way.** A collect Depth ("clear 20 anemones") is not a score
Depth with a label swapped: the solver measures *progress toward the objective* instead of
points, so greedy means "grab the most of that colour now", and the same three ceilings place
the goal inside the Depth's own tier band. The whole search is written against a scalar
progress metric, which is why a new objective type inherits the existing soundness proof rather
than needing a new one.

**The Trench is endless but not unverified.** Its rungs are generated *on the device* by this
same pipeline, in a Web Worker, and each one must certify its tier and replay its winning line
before the player ever sees it. Levels are certified minutes ahead and buffered, so the UI
never blocks on the solver.

Every level the generator emits is re-certified by the solver, and every winning line is
re-verified by replaying it through the real rules. See [SPEC.md](SPEC.md) for the full ruleset.

## Project structure
```
Tide-Pool/
├── index.html              # single page: home / game / win / lose screens
├── css/style.css           # Tide Pool "Kelp Forest" look (see design-brief.md)
├── js/
│   ├── game.js             # UI controller — DOM only ever reflects engine state
│   ├── sound.js            # "Marimba Tide" Web-Audio sounds (no asset files)
│   ├── hint-worker.js      # runs the solver off the main thread for hints
│   ├── economy.js          # shells, boosters, daily chest, Daily Tide, Weekly Tide
│   ├── album.js            # the 30-species field album (derived from cleared Depths)
│   ├── decor.js            # rockpool cosmetics: catalog, ownership, artwork
│   ├── endless.js          # The Trench: rung ramp + certified-level buffer
│   ├── endless-worker.js   # generates AND certifies Trench rungs off-thread
│   └── levels.js           # the pre-generated, pre-verified 250-Depth campaign
├── src/                    # the verified logic core (pure, no DOM, runs under Node)
│   ├── logic.js            # swap / match / gravity / refill / cascade / specials + scoring
│   ├── solver.js           # sound graded solver over a pluggable OBJECTIVE, powers hints
│   ├── generator.js        # solver-gated level generator
│   ├── transform.js        # structure-preserving recolouring (the Daily Tide)
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
node test/verify.js             # must print "ALL CHECKS GREEN" and exit 0
node test/verify-transform.js   # the Daily Tide recolouring really is an isomorphism
node scripts/selfcheck-phase3.js  # hand-counted urchin / combo fixtures
node scripts/reverify-campaign.js # all 250 Depths winnable at their own objective
```
It recomputes match detection, gravity, refill, cascade scoring and special candies from
independent ground truth, checks solver soundness by replaying certified wins through the real
rules, and confirms each generated Depth matches its requested tier.

## Regenerate / extend the campaign
```bash
# EXTEND the campaign — keeps Depths 1..(N-1) verbatim, generates the rest.
# This is the safe way to grow it, and how it went 100 -> 250:
node scripts/build-levels.js --count 250 --from 101

# A full rebuild is NOT idempotent. Depths 1-24 were certified pre-Phase-3, so
# rebuilding re-grades (and eases) them, and rebuilding 25+ discards any collect
# objectives. Prefer --from. See the header of scripts/build-levels.js.
node scripts/build-levels.js --count 250   # full rebuild — reads that warning first
node icons/generate-icons.js   # re-emits the app icons

# Give deep Depths COLLECT objectives (boards untouched; goals certified inside
# each Depth's own tier band). Easy slots are instant; hard slots take ~1 min each.
node scripts/add-objectives.js --depths 25,30,35 [--force]
```

## Deploy & install on iPhone
1. Publish this folder to a static host (e.g. **Netlify** — drag-and-drop the `Tide-Pool`
   folder, or connect the GitHub repo). No build step is required.
2. On your iPhone, open the deployed URL in **Safari**.
3. Tap **Share → Add to Home Screen**. It installs as a full-screen offline app (Tide Pool
   icon, no browser chrome, safe-area aware).
