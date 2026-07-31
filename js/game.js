/*
 * game.js — Tide Pool UI / DOM controller.
 *
 * ALL match-3 rules live in the verified engine (src/logic.js, solver.js) and
 * are consumed through the window.Candy* globals. This file holds ZERO rules:
 *   - every swap outcome is logic.applyMove(board, refill, pointers, move)
 *   - every hint is solver.hint(subLevel)  (run in a Web Worker)
 *   - the campaign is the pre-verified, pre-generated window.CANDY_LEVELS
 * The DOM only ever reflects engine state. Design + sounds follow the signed-off
 * brief (design-brief.md / design-screens.html / design-sound.html).
 */
(function () {
  "use strict";

  var L = window.CandyLogic;
  var SOLVER = window.CandySolver;
  var LEVELS = window.CANDY_LEVELS || [];
  var SND = window.TideSound;
  var ECON = window.TideEconomy;
  var TOTAL = LEVELS.length;

  // creature palette, 1-indexed to match engine color ids
  var HUE = [null, "#B79A56", "#6E8556", "#A85E4E", "#5BB6A6", "#7A5A78", "#8FB0C0"];
  // colorblind-safe emblems (hue + value + shape). inner SVG markup, viewBox 24.
  var EMBLEM = [null,
    // 1 anemone (flower)
    '<g fill="rgba(255,255,255,.42)"><circle cx="12" cy="6" r="3"/><circle cx="18" cy="10" r="3"/><circle cx="15.5" cy="17" r="3"/><circle cx="8.5" cy="17" r="3"/><circle cx="6" cy="10" r="3"/></g><circle cx="12" cy="12" r="3.1" fill="rgba(255,255,255,.72)"/>',
    // 2 shell (ridged fan)
    '<path d="M12 20 C5 20 4 9 12 5 C20 9 19 20 12 20Z" fill="rgba(255,255,255,.4)"/><g stroke="rgba(10,25,25,.28)" stroke-width="1.1" fill="none" stroke-linecap="round"><path d="M12 6.5V19"/><path d="M8.4 7.8 9.4 18.4"/><path d="M15.6 7.8 14.6 18.4"/></g>',
    // 3 urchin (spiky star)
    '<g stroke="rgba(255,255,255,.5)" stroke-width="2" stroke-linecap="round"><path d="M12 2.5V21.5M2.5 12H21.5M5 5 19 19M19 5 5 19"/></g><circle cx="12" cy="12" r="3.3" fill="rgba(255,255,255,.58)"/>',
    // 4 plankton (ringed circle)
    '<circle cx="12" cy="12" r="7.6" fill="none" stroke="rgba(255,255,255,.5)" stroke-width="2"/><circle cx="12" cy="12" r="3.3" fill="rgba(255,255,255,.62)"/>',
    // 5 scallop
    '<path d="M12 19 C5 19 3.5 9 5 6.5 C7 8.5 9 8.5 12 6.5 C15 8.5 17 8.5 19 6.5 C20.5 9 19 19 12 19Z" fill="rgba(255,255,255,.42)"/>',
    // 6 barnacle (cone)
    '<path d="M12 4 L16.5 19 H7.5 Z" fill="rgba(255,255,255,.42)"/><ellipse cx="12" cy="13.5" rx="2.7" ry="2.1" fill="rgba(255,255,255,.62)"/>'
  ];

  var TIER_NODECAP = { easy: 250000, medium: 500000, hard: 500000 };

  function $(id) { return document.getElementById(id); }

  // ------------------------------------------------------------- storage --
  function lsGet(k, fb) {
    try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : fb; }
    catch (e) { return fb; }
  }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }

  // progress: { unlocked:int(1..TOTAL), stars:{depth:1..3}, streak:int }
  var progress = Object.assign({ unlocked: 1, stars: {}, streak: 0, best: {} },
                               lsGet("tp-progress", {}));
  if (!progress.stars) progress.stars = {};
  // Your best result on each Depth, in that Depth's own currency (points, or
  // creatures collected). Recorded on a LOSS as well as a win — "best 4,900 of
  // 5,520" is exactly the number that tells you a retry is worth it.
  if (!progress.best) progress.best = {};
  function saveProgress() { lsSet("tp-progress", progress); }

  function recordBest(depth, value) {
    if (!(value > (progress.best[depth] || 0))) return;
    progress.best[depth] = value;
    saveProgress();
  }

  function highestUnlocked() { return Math.min(progress.unlocked || 1, TOTAL); }
  function isUnlocked(d) { return d <= highestUnlocked(); }
  function currentDepth() {
    for (var d = 1; d <= highestUnlocked(); d++) if (!progress.stars[d]) return d;
    return highestUnlocked();
  }
  function totalStars() {
    var s = 0; for (var k in progress.stars) s += progress.stars[k]; return s;
  }
  function buzz(p) { if (navigator.vibrate) { try { navigator.vibrate(p); } catch (e) {} } }
  function prefersReduced() {
    return window.matchMedia && window.matchMedia("(prefers-reduced-motion:reduce)").matches;
  }

  // ------------------------------------------------------------- state --
  var G = {
    screen: "home",
    depth: 0, meta: null,
    board: null, refill: null, pointers: null,
    colorCount: 4, moves: 0, target: 0, star2: 0, star3: 0,
    score: 0, movesUsed: 0,
    // The win condition. {type:"score",amount} or {type:"collect",color,amount}.
    // `progress` is measured in the objective's own currency — points for a
    // score Depth, creatures-of-that-colour for a collect Depth.
    objective: null, progress: 0,
    history: [],
    selected: null,
    down: null,
    animating: false,
    over: false,
    clawArmed: false,
    freeMove: false,
    challenge: false,
    weekly: null,          // Weekly Tide slot index (0-6) when playing one
    trench: 0,             // Trench rung number when playing an endless run
    geom: { ts: 44 },
    els: {}
  };
  // dev/test hook, only with ?dev=1 in the URL — never active in normal play
  if (typeof location !== "undefined" && /[?&]dev=1/.test(location.search)) window.__G = G;

  // ----------------------------------------------------- level lifecycle --
  function metaFor(depth) { return LEVELS[depth - 1]; }

  // ------------------------------------------------------------ objectives --
  // A Depth wins on its objective, not always on score. Score Depths keep the
  // classic bar; collect Depths ask for N creatures of one kind. Everything the
  // rest of the UI needs flows from these three helpers, so adding a third
  // objective type later means touching them and nothing else.
  function objectiveFor(meta) {
    return meta.objective || { type: "score", amount: meta.target };
  }
  // This move's contribution to the objective, read off the engine result.
  function progressGain(res) {
    if (G.objective && G.objective.type === "collect") {
      return (res.collected && res.collected[G.objective.color]) || 0;
    }
    return res.scoreGained;
  }
  function objectiveMet() {
    return G.objective && G.progress >= G.objective.amount;
  }
  function isCollect() { return !!(G.objective && G.objective.type === "collect"); }

  // Star bands in the objective's own currency (collect Depths carry their own,
  // computed against an exhibited ceiling by scripts/add-objectives.js).
  function starBands() {
    if (isCollect()) {
      return { two: G.meta.objStar2 || Infinity, three: G.meta.objStar3 || Infinity };
    }
    return { two: G.star2, three: G.star3 };
  }

  function cloneGrid(grid) {
    return grid.map(function (row) {
      return row.map(function (cd) { return cd === null ? null : { color: cd.color, kind: cd.kind }; });
    });
  }
  function cloneBoard(b) { return { rows: b.rows, cols: b.cols, grid: cloneGrid(b.grid) }; }

  function startDepth(depth) {
    var m = metaFor(depth);
    if (!m) return;
    G.challenge = false;
    G.weekly = null;
    G.trench = 0;
    G.depth = depth; G.meta = m;
    G.board = { rows: m.board.rows, cols: m.board.cols, grid: cloneGrid(m.board.grid) };
    G.refill = m.refill;
    G.pointers = new Array(m.cols).fill(0);
    G.colorCount = m.colorCount;
    G.moves = m.moves; G.target = m.target;
    G.star2 = m.star2; G.star3 = m.star3;
    G.objective = objectiveFor(m); G.progress = 0;
    G.score = 0; G.movesUsed = 0; G.bestMoveGain = 0;
    G.history = [];
    G.selected = null; G.down = null; G.animating = false; G.over = false;
    G.tutor = null;
    coach(null);
    document.body.classList.remove("lose-desat");
    applyStreakGift();
    show("game");
    layoutBoard();
    buildBoard(false);
    updateHUD();
    ensurePlayable();
    if (tutorialDue(depth)) startTutorial();
    saveGame();
  }

  // ------------------------------------------------------ first-dive coach --
  // One guided swap on a brand-new player's very first dive. Deliberately tiny:
  // it teaches the single mechanic everything else builds on (swap two
  // neighbours to line up three) and then gets out of the way. It is not a
  // multi-step tour, and it never appears again.
  //
  // The move it points at is the highest-scoring legal swap on the start board,
  // taken straight from the engine's own legalMoves — no solver call, so there
  // is no thinking pause on the first thing a new player ever sees.
  function tutorialDue(depth) {
    return depth === 1 && !lsGet("tp-tutorial", 0) && !totalStars();
  }
  function startTutorial() {
    var moves = L.legalMoves(G.board, G.refill, G.pointers);
    if (!moves.length) return;                 // nothing to teach; skip silently
    var best = moves[0];
    for (var i = 1; i < moves.length; i++) {
      if (moves[i].res.scoreGained > best.res.scoreGained) best = moves[i];
    }
    G.tutor = {
      a: { r: best.move.r1, c: best.move.c1 },
      b: { r: best.move.r2, c: best.move.c2 }
    };
    $("board").classList.add("tutor");
    markTutorTiles();
    coach("Tap these two to swap them");
  }
  function markTutorTiles() {
    if (!G.tutor) return;
    [G.tutor.a, G.tutor.b].forEach(function (cell) {
      var el = G.els[cell.r + "," + cell.c];
      if (el) el.classList.add("tut");
    });
  }
  function isTutorCell(cell) {
    if (!G.tutor || !cell) return false;
    return (cell.r === G.tutor.a.r && cell.c === G.tutor.a.c) ||
           (cell.r === G.tutor.b.r && cell.c === G.tutor.b.c);
  }
  function endTutorial(withPraise) {
    if (!G.tutor) return;
    G.tutor = null;
    $("board").classList.remove("tutor");
    for (var k in G.els) G.els[k].classList.remove("tut");
    lsSet("tp-tutorial", 1);
    if (withPraise) {
      coach("That's it — three in a row clears. Now reach the target.");
      setTimeout(function () { coach(null); }, 2600);
    } else {
      coach(null);
    }
  }
  function coach(text) {
    var el = $("coach");
    if (!text) { el.hidden = true; $("coach-text").textContent = ""; return; }
    $("coach-text").textContent = text;
    el.hidden = false;
  }

  // Tide's Favor: pre-place free specials for a win streak (see economy.js).
  // Conversions keep each creature's color, so no new matches can appear.
  function applyStreakGift() {
    var kinds = ECON ? ECON.streakGift(progress.streak || 0) : [];
    if (!kinds.length) return;
    var cells = [];
    for (var r = 0; r < G.board.rows; r++)
      for (var c = 0; c < G.board.cols; c++)
        if (G.board.grid[r][c] && G.board.grid[r][c].kind === "normal") cells.push({ r: r, c: c });
    var placed = 0;
    for (var i = 0; i < kinds.length && cells.length; i++) {
      var pick = cells.splice(Math.floor(Math.random() * cells.length), 1)[0];
      var cd = G.board.grid[pick.r][pick.c];
      cd.kind = (kinds[i] === "bomb") ? "bomb"
              : (Math.random() < 0.5 ? "stripe-h" : "stripe-v");
      placed++;
    }
    if (placed) {
      var msg = "Tide's Favor: " + placed + " gift" + (placed > 1 ? "s" : "") +
                " for your " + progress.streak + "-win streak";
      setTimeout(function () { toast(msg); if (SND.special) SND.special(); }, 500);
    }
  }

  // Signature of a depth's PUZZLE — board, refill queue, move budget. A mid-level
  // save stores it; if a shipped rebalance changes the puzzle under a save, that
  // save is discarded (the depth restarts fresh) instead of resuming against the
  // wrong level. tp-progress (stars/unlocked/best/streak) is never touched by this.
  //
  // The TARGET is deliberately NOT in the signature. It used to be, and that made
  // the save fragile in a way it never needed to be: retuning a win bar leaves the
  // board, the queue and the budget identical, so the save is still perfectly
  // valid — it just finishes against a different number. Hashing the target threw
  // away a legitimate in-progress game every time a Depth was rebalanced, which is
  // exactly what the 2026-07-30 hard-target clamp would have done to 96 Depths.
  function hash(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return h.toString(36);
  }
  function levelSig(m) {
    return hash(JSON.stringify({ b: m.board, r: m.refill, mv: m.moves }));
  }
  // The pre-2026-07-31 formula. Saves already on disk carry one of these, so it is
  // still accepted on resume — dropping the target from the hash must not itself
  // invalidate every save it was meant to protect. `t` is passed in because a
  // rebalanced Depth records what it used to ask for (levels.js prevTarget), and a
  // save written before that rebalance was hashed against the OLD number.
  function legacyLevelSig(m, t) {
    return hash(JSON.stringify({ b: m.board, r: m.refill, mv: m.moves, t: t }));
  }
  function sigOk(sv, m) {
    if (!m) return false;
    if (sv.sig === levelSig(m)) return true;              // written since the change
    if (sv.sig === legacyLevelSig(m, m.target)) return true;   // written before it
    return m.prevTarget !== undefined &&                  // ...on a rebalanced Depth
           sv.sig === legacyLevelSig(m, m.prevTarget);
  }
  function saveMatchesLevel(sv) {
    return sigOk(sv, metaFor(sv.depth));
  }

  function resumeSave(sv) {
    var m = metaFor(sv.depth);
    if (!m) return false;
    if (!sigOk(sv, m)) { lsDel("tp-save"); return false; }
    G.depth = sv.depth; G.meta = m;
    G.board = { rows: m.board.rows, cols: m.board.cols, grid: cloneGrid(sv.board.grid) };
    G.refill = m.refill;
    G.pointers = sv.pointers.slice();
    G.colorCount = m.colorCount;
    G.moves = sv.movesCap || m.moves; G.target = m.target;
    G.star2 = m.star2; G.star3 = m.star3;
    G.objective = objectiveFor(m);
    G.progress = sv.progress || 0;
    G.score = sv.score; G.movesUsed = sv.movesUsed;
    G.history = (sv.history || []).map(function (h) {
      return { grid: cloneGrid(h.grid), pointers: h.pointers.slice(), score: h.score,
               movesUsed: h.movesUsed, progress: h.progress || 0 };
    });
    G.selected = null; G.down = null; G.animating = false; G.over = false;
    G.tutor = null; coach(null);
    document.body.classList.remove("lose-desat");
    show("game");
    layoutBoard();
    buildBoard(false);
    updateHUD();
    ensurePlayable();
    return true;
  }

  // Daily Challenge session: the featured depth played at its 3-STAR score as
  // the target. Campaign progress, streak and the campaign save are untouched;
  // challenge sessions are never persisted (abandoning one costs nothing).
  // The Daily Tide. Not a replay of a Depth you already cleared: the featured
  // Depth is recoloured by a date-seeded COLOUR PERMUTATION, which is a proven
  // isomorphism of the game (src/transform.js, test/verify-transform.js), so the
  // board reads as new while its target, star bars and winning line stay exactly
  // as certified. Same puzzle for every player on the same day, no backend.
  function startChallenge(depth) {
    var m = metaFor(depth);
    if (!m) return;
    var day = ECON ? ECON.epochDay() : 0;
    var tl = (typeof TideTransform !== "undefined")
      ? TideTransform.dailyTransform(m, day) : m;
    var keepSave = lsGet("tp-save", null);   // an in-progress CAMPAIGN level, if any
    startDepth(depth);                        // builds the session (and writes tp-save)
    // swap in the transformed board/refill — the certificate travels with it
    G.board = { rows: tl.board.rows, cols: tl.board.cols, grid: cloneGrid(tl.board.grid) };
    G.refill = tl.refill;
    G.pointers = new Array(tl.board.cols).fill(0);
    G.meta = tl;
    G.objective = { type: "score", amount: m.star3 };
    G.progress = 0;
    G.challenge = true;
    G.weekly = null;
    G.target = m.star3;                       // the challenge bar (proven reachable)
    buildBoard(false);
    if (keepSave) lsSet("tp-save", keepSave); // put the campaign save back untouched
    else lsDel("tp-save");
    updateHUD();
    ensurePlayable();
    var st = ECON ? ECON.challengeState() : null;
    var extra = (st && st.streak) ? " · " + st.streak + "-day streak" : "";
    toast("Tide #" + (ECON ? ECON.tideNumber() : 0) + " — reach the target" + extra, 2400);
  }

  // Weekly Tide session: the slot's featured depth at its NORMAL win target —
  // a Weekly slot is meant to be finishable, the week itself is the challenge.
  // Like the Daily Challenge it leaves campaign progress, streak and the
  // campaign save completely alone.
  function startWeekly(slotIndex) {
    if (!ECON) return;
    var st = ECON.weeklyState(TOTAL);
    var slot = st.slots[slotIndex];
    if (!slot || !slot.unlocked) return;
    var m = metaFor(slot.depth);
    if (!m) return;
    var keepSave = lsGet("tp-save", null);   // an in-progress CAMPAIGN level, if any
    startDepth(slot.depth);                   // builds the session (and writes tp-save)
    G.challenge = true;                       // reuse "don't touch campaign state"
    G.weekly = slotIndex;
    if (keepSave) lsSet("tp-save", keepSave); // put the campaign save back untouched
    else lsDel("tp-save");
    updateHUD();
    toast(slot.day + "'s tide is in" +
          (slot.done ? " (already cleared)" : " · +" + st.slotReward + " shells"));
  }

  // ------------------------------------------------------- The Trench --
  // An endless run. Each rung is a level the device generated and CERTIFIED
  // itself (js/endless-worker.js), so "endless" never means "unverified". A run
  // ends the first time you fail a rung; how deep you got is the score.
  // Campaign progress, streak and save are untouched, like the other side modes.
  function startTrench(rung) {
    if (typeof TideTrench === "undefined" || !TideTrench.available()) {
      toast("The Trench needs a browser that allows workers");
      return;
    }
    var lvl = TideTrench.take();
    if (!lvl) {
      TideTrench.fill(rung);
      toast("The trench is still forming — try again in a moment", 2400);
      return;
    }
    var keepSave = lsGet("tp-save", null);
    G.challenge = true;          // reuse "don't touch campaign state"
    G.weekly = null;
    G.trench = rung;
    G.depth = rung;
    G.meta = lvl;
    G.board = { rows: lvl.board.rows, cols: lvl.board.cols, grid: cloneGrid(lvl.board.grid) };
    G.refill = lvl.refill;
    G.pointers = new Array(lvl.board.cols).fill(0);
    G.colorCount = lvl.colorCount;
    G.moves = lvl.moves; G.target = lvl.target;
    G.star2 = lvl.star2; G.star3 = lvl.star3;
    G.objective = { type: "score", amount: lvl.target };
    G.progress = 0;
    G.score = 0; G.movesUsed = 0; G.bestMoveGain = 0;
    G.history = [];
    G.selected = null; G.down = null; G.animating = false; G.over = false;
    G.tutor = null; coach(null);
    document.body.classList.remove("lose-desat");
    applyStreakGift();
    show("game");
    layoutBoard();
    buildBoard(false);
    updateHUD();
    ensurePlayable();
    if (keepSave) lsSet("tp-save", keepSave); else lsDel("tp-save");
    toast("Rung " + rung + " · " + TideTrench.tierForRung(rung), 1800);
  }

  function winTrench() {
    var rung = G.trench;
    var next = rung + 1;
    document.querySelector("#screen-win .win-h").textContent = "Deeper!";
    document.querySelector("#screen-win .win-sub").innerHTML =
      'The Trench &mdash; rung <b id="win-depth2">' + rung + "</b> cleared";
    // written whole, because a tide win may have left a named chip here
    document.querySelector("#screen-win .hud .depth").innerHTML =
      'Trench <b id="win-depth">' + rung + "</b>";
    var stars = $("win-stars"); stars.innerHTML = "";
    var earned = starsFor(starValue());
    for (var i = 1; i <= 3; i++) {
      var sp = document.createElement("span");
      sp.className = i <= earned ? "on" : "off";
      sp.style.animationDelay = (i * 0.14) + "s";
      sp.innerHTML = "&#9733;"; stars.appendChild(sp);
    }
    $("win-moves").textContent = G.movesUsed + "/" + G.moves;
    $("win-streak").textContent = "R" + rung;
    document.querySelectorAll("#screen-win .stat .l")[0].textContent = "Score";
    // Shells for depth, so a long run is worth something even when it ends.
    if (ECON) {
      var pay = 10 + rung * 2;
      ECON.awardTrench(pay);
      $("reward-total").textContent = pay;
      $("reward-detail").textContent = "rung " + rung + " of the Trench";
      $("win-reward").hidden = false;
    }
    $("win-find").hidden = true;   // the Trench logs no species
    if (earned < 3) renderStarBands($("win-bands"), G.meta, starValue(), earned, "end");
    else $("win-bands").hidden = true;
    $("btn-win-next").style.display = "";
    $("btn-win-next").textContent = "Rung " + next;
    SND.win(); buzz([12, 40, 20, 40, 12]);
    show("win");
    countUp($("win-score"), G.score, 900);
    celebrate();
  }

  function saveGame() {
    if (G.over || !G.board || G.challenge) return;
    lsSet("tp-save", {
      depth: G.depth,
      sig: levelSig(G.meta),
      movesCap: G.moves,          // may exceed the level's base after a rescue
      board: { grid: G.board.grid },
      pointers: G.pointers,
      score: G.score, movesUsed: G.movesUsed, progress: G.progress,
      history: G.history.map(function (h) {
        return { grid: h.grid, pointers: h.pointers, score: h.score,
                 movesUsed: h.movesUsed, progress: h.progress };
      }),
      savedAt: Date.now()
    });
  }

  // ------------------------------------------------------------- board --
  function layoutBoard() {
    var wrap = document.querySelector(".board-wrap");
    var availW = wrap.clientWidth - 32;
    var availH = wrap.clientHeight - 16;
    var cols = G.board.cols, rows = G.board.rows;
    var ts = Math.floor(Math.min(availW / cols, availH / rows));
    if (ts < 30) ts = 30;
    G.geom.ts = ts;
    var board = $("board");
    board.style.width = (ts * cols) + "px";
    board.style.height = (ts * rows) + "px";
  }

  function tileSvg(cd) {
    var kindClass = "blob";
    if (cd.kind === "stripe-h") kindClass += " stripe-h";
    else if (cd.kind === "stripe-v") kindClass += " stripe-v";
    else if (cd.kind === "bomb") kindClass += " bomb";
    else if (cd.kind === "urchin") kindClass += " urchin";
    var hue = cd.kind === "bomb" ? "#cfe6df" : HUE[cd.color];
    // Urchin shows its creature's own emblem; the spinning gold ring + pulse
    // (CSS) are what mark it as special.
    var emblem = cd.kind === "bomb" ? "" : EMBLEM[cd.color];
    return '<div class="' + kindClass + '" style="background:radial-gradient(circle at 34% 30%, ' +
      shade(hue, 1.35) + ', ' + hue + ' 62%); color:' + hue + '; box-shadow:0 2px 8px rgba(0,0,0,.35), 0 0 14px ' +
      hexA(hue, .38) + ';">' + (emblem ? '<svg viewBox="0 0 24 24">' + emblem + '</svg>' : '') + '</div>';
  }

  function makeTile(r, c, cd) {
    var el = document.createElement("div");
    el.className = "tile";
    el.dataset.r = r; el.dataset.c = c;
    el.dataset.color = cd.color; el.dataset.kind = cd.kind;
    el.innerHTML = tileSvg(cd);
    positionTile(el, r, c);
    return el;
  }
  function positionTile(el, r, c) {
    var ts = G.geom.ts;
    el.style.width = el.style.height = ts + "px";
    el.style.left = (c * ts) + "px";
    el.style.top = (r * ts) + "px";
  }

  function buildBoard(withFall) {
    var board = $("board");
    board.innerHTML = "";
    G.els = {};
    for (var r = 0; r < G.board.rows; r++) {
      for (var c = 0; c < G.board.cols; c++) {
        var cd = G.board.grid[r][c];
        if (!cd) continue;
        var el = makeTile(r, c, cd);
        if (withFall && !prefersReduced()) {
          el.classList.add("fall");
          el.style.setProperty("--fy", "-" + (40 + r * 6) + "px");
          el.style.animationDelay = (c * 18) + "ms";
          (function (e) { setTimeout(function () { e.classList.remove("fall"); e.style.removeProperty("--fy"); }, 700); })(el);
        }
        board.appendChild(el);
        G.els[r + "," + c] = el;
      }
    }
    markTutorTiles();   // a rebuild (or a free reshuffle) must not lose the glow
  }

  function relayout() {
    layoutBoard();
    for (var k in G.els) {
      var p = k.split(","); positionTile(G.els[k], +p[0], +p[1]);
    }
  }

  // ---------------------------------------------------------- selection --
  function setSelected(cell) {
    clearSelected();
    G.selected = cell;
    var el = G.els[cell.r + "," + cell.c];
    if (el) el.classList.add("sel");
    SND.select(); buzz(8);
  }
  function clearSelected() {
    if (G.selected) {
      var el = G.els[G.selected.r + "," + G.selected.c];
      if (el) el.classList.remove("sel");
    }
    G.selected = null;
  }

  function adjacent(a, b) { return Math.abs(a.r - b.r) + Math.abs(a.c - b.c) === 1; }

  // ------------------------------------------------------------- input --
  function cellFromEvent(e) {
    var rect = $("board").getBoundingClientRect();
    var x = e.clientX - rect.left, y = e.clientY - rect.top;
    var ts = G.geom.ts;
    var c = Math.floor(x / ts), r = Math.floor(y / ts);
    if (r < 0 || c < 0 || r >= G.board.rows || c >= G.board.cols) return null;
    if (!G.board.grid[r][c]) return null;
    return { r: r, c: c };
  }
  function pressTile(cell, on) {
    var el = G.els[cell.r + "," + cell.c];
    if (el) el.classList.toggle("press", on);
  }

  function onDown(e) {
    SND.resume(); getWorker();
    if (G.animating || G.over || !G.board) return;
    var cell = cellFromEvent(e);
    if (!cell) return;
    // During the coached first swap, taps outside the taught pair do nothing but
    // re-point at it — a new player poking elsewhere gets guidance, not an
    // illegal-move buzz.
    if (G.tutor && !isTutorCell(cell)) {
      coach("Tap the two glowing creatures");
      buzz(8);
      return;
    }
    G.down = { cell: cell, x: e.clientX, y: e.clientY, swiped: false };
    pressTile(cell, true);
    try { $("board").setPointerCapture(e.pointerId); } catch (x) {}
    e.preventDefault();
  }
  function onMove(e) {
    if (!G.down || G.animating || G.down.swiped) return;
    var dx = e.clientX - G.down.x, dy = e.clientY - G.down.y;
    var thresh = G.geom.ts * 0.4;
    if (Math.hypot(dx, dy) < thresh) return;
    var dir;
    if (Math.abs(dx) > Math.abs(dy)) dir = { r: 0, c: dx > 0 ? 1 : -1 };
    else dir = { r: dy > 0 ? 1 : -1, c: 0 };
    var a = G.down.cell, b = { r: a.r + dir.r, c: a.c + dir.c };
    if (G.tutor && !isTutorCell(b)) {          // swiping counts too — same guard
      G.down = null; pressTile(a, false);
      coach("Swipe one glowing creature into the other");
      return;
    }
    G.down.swiped = true;
    pressTile(a, false);
    if (b.r < 0 || b.c < 0 || b.r >= G.board.rows || b.c >= G.board.cols || !G.board.grid[b.r][b.c]) {
      G.down = null; return;
    }
    clearSelected();
    trySwap(a, b);
    G.down = null;
    e.preventDefault();
  }
  function onUp(e) {
    if (!G.down) return;
    pressTile(G.down.cell, false);
    if (G.down.swiped) { G.down = null; return; }
    var cell = G.down.cell;
    G.down = null;
    if (G.animating || G.over) return;
    if (G.clawArmed) { clawCell(cell); return; }   // Crab Claw targeting
    // tap logic
    if (!G.selected) { setSelected(cell); }
    else if (G.selected.r === cell.r && G.selected.c === cell.c) { clearSelected(); }
    else if (adjacent(G.selected, cell)) {
      var s = G.selected; clearSelected(); trySwap(s, cell);
    } else { setSelected(cell); }
  }

  // ------------------------------------------------------------- swap --
  function trySwap(a, b) {
    if (G.animating || G.over) return;
    var move = { r1: a.r, c1: a.c, r2: b.r, c2: b.c };
    var ca = G.board.grid[a.r][a.c], cb = G.board.grid[b.r][b.c];
    var wasBomb = !!(ca && ca.kind === "bomb") || !!(cb && cb.kind === "bomb");
    var trace = [];
    var res = L.applyMove(G.board, G.refill, G.pointers, move,
      { allowSpecials: true, trace: trace });
    if (!res.legal) { illegal(a, b); return; }
    G.animating = true;
    clearHint(); clearSelected();
    pushHistory();
    animateResolution(a, b, res, trace, wasBomb);
  }

  function illegal(a, b) {
    SND.bad(); buzz([6, 30, 6]);
    [a, b].forEach(function (cell) {
      var el = G.els[cell.r + "," + cell.c];
      if (!el) return;
      el.classList.remove("wobble"); void el.offsetWidth; el.classList.add("wobble");
      setTimeout(function () { el.classList.remove("wobble"); }, 400);
    });
  }

  function pushHistory() {
    G.history.push({
      grid: cloneGrid(G.board.grid), pointers: G.pointers.slice(),
      score: G.score, movesUsed: G.movesUsed, progress: G.progress
    });
    if (G.history.length > 30) G.history.shift();
  }

  // ---- incremental move animation (trace-driven) ----------------------------
  // The engine resolves a whole move (all cascades) at once and returns a `trace`
  // of steps. We animate each step so ONLY the matched pieces clear, survivors
  // SLIDE down (CSS transitions left/top), and refills DROP in from the top — the
  // rest of the board stays put. `res` (authoritative) is snapped in at the end.
  var SWAP_MS = 220, BLOOM_MS = 300, FALL_MS = 300;

  // Physically swap the two selected tiles (elements slide via CSS transition).
  function swapEls(a, b) {
    var ka = a.r + "," + a.c, kb = b.r + "," + b.c;
    var ea = G.els[ka], eb = G.els[kb], g = G.board.grid;
    var tmp = g[a.r][a.c]; g[a.r][a.c] = g[b.r][b.c]; g[b.r][b.c] = tmp;
    if (ea) { ea.dataset.r = b.r; ea.dataset.c = b.c; positionTile(ea, b.r, b.c); }
    if (eb) { eb.dataset.r = a.r; eb.dataset.c = a.c; positionTile(eb, a.r, a.c); }
    G.els[ka] = eb || undefined; G.els[kb] = ea || undefined;
    if (!eb) delete G.els[ka]; if (!ea) delete G.els[kb];
  }

  function animateResolution(a, b, res, trace, wasBomb) {
    // Objective progress ticks up per cascade step for feel, but the engine's
    // own tally is what counts — finishMove resets progress to base + res, so a
    // per-step miscount can never drift the win condition.
    G.progressBase = G.progress;
    if (prefersReduced() || !trace.length) { finishMove(res); return; }
    SND.select();
    if (!wasBomb) swapEls(a, b);
    setTimeout(function () { runStep(0, trace, res); }, wasBomb ? 0 : SWAP_MS);
  }

  function runStep(i, trace, res) {
    if (i >= trace.length) { finishMove(res); return; }
    var step = trace[i];
    // a) bloom + remove the cleared pieces (and only those)
    var wantColor = isCollect() ? G.objective.color : 0;
    step.cleared.forEach(function (cell) {
      var k = cell.r + "," + cell.c, el = G.els[k];
      var doomed = G.board.grid[cell.r][cell.c];
      if (wantColor && doomed && doomed.color === wantColor) {
        G.progress += 1;
        if (el) el.classList.add("collected");
      }
      spawnSparks(cell.r, cell.c);
      if (el) {
        el.classList.add("bloom");
        (function (e) { setTimeout(function () { if (e.parentNode) e.parentNode.removeChild(e); }, BLOOM_MS + 40); })(el);
        delete G.els[k];
      }
      G.board.grid[cell.r][cell.c] = null;
    });
    SND.match(); buzz(8); if (i > 0) SND.cascade(i);
    // b) creations: turn the creation cell's tile into its special (it then falls)
    step.creations.forEach(function (cr) {
      var k = cr.r + "," + cr.c, cd = { color: cr.color, kind: cr.kind }, el = G.els[k];
      if (!el) { el = makeTile(cr.r, cr.c, cd); $("board").appendChild(el); G.els[k] = el; }
      else { el.innerHTML = tileSvg(cd); el.dataset.color = cd.color; el.dataset.kind = cd.kind; }
      el.classList.add("glint");
      (function (e) { setTimeout(function () { e.classList.remove("glint"); }, 500); })(el);
      G.board.grid[cr.r][cr.c] = cd;
      if (cr.kind === "bomb" && SND.special) SND.special();
    });
    // progressive score (sums exactly to res.scoreGained across steps)
    G.score += step.score; updateHUD();
    // c) after the bloom, apply gravity toward this step's resulting board
    setTimeout(function () {
      applyGravity(step.boardAfter);
      setTimeout(function () { runStep(i + 1, trace, res); }, FALL_MS);
    }, BLOOM_MS);
  }

  // Slide survivors to the bottom of each column and drop new refills into the
  // gaps at the top, to reach `boardAfter`. Existing tile elements are reused
  // (they keep identity and just move), so untouched pieces never re-render.
  function applyGravity(boardAfter) {
    var board = $("board"), rows = G.board.rows, cols = G.board.cols, ts = G.geom.ts;
    for (var c = 0; c < cols; c++) {
      var surv = [];
      for (var r = rows - 1; r >= 0; r--) {
        var el = G.els[r + "," + c];
        if (el) { surv.push(el); delete G.els[r + "," + c]; }
      }
      var idx = 0;
      for (var rr = rows - 1; rr >= 0; rr--) {
        var key = rr + "," + c, cd = boardAfter.grid[rr][c];
        if (idx < surv.length) {                     // a survivor falls here
          var s = surv[idx++];
          s.dataset.r = rr; s.dataset.c = c; positionTile(s, rr, c);
          G.els[key] = s;
        } else if (cd) {                             // a fresh refill drops in
          var nel = makeTile(rr, c, cd);
          nel.classList.add("fall");
          nel.style.setProperty("--fy", "-" + ((rr + 2) * ts) + "px");
          board.appendChild(nel); G.els[key] = nel;
          // remove the fall class once it settles so no tile ever lingers with a
          // transform offset (defensive: keeps hit-testing/layout exact).
          (function (e) { setTimeout(function () { e.classList.remove("fall"); e.style.removeProperty("--fy"); }, 460); })(nel);
        }
        G.board.grid[rr][c] = cd;
      }
    }
  }

  function finishMove(res) {
    G.board = { rows: res.board.rows, cols: res.board.cols, grid: res.board.grid };
    G.pointers = res.pointers;
    if (G.freeMove) G.freeMove = false;   // boosters don't consume a move
    else G.movesUsed += 1;
    reconcileBoard(res.board);   // snap DOM to the authoritative final board
    // glint any freshly-formed specials that are still on the board
    for (var r = 0; r < G.board.rows; r++) for (var c = 0; c < G.board.cols; c++) {
      var cd = G.board.grid[r][c];
      if (cd && cd.kind !== "normal") {
        var el = G.els[r + "," + c];
        if (el) { var blob = el.firstChild; if (blob) blob.classList.add("glint"); }
      }
    }
    // Authoritative progress: whatever the engine says this move contributed,
    // added to where we started. (The per-step animation may have been running
    // ahead for feel; this is the number the win check uses.)
    var gained = progressGain(res);
    G.progress = (G.progressBase || 0) + gained;
    // Biggest single move of this dive — the lose screen uses it to say whether
    // the shortfall was really "one more move like that one".
    if (gained > (G.bestMoveGain || 0)) G.bestMoveGain = gained;
    if (G.tutor) endTutorial(true);   // the taught swap landed — they've got it
    G.animating = false;
    updateHUD();   // after clearing animating, so the undo button re-enables
    if (objectiveMet()) { win(); return; }
    if (G.movesUsed >= G.moves) { offerRescue(); return; }
    if (!ensurePlayable()) return;   // free turn-over if the pool deadlocked
    saveGame();
  }

  // --------------------------------------------- daily chest & challenge --
  // The tile shows only what changes; the sentence that used to sit under the
  // title moves to the aria-label so the meaning survives for screen readers.
  function renderChallengeCard() {
    if (!ECON) return;
    var st = ECON.challengeState();
    var card = $("btn-challenge");
    $("ch-name").textContent = "Daily";
    if (st.claimed) {
      card.classList.add("done");
      $("ch-reward").innerHTML = "&#10003; done";
      card.setAttribute("aria-label", "Daily Tide number " + ECON.tideNumber() +
        ", already cleared today" + (st.streak > 1 ? ", " + st.streak + " day streak" : ""));
    } else {
      card.classList.remove("done");
      $("ch-reward").innerHTML = "+" + (st.reward + st.streakBonus) + "&#128026;";
      card.setAttribute("aria-label", "Daily Tide number " + ECON.tideNumber() +
        ", the same board for every player today, worth " +
        (st.reward + st.streakBonus) + " shells" +
        (st.streak ? ". Keep your " + st.streak + " day streak alive" : ""));
    }
  }

  // ------------------------------------------------------- Weekly Tide UI --
  function renderWeeklyCard() {
    if (!ECON) return;
    var st = ECON.weeklyState(TOTAL);
    var card = $("btn-weekly");
    $("wk-reward").textContent = st.doneCount + "/7";
    card.classList.toggle("complete", st.complete);
    var today = st.slots[st.today];
    var say;
    if (st.complete) say = "all seven cleared, back Monday";
    else if (!today.done) say = today.day + "'s tide is in, worth " + st.slotReward + " shells";
    else {
      var pending = st.slots.filter(function (s) { return s.unlocked && !s.done; });
      say = pending.length
        ? pending.length + " tide" + (pending.length > 1 ? "s" : "") + " still open"
        : "next tide tomorrow";
    }
    card.setAttribute("aria-label", "Weekly Tide, " + st.doneCount +
      " of 7 cleared — " + say + ". All seven pays " + st.bonus + " shells");
  }

  // The Trench card doubles as the buffer's status light: it says plainly when
  // the device is still certifying rungs, so "not ready yet" never looks like a
  // broken button.
  function renderTrenchCard() {
    if (typeof TideTrench === "undefined") return;
    var card = $("btn-trench");
    if (!TideTrench.available()) {
      $("tr-best").textContent = "—";
      card.classList.add("done");
      card.setAttribute("aria-label", "The Trench is unavailable — this browser blocks Web Workers");
      return;
    }
    card.classList.remove("done");
    var best = TideTrench.best();
    var ready = TideTrench.ready();
    // While the buffer fills the badge says so, so a tap that cannot start a run
    // is never a surprise.
    card.classList.toggle("busy", !ready);
    $("tr-best").textContent = !ready ? "charting…" : (best ? "best " + best : "new");
    card.setAttribute("aria-label", "The Trench, an endless certified descent" +
      (best ? ", your best is rung " + best : "") +
      (ready ? "" : " — still charting the next rungs"));
    TideTrench.fill(best + 1);
  }

  function openWeeklyModal() {
    if (!ECON) return;
    var st = ECON.weeklyState(TOTAL);
    var track = $("week-track"); track.innerHTML = "";
    st.slots.forEach(function (s) {
      var b = document.createElement("button");
      b.className = "week-slot " +
        (s.done ? "done" : s.isToday ? "today" : s.unlocked ? "open" : "locked");
      b.dataset.slot = s.index;
      if (!s.unlocked) b.disabled = true;
      // The slot used to print its Depth here, which handed the player the one
      // thing a tide is meant to keep back. The payout is the useful number
      // anyway — it tells you what the slot is worth, not what it is.
      b.innerHTML = '<span class="wd">' + s.day + '</span>' +
                    '<span class="wn">' +
                      (s.unlocked ? "+" + st.slotReward : "&#128274;") + '</span>' +
                    '<span class="wm">' + (s.done ? "&#10003;" : s.unlocked ? "&#127754;" : "") + '</span>';
      track.appendChild(b);
    });
    $("week-count").textContent = st.doneCount;
    $("week-earned").textContent = st.doneCount * st.slotReward +
      (st.bonusClaimed ? st.bonus : 0);
    $("weekly-modal").hidden = false;
    // Set the width directly and let the CSS transition animate from whatever it
    // was. (The rescue bar's reset-to-0-then-rAF trick doesn't survive a tab that
    // isn't compositing — the rAF never fires and the bar sits empty.)
    $("week-fill").style.width = Math.round(st.doneCount / 7 * 100) + "%";
  }

  function maybeShowChest() {
    if (!ECON) return;
    var info = ECON.checkDailyLogin();
    if (!info.show || !$("chest-modal").hidden) return;
    // build the 7-day track: earlier days in this cycle lit, today highlighted
    var track = $("chest-track"); track.innerHTML = "";
    for (var i = 1; i <= 7; i++) {
      var pip = document.createElement("div");
      pip.className = "pip" + (i < info.dayIndex ? " past" : i === info.dayIndex ? " today" : "");
      pip.innerHTML = "Day " + i + "<b>" + info.rewards[i - 1] + "</b>";
      track.appendChild(pip);
    }
    $("chest").classList.remove("open");
    $("chest-amount").hidden = true;
    $("chest-open").hidden = false;
    $("chest-done").hidden = true;
    $("chest-burst").innerHTML = "";
    $("chest-modal").hidden = false;
  }

  function openChest() {
    var rw = ECON.claimLoginChest();
    if (!rw) { $("chest-modal").hidden = true; return; }
    $("chest").classList.add("open");
    $("chest-open").hidden = true;
    SND.special(); buzz([10, 30, 14]);
    // shells burst out of the chest
    var burst = $("chest-burst");
    for (var i = 0; i < 10; i++) {
      var s = document.createElement("span");
      s.className = "shellp"; s.textContent = "🐚";
      var ang = (-90 + (Math.random() * 120 - 60)) * Math.PI / 180;
      var dist = 40 + Math.random() * 55;
      s.style.setProperty("--dx", Math.cos(ang) * dist + "px");
      s.style.setProperty("--dy", Math.sin(ang) * dist + "px");
      s.style.setProperty("--rot", (Math.random() * 90 - 45) + "deg");
      s.style.animationDelay = (Math.random() * 0.25) + "s";
      burst.appendChild(s);
    }
    setTimeout(function () {
      $("chest-shells").textContent = rw.amount;
      $("chest-amount").hidden = false;
      $("chest-done").hidden = false;
      SND.win();
      if (ECON) $("stat-shells").textContent = ECON.balance();
    }, 550);
  }

  // ------------------------------------------------- Phase 2: boosters --
  // Second Wind: out of moves below target — offer +5 moves for shells
  // instead of an immediate wash-out.
  function offerRescue() {
    if (!ECON || !ECON.canAfford("rescue")) { lose(); return; }
    var goal = G.objective ? G.objective.amount : G.target;
    var have = G.objective ? G.progress : G.score;
    var pct = Math.max(0, Math.round(have / goal * 100));
    $("rescue-score").textContent = have;
    $("rescue-target").textContent = goal;
    $("rescue-pct").textContent = pct + "%";
    $("rescue-fill").style.width = "0%";
    $("rescue").hidden = false;
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { $("rescue-fill").style.width = Math.min(100, pct) + "%"; });
    });
  }

  function armClaw(on) {
    G.clawArmed = on === undefined ? !G.clawArmed : !!on;
    $("btn-claw").classList.toggle("armed", G.clawArmed);
    document.body.classList.toggle("claw-armed", G.clawArmed);
    if (G.clawArmed) toast("Tap a creature to claw it free");
  }

  // Crab Claw: pop one chosen creature (a special caught in the clear FIRES,
  // same as the hammer in the big games). Runs through the real engine
  // (resolveInternal) so gravity/refill/cascades/score stay authoritative.
  function clawCell(cell) {
    if (G.animating || G.over) return;
    if (!ECON.spend("claw")) { armClaw(false); toast("Not enough shells"); return; }
    armClaw(false);
    G.animating = true;
    clearHint(); clearSelected();
    pushHistory();
    var trace = [];
    var res = L.resolveInternal(G.board, G.refill, G.pointers,
      { type: "clear", cells: [{ r: cell.r, c: cell.c }] }, trace);
    G.freeMove = true;
    playClawFx(cell, function () {
      animateResolution(null, null, res, trace, true);
    });
  }

  // The claw show: crab scuttles in from the lower-right, pinches the target
  // (tile squeezes, sparks fly, "snip-snip" sound), then darts away as the
  // engine resolution takes over.
  function playClawFx(cell, done) {
    if (prefersReduced()) { (SND.claw || SND.special)(); done(); return; }
    var fx = $("boardFx"), ts = G.geom.ts;
    var brect = $("board").getBoundingClientRect(), wrect = fx.getBoundingClientRect();
    var cx = brect.left - wrect.left + cell.c * ts + ts / 2;
    var cy = brect.top - wrect.top + cell.r * ts + ts / 2;
    var claw = document.createElement("div");
    claw.className = "claw-fx";
    claw.style.left = cx + "px"; claw.style.top = cy + "px";
    var emo = document.createElement("span");
    emo.className = "emo in"; emo.textContent = "🦀"; // crab
    emo.style.fontSize = Math.round(ts * 1.05) + "px";
    claw.appendChild(emo); fx.appendChild(claw);
    setTimeout(function () {                       // arrived — SNIP
      emo.className = "emo snip";
      var el = G.els[cell.r + "," + cell.c];
      if (el) {
        el.classList.add("pinched");
        setTimeout(function () { el.classList.remove("pinched"); }, 280);
      }
      (SND.claw || SND.special)(); buzz([8, 24, 12]);
      spawnSparks(cell.r, cell.c);
      setTimeout(function () {                     // dart away, hand over
        emo.className = "emo out";
        setTimeout(function () { if (claw.parentNode) claw.parentNode.removeChild(claw); }, 320);
        done();
      }, 250);
    }, 290);
  }

  // Shuffle the live board in place. Retries until the layout has no ready-made
  // match and at least one legal swap. Returns "good" (playable), "matchfree"
  // (no ready match but also no legal swap — still stuck) or null (never even
  // got a match-free layout). Mutates G.board.grid; the caller owns history.
  function shuffleBoard() {
    var flat = [];
    var r, c;
    for (r = 0; r < G.board.rows; r++)
      for (c = 0; c < G.board.cols; c++)
        if (G.board.grid[r][c]) flat.push(G.board.grid[r][c]);
    var best = null;
    for (var attempt = 0; attempt < 80; attempt++) {
      for (var i = flat.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var t = flat[i]; flat[i] = flat[j]; flat[j] = t;
      }
      var k = 0;
      for (r = 0; r < G.board.rows; r++)
        for (c = 0; c < G.board.cols; c++)
          if (G.board.grid[r][c]) G.board.grid[r][c] = flat[k++];
      if (L.findRuns(G.board).length === 0) {
        best = "matchfree";
        if (L.hasAnyLegalMove(G.board, G.refill, G.pointers)) { best = "good"; break; }
      }
    }
    return best;
  }

  // Deadlock is not a paywall. If the pool runs out of legal swaps mid-dive, the
  // tide turns it over for FREE — no move, no shells. (Before this, the only way
  // out of a dead board was to buy a Rip Current or quit, which made a random
  // dead end feel like a shakedown and contradicted "every Depth is winnable
  // without spending a shell".)
  //
  // Note this can only make a dive easier: a reshuffle strictly adds options to
  // a position that had none. It does move the board off the solver-certified
  // line, but a deadlock means that line was already lost — the certificate
  // covers the level from its start position, not from every reachable one.
  function ensurePlayable() {
    if (G.over || !G.board) return true;
    if (L.hasAnyLegalMove(G.board, G.refill, G.pointers)) return true;
    var outcome = shuffleBoard();          // deliberately NOT pushed to history:
                                           // undoing back into a dead board would
                                           // just trigger this again
    if (outcome === "good") {
      SND.cascade(1); buzz([8, 30, 8]);
      buildBoard(true);
      toast("No moves left — the tide turns the pool over", 2200);
      updateHUD(); saveGame();
      return true;
    }
    // Nothing playable exists in this multiset of creatures. Vanishingly rare;
    // end the dive honestly rather than leaving the player poking a dead board.
    buildBoard(false); updateHUD();
    toast("The pool has settled — no moves remain", 2200);
    lose(true);
    return false;
  }

  // Rip Current: a PAID reshuffle the player asks for (no move consumed) — still
  // useful when the board is legal but unhelpful.
  function ripCurrent() {
    if (G.animating || G.over) return;
    if (!ECON.spend("current")) { toast("Not enough shells"); return; }
    clearHint(); clearSelected();
    pushHistory();
    var best = shuffleBoard();
    if (best === null) { // extremely unlikely; restore pre-shuffle state
      var st = G.history.pop();
      G.board = { rows: G.board.rows, cols: G.board.cols, grid: st.grid };
      ECON.refund("current");
      toast("The current stalled — shells refunded");
      buildBoard(false); updateHUD(); return;
    }
    SND.cascade(1);
    buzz([8, 30, 8]);
    buildBoard(true);            // a whole-board event: the fall-in re-deal
    toast("The current stirs the pool…");
    updateHUD();
    if (!ensurePlayable()) return;   // paid shuffle landed match-free but stuck
    saveGame();
  }

  // Safety net: make the DOM exactly match `fb`, fixing any animation drift.
  function reconcileBoard(fb) {
    var board = $("board"), seen = {};
    for (var r = 0; r < fb.rows; r++) {
      for (var c = 0; c < fb.cols; c++) {
        var k = r + "," + c, cd = fb.grid[r][c], el = G.els[k];
        if (!cd) { if (el) { if (el.parentNode) el.parentNode.removeChild(el); delete G.els[k]; } continue; }
        if (!el) { el = makeTile(r, c, cd); board.appendChild(el); G.els[k] = el; }
        else {
          var want = tileSvg(cd);
          if (el.innerHTML !== want) el.innerHTML = want;
          el.dataset.r = r; el.dataset.c = c;
          el.dataset.color = cd.color; el.dataset.kind = cd.kind;
          positionTile(el, r, c);
        }
        seen[k] = 1;
      }
    }
    for (var kk in G.els) {
      if (!seen[kk] && G.els[kk]) {
        if (G.els[kk].parentNode) G.els[kk].parentNode.removeChild(G.els[kk]);
        delete G.els[kk];
      }
    }
  }

  function spawnSparks(r, c) {
    if (prefersReduced()) return;
    var ts = G.geom.ts, fx = $("boardFx");
    var brect = $("board").getBoundingClientRect(), wrect = fx.getBoundingClientRect();
    var ox = brect.left - wrect.left, oy = brect.top - wrect.top;
    var cx = ox + c * ts + ts / 2, cy = oy + r * ts + ts / 2;
    var cd = G.board.grid[r] && G.board.grid[r][c];
    var col = cd ? HUE[cd.color] || "#cfe6df" : "#cfe6df";
    for (var i = 0; i < 5; i++) {
      var s = document.createElement("div");
      s.className = "spark";
      s.style.color = col; s.style.background = col;
      s.style.left = cx + "px"; s.style.top = cy + "px";
      fx.appendChild(s);
      var ang = (Math.PI * 2 * i) / 5 + Math.random() * 0.7;
      var dist = ts * (0.5 + Math.random() * 0.5);
      (function (el, dx, dy) {
        requestAnimationFrame(function () {
          el.style.transition = "transform .45s ease, opacity .45s ease";
          el.style.transform = "translate(" + dx + "px," + dy + "px) scale(.2)";
          el.style.opacity = "0";
        });
        setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 480);
      })(s, Math.cos(ang) * dist, Math.sin(ang) * dist);
    }
  }

  // ------------------------------------------------------------- undo --
  function undo() {
    if (G.animating || G.over || !G.history.length) return;
    if (G.clawArmed) armClaw(false);
    var st = G.history.pop();
    G.board = { rows: G.board.rows, cols: G.board.cols, grid: cloneGrid(st.grid) };
    G.pointers = st.pointers.slice();
    G.score = st.score; G.movesUsed = st.movesUsed;
    G.progress = st.progress || 0;
    clearSelected(); clearHint();
    buildBoard(false); updateHUD(); buzz(8);
    if (!ensurePlayable()) return;   // undone back into a dead board? turn it over
    saveGame();
  }

  // ------------------------------------------------------------- hint --
  function hint() {
    if (G.animating || G.over || !G.board) return;
    clearHint();
    var remaining = G.moves - G.movesUsed;
    // The sub-problem is "finish the objective from here": same board and
    // refill pointers, the moves you have left, and the REMAINDER of whatever
    // the objective asks for — points on a score Depth, creatures on a collect
    // Depth. The solver reads level.objective, so a collect hint searches for
    // the line that gathers the most of that colour, not the highest score.
    var need = (G.objective ? G.objective.amount : G.target) -
               (G.objective ? G.progress : G.score);
    if (need <= 0 || remaining <= 0) return;
    var sub = {
      board: { rows: G.board.rows, cols: G.board.cols, grid: cloneGrid(G.board.grid) },
      refill: G.refill,
      pointers: G.pointers.slice(),
      moves: remaining,
      target: need,
      colorCount: G.colorCount
    };
    if (isCollect()) {
      sub.objective = { type: "collect", color: G.objective.color, amount: need };
    }
    var cap = TIER_NODECAP[G.meta.tier] || 500000;
    $("thinking").hidden = false;
    requestHint(sub, cap).then(function (move) {
      $("thinking").hidden = true;
      if (!move) { toast("No line from here — try Undo"); buzz([10, 40, 10]); return; }
      showHint(move);
    }).catch(function () {
      $("thinking").hidden = true;
      toast("Hint unavailable");
    });
  }
  function showHint(move) {
    var a = G.els[move.r1 + "," + move.c1], b = G.els[move.r2 + "," + move.c2];
    if (a) a.classList.add("hintA");
    if (b) b.classList.add("hintB");
    toast("Follow the current — swap the glowing pair");
    buzz(10);
  }
  function clearHint() {
    for (var k in G.els) { G.els[k].classList.remove("hintA"); G.els[k].classList.remove("hintB"); }
  }

  // hint worker wiring (falls back to main thread where workers are blocked)
  var worker = null, jobs = {}, jobId = 0;
  function mainThreadHint(sub, cap) {
    return new Promise(function (resolve, reject) {
      setTimeout(function () {
        try { resolve(SOLVER.hint(sub, { nodeCap: cap }) || null); }
        catch (e) { reject(e); }
      }, 20);
    });
  }
  function getWorker() {
    if (worker === null) {
      try {
        worker = new Worker("js/hint-worker.js");
        worker.onmessage = function (e) {
          var d = e.data, job = jobs[d.id]; if (!job) return; delete jobs[d.id];
          if (d.type === "hint") job.resolve(d.move); else job.reject(new Error(d.message || "hint failed"));
        };
        worker.onerror = function () { worker = false; fallbackJobs(); };
      } catch (e) { worker = false; }
    }
    return worker;
  }
  function fallbackJobs() {
    var pending = jobs; jobs = {};
    Object.keys(pending).forEach(function (id) {
      var j = pending[id]; mainThreadHint(j.sub, j.cap).then(j.resolve, j.reject);
    });
  }
  function requestHint(sub, cap) {
    var w = getWorker();
    if (!w) return mainThreadHint(sub, cap);
    return new Promise(function (resolve, reject) {
      var id = ++jobId; jobs[id] = { resolve: resolve, reject: reject, sub: sub, cap: cap };
      try { w.postMessage({ type: "hint", id: id, level: sub, nodeCap: cap }); }
      catch (e) { delete jobs[id]; mainThreadHint(sub, cap).then(resolve, reject); }
    });
  }

  // ------------------------------------------------------------- HUD --
  // WHICH Depth a tide is built on is deliberately not shown.
  //
  // A Daily or Weekly tide is a known Depth recoloured by a date-seeded colour
  // permutation, so it is genuinely a fresh puzzle to solve — but the moment the
  // screen says "Depth 37" the player reads it as a Depth they already cleared
  // and plays it as a re-run. Naming the tide instead of its Depth costs nothing
  // (the underlying level is still whatever it was) and keeps the thing feeling
  // like its own puzzle, which is what it actually is.
  //
  // Returns null for anything that has no reason to hide: the campaign names its
  // Depth, and a Trench rung IS its number.
  function tideLabel() {
    if (G.trench) return null;
    if (G.weekly !== null && G.weekly !== undefined) {
      var st = ECON ? ECON.weeklyState(TOTAL) : null;
      var day = st && st.slots[G.weekly] ? st.slots[G.weekly].day : null;
      return day ? day + "'s Tide" : "Weekly Tide";
    }
    if (G.challenge) return "Tide #" + (ECON ? ECON.tideNumber() : 0);
    return null;
  }

  // The level chip on the win/lose screens. The <b> is kept alive under its usual
  // id whether or not the level is named, because several win paths address it
  // directly by id and would throw on a chip that had dropped it.
  function setLevelChip(sel, bid, n) {
    var tide = tideLabel();
    document.querySelector(sel).innerHTML = tide
      ? tide + ' <b id="' + bid + '" hidden></b>'
      : 'Depth <b id="' + bid + '">' + n + "</b>";
  }

  function updateHUD() {
    $("depthPill").textContent = tideLabel() ||
      (G.trench ? ("Trench " + G.trench) : ("Depth " + G.depth));
    var left = Math.max(0, G.moves - G.movesUsed);
    $("movesLeft").textContent = left;
    document.querySelector(".moves-pill").classList.toggle("low", left <= 1);
    var goal = G.objective ? G.objective.amount : G.target;
    var have = G.objective ? G.progress : G.score;
    if (isCollect()) {
      // The bar reads "creatures collected", and the emblem says which kind.
      $("scoreNow").innerHTML = have + ' <span class="objmark" style="color:' +
        HUE[G.objective.color] + '"><svg viewBox="0 0 24 24">' +
        EMBLEM[G.objective.color] + "</svg></span>";
      $("scoreTarget").textContent = goal;
    } else {
      $("scoreNow").textContent = G.score;
      $("scoreTarget").textContent = G.target;
    }
    var pct = Math.min(100, Math.round(have / goal * 100));
    $("pbarFill").style.width = pct + "%";
    document.querySelector(".pbar").classList.toggle("done", have >= goal);
    document.querySelector(".progress").classList.toggle("collect", isCollect());
    var banner = $("objGoal");
    if (isCollect()) {
      banner.innerHTML = 'Collect <b>' + G.objective.amount + '</b>' +
        '<span class="objmark" style="color:' + HUE[G.objective.color] + '">' +
        '<svg viewBox="0 0 24 24">' + EMBLEM[G.objective.color] + "</svg></span>" +
        " before your moves run out";
      banner.hidden = false;
    } else {
      banner.hidden = true;
      banner.innerHTML = "";   // belt and braces: nothing stale to leak back if
                               // the [hidden] rule is ever lost again
    }
    $("btn-undo").disabled = !G.history.length || G.animating;
    $("btn-mute").innerHTML = SND.isMuted() ? "&#128263;" : "&#128266;";
    if (ECON) {
      $("shellsPill").innerHTML = "&#128026; " + ECON.balance();
      $("btn-claw").disabled = G.animating || !ECON.canAfford("claw");
      $("btn-current").disabled = G.animating || !ECON.canAfford("current");
    }
  }

  // ------------------------------------------------------------- win --
  // Stars are earned in the objective's own currency: points on a score Depth,
  // creatures collected on a collect Depth (see starBands).
  function starsFor(value) {
    var b = starBands();
    var n = 1;
    if (value >= b.two) n = 2;
    if (value >= b.three) n = 3;
    return n;
  }
  function starValue() { return isCollect() ? G.progress : G.score; }

  function win() {
    G.over = true;
    clearSelected();
    if (G.trench) { winTrench(); return; }
    if (G.weekly !== null && G.weekly !== undefined) { winWeekly(); return; }
    if (G.challenge) { winChallenge(); return; }
    var earned = starsFor(starValue());
    var prev = progress.stars[G.depth] || 0;
    if (earned > prev) progress.stars[G.depth] = earned;
    recordBest(G.depth, starValue());
    if (G.depth + 1 <= TOTAL) progress.unlocked = Math.max(progress.unlocked, G.depth + 1);
    else progress.unlocked = TOTAL;
    progress.streak = (progress.streak || 0) + 1;
    saveProgress();
    lsDel("tp-save");

    // restore the standard texts FIRST (a challenge win rewrites them, and the
    // win-depth2 element must exist before we address it by id)
    document.querySelector("#screen-win .win-h").textContent = "Surfaced!";
    document.querySelector("#screen-win .win-sub").innerHTML =
      'Depth <b id="win-depth2">' + G.depth + "</b> cleared";
    // the headline stat is whatever the Depth actually asked of you
    document.querySelectorAll("#screen-win .stat .l")[0].textContent =
      isCollect() ? "Collected" : "Score";
    // written whole, because a tide win may have left a named chip here
    setLevelChip("#screen-win .hud .depth", "win-depth", G.depth);
    $("win-depth2").textContent = G.depth;
    var stars = $("win-stars"); stars.innerHTML = "";
    for (var i = 1; i <= 3; i++) {
      var sp = document.createElement("span");
      sp.className = i <= earned ? "on" : "off";
      sp.style.animationDelay = (i * 0.14) + "s";
      sp.innerHTML = "&#9733;";
      stars.appendChild(sp);
    }
    $("win-moves").textContent = G.movesUsed + "/" + G.moves;
    $("win-streak").textContent = "×" + progress.streak;

    // shell rewards (base + stars + daily dive + star milestones)
    if (ECON) {
      var rw = ECON.awardWin(G.meta.tier, earned, totalStars());
      var bits = [rw.base + " win", rw.stars + " stars"];
      if (rw.daily) bits.push(rw.daily + " daily dive");
      rw.milestones.forEach(function (m) { bits.push(m.bonus + " for " + m.at + "★ milestone"); });
      $("reward-total").textContent = rw.total;
      $("reward-detail").textContent = bits.join(" · ");
      $("win-reward").hidden = false;
    }
    // A species logged, announced in the moment it happens. Only on a FIRST
    // clear (prev === 0) — replaying Depth 6 for a third star should not keep
    // re-announcing the anemone you catalogued weeks ago.
    var found = (typeof TideAlbum !== "undefined" && prev === 0)
      ? TideAlbum.speciesAt(G.depth) : null;
    if (found) {
      $("find-ic").textContent = found.icon;
      $("find-name").textContent = "Logged: " + found.name;
      $("find-note").textContent = found.note;
      $("win-find").hidden = false;
    } else {
      $("win-find").hidden = true;
    }

    // What the next star would take. Skipped on a 3-star clear — there is
    // nothing left to chase, and a full set of bars would just be noise on the
    // one screen that should feel like a clean finish.
    if (earned < 3) {
      renderStarBands($("win-bands"), G.meta, starValue(), earned, "end");
    } else {
      $("win-bands").hidden = true;
    }

    // hide Next Depth on the final depth (and undo any Trench relabelling)
    $("btn-win-next").textContent = "Next Depth";
    $("btn-win-next").style.display = (G.depth >= TOTAL) ? "none" : "";

    SND.win(); buzz([12, 40, 20, 40, 12]);
    show("win");
    countUp($("win-score"), starValue(), 900);
    celebrate();
  }

  // Challenge win: campaign progress/streak/save untouched; the +100 reward is
  // claimable once per day (replays after claiming are just for glory).
  function winChallenge() {
    var stars = $("win-stars"); stars.innerHTML = "";
    for (var i = 1; i <= 3; i++) {
      var sp = document.createElement("span");
      sp.className = "on"; sp.style.animationDelay = (i * 0.14) + "s";
      sp.innerHTML = "&#9733;"; stars.appendChild(sp);
    }
    $("win-moves").textContent = G.movesUsed + "/" + G.moves;
    $("win-streak").textContent = "✓";
    // the Daily Tide is always played to a score bar, whatever the underlying
    // Depth asks for in the campaign
    document.querySelectorAll("#screen-win .stat .l")[0].textContent = "Score";
    $("win-bands").hidden = true;   // played AT the 3-star line; no bar to chase
    $("win-find").hidden = true;
    document.querySelector("#screen-win .win-h").textContent = "Tide mastered!";
    // keep id="win-depth2" alive — the campaign win() writes to it by id
    setLevelChip("#screen-win .hud .depth", "win-depth", G.depth);
    document.querySelector("#screen-win .win-sub").innerHTML =
      'Daily Tide #' + (ECON ? ECON.tideNumber() : 0) +
      ' cleared <b id="win-depth2" hidden></b>';
    var rw = ECON ? ECON.claimChallenge() : null;
    if (rw) {
      $("reward-total").textContent = rw.amount;
      $("reward-detail").textContent = rw.bonus
        ? rw.base + " tide · " + rw.bonus + " for a " + rw.streak + "-day streak"
        : "Daily Tide reward";
      $("win-reward").hidden = false;
      $("win-streak").textContent = rw.streak + "d";
    } else {
      $("win-reward").hidden = true;   // already claimed today
    }
    $("btn-win-next").style.display = "none";
    SND.win(); buzz([12, 40, 20, 40, 12]);
    show("win");
    countUp($("win-score"), starValue(), 900);
    celebrate();
  }

  // Weekly Tide win: the slot is marked cleared and pays once; the seventh
  // clear of the week also pays the completion bonus. Campaign state untouched.
  function winWeekly() {
    var slotIndex = G.weekly;
    var rw = ECON ? ECON.completeWeeklySlot(slotIndex, TOTAL) : null;
    var st = ECON ? ECON.weeklyState(TOTAL) : null;
    var dayName = st ? st.slots[slotIndex].day : "";

    setLevelChip("#screen-win .hud .depth", "win-depth", G.depth);
    var stars = $("win-stars"); stars.innerHTML = "";
    for (var i = 1; i <= 3; i++) {
      var sp = document.createElement("span");
      sp.className = "on"; sp.style.animationDelay = (i * 0.14) + "s";
      sp.innerHTML = "&#9733;"; stars.appendChild(sp);
    }
    $("win-moves").textContent = G.movesUsed + "/" + G.moves;
    $("win-streak").textContent = st ? (st.doneCount + "/7") : "✓";
    // a Weekly slot plays the Depth as it is, so it inherits that Depth's
    // objective — label the stat for whichever it turned out to be
    document.querySelectorAll("#screen-win .stat .l")[0].textContent =
      isCollect() ? "Collected" : "Score";
    $("win-bands").hidden = true;   // a slot's stars are ceremonial, not chaseable
    $("win-find").hidden = true;
    document.querySelector("#screen-win .win-h").textContent =
      (rw && rw.complete) ? "Full tide!" : "Tide cleared!";
    // keep id="win-depth2" alive — the campaign win() writes to it by id
    document.querySelector("#screen-win .win-sub").innerHTML =
      "Weekly Tide &middot; " + dayName + " cleared <b id=\"win-depth2\" hidden></b>";

    if (rw) {
      var bits = [rw.slot + " for " + dayName];
      if (rw.bonus) bits.push(rw.bonus + " for the full week");
      $("reward-total").textContent = rw.total;
      $("reward-detail").textContent = bits.join(" · ");
      $("win-reward").hidden = false;
    } else {
      $("win-reward").hidden = true;   // this slot was already cleared this week
    }
    $("btn-win-next").style.display = "none";
    SND.win(); buzz([12, 40, 20, 40, 12]);
    show("win");
    countUp($("win-score"), G.score, 900);
    celebrate();
  }

  function countUp(el, to, dur) {
    if (prefersReduced()) { el.textContent = to; return; }
    var t0 = null;
    function step(ts) {
      if (t0 === null) t0 = ts;
      var f = Math.min(1, (ts - t0) / dur);
      var e = 1 - Math.pow(1 - f, 3);
      el.textContent = Math.round(to * e);
      if (f < 1) requestAnimationFrame(step); else el.textContent = to;
    }
    requestAnimationFrame(step);
  }

  function celebrate() {
    var rl = $("rippleLayer"), pl = $("planktonLayer");
    rl.innerHTML = ""; pl.innerHTML = "";
    if (prefersReduced()) return;
    for (var i = 0; i < 3; i++) {
      var rp = document.createElement("div");
      rp.className = "ripple"; rp.style.animationDelay = (i * 0.35) + "s";
      rl.appendChild(rp);
    }
    for (var j = 0; j < 26; j++) {
      var p = document.createElement("div");
      p.className = "plank";
      var col = HUE[1 + (j % 6)];
      p.style.left = (18 + Math.random() * 64) + "%";
      p.style.top = (36 + Math.random() * 26) + "%";
      p.style.background = col;
      p.style.boxShadow = "0 0 8px " + col;
      p.style.animationDelay = (Math.random() * 1.2) + "s";
      pl.appendChild(p);
    }
  }

  // ------------------------------------------------------- near-miss read --
  // "Short by 900" tells a player they lost. It does not tell them whether the
  // dive was nearly right or hopeless, and that difference is what decides
  // between a retry and a quit. So the lose screen says WHY, using the same
  // solver that grades the level:
  //
  //   1. If the shortfall is smaller than the best single move they actually
  //      played, the honest read is "one more move like that one".
  //   2. Otherwise, rewind to the position before their last move and ask the
  //      solver whether a win was still available from there. If it was, the
  //      dive was live to the end and a different final swap would have done it.
  //
  // Both are statements of fact about this dive, not encouragement — the point
  // is to tell the player something true they could not see for themselves.
  // Runs through the hint worker, so the lose screen never waits on it.
  function nearMissRead(shortfall) {
    var goal = G.objective ? G.objective.amount : G.target;
    var unit = isCollect() ? "" : " points";

    if (G.bestMoveGain && shortfall <= G.bestMoveGain) {
      setLoseInsight("One more move like your best (" + fmt(G.bestMoveGain) +
                     unit + ") would have surfaced you.");
      return;
    }
    var h = G.history.length ? G.history[G.history.length - 1] : null;
    if (!h) return;
    var movesLeftThen = G.moves - h.movesUsed;
    var needThen = goal - (h.progress || 0);
    if (movesLeftThen <= 0 || needThen <= 0) return;

    var sub = {
      board: { rows: G.board.rows, cols: G.board.cols, grid: cloneGrid(h.grid) },
      refill: G.refill,
      pointers: h.pointers.slice(),
      moves: movesLeftThen,
      target: needThen,
      colorCount: G.colorCount
    };
    if (isCollect()) {
      sub.objective = { type: "collect", color: G.objective.color, amount: needThen };
    }
    requestHint(sub, TIER_NODECAP[G.meta.tier] || 500000).then(function (move) {
      if (!move) return;                       // no win existed; say nothing
      setLoseInsight(movesLeftThen === 1
        ? "A different final swap would have got you there."
        : "Your last " + movesLeftThen + " moves had a winning line in them.");
    }).catch(function () {});
  }
  function setLoseInsight(text) {
    // only if the player is still looking at the screen this refers to
    if (G.screen !== "lose") return;
    var el = $("lose-msg");
    if (el) el.textContent = text;
  }

  // ------------------------------------------------------------- lose --
  // `instant`: skip the desaturate pause and reveal the lose screen immediately.
  // Used when coming from the rescue modal, so the in-game board never flashes
  // between the modal closing and the lose screen appearing.
  function lose(instant) {
    G.over = true;
    clearSelected();
    if (!G.challenge) {                      // a lost challenge costs nothing
      progress.streak = 0; saveProgress();
      recordBest(G.depth, starValue());      // a near miss is still your best
      lsDel("tp-save");
    }
    // A failed rung ends the Trench run and banks how deep it got.
    if (G.trench && typeof TideTrench !== "undefined") {
      TideTrench.recordRun(G.trench - 1);
    }
    // Report the miss in the objective's own currency — telling a collect player
    // they were "3000 points short" of a goal they were never chasing is noise.
    var goal = G.objective ? G.objective.amount : G.target;
    var have = G.objective ? G.progress : G.score;
    var pct = Math.max(0, Math.round(have / goal * 100));
    var short = Math.max(0, goal - have);
    // encouraging copy that scales with how close you got
    var head, msg;
    if (pct >= 90) { head = "So close!"; msg = "A whisker away — the tide is basically yours."; }
    else if (pct >= 70) { head = "Almost surfaced"; msg = "You've got the rhythm now. One more dive."; }
    else if (pct >= 40) { head = "Washed out"; msg = "Regroup and try a fresh line down."; }
    else { head = "Washed out"; msg = "Shake off the salt and dive again."; }
    setLevelChip("#screen-lose .hud .depth", "lose-depth", G.depth);
    $("lose-h").textContent = head;
    $("lose-msg").textContent = msg;
    $("lose-target").textContent = goal;
    $("lose-short").textContent = short;
    document.querySelectorAll("#screen-lose .stat .l")[0].textContent =
      isCollect() ? "Collected" : "Score";
    $("lose-pct").textContent = pct + "%";
    $("lose-bar").style.width = Math.min(100, pct) + "%";
    $("lose-prog-fill").style.width = "0%";
    // gentle rising bubbles (life, not a celebration); a near-miss adds gold ones
    var bub = $("loseBubbles"); bub.innerHTML = "";
    if (!prefersReduced()) {
      for (var i = 0; i < 16; i++) {
        var b = document.createElement("div"); b.className = "lb";
        var sz = 4 + Math.random() * 9;
        b.style.width = b.style.height = sz + "px";
        b.style.left = Math.random() * 100 + "%";
        b.style.animationDuration = (6 + Math.random() * 7) + "s";
        b.style.animationDelay = (Math.random() * 5) + "s";
        if (pct >= 90 && Math.random() < 0.4) {
          b.style.background = "rgba(203,178,122,.3)";
          b.style.boxShadow = "0 0 7px rgba(203,178,122,.5)";
        }
        bub.appendChild(b);
      }
    }
    document.body.classList.add("lose-desat");
    SND.lose(); buzz([12, 30, 12]);
    // Every bar and the gap to it, so a retry starts with a number to beat
    // rather than just "you lost".
    if (endBandsApply()) renderStarBands($("lose-bands"), G.meta, have, 0, "end");
    else $("lose-bands").hidden = true;

    var reveal = function () {
      show("lose");
      countUp($("lose-score"), have, 800);
      $("lose-prog-fill").style.width = Math.min(100, pct) + "%";
      nearMissRead(short);   // fills in the specific reason when it resolves
    };
    if (instant || prefersReduced()) reveal();
    else setTimeout(reveal, 620);
  }

  // ------------------------------------------------------------- share --
  function share() {
    var text;
    if (G.challenge && G.weekly === null) {
      // A Daily Tide result is COMPARABLE: everyone played the same board today,
      // so score and moves mean the same thing to whoever reads it. The little
      // wave bar is the at-a-glance version — how far past the bar you got.
      var over = G.target ? G.score / G.target : 1;
      var filled = Math.max(1, Math.min(5, Math.round(over * 5)));
      var bar = "";
      for (var b = 0; b < 5; b++) bar += b < filled ? "🌊" : "▫️";
      var st = ECON ? ECON.challengeState() : null;
      text = "Tide Pool — Daily Tide #" + (ECON ? ECON.tideNumber() : 0) + "\n" +
        bar + "  " + G.score + " pts · " + G.movesUsed + "/" + G.moves + " moves" +
        ((st && st.streak > 1) ? "\n🔥 " + st.streak + "-day streak" : "");
    } else {
      var earned = progress.stars[G.depth] || starsFor(starValue());
      var starStr = "";
      for (var i = 0; i < 3; i++) starStr += i < earned ? "★" : "☆";
      text = "Tide Pool — Depth " + G.depth + " surfaced! " + starStr +
        " · " + (isCollect() ? G.progress + " collected" : G.score + " pts") +
        " in " + G.movesUsed + " moves. 🌊";
    }
    function ok() { toast("Copied your dive"); }
    if (navigator.share) { navigator.share({ text: text }).catch(function () {}); return; }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(ok, function () { fallbackCopy(text, ok); });
    } else fallbackCopy(text, ok);
  }
  function fallbackCopy(text, ok) {
    try {
      var ta = document.createElement("textarea"); ta.value = text;
      ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select(); document.execCommand("copy");
      document.body.removeChild(ta); ok();
    } catch (e) { toast("Copy failed"); }
  }

  // ------------------------------------------------------------- home --
  var NODE_GAP = 80, NODE_TOP = 46;
  function renderHome() {
    $("stat-stars").textContent = totalStars();
    $("stat-depth").textContent = highestUnlocked();
    $("stat-streak").textContent = progress.streak || 0;
    if (ECON) $("stat-shells").textContent = ECON.balance();
    renderChallengeCard();
    renderWeeklyCard();
    renderTrenchCard();
    renderDecor();
    maybeShowChest();

    var cur = currentDepth();
    var sv = lsGet("tp-save", null);
    var cont = $("btn-continue");
    if (sv && saveMatchesLevel(sv)) {
      cont.textContent = "Continue · Depth " + sv.depth;
      cont.dataset.action = "resume";
    } else {
      cont.textContent = (totalStars() > 0 ? "Continue · Depth " : "Dive · Depth ") + cur;
      cont.dataset.action = "current";
    }

    buildTrail(cur);
    renderZonePill(cur);
  }

  // ---------------------------------------------------------------- zones --
  // The campaign is split into ten named stretches. Ten is the constant, not the
  // zone size: at 100 Depths a zone is 10 Depths, at 250 it is 25, so the strip
  // stays the same shape however long the campaign grows.
  var ZONE_NAMES = ["Shallows", "Tide Line", "Kelp Forest", "Reef Wall", "Sand Flats",
                    "Twilight", "Midnight", "Cold Deep", "Trench Mouth", "The Abyss"];

  function zoneList() {
    var count = Math.min(ZONE_NAMES.length, TOTAL);
    var size = Math.ceil(TOTAL / count);
    var zones = [];
    for (var i = 0; i < count; i++) {
      var from = i * size + 1;
      if (from > TOTAL) break;
      var to = Math.min(TOTAL, (i + 1) * size);
      var stars = 0;
      for (var d = from; d <= to; d++) stars += progress.stars[d] || 0;
      zones.push({
        name: ZONE_NAMES[i], from: from, to: to, stars: stars,
        max: (to - from + 1) * 3,
        locked: from > highestUnlocked()
      });
    }
    return zones;
  }

  // ---------------------------------------------------- album & rockpool --
  // Everything the player has bought, painted into the home background. Called
  // on every home render, so a purchase shows up the moment the shop closes.
  function renderDecor() {
    if (typeof TideDecor === "undefined") return;
    var layer = $("decorLayer");
    if (!layer) return;
    layer.innerHTML = "";
    TideDecor.catalog().forEach(function (item) {
      var slots = TideDecor.placedSlots(item.id);   // one entry per copy that is out
      if (!slots.length) return;
      if (item.sparkle) { renderPlankton(layer, slots.length); return; }
      slots.forEach(function (slot, i) {
        // Anything that travels leaves the pool on the side it is pinned to, so
        // a right-edge piece heads left ("inward") and a left-edge piece heads
        // right. `swim` crosses the whole pool; `roam` wanders out and back.
        var goesLeft = slot.side === "right";
        var d = document.createElement("div");
        d.className = "decor" + (item.motion ? " " + item.motion : "") +
                      ((item.motion === "roam" || item.motion === "swim") && goesLeft
                        ? " inward" : "");
        d.style.color = item.color;
        d.style.width = Math.round(item.w * slot.scale) + "px";
        d.style.height = Math.round(item.h * slot.scale) + "px";
        d.style.bottom = slot.bottom + "px";
        d.style.zIndex = item.depth;
        // side "center" places a piece relative to the middle of the pool, with
        // slot.x as a pixel nudge either way. Centring is done with marginLeft
        // rather than translateX(-50%) on purpose: a CSS animation owns the
        // transform of the element it animates, so a transform-based centring
        // would be thrown away the moment the piece started moving.
        if (slot.side === "center") {
          d.style.left = "50%";
          d.style.marginLeft = Math.round(slot.x - (item.w * slot.scale) / 2) + "px";
        } else if (slot.side === "right") {
          d.style.right = slot.x + "%";
        } else {
          d.style.left = slot.x + "%";
        }
        if (item.motion) {
          // Stagger copies so a group never moves in lockstep, and vary the
          // period so they fall out of phase over time instead of pulsing
          // together. Negative delay starts each copy mid-path.
          var BASE = { roam: 34, drift: 18, sway: 15, swim: 46 };
          d.style.animationDelay = (i * -7) + "s";
          d.style.animationDuration = ((BASE[item.motion] || 18) + i * 5) + "s";
        }

        // The inner element carries the per-copy depth fade AND the facing flip.
        // Both have to live here rather than on `d`: a CSS animation owns the
        // properties it animates, so a flip or an opacity set on the animated
        // element is silently discarded the moment it starts moving. `swim`
        // fades itself in and out on `d`, which only works because the depth
        // opacity is one level down.
        var art = document.createElement("div");
        art.className = "decor-art";
        // Later copies sit further back, so a stack reads as depth rather than
        // identical cut-outs. Floored at 60% — with six kelp groves an unbounded
        // fade left the last ones nearly invisible.
        art.style.opacity = item.opacity * Math.max(0.6, 1 - i * 0.1);
        // A creature with a front must face where it is going. `facing` art is
        // drawn heading right, so it is mirrored only when it travels left —
        // ignoring slot.flip entirely, which is what made the fish reverse.
        var flip = item.facing ? goesLeft : !!slot.flip;
        if (flip) art.style.transform = "scaleX(-1)";
        art.innerHTML = item.svg;
        d.appendChild(art);
        layer.appendChild(d);
      });
    });
  }
  function renderPlankton(layer, copies) {
    if (prefersReduced()) return;
    var n = 14 * (copies || 1);                    // more copies, denser glow
    for (var i = 0; i < n; i++) {
      var s = document.createElement("div");
      s.className = "decor-spark";
      s.style.left = (4 + Math.random() * 92) + "%";
      s.style.bottom = (30 + Math.random() * 420) + "px";
      s.style.animationDelay = (Math.random() * 9) + "s";
      s.style.animationDuration = (7 + Math.random() * 5) + "s";
      layer.appendChild(s);
    }
  }

  function openAlbum() {
    if (typeof TideAlbum === "undefined") return;
    var all = TideAlbum.speciesList();
    var found = TideAlbum.countFound(progress.stars);
    $("album-count").textContent = found;
    $("album-total").textContent = TideAlbum.total();
    var next = TideAlbum.nextAfter(progress.stars);
    $("album-next").textContent = next
      ? "clear Depth " + next.at + " for the next"
      : "every species logged";

    var grid = $("album-grid"); grid.innerHTML = "";
    all.forEach(function (sp) {
      var got = !!progress.stars[sp.at];
      var el = document.createElement("div");
      el.className = "sp" + (got ? "" : " locked");
      el.innerHTML = '<span class="sp-ic">' + (got ? sp.icon : "&#10067;") + "</span>" +
        '<span class="sp-txt">' +
          '<span class="sp-name">' + (got ? sp.name : "Unlogged") + "</span>" +
          '<span class="sp-note">' + (got ? sp.note : "Clear this Depth to log it.") + "</span>" +
          '<span class="sp-at">Depth ' + sp.at + "</span>" +
        "</span>";
      grid.appendChild(el);
    });
    $("album-modal").hidden = false;
  }

  function openShop() {
    if (typeof TideDecor === "undefined" || !ECON) return;
    $("shop-shells").textContent = ECON.balance();
    var grid = $("shop-grid"); grid.innerHTML = "";
    TideDecor.catalog().forEach(function (item) {
      var qty = TideDecor.qtyOwned(item.id);
      var out = TideDecor.qtyPlaced(item.id);
      var max = TideDecor.maxOf(item.id);
      var afford = ECON.balance() >= item.cost;
      var canBuy = TideDecor.canBuyMore(item.id);

      // A row, not a button: buying and arranging are separate actions, so a
      // tap can never spend shells by surprise.
      var row = document.createElement("div");
      row.className = "shop-item" +
        (qty && out ? " owned" : qty ? " stored" : (afford ? "" : " cant"));
      row.dataset.id = item.id;

      var swatch = item.svg
        ? '<span class="shop-swatch" style="color:' + item.color + ';opacity:' +
          (qty && !out ? 0.35 : Math.min(1, item.opacity + 0.35)) + '">' + item.svg + "</span>"
        : '<span class="shop-swatch" style="font-size:1.2rem">&#10024;</span>';

      // Says only what is true of THIS row: how many of the ones you own are
      // currently out. Whether you can buy more is the buy control's job — an
      // earlier version appended "pool is full" here, which read as "no room to
      // place" when it actually meant "you already own the maximum".
      var sub = qty ? out + " of " + qty + " in the pool" : item.blurb;

      // stepper only once you own one; buy chip only while a slot remains
      var controls = "";
      if (qty) {
        controls =
          '<span class="qty">' +
            '<button class="qbtn" data-act="minus"' + (out <= 0 ? " disabled" : "") +
              ' aria-label="Take one out">&minus;</button>' +
            '<b class="qn">' + out + "</b>" +
            '<button class="qbtn" data-act="plus"' + (out >= qty ? " disabled" : "") +
              ' aria-label="Put one back">+</button>' +
          "</span>";
      }
      var buy = canBuy
        ? '<button class="buybtn' + (afford ? "" : " cant") + '" data-act="buy">' +
            (qty ? "another " : "") + item.cost + "&#128026;</button>"
        : '<span class="buymax">all ' + max + " owned</span>";

      row.innerHTML = swatch +
        '<span class="shop-txt"><span class="shop-name">' + item.name +
          (qty > 1 ? ' <span class="owncount">×' + qty + "</span>" : "") + "</span>" +
        '<span class="shop-blurb">' + sub + "</span></span>" +
        '<span class="shop-actions">' + controls + buy + "</span>";
      grid.appendChild(row);
    });
    $("shop-modal").hidden = false;
  }

  // Three explicit actions per row: buy another, put one out, take one in.
  function shopAction(id, act) {
    var item = TideDecor.itemById(id);
    if (!item) return;
    if (act === "buy") { buyDecor(id); return; }

    var changed = act === "plus" ? TideDecor.placeOne(id) : TideDecor.removeOne(id);
    if (!changed) return;
    SND.select(); buzz(8);
    var out = TideDecor.qtyPlaced(id);
    toast(act === "plus"
      ? item.name + " placed — " + out + " in your pool"
      : (out ? item.name + " — " + out + " left in your pool"
             : item.name + " taken out, still yours"));
    openShop();
    renderDecor();
  }

  function buyDecor(id) {
    var item = TideDecor.itemById(id);
    if (!item) return;
    if (!TideDecor.canBuyMore(id)) {
      toast("The pool has room for " + TideDecor.maxOf(id) + " of those");
      buzz(20);
      return;
    }
    if (ECON.balance() < item.cost) {
      toast("Not enough shells — " + (item.cost - ECON.balance()) + " to go");
      buzz(20);
      return;
    }
    // spend() only knows booster names, so take the cost directly and record it
    if (!ECON.spendShells(item.cost)) { toast("Not enough shells"); return; }
    TideDecor.grant(id);
    SND.special(); buzz([10, 30, 14]);
    var n = TideDecor.qtyOwned(id);
    toast(n > 1 ? item.name + " ×" + n + " in your pool"
                : item.name + " added to your pool");
    openShop();          // refresh costs/affordability
    renderDecor();
    if (ECON) $("stat-shells").textContent = ECON.balance();
  }

  // ------------------------------------------------------------ depth card --
  var TIER_LABEL = { easy: "Easy", medium: "Medium", hard: "Hard" };

  function fmt(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }

  // What this Depth asks for, as a phrase plus the creature emblem when it is a
  // collect Depth. Shared by the card and the goal line.
  function goalHtml(meta) {
    if (meta.objective && meta.objective.type === "collect") {
      return "Collect " + meta.objective.amount +
        '<span class="objmark" style="color:' + HUE[meta.objective.color] + '">' +
        '<svg viewBox="0 0 24 24">' + EMBLEM[meta.objective.color] + "</svg></span>" +
        " in " + meta.moves + " moves";
    }
    return "Reach " + fmt(meta.target) + " in " + meta.moves + " moves";
  }
  function bandsFor(meta) {
    if (meta.objective && meta.objective.type === "collect") {
      return { one: meta.objective.amount, two: meta.objStar2, three: meta.objStar3,
               unit: "" };
    }
    return { one: meta.target, two: meta.star2, three: meta.star3, unit: "" };
  }

  // The three star bars, rendered into `host`. Shared by the pre-dive card and
  // both end screens.
  //
  //   mode "card" — before a dive: which stars you already own, which is next.
  //   mode "end"  — after one: what THIS run scored against each bar, and the
  //                 gap still to close. The gap is the whole point; "3 stars =
  //                 4,920" is trivia, "you were 260 short of it" is a decision.
  function renderStarBands(host, meta, value, ownedStars, mode) {
    var b = bandsFor(meta);
    host.innerHTML = "";
    var nextTaken = false;   // only the FIRST bar you have not cleared is "next up"
    [["★", b.one, 1], ["★★", b.two, 2], ["★★★", b.three, 3]].forEach(function (row) {
      var threshold = row[1];
      var got = mode === "end" ? (value >= threshold) : (ownedStars >= row[2]);
      var isNext = !got && !nextTaken;
      if (isNext) nextTaken = true;
      var gap = threshold - value;

      var el = document.createElement("div");
      el.className = "dp-star" + (got ? " got" : "") + (isNext ? " next" : "");
      var label = got ? "earned" : (isNext ? "next up" : "");
      el.innerHTML = '<span class="s">' + row[0] + "</span>" +
        '<span class="lbl">' + label + "</span>" +
        (!got && gap > 0 && mode === "end"
          ? '<span class="d">+' + fmt(gap) + "</span>" : "") +
        '<span class="v">' + fmt(threshold) + "</span>";
      host.appendChild(el);
    });
    host.hidden = false;
  }

  // Star bars belong on an end screen only where they mean something: a campaign
  // Depth or a Trench rung, both of which have real bands you can chase on a
  // retry. The Daily Tide is played AT its 3-star line so it always awards three,
  // and a Weekly slot's stars are ceremonial — showing bars there would invite a
  // replay that cannot change the result.
  function endBandsApply() { return (!G.challenge || !!G.trench) && !!G.meta; }

  var dpDepth = 0;
  function openDepthCard(depth) {
    var meta = metaFor(depth);
    if (!meta) return;
    dpDepth = depth;
    var zones = zoneList(), zone = null;
    for (var i = 0; i < zones.length; i++) {
      if (depth >= zones[i].from && depth <= zones[i].to) { zone = zones[i]; break; }
    }
    var unlocked = isUnlocked(depth);
    var best = progress.best[depth] || 0;
    var earned = progress.stars[depth] || 0;
    var collect = !!(meta.objective && meta.objective.type === "collect");

    $("dp-title").textContent = "Depth " + depth;
    $("dp-zone").textContent = (zone ? zone.name + " · " : "") + (TIER_LABEL[meta.tier] || meta.tier);
    $("dp-goal").innerHTML = goalHtml(meta);
    $("dp-best").innerHTML = best
      ? "Your best: <b>" + fmt(best) + "</b>" + (collect ? " collected" : " points")
      : (earned ? "Cleared" : "Not yet dived");

    // The three bars, with the one you are chasing called out. This is the line
    // that makes a replay worth it: "you have 1 star, 5,520 gets you 3".
    renderStarBands($("dp-stars"), meta, best, earned, "card");

    var dive = $("dp-dive");
    dive.disabled = !unlocked;
    dive.textContent = !unlocked ? "Locked"
      : (earned ? (earned < 3 ? "Dive for " + (earned + 1) + "★" : "Dive again") : "Dive");
    $("depth-modal").hidden = false;
  }

  // The pill: which stretch you are in, and what it still owes you.
  function renderZonePill(cur) {
    var pill = $("btn-zone");
    var zones = zoneList();
    if (zones.length < 2) { pill.hidden = true; return; }   // nothing to jump between
    pill.hidden = false;
    var here = null;
    for (var i = 0; i < zones.length; i++) {
      if (cur >= zones[i].from && cur <= zones[i].to) { here = zones[i]; break; }
    }
    if (!here) here = zones[0];
    $("zone-name").textContent = here.name;
    $("zone-stars").innerHTML = "&#9733; " + here.stars + "/" + here.max;
    pill.setAttribute("aria-label", "You are in " + here.name + ", Depths " +
      here.from + " to " + here.to + ", " + here.stars + " of " + here.max +
      " stars. Tap to jump to another zone");
  }

  function openZoneModal() {
    var cur = currentDepth();
    var grid = $("zone-grid");
    grid.innerHTML = "";
    zoneList().forEach(function (z) {
      var isCur = cur >= z.from && cur <= z.to;
      var complete = z.stars >= z.max;
      var b = document.createElement("button");
      b.className = "zone" + (isCur ? " cur" : "") + (complete ? " done" : "") +
                    (z.locked ? " locked" : "");
      b.dataset.from = z.from;
      b.innerHTML = '<span class="zn">' + z.name + "</span>" +
        '<span class="zs">' + (z.locked ? z.from + "&ndash;" + z.to
                                        : "&#9733; " + z.stars + "/" + z.max) + "</span>";
      b.setAttribute("aria-label", z.name + ", Depths " + z.from + " to " + z.to +
        (z.locked ? ", not yet reached" : ", " + z.stars + " of " + z.max + " stars"));
      grid.appendChild(b);
    });
    $("zone-modal").hidden = false;
  }

  // Scroll the trail so `depth` sits mid-view. Shared by the zone chips, the
  // "back to your Depth" button and the initial centring.
  // Always a plain scrollTop assignment. The easing comes from CSS
  // `scroll-behavior:smooth` on .trail, so a browser that animates does, and one
  // that does not still lands on the right Depth. scrollTo({behavior:"smooth"})
  // was tried first and is the wrong tool here: it hands the scroll to the
  // compositor, so if frames are not being produced the jump silently does
  // nothing at all — the same failure mode that left the Weekly Tide bar empty.
  function scrollTrailTo(depth) {
    var trail = $("trail");
    var y = NODE_TOP + (depth - 1) * NODE_GAP;
    var h = trail.clientHeight;
    if (!h) return false;
    trail.scrollTop = Math.max(0, Math.min(trail.scrollHeight - h, y - h / 2));
    return true;
  }

  // Show the "back to Depth N" pill only once the player's own Depth has been
  // scrolled off screen — otherwise it is clutter sitting over the map.
  function updateHereButton() {
    var trail = $("trail"), btn = $("btn-here");
    var cur = currentDepth();
    var y = NODE_TOP + (cur - 1) * NODE_GAP;
    var top = trail.scrollTop, h = trail.clientHeight;
    var visible = y > top + 40 && y < top + h - 40;
    $("here-depth").textContent = cur;
    btn.hidden = visible || !h;
  }

  function buildTrail(cur) {
    var trail = $("trail");
    var inner = $("trailInner");
    var W = Math.max(240, Math.min(trail.clientWidth, 340));
    var H = NODE_TOP + (TOTAL - 1) * NODE_GAP + 130;
    inner.style.width = W + "px";
    inner.style.height = H + "px";
    var cx = W / 2, amp = W * 0.30;

    // node positions
    var pts = [];
    for (var d = 1; d <= TOTAL; d++) {
      var i = d - 1;
      var x = cx + Math.sin(i * 1.05 + 0.5) * amp;
      var y = NODE_TOP + i * NODE_GAP;
      pts.push({ x: x, y: y });
    }
    // connector path (smooth serpentine)
    var path = "M " + pts[0].x.toFixed(1) + " " + pts[0].y.toFixed(1);
    for (var k = 1; k < pts.length; k++) {
      var ym = (pts[k - 1].y + pts[k].y) / 2;
      path += " C " + pts[k - 1].x.toFixed(1) + " " + ym.toFixed(1) + " " +
        pts[k].x.toFixed(1) + " " + ym.toFixed(1) + " " +
        pts[k].x.toFixed(1) + " " + pts[k].y.toFixed(1);
    }

    var html = '<svg class="connector" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '">' +
      '<path class="base" d="' + path + '"></path><path class="flow" d="' + path + '"></path></svg>';

    var curEl = null, curY = 0;
    for (var n = 0; n < pts.length; n++) {
      var depth = n + 1;
      var p = pts[n];
      var cleared = !!progress.stars[depth];
      var isCur = (depth === cur) && !cleared && isUnlocked(depth);
      var cls = cleared ? "done" : (isCur ? "cur" : (isUnlocked(depth) ? "cur" : "lock"));
      // (an unlocked, uncleared, non-current depth cannot occur; frontier == current)
      var pip = "";
      if (cleared) {
        var stars = progress.stars[depth];
        var span = 26, startx = -((stars - 1) * 13) / 2 + 27;
        for (var s = 0; s < stars; s++) {
          var px = 27 + (s - (stars - 1) / 2) * 13;
          var py = (s === Math.floor(stars / 2) && stars % 2 === 1) ? -3 : 0;
          pip += '<div class="pip" style="left:' + px + 'px;top:' + py + 'px"></div>';
        }
      }
      html += '<button class="node ' + cls + '" data-depth="' + depth + '" style="left:' + p.x.toFixed(1) +
        'px;top:' + p.y.toFixed(1) + 'px"><span class="lvl">' + depth + '</span>' + pip + '</button>';
      if (isCur || (cleared && depth === cur)) curY = p.y;
      if (depth === cur) curY = p.y;
    }
    inner.innerHTML = html;

    // Auto-scroll to the current Depth. This can race with layout: on the
    // first frame after a screen swap the trail may still have zero height
    // (mid fade-in, or not yet displayed), which would leave the map pinned at
    // the top. Retry across a few frames until the container has laid out and
    // the scroll position actually lands.
    var tries = 0;
    (function centerOnCurrent() {
      var h = trail.clientHeight;
      if (h > 0) {
        var maxTop = Math.max(0, trail.scrollHeight - h);
        var target = Math.min(maxTop, Math.max(0, curY - h / 2));
        trail.scrollTop = target;
        if (Math.abs(trail.scrollTop - target) < 2) { updateHereButton(); return; } // landed
      }
      if (tries++ < 30) requestAnimationFrame(centerOnCurrent);
    })();
  }

  // ------------------------------------------------------------- screens --
  function show(name) {
    G.screen = name;
    ["home", "game", "win", "lose"].forEach(function (s) {
      $("screen-" + s).classList.toggle("active", s === name);
    });
    if (name === "home") { document.body.classList.remove("lose-desat"); renderHome(); }
    if (name !== "win") { $("rippleLayer").innerHTML = ""; $("planktonLayer").innerHTML = ""; }
  }

  function toast(msg, ms) {
    var el = $("toast"); el.textContent = msg; el.classList.add("show");
    if (toast._t) clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.classList.remove("show"); }, ms || 1700);
  }

  // ------------------------------------------------------------- water bg --
  function buildWater() {
    var rays = $("rays");
    [12, 46, 80].forEach(function (lx, i) {
      var d = document.createElement("div");
      d.className = "ray";
      d.style.left = lx + "%"; d.style.animationDelay = (i * 1.7) + "s";
      rays.appendChild(d);
    });
    var bubbles = $("bubbles");
    for (var i = 0; i < 16; i++) {
      var b = document.createElement("div");
      b.className = "bub";
      var s = 4 + Math.random() * 6;
      b.style.width = b.style.height = s + "px";
      b.style.left = (Math.random() * 100) + "%";
      b.style.animationDuration = (7 + Math.random() * 5) + "s";
      b.style.animationDelay = (Math.random() * 6) + "s";
      bubbles.appendChild(b);
    }
    // home kelp + drifting creatures
    var KPATH = "M20 200 C7 150 30 120 17 88 C7 58 27 40 20 0 C28 42 34 72 22 102 C34 132 12 164 20 200Z";
    var kelp = $("kelpLayer");
    var KW = 40;                                  // .kelp width, kept in sync with css
    // [ left%, height, animation delay, opacity, bottom ]
    //
    // Bottoms stay LOW — the strands are rooted at the very base of the screen,
    // which is where they read best. An earlier attempt lifted them to ~70px to
    // rescue them from the sand; that was the wrong lever, because they were
    // being painted OVER by .seabed rather than sunk into it. The kelp layer now
    // draws above the sand (see .kelp-layer), so low is both correct and fully
    // visible. Slight per-strand variation keeps the row from looking milled.
    var specs = [[4, 150, 0, .42, -4], [16, 187, .8, .54, -1], [34, 224, 1.6, .66, -6],
                 [58, 151, 2.4, .42, -3], [78, 188, 3.2, .54, 0], [96, 225, 4, .66, -5]];
    // A plain `left:X%` ignores the strand's own 40px width, so the outermost
    // one used to start past the right edge and get sliced flat — a strand that
    // looked cut in half, worse once the sway swung its top another ~14px out.
    // Insetting by the same fraction of the width makes X% read as "X% of the
    // way across", flush at 0 and 100 and clipping at neither end.
    specs.forEach(function (sp) {
      var d = document.createElement("div");
      d.className = "kelp";
      d.style.left = "calc(" + sp[0] + "% - " + (KW * sp[0] / 100).toFixed(1) + "px)";
      d.style.height = sp[1] + "px";
      d.style.animationDelay = sp[2] + "s"; d.style.opacity = sp[3];
      d.style.bottom = sp[4] + "px";
      d.innerHTML = '<svg viewBox="0 0 40 200" preserveAspectRatio="none"><path d="' + KPATH + '"></path></svg>';
      kelp.appendChild(d);
    });
    var cb = $("creaturesBg");
    // The barnacle cone used to drift at [70, 84, 6] — bottom-right, down among
    // the kelp fringe. Emblem 6 is a bare flat-bottomed triangle, and sitting
    // in a row of leaf-blade kelp it read as a snapped-off kelp tip rather than
    // as a creature. Dropped rather than relocated: every other spot down there
    // is kelp too, and the cone is the one emblem with no silhouette of its own.
    var cspecs = [[18, 42, 1], [82, 58, 3], [12, 72, 4], [88, 30, 5]];
    cspecs.forEach(function (cs, i) {
      var d = document.createElement("div");
      d.className = "creature-bg";
      d.style.left = cs[0] + "%"; d.style.top = cs[1] + "%";
      d.style.width = d.style.height = "34px";
      d.style.animationDelay = (i * 1.4) + "s";
      d.innerHTML = '<svg viewBox="0 0 24 24" style="color:' + HUE[cs[2]] + '">' +
        EMBLEM[cs[2]].replace(/rgba\(255,255,255,[^)]*\)/g, HUE[cs[2]]) + '</svg>';
      cb.appendChild(d);
    });
  }

  // ------------------------------------------------------------- helpers --
  function shade(hex, mul) {
    var c = hexRgb(hex);
    return "rgb(" + Math.min(255, Math.round(c[0] * mul)) + "," +
      Math.min(255, Math.round(c[1] * mul)) + "," + Math.min(255, Math.round(c[2] * mul)) + ")";
  }
  function hexA(hex, a) {
    var c = hexRgb(hex);
    return "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + a + ")";
  }
  function hexRgb(hex) {
    hex = hex.replace("#", "");
    return [parseInt(hex.substr(0, 2), 16), parseInt(hex.substr(2, 2), 16), parseInt(hex.substr(4, 2), 16)];
  }

  // ------------------------------------------------------------- init --
  function init() {
    buildWater();
    show("home");

    // dev/test surface, only with ?dev=1 — lets the harness drive internals that
    // are otherwise only reachable through rare in-game states (a dead board).
    if (window.__G) {
      window.__G.fn = {
        ensurePlayable: ensurePlayable,
        shuffleBoard: shuffleBoard,
        startWeekly: startWeekly
      };
    }

    // home
    $("btn-continue").addEventListener("click", function () {
      SND.resume();
      if ($("btn-continue").dataset.action === "resume") {
        var sv = lsGet("tp-save", null);
        if (sv && resumeSave(sv)) return;
      }
      startDepth(currentDepth());
    });
    // album + rockpool
    $("btn-album").addEventListener("click", function () { SND.resume(); openAlbum(); });
    $("album-close").addEventListener("click", function () { $("album-modal").hidden = true; });
    $("btn-shop").addEventListener("click", function () { SND.resume(); openShop(); });
    $("shop-close").addEventListener("click", function () {
      $("shop-modal").hidden = true;
      if (ECON) $("stat-shells").textContent = ECON.balance();
    });
    $("shop-grid").addEventListener("click", function (e) {
      var btn = e.target.closest("[data-act]");
      var row = e.target.closest(".shop-item");
      if (!btn || !row || btn.disabled) return;
      shopAction(row.dataset.id, btn.dataset.act);
    });

    // zone picker — jump to a stretch of the campaign
    $("btn-zone").addEventListener("click", function () { SND.resume(); openZoneModal(); });
    $("zone-close").addEventListener("click", function () { $("zone-modal").hidden = true; });
    $("zone-grid").addEventListener("click", function (e) {
      var z = e.target.closest(".zone");
      if (!z) return;
      SND.select();
      $("zone-modal").hidden = true;
      scrollTrailTo(+z.dataset.from);
      updateHereButton();   // directly, not via the scroll event: the jump is
                            // instant, and the pill should be too
    });
    $("btn-here").addEventListener("click", function () {
      SND.select();
      scrollTrailTo(currentDepth());
      updateHereButton();
    });
    // Throttle to one update per frame: momentum scrolling on iOS fires this
    // continuously and the pill only needs to settle, not track every pixel.
    var hereTick = false;
    $("trail").addEventListener("scroll", function () {
      if (hereTick) return;
      hereTick = true;
      requestAnimationFrame(function () { hereTick = false; updateHereButton(); });
    }, { passive: true });

    // Tapping a node opens its card rather than diving straight in. The primary
    // "Continue" button is still one tap, so progression keeps its momentum;
    // this path is the one where you are choosing a Depth deliberately, and
    // that is exactly when the target and your best matter.
    $("trailInner").addEventListener("click", function (e) {
      var node = e.target.closest(".node");
      if (!node) return;
      var depth = +node.dataset.depth;
      if (!isUnlocked(depth)) { toast("Dive deeper to unlock Depth " + depth); buzz(20); return; }
      SND.resume();
      openDepthCard(depth);
    });
    $("dp-close").addEventListener("click", function () { $("depth-modal").hidden = true; });
    $("dp-dive").addEventListener("click", function () {
      $("depth-modal").hidden = true;
      if (dpDepth) startDepth(dpDepth);
    });

    // game controls
    var board = $("board");
    board.addEventListener("pointerdown", onDown);
    board.addEventListener("pointermove", onMove);
    board.addEventListener("pointerup", onUp);
    board.addEventListener("pointercancel", function () {
      if (G.down) { pressTile(G.down.cell, false); G.down = null; }
    });
    $("btn-back").addEventListener("click", function () { armClaw(false); saveGame(); show("home"); });
    $("btn-undo").addEventListener("click", undo);
    $("btn-hint").addEventListener("click", hint);

    // Phase 2 boosters
    $("btn-claw").addEventListener("click", function () {
      if (G.animating || G.over) return;
      if (!ECON.canAfford("claw")) { toast("Not enough shells — win Depths to earn more"); return; }
      SND.select(); armClaw();
    });
    $("btn-current").addEventListener("click", function () {
      armClaw(false);
      ripCurrent();
    });
    $("rescue-yes").addEventListener("click", function () {
      if (!ECON.spend("rescue")) { $("rescue").hidden = true; lose(); return; }
      $("rescue").hidden = true;
      G.moves += 5;
      SND.win(); buzz([10, 30, 10]);
      toast("Second wind — 5 more moves");
      updateHUD(); saveGame();
    });
    $("rescue-no").addEventListener("click", function () {
      $("rescue").hidden = true;
      lose(true);   // straight to the lose screen — no in-game flash behind the modal
    });

    // daily chest + challenge
    $("chest-open").addEventListener("click", openChest);
    $("chest-done").addEventListener("click", function () { $("chest-modal").hidden = true; renderChallengeCard(); });
    $("btn-challenge").addEventListener("click", function () {
      SND.resume();
      var st = ECON.challengeState();
      var depth = ECON.dailyChallengeDepth(TOTAL);
      if (st.claimed) { toast("Challenge already mastered today — new one tomorrow"); return; }
      startChallenge(depth);
    });
    // the trench
    $("btn-trench").addEventListener("click", function () { SND.resume(); startTrench(1); });

    // weekly tide
    $("btn-weekly").addEventListener("click", function () { SND.resume(); openWeeklyModal(); });
    $("weekly-close").addEventListener("click", function () {
      $("weekly-modal").hidden = true; renderWeeklyCard();
    });
    $("week-track").addEventListener("click", function (e) {
      var b = e.target.closest(".week-slot");
      if (!b || b.disabled) return;
      var slot = +b.dataset.slot;
      var st = ECON.weeklyState(TOTAL);
      if (!st.slots[slot].unlocked) {
        toast(st.slots[slot].day + "'s tide hasn't risen yet"); buzz(20); return;
      }
      $("weekly-modal").hidden = true;
      SND.resume();
      startWeekly(slot);
    });

    $("btn-mute").addEventListener("click", function () {
      SND.toggle(); updateHUD(); if (!SND.isMuted()) SND.select();
    });

    // settings
    $("btn-settings").addEventListener("click", function () {
      SND.resume();
      $("set-sound").setAttribute("aria-checked", SND.isMuted() ? "false" : "true");
      $("settings-modal").hidden = false;
    });
    $("settings-close").addEventListener("click", function () { $("settings-modal").hidden = true; });
    $("set-sound").addEventListener("click", function () {
      var muted = SND.toggle();                 // returns the NEW muted state
      this.setAttribute("aria-checked", muted ? "false" : "true");
      $("btn-mute").innerHTML = muted ? "&#128263;" : "&#128266;";  // keep in-game icon in sync
      if (!muted) SND.select();
    });
    $("set-howto").addEventListener("click", function () {
      $("settings-modal").hidden = true; $("howto").hidden = false;
    });

    // win
    $("btn-win-map").addEventListener("click", function () { show("home"); });
    $("btn-win-next").addEventListener("click", function () {
      if (G.trench) { startTrench(G.trench + 1); return; }
      var next = G.depth + 1;
      if (next <= TOTAL) startDepth(next); else show("home");
    });
    $("btn-share").addEventListener("click", share);

    // lose
    $("btn-lose-map").addEventListener("click", function () { show("home"); });
    $("btn-lose-retry").addEventListener("click", function () {
      if (G.trench) startTrench(1);            // a Trench run restarts from the top
      else if (G.weekly !== null && G.weekly !== undefined) startWeekly(G.weekly);
      else if (G.challenge) startChallenge(G.depth);
      else startDepth(G.depth);
    });

    // how to play — opened from Settings (never auto-shown)
    $("howto-close").addEventListener("click", function () { $("howto").hidden = true; lsSet("tp-seen", 1); });

    window.addEventListener("resize", function () {
      if (G.screen === "game" && G.board) relayout();
      if (G.screen === "home") renderHome();
    });
    document.addEventListener("visibilitychange", function () {
      if (document.hidden && G.screen === "game" && !G.over) saveGame();
    });
    window.addEventListener("pagehide", function () {
      if (G.screen === "game" && !G.over) saveGame();
    });
    // block pinch/gesture zoom on the board
    document.addEventListener("gesturestart", function (e) { e.preventDefault(); });

    // relayout once fonts settle
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(function () {
        if (G.screen === "game" && G.board) relayout();
        if (G.screen === "home") renderHome();
      });
    }
  }

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("sw.js").catch(function () {});
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
