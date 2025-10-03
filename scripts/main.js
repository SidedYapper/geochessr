// Dynamic Chessboard (Mock FEN) client script
// Auto-detects rows/cols from mock FEN like "r2/bb1/B2" (3x3), "4/pppp" (2x4), "1P/2/2/1k" (4x2)

const PIECE_LETTERS = new Set(['p','r','n','b','q','k','P','R','N','B','Q','K']);

const boardEl = document.getElementById('board');
const errorEl = document.getElementById('error');
const board8El = document.getElementById('board8');
let lastOverlayTopLeft = null; // {row, col} in 0-based 8x8 coords
let geochessId = null;
let currentFen = '';
let currentRows = 0;
let currentCols = 0;
let topLeftLight = true; // default
let overlayFrozen = false;
let feedbackLineEl = null;

function createBoardSquares(rows, cols) {
  boardEl.innerHTML = '';
  boardEl.style.setProperty('--rows', String(rows));
  boardEl.style.setProperty('--cols', String(cols));
  // Ensure squares remain square by matching the board aspect to cols/rows
  boardEl.style.aspectRatio = `${cols} / ${rows}`;
  for (let rowIndex = 0; rowIndex < rows; rowIndex += 1) {
    for (let colIndex = 0; colIndex < cols; colIndex += 1) {
      const square = document.createElement('div');
      const isLight = ((rowIndex + colIndex) % 2 === 0) ? topLeftLight : !topLeftLight;
      square.className = 'square ' + (isLight ? 'light' : 'dark');
      square.dataset.row = String(rowIndex);
      square.dataset.col = String(colIndex);
      square.id = `sq-${rowIndex}-${colIndex}`;
      boardEl.appendChild(square);
    }
  }
}

function pieceToAssetPath(ch) {
  const isWhite = ch === ch.toUpperCase();
  const color = isWhite ? 'w' : 'b';
  const pieceLetter = ch.toUpperCase();
  // Served by Flask at /assets/cburnett/<file>
  return `/assets/cburnett/${color}${pieceLetter}.svg`;
}

function renderCells(rows, cols, cells) {
  for (let rowIndex = 0; rowIndex < rows; rowIndex += 1) {
    for (let colIndex = 0; colIndex < cols; colIndex += 1) {
      const i = rowIndex * cols + colIndex;
      const square = document.getElementById(`sq-${rowIndex}-${colIndex}`);
      square.innerHTML = '';
      square.classList.remove('highlight');
      const ch = cells[i];
      if (ch) {
        const img = document.createElement('img');
        img.alt = `Piece ${ch}`;
        img.src = pieceToAssetPath(ch);
        square.appendChild(img);
      }
    }
  }
}

function parseMockFen(fen) {
  const cleaned = (fen || '').trim();
  if (!cleaned) {
    throw new Error('FEN is empty.');
  }
  const ranks = cleaned.split('/');
  const rows = ranks.length;
  let expectedCols = null;
  const cells = [];
  for (let r = 0; r < rows; r += 1) {
    const rank = ranks[r];
    let fileCount = 0;
    for (let idx = 0; idx < rank.length; idx += 1) {
      const ch = rank[idx];
      if (ch >= '1' && ch <= '9') {
        const empties = parseInt(ch, 10);
        if (empties < 1) {
          throw new Error(`Digit '${ch}' out of range in rank ${r + 1}.`);
        }
        for (let k = 0; k < empties; k += 1) {
          cells.push(null);
          fileCount += 1;
        }
      } else if (PIECE_LETTERS.has(ch)) {
        cells.push(ch);
        fileCount += 1;
      } else {
        throw new Error(`Invalid character '${ch}' in rank ${r + 1}.`);
      }
    }
    if (expectedCols === null) {
      expectedCols = fileCount;
    } else if (fileCount !== expectedCols) {
      throw new Error(`Rank ${r + 1} has ${fileCount} files but expected ${expectedCols}.`);
    }
  }
  const cols = expectedCols || 0;
  if (rows <= 0 || cols <= 0) {
    throw new Error('Board dimensions are invalid.');
  }
  if (cells.length !== rows * cols) {
    throw new Error('Parsed board size mismatch.');
  }
  return { rows, cols, cells };
}

