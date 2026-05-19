// omoggle v2 — on-device face analysis & PSL scoring
// Wraps face-api.js (TinyFaceDetector + 68-point landmarks) and computes a
// 5-axis breakdown: symmetry, harmony, jaw, canthal tilt, skin.
// Everything stays in this tab — no frames or landmarks ever leave.

window.OmoggleFace = (() => {
  const MODEL_URL = 'https://justadudewhohacks.github.io/face-api.js/models';

  let modelsReady = false;
  let modelLoadPromise = null;

  async function loadModels(onProgress) {
    if (modelsReady) return;
    if (modelLoadPromise) return modelLoadPromise;
    modelLoadPromise = (async () => {
      if (!window.faceapi) {
        throw new Error('face-api.js script failed to load');
      }
      const steps = [
        () => faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
        () => faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
      ];
      let done = 0;
      for (const s of steps) {
        await s();
        done++;
        onProgress?.(done / steps.length);
      }
      modelsReady = true;
    })();
    return modelLoadPromise;
  }

  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
  function midpoint(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
  function clamp01(v) { return Math.max(0, Math.min(1, v)); }
  function smooth(prev, next, alpha = 0.3) { return prev == null ? next : prev * (1 - alpha) + next * alpha; }

  // Compute 5-axis face scores from a 68-point landmark set.
  // Each axis is mapped to [0, 10]; final PSL is a weighted average.
  function score(landmarks) {
    const pts = landmarks.positions;

    // standard 68-point indices
    const jawline = pts.slice(0, 17);
    const leftBrow = pts.slice(17, 22);
    const rightBrow = pts.slice(22, 27);
    const noseBridge = pts.slice(27, 31);
    const noseBase = pts.slice(31, 36);
    const leftEye = pts.slice(36, 42);
    const rightEye = pts.slice(42, 48);
    const outerMouth = pts.slice(48, 60);

    const leftEyeOuter = pts[36], leftEyeInner = pts[39];
    const rightEyeInner = pts[42], rightEyeOuter = pts[45];
    const noseTip = pts[30];
    const chinBottom = pts[8];
    const browLeftPeak = pts[19], browRightPeak = pts[24];
    const mouthLeft = pts[48], mouthRight = pts[54];
    const mouthTopCenter = pts[51], mouthBottomCenter = pts[57];

    // alignment: center axis = midpoint between eyes -> chin
    const eyeMid = midpoint(leftEyeInner, rightEyeInner);
    const faceAxisVec = { x: chinBottom.x - eyeMid.x, y: chinBottom.y - eyeMid.y };
    const axisAngle = Math.atan2(faceAxisVec.y, faceAxisVec.x); // ~ pi/2 for upright

    // Project a point onto the axis-perpendicular distance (sign = side)
    function offAxis(p) {
      const dx = p.x - eyeMid.x;
      const dy = p.y - eyeMid.y;
      // rotate by -axisAngle so axis aligns to +y
      const cs = Math.cos(-axisAngle + Math.PI / 2);
      const sn = Math.sin(-axisAngle + Math.PI / 2);
      return { x: dx * cs - dy * sn, y: dx * sn + dy * cs };
    }

    // 1) SYMMETRY — compare mirrored pairs of landmarks across the central axis.
    const pairs = [
      [0, 16], [1, 15], [2, 14], [3, 13], [4, 12], [5, 11], [6, 10], [7, 9],
      [17, 26], [18, 25], [19, 24], [20, 23], [21, 22],
      [31, 35], [32, 34],
      [36, 45], [37, 44], [38, 43], [39, 42], [40, 47], [41, 46],
      [48, 54], [49, 53], [50, 52], [59, 55], [58, 56],
    ];
    const faceWidth = dist(pts[0], pts[16]) || 1;
    let symErr = 0;
    for (const [a, b] of pairs) {
      const pa = offAxis(pts[a]);
      const pb = offAxis(pts[b]);
      // mirrored: pa.x ≈ -pb.x, pa.y ≈ pb.y
      symErr += Math.abs(pa.x + pb.x) + Math.abs(pa.y - pb.y);
    }
    const symNorm = symErr / pairs.length / faceWidth;
    const symmetry = 10 * clamp01(1 - symNorm * 4.5);

    // 2) HARMONY — facial thirds + golden-ratio width-to-height.
    const foreheadY = browLeftPeak.y - (chinBottom.y - browLeftPeak.y) * 0.5;
    const top = { x: eyeMid.x, y: foreheadY };
    const thirdTop = dist(top, browLeftPeak);
    const thirdMid = dist(browLeftPeak, pts[33] || noseTip);
    const thirdBot = dist(pts[33] || noseTip, chinBottom);
    const thirdAvg = (thirdTop + thirdMid + thirdBot) / 3 || 1;
    const thirdVar = (Math.abs(thirdTop - thirdAvg) + Math.abs(thirdMid - thirdAvg) + Math.abs(thirdBot - thirdAvg)) / 3 / thirdAvg;

    const faceHeight = dist(top, chinBottom) || 1;
    const wh = faceWidth / faceHeight;
    const phiTarget = 1 / 1.618; // ideal width:height ~ 0.618
    const whErr = Math.abs(wh - phiTarget);

    const harmony = 10 * clamp01(1 - thirdVar * 2.6 - whErr * 1.8);

    // 3) JAW — angle at chin (sharpness) + jaw-to-cheekbone taper.
    // Vectors from chin to jaw point pts[5] and pts[11].
    const vL = { x: pts[5].x - chinBottom.x, y: pts[5].y - chinBottom.y };
    const vR = { x: pts[11].x - chinBottom.x, y: pts[11].y - chinBottom.y };
    const cosAng = (vL.x * vR.x + vL.y * vR.y) / ((Math.hypot(vL.x, vL.y) * Math.hypot(vR.x, vR.y)) || 1);
    const chinAngleDeg = Math.acos(Math.max(-1, Math.min(1, cosAng))) * 180 / Math.PI;
    // Sharper chin -> smaller angle. Map ~120° (soft) → 0, ~70° (sharp) → 10.
    const jawSharp = clamp01((120 - chinAngleDeg) / 50);
    const cheekbone = dist(pts[1], pts[15]);
    const jawWidth = dist(pts[4], pts[12]) || 1;
    const taper = clamp01((cheekbone - jawWidth) / (cheekbone || 1) + 0.05);
    const jaw = 10 * clamp01(jawSharp * 0.65 + taper * 0.55);

    // 4) CANTHAL TILT — angle of line from inner to outer canthus.
    function tiltDeg(inner, outer) {
      return Math.atan2(inner.y - outer.y, outer.x - inner.x) * 180 / Math.PI;
    }
    const tiltL = tiltDeg(leftEyeInner, leftEyeOuter);
    const tiltR = tiltDeg(rightEyeInner, rightEyeOuter);
    // Mirror right side (its dx is inverted relative to left)
    const tiltRMirrored = -tiltR;
    const meanTilt = (tiltL + tiltRMirrored) / 2;
    // Positive tilt (~3–7°) is conventionally "hunter eyes". Map 0° → 5, +6° → 10, -6° → 0.
    const canthal = clamp01(0.5 + meanTilt / 12) * 10;

    // 5) SKIN — uniformity of luminance over a forehead/cheek patch.
    // Filled in by sampleSkin() below; the score function returns a placeholder when not provided.
    return {
      symmetry, harmony, jaw, canthal, chinAngleDeg, faceWidth, faceHeight,
    };
  }

  function sampleSkin(video, landmarks, canvas) {
    if (!video.videoWidth) return 5;
    const w = video.videoWidth, h = video.videoHeight;
    const c = canvas || document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, w, h);
    const pts = landmarks.positions;
    // pick three patches: forehead, left cheek, right cheek
    const forehead = { x: (pts[19].x + pts[24].x) / 2, y: pts[19].y - (pts[8].y - pts[19].y) * 0.18 };
    const leftCheek = { x: (pts[2].x + pts[31].x) / 2, y: (pts[2].y + pts[31].y) / 2 };
    const rightCheek = { x: (pts[14].x + pts[35].x) / 2, y: (pts[14].y + pts[35].y) / 2 };
    const patchR = Math.max(6, Math.min(20, dist(pts[36], pts[45]) * 0.15));

    function lumStats(cx, cy) {
      const x0 = Math.max(0, Math.floor(cx - patchR));
      const y0 = Math.max(0, Math.floor(cy - patchR));
      const x1 = Math.min(w, Math.floor(cx + patchR));
      const y1 = Math.min(h, Math.floor(cy + patchR));
      if (x1 <= x0 || y1 <= y0) return null;
      const data = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
      let n = 0, mean = 0, m2 = 0;
      for (let i = 0; i < data.length; i += 4) {
        const lum = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
        n++; const d = lum - mean; mean += d / n; m2 += d * (lum - mean);
      }
      const sd = Math.sqrt(m2 / Math.max(1, n - 1));
      return { mean, sd };
    }

    const patches = [lumStats(forehead.x, forehead.y), lumStats(leftCheek.x, leftCheek.y), lumStats(rightCheek.x, rightCheek.y)].filter(Boolean);
    if (!patches.length) return 5;
    const avgSd = patches.reduce((s, p) => s + p.sd, 0) / patches.length;
    const avgMean = patches.reduce((s, p) => s + p.mean, 0) / patches.length;
    // good: low sd (uniform), reasonable mean (not crushed black / blown white)
    const uniform = clamp01(1 - avgSd / 38);
    const expo = clamp01(1 - Math.abs(avgMean - 145) / 145);
    return 10 * clamp01(uniform * 0.7 + expo * 0.4);
  }

  function composite(axes) {
    // weights tuned to give jaw + canthal extra weight (mog-relevant)
    const w = { symmetry: 0.22, harmony: 0.22, jaw: 0.22, canthal: 0.20, skin: 0.14 };
    const s = axes.symmetry * w.symmetry
            + axes.harmony  * w.harmony
            + axes.jaw      * w.jaw
            + axes.canthal  * w.canthal
            + axes.skin     * w.skin;
    return Math.max(0, Math.min(10, s));
  }

  function drawLandmarks(ctx, detection, color) {
    if (!detection) return;
    ctx.save();
    const pts = detection.landmarks.positions;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2;
    function poly(s, e, close=false) {
      ctx.beginPath();
      ctx.moveTo(pts[s].x, pts[s].y);
      for (let i = s + 1; i <= e; i++) ctx.lineTo(pts[i].x, pts[i].y);
      if (close) ctx.closePath();
      ctx.stroke();
    }
    poly(0, 16);         // jaw
    poly(17, 21);        // l brow
    poly(22, 26);        // r brow
    poly(27, 30);        // nose bridge
    poly(31, 35);        // nose base
    poly(36, 41, true);  // l eye
    poly(42, 47, true);  // r eye
    poly(48, 59, true);  // outer mouth
    poly(60, 67, true);  // inner mouth
    ctx.fillStyle = color;
    for (const p of pts) {
      ctx.beginPath(); ctx.arc(p.x, p.y, 1.1, 0, Math.PI * 2); ctx.fill();
    }
    // bounding box
    const b = detection.detection.box;
    ctx.strokeStyle = color + 'cc';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(b.x, b.y, b.width, b.height);
    ctx.restore();
  }

  // Analyzer instance bound to a single video element and overlay canvas.
  function create({ video, overlay, color = '#b8ff3a', onTick }) {
    const state = {
      running: false,
      smoothed: null,
      lastDetection: null,
      skinCanvas: document.createElement('canvas'),
    };
    const detectorOpts = new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.4 });

    async function tick() {
      if (!state.running) return;
      try {
        if (video.readyState >= 2 && video.videoWidth > 0) {
          const det = await faceapi.detectSingleFace(video, detectorOpts).withFaceLandmarks(true);
          if (overlay) {
            const w = overlay.width = video.clientWidth;
            const h = overlay.height = video.clientHeight;
            const ctx = overlay.getContext('2d');
            ctx.clearRect(0, 0, w, h);
            if (det) {
              const resized = faceapi.resizeResults(det, { width: w, height: h });
              drawLandmarks(ctx, resized, color);
            }
          }
          if (det) {
            state.lastDetection = det;
            const axes = score(det.landmarks);
            axes.skin = sampleSkin(video, det.landmarks, state.skinCanvas);
            const psl = composite(axes);

            // exponential smoothing for stability
            const prev = state.smoothed || axes;
            const sm = {
              symmetry: smooth(prev.symmetry, axes.symmetry),
              harmony:  smooth(prev.harmony, axes.harmony),
              jaw:      smooth(prev.jaw, axes.jaw),
              canthal:  smooth(prev.canthal, axes.canthal),
              skin:     smooth(prev.skin, axes.skin),
            };
            sm.psl = smooth(prev.psl, psl);
            state.smoothed = sm;
            onTick?.({ ...sm, raw: { ...axes, psl }, detected: true });
          } else {
            onTick?.({ detected: false });
          }
        }
      } catch (e) {
        // swallow per-frame errors; keep running
      }
      if (state.running) requestAnimationFrame(tick);
    }

    return {
      start() { if (!state.running) { state.running = true; tick(); } },
      stop() { state.running = false; },
      latest() { return state.smoothed; },
    };
  }

  return { loadModels, create, composite, score };
})();
