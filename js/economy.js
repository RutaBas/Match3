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
 *   Weekly Tide slot (7/week)          +60
 *   Weekly Tide, all seven cleared    +400
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
  // A 250-Depth campaign is worth up to 750 stars, so the ladder runs that far;
  // stopping at 500 would silently retire the reward two thirds of the way in.
  var MILESTONES = [10, 25, 50, 100, 150, 200, 300, 400, 500, 600, 700, 750];
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
    { lastLoginDay: 0, streakDay: 0, lastChestDay: 0, challengeDay: 0, challengeClaimed: false,
      challengeStreak: 0, lastChallengeWin: -1 },
    lsGet("tp-daily", {})
  );
  function saveDaily() { lsSet("tp-daily", daily); }

  function epochDay() {
    var now = new Date();
    return Math.floor((now.getTime() - now.getTimezoneOffset() * 60000) / 86400000);
  }
  // Tide number shown to the player — "Tide #412" — counted from launch day so
  // it reads like an issue number rather than a raw epoch figure.
  var TIDE_EPOCH = 20600;              // 2026-05-27
  function tideNumber() { return epochDay() - TIDE_EPOCH; }

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

  // Spend an arbitrary amount (rockpool decor, which is priced per item rather
  // than by a fixed booster name). Returns true if paid.
  function spendShells(amount) {
    if (!(amount > 0) || wallet.shells < amount) return false;
    wallet.shells -= amount;
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
      // A day passed without clearing yesterday's tide breaks the streak. This
      // is evaluated lazily on read, so the streak is correct even if the app
      // was closed for a week.
      if (daily.lastChallengeWin !== today - 1) daily.challengeStreak = 0;
      daily.challengeDay = today;
      daily.challengeClaimed = false;
      saveDaily();
    }
    return {
      claimed: daily.challengeClaimed,
      reward: CHALLENGE_REWARD,
      streak: daily.challengeStreak || 0,
      // the streak bonus rewards showing up, and is what makes a Daily Tide
      // worth defending rather than a one-off
      streakBonus: streakBonusFor((daily.challengeStreak || 0) + 1),
      day: today
    };
  }
  // +25 per consecutive day beyond the first, capped at +200 (day 9 onward).
  function streakBonusFor(streakAfterWin) {
    return Math.min(200, Math.max(0, (streakAfterWin - 1) * 25));
  }
  function claimChallenge() {
    var today = epochDay();
    if (daily.challengeDay === today && daily.challengeClaimed) return null;
    if (daily.lastChallengeWin !== today - 1) daily.challengeStreak = 0;
    daily.challengeStreak = (daily.challengeStreak || 0) + 1;
    daily.lastChallengeWin = today;
    daily.challengeDay = today;
    daily.challengeClaimed = true;
    var bonus = streakBonusFor(daily.challengeStreak);
    wallet.shells += CHALLENGE_REWARD + bonus;
    save(); saveDaily();
    return { amount: CHALLENGE_REWARD + bonus, base: CHALLENGE_REWARD,
             bonus: bonus, streak: daily.challengeStreak };
  }

  // ----------------------------------------------------------- Weekly Tide --
  // Seven date-seeded Depths, Monday through Sunday, identical for every player.
  // Slot i unlocks on day i of the week and STAYS open for the rest of the week,
  // so missing Tuesday doesn't cost you Tuesday's tide — it just waits. Each slot
  // is played at its Depth's normal win target (not the 3-star bar the Daily
  // Challenge uses), so a Weekly slot is a dive you can actually finish; the
  // reward for the week is completion, not perfection. Clearing all seven pays
  // the WEEKLY_BONUS on top.
  //
  // Slots ramp in depth across the week: slot i draws from the i-th seventh of
  // the campaign, so Monday is shallow and Sunday is deep.
  var WEEKLY_SLOT_REWARD = 60;
  var WEEKLY_BONUS = 400;
  var DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

  var weekly = Object.assign(
    { week: -1, done: [], bonusClaimed: false },
    lsGet("tp-weekly", {})
  );
  if (!Array.isArray(weekly.done)) weekly.done = [];
  function saveWeekly() { lsSet("tp-weekly", weekly); }

  // epochDay 0 (1970-01-01) was a Thursday, so +3 puts Monday at index 0.
  function dayOfWeek() { return (epochDay() + 3) % 7; }
  function weekIndex() { return Math.floor((epochDay() + 3) / 7); }

  function hash32(x) { return ((x * 2654435761) >>> 0); }

  // The seven Depths for a given week, shallow -> deep.
  function weeklyDepths(totalDepths, wk) {
    var out = [];
    for (var i = 0; i < 7; i++) {
      var lo = Math.floor(i * totalDepths / 7);          // 0-based band start
      var hi = Math.floor((i + 1) * totalDepths / 7);    // exclusive
      if (hi <= lo) hi = lo + 1;
      var span = hi - lo;
      out.push(lo + (hash32(wk * 7 + i + 1) % span) + 1); // -> 1-based depth
    }
    return out;
  }

  // Roll the week over if needed, then describe it.
  function weeklyState(totalDepths) {
    var wk = weekIndex();
    if (weekly.week !== wk) {
      weekly.week = wk;
      weekly.done = [false, false, false, false, false, false, false];
      weekly.bonusClaimed = false;
      saveWeekly();
    }
    while (weekly.done.length < 7) weekly.done.push(false);
    var today = dayOfWeek();
    var depths = weeklyDepths(totalDepths, wk);
    var slots = [];
    var doneCount = 0;
    for (var i = 0; i < 7; i++) {
      if (weekly.done[i]) doneCount++;
      slots.push({
        index: i,
        day: DAY_NAMES[i],
        depth: depths[i],
        done: !!weekly.done[i],
        unlocked: i <= today,
        isToday: i === today
      });
    }
    return {
      week: wk,
      today: today,
      slots: slots,
      doneCount: doneCount,
      complete: doneCount >= 7,
      bonusClaimed: !!weekly.bonusClaimed,
      slotReward: WEEKLY_SLOT_REWARD,
      bonus: WEEKLY_BONUS
    };
  }

  // Clear a slot. Returns the payout breakdown, or null if it was already done
  // (replays are for glory — a slot only ever pays once).
  //   { slot, bonus, total, complete }
  function completeWeeklySlot(i, totalDepths) {
    weeklyState(totalDepths);                   // roll over / normalise first
    if (i < 0 || i > 6 || weekly.done[i]) return null;
    weekly.done[i] = true;
    var slot = WEEKLY_SLOT_REWARD;
    var bonus = 0;
    var all = weekly.done.every(function (d) { return d; });
    if (all && !weekly.bonusClaimed) { weekly.bonusClaimed = true; bonus = WEEKLY_BONUS; }
    wallet.shells += slot + bonus;
    save(); saveWeekly();
    return { slot: slot, bonus: bonus, total: slot + bonus, complete: all };
  }

  // The Trench pays by how deep you got, so a run that ends is still worth
  // something. Deliberately modest: the Trench is endless, and an endless faucet
  // would make every other shell source pointless.
  function awardTrench(amount) {
    wallet.shells += amount;
    save();
    return amount;
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
    spendShells: spendShells,
    refund: refund,
    awardWin: awardWin,
    streakGift: streakGift,
    checkDailyLogin: checkDailyLogin,
    claimLoginChest: claimLoginChest,
    epochDay: epochDay,
    tideNumber: tideNumber,
    dailyChallengeDepth: dailyChallengeDepth,
    challengeState: challengeState,
    claimChallenge: claimChallenge,
    weeklyState: weeklyState,
    completeWeeklySlot: completeWeeklySlot,
    awardTrench: awardTrench
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