function updateBoardFromInput() {
  errorEl.textContent = '';
  try {
    const { rows, cols, cells } = parseMockFen(currentFen);
    currentRows = rows;
    currentCols = cols;
    createBoardSquares(rows, cols);
    renderCells(rows, cols, cells);
    // After rendering, ensure left board is not taller than right board
    // Especially relevant when rows > 3
    requestAnimationFrame(enforceLeftBoardMaxHeight);
    // Recompute title position after layout settles
    requestAnimationFrame(positionTitle);
  } catch (err) {
    errorEl.textContent = err && err.message ? err.message : String(err);
  }
}

document.addEventListener('DOMContentLoaded', function() {
  const initial = (window.INITIAL_SUBFEN || '').trim();
  const defaultFen = initial || 'r2/bb1/B2'; // fallback if DB missing
  currentFen = defaultFen;
  updateBoardFromInput();
  initBoard8();
  geochessId = window.GEOCHESS_ID || null;
  const lm = Array.isArray(window.LAST_MOVE_CELLS) ? window.LAST_MOVE_CELLS : [];
  if (lm.length) {
    // Apply highlight after first render (slight delay to ensure squares exist)
    setTimeout(() => highlightLastMove(lm), 0);
  }
  // Re-apply sizing on resize
  window.addEventListener('resize', enforceLeftBoardMaxHeight);
  if (typeof window.TOP_LEFT_LIGHT === 'boolean') {
    topLeftLight = window.TOP_LEFT_LIGHT;
    // Re-render to apply color parity if it differs from default
    updateBoardFromInput();
  }
  // Labels visible only in initial solve phase
  const lblL = document.getElementById('labelLeft');
  const lblR = document.getElementById('labelRight');
  if (lblL) lblL.style.display = 'block';
  if (lblR) lblR.style.display = 'block';
  positionTitle();
  window.addEventListener('resize', positionTitle);
  // Also observe size changes of boards to keep title centered when 2x4/4x2 sizes adjust
  try {
    const ro = new ResizeObserver(() => positionTitle());
    if (boardEl) ro.observe(boardEl);
    if (board8El) ro.observe(board8El);
    const boardsWrapper = document.querySelector('.boards');
    if (boardsWrapper) ro.observe(boardsWrapper);
  } catch (_) {
    // ResizeObserver not supported; window resize listener will suffice
  }
});

function initBoard8() {
  // Create 8x8 squares once
  board8El.innerHTML = '';
  for (let rowIndex = 0; rowIndex < 8; rowIndex += 1) {
    for (let colIndex = 0; colIndex < 8; colIndex += 1) {
      const square = document.createElement('div');
      square.className = 'square ' + (((rowIndex + colIndex) % 2 === 0) ? 'light' : 'dark');
      square.dataset.row = String(rowIndex);
      square.dataset.col = String(colIndex);
      square.id = `b8-${rowIndex}-${colIndex}`;
      board8El.appendChild(square);
    }
  }

  board8El.addEventListener('mousemove', handleBoard8Hover);
  board8El.addEventListener('mouseleave', clearBoard8Overlay);
  board8El.addEventListener('click', handleBoard8Click);
}

function clearBoard8Overlay() {
  if (overlayFrozen) return; // keep frozen overlay
  const imgs = board8El.querySelectorAll('img.b8-overlay');
  imgs.forEach(img => img.remove());
  if (feedbackLineEl) {
    feedbackLineEl.remove();
    feedbackLineEl = null;
  }
}

