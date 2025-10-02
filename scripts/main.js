// 3x3 Chessboard (Mock FEN) client script
// Keeps parity with original mockup functionality

const BOARD_SIZE = 3;
const PIECE_LETTERS = new Set(['p','r','n','b','q','k','P','R','N','B','Q','K']);

const boardEl = document.getElementById('board');
const fenForm = document.getElementById('fenForm');
const fenInput = document.getElementById('fenInput');
const errorEl = document.getElementById('error');

function createBoardSquares() {
  boardEl.innerHTML = '';
  for (let rowIndex = 0; rowIndex < BOARD_SIZE; rowIndex += 1) {
    for (let colIndex = 0; colIndex < BOARD_SIZE; colIndex += 1) {
      const square = document.createElement('div');
      square.className = 'square ' + (((rowIndex + colIndex) % 2 === 0) ? 'light' : 'dark');
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

function renderCells(cells) {
  for (let rowIndex = 0; rowIndex < BOARD_SIZE; rowIndex += 1) {
    for (let colIndex = 0; colIndex < BOARD_SIZE; colIndex += 1) {
      const i = rowIndex * BOARD_SIZE + colIndex;
      const square = document.getElementById(`sq-${rowIndex}-${colIndex}`);
      square.innerHTML = '';
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
  if (ranks.length !== BOARD_SIZE) {
    throw new Error(`FEN must have ${BOARD_SIZE} ranks separated by '/'.`);
  }
  const cells = [];
  for (let r = 0; r < BOARD_SIZE; r += 1) {
    const rank = ranks[r];
    let fileCount = 0;
    for (let idx = 0; idx < rank.length; idx += 1) {
      const ch = rank[idx];
      if (ch >= '1' && ch <= '9') {
        const empties = parseInt(ch, 10);
        if (empties < 1 || empties > BOARD_SIZE) {
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
      if (fileCount > BOARD_SIZE) {
        throw new Error(`Too many squares in rank ${r + 1}.`);
      }
    }
    if (fileCount !== BOARD_SIZE) {
      throw new Error(`Rank ${r + 1} must have exactly ${BOARD_SIZE} squares.`);
    }
  }
  if (cells.length !== BOARD_SIZE * BOARD_SIZE) {
    throw new Error('Parsed board does not have 9 squares.');
  }
  return cells;
}

function updateBoardFromInput() {
  errorEl.textContent = '';
  try {
    const fen = fenInput.value;
    const cells = parseMockFen(fen);
    renderCells(cells);
  } catch (err) {
    errorEl.textContent = err && err.message ? err.message : String(err);
  }
}

fenForm.addEventListener('submit', function(evt) {
  evt.preventDefault();
  updateBoardFromInput();
});

document.addEventListener('DOMContentLoaded', function() {
  createBoardSquares();
  const defaultFen = 'r2/bb1/B2';
  fenInput.value = defaultFen;
  updateBoardFromInput();
});


