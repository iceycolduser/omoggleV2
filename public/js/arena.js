(() => {
  const ID_KEY = 'omoggle_v2_player_id';
  const HANDLE_KEY = 'omoggle_v2_handle';
  const AGE_KEY = 'omoggle_v2_age_ok';
  const STATS_KEY = 'omoggle_v2_last_stats';

  if (localStorage.getItem(AGE_KEY) !== '1') { location.href = '/'; return; }

  const $ = (id) => document.getElementById(id);
  const stages = {
    calibrate: $('stage-calibrate'),
    queue:     $('stage-queue'),
    battle:    $('stage-battle'),
    result:    $('stage-result'),
  };
  function setStage(name) {
    for (const [k, el] of Object.entries(stages)) el.dataset.active = (k === name) ? 'true' : 'false';
  }

  // ---------- bootstrap ----------
  let socket = null;
  let player = null;
  let analyzer = null;
  let oppAnalyzer = null;
  let stream = null;
  let peer = null;
  let calSafety = null;
  let meSafety = null;
  let oppSafety = null;
  let safetyBlocked = false;     // calibration: queue locked until camera is clean
  let merger = null;             // live half-and-half face merger

  function setBar(id, pct) {
    const fill = document.getElementById('bar-' + id);
    const lbl  = document.getElementById('bar-' + id + '-pct');
    if (fill) fill.style.width = pct + '%';
    if (lbl)  lbl.textContent = pct + '%';
  }

  const AXIS_NAMES = ['symmetry', 'harmony', 'jaw', 'canthal', 'skin'];

  function renderAxes(container, axes) {
    if (!container) return;
    if (!container._built) {
      container.innerHTML = AXIS_NAMES.map(a =>
        `<div class="psl-axis" data-axis="${a}"><span>${a}</span><div class="axis-track"><div class="axis-fill"></div></div><b>—</b></div>`
      ).join('');
      container._built = true;
    }
    for (const a of AXIS_NAMES) {
      const row = container.querySelector(`[data-axis="${a}"]`);
      if (!row) continue;
      const v = axes ? axes[a] : null;
      row.querySelector('.axis-fill').style.width = (v == null ? 0 : (v * 10)) + '%';
      row.querySelector('b').textContent = v == null ? '—' : v.toFixed(1);
    }
  }

  // ---------- stage: calibrate ----------
  async function bootstrapCalibrate() {
    // Connect socket immediately so stats are live during calibration
    socket = io({ transports: ['websocket', 'polling'] });
    socket.emit('player:hello', {
      playerId: localStorage.getItem(ID_KEY) || null,
      handle: localStorage.getItem(HANDLE_KEY) || null,
    }, (resp) => {
      player = resp;
      localStorage.setItem(ID_KEY, resp.playerId);
      localStorage.setItem(HANDLE_KEY, resp.handle);
      $('hud-handle').textContent = resp.handle;
      $('hud-elo').textContent = resp.elo;
      $('hud-mogs').textContent = resp.mogs || 0;
      $('me-elo').textContent = resp.elo;
      $('me-handle').textContent = resp.handle;
      $('q-elo').textContent = resp.elo;
    });

    socket.on('queue:joined', ({ position }) => {
      $('q-online').textContent = position;
    });
    socket.on('match:start', onMatchStart);
    socket.on('rtc:signal', (msg) => peer?.handleSignal(msg));
    socket.on('match:opponent_psl', ({ psl }) => {
      if (psl != null) {
        $('opp-psl').textContent = Number(psl).toFixed(2);
      }
    });
    socket.on('match:opponent_left', () => {
      flash('opponent disconnected');
    });
    socket.on('match:result', onMatchResult);

    // load face-api models in parallel with camera prompt
    const modelsP = OmoggleFace.loadModels((p) => setBar('models', Math.round(p * 100)));
    const camP = navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
      audio: true,
    });

    let cam;
    try {
      cam = await camP;
      stream = cam;
      const v = $('cal-video');
      v.srcObject = cam;
      await v.play().catch(() => {});
      setBar('cam', 100);
    } catch (e) {
      $('cal-hint').textContent = 'camera access denied — click the lock icon to allow';
      return;
    }

    try {
      await modelsP;
    } catch (e) {
      $('cal-hint').textContent = 'failed to load face models — refresh to retry';
      return;
    }

    $('cal-hint').textContent = 'center your face. when face-lock hits 100%, you can queue.';

    let goodFrames = 0;
    analyzer = OmoggleFace.create({
      video: $('cal-video'),
      overlay: $('cal-overlay'),
      color: '#b8ff3a',
      onTick: (s) => {
        const fit = $('cal-fitness');
        if (!s.detected) {
          goodFrames = Math.max(0, goodFrames - 2);
          fit.textContent = 'no face detected';
          fit.style.color = 'var(--danger)';
          setBar('face', Math.min(100, goodFrames * 5));
          $('cal-psl').textContent = '—';
          renderAxes($('cal-axes'), null);
          $('btn-queue').disabled = true;
          return;
        }
        goodFrames = Math.min(20, goodFrames + 1);
        fit.textContent = 'face locked';
        fit.style.color = 'var(--accent)';
        setBar('face', Math.min(100, goodFrames * 5));
        $('cal-psl').textContent = s.psl.toFixed(2);
        renderAxes($('cal-axes'), s);
        if (goodFrames >= 12) {
          $('btn-queue').disabled = false;
          // persist last psl
          socket.emit('player:psl', { psl: s.psl });
          $('q-psl').textContent = s.psl.toFixed(2);
          $('hud-handle').dataset.psl = s.psl.toFixed(2);
          try {
            const cur = JSON.parse(localStorage.getItem(STATS_KEY) || '{}');
            localStorage.setItem(STATS_KEY, JSON.stringify({ ...cur, psl: s.psl, elo: player?.elo ?? 1000, mogs: player?.mogs ?? 0 }));
          } catch {}
        }
      },
    });
    analyzer.start();

    // ---- safety scanner (NSFW) on the local feed during calibration ----
    // Loads nsfwjs in the background; the camera works without it but the
    // queue button stays locked until we have at least one clean reading.
    const safeFill = document.getElementById('bar-safe');
    const safePct  = document.getElementById('bar-safe-pct');
    let safeReady = false;
    (async () => {
      try {
        await OmoggleSafety.loadModel();
        safeReady = true;
        if (safeFill) safeFill.style.width = '100%';
        if (safePct)  safePct.textContent = 'ok';
      } catch {
        // If the safety model fails to load (network/CDN issue), fail-open:
        // we don't block the queue, but we mark the bar so the operator sees it.
        if (safeFill) safeFill.style.background = 'var(--warn)';
        if (safePct)  safePct.textContent = 'off';
      }
    })();
    calSafety = OmoggleSafety.create({
      video: $('cal-video'),
      onFlag: ({ score }) => {
        safetyBlocked = true;
        $('btn-queue').disabled = true;
        const h = $('cal-hint');
        h.textContent = 'safety filter triggered — adjust framing (no exposed skin / underwear / explicit content)';
        h.classList.add('bad');
        if (safeFill) { safeFill.style.background = 'var(--danger)'; safeFill.style.width = '100%'; }
        if (safePct)  safePct.textContent = 'flag';
      },
      onClear: () => {
        safetyBlocked = false;
        const h = $('cal-hint');
        h.textContent = 'looks clean — when face-lock hits 100%, you can queue.';
        h.classList.remove('bad');
        if (safeFill) { safeFill.style.background = ''; safeFill.style.width = '100%'; }
        if (safePct)  safePct.textContent = 'ok';
      },
    });
    calSafety.start();

    $('btn-queue').addEventListener('click', () => {
      if (safetyBlocked) return;
      if (!safeReady) {
        // Model still loading — let them queue anyway; battle stage has its
        // own scanner that will catch anything once the model is up.
      }
      calSafety?.stop();
      setStage('queue');
      socket.emit('queue:join');
    });
  }

  $('btn-cancel-queue').addEventListener('click', () => {
    socket?.emit('queue:leave');
    setStage('calibrate');
  });

  // ---------- stage: battle ----------
  let battleRound = 0;
  let battleTimer = null;
  let battleEndsAt = 0;
  let myFinalPsl = null;
  let oppFinalPsl = null;
  let battleActive = false;

  async function onMatchStart({ matchId, role, opponent }) {
    battleRound++;
    battleActive = true;
    myFinalPsl = null;
    oppFinalPsl = null;
    $('opp-handle').textContent = opponent.handle || 'opponent';
    $('opp-elo').textContent = opponent.elo ?? '—';
    $('opp-psl').textContent = '—';
    $('me-psl').textContent = '—';
    renderAxes($('me-axes'), null);
    renderAxes($('opp-axes'), null);
    $('opp-waiting').classList.remove('hide');
    setStage('battle');

    // restart self analyzer on me-video using same stream
    analyzer?.stop();
    const me = $('me-video');
    me.srcObject = stream;
    me.muted = true;
    await me.play().catch(() => {});

    analyzer = OmoggleFace.create({
      video: me,
      overlay: $('me-overlay'),
      color: '#b8ff3a',
      onTick: (s) => {
        if (!s.detected) {
          $('me-psl').textContent = '—';
          renderAxes($('me-axes'), null);
          return;
        }
        $('me-psl').textContent = s.psl.toFixed(2);
        renderAxes($('me-axes'), s);
      },
    });
    analyzer.start();

    // live half-and-half face merger — left side = me, right side = opponent
    merger?.stop();
    const battleMerge = document.getElementById('merge-canvas-battle');
    if (battleMerge) {
      merger = OmoggleMerge.createMerger({
        canvas: battleMerge,
        meVideo: me,
        oppVideo: document.getElementById('opp-video'),
        getMeDetection:  () => analyzer?.latestDetection(),
        getOppDetection: () => oppAnalyzer?.latestDetection(),
        width: 220, height: 220,
      });
      merger.start();
    }

    // safety scanner on own feed — auto-concede if NSFW is detected
    meSafety?.stop();
    meSafety = OmoggleSafety.create({
      video: me,
      onFlag: () => {
        if (!battleActive) return;
        $('me-safety').classList.remove('hide');
        flash('your feed was flagged — round forfeited');
        battleActive = false;
        socket.emit('match:concede');
      },
      onClear: () => $('me-safety').classList.add('hide'),
    });
    meSafety.start();

    // setup peer
    peer = OmoggleRTC.createPeer({
      socket,
      localStream: stream,
      role,
      onRemoteStream: (rs) => {
        const v = $('opp-video');
        v.srcObject = rs;
        v.play().catch(() => {});
        $('opp-waiting').classList.add('hide');
        // start an analyzer for the opponent (visual only, scores not used for elo)
        oppAnalyzer?.stop();
        oppAnalyzer = OmoggleFace.create({
          video: v,
          overlay: null,
          color: '#ff3aa1',
          onTick: (s) => {
            if (s.detected) renderAxes($('opp-axes'), s);
          },
        });
        oppAnalyzer.start();

        // safety scanner on opponent feed — auto-report + end round on NSFW
        oppSafety?.stop();
        oppSafety = OmoggleSafety.create({
          video: v,
          onFlag: () => {
            if (!battleActive) return;
            $('opp-safety').classList.remove('hide');
            flash('opponent flagged — auto-reporting');
            battleActive = false;
            socket.emit('match:report', { reason: 'auto:nsfw' });
          },
          onClear: () => $('opp-safety').classList.add('hide'),
        });
        oppSafety.start();
      },
      onClose: () => flash('connection lost'),
    });
    await peer.start();

    // start 15s round
    const DURATION = 15_000;
    battleEndsAt = Date.now() + DURATION;
    clearInterval(battleTimer);
    battleTimer = setInterval(() => {
      const left = Math.max(0, Math.ceil((battleEndsAt - Date.now()) / 1000));
      const el = $('battle-timer');
      el.textContent = left;
      el.classList.toggle('warn', left <= 8 && left > 3);
      el.classList.toggle('danger', left <= 3);
      // broadcast running psl every ~1s
      const s = analyzer?.latest();
      if (s) socket.emit('match:psl', { psl: s.psl });
      if (left <= 0) {
        clearInterval(battleTimer);
        finalize();
      }
    }, 250);
  }

  function finalize() {
    if (!battleActive) return;
    battleActive = false;
    const my = analyzer?.latest();
    // peer's last reported psl was captured in DOM
    const oppTxt = $('opp-psl').textContent;
    myFinalPsl = my?.psl ?? null;
    oppFinalPsl = parseFloat(oppTxt);
    if (!Number.isFinite(oppFinalPsl)) oppFinalPsl = null;
    socket.emit('match:finish', { aPsl: myFinalPsl, bPsl: oppFinalPsl });
  }

  function onMatchResult({ youWon, draw, opponentPsl, yourPsl, eloDelta, newElo, opponentEloDelta }) {
    clearInterval(battleTimer);

    // Snapshot the live merge before tearing down the analyzers so the
    // result canvas keeps showing both faces at the final moment.
    const finalMergeCanvas = $('merge-canvas-result');
    const sourceMerge      = $('merge-canvas-battle');
    if (finalMergeCanvas && sourceMerge) {
      const fctx = finalMergeCanvas.getContext('2d');
      fctx.clearRect(0, 0, finalMergeCanvas.width, finalMergeCanvas.height);
      fctx.drawImage(sourceMerge, 0, 0, finalMergeCanvas.width, finalMergeCanvas.height);
    }
    merger?.stop(); merger = null;

    peer?.close(); peer = null;
    oppAnalyzer?.stop(); oppAnalyzer = null;
    meSafety?.stop();    meSafety = null;
    oppSafety?.stop();   oppSafety = null;
    $('me-safety')?.classList.add('hide');
    $('opp-safety')?.classList.add('hide');

    const banner = $('result-banner');
    if (draw) { banner.textContent = 'a draw.'; banner.className = 'result-banner draw'; }
    else if (youWon) { banner.textContent = 'you mogged.'; banner.className = 'result-banner'; }
    else { banner.textContent = 'mogged.'; banner.className = 'result-banner loss'; }

    $('r-mypsl').textContent = yourPsl != null ? Number(yourPsl).toFixed(2) : (myFinalPsl != null ? myFinalPsl.toFixed(2) : '—');
    $('r-opsl').textContent = opponentPsl != null ? Number(opponentPsl).toFixed(2) : (oppFinalPsl != null ? oppFinalPsl.toFixed(2) : '—');
    const d = eloDelta || 0;
    $('r-delta').textContent = (d > 0 ? '+' : '') + d;
    $('r-elo').textContent = newElo;
    $('hud-elo').textContent = newElo;
    $('me-elo').textContent = newElo;

    if (player) {
      player.elo = newElo;
      if (youWon) {
        player.mogs = (player.mogs || 0) + 1;
        $('hud-mogs').textContent = player.mogs;
      }
    }
    try {
      const cur = JSON.parse(localStorage.getItem(STATS_KEY) || '{}');
      localStorage.setItem(STATS_KEY, JSON.stringify({ ...cur, elo: newElo, mogs: player?.mogs ?? cur.mogs ?? 0 }));
    } catch {}

    setStage('result');
  }

  $('btn-skip').addEventListener('click', () => {
    if (!battleActive) return;
    socket.emit('match:concede');
  });
  $('btn-report').addEventListener('click', () => {
    const reason = prompt('report reason (one short line):', '') || '';
    if (!reason) return;
    socket.emit('match:report', { reason });
  });
  $('btn-rematch').addEventListener('click', () => {
    setStage('queue');
    socket.emit('queue:join');
  });
  $('btn-save-merge')?.addEventListener('click', () => {
    const c = $('merge-canvas-result');
    if (!c) return;
    const url = c.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = url;
    a.download = `omoggle-merge-${Date.now()}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  });

  // ---------- util ----------
  function flash(text) {
    const fit = $('cal-fitness');
    if (fit) {
      fit.textContent = text;
      fit.style.color = 'var(--warn)';
      setTimeout(() => { fit.style.color = 'var(--muted)'; }, 1800);
    }
  }

  window.addEventListener('beforeunload', () => {
    try {
      socket?.disconnect(); peer?.close();
      analyzer?.stop(); oppAnalyzer?.stop();
      calSafety?.stop(); meSafety?.stop(); oppSafety?.stop();
      merger?.stop();
    } catch {}
    try { stream?.getTracks().forEach(t => t.stop()); } catch {}
  });

  bootstrapCalibrate();
})();