function handleBoard8Hover(evt) {
  if (overlayFrozen) return; // stop following when frozen
  // Calculate which square we are over
  const rect = board8El.getBoundingClientRect();
  const x = evt.clientX - rect.left;
  const y = evt.clientY - rect.top;
  const squareWidth = rect.width / 8;
  const squareHeight = rect.height / 8;
  const col = Math.min(7, Math.max(0, Math.floor(x / squareWidth)));
  const row = Math.min(7, Math.max(0, Math.floor(y / squareHeight)));

  // Determine current mock FEN board size and cells
  let parsed;
  try {
    parsed = parseMockFen(currentFen);
  } catch (e) {
    clearBoard8Overlay();
    return;
  }

  const { rows, cols, cells } = parsed;

  // Compute top-left of overlay region so that hovered square is the center
  const startRow = Math.max(0, Math.min(8 - rows, row - Math.floor(rows / 2)));
  const startCol = Math.max(0, Math.min(8 - cols, col - Math.floor(cols / 2)));

  // Clear previous overlay
  if (!overlayFrozen) clearBoard8Overlay();

  // Place pieces aligned to 8x8 grid
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const ch = cells[r * cols + c];
      if (!ch) continue;
      const targetRow = startRow + r;
      const targetCol = startCol + c;
      if (targetRow < 0 || targetRow > 7 || targetCol < 0 || targetCol > 7) continue;
      const square = document.getElementById(`b8-${targetRow}-${targetCol}`);
      if (!square) continue;
      // Render overlay image exactly inside the square
      const img = document.createElement('img');
      img.className = 'b8-overlay';
      img.alt = `Overlay ${ch}`;
      img.src = pieceToAssetPath(ch);
      // Size similar to primary board styling
      img.style.width = '74%';
      img.style.height = '74%';
      img.style.objectFit = 'contain';
      img.style.pointerEvents = 'none';
      img.style.filter = 'drop-shadow(0 1px 1px rgba(0,0,0,0.25))';
      square.appendChild(img);
    }
  }

  // Save current top-left for click submission
  lastOverlayTopLeft = { row: startRow, col: startCol };
}

async function handleBoard8Click() {
  if (!lastOverlayTopLeft) return;
  const id = geochessId;
  if (!id) return;

  // Freeze current overlay and stop following the mouse
  overlayFrozen = true;

  // Submit top-left as (x,y) matching posx/posy semantics from backend (0-based)
  const payload = { id, x: lastOverlayTopLeft.col, y: lastOverlayTopLeft.row };
  try {
    const res = await fetch('/api/check_position', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    showResultMessage(data);
    if (!data.correct) {
      drawFeedbackLine(lastOverlayTopLeft, { col: data.answer.x, row: data.answer.y });
    }
    // If server provides fullFen, render it on the left board (8x8)
    if (data && typeof data.fullFen === 'string' && data.fullFen.length > 0) {
      const placement = data.fullFen.split(' ')[0];
      currentFen = placement; // now treat as an 8x8 placement-only FEN
      // For full 8x8 feedback board, force top-left to be light
      topLeftLight = true;
      updateBoardFromInput();
      if (Array.isArray(data.lastMoveCells) && data.lastMoveCells.length) {
        // Highlight last move on the now-8x8 left board
        setTimeout(() => highlightAbsoluteLastMove(data.lastMoveCells), 0);
      }
    }
    // Update meta link if provided
    if (data && data.gameId && typeof data.halfMoveNum === 'number') {
      const link = document.getElementById('metaGameLink');
      if (link) {
        link.textContent = data.gameId;
        link.href = `https://lichess.org/${data.gameId}/#${data.halfMoveNum}`;
      }
    }
  } catch (e) {
    showResultMessage({ ok: false, error: 'Network error' });
  }
}

function showResultMessage(resp) {
  if (!errorEl) return;
  if (!resp || resp.ok !== true) {
    errorEl.textContent = 'Submission failed.';
    return;
  }
  if (!resp.correct) {
    errorEl.textContent = `Wrong. Correct top-left is (${resp.answer.x}, ${resp.answer.y}).`;
    errorEl.style.color = 'var(--danger)';
  } else {
    // Do nothing on correct per spec
  }
  // Show feedback card with status and Next button
  const card = document.getElementById('feedbackCard');
  const title = document.getElementById('feedbackTitle');
  const nextBtn = document.getElementById('nextButton');
  if (card && title && nextBtn) {
    card.style.display = 'grid';
    card.classList.remove('success', 'error');
    title.textContent = resp.correct ? 'Success' : 'Incorrect';
    card.classList.add(resp.correct ? 'success' : 'error');
    nextBtn.classList.remove('success', 'error');
    nextBtn.classList.add(resp.correct ? 'success' : 'error');
    // Attach the handler once
    if (!nextBtn.dataset.bound) {
      nextBtn.addEventListener('click', handleNextClick);
      nextBtn.dataset.bound = '1';
    }
    // Hide initial labels permanently after first submission
    const lblL = document.getElementById('labelLeft');
    const lblR = document.getElementById('labelRight');
    if (lblL) lblL.style.display = 'none';
    if (lblR) lblR.style.display = 'none';
  }
}

async function handleNextClick() {
  try {
    const res = await fetch('/api/next');
    const data = await res.json();
    if (!data || data.ok !== true) return;
    // Reset dynamic state to initial
    overlayFrozen = false;
    if (feedbackLineEl) { feedbackLineEl.remove(); feedbackLineEl = null; }
    clearBoard8Overlay();
    board8El.innerHTML = '';
    initBoard8();

    // Update left board from new subfen and parity
    currentFen = (data.initial_subfen || '').trim();
    // Update active GeoChess id for subsequent submissions
    geochessId = data.geochess_id || null;
    // Clear any stale hover selection
    lastOverlayTopLeft = null;
    if (typeof data.top_left_light === 'boolean') {
      topLeftLight = data.top_left_light;
    } else {
      topLeftLight = true;
    }
    updateBoardFromInput();

    // Apply subfen last-move highlights if any
    if (Array.isArray(data.last_move_cells) && data.last_move_cells.length) {
      setTimeout(() => highlightLastMove(data.last_move_cells), 0);
    }

    // Update meta panel
    const setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val ?? ''; };
    if (data.game_meta) {
      setText('metaResult', data.game_meta.result || '');
      setText('metaWhiteElo', data.game_meta.whiteElo || '');
      setText('metaBlackElo', data.game_meta.blackElo || '');
      setText('metaTime', data.game_meta.timeControl || '');
      setText('metaMove', data.game_meta.moveNum || '');
    } else {
      setText('metaResult', ''); setText('metaWhiteElo', ''); setText('metaBlackElo', ''); setText('metaTime', ''); setText('metaMove', '');
    }
    // Reset URL link
    const link = document.getElementById('metaGameLink');
    if (link) { link.textContent = ''; link.removeAttribute('href'); }

    // Hide feedback card
    const card = document.getElementById('feedbackCard');
    if (card) { card.style.display = 'none'; card.classList.remove('success', 'error'); }
    const title = document.getElementById('feedbackTitle');
    if (title) { title.textContent = ''; }
    const nextBtn = document.getElementById('nextButton');
    if (nextBtn) { nextBtn.classList.remove('success', 'error'); }
  } catch (_) {
    // silent fail
  }
}

