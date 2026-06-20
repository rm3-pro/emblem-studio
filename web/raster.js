/* Browser-only: rasterize emblem frames to a canvas; produce indexed frames for
 * the GIF encoder; record WebM via MediaRecorder. Not loaded in Node. */
(function () {
  "use strict";
  const FONT_PX = 16, BG = [10, 10, 10];

  function metrics(colorBake, opts) {
    const fpx = (opts && opts.fontPx) || FONT_PX;
    let cols = 0; for (const fr of colorBake.frames) for (const t of fr.t) if (t.length > cols) cols = t.length;
    const rows = colorBake.frames[0].t.length;
    const cw = Math.ceil(fpx * 0.6), lh = Math.ceil(fpx * 1.0);
    return { fpx, cols, rows, cw, lh, width: Math.max(1, cols * cw), height: Math.max(1, rows * lh) };
  }

  function drawFrameToCanvas(ctx, colorBake, frameIndex, opts) {
    const m = metrics(colorBake, opts);
    ctx.fillStyle = `rgb(${BG})`; ctx.fillRect(0, 0, m.width, m.height);
    ctx.font = `${m.fpx}px 'JetBrains Mono','DejaVu Sans Mono',monospace`;
    ctx.textBaseline = "top";
    const fr = colorBake.frames[frameIndex % colorBake.frames.length];
    const PAL = colorBake.palette, base = "rgb(216,210,188)";
    for (let y = 0; y < fr.t.length; y++) {
      const s = fr.t[y], cs = fr.c[y];
      for (let x = 0; x < s.length; x++) {
        if (s[x] === " ") continue;
        const ci = cs[x];
        ctx.fillStyle = ci < 0 ? base : `rgb(${PAL[ci]})`;
        ctx.fillText(s[x], x * m.cw, y * m.lh);
      }
    }
    return m;
  }

  function rasterizeFrames(colorBake, opts) {
    const m = metrics(colorBake, opts);
    const canvas = document.createElement("canvas");
    canvas.width = m.width; canvas.height = m.height;
    const ctx = canvas.getContext("2d");
    // build a palette: bg + bake palette; map pixels to nearest index
    const pal = [BG].concat(colorBake.palette.map((c) => [c[0], c[1], c[2]]));
    const nearest = (r, g, b) => {
      let bi = 0, bd = Infinity;
      for (let i = 0; i < pal.length; i++) { const dr = r - pal[i][0], dg = g - pal[i][1], db = b - pal[i][2]; const d = dr * dr + dg * dg + db * db; if (d < bd) { bd = d; bi = i; } }
      return bi;
    };
    const frames = [];
    for (let f = 0; f < colorBake.frames.length; f++) {
      drawFrameToCanvas(ctx, colorBake, f, opts);
      const data = ctx.getImageData(0, 0, m.width, m.height).data;
      const index = new Uint8Array(m.width * m.height);
      for (let p = 0; p < index.length; p++) index[p] = nearest(data[p * 4], data[p * 4 + 1], data[p * 4 + 2]);
      frames.push({ index, delayMs: (opts && opts.tickMs) || 80 });
    }
    return { width: m.width, height: m.height, palette: pal, frames };
  }

  function recordWebm(canvas, draw, totalMs, fps) {
    return new Promise((resolve, reject) => {
      try {
        const stream = canvas.captureStream(fps || 25);
        const chunks = [];
        const rec = new MediaRecorder(stream, { mimeType: "video/webm" });
        rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
        rec.onstop = () => resolve(new Blob(chunks, { type: "video/webm" }));
        rec.onerror = reject;
        const t0 = performance.now();
        rec.start();
        (function loop() {
          const t = performance.now() - t0;
          draw(t);
          if (t >= totalMs) { rec.stop(); return; }
          requestAnimationFrame(loop);
        })();
      } catch (e) { reject(e); }
    });
  }

  window.EmblemRaster = { rasterizeFrames, drawFrameToCanvas, recordWebm, metrics };
})();
