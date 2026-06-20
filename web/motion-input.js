/* Motion-source frame extractors. gifToImageDatas is Node-safe (no DOM);
 * video/webcam helpers are browser-only and guard on `document`. */
(function (root) {
  "use strict";
  const FRAMES = 36;
  function getGifReader() {
    if (typeof module !== "undefined" && module.exports) return require("./vendor/omggif.js").GifReader;
    return root.GifReader; // omggif exposes GifReader as a browser global
  }
  function gifToImageDatas(buf, count) {
    count = count || FRAMES;
    const GifReader = getGifReader();
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    const r = new GifReader(bytes);
    const W = r.width, H = r.height, N = r.numFrames();
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
  function _grab(videoEl) {
    const W = videoEl.videoWidth, H = videoEl.videoHeight;
    const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
    const ctx = cv.getContext("2d");
    ctx.drawImage(videoEl, 0, 0, W, H);
    return ctx.getImageData(0, 0, W, H);
  }
  function videoToImageDatas(file, count) {
    count = count || FRAMES;
    if (typeof document === "undefined") throw new Error("videoToImageDatas requires a browser");
    return new Promise((resolve, reject) => {
      const v = document.createElement("video"); v.muted = true; v.playsInline = true;
      v.src = URL.createObjectURL(file);
      v.onloadedmetadata = async () => {
        const dur = v.duration && isFinite(v.duration) ? v.duration : 0;
        const out = [];
        try {
          for (let i = 0; i < count; i++) {
            const t = dur ? (i / count) * dur : 0;
            await new Promise((r) => { v.onseeked = r; v.currentTime = t; });
            out.push(_grab(v));
          }
          URL.revokeObjectURL(v.src); resolve(out);
        } catch (e) { reject(e); }
      };
      v.onerror = () => reject(new Error("video decode failed"));
    });
  }
  function webcamToImageDatas(count, intervalMs) {
    count = count || FRAMES; intervalMs = intervalMs || 80;
    if (typeof document === "undefined" || !navigator.mediaDevices) throw new Error("webcam requires a browser");
    return navigator.mediaDevices.getUserMedia({ video: true }).then((stream) => {
      const v = document.createElement("video"); v.srcObject = stream; v.muted = true; v.playsInline = true;
      return v.play().then(() => new Promise((resolve) => {
        const out = [];
        const tick = () => {
          out.push(_grab(v));
          if (out.length >= count) { stream.getTracks().forEach((t) => t.stop()); resolve(out); }
          else setTimeout(tick, intervalMs);
        };
        setTimeout(tick, intervalMs);
      }));
    });
  }
  const API = { gifToImageDatas, videoToImageDatas, webcamToImageDatas, FRAMES };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  root.EmblemMotion = Object.assign(root.EmblemMotion || {}, API);
})(typeof globalThis !== "undefined" ? globalThis : this);
