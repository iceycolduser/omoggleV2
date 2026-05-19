// omoggle v2 — on-device NSFW detection
// Uses nsfwjs (TensorFlow.js MobileNet) to classify the local camera feed and
// the incoming opponent feed. Everything runs in this tab; no frames leave.
//
// Classes returned by nsfwjs: Drawing, Hentai, Neutral, Porn, Sexy.
// We collapse them into a single risk score and require two consecutive
// hits before raising a flag — keeps false positives from a swimsuit or a
// briefly-bare shoulder from blowing up a match.

window.OmoggleSafety = (() => {
  let modelPromise = null;

  function loadModel() {
    if (modelPromise) return modelPromise;
    if (!window.nsfwjs) {
      return Promise.reject(new Error('nsfwjs script not loaded'));
    }
    // Default model is MobileNetV2 mid (~4mb), shipped by nsfwjs's CDN.
    modelPromise = window.nsfwjs.load();
    return modelPromise;
  }

  // risk score from the 5-class softmax
  // porn + hentai weighted full; sexy partial (swimwear / lingerie ambiguity).
  function risk(probs) {
    const p = (k) => probs[k] || probs[k.toLowerCase()] || 0;
    return p('Porn') * 1.0 + p('Hentai') * 1.0 + p('Sexy') * 0.45;
  }

  function create({ video, onFlag, onClear, threshold = 0.55, intervalMs = 1800, requiredHits = 2 }) {
    let timer = null;
    let model = null;
    let running = false;
    let consecutive = 0;
    let flagged = false;
    let busy = false;

    async function tick() {
      if (!running || busy) return;
      if (!video || video.readyState < 2 || !video.videoWidth) return;
      busy = true;
      try {
        if (!model) model = await loadModel();
        const preds = await model.classify(video, 5);
        const probs = {};
        for (const { className, probability } of preds) probs[className] = probability;
        const score = risk(probs);
        if (score >= threshold) {
          consecutive++;
          if (consecutive >= requiredHits && !flagged) {
            flagged = true;
            onFlag?.({ score, breakdown: probs });
          }
        } else if (consecutive > 0 || flagged) {
          consecutive = 0;
          if (flagged) { flagged = false; onClear?.(); }
        }
      } catch (e) {
        // Silent: if a single frame fails we just skip it.
      } finally {
        busy = false;
      }
    }

    return {
      start() {
        if (running) return;
        running = true;
        // do a first tick quickly so calibration feedback is fast
        setTimeout(tick, 600);
        timer = setInterval(tick, intervalMs);
      },
      stop() {
        running = false;
        clearInterval(timer);
        timer = null;
        consecutive = 0;
        flagged = false;
      },
      isFlagged() { return flagged; },
    };
  }

  return { loadModel, create };
})();
