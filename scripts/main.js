// Dynamic Chessboard (Mock FEN) client script
// Auto-detects rows/cols from mock FEN like "r2/bb1/B2" (3x3), "4/pppp" (2x4), "1P/2/2/1k" (4x2)

const PIECE_LETTERS = new Set(['p','r','n','b','q','k','P','R','N','B','Q','K']);

const boardEl = document.getElementById('board');
const boardShellEl = document.querySelector('.board-shell');
const lichessShellEl = document.getElementById('lichessShell');
const lichessIframeEl = document.getElementById('lichessIframe');
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
let feedbackBoxesEl = null;
let feedbackSubfen = '';
let isTouching = false;
let lastTouchWithinBoard = false;
let suppressNextClick = false;
let currentRunId = null;
let currentRunIndex = 0;
let currentRunLen = 0;
let currentRunSubmissions = []; // Track all submissions for the current run
let currentPgnObjectUrl = null; // Blob URL for PGN download (feedback phase)
let useLichessEmbed = false; // user toggle for lichess board in feedback
let currentRunTimeTakenSeconds = null; // Elapsed time reported by server when run finished

// Sound effects
let sfxCorrect = null;
let sfxIncorrect = null;
let sfxRunFinished = null;
let sfxAllCorrect = null;

// Share-link helper for first puzzle prompt (non-daily)
let shareCopyHandler = null;

