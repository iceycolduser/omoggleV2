(() => {
  const rows = document.getElementById('board-rows');
  const tabs = document.querySelectorAll('.tab');
  let cur = 'elo';

  function render(list) {
    if (!list.length) {
      rows.innerHTML = '<div class="board-empty">no matches yet — be first on the board.</div>';
      return;
    }
    rows.innerHTML = list.map((p, i) => {
      const rk = (i + 1);
      const cls = rk === 1 ? 'top1' : rk === 2 ? 'top2' : rk === 3 ? 'top3' : '';
      const psl = p.psl != null ? Number(p.psl).toFixed(2) : '—';
      const wld = `${p.wins ?? 0}/${p.losses ?? 0}/${p.draws ?? 0}`;
      const handle = escapeHtml(p.handle || 'anon');
      return `<div class="board-row">
        <span class="rank ${cls}">#${rk}</span>
        <span class="handle">${handle}</span>
        <span class="elo">${p.elo}</span>
        <span class="psl">${psl}</span>
        <span class="wld">${wld}</span>
        <span class="mogs">${p.mogs ?? 0}</span>
      </div>`;
    }).join('');
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function load() {
    rows.innerHTML = '<div class="board-empty">loading…</div>';
    try {
      const r = await fetch('/api/leaderboard?board=' + cur + '&limit=100');
      const j = await r.json();
      render(j.board || []);
    } catch {
      rows.innerHTML = '<div class="board-empty">failed to load</div>';
    }
  }

  tabs.forEach((t) => t.addEventListener('click', () => {
    tabs.forEach((x) => x.classList.toggle('active', x === t));
    cur = t.dataset.board;
    load();
  }));

  load();
  setInterval(load, 15_000);
})();
