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

  // side: which edge it hangs off, so pieces never stack on the same spot.
  // depth: paint order (lower is further back).
  var CATALOG = [
    {
      id: "anemones", name: "Anemone Bed", cost: 80, side: "left", depth: 2,
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
      slots: [ { side: "left",  x: 2,  bottom: 42, scale: 1 },
               { side: "right", x: 4,  bottom: 30, scale: 0.78, flip: true },
               { side: "left",  x: 26, bottom: 16, scale: 0.62 } ]
    },
    {
      id: "coral", name: "Coral Fan", cost: 120, side: "right", depth: 2,
      blurb: "Slow-grown, older than anyone who has seen it.",
      svg: '<svg viewBox="0 0 80 96" preserveAspectRatio="none">' +
        '<g stroke="currentColor" fill="none" stroke-width="3" stroke-linecap="round">' +
        '<path d="M40 96 V60"/><path d="M40 66 C28 58 22 46 20 30"/><path d="M40 66 C52 58 58 46 60 30"/>' +
        '<path d="M40 74 C32 68 26 60 22 50"/><path d="M40 74 C48 68 54 60 58 50"/>' +
        '<path d="M20 30 L14 18"/><path d="M20 30 L26 16"/><path d="M60 30 L54 16"/><path d="M60 30 L66 18"/>' +
        '<path d="M40 60 V34"/><path d="M40 40 L34 28"/><path d="M40 40 L46 28"/>' +
        "</g></svg>",
      w: 80, h: 96, color: "#d08a6a", opacity: 0.42,
      slots: [ { side: "right", x: 3,  bottom: 40, scale: 1 },
               { side: "left",  x: 1,  bottom: 58, scale: 0.72, flip: true },
               { side: "right", x: 24, bottom: 24, scale: 0.55 } ]
    },
    {
      id: "kelpgrove", name: "Kelp Grove", cost: 150, side: "left", depth: 1,
      blurb: "Three more strands, taller than the rest.",
      svg: '<svg viewBox="0 0 60 240" preserveAspectRatio="none"><g fill="currentColor">' +
        '<path d="M12 240 C2 190 20 150 8 110 C0 76 16 54 12 8 C20 56 26 90 14 122 C26 158 6 196 12 240Z"/>' +
        '<path d="M32 240 C24 200 40 168 30 132 C22 104 36 84 32 46 C40 88 44 112 34 140 C44 172 26 208 32 240Z" opacity=".8"/>' +
        '<path d="M50 240 C44 206 56 180 48 152 C42 130 52 114 50 86 C56 118 59 136 51 158 C59 182 46 214 50 240Z" opacity=".6"/>' +
        "</g></svg>",
      w: 60, h: 240, color: "#2f6b5e", opacity: 0.55,
      slots: [ { side: "left",  x: 12, bottom: 0, scale: 1 },
               { side: "right", x: 9,  bottom: 0, scale: 0.85, flip: true },
               { side: "left",  x: 33, bottom: 0, scale: 0.66 } ]
    },
    {
      id: "starfish", name: "Starfish Pair", cost: 100, side: "right", depth: 3,
      blurb: "Both mid-way through regrowing an arm.",
      svg: '<svg viewBox="0 0 96 52" preserveAspectRatio="none"><g fill="currentColor">' +
        '<path d="M26 6 L32 22 L49 23 L36 33 L41 50 L26 40 L11 50 L16 33 L3 23 L20 22 Z"/>' +
        '<path d="M72 20 L76 32 L89 33 L79 40 L83 52 L72 45 L61 52 L65 40 L55 33 L68 32 Z" opacity=".72"/>' +
        "</g></svg>",
      w: 96, h: 52, color: "#cbb27a", opacity: 0.45,
      slots: [ { side: "right", x: 8,  bottom: 20, scale: 1 },
               { side: "left",  x: 14, bottom: 8,  scale: 0.8, flip: true },
               { side: "right", x: 34, bottom: 34, scale: 0.6 } ]
    },
    {
      id: "driftwood", name: "Driftwood", cost: 90, side: "left", depth: 3,
      blurb: "Came from a forest. Ended up here.",
      svg: '<svg viewBox="0 0 130 34" preserveAspectRatio="none"><g fill="currentColor">' +
        '<path d="M4 22 C30 12 60 26 92 16 C108 11 122 14 128 20 C120 26 106 24 92 26 C60 34 30 24 4 28 Z"/>' +
        '<path d="M40 20 L34 8" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>' +
        "</g></svg>",
      w: 130, h: 34, color: "#6b5540", opacity: 0.5,
      slots: [ { side: "left",  x: 0,  bottom: 14, scale: 1 },
               { side: "right", x: 2,  bottom: 4,  scale: 0.75, flip: true },
               { side: "left",  x: 30, bottom: 30, scale: 0.55 } ]
    },
    {
      id: "shoal", name: "Passing Shoal", cost: 180, side: "right", depth: 4,
      blurb: "They drift through and never quite leave.",
      svg: '<svg viewBox="0 0 120 70" preserveAspectRatio="none"><g fill="currentColor">' +
        '<path d="M10 14 l12 5 -12 5 3 -5z"/><path d="M34 6 l12 5 -12 5 3 -5z"/>' +
        '<path d="M56 20 l12 5 -12 5 3 -5z"/><path d="M28 30 l12 5 -12 5 3 -5z"/>' +
        '<path d="M74 38 l12 5 -12 5 3 -5z"/><path d="M48 46 l12 5 -12 5 3 -5z"/>' +
        '<path d="M88 12 l12 5 -12 5 3 -5z"/><path d="M18 54 l12 5 -12 5 3 -5z"/>' +
        "</g></svg>",
      w: 120, h: 70, color: "#7fd4c1", opacity: 0.34, drift: true,
      slots: [ { side: "right", x: 2,  bottom: 150, scale: 1 },
               { side: "left",  x: 3,  bottom: 250, scale: 0.75, flip: true },
               { side: "right", x: 30, bottom: 330, scale: 0.55 } ]
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
      w: 70, h: 96, color: "#9fb8e0", opacity: 0.4, drift: true,
      slots: [ { side: "left",  x: 4,  bottom: 210, scale: 1 },
               { side: "right", x: 8,  bottom: 300, scale: 0.72, flip: true },
               { side: "left",  x: 32, bottom: 380, scale: 0.55 } ]
    },
    {
      id: "plankton", name: "Glow Plankton", cost: 220, side: "full", depth: 5,
      blurb: "The pool lights up where you disturb it.",
      svg: "",
      w: 0, h: 0, color: "#cbb27a", opacity: 1, sparkle: true,
      slots: [ { scale: 1 }, { scale: 1 }, { scale: 1 } ]
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
