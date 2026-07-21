/*
 * logic.js — Candy-Crush-dupe core engine (pure, headless, zero DOM).
 *
 * Runs under Node (module.exports) and the browser (root.CandyLogic).
 *
 * ---------------------------------------------------------------------------
 * DETERMINISM (the whole point)
 * ---------------------------------------------------------------------------
 * A level is a fixed start board + a fixed PER-COLUMN refill queue + a move
 * budget + a target score. Given the start board, the refill queues and a move
 * sequence, the ENTIRE game — every cascade — is reproducible. No randomness
 * lives here; all randomness lives in the seeded RNG the generator uses.
 *
 * BOARD MODEL
 *   board = { rows, cols, grid } where grid[r][c] is a candy or null.
 *   candy = { color:int>=1, kind:'normal'|'stripe-h'|'stripe-v'|'urchin'|'bomb' }.
 *     - color bomb ('bomb', the "pearl") is a WILDCARD: it carries color 0 and
 *       never takes part in a color run; it only fires when swapped (activation).
 *     - striped candies AND urchins keep a real color and DO take part in
 *       color runs.
 *   refill = array (length cols); refill[c] is that column's fixed queue of
 *     upcoming color ints. A per-column pointer array tracks the next draw.
 *
 * COORDINATE / GRAVITY CONVENTION
 *   Row 0 is the TOP. Candies fall DOWN (toward larger r). Refill enters from
 *   the top. After gravity, all empty cells in a column are contiguous at the
 *   top; they are filled bottom-most-empty first, drawing the column queue in
 *   order (so the first queued candy lands lowest). If a column queue is
 *   exhausted it wraps cyclically (documented fallback; the generator sizes
 *   queues so this never bites in practice).
 *
 * MATCH / CLEAR / SPECIALS  (see resolveInternal for the exact ordering)
 *   - A match is a maximal horizontal or vertical run of >=3 same color.
 *   - run of exactly 4  -> a STRIPED candy is created at the swap cell (or the
 *     run midpoint during a cascade). Horizontal run -> 'stripe-h' (clears its
 *     ROW when fired); vertical run -> 'stripe-v' (clears its COLUMN).
 *   - L/T shape (an h-run >=3 and a v-run >=3, same color, sharing a cell,
 *     >=5 distinct cells total) -> an URCHIN is created at the shared cell (or
 *     a swap cell on the union). Fires a 3x3 blast centered on itself.
 *   - run of >=5 in a straight line -> a COLOR BOMB is created at the swap/mid
 *     cell. Creation priority per color-group when overlapping runs compete:
 *     straight-5 pearl > urchin (L/T) > stripe; a run consumed by an urchin
 *     creation cannot also mint a stripe (see computeCreations).
 *   - a striped candy or urchin caught in a clear FIRES (row/column, or 3x3);
 *     firing chains (a fired special can set off other specials). A color bomb
 *     only fires via SWAP activation (see applyMove); a bomb merely caught in a
 *     cascade clear is removed without its all-color effect (keeps the cascade
 *     unambiguous — a bomb has no color to key on outside a swap).
 *   - SPECIAL+SPECIAL swaps are ACTIVATIONS: always legal, no match required
 *     (stripe/urchin swapped with a NORMAL candy stays match-required). The
 *     effect resolves as a forced initial clear, then normal cascading; the two
 *     swapped specials are CONSUMED (cleared + scored, but they do not re-fire
 *     their own single effect). See comboClear for the exact cell unions.
 *
 * SCORING
 *   BASE_SCORE (60) points per cleared candy, times a combo multiplier that
 *   starts at 1 for the swap's own match and increments by 1 for each further
 *   cascade step. score(step) = clearedCount * BASE_SCORE * combo.
 */
