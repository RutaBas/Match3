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
  var progress = Object.assign({ unlocked: 1, stars: {}, streak: 0 }, lsGet("tp-progress", {}));
  if (!progress.stars) progress.stars = {};
  function saveProgress() { lsSet("tp-progress", progress); }

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
    history: [],
    selected: null,
    down: null,
    animating: false,
    over: false,
    clawArmed: false,
    freeMove: false,
    geom: { ts: 44 },
    els: {}
  };
  // dev/test hook, only with ?dev=1 in the URL — never active in normal play
  if (typeof location !== "undefined" && /[?&]dev=1/.test(location.search)) window.__G = G;

  // ----------------------------------------------------- level lifecycle --
  function metaFor(depth) { return LEVELS[depth - 1]; }

  function cloneGrid(grid) {
    return grid.map(function (row) {
      return row.map(function (cd) { return cd === null ? null : { color: cd.color, kind: cd.kind }; });
    });
  }
  function cloneBoard(b) { return { rows: b.rows, cols: b.cols, grid: cloneGrid(b.grid) }; }

  function startDepth(depth) {
    var m = metaFor(depth);
    if (!m) return;
    G.depth = depth; G.meta = m;
    G.board = { rows: m.board.rows, cols: m.board.cols, grid: cloneGrid(m.board.grid) };
    G.refill = m.refill;
    G.pointers = new Array(m.cols).fill(0);
    G.colorCount = m.colorCount;
    G.moves = m.moves; G.target = m.target;
    G.star2 = m.star2; G.star3 = m.star3;
    G.score = 0; G.movesUsed = 0;
    G.history = [];
    G.selected = null; G.down = null; G.animating = false; G.over = false;
    document.body.classList.remove("lose-desat");
    applyStreakGift();
    show("game");
    layoutBoard();
    buildBoard(false);
    updateHUD();
    saveGame();
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

  // Signature of a depth's DEFINITION (board+refill+moves+target). A mid-level
  // save stores it; if a shipped rebalance changes that depth, the stale save is
  // discarded (the depth restarts fresh) instead of resuming against the wrong
  // level. tp-progress (stars/unlocked/streak) is never touched by this.
  function levelSig(m) {
    var s = JSON.stringify({ b: m.board, r: m.refill, mv: m.moves, t: m.target });
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return h.toString(36);
  }
  function saveMatchesLevel(sv) {
    var m = metaFor(sv.depth);
    return !!m && sv.sig === levelSig(m);
  }

  function resumeSave(sv) {
    var m = metaFor(sv.depth);
    if (!m) return false;
    if (sv.sig !== levelSig(m)) { lsDel("tp-save"); return false; }
    G.depth = sv.depth; G.meta = m;
    G.board = { rows: m.board.rows, cols: m.board.cols, grid: cloneGrid(sv.board.grid) };
    G.refill = m.refill;
    G.pointers = sv.pointers.slice();
    G.colorCount = m.colorCount;
    G.moves = sv.movesCap || m.moves; G.target = m.target;
    G.star2 = m.star2; G.star3 = m.star3;
    G.score = sv.score; G.movesUsed = sv.movesUsed;
    G.history = (sv.history || []).map(function (h) {
      return { grid: cloneGrid(h.grid), pointers: h.pointers.slice(), score: h.score, movesUsed: h.movesUsed };
    });
    G.selected = null; G.down = null; G.animating = false; G.over = false;
    document.body.classList.remove("lose-desat");
    show("game");
    layoutBoard();
    buildBoard(false);
    updateHUD();
    return true;
  }

  function saveGame() {
    if (G.over || !G.board) return;
    lsSet("tp-save", {
      depth: G.depth,
      sig: levelSig(G.meta),
      movesCap: G.moves,          // may exceed the level's base after a rescue
      board: { grid: G.board.grid },
      pointers: G.pointers,
      score: G.score, movesUsed: G.movesUsed,
      history: G.history.map(function (h) {
        return { grid: h.grid, pointers: h.pointers, score: h.score, movesUsed: h.movesUsed };
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
    // Urchin emblem: dark strokes UNDER white ones so the spikes read on any hue.
    var emblem = cd.kind === "bomb" ? "" : cd.kind === "urchin"
      ? '<g stroke="rgba(8,18,18,.85)" stroke-width="3.4" stroke-linecap="round">' +
        '<path d="M12 1.5V7M12 17v5.5M1.5 12H7M17 12h5.5M4.2 4.2l3.6 3.6M16.2 16.2l3.6 3.6M19.8 4.2l-3.6 3.6M7.8 16.2l-3.6 3.6"/></g>' +
        '<g stroke="rgba(255,255,255,.95)" stroke-width="1.5" stroke-linecap="round">' +
        '<path d="M12 1.5V7M12 17v5.5M1.5 12H7M17 12h5.5M4.2 4.2l3.6 3.6M16.2 16.2l3.6 3.6M19.8 4.2l-3.6 3.6M7.8 16.2l-3.6 3.6"/></g>' +
        '<circle cx="12" cy="12" r="5" fill="rgba(8,18,18,.7)"/>' +
        '<circle cx="12" cy="12" r="3.4" fill="rgba(255,255,255,.9)"/>'
      : EMBLEM[cd.color];
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
      score: G.score, movesUsed: G.movesUsed
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
    if (prefersReduced() || !trace.length) { finishMove(res); return; }
    SND.select();
    if (!wasBomb) swapEls(a, b);
    setTimeout(function () { runStep(0, trace, res); }, wasBomb ? 0 : SWAP_MS);
  }

  function runStep(i, trace, res) {
    if (i >= trace.length) { finishMove(res); return; }
    var step = trace[i];
    // a) bloom + remove the cleared pieces (and only those)
    step.cleared.forEach(function (cell) {
      var k = cell.r + "," + cell.c, el = G.els[k];
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
    G.animating = false;
    updateHUD();   // after clearing animating, so the undo button re-enables
    if (G.score >= G.target) { win(); return; }
    if (G.movesUsed >= G.moves) { offerRescue(); return; }
    saveGame();
  }

  // ------------------------------------------------- Phase 2: boosters --
  // Second Wind: out of moves below target — offer +5 moves for shells
  // instead of an immediate wash-out.
  function offerRescue() {
    if (!ECON || !ECON.canAfford("rescue")) { lose(); return; }
    $("rescue-score").textContent = G.score;
    $("rescue-target").textContent = G.target;
    $("rescue").hidden = false;
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

  // Rip Current: reshuffle the board (no move consumed). Retries until the
  // layout has no ready-made match and at least one legal swap.
  function ripCurrent() {
    if (G.animating || G.over) return;
    if (!ECON.spend("current")) { toast("Not enough shells"); return; }
    clearHint(); clearSelected();
    pushHistory();
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
    clearSelected(); clearHint();
    buildBoard(false); updateHUD(); buzz(8); saveGame();
  }

  // ------------------------------------------------------------- hint --
  function hint() {
    if (G.animating || G.over || !G.board) return;
    clearHint();
    var remaining = G.moves - G.movesUsed;
    var need = G.target - G.score;
    if (need <= 0 || remaining <= 0) return;
    var sub = {
      board: { rows: G.board.rows, cols: G.board.cols, grid: cloneGrid(G.board.grid) },
      refill: G.refill,
      pointers: G.pointers.slice(),
      moves: remaining,
      target: need,
      colorCount: G.colorCount
    };
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
  function updateHUD() {
    $("depthPill").textContent = "Depth " + G.depth;
    var left = Math.max(0, G.moves - G.movesUsed);
    $("movesLeft").textContent = left;
    document.querySelector(".moves-pill").classList.toggle("low", left <= 1);
    $("scoreNow").textContent = G.score;
    $("scoreTarget").textContent = G.target;
    var pct = Math.min(100, Math.round(G.score / G.target * 100));
    $("pbarFill").style.width = pct + "%";
    document.querySelector(".pbar").classList.toggle("done", G.score >= G.target);
    $("btn-undo").disabled = !G.history.length || G.animating;
    $("btn-mute").innerHTML = SND.isMuted() ? "&#128263;" : "&#128266;";
    if (ECON) {
      $("shellsPill").innerHTML = "&#128026; " + ECON.balance();
      $("btn-claw").disabled = G.animating || !ECON.canAfford("claw");
      $("btn-current").disabled = G.animating || !ECON.canAfford("current");
    }
  }

  // ------------------------------------------------------------- win --
  function starsFor(score) {
    var n = 1;
    if (score >= G.star2) n = 2;
    if (score >= G.star3) n = 3;
    return n;
  }

  function win() {
    G.over = true;
    clearSelected();
    var earned = starsFor(G.score);
    var prev = progress.stars[G.depth] || 0;
    if (earned > prev) progress.stars[G.depth] = earned;
    if (G.depth + 1 <= TOTAL) progress.unlocked = Math.max(progress.unlocked, G.depth + 1);
    else progress.unlocked = TOTAL;
    progress.streak = (progress.streak || 0) + 1;
    saveProgress();
    lsDel("tp-save");

    $("win-depth").textContent = G.depth;
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
    // hide Next Depth on the final depth
    $("btn-win-next").style.display = (G.depth >= TOTAL) ? "none" : "";

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

  // ------------------------------------------------------------- lose --
  function lose() {
    G.over = true;
    clearSelected();
    progress.streak = 0; saveProgress();
    lsDel("tp-save");
    $("lose-depth").textContent = G.depth;
    $("lose-score").textContent = G.score;
    var pct = Math.round(G.score / G.target * 100);
    $("lose-pct").textContent = pct + "%";
    $("lose-bar").style.width = Math.min(100, pct) + "%";
    $("lose-msg").innerHTML = G.score + " / " + G.target + " &mdash; " +
      (pct >= 80 ? "so close. The tide will turn." : "regroup and dive again.");
    document.body.classList.add("lose-desat");
    SND.lose(); buzz([12, 30, 12]);
    setTimeout(function () { show("lose"); }, prefersReduced() ? 0 : 620);
  }

  // ------------------------------------------------------------- share --
  function share() {
    var earned = progress.stars[G.depth] || starsFor(G.score);
    var starStr = "";
    for (var i = 0; i < 3; i++) starStr += i < earned ? "★" : "☆";
    var text = "Tide Pool — Depth " + G.depth + " surfaced! " + starStr +
      " · " + G.score + " pts in " + G.movesUsed + " moves. 🌊";
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
  }

  function buildTrail(cur) {
    var trail = $("trail");
    var inner = $("trailInner");
    var W = Math.max(240, Math.min(trail.clientWidth, 340));
    var H = NODE_TOP + (TOTAL - 1) * NODE_GAP + 90;
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

    // auto-scroll to the current Depth
    requestAnimationFrame(function () {
      var target = Math.max(0, curY - trail.clientHeight / 2);
      trail.scrollTop = target;
    });
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
    var specs = [[4, 150, 0, .42], [16, 187, .8, .54], [34, 224, 1.6, .66], [58, 151, 2.4, .42], [78, 188, 3.2, .54], [90, 225, 4, .66]];
    specs.forEach(function (sp) {
      var d = document.createElement("div");
      d.className = "kelp";
      d.style.left = sp[0] + "%"; d.style.height = sp[1] + "px";
      d.style.animationDelay = sp[2] + "s"; d.style.opacity = sp[3];
      d.innerHTML = '<svg viewBox="0 0 40 200" preserveAspectRatio="none"><path d="' + KPATH + '"></path></svg>';
      kelp.appendChild(d);
    });
    var cb = $("creaturesBg");
    var cspecs = [[18, 42, 1], [82, 58, 3], [12, 72, 4], [88, 30, 5], [70, 84, 6]];
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

    // home
    $("btn-continue").addEventListener("click", function () {
      SND.resume();
      if ($("btn-continue").dataset.action === "resume") {
        var sv = lsGet("tp-save", null);
        if (sv && resumeSave(sv)) return;
      }
      startDepth(currentDepth());
    });
    $("trailInner").addEventListener("click", function (e) {
      var node = e.target.closest(".node");
      if (!node) return;
      var depth = +node.dataset.depth;
      if (!isUnlocked(depth)) { toast("Dive deeper to unlock Depth " + depth); buzz(20); return; }
      SND.resume(); startDepth(depth);
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
      lose();
    });
    $("btn-mute").addEventListener("click", function () {
      SND.toggle(); updateHUD(); if (!SND.isMuted()) SND.select();
    });

    // win
    $("btn-win-map").addEventListener("click", function () { show("home"); });
    $("btn-win-next").addEventListener("click", function () {
      var next = G.depth + 1;
      if (next <= TOTAL) startDepth(next); else show("home");
    });
    $("btn-share").addEventListener("click", share);

    // lose
    $("btn-lose-map").addEventListener("click", function () { show("home"); });
    $("btn-lose-retry").addEventListener("click", function () { startDepth(G.depth); });

    // how to play — opened on demand from the home button (never auto-shown)
    $("btn-howto").addEventListener("click", function () { $("howto").hidden = false; });
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
