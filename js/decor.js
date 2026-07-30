/*
 * decor.js — the rockpool you decorate.
 *
 * WHY
 *   Shells only ever bought boosters, so a player who never uses boosters was
 *   earning a currency with nowhere to go — every win paid them in something
 *   they had no use for. Decor gives shells a second, permanent sink that costs
 *   the game nothing in balance: these are cosmetics on the home background, so
 *   no amount of buying makes a Depth easier, and the solver guarantee is
 *   untouched.
 *
 *   It also gives the home screen a reason to change. A map that looks identical
 *   at Depth 4 and Depth 200 quietly tells you nothing you did mattered.
 *
 * HOW
 *   Each piece is a bit of SVG drawn into the background layer, behind the map
 *   and in front of the water. They are placed at fixed spots either side of the
 *   trail so they frame the screen instead of competing with it, and they are
 *   drawn in the palette's own colours — silhouettes and soft glows, never a
 *   sticker on top of the scene.
 *
 *   Ownership lives in tp-decor. Buying is permanent; nothing here is
 *   consumable, because a currency sink you can accidentally waste is a worse
 *   deal than no sink at all.
 */
(function (root) {
  "use strict";

  var STORE = "tp-decor";

  function lsGet(k, fb) {
    try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : fb; }
    catch (e) { return fb; }
  }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

  // `items`  — everything you have bought. Permanent; buying is never undone.
  // `stored` — bought but currently taken OUT of the pool.
  //
  // Removal is a PLACEMENT toggle, not a sale. You paid for the piece, so it
  // stays yours and putting it back costs nothing; a refund would just invite
  // buy/sell churn, and charging again to re-place something you already own
  // would punish a player for rearranging. Tracking what is *stored* rather
  // than what is *placed* also means every existing save stays correct without
  // migration: nothing stored, so everything owned is in the pool, exactly as
  // it was before this existed.
  // MULTIPLES
  //   You can own and place several of the same piece — three anemone beds
  //   really do make a bed. Each copy needs its own spot, so every item carries
  //   an explicit list of SLOTS (position, size, and for a few of them a flip)
  //   rather than a random scatter: hand-placed copies sit where they look
  //   deliberate, and the slot list also caps how many of a thing the pool can
  //   hold, which stops a player spending 2,000 shells to bury the map in kelp.
  //
  //   State is two counts per item: how many you BOUGHT and how many are
  //   currently OUT in the pool. Buying is still permanent; taking one out just
  //   lowers the placed count.
  //
  //   Saves written before multiples existed used { items:[id], stored:[id] }.
  //   migrate() folds those into counts on load, so nobody loses a purchase.
  var owned = lsGet(STORE, {});
  migrate();
  function migrate() {
    if (!owned || typeof owned !== "object") owned = {};
    if (!owned.qty) {
      var qty = {}, placed = {};
      var items = Array.isArray(owned.items) ? owned.items : [];
      var stored = Array.isArray(owned.stored) ? owned.stored : [];
      for (var i = 0; i < items.length; i++) {
        qty[items[i]] = 1;
        placed[items[i]] = stored.indexOf(items[i]) >= 0 ? 0 : 1;
      }
      owned = { qty: qty, placed: placed };
      save();
    }
    if (!owned.placed) owned.placed = {};
  }
  function save() { lsSet(STORE, owned); }

  // ------------------------------------------------------------ lanternfish --
  // The one piece with real internal detail: a ribcage and a row of belly
  // photophores. Both are built in a loop rather than typed out, because they
  // are ~60 paths that only differ by a march along x — as a literal they would
  // be unreadable and impossible to re-tune.
  //
  // Two colours, not one. Everything else in the catalog is a single-colour
  // silhouette tinted by item.color, but a lanternfish that does not GLOW is
  // just a fish, so the bones and light organs carry their own pale aqua while
  // the body stays on currentColor.
  //
  // The ribs are clipped to the body outline instead of being length-matched to
  // it by hand: the profile is a bezier, so any per-rib length table would drift
  // out of true the moment the outline is nudged. The clip id is shared by every
  // copy on screen, which is safe only because all copies clip to the same path.
  //
  // Drawn nose-RIGHT on purpose. `facing: true` tells the renderer the art has a
  // front and mirrors it when the fish is travelling left; art drawn nose-left
  // would swim backwards half the time.
  var LANTERN = (function () {
    // Deepest just behind the head, then a long taper to a NARROW peduncle at
    // x=30. The waist is the whole silhouette: a body carried at full depth all
    // the way to the fin reads as a blimp with a tail stuck on it.
    var BODY = "M127 28 C121 17 112 11 97 9 C78 6 55 11 40 19 C36 21 33 23 30 25 " +
               "L30 32 C33 34 36 36 40 39 C55 47 78 51 97 48 C112 46 121 39 127 28 Z";
    var i, x, t, r;

    // Ribcage. These SWEEP — each rib leaves the spine and curves back toward
    // the tail, which is what makes it read as bone rather than as a grille.
    // An earlier pass ran them straight up and down at even spacing and the
    // fish looked like it was wearing a barcode.
    //
    // Every rib is drawn over-long and clipped to the outline rather than
    // length-matched to it by hand: the profile is a bezier, so any per-rib
    // length table would drift out of true the moment the outline is nudged.
    var ribs = "";
    for (i = 0; i < 13; i++) {
      x = 98 - i * 4.8;
      ribs += '<path d="M' + x.toFixed(1) + ' 26 Q' + (x - 4).toFixed(1) + ' 14 ' +
                (x - 11).toFixed(1) + ' 3"/>' +
              '<path d="M' + x.toFixed(1) + ' 30 Q' + (x - 4).toFixed(1) + ' 42 ' +
                (x - 11).toFixed(1) + ' 53"/>';
    }

    // Photophore row along the lateral line. The size wobble is a fixed pattern
    // rather than random: a decor piece has to look identical every time the
    // home screen redraws, or the pool appears to twitch on every render.
    var WOBBLE = [1, .5, .8, 1.5, .6, 1.3, .5, 1.1, .7, 1.4, .6, .9, 1.2, .5,
                  1, .7, 1.3, .5, .9, 1.1, .6, .8];
    var lamps = "", glow = "";
    for (i = 0; i < WOBBLE.length; i++) {
      x = 32 + i * 3.3;
      t = i / (WOBBLE.length - 1);
      r = (0.6 + 1.1 * t) * WOBBLE[i];
      glow  += '<circle cx="' + x.toFixed(1) + '" cy="28" r="' + (r * 2.2).toFixed(2) + '"/>';
      lamps += '<circle cx="' + x.toFixed(1) + '" cy="28" r="' + r.toFixed(2) + '"/>';
    }

    return '<svg viewBox="0 0 130 58">' +
      '<defs><clipPath id="tpLanternBody"><path d="' + BODY + '"/></clipPath></defs>' +
      // Fins first, so the body sits over their roots — a fin that starts at
      // the outline instead of under it reads as glued on. Kept faint: they are
      // the translucent part of the animal, and a solid fin out-weighs the glow.
      '<g fill="currentColor" opacity=".38">' +
        '<path d="M100 11 C96 1 86 -4 76 -2 C82 5 84 11 84 16 Z"/>' +     // dorsal
        '<path d="M54 16 C50 11 45 9 41 10 C44 13 45 16 45 19 Z"/>' +     // adipose
        '<path d="M31 28 L5 7 L17 28 L5 49 Z"/>' +                        // caudal
        '<path d="M92 42 C89 52 81 58 72 57 C77 51 79 46 80 41 Z"/>' +    // pectoral
        '<path d="M68 47 C66 54 60 58 54 57 C58 53 59 49 60 45 Z"/>' +    // pelvic
        '<path d="M50 44 C47 51 40 55 34 54 C39 50 41 46 42 42 Z"/>' +    // anal
      "</g>" +
      '<path d="' + BODY + '" fill="currentColor"/>' +
      '<g clip-path="url(#tpLanternBody)">' +
        // gill plate + a soft dorsal sheen, so the flank is not one flat slab
        '<path d="M97 4 C90 15 90 41 98 54 L130 54 L130 4 Z" fill="#ffffff" opacity=".06"/>' +
        '<path d="M30 20 C60 8 95 5 127 24 L127 8 L30 14 Z" fill="#ffffff" opacity=".05"/>' +
        '<g stroke="#7fe8d8" stroke-width="1.15" fill="none" stroke-linecap="round" ' +
          'opacity=".45">' + ribs + "</g>" +
        '<g fill="#8ff5e6" opacity=".16">' + glow + "</g>" +
        '<g fill="#c9fff7">' + lamps + "</g>" +
      "</g>" +
      // Eye and cheek photophores ride OUTSIDE the clip: they sit on the head,
      // where the outline is the thing they should read against.
      '<circle cx="110" cy="26" r="8" fill="#a5f7ea"/>' +
      '<circle cx="110" cy="26" r="4.1" fill="#0d2b2b"/>' +
      '<g fill="#bafff2">' +
        '<circle cx="99" cy="33" r="1.9"/><circle cx="102" cy="39" r="1.5"/>' +
        '<circle cx="96" cy="38" r="1.3"/><circle cx="100" cy="44" r="1.4"/>' +
        '<circle cx="94" cy="43" r="1.1"/>' +
      "</g></svg>";
  })();

  // side: which edge it hangs off, so pieces never stack on the same spot.
  // depth: paint order (lower is further back).
  var CATALOG = [
    {
      id: "anemones", name: "Anemone Bed", cost: 80, side: "left", depth: 1,
      blurb: "A cluster of beadlets, open and swaying.",
      svg: '<svg viewBox="0 0 90 60" preserveAspectRatio="none">' +
        '<g fill="currentColor">' +
        '<ellipse cx="18" cy="52" rx="13" ry="9"/><ellipse cx="45" cy="55" rx="16" ry="10"/>' +
        '<ellipse cx="72" cy="53" rx="11" ry="8"/>' +
        '<g stroke="currentColor" stroke-width="2.5" stroke-linecap="round" fill="none" opacity=".85">' +
        '<path d="M18 44 V32"/><path d="M11 45 L5 34"/><path d="M25 45 L31 34"/>' +
        '<path d="M45 45 V30"/><path d="M36 47 L29 35"/><path d="M54 47 L61 35"/>' +
        '<path d="M72 45 V34"/><path d="M65 46 L60 37"/><path d="M79 46 L84 37"/>' +
        "</g></g></svg>",
      w: 90, h: 60, color: "#c98f9a", opacity: 0.5,
      // Anemones are SESSILE — they cement a foot to rock and stay there for
      // life, so every copy has to meet the floor. An earlier pass spread them
      // up to 126px to declutter the sand and left two of them hanging in open
      // water, which is a thing an anemone cannot do.
      // Depth instead comes from the ground plane: the seabed band is 70px, so
      // a copy sitting a little higher AND smaller AND fainter reads as further
      // back along the sand rather than floating above it.
      slots: [ { side: "left",   x: 6,   bottom: 10, scale: 1 },
               { side: "right",  x: 7,   bottom: 38, scale: 0.7, flip: true },
               { side: "center", x: -38, bottom: 72, scale: 0.5 } ]
    },
    {
      id: "coral", name: "Coral Fan", cost: 120, side: "right", depth: 1,
      blurb: "Slow-grown, older than anyone who has seen it.",
      svg: '<svg viewBox="0 0 80 96" preserveAspectRatio="none">' +
        '<g stroke="currentColor" fill="none" stroke-width="3" stroke-linecap="round">' +
        '<path d="M40 96 V60"/><path d="M40 66 C28 58 22 46 20 30"/><path d="M40 66 C52 58 58 46 60 30"/>' +
        '<path d="M40 74 C32 68 26 60 22 50"/><path d="M40 74 C48 68 54 60 58 50"/>' +
        '<path d="M20 30 L14 18"/><path d="M20 30 L26 16"/><path d="M60 30 L54 16"/><path d="M60 30 L66 18"/>' +
        '<path d="M40 60 V34"/><path d="M40 40 L34 28"/><path d="M40 40 L46 28"/>' +
        "</g></svg>",
      w: 80, h: 96, color: "#c08466", opacity: 0.38,
      // The first fan used to sit at the very right edge, jammed against the
      // outermost kelp. Kelp occupies roughly 1%, 9% and 22% in from each side,
      // so 15% drops the fan into the gap between the second and third strands
      // instead of on top of them.
      // Coral is a colony cemented to the substrate — same rule as the anemones,
      // so all three fans keep their base on the sand and recede by size.
      slots: [ { side: "right",  x: 14, bottom: 18, scale: 0.85 },
               { side: "left",   x: 19, bottom: 48, scale: 0.6, flip: true },
               { side: "center", x: 44, bottom: 82, scale: 0.46 } ]
    },
    {
      id: "kelpgrove", name: "Kelp Grove", cost: 150, side: "left", depth: 3,
      blurb: "Three more strands, taller than the rest. Up to six groves.",
      svg: '<svg viewBox="0 0 60 240" preserveAspectRatio="none"><g fill="currentColor">' +
        '<path d="M12 240 C2 190 20 150 8 110 C0 76 16 54 12 8 C20 56 26 90 14 122 C26 158 6 196 12 240Z"/>' +
        '<path d="M32 240 C24 200 40 168 30 132 C22 104 36 84 32 46 C40 88 44 112 34 140 C44 172 26 208 32 240Z" opacity=".8"/>' +
        '<path d="M50 240 C44 206 56 180 48 152 C42 130 52 114 50 86 C56 118 59 136 51 158 C59 182 46 214 50 240Z" opacity=".6"/>' +
        "</g></svg>",
      // Kelp gets six slots rather than three: it is the one piece that reads as
      // a backdrop instead of an object, so a whole fringe of it looks right
      // where six of anything else would look like clutter. All six hug the left
      // and right edges and vary in height, so they frame the trail rather than
      // growing through it.
      // Rooted low like the default fringe. These were briefly raised to ~75px
      // to keep them clear of the sand; unnecessary once the sand stopped
      // painting over the kelp, and low is where they look right.
      w: 60, h: 240, color: "#2f6b5e", opacity: 0.62,
      slots: [ { side: "left",  x: 12, bottom: -2, scale: 1 },
               { side: "right", x: 9,  bottom: 0,  scale: 0.85, flip: true },
               { side: "left",  x: 24, bottom: -5, scale: 0.66 },
               { side: "right", x: 22, bottom: -3, scale: 0.74, flip: true },
               { side: "left",  x: 1,  bottom: 2,  scale: 0.58 },
               { side: "right", x: 1,  bottom: -6, scale: 0.62, flip: true } ]
    },
    {
      id: "starfish", name: "Starfish Pair", cost: 100, side: "right", depth: 2,
      blurb: "Both mid-way through regrowing an arm.",
      // Two fixes for "looks very 2D next to the moving kelp": it now has a
      // lighter inner star offset from the outline, which gives the arms some
      // roll instead of reading as a flat cut-out; and it SWAYS — a slow lean
      // against the current, the way something clamped to a rock actually moves.
      // Everything else in the pool was breathing and only this sat perfectly
      // still, which is what made it look pasted on.
      svg: '<svg viewBox="0 0 96 52"><g fill="currentColor">' +
        '<path d="M26 6 L32 22 L49 23 L36 33 L41 50 L26 40 L11 50 L16 33 L3 23 L20 22 Z"/>' +
        '<path d="M26 13 L30 23.5 L40 24 L32 30.5 L35 42 L26 35.5 L17 42 L20 30.5 L12 24 L22 23.5 Z" ' +
          'fill="#ffffff" opacity=".22"/>' +
        '<path d="M72 20 L76 32 L89 33 L79 40 L83 52 L72 45 L61 52 L65 40 L55 33 L68 32 Z" opacity=".72"/>' +
        '<path d="M72 25 L75 32.5 L83 33 L77 37.5 L79 46 L72 41.5 L65 46 L67 37.5 L61 33 L69 32.5 Z" ' +
          'fill="#ffffff" opacity=".16"/>' +
        "</g></svg>",
      w: 96, h: 52, color: "#cbb27a", opacity: 0.5, motion: "sway",
      // A starfish crawls, but it crawls ON something — with no rock face drawn
      // above the seabed, a starfish at 214px was floating just as plainly as
      // the anemones were. All three stay on the sand.
      slots: [ { side: "right",  x: 3,  bottom: 28, scale: 0.92 },
               { side: "left",   x: 2,  bottom: 56, scale: 0.7, flip: true },
               { side: "center", x: -6, bottom: 86, scale: 0.52 } ]
    },
    {
      id: "driftwood", name: "Driftwood", cost: 90, side: "left", depth: 2,
      blurb: "Came from a forest. Ended up here.",
      svg: '<svg viewBox="0 0 130 34" preserveAspectRatio="none"><g fill="currentColor">' +
        '<path d="M4 22 C30 12 60 26 92 16 C108 11 122 14 128 20 C120 26 106 24 92 26 C60 34 30 24 4 28 Z"/>' +
        '<path d="M40 20 L34 8" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>' +
        "</g></svg>",
      // Was #6b5540 at 0.5 opacity — a dark brown at half strength against a
      // dark teal floor, which is why it read as nothing. Lighter, warmer and
      // far more opaque; driftwood is meant to be the one hard-edged object down
      // there, so it should actually catch the eye.
      w: 140, h: 37, color: "#a8825c", opacity: 0.78,
      // driftwood is the one thing that belongs ON the sand, so it stays low
      slots: [ { side: "left",   x: 0,  bottom: 2,  scale: 0.92 },
               { side: "right",  x: 1,  bottom: 26, scale: 0.72, flip: true },
               { side: "center", x: 22, bottom: 60, scale: 0.55 } ]
    },
    {
      id: "shoal", name: "Passing Shoal", cost: 180, side: "right", depth: 4,
      blurb: "Little fish, always on their way somewhere else.",
      // Four fish per cluster, not eight: with five clusters available that is
      // still up to twenty fish, and a loose group of four reads as a shoal
      // where eight crammed into one box read as a shape.
      // `facing` tells the renderer this art has a front, so it is mirrored to
      // match its direction of travel instead of following slot.flip.
      svg: '<svg viewBox="0 0 96 44"><g fill="currentColor"><g transform="translate(12,14) scale(1)"><ellipse cx="8" cy="0" rx="8" ry="3.6"/><path d="M1 0 L-6.5 -4.6 L-4.4 0 L-6.5 4.6 Z"/></g><g transform="translate(44,7) scale(0.85)"><ellipse cx="8" cy="0" rx="8" ry="3.6"/><path d="M1 0 L-6.5 -4.6 L-4.4 0 L-6.5 4.6 Z"/></g><g transform="translate(38,30) scale(0.92)"><ellipse cx="8" cy="0" rx="8" ry="3.6"/><path d="M1 0 L-6.5 -4.6 L-4.4 0 L-6.5 4.6 Z"/></g><g transform="translate(72,22) scale(0.72)"><ellipse cx="8" cy="0" rx="8" ry="3.6"/><path d="M1 0 L-6.5 -4.6 L-4.4 0 L-6.5 4.6 Z"/></g></g></svg>',
      w: 104, h: 48, color: "#8fdcc8", opacity: 0.42, motion: "swim", facing: true,
      slots: [ { side: "right", x: 2,  bottom: 178, scale: 1 },
               { side: "left",  x: 3,  bottom: 268, scale: 0.8 },
               { side: "right", x: 4,  bottom: 348, scale: 0.66 },
               { side: "left",  x: 2,  bottom: 132, scale: 0.72 },
               { side: "right", x: 3,  bottom: 420, scale: 0.58 } ]
    },
    {
      id: "lanternfish", name: "Lanternfish", cost: 500, side: "left", depth: 4,
      blurb: "Carries its own light down where there is none.",
      svg: LANTERN,
      // 78x35 — the art was first drawn at 130x58, a step up from the shoal, and
      // at that size a single fish crowded the trail rather than passing behind
      // it. Scaled to 60%, so it now sits UNDER the shoal's 104x48: read as one
      // small deep-water fish a long way off, which is the right register for it.
      // The viewBox is untouched; only the box it draws into shrank.
      // Travels the same way — `swim`, a one-way crossing, with `facing` so it
      // is mirrored to match its direction rather than swimming tail-first.
      w: 78, h: 35, color: "#245c56", opacity: 0.72, motion: "swim", facing: true,
      // Fewer copies than the shoal. Four fish in a cluster read as one shoal,
      // but four lanternfish read as four lanternfish, and the whole point of
      // the piece is that it is the rare thing you see once on a crossing.
      slots: [ { side: "left",  x: 2, bottom: 232, scale: 1 },
               { side: "right", x: 3, bottom: 384, scale: 0.78 },
               { side: "left",  x: 4, bottom: 152, scale: 0.62 } ]
    },
    {
      id: "jelly", name: "Jelly Drift", cost: 200, side: "left", depth: 4,
      blurb: "No brain, no heart, no particular hurry.",
      svg: '<svg viewBox="0 0 70 96" preserveAspectRatio="none"><g fill="currentColor">' +
        '<path d="M35 6 C54 6 64 20 64 34 C64 42 56 44 35 44 C14 44 6 42 6 34 C6 20 16 6 35 6Z" opacity=".55"/>' +
        '<g stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" opacity=".45">' +
        '<path d="M18 44 C16 60 22 70 18 88"/><path d="M28 44 C26 62 32 74 28 92"/>' +
        '<path d="M42 44 C44 62 38 74 42 92"/><path d="M52 44 C54 60 48 70 52 88"/>' +
        "</g></g></svg>",
      // jellies ROAM — a long, wandering path across the pool rather than the
      // shoal's small sway. They pass behind the map, which is why the layer
      // sits under the content: a jelly crossing behind the trail looks like
      // water, while one crossing over it would look like a bug.
      w: 70, h: 96, color: "#9fb8e0", opacity: 0.4, motion: "roam",
      slots: [ { side: "left",  x: 4,  bottom: 210, scale: 1 },
               { side: "right", x: 8,  bottom: 300, scale: 0.72, flip: true },
               { side: "left",  x: 32, bottom: 380, scale: 0.55 } ]
    },
    {
      id: "plankton", name: "Glow Plankton", cost: 220, side: "full", depth: 5,
      blurb: "The pool lights up where you disturb it.",
      svg: "",
      // Five, not three: plankton is the only piece with no silhouette at all,
      // so extra copies just deepen the glow rather than adding another object
      // to look at. Each copy is another 14 motes.
      w: 0, h: 0, color: "#cbb27a", opacity: 1, sparkle: true,
      slots: [ { scale: 1 }, { scale: 1 }, { scale: 1 }, { scale: 1 }, { scale: 1 } ]
    }
  ];

  function catalog() { return CATALOG.slice(); }
  function itemById(id) {
    for (var i = 0; i < CATALOG.length; i++) if (CATALOG[i].id === id) return CATALOG[i];
    return null;
  }

  function maxOf(id) { var it = itemById(id); return it ? it.slots.length : 0; }
  function qtyOwned(id) { return owned.qty[id] || 0; }
  function qtyPlaced(id) { return Math.min(owned.placed[id] || 0, qtyOwned(id)); }
  function isOwned(id) { return qtyOwned(id) > 0; }
  function isPlaced(id) { return qtyPlaced(id) > 0; }
  function canBuyMore(id) { return qtyOwned(id) < maxOf(id); }
  function ownedCount() {
    var n = 0; for (var k in owned.qty) n += owned.qty[k]; return n;
  }
  function placedCount() {
    var n = 0; for (var k in owned.qty) n += qtyPlaced(k); return n;
  }
  // Slots for the copies currently out, in order. Slot i is a fixed spot, so a
  // pool looks the same every time it is drawn.
  function placedSlots(id) {
    var it = itemById(id);
    if (!it) return [];
    return it.slots.slice(0, qtyPlaced(id));
  }

  // Put one more copy out, or take one back in. Both clamp, so the UI can call
  // them freely without checking bounds first.
  function placeOne(id) {
    if (qtyPlaced(id) >= qtyOwned(id)) return false;
    owned.placed[id] = qtyPlaced(id) + 1;
    save();
    return true;
  }
  function removeOne(id) {
    if (qtyPlaced(id) <= 0) return false;
    owned.placed[id] = qtyPlaced(id) - 1;
    save();
    return true;
  }

  // Buying is handled by the caller (it owns the wallet); this only records it.
  // A newly bought copy goes straight into the pool — nobody buys scenery to
  // then have to place it.
  function grant(id) {
    if (!canBuyMore(id)) return false;
    owned.qty[id] = qtyOwned(id) + 1;
    owned.placed[id] = qtyPlaced(id) + 1;
    save();
    return true;
  }

  root.TideDecor = {
    catalog: catalog,
    itemById: itemById,
    maxOf: maxOf,
    qtyOwned: qtyOwned,
    qtyPlaced: qtyPlaced,
    isOwned: isOwned,
    isPlaced: isPlaced,
    canBuyMore: canBuyMore,
    placedSlots: placedSlots,
    placeOne: placeOne,
    removeOne: removeOne,
    ownedCount: ownedCount,
    placedCount: placedCount,
    grant: grant,
    total: function () { return CATALOG.length; }
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
