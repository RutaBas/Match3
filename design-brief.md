# Tide Pool (Candy Crush dupe) — Design Brief (game-design-elements, 8 stages)

**Signed-off direction (Round 1):** World = **Tide Pool** · Palette = **Kelp Forest** ·
Levels called **"Depth"** (Depth 1, Depth 2…) · Structure = **level campaign** (unlock the
next Depth by winning the current; progress saved on-device). Standing prefs honored: muted
colors, unique per-game sounds, playable moodboard previews.

Round 2 (screens + sound) is in `design-screens.html` + `design-sound.html`; final sign-off
pending. This brief is the source of truth the UI is built from.

---

## Stage 1 — Concept anchor
**Tide Pool feels like a rockpool at dusk — anemones, urchins and plankton that retract and
glow when you disturb them.** Every choice below answers "because it's a living rockpool":
creatures not candies, bioluminescent glow not gloss, watery motion not bounce, a descent
through deepening pools not a difficulty menu.

## Stage 2 — Color (Kelp Forest, muted, text contrast ≥ AA 4.5:1)
| Role | Hex | Note |
|------|-----|------|
| Background neutral | `#17292A` deep teal-green | never pure black; the water |
| Board/well | `#0F1F1F` darker | the pool floor, recedes behind creatures |
| Dominant surface | `#1E3536` panel | HUD/cards, a shade up from bg |
| Accent (tappable/glow) | `#5BB6A6` aqua | selection ring, buttons, progress |
| Secondary (hint / complete / win gold) | `#CBB27A` warm sand-gold | hint pulse, win |
| Text | `#E1E9DF` on `#17292A` = 10.4:1 | secondary text `#9FB4B1` (4.9:1) |

**Creature (tile) colors** — distinguished by hue *and* value *and* an emblem shape (never
hue alone; colorblind-safe):
- 4 (early Depths): ochre-kelp `#B79A56` · olive `#6E8556` · rust-anemone `#A85E4E` · aqua `#5BB6A6`
- +5th (mid): urchin-plum `#7A5A78`
- +6th (deep): seafoam-blue `#8FB0C0`
Emblems: anemone (flower), shell, urchin (spiky star), plankton (ringed circle), plus scallop
& barnacle for 5th/6th. Specials: **striped** = a creature with a directional *current*
streak; **color bomb** = a glowing **pearl**.

## Stage 3 — Typography (Google Fonts)
- **Heading — Quicksand** (600/700): soft, rounded, aquatic; the rockpool's calm.
- **Body / HUD — Nunito Sans** (400/600/700), tabular numerals for score & moves.
No system-sans default.

## Stage 4 — Spacing & depth
- Scale **4 / 8 / 16 / 24 / 32**. Tiles ~48–52px at 390px width (≥44px tap targets).
- **One material — "wet glow pebble":** each creature is a soft-cornered blob
  (`border-radius:46% 54% 50% 50%`) with an inner top highlight and a soft outer **glow in
  its own hue** on the dark water. Selected = brighter glow + aqua ring. **Pressed = scale
  0.96, glow dims.** Board sits in a subtly inset well.

## Stage 5 — Motion language — **smooth & watery**
- Easing: select/settle `cubic-bezier(.34,1.3,.6,1)` (a gentle overshoot, like buoyancy);
  falls ease-in then settle. Durations ~180–420ms.
- Touchpoints: tile select (glow up), swap (two creatures glide past each other), **illegal
  swap** (they nudge together then recoil — a soft wobble, no clear), match (creatures
  **retract** then **pop** in a small bloom), gravity fall (buoyant drop), cascade (staggered,
  rising pitch), special-form (a bright current-glint / pearl shimmer), screen transitions
  (a soft ripple/fade), win/lose.