function highlightLastMove(cells) {
  // cells: [{r, c}] relative to subfen top-left
  let parsed;
  try {
    parsed = parseMockFen(currentFen);
  } catch {
    return;
  }
  const { rows, cols } = parsed;
  for (const cell of cells) {
    const r = cell && typeof cell.r === 'number' ? cell.r : null;
    const c = cell && typeof cell.c === 'number' ? cell.c : null;
    if (r == null || c == null) continue;
    if (r < 0 || c < 0 || r >= rows || c >= cols) continue;
    const sq = document.getElementById(`sq-${r}-${c}`);
    if (!sq) continue;
    sq.classList.add('highlight');
  }
}

function highlightAbsoluteLastMove(absCells) {
  let parsed;
  try {
    parsed = parseMockFen(currentFen);
  } catch {
    return;
  }
  const { rows, cols } = parsed;
  if (rows !== 8 || cols !== 8) return;
  for (const cell of absCells) {
    const r = cell && typeof cell.r === 'number' ? cell.r : null;
    const c = cell && typeof cell.c === 'number' ? cell.c : null;
    if (r == null || c == null) continue;
    if (r < 0 || c < 0 || r >= 8 || c >= 8) continue;
    const sq = document.getElementById(`sq-${r}-${c}`);
    if (!sq) continue;
    sq.classList.add('highlight');
  }
}

