document.addEventListener('DOMContentLoaded', () => {
  const boxesContainer = document.getElementById('runSummaryBoxes');
  const timeEl = document.getElementById('runSummaryTime');
  const puzzleIds = Array.isArray(window.CERT_PUZZLE_IDS) ? window.CERT_PUZZLE_IDS : [];
  const successes = Array.isArray(window.CERT_SUCCESSES) ? window.CERT_SUCCESSES : [];
  const timeTaken = (typeof window.CERT_TIME_TAKEN_SECONDS === 'number') ? window.CERT_TIME_TAKEN_SECONDS : null;

  // Build boxes
  boxesContainer.innerHTML = '';
  for (let i = 0; i < puzzleIds.length; i += 1) {
    const box = document.createElement('div');
    box.className = 'run-summary-box ' + (successes[i] ? 'correct' : 'incorrect');
    // add visual mark like in run summary
    box.textContent = successes[i] ? '✓' : '✕';
    // click: open puzzle in new tab
    const pid = puzzleIds[i];
    if (pid != null) {
      box.style.cursor = 'pointer';
      box.title = 'Open this puzzle';
      box.addEventListener('click', () => {
        window.open(`/puzzle/${encodeURIComponent(pid)}`, '_blank', 'noopener,noreferrer');
      });
    }
    boxesContainer.appendChild(box);
  }

  // Stats table (Yours vs Average), like run summary
  function formatDuration(totalSeconds) {
    try {
      totalSeconds = Number(totalSeconds);
      if (!isFinite(totalSeconds)) return '—';
      const m = Math.floor(totalSeconds / 60);
      const s = totalSeconds % 60;
      return `${m}:${String(s).padStart(2, '0')}`;
    } catch(_) { return '—'; }
  }

  try {
    const stats = (window.RUN_STATS && typeof window.RUN_STATS === 'object') ? window.RUN_STATS : { completedCount: 0 };
    const completedCount = Number(stats.completedCount || 0);
    const avgTimeSeconds = (stats.avgTimeSeconds != null && isFinite(Number(stats.avgTimeSeconds))) ? Number(stats.avgTimeSeconds) : null;
    const avgCorrectCount = (stats.avgCorrectCount != null) ? Number(stats.avgCorrectCount) : null;

    const yoursSolved = `${successes.filter(Boolean).length}/${puzzleIds.length}`;
    const avgSolved = (avgCorrectCount != null) ? `${Math.round(avgCorrectCount)}/${puzzleIds.length}` : '—';
    const yoursTime = (timeTaken != null) ? formatDuration(timeTaken) : '—';
    const avgTime = (avgTimeSeconds != null) ? formatDuration(Math.round(avgTimeSeconds)) : '—';

    if (timeEl) {
      timeEl.style.display = '';
      timeEl.innerHTML = '';
      const msg = document.createElement('div');
      msg.className = 'run-summary-note';
      msg.textContent = `This run has been completed ${completedCount} ${completedCount === 1 ? 'time' : 'times'}.`;
      timeEl.appendChild(msg);

      const table = document.createElement('table');
      const thead = document.createElement('thead');
      const trh = document.createElement('tr');
      ['', 'Yours', 'Average'].forEach(txt => { const th = document.createElement('th'); th.textContent = txt; trh.appendChild(th); });
      thead.appendChild(trh);
      table.appendChild(thead);
      const tbody = document.createElement('tbody');
      const rows = [['Solved', yoursSolved, avgSolved], ['Time', yoursTime, avgTime]];
      rows.forEach(r => { const tr = document.createElement('tr'); r.forEach((cell, idx) => { const el = idx === 0 ? document.createElement('th') : document.createElement('td'); el.textContent = cell; tr.appendChild(el); }); tbody.appendChild(tr); });
      table.appendChild(tbody);
      timeEl.appendChild(table);
    }
  } catch (_) {}
});


