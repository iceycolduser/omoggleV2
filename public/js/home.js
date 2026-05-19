(() => {
  const ID_KEY     = 'omoggle_v2_player_id';
  const HANDLE_KEY = 'omoggle_v2_handle';
  const AGE_KEY    = 'omoggle_v2_age_ok';
  const STATS_KEY  = 'omoggle_v2_last_stats';

  const $ = (id) => document.getElementById(id);

  // ---------- DOM ----------
  const handleEl   = $('handle');
  const statusEl   = $('handle-status');
  const ageOk      = $('age-ok');
  const btnEnter   = $('btn-enter');
  const btnFriend  = $('btn-friend');
  const pfpInput   = $('pfp-input');
  const pfpPreview = $('pfp-preview');
  const pfpInitial = $('pfp-initial');
  const pfpDrop    = $('pfp-drop');
  const friendOverlay = $('friend-overlay');
  const friendClose   = $('friend-close');
  const friendTabs    = document.querySelectorAll('[data-friend-tab]');
  const hostPanel     = $('friend-host');
  const joinPanel     = $('friend-join');
  const btnHost       = $('btn-host');
  const btnJoin       = $('btn-join');
  const joinCodeEl    = $('join-code');
  const joinError     = $('join-error');

  // ---------- state ----------
  let claimedPlayerId = localStorage.getItem(ID_KEY) || null;
  let claimedHandle   = null;
  let availability = { ok: false, value: '' };
  let pendingPfpDataUrl = null;
  let pendingPfpBuf = null;

  ageOk.checked = localStorage.getItem(AGE_KEY) === '1';
  handleEl.value = localStorage.getItem(HANDLE_KEY) || '';

  // hydrate hero stats
  try {
    const cached = JSON.parse(localStorage.getItem(STATS_KEY) || '{}');
    if (cached.elo)  $('your-elo').textContent  = cached.elo;
    if (cached.tier) $('your-tier').textContent = cached.tier;
    if (cached.mogs != null) $('your-mogs').textContent = cached.mogs;
  } catch {}

  if (claimedPlayerId) {
    $('pfp-preview').src = `/pfp/${claimedPlayerId}?t=${Date.now()}`;
    $('pfp-preview').onerror = () => { $('pfp-preview').removeAttribute('src'); };
  }

  // ---------- live counters ----------
  async function tickStats() {
    try {
      const r = await fetch('/api/stats');
      if (!r.ok) return;
      const j = await r.json();
      $('online-count').textContent = j.online ?? '—';
      $('match-count').textContent  = j.matches ?? '—';
    } catch {}
  }
  tickStats(); setInterval(tickStats, 5000);

  // ---------- handle availability (debounced) ----------
  let checkTimer = null;
  function syncEnter() {
    const ready = availability.ok && ageOk.checked && handleEl.value.trim();
    btnEnter.disabled = !ready;
    btnFriend.disabled = !ready;
  }
  function setStatus(text, cls) {
    statusEl.textContent = text;
    statusEl.className = 'field-status' + (cls ? ' ' + cls : '');
  }
  function refreshPfpInitial() {
    const v = handleEl.value.trim();
    pfpInitial.textContent = v ? v[0].toUpperCase() : '?';
  }
  handleEl.addEventListener('input', () => {
    refreshPfpInitial();
    const v = handleEl.value.trim();
    clearTimeout(checkTimer);
    availability = { ok: false, value: v };
    if (!v) { setStatus('type to check availability', ''); syncEnter(); return; }
    if (v.length < 3) { setStatus('too short (min 3)', 'err'); syncEnter(); return; }
    if (v.length > 20) { setStatus('too long (max 20)', 'err'); syncEnter(); return; }
    if (!/^[A-Za-z0-9_\-]+$/.test(v)) { setStatus('letters, numbers, _ and - only', 'err'); syncEnter(); return; }
    setStatus('checking…', 'pending');
    syncEnter();
    checkTimer = setTimeout(async () => {
      try {
        const r = await fetch('/api/handle/check?name=' + encodeURIComponent(v));
        const j = await r.json();
        if (handleEl.value.trim() !== v) return; // stale
        if (j.ok) { availability = { ok: true, value: v }; setStatus('available ✓', 'ok'); }
        else if (j.error === 'taken') { setStatus('already taken', 'err'); }
        else if (j.error === 'inappropriate') { setStatus('not allowed', 'err'); }
        else { setStatus('invalid', 'err'); }
        syncEnter();
      } catch {
        setStatus('check failed — try again', 'err');
        syncEnter();
      }
    }, 320);
  });
  refreshPfpInitial();
  ageOk.addEventListener('change', () => {
    localStorage.setItem(AGE_KEY, ageOk.checked ? '1' : '0');
    syncEnter();
  });
  syncEnter();

  // ---------- pfp upload (client-side resize) ----------
  pfpDrop.addEventListener('click', (e) => {
    // clicking anywhere on the drop area triggers the file picker
    if (e.target !== pfpInput) pfpInput.click();
  });
  pfpInput.addEventListener('change', async () => {
    const file = pfpInput.files?.[0];
    if (!file) return;
    if (!/^image\//.test(file.type)) return;
    try {
      const dataUrl = await squashImageToDataUrl(file, 256, 0.82);
      pendingPfpDataUrl = dataUrl;
      pfpPreview.src = dataUrl;
      pfpPreview.style.display = 'block';
      pfpDrop.classList.add('has-pfp');
    } catch (e) {
      console.warn('pfp resize failed', e);
    }
  });

  function squashImageToDataUrl(file, maxSide, quality) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        const side = Math.min(maxSide, Math.max(img.width, img.height));
        // square crop centred
        const srcSide = Math.min(img.width, img.height);
        const sx = (img.width - srcSide) / 2;
        const sy = (img.height - srcSide) / 2;
        const c = document.createElement('canvas');
        c.width = c.height = side;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#0a0a12';
        ctx.fillRect(0, 0, side, side);
        ctx.drawImage(img, sx, sy, srcSide, srcSide, 0, 0, side, side);
        let url2 = c.toDataURL('image/jpeg', quality);
        // shrink further if still too big
        let q = quality;
        while (url2.length > 120_000 && q > 0.4) {
          q -= 0.1;
          url2 = c.toDataURL('image/jpeg', q);
        }
        resolve(url2);
      };
      img.onerror = (err) => { URL.revokeObjectURL(url); reject(err); };
      img.src = url;
    });
  }

  // ---------- claim ----------
  async function claim() {
    const v = handleEl.value.trim();
    if (!v) return null;
    const body = { handle: v };
    if (claimedPlayerId) body.playerId = claimedPlayerId;
    const r = await fetch('/api/claim', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!r.ok) {
      setStatus(errorLabel(j.error), 'err');
      syncEnter();
      return null;
    }
    claimedPlayerId = j.playerId;
    claimedHandle = j.handle;
    localStorage.setItem(ID_KEY, j.playerId);
    localStorage.setItem(HANDLE_KEY, j.handle);
    try {
      const cur = JSON.parse(localStorage.getItem(STATS_KEY) || '{}');
      localStorage.setItem(STATS_KEY, JSON.stringify({
        ...cur, elo: j.elo, tier: j.tier, mogs: j.mogs ?? cur.mogs ?? 0,
      }));
    } catch {}
    return j;
  }

  async function uploadPfpIfPending() {
    if (!pendingPfpDataUrl || !claimedPlayerId) return;
    try {
      await fetch('/api/pfp', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ playerId: claimedPlayerId, dataUrl: pendingPfpDataUrl }),
      });
      pendingPfpDataUrl = null;
    } catch {}
  }

  function errorLabel(code) {
    switch (code) {
      case 'too_short':     return 'too short (min 3)';
      case 'too_long':      return 'too long (max 20)';
      case 'bad_chars':     return 'letters, numbers, _ and - only';
      case 'inappropriate': return 'not allowed — try another';
      case 'taken':         return 'already taken';
      case 'invalid':       return 'invalid handle';
      default:              return 'something broke — try again';
    }
  }

  // ---------- enter the arena ----------
  btnEnter.addEventListener('click', async (e) => {
    e.preventDefault();
    if (!ageOk.checked) return;
    btnEnter.disabled = true;
    btnEnter.textContent = 'claiming…';
    const claimed = await claim();
    if (!claimed) {
      btnEnter.textContent = 'enter the arena →';
      syncEnter();
      return;
    }
    await uploadPfpIfPending();
    btnEnter.textContent = 'entering…';
    location.href = '/arena.html';
  });

  // ---------- play a friend ----------
  btnFriend.addEventListener('click', async () => {
    if (!ageOk.checked) return;
    // Make sure the handle is claimed first so the room socket can identify us.
    btnFriend.disabled = true;
    if (!claimedHandle) {
      const claimed = await claim();
      if (!claimed) { btnFriend.disabled = false; return; }
      await uploadPfpIfPending();
    }
    friendOverlay.hidden = false;
    document.body.style.overflow = 'hidden';
  });
  friendClose.addEventListener('click', () => closeFriendOverlay());
  friendOverlay.addEventListener('click', (e) => {
    if (e.target === friendOverlay) closeFriendOverlay();
  });
  function closeFriendOverlay() {
    friendOverlay.hidden = true;
    document.body.style.overflow = '';
    syncEnter();
  }
  friendTabs.forEach((b) => b.addEventListener('click', () => {
    friendTabs.forEach((x) => x.classList.toggle('active', x === b));
    const which = b.dataset.friendTab;
    hostPanel.hidden = which !== 'host';
    joinPanel.hidden = which !== 'join';
  }));

  // The room create / join lifecycle lives on the arena page so the socket
  // that hosts the room is the same one that handles the match. The home
  // page just collects the user's intent and hands off.
  btnHost.addEventListener('click', () => {
    // hand off — arena will emit room:create after it claims the same handle
    location.href = '/arena.html?host=1';
  });

  btnCopyLink.addEventListener('click', () => {});  // unused on home

  joinCodeEl.addEventListener('input', () => {
    joinCodeEl.value = joinCodeEl.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  });
  btnJoin.addEventListener('click', () => {
    const code = joinCodeEl.value.trim().toUpperCase();
    if (code.length !== 6) {
      joinError.hidden = false; joinError.textContent = 'codes are 6 characters';
      return;
    }
    location.href = '/arena.html?room=' + encodeURIComponent(code);
  });

  // pick up ?room=XYZ on the home URL too — auto-redirect with claim
  const urlParams = new URLSearchParams(location.search);
  const incomingRoom = urlParams.get('room');
  if (incomingRoom) {
    joinCodeEl.value = incomingRoom.toUpperCase().slice(0, 6);
    // open the friend overlay with the join tab focused, once the user has a name
    document.addEventListener('DOMContentLoaded', () => {
      friendTabs.forEach((b) => b.classList.toggle('active', b.dataset.friendTab === 'join'));
      hostPanel.hidden = true; joinPanel.hidden = false;
    });
  }
})();