function playSfx(kind) {
  try {
    let audio = null;
    if (kind === 'run_finished') audio = sfxRunFinished;
    else if (kind === 'all_correct') audio = sfxAllCorrect;
    else if (kind === 'correct') audio = sfxCorrect;
    else if (kind === 'incorrect') audio = sfxIncorrect;
    if (!audio) return;
    audio.currentTime = 0;
    // Ignore possible play() promise rejections due to autoplay policies
    const p = audio.play();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (_) {}
}

// Play a sound and resolve when it finishes (with robust fallbacks)
function playSfxAndWait(kind) {
  try {
    let audio = null;
    if (kind === 'run_finished') audio = sfxRunFinished;
    else if (kind === 'all_correct') audio = sfxAllCorrect;
    else if (kind === 'correct') audio = sfxCorrect;
    else if (kind === 'incorrect') audio = sfxIncorrect;
    if (!audio) return Promise.resolve();
    audio.currentTime = 0;
    return new Promise((resolve) => {
      let finished = false;
      const cleanup = () => {
        if (finished) return;
        finished = true;
        try { audio.removeEventListener('ended', onEnded); } catch(_) {}
        try { audio.removeEventListener('error', onError); } catch(_) {}
        try { clearTimeout(timer); } catch(_) {}
        resolve();
      };
      const onEnded = () => cleanup();
      const onError = () => cleanup();
      audio.addEventListener('ended', onEnded, { once: true });
      audio.addEventListener('error', onError, { once: true });
      const p = audio.play();
      if (p && typeof p.catch === 'function') p.catch(() => cleanup());
      // Fallback: resolve after duration (if known) or 1200ms
      const fallbackMs = Math.max(1200, Math.floor(((audio.duration || 1.2) * 1000)) + 50);
      const timer = setTimeout(() => cleanup(), fallbackMs);
    });
  } catch (_) {
    return Promise.resolve();
  }
}

// Play first, then when it finishes, play second
function playSfxThen(firstKind, secondKind) {
  playSfxAndWait(firstKind)
    .then(() => new Promise(resolve => setTimeout(resolve, 500)))
    .then(() => { try { playSfx(secondKind); } catch(_) {} });
}

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
    // Adjust meta width to keep ratio with boards on desktop
    requestAnimationFrame(applyLayoutSizing);
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
  currentRunId = window.RUN_ID || null;
  currentRunIndex = Number(window.RUN_INDEX || 0);
  currentRunLen = Number(window.RUN_LEN || 0);
  currentRunTimeTakenSeconds = null;
  // Initialize sounds after first user gesture will be required by browsers; creating upfront is fine
  try {
    sfxCorrect = new Audio('/assets/sound/correct.mp3');
    sfxIncorrect = new Audio('/assets/sound/incorrect.mp3');
    sfxRunFinished = new Audio('/assets/sound/run_finished.mp3');
    sfxAllCorrect = new Audio('/assets/sound/all_correct.mp3');
    [sfxCorrect, sfxIncorrect, sfxRunFinished, sfxAllCorrect].forEach(a => { if (a) a.preload = 'auto'; });
  } catch (_) {}
  // Update titles with daily flag if applicable
  try {
    if (window.IS_DAILY) {
      const h = document.querySelector('h1.page-title');
      if (h && !h.textContent.includes('Daily')) {
        h.textContent = `${h.textContent} - Daily`;
      }
      if (document && document.title && !document.title.includes('Daily')) {
        document.title = `${document.title} - Daily`;
      }
    }
  } catch (_) {}
  
  // Initialize submissions array from server data or create empty array
  const allSubs = Array.isArray(window.ALL_SUBMISSIONS) ? window.ALL_SUBMISSIONS : [];
  currentRunSubmissions = new Array(currentRunLen).fill(null);
  // Populate with any existing submissions
  allSubs.forEach((sub, idx) => {
    if (idx < currentRunSubmissions.length && sub) {
      currentRunSubmissions[idx] = sub;
    }
  });
  
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
  window.addEventListener('resize', applyLayoutSizing);
  // Also observe size changes of boards to keep title centered when 2x4/4x2 sizes adjust
  try {
    const ro = new ResizeObserver(() => { positionTitle(); applyLayoutSizing(); });
    if (boardEl) ro.observe(boardEl);
    if (board8El) ro.observe(board8El);
    const boardsWrapper = document.querySelector('.boards');
    if (boardsWrapper) ro.observe(boardsWrapper);
  } catch (_) {
    // ResizeObserver not supported; window resize listener will suffice
  }

  // Check if user already submitted this puzzle (prior_submission from server)
  const priorSub = window.PRIOR_SUBMISSION;
  if (priorSub && typeof priorSub === 'object' && typeof priorSub.x === 'number' && typeof priorSub.y === 'number') {
    // Immediately show feedback state
    setTimeout(() => {
      replayPriorSubmission(priorSub.x, priorSub.y, priorSub.correct);
    }, 100);
  }

  // For the first puzzle of non-daily runs, show an initial share prompt
  try {
    if (!window.IS_DAILY && currentRunIndex === 0 && !priorSub) {
      const card = document.getElementById('feedbackCard');
      const title = document.getElementById('feedbackTitle');
      const nextBtn = document.getElementById('nextButton');
      if (card && title && nextBtn) {
        card.style.display = 'grid';
        card.classList.remove('success', 'error');
        title.textContent = 'You can share your run link with a friend, so they can try the same puzzles';
        title.classList.add('small-title');
        nextBtn.classList.remove('success', 'error', 'new-run');
        nextBtn.textContent = 'Copy run link';
        // Bind copy action (avoid duplicate binding)
        if (!nextBtn.dataset.shareBound) {
          shareCopyHandler = async () => {
            try {
              const url = window.location.href;
              await navigator.clipboard.writeText(url);
              const old = nextBtn.textContent;
              nextBtn.textContent = 'Copied!';
              setTimeout(() => { nextBtn.textContent = old; }, 1500);
            } catch (_) {
              const old = nextBtn.textContent;
              nextBtn.textContent = 'Failed';
              setTimeout(() => { nextBtn.textContent = old; }, 1500);
            }
          };
          nextBtn.addEventListener('click', shareCopyHandler);
          nextBtn.dataset.shareBound = '1';
        }
      }
    }
  } catch (_) {}

  // Metadata rows/values lookup
  const metaRows = {
    result: document.getElementById('metaRowResult'),
    whiteElo: document.getElementById('metaRowWhiteElo'),
    blackElo: document.getElementById('metaRowBlackElo'),
    move_num: document.getElementById('metaRowMoveNum'),
    opening_name: document.getElementById('metaRowOpening'),
    whitePlayer: document.getElementById('metaRowWhitePlayer'),
    blackPlayer: document.getElementById('metaRowBlackPlayer'),
    year: document.getElementById('metaRowYear'),
    url: document.getElementById('metaRowUrl'),
    pgn: document.getElementById('metaRowPgn'),
  };
  const metaVals = {
    result: document.getElementById('metaResult'),
    whiteElo: document.getElementById('metaWhiteElo'),
    blackElo: document.getElementById('metaBlackElo'),
    move_num: document.getElementById('metaMove'),
    opening_name: document.getElementById('metaOpening'),
    whitePlayer: document.getElementById('metaWhitePlayer'),
    blackPlayer: document.getElementById('metaBlackPlayer'),
    year: document.getElementById('metaYear'),
    url: document.getElementById('metaGameLink'),
    pgn: document.getElementById('metaPgnLink'),
  };

  // Initialize metadata rows visibility based on run metadata fields
  try {
    const fields = Array.isArray(window.METADATA_FIELDS) ? window.METADATA_FIELDS : [];
    const allowed = new Set(fields);
    Object.entries(metaRows).forEach(([key, row]) => {
      if (!row) return;
      // URL and PGN hidden until feedback
      if (key === 'url' || key === 'pgn') {
        row.style.display = 'none';
        return;
      }
      row.style.display = allowed.has(key) ? '' : 'none';
    });
  } catch (_) {}

  // Bottom menu bindings
  const btnNewRun = document.getElementById('btnNewRun');
  const btnGithub = document.getElementById('btnGithub');
  const btnAbout = document.getElementById('btnAbout');
  const btnLichess = document.getElementById('btnLichessBoard');
  const modal = document.getElementById('runModal');
  const modalClose = document.getElementById('runModalClose');
  const rsDifficulty = document.getElementById('rsDifficulty');
  const rsDifficultyLabel = document.getElementById('rsDifficultyLabel');
  const rsNPuzzles = document.getElementById('rsNPuzzles');
  const rsNPuzzlesVal = document.getElementById('rsNPuzzlesVal');
  const rsMinMove = document.getElementById('rsMinMove');
  const rsMaxMove = document.getElementById('rsMaxMove');
  const rsMinMoveVal = document.getElementById('rsMinMoveVal');
  const rsMaxMoveVal = document.getElementById('rsMaxMoveVal');
  const runCreateBtn = document.getElementById('runCreateBtn');
  const rsSourceLichess = document.getElementById('rsSourceLichess');
  const rsSourceMasters = document.getElementById('rsSourceMasters');

  // Determine if this run supports lichess URLs
  const lichessAllowed = Array.isArray(window.METADATA_FIELDS) && window.METADATA_FIELDS.includes('url');
  if (btnLichess && !lichessAllowed) {
    try {
      btnLichess.setAttribute('disabled', '');
      btnLichess.setAttribute('aria-disabled', 'true');
      btnLichess.setAttribute('aria-pressed', 'false');
      btnLichess.style.opacity = '0.5';
      btnLichess.style.cursor = 'not-allowed';
      btnLichess.title = 'Unavailable for this run';
    } catch (_) {}
  }

  // Helpers to persist run settings in cookie
  function readRunSettingsFromUI() {
    let source = 'lichess';
    try {
      if (rsSourceMasters && rsSourceMasters.checked) source = 'world_champion';
      else if (rsSourceLichess && rsSourceLichess.checked) source = 'lichess';
    } catch (_) {}
    return {
      difficulty: Number(rsDifficulty && rsDifficulty.value || 1),
      n_puzzles: Number(rsNPuzzles && rsNPuzzles.value || 10),
      min_move: Number(rsMinMove && rsMinMove.value || 5),
      max_move: Number(rsMaxMove && rsMaxMove.value || 20),
      source,
    };
  }
  function applyRunSettingsToUI(s) {
    if (!s || typeof s !== 'object') return;
    try {
      if (typeof s.difficulty === 'number' && rsDifficulty) rsDifficulty.value = String(Math.max(0, Math.min(3, s.difficulty)));
      if (typeof s.n_puzzles === 'number' && rsNPuzzles) rsNPuzzles.value = String(Math.max(1, Math.min(50, s.n_puzzles)));
      if (typeof s.min_move === 'number' && rsMinMove) rsMinMove.value = String(Math.max(0, Math.min(100, s.min_move)));
      if (typeof s.max_move === 'number' && rsMaxMove) rsMaxMove.value = String(Math.max(0, Math.min(100, s.max_move)));
      if (typeof s.source === 'string') {
        if (s.source === 'world_champion' && rsSourceMasters) rsSourceMasters.checked = true;
        else if (rsSourceLichess) rsSourceLichess.checked = true;
      }
      // Update labels and enforce ordering
      if (typeof updateDiffLabel === 'function') updateDiffLabel();
      if (typeof clampMinMax === 'function') clampMinMax.call(rsMaxMove);
      if (rsNPuzzles && rsNPuzzlesVal) rsNPuzzlesVal.textContent = String(rsNPuzzles.value);
    } catch (_) {}
  }
  function saveRunSettingsCookie() {
    try {
      const s = readRunSettingsFromUI();
      const val = encodeURIComponent(JSON.stringify(s));
      setCookie('runSettings', val, 180);
    } catch (_) {}
  }
  function loadRunSettingsCookie() {
    try {
      const raw = getCookie('runSettings');
      if (!raw) return;
      const s = JSON.parse(decodeURIComponent(raw));
      applyRunSettingsToUI(s);
    } catch (_) {}
  }

  if (btnNewRun && modal) {
    btnNewRun.addEventListener('click', () => { loadRunSettingsCookie(); modal.style.display = 'grid'; });
  }
  if (modalClose && modal) {
    modalClose.addEventListener('click', () => { modal.style.display = 'none'; });
  }
  if (btnGithub) {
    btnGithub.addEventListener('click', () => { window.open('https://github.com/yannikkellerde/geochessr', '_blank', 'noopener,noreferrer'); });
  }
  if (btnAbout) {
    btnAbout.addEventListener('click', () => {
      window.location.href = '/about';
    });
  }

  // Simple cookie helpers
  function setCookie(name, value, days) {
    try {
      const d = new Date();
      d.setTime(d.getTime() + (days * 24 * 60 * 60 * 1000));
      document.cookie = `${name}=${value}; expires=${d.toUTCString()}; path=/; SameSite=Lax`;
    } catch (_) {}
  }
  function getCookie(name) {
    try {
      const parts = document.cookie.split('; ').filter(Boolean);
      for (const part of parts) {
        const [k, v] = part.split('=');
        if (k === name) return v || null;
      }
    } catch (_) {}
    return null;
  }

  // Initialize lichess toggle from cookie or default to active on landscape
  try {
    if (!lichessAllowed) {
      useLichessEmbed = false;
      if (btnLichess) btnLichess.setAttribute('aria-pressed', 'false');
      toggleLichessEmbed('', '');
    } else {
      const saved = getCookie('lichessEmbed');
      let initial = null;
      if (saved === '1') initial = true;
      else if (saved === '0') initial = false;
      else initial = (window.innerWidth >= window.innerHeight); // active by default on landscape
      useLichessEmbed = !!initial;
      if (btnLichess) btnLichess.setAttribute('aria-pressed', useLichessEmbed ? 'true' : 'false');
      // If we are already in feedback and a lichess URL is present, apply immediately
      try {
        const card = document.getElementById('feedbackCard');
        if (card && card.style.display !== 'none') {
          const link = document.getElementById('metaGameLink');
          const href = link && link.href ? link.href : '';
          if (useLichessEmbed && href && href.includes('lichess.org/')) {
            let gameId = '';
            let half = '';
            try {
              const m = href.match(/lichess\.org\/(\w+)\/\#(\d+)/);
              if (m) { gameId = m[1]; half = m[2]; }
            } catch(_) {}
            toggleLichessEmbed(gameId, half);
          } else {
            toggleLichessEmbed('', '');
          }
        }
      } catch(_) {}
    }
  } catch(_) {}
  if (btnLichess) {
    btnLichess.addEventListener('click', () => {
      if (!lichessAllowed || btnLichess.hasAttribute('disabled') || btnLichess.getAttribute('aria-disabled') === 'true') {
        return;
      }
      useLichessEmbed = !useLichessEmbed;
      btnLichess.setAttribute('aria-pressed', useLichessEmbed ? 'true' : 'false');
      // persist selection in cookie for 180 days
      try { setCookie('lichessEmbed', useLichessEmbed ? '1' : '0', 180); } catch(_) {}
      // If we are already in feedback phase with a game link, update view
      try {
        const card = document.getElementById('feedbackCard');
        if (card && card.style.display !== 'none') {
          // Re-evaluate left panel display based on current data in meta link
          const link = document.getElementById('metaGameLink');
          const href = link && link.href ? link.href : '';
          // Only switch if we have a lichess URL
          if (href && href.includes('lichess.org/')) {
            // Parse game id and half move from existing href if possible
            let gameId = '';
            let half = '';
            try {
              const m = href.match(/lichess\.org\/(\w+)\/\#(\d+)/);
              if (m) { gameId = m[1]; half = m[2]; }
            } catch(_) {}
            toggleLichessEmbed(gameId, half);
          } else {
            toggleLichessEmbed('', '');
          }
        }
      } catch(_) {}
    });
  }

  const diffBuckets = [
    { name: 'Easy', range: '0%–30%', min: 0.0, max: 0.3, bir: 0.0 },
    { name: 'Normal', range: '20%–60%', min: 0.2, max: 0.6, bir: 0.2 },
    { name: 'Hard', range: '40%–80%', min: 0.4, max: 0.8, bir: 0.5 },
    { name: 'Extra Hard', range: '60%–100%', min: 0.6, max: 1.0, bir: 0.8 },
  ];
  function updateDiffLabel() {
    const b = diffBuckets[Number(rsDifficulty.value) || 0];
    rsDifficultyLabel.textContent = `${b.name} (${b.range})`;
  }
  if (rsDifficulty && rsDifficultyLabel) {
    rsDifficulty.addEventListener('input', () => { updateDiffLabel(); saveRunSettingsCookie(); });
    updateDiffLabel();
  }
  function clampMinMax() {
    let minv = Number(rsMinMove.value || 0);
    let maxv = Number(rsMaxMove.value || 0);
    if (minv > maxv) {
      // keep handles ordered
      if (this === rsMinMove) rsMaxMove.value = String(minv);
      else rsMinMove.value = String(maxv);
      minv = Number(rsMinMove.value); maxv = Number(rsMaxMove.value);
    }
    rsMinMoveVal.textContent = String(minv);
    rsMaxMoveVal.textContent = String(maxv);
  }
  if (rsMinMove && rsMaxMove) {
    rsMinMove.addEventListener('input', () => { clampMinMax(); saveRunSettingsCookie(); });
    rsMaxMove.addEventListener('input', () => { clampMinMax(); saveRunSettingsCookie(); });
    clampMinMax();
  }
  if (rsNPuzzles && rsNPuzzlesVal) {
    rsNPuzzles.addEventListener('input', () => { rsNPuzzlesVal.textContent = String(rsNPuzzles.value); saveRunSettingsCookie(); });
    rsNPuzzlesVal.textContent = String(rsNPuzzles.value);
  }
  // Persist source radio changes
  if (rsSourceLichess) rsSourceLichess.addEventListener('change', saveRunSettingsCookie);
  if (rsSourceMasters) rsSourceMasters.addEventListener('change', saveRunSettingsCookie);

  if (runCreateBtn) {
    runCreateBtn.addEventListener('click', async () => {
      const diff = Number(rsDifficulty.value || 1);
      let source = 'lichess';
      try {
        if (rsSourceMasters && rsSourceMasters.checked) source = 'world_champion';
        else if (rsSourceLichess && rsSourceLichess.checked) source = 'lichess';
      } catch (_) { /* default to lichess */ }
      const payload = {
        difficulty: diff,
        n_puzzles: Number(rsNPuzzles.value || 8),
        min_move: Number(rsMinMove.value || 5),
        max_move: Number(rsMaxMove.value || 20),
        source,
      };
      // Persist settings on create
      saveRunSettingsCookie();
      try {
        const res = await fetch('/api/create_run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (data && data.ok && data.run_id) {
          window.location.assign(`/run/${encodeURIComponent(data.run_id)}`);
        }
      } catch (_) { /* silent */ }
    });
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
      square.style.position = 'relative';
      board8El.appendChild(square);
    }
  }

  board8El.addEventListener('mousemove', handleBoard8Hover);
  board8El.addEventListener('mouseleave', clearBoard8Overlay);
  board8El.addEventListener('click', handleBoard8Click);
  // Touch support: show overlay during touch, submit on release inside board
  board8El.addEventListener('touchstart', handleBoard8TouchStart, { passive: false });
  board8El.addEventListener('touchmove', handleBoard8TouchMove, { passive: false });
  board8El.addEventListener('touchend', handleBoard8TouchEnd);
  board8El.addEventListener('touchcancel', handleBoard8TouchCancel);
}

function clearBoard8Overlay() {
  if (overlayFrozen) return; // keep frozen overlay
  const imgs = board8El.querySelectorAll('img.b8-overlay');
  imgs.forEach(img => img.remove());
  if (feedbackLineEl) {
    feedbackLineEl.remove();
    feedbackLineEl = null;
  }
  if (feedbackBoxesEl) {
    feedbackBoxesEl.remove();
    feedbackBoxesEl = null;
  }
}

function showBoard8OverlayAtPosition(topLeftRow, topLeftCol) {
  // Display mock FEN pieces on 8x8 board at specific top-left position
  let parsed;
  try {
    parsed = parseMockFen(currentFen);
  } catch (e) {
    return;
  }

  const { rows, cols, cells } = parsed;

  // Place pieces aligned to 8x8 grid
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const ch = cells[r * cols + c];
      if (!ch) continue;
      const targetRow = topLeftRow + r;
      const targetCol = topLeftCol + c;
      if (targetRow < 0 || targetRow > 7 || targetCol < 0 || targetCol > 7) continue;
      const square = document.getElementById(`b8-${targetRow}-${targetCol}`);
      if (!square) continue;
      // Render overlay image exactly inside the square
      const img = document.createElement('img');
      img.className = 'b8-overlay';
      img.alt = `Overlay ${ch}`;
      img.src = pieceToAssetPath(ch);
      img.style.width = '74%';
      img.style.height = '74%';
      img.style.objectFit = 'contain';
      img.style.pointerEvents = 'none';
      img.style.filter = 'drop-shadow(0 1px 1px rgba(0,0,0,0.25))';
      square.appendChild(img);
    }
  }
}

