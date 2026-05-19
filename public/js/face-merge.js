// omoggle v2 — eye-aligned face merge
// Takes two video elements + two face-api detections and renders a single
// canvas where the left half is one face and the right half is the other,
// scaled/rotated so the eye lines align and softened with a feathered seam.
//
// Designed to run on requestAnimationFrame off the face analyzers' latest
// detection — no extra inference, no extra cost beyond a couple drawImages.

window.OmoggleMerge = (() => {
  function deriveAnchors(det) {
    if (!det) return null;
    const pts = det.landmarks.positions;
    const leftEyeOuter  = pts[36];
    const leftEyeInner  = pts[39];
    const rightEyeInner = pts[42];
    const rightEyeOuter = pts[45];
    const cx = (leftEyeInner.x + rightEyeInner.x) / 2;
    const cy = (leftEyeInner.y + rightEyeInner.y) / 2;
    const dx = rightEyeOuter.x - leftEyeOuter.x;
    const dy = rightEyeOuter.y - leftEyeOuter.y;
    const dist = Math.hypot(dx, dy) || 1;
    const angle = Math.atan2(dy, dx);
    return { cx, cy, dist, angle };
  }

  function smoothA(prev, next, alpha = 0.25) {
    if (!prev) return next;
    if (!next) return prev;
    // angles unwrapped a tiny bit so we don't snap across the ±π boundary
    let pa = prev.angle, na = next.angle;
    if (na - pa > Math.PI)  na -= 2 * Math.PI;
    if (na - pa < -Math.PI) na += 2 * Math.PI;
    return {
      cx:    prev.cx    * (1 - alpha) + next.cx    * alpha,
      cy:    prev.cy    * (1 - alpha) + next.cy    * alpha,
      dist:  prev.dist  * (1 - alpha) + next.dist  * alpha,
      angle: pa         * (1 - alpha) + na         * alpha,
    };
  }

  function createMerger({ canvas, meVideo, oppVideo, getMeDetection, getOppDetection, width = 480, height = 480 }) {
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const off = document.createElement('canvas');
    off.width = width; off.height = height;
    const octx = off.getContext('2d');

    // Target placement: eye line at 42% from the top, eyes separated by 32% of width.
    const target = {
      eyeCenterX: width * 0.5,
      eyeCenterY: height * 0.42,
      eyeDist:    width * 0.32,
    };

    let running = false;
    let smoothMe = null, smoothOpp = null;
    let lastMeFrame = 0, lastOppFrame = 0;

    function drawWarped(targetCtx, video, anc, mirror) {
      if (!anc || !video || video.readyState < 2 || !video.videoWidth) return false;
      const s = target.eyeDist / anc.dist;
      targetCtx.save();
      targetCtx.translate(target.eyeCenterX, target.eyeCenterY);
      targetCtx.rotate(-anc.angle);
      // Mirror flips the X axis so a selfie-style "me" stays selfie-style.
      targetCtx.scale(mirror ? -s : s, s);
      targetCtx.translate(-anc.cx, -anc.cy);
      targetCtx.drawImage(video, 0, 0);
      targetCtx.restore();
      return true;
    }

    function tick() {
      if (!running) return;

      const meDet  = getMeDetection?.();
      const oppDet = getOppDetection?.();
      const meAnc  = deriveAnchors(meDet);
      const oppAnc = deriveAnchors(oppDet);
      if (meAnc)  smoothMe  = smoothA(smoothMe,  meAnc);
      if (oppAnc) smoothOpp = smoothA(smoothOpp, oppAnc);

      ctx.clearRect(0, 0, width, height);
      // void background so partial coverage looks intentional
      ctx.fillStyle = '#07070d';
      ctx.fillRect(0, 0, width, height);

      // 1) draw "me" full-frame (will be partially overdrawn by the masked opp on the right)
      const meOk = drawWarped(ctx, meVideo, smoothMe, /* mirror */ true);

      // 2) draw "opp" warped to offscreen, then mask to the right half with a soft seam
      octx.clearRect(0, 0, width, height);
      const oppOk = drawWarped(octx, oppVideo, smoothOpp, /* mirror */ false);
      if (oppOk) {
        octx.save();
        octx.setTransform(1, 0, 0, 1, 0, 0);
        octx.globalCompositeOperation = 'destination-in';
        const seam = width * 0.5;
        const feather = width * 0.06;
        const grad = octx.createLinearGradient(seam - feather, 0, seam + feather, 0);
        grad.addColorStop(0, 'rgba(0,0,0,0)');
        grad.addColorStop(1, 'rgba(0,0,0,1)');
        octx.fillStyle = grad;
        octx.fillRect(0, 0, width, height);
        octx.restore();
        ctx.drawImage(off, 0, 0);
      }

      // 3) accent line down the seam
      ctx.save();
      ctx.strokeStyle = 'rgba(184, 255, 58, 0.55)';
      ctx.shadowColor = 'rgba(184, 255, 58, 0.6)';
      ctx.shadowBlur = 10;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(width * 0.5, 0);
      ctx.lineTo(width * 0.5, height);
      ctx.stroke();
      ctx.restore();

      // 4) status pill if either side isn't tracked
      if (!meOk || !oppOk) {
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillRect(0, height - 26, width, 26);
        ctx.fillStyle = '#ecedf5';
        ctx.font = '12px "JetBrains Mono", monospace';
        ctx.textAlign = 'center';
        ctx.fillText(
          !meOk && !oppOk ? 'waiting for both faces…'
            : !meOk        ? 'waiting for your face…'
            :                'waiting for opponent face…',
          width / 2, height - 9
        );
      }

      requestAnimationFrame(tick);
    }

    return {
      start() {
        if (running) return;
        running = true;
        requestAnimationFrame(tick);
      },
      stop() {
        running = false;
      },
      snapshot() {
        // returns a PNG data URL of the current merged canvas
        return canvas.toDataURL('image/png');
      },
      resize(w, h) {
        canvas.width = off.width = w;
        canvas.height = off.height = h;
        target.eyeCenterX = w * 0.5;
        target.eyeCenterY = h * 0.42;
        target.eyeDist    = w * 0.32;
      },
    };
  }

  return { createMerger };
})();
