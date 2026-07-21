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
  var START_BALANCE = 150;
  var MILESTONES = [10, 25, 50, 100, 150, 200, 300, 400, 500];
  var MILESTONE_BONUS = 100;
  // Daily Dive login chest: reward by consecutive-day index (1-based). After
  // day 7 the cycle restarts at day 1; a missed day also resets to day 1.
  var LOGIN_REWARDS = [20, 30, 45, 60, 80, 100, 150];
  var CHALLENGE_REWARD = 100;

  function lsGet(k, fb) {
    try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : fb; }
    catch (e) { return fb; }
  }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

  var wallet = Object.assign(
    { shells: START_BALANCE, milestonesClaimed: [] },
    lsGet("tp-wallet", {})
  );
  if (!Array.isArray(wallet.milestonesClaimed)) wallet.milestonesClaimed = [];
  function save() { lsSet("tp-wallet", wallet); }
  save(); // persist the starting balance on first run

  // Daily state (login chest + challenge), separate from the wallet.
  // epochDay is a LOCAL-midnight day number so "yesterday" means what players
  // expect regardless of timezone.
  var daily = Object.assign(
    { lastLoginDay: 0, streakDay: 0, lastChestDay: 0, challengeDay: 0, challengeClaimed: false },
    lsGet("tp-daily", {})
  );
  function saveDaily() { lsSet("tp-daily", daily); }

  function epochDay() {
    var now = new Date();
    return Math.floor((now.getTime() - now.getTimezoneOffset() * 60000) / 86400000);
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
  // { total, base, stars, milestones:[{at,bonus}] }
  // (The old first-win-of-the-day bonus moved to the visible login chest.)
  function awardWin(tier, starsEarned, totalStarsNow) {
    var base = WIN_BASE[tier] || WIN_BASE.easy;
    var starShells = STAR_BONUS * (starsEarned || 0);
    var hit = [];
    for (var i = 0; i < MILESTONES.length; i++) {
      var m = MILESTONES[i];
      if (totalStarsNow >= m && wallet.milestonesClaimed.indexOf(m) < 0) {
        wallet.milestonesClaimed.push(m);
        hit.push({ at: m, bonus: MILESTONE_BONUS });
      }
    }
    var total = base + starShells + hit.length * MILESTONE_BONUS;
    wallet.shells += total;
    save();
    return { total: total, base: base, stars: starShells, milestones: hit };
  }

  // ------------------------------------------------ Daily Dive login chest --
  // Call on app open. Advances the consecutive-day streak (missed day -> day 1;
  // day 7 completes the cycle and the next day starts a fresh cycle) and says
  // whether the chest should be shown. Claiming is separate (claimLoginChest).
  function checkDailyLogin() {
    var today = epochDay();
    if (daily.lastLoginDay !== today) {
      if (daily.lastLoginDay === today - 1) {
        daily.streakDay = (daily.streakDay % 7) + 1;   // consecutive: advance, wrap after 7
      } else {
        daily.streakDay = 1;                            // first ever, or missed a day
      }
      daily.lastLoginDay = today;
      saveDaily();
    }
    return {
      show: daily.lastChestDay !== today,
      dayIndex: daily.streakDay,
      reward: LOGIN_REWARDS[daily.streakDay - 1],
      rewards: LOGIN_REWARDS.slice()
    };
  }
  function claimLoginChest() {
    var today = epochDay();
    if (daily.lastChestDay === today) return null;      // already claimed
    daily.lastChestDay = today;
    var amount = LOGIN_REWARDS[(daily.streakDay || 1) - 1];
    wallet.shells += amount;
    save(); saveDaily();
    return { amount: amount, dayIndex: daily.streakDay };
  }

  // ------------------------------------------------------- Daily challenge --
  // One featured depth per day, identical for every player (derived from the
  // date). The goal is that depth's 3-star score — which the build pipeline
  // clamps to a PROVEN-reachable line, so every day's challenge is beatable.
  function dailyChallengeDepth(totalDepths) {
    var d = epochDay();
    return ((d * 2654435761) >>> 0) % totalDepths + 1;
  }
  function challengeState() {
    var today = epochDay();
    if (daily.challengeDay !== today) {
      daily.challengeDay = today;
      daily.challengeClaimed = false;
      saveDaily();
    }
    return { claimed: daily.challengeClaimed, reward: CHALLENGE_REWARD };
  }
  function claimChallenge() {
    var today = epochDay();
    if (daily.challengeDay === today && daily.challengeClaimed) return null;
    daily.challengeDay = today;
    daily.challengeClaimed = true;
    wallet.shells += CHALLENGE_REWARD;
    save(); saveDaily();
    return { amount: CHALLENGE_REWARD };
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
    streakGift: streakGift,
    checkDailyLogin: checkDailyLogin,
    claimLoginChest: claimLoginChest,
    dailyChallengeDepth: dailyChallengeDepth,
    challengeState: challengeState,
    claimChallenge: claimChallenge
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