// Render overlay pieces using a provided FEN at a fixed top-left on the 8x8 board.
// Options: { opacity: number }
function renderOverlayPiecesAt(topLeftRow, topLeftCol, fenString, opts) {
  if (!fenString) return;
  let parsed;
  try {
    parsed = parseMockFen(fenString);
  } catch (e) {
    return;
  }
  const { rows, cols, cells } = parsed;
  // Only render the visible dimx x dimy window from this FEN
  // Dimensional window equals current mock FEN board size
  const opacity = opts && typeof opts.opacity === 'number' ? String(opts.opacity) : '';
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const ch = cells[r * cols + c];
      if (!ch) continue;
      const targetRow = topLeftRow + r;
      const targetCol = topLeftCol + c;
      if (targetRow < 0 || targetRow > 7 || targetCol < 0 || targetCol > 7) continue;
      const square = document.getElementById(`b8-${targetRow}-${targetCol}`);
      if (!square) continue;
      const img = document.createElement('img');
      img.className = 'b8-overlay';
      img.alt = `Overlay ${ch}`;
      img.src = pieceToAssetPath(ch);
      // Absolutely position to avoid layout expansion when stacking two overlays
      const rect = square.getBoundingClientRect();
      // Use percentages to match existing visual size (~74%) and center
      img.style.position = 'absolute';
      img.style.left = '50%';
      img.style.top = '50%';
      img.style.transform = 'translate(-50%, -50%)';
      img.style.width = '74%';
      img.style.height = '74%';
      img.style.objectFit = 'contain';
      img.style.pointerEvents = 'none';
      img.style.filter = 'drop-shadow(0 1px 1px rgba(0,0,0,0.25))';
      // Layering: correct pieces base z, ghost above
      const z = opts && opts.opacity && Number(opts.opacity) < 1 ? 2 : 1;
      img.style.zIndex = String(z);
      if (opacity) img.style.opacity = opacity;
      square.appendChild(img);
    }
  }
}

