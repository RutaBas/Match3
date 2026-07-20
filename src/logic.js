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
 *   candy = { color:int>=1, kind:'normal'|'stripe-h'|'stripe-v'|'bomb' }.
 *     - color bomb ('bomb') is a WILDCARD: it carries color 0 and never takes
 *       part in a color run; it only fires when swapped (activation).
 *     - a striped candy keeps a real color and DOES take part in color runs.
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
 *   - run of >=5        -> a COLOR BOMB is created at the swap/mid cell.
 *   - a striped candy caught in a match FIRES (clears its whole row/column);
 *     firing chains (a fired stripe can clear other stripes). A color bomb only
 *     fires via SWAP activation (see applyMove); a bomb merely caught in a
 *     cascade clear is removed without its all-color effect (keeps the cascade
 *     unambiguous — a bomb has no color to key on outside a swap).
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
  //   'A'..'F' stripe-v  |  '*' bomb.
  function cellChar(cd) {
    if (cd === null) return ".";
    if (cd.kind === "bomb") return "*";
    if (cd.kind === "stripe-h") return String.fromCharCode(96 + cd.color); // a..
    if (cd.kind === "stripe-v") return String.fromCharCode(64 + cd.color); // A..
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

  // Which >=4 runs mint a special, and where. swapCells (or null) biases the
  // creation cell onto the player's swap cell when it lies on the run.
  function computeCreations(runs, swapCells) {
    var sorted = runs.slice().sort(function (a, b) { return b.len - a.len; });
    var creations = [], used = {};
    for (var i = 0; i < sorted.length; i++) {
      var run = sorted[i];
      if (run.len < 4) continue;
      var cell = null, j;
      if (swapCells) {
        for (j = 0; j < swapCells.length; j++) {
          var sc = swapCells[j];
          for (var k = 0; k < run.cells.length; k++) {
            if (run.cells[k].r === sc.r && run.cells[k].c === sc.c) { cell = sc; break; }
          }
          if (cell) break;
        }
      }
      if (!cell) cell = run.cells[Math.floor((run.len - 1) / 2)];
      if (used[key(cell.r, cell.c)]) continue;
      used[key(cell.r, cell.c)] = 1;
      var kind = run.len >= 5 ? "bomb" : (run.dir === "h" ? "stripe-h" : "stripe-v");
      var color = run.len >= 5 ? 0 : run.color;
      creations.push({ r: cell.r, c: cell.c, kind: kind, color: color });
    }
    return creations;
  }

  // Expand a clear set by firing existing specials it contains. A stripe-h
  // clears its row, stripe-v its column; a bomb caught here just clears.
  // Returns { cells:[{r,c}...], firedAny }.
  function expandFires(board, clearCells) {
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
      if (isSpecial(cd)) {
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
  //   { type:'clear', cells:[{r,c}...] }         (bomb activation; forced clears).
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

      var exp = expandFires(b, clearCells);
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

  // ------------------------------------------------------------- applyMove --

  // Apply one swap. move = { r1,c1, r2,c2 } (orthogonally adjacent).
  // opts.allowSpecials (default true) permits color-bomb activation swaps.
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

    // --- color-bomb activation ------------------------------------------
    if (allowSpecials && (A.kind === "bomb" || B.kind === "bomb")) {
      var initialCells = [];
      var r, c;
      if (A.kind === "bomb" && B.kind === "bomb") {
        for (r = 0; r < board.rows; r++)
          for (c = 0; c < board.cols; c++)
            if (board.grid[r][c] !== null) initialCells.push({ r: r, c: c });
      } else {
        var other = A.kind === "bomb" ? B : A;
        var targetColor = other.color; // stripe or normal color
        var have = {};
        for (r = 0; r < board.rows; r++) {
          for (c = 0; c < board.cols; c++) {
            var cd = board.grid[r][c];
            if (cd === null) continue;
            if (cd.color === targetColor || (cd.kind === "bomb")) {
              // include all of the keyed color; also consume the bomb itself.
              if (cd.color === targetColor || (r === a.r && c === a.c) || (r === d.r && c === d.c)) {
                if (!have[key(r, c)]) { have[key(r, c)] = 1; initialCells.push({ r: r, c: c }); }
              }
            }
          }
        }
        // ensure both swapped cells are consumed
        if (!have[key(a.r, a.c)]) initialCells.push({ r: a.r, c: a.c });
        if (!have[key(d.r, d.c)]) initialCells.push({ r: d.r, c: d.c });
      }
      var resB = resolveInternal(board, refill, pointers, { type: "clear", cells: initialCells }, opts.trace);
      resB.specialFired = true;
      resB.legal = true;
      return resB;
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
