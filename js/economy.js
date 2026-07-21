/*
 * economy.js — the Tide Pool shell economy (Phase 2).
 *
 * One currency: SHELLS (🐚). No inventory — boosters are bought at the moment
 * of use, streak gifts are free and automatic. All state in localStorage
 * ("tp-wallet"); progress ("tp-progress") is never touched here.
 *
 *   Earning                                   Spending
 *   ------------------------------------      --------------------------------
 *   win: easy 20 / medium 30 / hard 40        Crab Claw (pop one creature)  60
 *   + 10 per star earned                      Rip Current (reshuffle)       40
 *   first win each day ("Daily Dive")  +50    Second Wind (+5 moves rescue) 100
 *   star milestones (10/25/50/100/...) +100
 *   new players start with                150
 *
 * Streak gift ("Tide's Favor", free, applied at level start, resets on a loss):
 *   1 win  -> 1 striped current pre-placed
 *   2 wins -> 2 striped currents
 *   3+     -> 2 striped currents + 1 pearl (color bomb)
 *
 * Every level remains solver-certified winnable WITHOUT any booster; boosters
 * only ever help, so the correctness guarantee is untouched.
 */
(function (root) {
  "use strict";

  var COSTS = { claw: 60, current: 40, rescue: 100 };
  var WIN_BASE = { easy: 20, medium: 30, hard: 40 };
  var STAR_BONUS = 10;
  var DAILY_BONUS = 50;
  var START_BALANCE = 150;
  var MILESTONES = [10, 25, 50, 100, 150, 200, 300, 400, 500];
  var MILESTONE_BONUS = 100;

  function lsGet(k, fb) {
    try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : fb; }
    catch (e) { return fb; }
  }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

  var wallet = Object.assign(
    { shells: START_BALANCE, lastDailyDay: "", milestonesClaimed: [] },
    lsGet("tp-wallet", {})
  );
  if (!Array.isArray(wallet.milestonesClaimed)) wallet.milestonesClaimed = [];
  function save() { lsSet("tp-wallet", wallet); }
  save(); // persist the starting balance on first run

  function today() {
    var d = new Date();
    return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate();
  }

  function balance() { return wallet.shells; }

  function canAfford(what) { return wallet.shells >= COSTS[what]; }

  // Spend for a booster. Returns true if paid.
  function spend(what) {
    var cost = COSTS[what];
    if (cost === undefined || wallet.shells < cost) return false;
    wallet.shells -= cost;
    save();
    return true;
  }

  // Return a booster's cost (e.g. a Rip Current that couldn't produce a valid
  // shuffle refunds itself).
  function refund(what) {
    var cost = COSTS[what];
    if (cost === undefined) return;
    wallet.shells += cost;
    save();
  }

  // Award shells for a win. Returns a breakdown for the win screen:
  // { total, base, stars, daily, milestones:[{at,bonus}] }
  function awardWin(tier, starsEarned, totalStarsNow) {
    var base = WIN_BASE[tier] || WIN_BASE.easy;
    var starShells = STAR_BONUS * (starsEarned || 0);
    var daily = 0;
    var t = today();
    if (wallet.lastDailyDay !== t) { daily = DAILY_BONUS; wallet.lastDailyDay = t; }
    var hit = [];
    for (var i = 0; i < MILESTONES.length; i++) {
      var m = MILESTONES[i];
      if (totalStarsNow >= m && wallet.milestonesClaimed.indexOf(m) < 0) {
        wallet.milestonesClaimed.push(m);
        hit.push({ at: m, bonus: MILESTONE_BONUS });
      }
    }
    var total = base + starShells + daily + hit.length * MILESTONE_BONUS;
    wallet.shells += total;
    save();
    return { total: total, base: base, stars: starShells, daily: daily, milestones: hit };
  }

  // Tide's Favor: what the current win streak grants at level start.
  // Returns a list of kinds to pre-place: 'stripe' | 'bomb'.
  function streakGift(streak) {
    if (streak >= 3) return ["stripe", "stripe", "bomb"];
    if (streak === 2) return ["stripe", "stripe"];
    if (streak === 1) return ["stripe"];
    return [];
  }

  root.TideEconomy = {
    COSTS: COSTS,
    balance: balance,
    canAfford: canAfford,
    spend: spend,
    refund: refund,
    awardWin: awardWin,
    streakGift: streakGift
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
