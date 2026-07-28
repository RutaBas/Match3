/*
 * album.js — the field album: a species logged for Depths you have cleared.
 *
 * WHY IT IS DERIVED, NOT STORED
 *   Discovery is a pure function of which Depths you have cleared, which the
 *   game already records in tp-progress.stars. Nothing new is persisted, there
 *   is no migration, and a player who is already at Depth 180 opens the album to
 *   find their whole history of dives waiting for them rather than an empty book
 *   that only starts counting from today. It also cannot desync from progress,
 *   because it IS progress, read a different way.
 *
 * SPREAD
 *   30 species across 250 Depths — roughly one every eight or nine dives, and
 *   deliberately front-loaded (the first few come quickly, so the album shows
 *   its shape early), thinning out as the campaign goes on. Species descend with
 *   the campaign: rockpool creatures at the top, abyssal ones at the bottom,
 *   matching the zone names on the map.
 *
 *   Field notes are one line each and true-ish to the real animal — the joke, if
 *   there is one, is in the last few words rather than the whole entry.
 */
(function (root) {
  "use strict";

  // { at: unlocking Depth, icon, name, note }
  var SPECIES = [
    { at: 1,   icon: "🐚", name: "Periwinkle",        note: "Grazes the shallows at its own unhurried pace. Has nowhere to be." },
    { at: 3,   icon: "🦀", name: "Shore Crab",        note: "Sideways is a perfectly good direction if you commit to it." },
    { at: 6,   icon: "🪸", name: "Beadlet Anemone",   note: "Closes into a sulking blob at low tide, blooms again when covered." },
    { at: 10,  icon: "🐌", name: "Limpet",            note: "Returns to the exact same scar on the rock after every feed." },
    { at: 15,  icon: "⭐", name: "Common Starfish",   note: "Can regrow a lost arm. Takes its time about it." },
    { at: 21,  icon: "🦐", name: "Rockpool Shrimp",   note: "Nearly invisible until it moves, then instantly regrets moving." },
    { at: 28,  icon: "🐟", name: "Rock Goby",         note: "Wedges itself under a stone and dares the tide to try." },
    { at: 36,  icon: "🪼", name: "Moon Jelly",        note: "No brain, no heart, no bones. Four hundred million years of that working fine." },
    { at: 45,  icon: "🦑", name: "Bobtail Squid",     note: "Farms glowing bacteria in its skin to erase its own shadow." },
    { at: 55,  icon: "🐙", name: "Common Octopus",    note: "Solves the puzzle, then dismantles the puzzle out of spite." },
    { at: 66,  icon: "🦞", name: "Spiny Lobster",     note: "Marches in single file across open sand, each holding the one ahead." },
    { at: 78,  icon: "🐠", name: "Wrasse",            note: "Runs a cleaning station. Customers queue politely." },
    { at: 90,  icon: "🪱", name: "Feather Duster",    note: "A worm wearing a spectacular hat. Retracts if you admire it too loudly." },
    { at: 100, icon: "🐡", name: "Pufferfish",        note: "Its entire defence is becoming briefly inconvenient to swallow." },
    { at: 110, icon: "🦈", name: "Dogfish",           note: "A small shark with the patience of a much larger one." },
    { at: 120, icon: "🐢", name: "Green Turtle",      note: "Navigates by magnetic field back to the beach it hatched on." },
    { at: 130, icon: "🦭", name: "Grey Seal",         note: "Sleeps upright underwater, bobbing like a bottle. Wakes to breathe." },
    { at: 140, icon: "🦀", name: "Yeti Crab",         note: "Grows bacteria on its furry arms and eats them. A crab with a garden." },
    { at: 150, icon: "🐋", name: "Sperm Whale",       note: "Dives a kilometre on one breath to argue with squid in the dark." },
    { at: 160, icon: "🦑", name: "Vampire Squid",     note: "Neither vampire nor squid. Eats marine snow and minds its business." },
    { at: 170, icon: "🐟", name: "Lanternfish",       note: "The most numerous vertebrate on Earth, and nobody has ever seen one." },
    { at: 180, icon: "🪸", name: "Bubblegum Coral",   note: "Grows a centimetre a decade. Older than the boat above it." },
    { at: 190, icon: "🦐", name: "Vent Shrimp",       note: "Blind, and swarming water hot enough to cook it. Reads heat instead." },
    { at: 200, icon: "🐙", name: "Dumbo Octopus",     note: "Flaps two small ears through the cold and asks nothing of anyone." },
    { at: 210, icon: "🎣", name: "Anglerfish",        note: "Carries her own lamp. The males fuse on and become spare parts." },
    { at: 220, icon: "🪼", name: "Benthic Comb Jelly", note: "Refracts every colour it does not possess. Pure theatre, no pigment." },
    { at: 230, icon: "🦴", name: "Bone-Eater Worm",   note: "Has no mouth and no gut. Dissolves whale bone and lives off the seep." },
    { at: 238, icon: "👻", name: "Ghost Shark",       note: "Senses electric fields with a face full of pores. Older than trees." },
    { at: 244, icon: "🕷️", name: "Sea Spider",        note: "Pumps blood with its gut because it never grew a proper heart." },
    { at: 250, icon: "🕳️", name: "The Trench Itself", note: "Nothing lives here that you have seen. Something lives here." }
  ];

  function speciesList() { return SPECIES.slice(); }

  // A species is logged once its Depth has been CLEARED (any star count).
  function discovered(stars) {
    var out = [];
    for (var i = 0; i < SPECIES.length; i++) {
      if (stars && stars[SPECIES[i].at]) out.push(SPECIES[i]);
    }
    return out;
  }
  function countFound(stars) { return discovered(stars).length; }
  function total() { return SPECIES.length; }

  // The species a given Depth logs, or null. Used by the win screen to announce
  // a find in the moment it happens.
  function speciesAt(depth) {
    for (var i = 0; i < SPECIES.length; i++) {
      if (SPECIES[i].at === depth) return SPECIES[i];
    }
    return null;
  }
  // The next one still to find, for the "N to go" line.
  function nextAfter(stars) {
    for (var i = 0; i < SPECIES.length; i++) {
      if (!(stars && stars[SPECIES[i].at])) return SPECIES[i];
    }
    return null;
  }

  root.TideAlbum = {
    speciesList: speciesList,
    discovered: discovered,
    countFound: countFound,
    total: total,
    speciesAt: speciesAt,
    nextAfter: nextAfter
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
