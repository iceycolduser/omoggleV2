(() => {
  const ID_KEY = 'omoggle_v2_player_id';
  const HANDLE_KEY = 'omoggle_v2_handle';
  const AGE_KEY = 'omoggle_v2_age_ok';
  const STATS_KEY = 'omoggle_v2_last_stats';

  const form = document.getElementById('enter-form');
  const handleInput = document.getElementById('handle');
  const ageOk = document.getElementById('age-ok');
  const enterBtn = document.getElementById('enter-btn');

  handleInput.value = localStorage.getItem(HANDLE_KEY) || '';
  ageOk.checked = localStorage.getItem(AGE_KEY) === '1';

  // hydrate hero stats from last session
  try {
    const cached = JSON.parse(localStorage.getItem(STATS_KEY) || '{}');
    if (cached.elo) document.getElementById('your-elo').textContent = cached.elo;
    if (cached.psl != null) document.getElementById('your-psl').textContent = Number(cached.psl).toFixed(2);
    if (cached.mogs != null) document.getElementById('your-mogs').textContent = cached.mogs;
  } catch {}

  // live counters
  async function tickStats() {
    try {
      const r = await fetch('/api/stats');
      if (!r.ok) return;
      const j = await r.json();
      document.getElementById('online-count').textContent = j.online ?? '—';
      document.getElementById('match-count').textContent = j.matches ?? '—';
    } catch {}
  }
  tickStats();
  setInterval(tickStats, 5000);

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!ageOk.checked) {
      ageOk.parentElement.style.color = 'var(--danger)';
      ageOk.focus();
      return;
    }
    localStorage.setItem(AGE_KEY, '1');
    const h = handleInput.value.trim().slice(0, 20);
    if (h) localStorage.setItem(HANDLE_KEY, h);
    if (!localStorage.getItem(ID_KEY)) {
      // server will mint one on hello if none provided; pre-generate so reconnects are stable
      localStorage.setItem(ID_KEY, mintId());
    }
    enterBtn.textContent = 'entering…';
    enterBtn.disabled = true;
    location.href = '/arena.html';
  });

  function mintId() {
    const a = new Uint8Array(12);
    crypto.getRandomValues(a);
    return Array.from(a, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 16);
  }
})();