// Render only the dimx x dimy window from a full 8x8 FEN at the given top-left
function renderCorrectWindowAt(topLeftRow, topLeftCol, fullFen, windowRows, windowCols) {
  if (!fullFen) return;
  let parsed;
  try {
    parsed = parseMockFen(fullFen);
  } catch (e) {
    return;
  }
  const { rows, cols, cells } = parsed;
  if (rows !== 8 || cols !== 8) return;
  const wr = Math.max(1, Math.min(8, Number(windowRows) || 8));
  const wc = Math.max(1, Math.min(8, Number(windowCols) || 8));
  for (let r = 0; r < wr; r += 1) {
    for (let c = 0; c < wc; c += 1) {
      const absRow = topLeftRow + r;
      const absCol = topLeftCol + c;
      if (absRow < 0 || absRow > 7 || absCol < 0 || absCol > 7) continue;
      const ch = cells[absRow * 8 + absCol];
      if (!ch) continue;
      const square = document.getElementById(`b8-${absRow}-${absCol}`);
      if (!square) continue;
      const img = document.createElement('img');
      img.className = 'b8-overlay';
      img.alt = `Overlay ${ch}`;
      img.src = pieceToAssetPath(ch);
      img.style.position = 'absolute';
      img.style.left = '50%';
      img.style.top = '50%';
      img.style.transform = 'translate(-50%, -50%)';
      img.style.width = '74%';
      img.style.height = '74%';
      img.style.objectFit = 'contain';
      img.style.pointerEvents = 'none';
      img.style.filter = 'drop-shadow(0 1px 1px rgba(0,0,0,0.25))';
      img.style.zIndex = '1';
      square.appendChild(img);
    }
  }
}

function handleBoard8Hover(evt) {
  if (overlayFrozen) return; // stop following when frozen
  updateOverlayAtClientXY(evt.clientX, evt.clientY);
}

function updateOverlayAtClientXY(clientX, clientY) {
  // Calculate which square we are over
  const rect = board8El.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  if (x < 0 || y < 0 || x > rect.width || y > rect.height) {
    clearBoard8Overlay();
    lastTouchWithinBoard = false;
    return false;
  }
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
    return false;
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
      img.style.width = '74%';
      img.style.height = '74%';
      img.style.objectFit = 'contain';
      img.style.pointerEvents = 'none';
      img.style.filter = 'drop-shadow(0 1px 1px rgba(0,0,0,0.25))';
      square.appendChild(img);
    }
  }

  // Save current top-left for submission
  lastOverlayTopLeft = { row: startRow, col: startCol };
  lastTouchWithinBoard = true;
  return true;
}

function handleBoard8TouchStart(evt) {
  if (overlayFrozen) return;
  if (!evt.touches || evt.touches.length === 0) return;
  isTouching = true;
  lastTouchWithinBoard = false;
  // prevent synthetic mouse events and scrolling
  evt.preventDefault();
  const t = evt.touches[0];
  updateOverlayAtClientXY(t.clientX, t.clientY);
}

function handleBoard8TouchMove(evt) {
  if (overlayFrozen) return;
  if (!isTouching) return;
  if (!evt.touches || evt.touches.length === 0) return;
  evt.preventDefault();
  const t = evt.touches[0];
  updateOverlayAtClientXY(t.clientX, t.clientY);
}

function handleBoard8TouchEnd(evt) {
  if (overlayFrozen) return;
  if (!isTouching) return;
  // If touch ended within board, submit; else just clear overlay
  const endedInside = !!lastTouchWithinBoard && !!lastOverlayTopLeft;
  // Suppress the click event that some browsers fire after touchend
  suppressNextClick = true;
  isTouching = false;
  if (!endedInside) {
    clearBoard8Overlay();
    return;
  }
  // Submit like a click
  submitBoard8Selection();
}

function handleBoard8TouchCancel() {
  isTouching = false;
  lastTouchWithinBoard = false;
  if (!overlayFrozen) clearBoard8Overlay();
}

