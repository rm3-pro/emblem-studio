/* Motion-source frame extractors. gifToImageDatas is Node-safe (no DOM);
 * video/webcam helpers are browser-only and guard on `document`. */
(function (root) {
  "use strict";
  const FRAMES = 36;
  const LIMITS = {
    maxPixels: 640 * 480,
    maxStillPixels: 24 * 1000 * 1000,
    maxFileBytes: 20 * 1024 * 1024,
    maxGifFrames: 90,
    captureWidth: 960,
    seekTimeoutMs: 5000,
  };
  function optsOf(countOrOpts) {
    return typeof countOrOpts === "object" && countOrOpts
      ? Object.assign({ count: FRAMES }, countOrOpts)
      : { count: countOrOpts || FRAMES };
  }
  function validateImageSize(width, height, opts) {
    const maxPixels = (opts && opts.maxPixels) || LIMITS.maxPixels;
    if (!width || !height) throw new Error("source has no video dimensions");
    if (width * height > maxPixels) {
      throw new Error(`source too large (${width}x${height}); use ${Math.floor(maxPixels / 100000) / 10}MP or smaller`);
    }
  }
  function validateFileSize(file, opts) {
    const maxFileBytes = (opts && opts.maxFileBytes) || LIMITS.maxFileBytes;
    if (file && file.size > maxFileBytes) throw new Error(`file too large (${Math.ceil(file.size / 1048576)}MB); use ${Math.floor(maxFileBytes / 1048576)}MB or smaller`);
  }
  function scaledSize(width, height, opts) {
    validateImageSize(width, height, opts);
    const maxW = (opts && opts.captureWidth) || LIMITS.captureWidth;
    const scale = Math.min(1, maxW / width, Math.sqrt(((opts && opts.maxPixels) || LIMITS.maxPixels) / (width * height)));
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
  }
  function getGifReader() {
    if (typeof module !== "undefined" && module.exports) return require("./vendor/omggif.js").GifReader;
    return root.GifReader; // omggif exposes GifReader as a browser global
  }
  function gifToImageDatas(buf, countOrOpts) {
    const opts = optsOf(countOrOpts), count = opts.count || FRAMES;
    const GifReader = getGifReader();
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    const r = new GifReader(bytes);
    const W = r.width, H = r.height, N = r.numFrames();
    validateImageSize(W, H, opts);
    if (N > (opts.maxGifFrames || LIMITS.maxGifFrames)) throw new Error(`GIF has too many frames (${N})`);
    const src = []; const prev = new Uint8Array(W * H * 4);
    for (let i = 0; i < N; i++) {
      const out = new Uint8Array(W * H * 4); out.set(prev);
      r.decodeAndBlitFrameRGBA(i, out); prev.set(out);
      src.push({ width: W, height: H, data: out });
    }
    const res = [];
    for (let f = 0; f < count; f++) res.push(src[Math.min(N - 1, Math.floor((f * N) / count))]);
    return res;
  }
  function _grab(videoEl, opts) {
    const size = scaledSize(videoEl.videoWidth, videoEl.videoHeight, opts);
    const W = size.width, H = size.height;
    const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
    const ctx = cv.getContext("2d");
    ctx.drawImage(videoEl, 0, 0, W, H);
    return ctx.getImageData(0, 0, W, H);
  }
  function videoToImageDatas(file, countOrOpts) {
    const opts = optsOf(countOrOpts), count = opts.count || FRAMES;
    if (typeof document === "undefined") throw new Error("videoToImageDatas requires a browser");
    validateFileSize(file, opts);
    return new Promise((resolve, reject) => {
      const v = document.createElement("video"); v.muted = true; v.playsInline = true;
      const url = URL.createObjectURL(file); v.src = url;
      const cleanup = () => { URL.revokeObjectURL(url); v.removeAttribute("src"); try { v.load(); } catch (e) {} };
      const seekTo = (t) => new Promise((res, rej) => {
        const timer = setTimeout(() => { v.onseeked = null; rej(new Error("video seek timed out")); }, opts.seekTimeoutMs || LIMITS.seekTimeoutMs);
        v.onseeked = () => { clearTimeout(timer); v.onseeked = null; res(); };
        v.currentTime = t;
      });
      v.onloadedmetadata = async () => {
        const dur = v.duration && isFinite(v.duration) ? v.duration : 0;
        const out = [];
        try {
          validateImageSize(v.videoWidth, v.videoHeight, opts);
          for (let i = 0; i < count; i++) {
            const t = dur ? (i / count) * dur : 0;
            await seekTo(t);
            out.push(_grab(v, opts));
          }
          cleanup(); resolve(out);
        } catch (e) { cleanup(); reject(e); }
      };
      v.onerror = () => { cleanup(); reject(new Error("video decode failed")); };
    });
  }
  function webcamToImageDatas(countOrOpts, intervalMs) {
    const opts = optsOf(countOrOpts), count = opts.count || FRAMES;
    intervalMs = intervalMs || opts.intervalMs || 80;
    if (typeof document === "undefined" || !navigator.mediaDevices) throw new Error("webcam requires a browser");
    return navigator.mediaDevices.getUserMedia({ video: true }).then((stream) => {
      const v = document.createElement("video"); v.srcObject = stream; v.muted = true; v.playsInline = true;
      const stop = () => stream.getTracks().forEach((t) => t.stop());
      return v.play().then(() => new Promise((resolve, reject) => {
        const out = [];
        const tick = () => {
          try { out.push(_grab(v, opts)); }
          catch (e) { stop(); reject(e); return; }
          if (out.length >= count) { stop(); resolve(out); }
          else setTimeout(tick, intervalMs);
        };
        setTimeout(tick, intervalMs);
      })).catch((e) => { stop(); throw e; });
    });
  }
  const API = { LIMITS, validateImageSize, validateFileSize, scaledSize, gifToImageDatas, videoToImageDatas, webcamToImageDatas, FRAMES };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  root.EmblemMotion = Object.assign(root.EmblemMotion || {}, API);
})(typeof globalThis !== "undefined" ? globalThis : this);