function drawFeedbackLine(submittedTopLeft, correctTopLeft) {
  // Remove old line
  if (feedbackLineEl) {
    feedbackLineEl.remove();
    feedbackLineEl = null;
  }

  const rect = board8El.getBoundingClientRect();
  const squareW = rect.width / 8;
  const squareH = rect.height / 8;

  // Centers of rectangles
  const subCenterX = (submittedTopLeft.col + currentCols / 2) * squareW;
  const subCenterY = (submittedTopLeft.row + currentRows / 2) * squareH;
  const corCenterX = (correctTopLeft.col + currentCols / 2) * squareW;
  const corCenterY = (correctTopLeft.row + currentRows / 2) * squareH;

  // Create an SVG overlay positioned absolutely over the board
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'feedback-line');
  svg.setAttribute('width', String(rect.width));
  svg.setAttribute('height', String(rect.height));
  svg.style.position = 'absolute';
  svg.style.left = '0';
  svg.style.top = '0';
  svg.style.pointerEvents = 'none';

  // Compute shortened end point so arrow tip lands at target center
  const dx = corCenterX - subCenterX;
  const dy = corCenterY - subCenterY;
  const dist = Math.hypot(dx, dy) || 1;
  const strokeWidth = 10; // must match line stroke-width
  const arrowHeadUnits = 3; // tip length in marker units (matches path 0->3)
  const headLenPx = arrowHeadUnits * strokeWidth; // because markerUnits=strokeWidth
  const shorten = Math.min(headLenPx, dist - 1); // keep at least 1px line
  const ratio = (dist - shorten) / dist;
  const x2 = subCenterX + dx * ratio;
  const y2 = subCenterY + dy * ratio;

  const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  line.setAttribute('x1', String(subCenterX));
  line.setAttribute('y1', String(subCenterY));
  line.setAttribute('x2', String(x2));
  line.setAttribute('y2', String(y2));
  line.setAttribute('stroke', '#ef4444');
  line.setAttribute('stroke-width', '10');
  line.setAttribute('stroke-linecap', 'butt');
  line.setAttribute('stroke-opacity', '0.7');

  // Define a filled arrowhead marker
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
  marker.setAttribute('id', 'arrowhead');
  marker.setAttribute('markerWidth', '3');
  marker.setAttribute('markerHeight', '3');
  marker.setAttribute('refX', '0');
  marker.setAttribute('refY', '1.5');
  marker.setAttribute('orient', 'auto');
  marker.setAttribute('markerUnits', 'strokeWidth');

  const arrowPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  arrowPath.setAttribute('d', 'M0,0 L0,3 L3,1.5 Z');
  arrowPath.setAttribute('fill', '#ef4444');
  arrowPath.setAttribute('fill-opacity', '0.7');
  arrowPath.setAttribute('stroke', 'none');
  marker.appendChild(arrowPath);
  defs.appendChild(marker);
  svg.appendChild(defs);

  // Attach arrowhead to the end of the line
  line.setAttribute('marker-end', 'url(#arrowhead)');
  svg.appendChild(line);

  board8El.style.position = 'relative';
  board8El.appendChild(svg);
  feedbackLineEl = svg;
}

function enforceLeftBoardMaxHeight() {
  if (!boardEl || !board8El) return;
  if (!currentRows || !currentCols) return;
  const rightHeight = board8El.getBoundingClientRect().height;
  if (!rightHeight || rightHeight <= 0) return;
  // Height_left = width_left * rows/cols (since aspect-ratio is cols/rows)
  // We need width_left <= rightHeight * (cols/rows)
  const maxAllowedWidth = rightHeight * (currentCols / currentRows);
  // Apply only when rows > 3; otherwise clear the override
  if (currentRows > 3) {
    boardEl.style.maxWidth = `${Math.floor(maxAllowedWidth)}px`;
  } else {
    boardEl.style.maxWidth = '';
  }
  // After potentially changing board size, reposition title
  positionTitle();
}

function positionTitle() {
  const title = document.querySelector('.page-title');
  const boards = document.querySelector('.boards');
  if (!title || !boards) return;
  const boardsTop = boards.getBoundingClientRect().top + window.scrollY;
  const midpoint = boardsTop / 2 - 25; // halfway between page top and boards top
  title.style.top = `${Math.max(0, Math.floor(midpoint))}px`;
  if (midpoint < 25){
    title.style.visibility = 'hidden';
  }
  else {
    title.style.visibility = 'visible';
  }
}