async function handleBoard8Click() {
  if (suppressNextClick) { suppressNextClick = false; return; }
  // During feedback mode, ignore clicks entirely
  if (overlayFrozen) return;
  if (!lastOverlayTopLeft) return;
  if (!geochessId) return;
  await submitBoard8Selection();
}

async function submitBoard8Selection() {
  if (overlayFrozen) return;
  if (!lastOverlayTopLeft) return;
  const id = geochessId;
  if (!id) return;
  overlayFrozen = true;
  // Freeze a copy of current placement for ghost rendering later
  try {
    if (currentFen && typeof currentFen === 'string') {
      feedbackSubfen = currentFen.split(' ')[0];
    }
  } catch(_) {}
  const payload = { id, x: lastOverlayTopLeft.col, y: lastOverlayTopLeft.row };
  try {
    const res = await fetch('/api/check_position', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    
    // Track this submission using authoritative server state when available
    if (data && data.ok === true) {
      if (Array.isArray(data.allSubmissions) && data.allSubmissions.length) {
        currentRunSubmissions = data.allSubmissions.slice();
      } else if (currentRunIndex >= 0 && currentRunIndex < currentRunSubmissions.length) {
        currentRunSubmissions[currentRunIndex] = { x: payload.x, y: payload.y, correct: data.correct };
      }
      if (typeof data.timeTakenSeconds === 'number' && isFinite(data.timeTakenSeconds)) {
        currentRunTimeTakenSeconds = data.timeTakenSeconds;
      }
    }

    // Play sound: if last puzzle, play correct/incorrect first, then run_finished
    try {
      const isLastPuzzle = (currentRunIndex === currentRunLen - 1);
      if (isLastPuzzle) {
        const correctCount = countCorrectSubmissions();
        playSfxThen(data && data.correct ? 'correct' : 'incorrect', correctCount === currentRunLen ? 'all_correct' : 'run_finished');
      } else {
        playSfx(data && data.correct ? 'correct' : 'incorrect');
      }
    } catch (_) {}
    
    showResultMessage(data);
    if (!data.correct) {
      drawFeedbackLine(lastOverlayTopLeft, { col: data.answer.x, row: data.answer.y });
    }
    // After feedback card, render ghost submission pieces and correct window pieces on right board
    try {
      // Clear any existing overlays/line before layering anew
      const imgs = board8El.querySelectorAll('img.b8-overlay');
      imgs.forEach(img => img.remove());
    if (feedbackBoxesEl) { feedbackBoxesEl.remove(); feedbackBoxesEl = null; }
      // Submission (ghosted)
      if (feedbackSubfen) {
        renderOverlayPiecesAt(lastOverlayTopLeft.row, lastOverlayTopLeft.col, feedbackSubfen, { opacity: 0.5 });
      }
      // Correct window: draw only dimx x dimy portion at the correct top-left
      if (data && typeof data.fullFen === 'string' && data.fullFen.length > 0) {
        const placement = data.fullFen.split(' ')[0];
        // infer window rows/cols from submitted subfen
        try {
          const { rows: wr, cols: wc } = parseMockFen(feedbackSubfen || '');
          const ansX = data && data.answer && typeof data.answer.x === 'number' ? data.answer.x : 0;
          const ansY = data && data.answer && typeof data.answer.y === 'number' ? data.answer.y : 0;
          renderCorrectWindowAt(ansY, ansX, placement, wr, wc);
        } catch (_) {
          // fallback to drawing nothing if parsing fails
        }
      }
      // Draw feedback borders (and arrow on top if incorrect)
      try {
        const { rows: wr, cols: wc } = parseMockFen(feedbackSubfen || '');
        drawFeedbackBoxes({
          submittedTopLeft: lastOverlayTopLeft,
          correctTopLeft: { row: data.answer.y, col: data.answer.x },
          windowRows: wr,
          windowCols: wc,
          isCorrect: !!data.correct,
        });
      } catch(_) {}
      if (!data.correct) {
        drawFeedbackLine(lastOverlayTopLeft, { col: data.answer.x, row: data.answer.y });
      }
    } catch(_) {}
    if (data && typeof data.fullFen === 'string' && data.fullFen.length > 0) {
      const placement = data.fullFen.split(' ')[0];
      currentFen = placement;
      topLeftLight = true;
      updateBoardFromInput();
      if (Array.isArray(data.lastMoveCells) && data.lastMoveCells.length) {
        setTimeout(() => highlightAbsoluteLastMove(data.lastMoveCells), 0);
      }
    }
    if (data && data.gameId && typeof data.halfMoveNum === 'number') {
      const link = document.getElementById('metaGameLink');
      if (link) {
        link.textContent = data.gameId;
        link.href = `https://lichess.org/${data.gameId}/#${data.halfMoveNum}`;
      }
      // Switch to lichess embed if toggled on and URL available
      if (useLichessEmbed) {
        toggleLichessEmbed(data.gameId, String(data.halfMoveNum));
      } else {
        toggleLichessEmbed('', '');
      }
    }
  // After submission, reveal URL/PGN rows according to metadata fields
  try {
    const fields = Array.isArray(window.METADATA_FIELDS) ? window.METADATA_FIELDS : [];
    const allowed = new Set(fields);
    const metaRowUrl = document.getElementById('metaRowUrl');
    const metaRowPgn = document.getElementById('metaRowPgn');
    const pgnLink = document.getElementById('metaPgnLink');
    if (metaRowUrl) metaRowUrl.style.display = allowed.has('url') ? '' : 'none';
    if (metaRowPgn) {
      if (allowed.has('pgn') && data && typeof data.pgn === 'string' && data.pgn.length > 0) {
        try { if (currentPgnObjectUrl) URL.revokeObjectURL(currentPgnObjectUrl); } catch(_) {}
        const blob = new Blob([data.pgn], { type: 'application/x-chess-pgn' });
        currentPgnObjectUrl = URL.createObjectURL(blob);
        if (pgnLink) {
          pgnLink.textContent = 'Download';
          pgnLink.href = currentPgnObjectUrl;
          pgnLink.download = 'game.pgn';
        }
        metaRowPgn.style.display = '';
      } else {
        metaRowPgn.style.display = 'none';
      }
    }
  } catch(_) {}
  } catch (e) {
    console.error(e);
    showResultMessage({ ok: false, error: 'Network error' });
  }
}

function showResultMessage(resp) {
  if (!errorEl) return;
  if (!resp || resp.ok !== true) {
    if (resp && resp.error) {
      console.error(resp);
      errorEl.textContent = resp.error;
    } else {
      errorEl.textContent = 'Submission failed.';
    }
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
  const runSummary = document.getElementById('runSummary');
  const metaRowUrl = document.getElementById('metaRowUrl');
  const metaRowPgn = document.getElementById('metaRowPgn');
  const pgnLink = document.getElementById('metaPgnLink');
  // Unmask metadata in feedback: populate all allowed fields with full values
  try {
    const fields = Array.isArray(window.METADATA_FIELDS) ? window.METADATA_FIELDS : [];
    const allowed = new Set(fields);
    const gm = resp && resp.gameMeta ? resp.gameMeta : null;
    if (gm) {
      const setIf = (key, id, val) => {
        if (!allowed.has(key)) return;
        const el = document.getElementById(id);
        if (el) el.textContent = val != null ? String(val) : '';
        // Also ensure the row is visible in feedback
        const rowIdByKey = {
          result: 'metaRowResult',
          whiteElo: 'metaRowWhiteElo',
          blackElo: 'metaRowBlackElo',
          move_num: 'metaRowMoveNum',
          opening_name: 'metaRowOpening',
          whitePlayer: 'metaRowWhitePlayer',
          blackPlayer: 'metaRowBlackPlayer',
          year: 'metaRowYear',
        };
        const rowEl = document.getElementById(rowIdByKey[key] || '');
        if (rowEl) rowEl.style.display = '';
      };
      setIf('result', 'metaResult', gm.result);
      setIf('whiteElo', 'metaWhiteElo', gm.whiteElo);
      setIf('blackElo', 'metaBlackElo', gm.blackElo);
      setIf('move_num', 'metaMove', gm.moveNum);
      setIf('opening_name', 'metaOpening', gm.opening_name);
      setIf('whitePlayer', 'metaWhitePlayer', gm.whitePlayer);
      setIf('blackPlayer', 'metaBlackPlayer', gm.blackPlayer);
      setIf('year', 'metaYear', gm.year);
    }
  } catch(_) {}
  
  if (card && title && nextBtn) {
    card.style.display = 'grid';
    card.classList.remove('success', 'error');
    title.textContent = resp.correct ? 'Success' : 'Incorrect';
    title.classList.remove('small-title');
    card.classList.add(resp.correct ? 'success' : 'error');
    nextBtn.classList.remove('success', 'error', 'new-run');
    
    // Check if this is the last puzzle
    const isLastPuzzle = (currentRunIndex === currentRunLen - 1);
    
    if (isLastPuzzle) {
      // Hide Next button and show run summary
      nextBtn.style.display = 'none';
      if (runSummary) {
        showRunSummary();
      }
    } else {
      // Show Next button with success/error styling
      nextBtn.style.display = 'block';
      nextBtn.textContent = 'Next';
      nextBtn.classList.add(resp.correct ? 'success' : 'error');
      // If we previously converted Next into a share-link button, restore its handler
      if (nextBtn.dataset.shareBound && shareCopyHandler) {
        try { nextBtn.removeEventListener('click', shareCopyHandler); } catch(_) {}
        delete nextBtn.dataset.shareBound;
        shareCopyHandler = null;
      }
      // Attach the handler once
      if (!nextBtn.dataset.bound) {
        nextBtn.addEventListener('click', handleNextClick);
        nextBtn.dataset.bound = '1';
      }
    }
  }

  // Reveal URL row in feedback if it is part of run metadata fields
  try {
    const fields = Array.isArray(window.METADATA_FIELDS) ? window.METADATA_FIELDS : [];
    const allowed = new Set(fields);
    if (metaRowUrl) metaRowUrl.style.display = allowed.has('url') ? '' : 'none';
    // PGN: construct a downloadable link if provided
    if (metaRowPgn) {
      if (allowed.has('pgn') && resp && typeof resp.pgn === 'string' && resp.pgn.length > 0) {
        // Revoke previous object URL to avoid leaks
        try { if (currentPgnObjectUrl) URL.revokeObjectURL(currentPgnObjectUrl); } catch(_) {}
        const blob = new Blob([resp.pgn], { type: 'application/x-chess-pgn' });
        currentPgnObjectUrl = URL.createObjectURL(blob);
        if (pgnLink) {
          pgnLink.textContent = 'Download';
          pgnLink.href = currentPgnObjectUrl;
          pgnLink.download = 'game.pgn';
        }
        metaRowPgn.style.display = '';
      } else {
        metaRowPgn.style.display = 'none';
      }
    }
  } catch(_) {}

  // If toggle is on and URL present in resp, update embed now
  try {
    if (useLichessEmbed && resp && resp.gameId && typeof resp.halfMoveNum === 'number') {
      toggleLichessEmbed(resp.gameId, String(resp.halfMoveNum));
    }
  } catch(_) {}
}

function countCorrectSubmissions() {
  return currentRunSubmissions.filter(sub => sub && sub.correct).length;
}

function showRunSummary() {
  const runSummary = document.getElementById('runSummary');
  const boxesContainer = document.getElementById('runSummaryBoxes');
  const scoreEl = document.getElementById('runSummaryScore');
  const timeEl = document.getElementById('runSummaryTime');
  const nextBtn = document.getElementById('nextButton');
  
  if (!runSummary || !boxesContainer || !scoreEl) return;
  
  // Use client-side tracked submissions
  const allSubmissions = currentRunSubmissions || [];
  
  // Clear previous content
  boxesContainer.innerHTML = '';
  
  // Count correct submissions
  let correctCount = 0;
  
  // Create a box for each submission
  allSubmissions.forEach((sub, idx) => {
    if (!sub) return; // Skip null/undefined submissions
    
    const box = document.createElement('div');
    box.className = 'run-summary-box';
    
    if (sub.correct) {
      box.classList.add('correct');
      box.innerHTML = '✓';
      correctCount++;
    } else {
      box.classList.add('incorrect');
      box.innerHTML = '✕';
    }
    
    boxesContainer.appendChild(box);
  });
  
  // Show score
  scoreEl.textContent = `You solved ${correctCount}/${allSubmissions.length} correctly.`;
  // Show elapsed time if provided by server
  if (timeEl) {
    if (typeof currentRunTimeTakenSeconds === 'number' && isFinite(currentRunTimeTakenSeconds)) {
      timeEl.textContent = `Time taken: ${formatDuration(currentRunTimeTakenSeconds)}`;
      timeEl.style.display = '';
    } else {
      timeEl.textContent = '';
      timeEl.style.display = 'none';
    }
  }
  
  // Show the summary
  runSummary.style.display = 'flex';
  
  // Setup "Copy run link" button
  const copyLinkBtn = document.getElementById('copyRunLinkBtn');
  if (copyLinkBtn && !copyLinkBtn.dataset.bound) {
    copyLinkBtn.addEventListener('click', async () => {
      try {
        const url = window.location.href;
        await navigator.clipboard.writeText(url);
        // Visual feedback
        copyLinkBtn.textContent = 'Copied!';
        copyLinkBtn.classList.add('copied');
        setTimeout(() => {
          copyLinkBtn.textContent = 'Copy run link';
          copyLinkBtn.classList.remove('copied');
        }, 2000);
      } catch (err) {
        console.error('Failed to copy:', err);
        copyLinkBtn.textContent = 'Failed';
        setTimeout(() => {
          copyLinkBtn.textContent = 'Copy run link';
        }, 2000);
      }
    });
    copyLinkBtn.dataset.bound = '1';
  }
  
  // Show "Start new run" button
  if (nextBtn) {
    nextBtn.style.display = 'block';
    nextBtn.textContent = 'Start new run';
    nextBtn.classList.remove('success', 'error');
    nextBtn.classList.add('new-run');
    
    // Replace click handler to open new run modal
    if (!nextBtn.dataset.newRunBound) {
      nextBtn.removeEventListener('click', handleNextClick);
      nextBtn.addEventListener('click', () => {
        const modal = document.getElementById('runModal');
        if (modal) modal.style.display = 'grid';
      });
      nextBtn.dataset.newRunBound = '1';
    }
  }
}

function formatDuration(totalSeconds) {
  try {
    const s = Math.max(0, Math.floor(Number(totalSeconds) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    const pad = (n) => String(n).padStart(2, '0');
    if (h > 0) return `${h}:${pad(m)}:${pad(r)}`;
    return `${m}:${pad(r)}`;
  } catch (_) {
    return '';
  }
}

async function replayPriorSubmission(x, y, correct) {
  // Hide labels immediately
  const lblL = document.getElementById('labelLeft');
  const lblR = document.getElementById('labelRight');
  if (lblL) lblL.style.display = 'none';
  if (lblR) lblR.style.display = 'none';

  // Set frozen state
  overlayFrozen = true;
  // Preserve the subfen used at the time of submission
  try {
    if (currentFen && typeof currentFen === 'string') {
      feedbackSubfen = currentFen.split(' ')[0];
    }
  } catch(_) {}
  
  // Fetch full feedback data from server
  const id = geochessId;
  if (!id) return;
  const payload = { id, x, y };
  try {
    const res = await fetch('/api/check_position', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    
    // Sync all submissions and time BEFORE showing the feedback card (so summary can use them)
    try {
      if (Array.isArray(data.allSubmissions) && data.allSubmissions.length) {
        currentRunSubmissions = data.allSubmissions.slice();
      }
      if (typeof data.timeTakenSeconds === 'number' && isFinite(data.timeTakenSeconds)) {
        currentRunTimeTakenSeconds = data.timeTakenSeconds;
      }
    } catch(_) {}
    // Show feedback card
    showResultMessage(data);
    
    // Render ghost submission pieces and correct window pieces
    try {
      // Clear overlays
      const imgs = board8El.querySelectorAll('img.b8-overlay');
      imgs.forEach(img => img.remove());
    if (feedbackBoxesEl) { feedbackBoxesEl.remove(); feedbackBoxesEl = null; }
      // Submission (ghost)
      if (feedbackSubfen) {
        renderOverlayPiecesAt(y, x, feedbackSubfen, { opacity: 0.5 });
      }
      // Correct window at the correct top-left
      if (data && typeof data.fullFen === 'string' && data.fullFen.length > 0) {
        const placement = data.fullFen.split(' ')[0];
        try {
          const { rows: wr, cols: wc } = parseMockFen(feedbackSubfen || '');
          const ansX = data && data.answer && typeof data.answer.x === 'number' ? data.answer.x : 0;
          const ansY = data && data.answer && typeof data.answer.y === 'number' ? data.answer.y : 0;
          renderCorrectWindowAt(ansY, ansX, placement, wr, wc);
        } catch (_) {}
      }
      // Borders and arrow
      try {
        const { rows: wr, cols: wc } = parseMockFen(feedbackSubfen || '');
        drawFeedbackBoxes({
          submittedTopLeft: { row: y, col: x },
          correctTopLeft: { row: data.answer.y, col: data.answer.x },
          windowRows: wr,
          windowCols: wc,
          isCorrect: !!data.correct,
        });
      } catch(_) {}
      if (!data.correct) {
        const submitted = { col: x, row: y };
        const answer = { col: data.answer.x, row: data.answer.y };
        drawFeedbackLine(submitted, answer);
      }
    } catch(_) {}
    
    // Switch left board to full FEN
    if (data && typeof data.fullFen === 'string' && data.fullFen.length > 0) {
      const placement = data.fullFen.split(' ')[0];
      currentFen = placement;
      topLeftLight = true;
      updateBoardFromInput();
      if (Array.isArray(data.lastMoveCells) && data.lastMoveCells.length) {
        setTimeout(() => highlightAbsoluteLastMove(data.lastMoveCells), 0);
      }
    }
    
    // Update game link
    if (data && data.gameId && typeof data.halfMoveNum === 'number') {
      const link = document.getElementById('metaGameLink');
      if (link) {
        link.textContent = data.gameId;
        link.href = `https://lichess.org/${data.gameId}/#${data.halfMoveNum}`;
      }
      if (useLichessEmbed) {
        toggleLichessEmbed(data.gameId, String(data.halfMoveNum));
      } else {
        toggleLichessEmbed('', '');
      }
    }
  } catch (e) {
    console.error(e);
    showResultMessage({ ok: false, error: 'Network error' });
  }
}

async function handleNextClick() {
  try {
    if (!currentRunId) return;
    const res = await fetch(`/api/next/${encodeURIComponent(currentRunId)}?index=${encodeURIComponent(currentRunIndex)}`);
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
    // Update run state and active GeoChess id
    geochessId = data.geochess_id || null;
    currentRunIndex = Number(data.index || (currentRunIndex + 1));
    currentRunLen = Number(data.len || currentRunLen);
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
    // Update puzzle number
    setText('metaPuzzleNum', `${currentRunIndex + 1}/${currentRunLen}`);
    if (data.game_meta) {
    setText('metaResult', data.game_meta.result || '');
    setText('metaWhiteElo', data.game_meta.whiteElo || '');
    setText('metaOpening', data.game_meta.opening_name || '');
    setText('metaBlackElo', data.game_meta.blackElo || '');
    setText('metaMove', data.game_meta.moveNum || '');
    setText('metaWhitePlayer', data.game_meta.whitePlayer || '');
    setText('metaBlackPlayer', data.game_meta.blackPlayer || '');
    setText('metaYear', data.game_meta.year || '');
    } else {
    setText('metaResult', ''); setText('metaWhiteElo', ''); setText('metaBlackElo', ''); setText('metaMove', ''); setText('metaWhitePlayer',''); setText('metaBlackPlayer',''); setText('metaYear','');
    }
    // Reset URL link
    const link = document.getElementById('metaGameLink');
    if (link) { link.textContent = ''; link.removeAttribute('href'); }
  // Hide URL/PGN rows until next submission feedback
  try {
    const metaRowUrl = document.getElementById('metaRowUrl');
    const metaRowPgn = document.getElementById('metaRowPgn');
    if (metaRowUrl) metaRowUrl.style.display = 'none';
    if (metaRowPgn) metaRowPgn.style.display = 'none';
    if (currentPgnObjectUrl) { try { URL.revokeObjectURL(currentPgnObjectUrl); } catch(_) {} currentPgnObjectUrl = null; }
  } catch(_) {}

    // Hide feedback card and run summary
    const card = document.getElementById('feedbackCard');
    if (card) { card.style.display = 'none'; card.classList.remove('success', 'error'); }
    const title = document.getElementById('feedbackTitle');
    if (title) { title.textContent = ''; title.classList.remove('small-title'); }
    const runSummary = document.getElementById('runSummary');
    if (runSummary) { runSummary.style.display = 'none'; }
    const nextBtn = document.getElementById('nextButton');
    if (nextBtn) {
      nextBtn.classList.remove('success', 'error', 'new-run');
      nextBtn.textContent = 'Next';
      // Hide Next button entirely if last puzzle reached
      if (data.is_last === true) {
        nextBtn.style.display = 'none';
      } else {
        nextBtn.style.display = 'block';
      }
    }
    // Ensure left board is visible again, hide lichess embed for new puzzle
    toggleLichessEmbed('', '');
    // Re-apply layout sizing after new position
    applyLayoutSizing();
    // Hide initial labels permanently after first submission
    const lblL = document.getElementById('labelLeft');
    const lblR = document.getElementById('labelRight');
    if (lblL) lblL.style.display = 'none';
    if (lblR) lblR.style.display = 'none';
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

function toggleLichessEmbed(gameId, halfMoveNumStr) {
  // Only allow embed if run metadata includes 'url'
  const fields = Array.isArray(window.METADATA_FIELDS) ? window.METADATA_FIELDS : [];
  const hasUrlField = fields.includes('url');
  // Show iframe instead of left board in feedback if enabled and a URL exists
  const hasUrl = hasUrlField && !!gameId && !!halfMoveNumStr;
  if (!useLichessEmbed || !hasUrl) {
    // Hide iframe, show board
    if (lichessShellEl) lichessShellEl.style.display = 'none';
    if (boardShellEl) boardShellEl.style.display = '';
    // Clear iframe src to avoid playing anything in background
    if (lichessIframeEl) lichessIframeEl.src = '';
    return;
  }
  // Build embed URL
  const src = `https://lichess.org/embed/game/${encodeURIComponent(gameId)}#${encodeURIComponent(halfMoveNumStr)}?theme=auto&bg=auto`;
  if (lichessIframeEl) lichessIframeEl.src = src;
  // Show iframe shell, hide board shell
  if (lichessShellEl) lichessShellEl.style.display = '';
  if (boardShellEl) boardShellEl.style.display = 'none';
  // Keep sizes consistent
  enforceLeftBoardMaxHeight();
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
  const strokeWidth = 10; // must match line stroke-width

  // Centers of rectangles
  const subCenterX = (submittedTopLeft.col + currentCols / 2) * squareW-strokeWidth/2;
  const subCenterY = (submittedTopLeft.row + currentRows / 2) * squareH-strokeWidth/2;
  const corCenterX = (correctTopLeft.col + currentCols / 2) * squareW-strokeWidth/2;
  const corCenterY = (correctTopLeft.row + currentRows / 2) * squareH-strokeWidth/2;

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

// Draw green/red boxes around the dimx x dimy windows on the right board.
// If isCorrect is true, only draw the green box at correctTopLeft.
function drawFeedbackBoxes(opts) {
  if (!opts) return;
  const submittedTopLeft = opts.submittedTopLeft;
  const correctTopLeft = opts.correctTopLeft;
  const wr = Math.max(1, Math.min(8, Number(opts.windowRows) || 1));
  const wc = Math.max(1, Math.min(8, Number(opts.windowCols) || 1));
  const isCorrect = !!opts.isCorrect;

  if (feedbackBoxesEl) { feedbackBoxesEl.remove(); feedbackBoxesEl = null; }

  const rect = board8El.getBoundingClientRect();
  const squareW = rect.width / 8;
  const squareH = rect.height / 8;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'feedback-boxes');
  svg.setAttribute('width', String(rect.width));
  svg.setAttribute('height', String(rect.height));
  svg.style.position = 'absolute';
  svg.style.left = '0';
  svg.style.top = '0';
  svg.style.pointerEvents = 'none';

  // Pick a stroke width proportional to square size, clamped
  const strokeW = Math.max(4, Math.min(10, Math.floor(Math.min(squareW, squareH) * 0.12)));

  // Helper to add a rectangle whose stroke center aligns exactly with grid lines
  function addRect(topLeft, color) {
    const xEdge = topLeft.col * squareW;
    const yEdge = topLeft.row * squareH;
    const wEdge = wc * squareW;
    const hEdge = wr * squareH;
    // Position rect so its stroke is centered on the selection edges
    const x = xEdge - strokeW / 2;
    const y = yEdge - strokeW / 2;
    const w = Math.max(0, wEdge);
    const h = Math.max(0, hEdge);
    const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    r.setAttribute('x', String(x));
    r.setAttribute('y', String(y));
    r.setAttribute('width', String(w));
    r.setAttribute('height', String(h));
    r.setAttribute('fill', 'none');
    r.setAttribute('stroke', color);
    r.setAttribute('stroke-width', String(strokeW));
    r.setAttribute('stroke-opacity', '0.85');
    svg.appendChild(r);
  }

  // Green border for correct
  if (correctTopLeft) addRect(correctTopLeft, '#10b981');
  // Red border for submitted if incorrect
  if (!isCorrect && submittedTopLeft) addRect(submittedTopLeft, '#ef4444');

  board8El.style.position = 'relative';
  board8El.appendChild(svg);
  feedbackBoxesEl = svg;
}

function enforceLeftBoardMaxHeight() {
  if (!boardEl || !board8El) return;
  if (!currentRows || !currentCols) return;
  const rightHeight = board8El.getBoundingClientRect().height;
  if (!rightHeight || rightHeight <= 0) return;
  // Height_left = width_left * rows/cols (since aspect-ratio is cols/rows)
  // We need width_left <= rightHeight * (cols/rows)
  const maxAllowedWidth = rightHeight * (currentCols / currentRows);
  // Always cap the board width so its height never exceeds the right board height,
  // regardless of the mock FEN dimensions (works for tall/wide boards like 2x3, 3x2, etc.).
  boardEl.style.maxWidth = `${Math.floor(maxAllowedWidth)}px`;
  // Keep lichess shell matched as well (when visible)
  if (lichessShellEl) {
    lichessShellEl.style.maxWidth = `${Math.floor(maxAllowedWidth)}px`;
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

function applyLayoutSizing() {
  const wrapper = document.querySelector('.boards');
  if (!wrapper) return;
  const isLandscape = window.innerWidth >= window.innerHeight;
  if (!isLandscape) {
    // Reset to CSS-controlled sizing in portrait
    wrapper.style.gridTemplateColumns = '';
    document.documentElement.style.setProperty('--meta-scale', '1');
    return;
  }
  const leftW = boardEl ? boardEl.getBoundingClientRect().width : 0;
  const shellW = boardShellEl ? boardShellEl.getBoundingClientRect().width : leftW;
  const lichessShellW = lichessShellEl && lichessShellEl.style.display !== 'none' ? lichessShellEl.getBoundingClientRect().width : 0;
  const rightW = board8El ? board8El.getBoundingClientRect().width : 0;
  const effectiveLeft = Math.max(shellW, lichessShellW);
  const boardW = Math.max(0, Math.min(effectiveLeft || rightW, rightW || effectiveLeft));
  if (!boardW) return;
  const RATIO = 0.75; // meta width relative to a board width
  let metaW = Math.round(boardW * RATIO);
  // Keep within reasonable bounds from previous design
  metaW = Math.max(240, Math.min(420, metaW));
  wrapper.style.gridTemplateColumns = `auto auto ${metaW}px`;

   // Scale meta content based on viewport height versus board size
   const vh = window.innerHeight || 0;
   if (vh > 0) {
     // Target: boards plus meta should fit; when vh is small, shrink meta typography
     // Compute a scale between 0.8 and 1.0 depending on height
     const targetH = 820; // heuristic total content height
     const scale = Math.max(0.8, Math.min(1.0, vh / targetH));
     document.documentElement.style.setProperty('--meta-scale', String(scale));
   }
}


