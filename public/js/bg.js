// animated grid + drifting particles background
(() => {
  const c = document.getElementById('bg-grid');
  if (!c) return;
  const ctx = c.getContext('2d');
  let w = 0, h = 0, dpr = Math.min(window.devicePixelRatio || 1, 2);
  const particles = [];
  const N = 28;

  function resize() {
    w = c.width = innerWidth * dpr;
    h = c.height = innerHeight * dpr;
    c.style.width = innerWidth + 'px';
    c.style.height = innerHeight + 'px';
  }
  resize();
  addEventListener('resize', resize);

  for (let i = 0; i < N; i++) {
    particles.push({
      x: Math.random() * w,
      y: Math.random() * h,
      vx: (Math.random() - 0.5) * 0.2 * dpr,
      vy: (Math.random() - 0.5) * 0.2 * dpr,
      r: (Math.random() * 1.6 + 0.4) * dpr,
      hue: Math.random() > 0.5 ? '#b8ff3a' : (Math.random() > 0.5 ? '#ff3aa1' : '#6ad8ff'),
    });
  }

  let t = 0;
  function tick() {
    ctx.clearRect(0, 0, w, h);
    // grid
    const step = 60 * dpr;
    ctx.strokeStyle = 'rgba(184, 255, 58, 0.04)';
    ctx.lineWidth = 1;
    const off = (t * 0.15) % step;
    for (let x = -off; x < w; x += step) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
    for (let y = -off; y < h; y += step) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }
    // particles
    for (const p of particles) {
      p.x += p.vx; p.y += p.vy;
      if (p.x < 0) p.x = w; if (p.x > w) p.x = 0;
      if (p.y < 0) p.y = h; if (p.y > h) p.y = 0;
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r * 18);
      g.addColorStop(0, p.hue + '88');
      g.addColorStop(1, p.hue + '00');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r * 18, 0, Math.PI * 2); ctx.fill();
    }
    t += 1;
    requestAnimationFrame(tick);
  }
  tick();
})();