(function (root, factory) {
  "use strict";
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory();
  } else {
    root.CandyLogic = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var BASE_SCORE = 60;

  // --------------------------------------------------------------- candies --

  function makeCandy(color, kind) {
    return { color: color, kind: kind || "normal" };
  }
  function cloneCandy(cd) {
    return cd === null ? null : { color: cd.color, kind: cd.kind };
  }

  // matchColor: the value a cell contributes to color runs. Real colors are
  // >=1; a bomb contributes 0 (never groups); an empty cell contributes -1.
  function matchColor(cd) {
    if (cd === null) return -1;
    if (cd.kind === "bomb") return 0;
    return cd.color;
  }
  function isSpecial(cd) {
    return cd !== null && cd.kind !== "normal";
  }

  // ----------------------------------------------------------- board utils --

  function makeEmptyBoard(rows, cols) {
    var grid = [];
    for (var r = 0; r < rows; r++) {
      var row = [];
      for (var c = 0; c < cols; c++) row.push(null);
      grid.push(row);
    }
    return { rows: rows, cols: cols, grid: grid };
  }

  function cloneBoard(board) {
    var grid = new Array(board.rows);
    for (var r = 0; r < board.rows; r++) {
      var src = board.grid[r], row = new Array(board.cols);
      for (var c = 0; c < board.cols; c++) row[c] = cloneCandy(src[c]);
      grid[r] = row;
    }
    return { rows: board.rows, cols: board.cols, grid: grid };
  }

  function inBounds(board, r, c) {
    return r >= 0 && r < board.rows && c >= 0 && c < board.cols;
  }

  // Single-char-per-cell encoding (colors 1..6):
  //   '.' empty  |  '1'..'6' normal  |  'a'..'f' stripe-h  |
  //   'A'..'F' stripe-v  |  'g'..'l' urchin  |  '*' bomb.
  function cellChar(cd) {
    if (cd === null) return ".";
    if (cd.kind === "bomb") return "*";
    if (cd.kind === "stripe-h") return String.fromCharCode(96 + cd.color);  // a..
    if (cd.kind === "stripe-v") return String.fromCharCode(64 + cd.color);  // A..
    if (cd.kind === "urchin") return String.fromCharCode(102 + cd.color);   // g..
    return String(cd.color);
  }
  function serialize(board) {
    var parts = [];
    for (var r = 0; r < board.rows; r++) {
      var row = board.grid[r], s = "";
      for (var c = 0; c < board.cols; c++) s += cellChar(row[c]);
      parts.push(s);
    }
    return board.rows + "x" + board.cols + ":" + parts.join(",");
  }

  function orthoNeighbors(board, r, c) {
    var out = [];
    if (r > 0) out.push([r - 1, c]);
    if (r + 1 < board.rows) out.push([r + 1, c]);
    if (c > 0) out.push([r, c - 1]);
    if (c + 1 < board.cols) out.push([r, c + 1]);
    return out;
  }

  function areAdjacent(a, b) {
    var dr = Math.abs(a.r - b.r), dc = Math.abs(a.c - b.c);
    return (dr + dc) === 1;
  }

  // -------------------------------------------------------------- matching --

  // Every maximal H/V run of >=3 equal real colors. Each run:
  //   { cells:[{r,c}...], dir:'h'|'v', len, color }.
  function findRuns(board) {
    var runs = [];
    var r, c;
    // horizontal
    for (r = 0; r < board.rows; r++) {
      c = 0;
      while (c < board.cols) {
        var col = matchColor(board.grid[r][c]);
        if (col >= 1) {
          var c2 = c + 1;
          while (c2 < board.cols && matchColor(board.grid[r][c2]) === col) c2++;
          var len = c2 - c;
          if (len >= 3) {
            var cellsH = [];
            for (var cc = c; cc < c2; cc++) cellsH.push({ r: r, c: cc });
            runs.push({ cells: cellsH, dir: "h", len: len, color: col });
          }
          c = c2;
        } else {
          c++;
        }
      }
    }
    // vertical
    for (c = 0; c < board.cols; c++) {
      r = 0;
      while (r < board.rows) {
        var colv = matchColor(board.grid[r][c]);
        if (colv >= 1) {
          var r2 = r + 1;
          while (r2 < board.rows && matchColor(board.grid[r2][c]) === colv) r2++;
          var lenv = r2 - r;
          if (lenv >= 3) {
            var cellsV = [];
            for (var rr = r; rr < r2; rr++) cellsV.push({ r: rr, c: c });
            runs.push({ cells: cellsV, dir: "v", len: lenv, color: colv });
          }
          r = r2;
        } else {
          r++;
        }
      }
    }
    return runs;
  }

  function hasMatch(board) {
    // Cheap early-out variant of findRuns.
    var r, c;
    for (r = 0; r < board.rows; r++) {
      for (c = 0; c + 2 < board.cols; c++) {
        var v = matchColor(board.grid[r][c]);
        if (v >= 1 && matchColor(board.grid[r][c + 1]) === v &&
            matchColor(board.grid[r][c + 2]) === v) return true;
      }
    }
    for (c = 0; c < board.cols; c++) {
      for (r = 0; r + 2 < board.rows; r++) {
        var w = matchColor(board.grid[r][c]);
        if (w >= 1 && matchColor(board.grid[r + 1][c]) === w &&
            matchColor(board.grid[r + 2][c]) === w) return true;
      }
    }
    return false;
  }

  // --------------------------------------------------------- gravity/refill --

  function drawRefill(refill, ptr, c) {
    var q = refill[c];
    if (!q || q.length === 0) return 1; // degenerate; generator never does this
    var color = q[ptr[c] % q.length];   // cyclic fallback if exhausted
    ptr[c]++;
    return color;
  }

  // Mutates board; returns a fresh pointer array. Falls candies down each
  // column, then refills empty top cells (bottom-most empty first).
  function gravityAndRefill(board, refill, pointers) {
    var ptr = pointers.slice();
    for (var c = 0; c < board.cols; c++) {
      // survivors, bottom -> up
      var survivors = [];
      for (var r = board.rows - 1; r >= 0; r--) {
        if (board.grid[r][c] !== null) survivors.push(board.grid[r][c]);
      }
      var idx = 0;
      for (var rr = board.rows - 1; rr >= 0; rr--) {
        if (idx < survivors.length) {
          board.grid[rr][c] = survivors[idx++];
        } else {
          board.grid[rr][c] = makeCandy(drawRefill(refill, ptr, c), "normal");
        }
      }
    }
    return ptr;
  }

  // --------------------------------------------------------------- resolve --

  function key(r, c) { return r + "," + c; }

  // Which runs mint a special, and where. swapCells (or null) biases the
  // creation cell onto the player's swap cell when it lies on the run (for an
  // urchin: on the UNION of its two runs).
  //
  // Creation priority per color-group when overlapping runs compete — three
  // deterministic passes:
  //   1. straight runs of >=5 -> color bomb ("pearl"), longest first;
  //   2. L/T intersections among runs not consumed by pass 1 (an h-run >=3 and
  //      a v-run >=3, same color, sharing a cell, >=5 distinct cells total) ->
  //      URCHIN at the shared cell (swap-cell bias over the union). BOTH runs
  //      are consumed: a run consumed by an urchin cannot also mint a stripe;
  //   3. remaining runs of exactly 4 -> stripe (h -> stripe-h, v -> stripe-v).
  function computeCreations(runs, swapCells) {
    var creations = [], usedCell = {}, consumed = new Array(runs.length);
    var i, j;

    function onCells(cells, r, c) {
      for (var t = 0; t < cells.length; t++) {
        if (cells[t].r === r && cells[t].c === c) return true;
      }
      return false;
    }
    // Swap-cell bias: the earliest swap cell lying on `cells`, else `fallback`.
    function pickCell(cells, fallback) {
      if (swapCells) {
        for (var s = 0; s < swapCells.length; s++) {
          if (onCells(cells, swapCells[s].r, swapCells[s].c)) {
            return { r: swapCells[s].r, c: swapCells[s].c };
          }
        }
      }
      return fallback;
    }
    function midCell(run) {
      return run.cells[Math.floor((run.len - 1) / 2)];
    }

    // Deterministic order: length desc, findRuns order (h then v, scan order)
    // as the tiebreak — matches the old stable sort behavior.
    var order = [];
    for (i = 0; i < runs.length; i++) order.push(i);
    order.sort(function (a, b) { return runs[b].len - runs[a].len || a - b; });

    // pass 1: pearls (straight >=5)
    for (i = 0; i < order.length; i++) {
      var brun = runs[order[i]];
      if (brun.len < 5) continue;
      var bcell = pickCell(brun.cells, midCell(brun));
      if (usedCell[key(bcell.r, bcell.c)]) continue;
      usedCell[key(bcell.r, bcell.c)] = 1;
      consumed[order[i]] = 1;
      creations.push({ r: bcell.r, c: bcell.c, kind: "bomb", color: 0 });
    }

    // pass 2: urchins (L/T). Scan h-runs in findRuns order; pair each with the
    // first unconsumed same-color v-run sharing a cell. (An h-run and a v-run
    // can share at most one cell: (h.row, v.col).)
    for (i = 0; i < runs.length; i++) {
      if (consumed[i] || runs[i].dir !== "h") continue;
      for (j = 0; j < runs.length; j++) {
        if (consumed[j] || runs[j].dir !== "v" || runs[j].color !== runs[i].color) continue;
        var hr = runs[i], vr = runs[j];
        var ir = hr.cells[0].r, ic = vr.cells[0].c; // the only possible shared cell
        if (!onCells(hr.cells, ir, ic) || !onCells(vr.cells, ir, ic)) continue;
        if (hr.len + vr.len - 1 < 5) continue; // >=5 distinct cells (always true for >=3 runs)
        var ucell = pickCell(hr.cells.concat(vr.cells), { r: ir, c: ic });
        if (usedCell[key(ucell.r, ucell.c)]) continue;
        usedCell[key(ucell.r, ucell.c)] = 1;
        consumed[i] = 1;
        consumed[j] = 1;
        creations.push({ r: ucell.r, c: ucell.c, kind: "urchin", color: hr.color });
        break;
      }
    }

    // pass 3: stripes (exactly 4, not consumed above)
    for (i = 0; i < order.length; i++) {
      var idx = order[i], srun = runs[idx];
      if (consumed[idx] || srun.len !== 4) continue;
      var scell = pickCell(srun.cells, midCell(srun));
      if (usedCell[key(scell.r, scell.c)]) continue;
      usedCell[key(scell.r, scell.c)] = 1;
      consumed[idx] = 1;
      creations.push({ r: scell.r, c: scell.c,
        kind: srun.dir === "h" ? "stripe-h" : "stripe-v", color: srun.color });
    }

    return creations;
  }

  // Expand a clear set by firing existing specials it contains. A stripe-h
  // clears its row, stripe-v its column, an urchin the 3x3 block centered on
  // it; firing chains. A bomb caught here just clears (it only fires via swap
  // activation). `suppress` (optional {"r,c":1} map) lists cells whose special
  // was CONSUMED by an activation combo: it clears with the set but does NOT
  // additionally fire its own single effect.
  // Returns { cells:[{r,c}...], firedAny }.
  function expandFires(board, clearCells, suppress) {
    var inSet = {}, queue = [], out = [];
    var i, c;
    for (i = 0; i < clearCells.length; i++) {
      var kk = key(clearCells[i].r, clearCells[i].c);
      if (!inSet[kk]) { inSet[kk] = 1; queue.push(clearCells[i]); }
    }
    var firedAny = false;
    var head = 0;
    while (head < queue.length) {
      var cell = queue[head++];
      out.push(cell);
      var cd = board.grid[cell.r][cell.c];
      if (isSpecial(cd) && !(suppress && suppress[key(cell.r, cell.c)])) {
        firedAny = true;
        var add = [];
        if (cd.kind === "stripe-h") {
          for (c = 0; c < board.cols; c++) {
            if (board.grid[cell.r][c] !== null) add.push({ r: cell.r, c: c });
          }
        } else if (cd.kind === "stripe-v") {
          for (var rr = 0; rr < board.rows; rr++) {
            if (board.grid[rr][cell.c] !== null) add.push({ r: rr, c: cell.c });
          }
        } else if (cd.kind === "urchin") {
          for (var dr = -1; dr <= 1; dr++) {
            for (var dc = -1; dc <= 1; dc++) {
              var ur = cell.r + dr, uc = cell.c + dc;
              if (inBounds(board, ur, uc) && board.grid[ur][uc] !== null) {
                add.push({ r: ur, c: uc });
              }
            }
          }
        }
        // bomb: no extra clears here (only fires via swap activation).
        for (i = 0; i < add.length; i++) {
          var ak = key(add[i].r, add[i].c);
          if (!inSet[ak]) { inSet[ak] = 1; queue.push(add[i]); }
        }
      }
    }
    return { cells: out, firedAny: firedAny };
  }

  // The cascade loop. `initial` is either
  //   { type:'match', swapCells:[{r,c},{r,c}] }  (normal swap; find the match), or
  //   { type:'clear', cells:[{r,c}...], suppress? } (activation swap; forced
  //     clears — suppress marks consumed specials that must not re-fire).
  // Returns { board, pointers, scoreGained, cascades, specialCreated, specialFired }.
  var MAX_CASCADES = 200;

  // `trace` (optional array): if given, each cascade step pushes
  // { cleared:[{r,c}], creations:[{r,c,color,kind}], score, boardAfter } for the
  // UI to animate. Purely observational — does not affect the returned result.
  function resolveInternal(board, refill, pointers, initial, trace) {
    var b = cloneBoard(board);
    var ptr = pointers.slice();
    var score = 0, cascades = 0, combo = 1;
    var specialCreated = false, specialFired = false;
    var first = true;

    // MAX_CASCADES is a determinism guard: a pathological refill queue (e.g. a
    // column that keeps drawing the same color) could otherwise cascade forever.
    // Real levels settle in a handful of steps; the cap only fences off
    // degenerate queues so search can never hang.
    while (cascades < MAX_CASCADES) {
      var clearCells, creations;
      if (first && initial.type === "clear") {
        clearCells = initial.cells.slice();
        creations = [];
      } else {
        var runs = findRuns(b);
        if (runs.length === 0) break;
        var seen = {}, union = [];
        for (var ri = 0; ri < runs.length; ri++) {
          var cells = runs[ri].cells;
          for (var ci = 0; ci < cells.length; ci++) {
            var kk = key(cells[ci].r, cells[ci].c);
            if (!seen[kk]) { seen[kk] = 1; union.push(cells[ci]); }
          }
        }
        clearCells = union;
        creations = computeCreations(runs, first ? initial.swapCells : null);
      }

      var exp = expandFires(b, clearCells,
        (first && initial.type === "clear") ? initial.suppress : null);
      if (exp.firedAny) specialFired = true;
      clearCells = exp.cells;

      // Creation cells survive as specials; everything else clears & scores.
      var creationKey = {};
      var cr;
      for (cr = 0; cr < creations.length; cr++) {
        creationKey[key(creations[cr].r, creations[cr].c)] = 1;
      }
      var clearedCount = 0;
      var clearedThisStep = trace ? [] : null;
      for (var ii = 0; ii < clearCells.length; ii++) {
        var cell = clearCells[ii];
        if (creationKey[key(cell.r, cell.c)]) continue;
        if (b.grid[cell.r][cell.c] !== null) {
          b.grid[cell.r][cell.c] = null;
          clearedCount++;
          if (trace) clearedThisStep.push({ r: cell.r, c: cell.c });
        }
      }
      var stepScore = clearedCount * BASE_SCORE * combo;
      score += stepScore;

      var creationsThisStep = trace ? [] : null;
      for (cr = 0; cr < creations.length; cr++) {
        b.grid[creations[cr].r][creations[cr].c] =
          makeCandy(creations[cr].color, creations[cr].kind);
        specialCreated = true;
        if (trace) creationsThisStep.push({
          r: creations[cr].r, c: creations[cr].c,
          color: creations[cr].color, kind: creations[cr].kind
        });
      }

      ptr = gravityAndRefill(b, refill, ptr);
      if (trace) trace.push({
        cleared: clearedThisStep, creations: creationsThisStep,
        score: stepScore, boardAfter: cloneBoard(b)
      });
      cascades++;
      combo++;
      first = false;
    }

    return {
      board: b, pointers: ptr, scoreGained: score, cascades: cascades,
      specialCreated: specialCreated, specialFired: specialFired
    };
  }

  // ---------------------------------------------------- activation combos --

  // Build the initial forced-clear set for an ACTIVATION swap — a swap that is
  // always legal, no match required: any swap involving a color bomb, or a
  // swap of TWO specials. Returns { cells:[{r,c}...], suppress:{"r,c":1} } or
  // null when the swap is NOT an activation (normal+normal, or a stripe/urchin
  // paired with a normal candy — those stay match-required).
  //
  // `suppress` lists CONSUMED specials: they are cleared and scored with the
  // union but do not additionally fire their own single effect in expandFires
  // (the combo's stated union IS their effect). Any OTHER special caught
  // inside the union still fires and chains normally via expandFires.
  //
  // Pair effects are centered on the swap DESTINATION cell d = (move.r2,
  // move.c2). Cell unions (clipped to the board, deterministic, no RNG):
  //   stripe+stripe  -> full row d.r + full column d.c (a cross).
  //   stripe+urchin  -> 3 rows (d.r-1..d.r+1) + 3 columns (d.c-1..d.c+1).
  //   urchin+urchin  -> the 5x5 block centered on d.
  //   bomb+stripe    -> every candy of the stripe's color becomes a stripe
  //                     ((r+c)%2===0 -> fires its ROW, else its COLUMN) and
  //                     ALL of them fire; bomb + originals consumed.
  //   bomb+urchin    -> every candy of the urchin's color fires a 3x3 blast
  //                     at its own location; bomb + originals consumed.
  //   bomb+normal    -> every candy of the partner's color clears (specials of
  //                     that color caught in the set fire via expandFires).
  //   bomb+bomb      -> the whole board.
  function comboClear(board, a, d, A, B) {
    var cells = [], have = {}, suppress = {};
    function add(r, c) {
      if (board.grid[r][c] === null) return;
      var kk = key(r, c);
      if (!have[kk]) { have[kk] = 1; cells.push({ r: r, c: c }); }
    }
    function addRow(r) {
      if (r < 0 || r >= board.rows) return;
      for (var c = 0; c < board.cols; c++) add(r, c);
    }
    function addCol(c) {
      if (c < 0 || c >= board.cols) return;
      for (var r = 0; r < board.rows; r++) add(r, c);
    }
    function addBlock(cr, cc, radius) {
      for (var r = cr - radius; r <= cr + radius; r++) {
        for (var c = cc - radius; c <= cc + radius; c++) {
          if (inBounds(board, r, c)) add(r, c);
        }
      }
    }
    var r, c, cd;

    if (A.kind === "bomb" || B.kind === "bomb") {
      var bombCell = A.kind === "bomb" ? a : d;
      var other = A.kind === "bomb" ? B : A;
      if (other.kind === "bomb") {
        // bomb + bomb: the whole board.
        for (r = 0; r < board.rows; r++) for (c = 0; c < board.cols; c++) add(r, c);
        return { cells: cells, suppress: suppress };
      }
      if (other.kind === "stripe-h" || other.kind === "stripe-v" || other.kind === "urchin") {
        // bomb + stripe / bomb + urchin: convert-and-fire every candy of the
        // partner's color; consume the bomb and all originals.
        var asUrchin = other.kind === "urchin";
        for (r = 0; r < board.rows; r++) {
          for (c = 0; c < board.cols; c++) {
            cd = board.grid[r][c];
            if (cd === null || cd.kind === "bomb" || cd.color !== other.color) continue;
            suppress[key(r, c)] = 1; // an original: converted & consumed
            add(r, c);
            if (asUrchin) addBlock(r, c, 1);
            else if ((r + c) % 2 === 0) addRow(r);
            else addCol(c);
          }
        }
        suppress[key(bombCell.r, bombCell.c)] = 1;
        add(bombCell.r, bombCell.c);
        return { cells: cells, suppress: suppress };
      }
      // bomb + normal: every candy of the partner's color + the bomb itself.
      for (r = 0; r < board.rows; r++) {
        for (c = 0; c < board.cols; c++) {
          cd = board.grid[r][c];
          if (cd !== null && cd.kind !== "bomb" && cd.color === other.color) add(r, c);
        }
      }
      add(a.r, a.c);
      add(d.r, d.c);
      return { cells: cells, suppress: suppress };
    }

    if (isSpecial(A) && isSpecial(B)) {
      // stripe/urchin pair, centered on the destination cell d. Both consumed.
      var urchins = (A.kind === "urchin" ? 1 : 0) + (B.kind === "urchin" ? 1 : 0);
      suppress[key(a.r, a.c)] = 1;
      suppress[key(d.r, d.c)] = 1;
      add(a.r, a.c);
      add(d.r, d.c);
      if (urchins === 0) {          // stripe + stripe: cross
        addRow(d.r);
        addCol(d.c);
      } else if (urchins === 1) {   // stripe + urchin: 3 rows + 3 columns
        addRow(d.r - 1); addRow(d.r); addRow(d.r + 1);
        addCol(d.c - 1); addCol(d.c); addCol(d.c + 1);
      } else {                      // urchin + urchin: 5x5 blast
        addBlock(d.r, d.c, 2);
      }
      return { cells: cells, suppress: suppress };
    }

    return null; // match-required swap (normal+normal or special+normal)
  }

  // ------------------------------------------------------------- applyMove --

  // Apply one swap. move = { r1,c1, r2,c2 } (orthogonally adjacent).
  // opts.allowSpecials (default true) permits activation swaps (any swap with
  // a color bomb, and special+special combos — see comboClear).
  // Returns { legal, board, pointers, scoreGained, cascades,
  //           specialCreated, specialFired }. On an illegal move: { legal:false }.
  function applyMove(board, refill, pointers, move, opts) {
    opts = opts || {};
    var allowSpecials = opts.allowSpecials !== false;
    var a = { r: move.r1, c: move.c1 }, d = { r: move.r2, c: move.c2 };
    if (!inBounds(board, a.r, a.c) || !inBounds(board, d.r, d.c)) return { legal: false };
    if (!areAdjacent(a, d)) return { legal: false };
    var A = board.grid[a.r][a.c], B = board.grid[d.r][d.c];
    if (A === null || B === null) return { legal: false };

    // --- activation swaps (bomb swaps, special+special combos) -----------
    if (allowSpecials) {
      var combo = comboClear(board, a, d, A, B);
      if (combo) {
        var resB = resolveInternal(board, refill, pointers,
          { type: "clear", cells: combo.cells, suppress: combo.suppress },
          opts.trace);
        resB.specialFired = true;
        resB.legal = true;
        return resB;
      }
    }

    // --- normal swap -----------------------------------------------------
    var b = cloneBoard(board);
    b.grid[a.r][a.c] = B;
    b.grid[d.r][d.c] = A;
    if (!hasMatch(b)) return { legal: false };
    var res = resolveInternal(b, refill, pointers,
      { type: "match", swapCells: [{ r: a.r, c: a.c }, { r: d.r, c: d.c }] }, opts.trace);
    return {
      legal: true, board: res.board, pointers: res.pointers,
      scoreGained: res.scoreGained, cascades: res.cascades,
      specialCreated: res.specialCreated, specialFired: res.specialFired
    };
  }

  // Every legal swap from this state, deterministic row-major, each adjacency
  // once (right + down). opts.noSpecial drops any swap that creates OR fires a
  // special. Returns [{ move, res }...].
  function legalMoves(board, refill, pointers, opts) {
    opts = opts || {};
    var noSpecial = !!opts.noSpecial;
    var out = [];
    for (var r = 0; r < board.rows; r++) {
      for (var c = 0; c < board.cols; c++) {
        var dirs = [[r, c + 1], [r + 1, c]];
        for (var d = 0; d < dirs.length; d++) {
          var nr = dirs[d][0], nc = dirs[d][1];
          if (!inBounds(board, nr, nc)) continue;
          var move = { r1: r, c1: c, r2: nr, c2: nc };
          var res = applyMove(board, refill, pointers, move,
            { allowSpecials: !noSpecial });
          if (!res.legal) continue;
          if (noSpecial && (res.specialCreated || res.specialFired)) continue;
          out.push({ move: move, res: res });
        }
      }
    }
    return out;
  }

  function hasAnyLegalMove(board, refill, pointers) {
    return legalMoves(board, refill, pointers, {}).length > 0;
  }

  return {
    BASE_SCORE: BASE_SCORE,
    makeCandy: makeCandy,
    cloneCandy: cloneCandy,
    matchColor: matchColor,
    isSpecial: isSpecial,
    makeEmptyBoard: makeEmptyBoard,
    cloneBoard: cloneBoard,
    inBounds: inBounds,
    serialize: serialize,
    orthoNeighbors: orthoNeighbors,
    areAdjacent: areAdjacent,
    findRuns: findRuns,
    hasMatch: hasMatch,
    gravityAndRefill: gravityAndRefill,
    resolveInternal: resolveInternal,
    applyMove: applyMove,
    legalMoves: legalMoves,
    hasAnyLegalMove: hasAnyLegalMove
  };
});