## Stage 6 — Feedback & juice (proportional; full celebration reserved for the win)
| Moment | Feedback |
|--------|----------|
| Select / swap | glow-up + soft "bloop", 8ms haptic |
| Illegal swap | recoil wobble + dull "nope", no score/haptic |
| Match clear | retract→bloom, brief glow-flash, tick per creature; cascade raises pitch |
| Special formed | current-glint (stripe) / pearl-shimmer (bomb) + distinct chime |
| **Depth complete (WIN)** | **full celebration**: bioluminescent ripple + plankton particle
  bloom in creature colors + score count-up to gold + win chord + long haptic — the payoff |
| Out of moves (LOSE) | gentle desaturate + soft receding "gulp" tone + restat panel; kind, never harsh |
Sounds synthesized with Web Audio (no asset files). `design-sound.html` offers 2–3 distinct
**watery** sets unique to this game; the pick is recorded below.

## Stage 7 — Screens & layout
- **Home / level-map** (above the fold @390px): title "TIDE POOL", one primary **Play/Continue**
  (jumps to the next unbeaten Depth), and a **Depth map** — a vertical descending trail of Depth
  nodes (locked/unlocked/cleared, star ratings), scrollable. On a **unique animated background**:
  a **kelp-forest scene** — swaying kelp-frond silhouettes, drifting particulate/bubbles, dappled
  light from above, deepening color toward the bottom. NOT a flat fill.
- **In-game HUD** (minimal, board dominant): top bar = Depth number, score→target **progress
  bar** (aqua), moves remaining. Small **Undo** + **Hint** controls. Chrome recedes into the water.
- **Win screen ("Surfaced"):** final score vs target, moves used, **stars**, streak, **Share**,
  **Next Depth** / Replay. Most-polished screen; full celebration.
- **Lose screen ("Washed out"):** score-vs-target, encouraging line, **Retry** / level-map.
  (This game can be lost — real lose screen required.)

## Stage 8 — App-store-level extras
Manifest: real **pearl/tide app icon**, theme color `#17292A`, splash to match. iOS meta tags +
safe-area insets (notch/home-bar). Block pull-to-refresh & text-selection on the board. Offline
play via service worker (app shell). First-launch "how to play" (swap two neighbours to line up
3+; make 4 for a current, 5 for a pearl) that returning players skip.

---

## SIGN-OFF
- Direction / palette / level word: **Tide Pool · Kelp Forest · Depth** ✅ (Round 1)
- Structure: **level campaign, unlock-next-by-winning** ✅
- **DESIGN GATE FULLY SIGNED OFF** (all screens confirmed, build approved).
- Confirmed home background: animated Kelp Forest — **enriched** per feedback: layered water
  gradient + seabed + caustic light, denser swaying kelp, scattered background sea-life, a
  flowing "current" connector trail through the Depth nodes (cleared nodes show a creature +
  stars, the next glows "GO", locked dim), and a stats header (⭐ stars · 🌊 best Depth · 🔥 streak).
- Win / lose screens: "Surfaced" / "Washed out". **Tweaks applied:** win screen ghost button
  is **"Map"** (returns to home / Depth map, matching the lose screen's Map); **"Next Depth"**
  primary button has **no arrow**.
- Chosen sound set: **3 · Marimba Tide** (warm wooden marimba plinks) ✅
- **Depth-map node design (final):** each pool is a circle with the **level number inside**
  (no "Depth" word inside the circle); **star pips arced across the top** of the ring show
  stars earned (1–3 small gold dots); the next unbeaten pool glows aqua + pulses; locked pools
  are dim; a glowing aqua dashed "current" line connects them top-to-bottom. In the real UI the
  map auto-scrolls to the current Depth. See `design-screens.html` for the exact treatment.

**How to apply in the UI build:** both "Map" buttons and the lose "Map" navigate to the home
Depth-map screen; "Next Depth" advances to the next unlocked Depth; "Retry Depth" reloads the
current level; the home stats header reads from localStorage (total stars, highest Depth
reached, current win streak).
