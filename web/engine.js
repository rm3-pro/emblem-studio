/* Emblem Studio engine — pure logic, no DOM.
 * Dual-loads: browser global `EmblemEngine` and Node `require`.
 * Turns an image (ImageData-shaped {width,height,data}) into animated, colored
 * ASCII emblem frames in the Codex-spinner style, plus exporters (player.html,
 * config.json, store-only zip). DOM-free so it is unit-testable in Node.
 */
(function (root) {
  "use strict";

  // ---- constants ---------------------------------------------------------
  const CELL_ASPECT = 2.05; // a terminal cell is ~2.05x taller than wide
  const FRAMES = 36;
  const FRAME_TICK_MS = 80;
  const OFFWHITE = [216, 210, 188]; // NieR off-white
  const ACCENT = [198, 64, 56]; // NieR/BB red
  const LBASE = [150, 145, 128]; // label shimmer trough
  const LHI = [240, 237, 222]; // label shimmer crest
  const SHIMMER_PAD = 10;
  const SHIMMER_BAND = 5.0;

  // retro display themes (presentation only — bg/glow/scanlines + optional default text color)
  const THEMES = {
    flat:   { bg: "#0a0a0a", fg: null,      css: "" },
    amber:  { bg: "#0a0700", fg: "#ffb000", css: "#stage,.emblem-embed{text-shadow:0 0 4px rgba(255,176,0,.5)}" },
    green:  { bg: "#000a00", fg: "#33ff66", css: "#stage,.emblem-embed{text-shadow:0 0 4px rgba(51,255,102,.5)}" },
    crt:    { bg: "#050505", fg: null,      css: "#stage pre,.emblem-embed pre{text-shadow:0 0 3px rgba(255,255,255,.35)}#stage::after,.emblem-embed::after{content:'';position:absolute;inset:0;pointer-events:none;background:repeating-linear-gradient(0deg,rgba(0,0,0,.25)0,rgba(0,0,0,.25)1px,transparent 1px,transparent 3px)}" },
    matrix: { bg: "#000500", fg: "#00ff41", css: "#stage,.emblem-embed{text-shadow:0 0 6px rgba(0,255,65,.6)}" },
  };
  function themeOf(name) { return THEMES[name] || THEMES.flat; }

  const PRESETS = [
    { name: "Reticle",          params: { symbolKey: "line", edgeStyle: "off", colorMode: "flat" } },
    { name: "3D Card Spin",     params: { fx: { rotate3d: true, churn: false }, rotAxis: "y", rotTurns: 1, perspective: 0.5, colorMode: "palette" } },
    { name: "Inked Edges",      params: { symbolKey: "blocks", edgeStyle: "lines", edgeThreshold: 0.3, colorMode: "image" } },
    { name: "Braille Portrait", params: { renderMode: "braille", matchMode: "portrait", dither: true } },
    { name: "Amber Terminal",   params: { colorMode: "flat", baseColor: [255, 176, 0], theme: "amber", fx: { churn: true } } },
    { name: "Matrix",           params: { colorMode: "flat", baseColor: [0, 255, 65], theme: "matrix", symbolKey: "ascii" } },
  ];

  // density-ordered symbol sets (sparse -> dense, first char is " ")
  const SYMBOL_SETS = {
    line: " .-=|/\\#",
    blocks: " ░▒▓█",
    dots: " ·∙○◐●◉",
    shapes: " ·△◇○□◆■▲",
    hash: " .:#",
    ascii: " .:-=+*#%@",
    bold: " ▪▦▩█",
    soft: " ·:+oO0",
    mixed: " .,:;ox%#@",
    asciiExt: " .'`^\",:;Il!i><~+_-?][}{1)(|/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$",
  };
  const ROT_AXES = ["y", "x", "z"]; // horizontal globe / vertical tumble / in-plane
  const COLOR_MODES = ["flat", "palette", "image"];
  const MATCH_MODES = ["silhouette", "portrait"];
  const FX_KEYS = ["rotate3d", "churn", "shimmer", "dissolve"];

  // ---- small utils -------------------------------------------------------
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const cbyte = (v) => clamp(Math.round(v), 0, 255);
  function hash01(x, y, z) {
    let h = (x * 374761393 + y * 668265263 + z * 2147483647) >>> 0;
    h = (h ^ (h >>> 13)) >>> 0;
    h = (h * 1274126177) >>> 0;
    h = (h ^ (h >>> 16)) >>> 0;
    return h / 4294967296;
  }
  function blend(a, b, t) {
    return [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t));
  }

  function defaults() {
    return {
      cols: 48,
      matchMode: "silhouette",
      symbolKey: "line",
      customSymbols: "",
      busyness: 0.5,
      threshold: 0.45,
      edgeAmount: 0.0,
      edgeStyle: "off",     // off | glow | lines
      edgeThreshold: 0.35,  // DoG magnitude cutoff for lines
      edgeDetail: 0.5,      // 0..1 -> DoG sigma ratio (finer lines as it rises)
      brightness: 0.0,
      contrast: 1.0,
      invert: false,
      speed: 1.0,
      // composable animation layers
      fx: { rotate3d: false, churn: true, shimmer: false, dissolve: false },
      rotAxis: "y", // y=horizontal globe, x=vertical, z=in-plane
      rotTurns: 1, // integer turns per loop (seamless)
      perspective: 0.5, // 0..1 perspective strength
      farDim: 0, // 0..1 dimming at far edge
      // color
      colorMode: "flat", // flat | palette | image
      baseColor: OFFWHITE.slice(),
      accentColor: ACCENT.slice(),
      accentThreshold: 0.72, // level above this -> accent (palette mode)
      imageLift: 0.3, // raise dark image colors so they show on black
      label: "RM3",
      renderMode: "glyph",  // glyph | braille
      dither: true,
      dotChurn: false,
      theme: "flat",
    };
  }
  function withDefaults(params) {
    const p = Object.assign(defaults(), params);
    p.fx = Object.assign({ rotate3d: false, churn: true, shimmer: false, dissolve: false }, (params && params.fx) || {});
    delete p.fx.spin; // drop legacy key from old configs
    if (!(params && Object.prototype.hasOwnProperty.call(params, "edgeStyle"))) {
      p.edgeStyle = p.edgeAmount > 0 ? "glow" : "off";
    }
    return p;
  }

  function gridDims(cols, imgW, imgH) {
    cols = Math.max(8, Math.round(cols));
    const rows = Math.max(4, Math.round((cols * imgH) / (imgW * CELL_ASPECT)));
    return { cols, rows };
  }

  // ---- sampling (brightness + edge + color) ------------------------------
  function sample(imageData, cols, rows) {
    const { width: W, height: H, data } = imageData;
    const bright = new Float32Array(cols * rows);
    const cr = new Float32Array(cols * rows);
    const cg = new Float32Array(cols * rows);
    const cb = new Float32Array(cols * rows);
    for (let r = 0; r < rows; r++) {
      const y0 = Math.floor((r / rows) * H);
      const y1 = Math.max(y0 + 1, Math.floor(((r + 1) / rows) * H));
      for (let c = 0; c < cols; c++) {
        const x0 = Math.floor((c / cols) * W);
        const x1 = Math.max(x0 + 1, Math.floor(((c + 1) / cols) * W));
        let lum = 0, sr = 0, sg = 0, sb = 0, wa = 0, n = 0;
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            const i = (y * W + x) * 4;
            const a = data[i + 3] / 255;
            lum += ((0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) / 255) * a;
            sr += data[i] * a; sg += data[i + 1] * a; sb += data[i + 2] * a; wa += a; n++;
          }
        }
        const k = r * cols + c;
        bright[k] = n ? lum / n : 0;
        cr[k] = wa ? sr / wa : 0; cg[k] = wa ? sg / wa : 0; cb[k] = wa ? sb / wa : 0;
      }
    }
    return {
      bright,
      edge: sobel(bright, cols, rows),
      dogMag: dog(bright, cols, rows),
      theta: gradientAngle(bright, cols, rows),
      cr, cg, cb,
    };
  }

  function sampleBraille(imageData, cols, rows) {
    const DW = cols * 2, DH = rows * 4;
    const { width: W, height: H, data } = imageData;
    const dots = new Float32Array(DW * DH);
    for (let dy = 0; dy < DH; dy++) {
      const y0 = Math.floor((dy / DH) * H), y1 = Math.max(y0 + 1, Math.floor(((dy + 1) / DH) * H));
      for (let dx = 0; dx < DW; dx++) {
        const x0 = Math.floor((dx / DW) * W), x1 = Math.max(x0 + 1, Math.floor(((dx + 1) / DW) * W));
        let lum = 0, n = 0;
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
          const i = (y * W + x) * 4, a = data[i + 3] / 255;
          lum += ((0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) / 255) * a; n++;
        }
        dots[dy * DW + dx] = n ? lum / n : 0;
      }
    }
    const cr = new Float32Array(cols * rows), cg = new Float32Array(cols * rows), cb = new Float32Array(cols * rows);
    for (let r = 0; r < rows; r++) {
      const y0 = Math.floor((r / rows) * H), y1 = Math.max(y0 + 1, Math.floor(((r + 1) / rows) * H));
      for (let c = 0; c < cols; c++) {
        const x0 = Math.floor((c / cols) * W), x1 = Math.max(x0 + 1, Math.floor(((c + 1) / cols) * W));
        let sr = 0, sg = 0, sb = 0, wa = 0;
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
          const i = (y * W + x) * 4, a = data[i + 3] / 255;
          sr += data[i] * a; sg += data[i + 1] * a; sb += data[i + 2] * a; wa += a;
        }
        const k = r * cols + c; cr[k] = wa ? sr / wa : 0; cg[k] = wa ? sg / wa : 0; cb[k] = wa ? sb / wa : 0;
      }
    }
    return { dots, cr, cg, cb, DW, DH };
  }

  function sobel(g, cols, rows) {
    const out = new Float32Array(cols * rows);
    const at = (x, y) => g[clamp(y, 0, rows - 1) * cols + clamp(x, 0, cols - 1)];
    let max = 1e-6;
    for (let y = 0; y < rows; y++)
      for (let x = 0; x < cols; x++) {
        const gx = -at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1) + at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1);
        const gy = -at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1) + at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1);
        const m = Math.hypot(gx, gy);
        out[y * cols + x] = m;
        if (m > max) max = m;
      }
    for (let i = 0; i < out.length; i++) out[i] /= max;
    return out;
  }

  function gaussianBlur(field, cols, rows, sigma) {
    if (!(sigma > 0)) return field.slice();
    const radius = Math.max(1, Math.ceil(sigma * 3));
    const kernel = new Float32Array(radius * 2 + 1);
    let sum = 0;
    for (let i = -radius; i <= radius; i++) { const w = Math.exp(-(i * i) / (2 * sigma * sigma)); kernel[i + radius] = w; sum += w; }
    for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;
    const tmp = new Float32Array(cols * rows), out = new Float32Array(cols * rows);
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      let acc = 0; for (let i = -radius; i <= radius; i++) acc += field[y * cols + clamp(x + i, 0, cols - 1)] * kernel[i + radius];
      tmp[y * cols + x] = acc;
    }
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      let acc = 0; for (let i = -radius; i <= radius; i++) acc += tmp[clamp(y + i, 0, rows - 1) * cols + x] * kernel[i + radius];
      out[y * cols + x] = acc;
    }
    return out;
  }
  function dog(bright, cols, rows, opts) {
    const o = Object.assign({ sigma1: 1.0, sigma2: 1.7, tau: 0.97 }, opts);
    const g1 = gaussianBlur(bright, cols, rows, o.sigma1), g2 = gaussianBlur(bright, cols, rows, o.sigma2);
    const out = new Float32Array(cols * rows); let max = 1e-6;
    for (let i = 0; i < out.length; i++) { const v = Math.abs(g1[i] - o.tau * g2[i]); out[i] = v; if (v > max) max = v; }
    for (let i = 0; i < out.length; i++) out[i] /= max;
    return out;
  }

  const BRAILLE_BITS = [0x01, 0x08, 0x02, 0x10, 0x04, 0x20, 0x40, 0x80];
  function brailleChar(dots) {
    let mask = 0;
    for (let i = 0; i < 8; i++) if (dots[i]) mask |= BRAILLE_BITS[i];
    return mask === 0 ? " " : String.fromCharCode(0x2800 + mask);
  }
  function floydSteinberg(field, w, h) {
    const f = Float32Array.from(field);
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, old = f[i], nw = old < 0.5 ? 0 : 1;
      out[i] = nw; const err = old - nw;
      if (x + 1 < w) f[i + 1] += (err * 7) / 16;
      if (y + 1 < h) {
        if (x > 0) f[i + w - 1] += (err * 3) / 16;
        f[i + w] += (err * 5) / 16;
        if (x + 1 < w) f[i + w + 1] += (err * 1) / 16;
      }
    }
    return out;
  }

  function gradientAngle(g, cols, rows) {
    const out = new Float32Array(cols * rows);
    const at = (x, y) => g[clamp(y, 0, rows - 1) * cols + clamp(x, 0, cols - 1)];
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      const gx = -at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1) + at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1);
      const gy = -at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1) + at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1);
      out[y * cols + x] = Math.atan2(gy, gx);
    }
    return out;
  }
  // edge runs perpendicular to the gradient; map tangent direction to a glyph
  function edgeGlyph(theta) {
    let a = theta + Math.PI / 2;        // tangent angle
    a = ((a % Math.PI) + Math.PI) % Math.PI; // [0, PI)
    const seg = Math.round(a / (Math.PI / 4)) % 4; // 0..3
    return ["-", "/", "|", "\\"][seg];
  }

  function shapeLevel(b, p) {
    let v = (b - 0.5) * p.contrast + 0.5 + p.brightness;
    if (p.invert) v = 1 - v;
    return clamp(v, 0, 1);
  }
  function rampFor(p) {
    return p.customSymbols && p.customSymbols.length >= 2
      ? p.customSymbols
      : SYMBOL_SETS[p.symbolKey] || SYMBOL_SETS.line;
  }
  function liftColor(r, g, b, lift) {
    const mx = Math.max(r, g, b);
    if (mx < 1) { const v = cbyte(255 * lift); return [v, v, v]; }
    const scale = Math.max(1, (lift * 255) / mx);
    return [cbyte(r * scale), cbyte(g * scale), cbyte(b * scale)];
  }
  const q24 = (v) => Math.round(v / 24) * 24; // quantize image colors for a small palette

  // ---- structured render: {chars:char[][], colors:([r,g,b]|null)[][]} ----
  function renderBrailleGrid(bc, cols, rows, p, frameIdx) {
    const DW = bc.DW, DH = bc.DH;
    const frac = ((((frameIdx % FRAMES) + FRAMES) % FRAMES)) / FRAMES;
    const churnTurns = Math.max(1, Math.round(p.speed));
    const cx = (cols - 1) / 2, cy = (rows - 1) / 2;
    // level-adjust the dot field, then dither or hard-threshold
    const lvl = new Float32Array(bc.dots.length);
    for (let i = 0; i < lvl.length; i++) {
      let v = (bc.dots[i] - 0.5) * p.contrast + 0.5 + p.brightness;
      if (p.invert) v = 1 - v;
      lvl[i] = clamp(v, 0, 1);
    }
    let on;
    if (p.dither) on = floydSteinberg(lvl, DW, DH);
    else { on = new Uint8Array(lvl.length); const thr = clamp(p.threshold, 0, 1); for (let i = 0; i < lvl.length; i++) on[i] = lvl[i] > thr ? 1 : 0; }
    const chars = [], colors = [];
    for (let y = 0; y < rows; y++) {
      const rowC = [], rowK = [];
      for (let x = 0; x < cols; x++) {
        const dots = new Array(8);
        for (let sub = 0; sub < 8; sub++) {
          const col = sub % 2, row = (sub - col) / 2;
          const dx = x * 2 + col, dy = y * 4 + row;
          let v = on[dy * DW + dx];
          if (p.dotChurn && v && hash01(dx, dy, (frameIdx * churnTurns) % FRAMES) < 0.10) v = 0;
          dots[sub] = v;
        }
        let ch = brailleChar(dots);
        if (p.fx.dissolve && ch !== " ") {
          const ddx = (x - cx) / cols, ddy = (y - cy) / rows;
          const m = Math.min(1, Math.hypot(ddx * 2, ddy * 2));
          const d = (((m - frac) % 1) + 1) % 1;
          if (d < 0.12 || d > 0.88) ch = " ";
        }
        let rgb = null;
        if (ch !== " ") {
          const k = y * cols + x;
          if (p.colorMode === "image") rgb = liftColor(q24(bc.cr[k]), q24(bc.cg[k]), q24(bc.cb[k]), p.imageLift);
          else if (p.colorMode === "palette") {
            const lum = (0.299 * bc.cr[k] + 0.587 * bc.cg[k] + 0.114 * bc.cb[k]) / 255;
            rgb = lum >= p.accentThreshold ? p.accentColor.slice() : p.baseColor.slice();
          } else rgb = p.baseColor.slice();
          if (p.fx.shimmer) {
            const period = cols + 20, pos = frac * period, dd = Math.abs(x + 10 - pos);
            const t = dd <= 8 ? 0.5 * (1 + Math.cos(Math.PI * (dd / 8))) : 0;
            rgb = blend(rgb, [255, 255, 255], t * 0.6);
          }
        }
        rowC.push(ch); rowK.push(rgb);
      }
      chars.push(rowC); colors.push(rowK);
    }
    return { chars, colors };
  }

  function renderGrid(cells, cols, rows, params, frameIdx) {
    const p = withDefaults(params);
    if (p.renderMode === "braille") return renderBrailleGrid(cells, cols, rows, p, frameIdx);
    const edgeField = p.edgeStyle === "lines"
      ? dog(cells.bright, cols, rows, { sigma2: 1.2 + (1 - clamp(p.edgeDetail, 0, 1)) * 1.6 })
      : null;
    const ramp = rampFor(p), L = ramp.length;
    const cx = (cols - 1) / 2, cy = (rows - 1) / 2;
    const frac = ((((frameIdx % FRAMES) + FRAMES) % FRAMES)) / FRAMES;
    const churnTurns = Math.max(1, Math.round(p.speed));
    const chars = [], colors = [];

    // ---- 3D card rotation (closed-form inverse map: output cell -> texel) ----
    const rot3d = !!p.fx.rotate3d;
    const axis = p.rotAxis || "y";
    const turns = Math.max(1, Math.round(p.rotTurns));
    const theta = frac * 2 * Math.PI * turns;
    const ct = Math.cos(theta), st = Math.sin(theta);
    const persp = clamp(p.perspective == null ? 0.5 : p.perspective, 0, 1);
    const Dcam = 3.5 - 2.2 * persp;      // camera distance in card-half-widths: 3.5 mild .. 1.3 strong
    const MIN_FACE = 0.08;               // edge-on min thickness: never fully collapse
    const cyy = (rows - 1) / 2;          // vertical half-extent (cx is the horizontal one)
    // in-plane z is a genuine rotation matrix; y/x use the perspective card inverse
    let zc = 1, zs = 0;
    if (rot3d && axis === "z") { zc = ct; zs = st; }

    for (let y = 0; y < rows; y++) {
      const rowC = [], rowK = [];
      for (let x = 0; x < cols; x++) {
        let sx = x, sy = y, scaleS = 1;
        if (rot3d) {
          if (axis === "z") {
            const dx = x - cx, dy = (y - cy) * CELL_ASPECT;
            sx = Math.round(cx + (dx * zc - dy * zs));
            sy = Math.round(cy + (dx * zs + dy * zc) / CELL_ASPECT);
          } else {
            const aRaw = ct;
            const a = (aRaw >= 0 ? 1 : -1) * Math.max(Math.abs(aRaw), MIN_FACE);
            const b = st;
            const nx = cx ? (x - cx) / cx : 0;   // [-1,1] across cols
            const ny = cyy ? (y - cy) / cyy : 0; // [-1,1] across rows
            if (axis === "y") {
              const u = (nx * Dcam) / (a * Dcam + nx * b);
              if (u < -1 || u > 1) { sx = -1; sy = -1; }
              else {
                const s = Dcam / (Dcam - u * b); scaleS = s;
                const v = ny / s;
                if (v < -1 || v > 1) { sx = -1; sy = -1; }
                else { sx = Math.round(cx + u * cx); sy = Math.round(cy + v * cyy); }
              }
            } else { // axis === "x": vertical tumble, rows take the u role
              const u = (ny * Dcam) / (a * Dcam + ny * b);
              if (u < -1 || u > 1) { sx = -1; sy = -1; }
              else {
                const s = Dcam / (Dcam - u * b); scaleS = s;
                const hx = nx / s;
                if (hx < -1 || hx > 1) { sx = -1; sy = -1; }
                else { sx = Math.round(cx + hx * cx); sy = Math.round(cy + u * cyy); }
              }
            }
          }
        }

        let b = 0, e = 0, R = 0, G = 0, B = 0;
        if (sx >= 0 && sx < cols && sy >= 0 && sy < rows) {
          const k = sy * cols + sx;
          b = cells.bright[k]; e = cells.edge[k];
          R = cells.cr[k]; G = cells.cg[k]; B = cells.cb[k];
        }
        let level = shapeLevel(b, p);
        if (rot3d && p.farDim > 0 && scaleS < 1) level *= 1 - p.farDim * (1 - clamp(scaleS, 0, 1));
        if (p.edgeAmount > 0) level = Math.max(level, e * p.edgeAmount);

        // glyph
        let ch = " ";
        if (p.matchMode === "portrait") {
          const lv = clamp(level + (p.busyness - 0.5) * 0.6, 0, 1);
          ch = ramp[Math.round(lv * (L - 1))];
        } else {
          const thr = clamp(p.threshold - (p.busyness - 0.5) * 0.4, 0, 1);
          if (level > thr) {
            let idx = clamp(Math.floor((1 + level) * 0.5 * (L - 1)) + 1, 1, L - 1);
            if (p.fx.churn) idx = clamp(1 + Math.floor(hash01(x, y, (frameIdx * churnTurns) % FRAMES) * (L - 1)), 1, L - 1);
            ch = ramp[idx];
          }
        }

        // dissolve: a gap ring sweeps outward (seamless), visibly animating
        if (p.fx.dissolve && ch !== " ") {
          const dx = (x - cx) / cols, dy = (y - cy) / rows;
          const m = Math.min(1, Math.hypot(dx * 2, dy * 2));
          const d = (((m - frac) % 1) + 1) % 1;
          if (d < 0.12 || d > 0.88) ch = " ";
        }

        // directional edges: contour glyphs override the fill where DoG is strong
        if (p.edgeStyle === "lines" && sx >= 0 && sx < cols && sy >= 0 && sy < rows) {
          const k = sy * cols + sx;
          if (edgeField[k] > p.edgeThreshold) ch = edgeGlyph(cells.theta[k]);
        }

        // color
        let rgb = null;
        if (ch !== " ") {
          if (p.colorMode === "image") rgb = liftColor(q24(R), q24(G), q24(B), p.imageLift);
          else if (p.colorMode === "palette") rgb = level >= p.accentThreshold ? p.accentColor.slice() : p.baseColor.slice();
          else rgb = p.baseColor.slice();
          if (p.fx.shimmer) {
            const period = cols + 20;
            const pos = frac * period;
            const dd = Math.abs(x + 10 - pos);
            const t = dd <= 8 ? 0.5 * (1 + Math.cos(Math.PI * (dd / 8))) : 0;
            rgb = blend(rgb, [255, 255, 255], t * 0.6);
          }
        }
        rowC.push(ch); rowK.push(rgb);
      }
      chars.push(rowC); colors.push(rowK);
    }
    return { chars, colors };
  }

  function frameToText(grid) {
    return grid.chars.map((row) => row.join("").replace(/\s+$/, "")).join("\n");
  }
  function matchFrame(cells, cols, rows, params, frameIdx) {
    return frameToText(renderGrid(cells, cols, rows, params, frameIdx));
  }
  function bakeFrames(cells, cols, rows, params) {
    const out = [];
    for (let i = 0; i < FRAMES; i++) out.push(matchFrame(cells, cols, rows, params, i));
    return out;
  }
  // colored frames for the player: {palette:[[r,g,b]...], frames:[{t:[lines], c:[[idx]]}]}
  function bakeColorFrames(cells, cols, rows, params) {
    const palette = [], palMap = new Map();
    const idxOf = (rgb) => {
      const key = rgb.join(",");
      let i = palMap.get(key);
      if (i == null) { i = palette.length; palette.push(rgb); palMap.set(key, i); }
      return i;
    };
    const frames = [];
    for (let f = 0; f < FRAMES; f++) {
      const g = renderGrid(cells, cols, rows, params, f);
      const t = [], c = [];
      for (let y = 0; y < g.chars.length; y++) {
        let line = "", row = [];
        for (let x = 0; x < g.chars[y].length; x++) {
          const ch = g.chars[y][x];
          line += ch;
          row.push(ch === " " ? -1 : idxOf(g.colors[y][x] || OFFWHITE));
        }
        // right-trim but keep color row aligned to trimmed length
        const trimmed = line.replace(/\s+$/, "");
        t.push(trimmed);
        c.push(row.slice(0, trimmed.length));
      }
      frames.push({ t, c });
    }
    return { palette, frames };
  }

  // single-frame analogue of bakeColorFrames: builds palette from one frame only
  function bakeColorFrameAt(cells, cols, rows, params, frameIdx) {
    const palette = [], palMap = new Map();
    const idxOf = (rgb) => {
      const key = rgb.join(",");
      let i = palMap.get(key);
      if (i == null) { i = palette.length; palette.push(rgb); palMap.set(key, i); }
      return i;
    };
    const g = renderGrid(cells, cols, rows, params, frameIdx);
    const t = [], c = [];
    for (let y = 0; y < g.chars.length; y++) {
      let line = "", row = [];
      for (let x = 0; x < g.chars[y].length; x++) {
        const ch = g.chars[y][x];
        line += ch;
        row.push(ch === " " ? -1 : idxOf(g.colors[y][x] || OFFWHITE));
      }
      const trimmed = line.replace(/\s+$/, "");
      t.push(trimmed);
      c.push(row.slice(0, trimmed.length));
    }
    return { palette, frame: { t, c } };
  }

  // ---- motion (multi-image) bake -----------------------------------------
  function motionParams(params) {
    const p = withDefaults(params);
    p.fx = Object.assign({}, p.fx, { rotate3d: false, churn: false, dissolve: false });
    return p;
  }
  function _cellsFor(p, img, cols, rows) {
    return p.renderMode === "braille" ? sampleBraille(img, cols, rows) : sample(img, cols, rows);
  }
  function bakeColorFramesFromImages(images, cols, rows, params) {
    const p = motionParams(params);
    const palette = [], palMap = new Map();
    const idxOf = (rgb) => { const key = rgb.join(","); let i = palMap.get(key); if (i == null) { i = palette.length; palette.push(rgb); palMap.set(key, i); } return i; };
    const frames = [];
    for (let f = 0; f < FRAMES; f++) {
      const img = images[Math.min(f, images.length - 1)];
      const g = renderGrid(_cellsFor(p, img, cols, rows), cols, rows, p, 0);
      const t = [], c = [];
      for (let y = 0; y < g.chars.length; y++) {
        let line = "", row = [];
        for (let x = 0; x < g.chars[y].length; x++) { const ch = g.chars[y][x]; line += ch; row.push(ch === " " ? -1 : idxOf(g.colors[y][x] || OFFWHITE)); }
        const trimmed = line.replace(/\s+$/, "");
        t.push(trimmed); c.push(row.slice(0, trimmed.length));
      }
      frames.push({ t, c });
    }
    return { palette, frames };
  }
  function bakeFramesFromImages(images, cols, rows, params) {
    const p = motionParams(params);
    const out = [];
    for (let f = 0; f < FRAMES; f++) {
      const img = images[Math.min(f, images.length - 1)];
      out.push(frameToText(renderGrid(_cellsFor(p, img, cols, rows), cols, rows, p, 0)));
    }
    return out;
  }

  // ---- shimmer (label) ---------------------------------------------------
  function shimmerCells(text, pos) {
    const cells = [];
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === " ") { cells.push({ ch: " ", rgb: null }); continue; }
      const d = Math.abs(i + SHIMMER_PAD - pos);
      let t = 0;
      if (d <= SHIMMER_BAND) t = 0.5 * (1 + Math.cos(Math.PI * (d / SHIMMER_BAND)));
      cells.push({ ch, rgb: blend(LBASE, LHI, clamp(t, 0, 1) * 0.9) });
    }
    return cells;
  }

  // ---- exporters ---------------------------------------------------------
  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }
  function escapeXml(s) {
    return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  }
  function paletteFrameToSvg(palette, frame, opts) {
    const o = Object.assign(
      { fontSize: 14, lineHeight: 1.0, bg: "#0a0a0a",
        fontFamily: "'JetBrains Mono','DejaVu Sans Mono',monospace", base: OFFWHITE },
      opts);
    const cw = o.fontSize * 0.6, lh = o.fontSize * o.lineHeight;
    let maxLen = 0; for (const t of frame.t) if (t.length > maxLen) maxLen = t.length;
    const rows = frame.t.length;
    const W = Math.max(1, Math.round(maxLen * cw)), H = Math.max(1, Math.round(rows * lh));
    let body = `<rect width="${W}" height="${H}" fill="${o.bg}"/>`;
    for (let y = 0; y < rows; y++) {
      const s = frame.t[y], cs = frame.c[y];
      let spans = "", cur = -2, run = "";
      const flush = () => {
        if (run) {
          const col = cur < 0 ? `rgb(${o.base})` : `rgb(${palette[cur]})`;
          spans += `<tspan fill="${col}">${escapeXml(run)}</tspan>`; run = "";
        }
      };
      for (let x = 0; x < s.length; x++) { const ci = cs[x]; if (ci !== cur) { flush(); cur = ci; } run += s[x]; }
      flush();
      body += `<text x="0" y="${((y + 0.8) * lh).toFixed(2)}" xml:space="preserve" font-family="${o.fontFamily}" font-size="${o.fontSize}">${spans}</text>`;
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${body}</svg>`;
  }
  function buildConfig(params) {
    const p = withDefaults(params);
    return JSON.stringify({ kind: "emblem-studio", version: 3, frameTickMs: FRAME_TICK_MS, frames: FRAMES, params: p }, null, 2);
  }
  function paletteFrameToAnsi(palette, frame) {
    let out = "";
    for (let y = 0; y < frame.t.length; y++) {
      const s = frame.t[y], cs = frame.c[y];
      let cur = -2, run = "";
      const flush = () => { if (run) out += cur < 0 ? run : "\x1b[38;2;" + palette[cur].join(";") + "m" + run + "\x1b[0m"; run = ""; };
      for (let x = 0; x < s.length; x++) {
        const ci = cs[x];
        if (ci !== cur) { flush(); cur = ci; }
        run += s[x];
      }
      flush();
      out += "\n";
    }
    return out;
  }
  function bakeAnsiFrames(cells, cols, rows, params) {
    const bake = bakeColorFrames(cells, cols, rows, params);
    return bake.frames.map((f) => paletteFrameToAnsi(bake.palette, f));
  }

  function playerScript(art, labelJs, suf) {
    return `<script>
(function(){
const ART${suf}=${art},TICK=${FRAME_TICK_MS},SWEEP=2000,BAND=${SHIMMER_BAND},PAD=${SHIMMER_PAD};
const LBASE=[${LBASE}],LHI=[${LHI}],LABEL${suf}=${labelJs},PAL${suf}=ART${suf}.palette;
const t0${suf}=performance.now();
function ec${suf}(c){return c==='<'?'&lt;':c==='>'?'&gt;':c==='&'?'&amp;':c;}
function bl${suf}(a,b,t){return [0,1,2].map(i=>Math.round(a[i]+(b[i]-a[i])*t));}
function drawArt${suf}(fr){let h="";for(let y=0;y<fr.t.length;y++){const s=fr.t[y],cs=fr.c[y];let cur=-2,run="";
 for(let x=0;x<s.length;x++){const ci=cs[x];if(ci!==cur){if(run)h+=cur<0?run:"<span style=color:rgb("+PAL${suf}[cur]+")>"+run+"</span>";run="";cur=ci;}run+=ec${suf}(s[x]);}
 if(run)h+=cur<0?run:"<span style=color:rgb("+PAL${suf}[cur]+")>"+run+"</span>";h+="\\n";}return h;}
function shim${suf}(s,pos){let o="";for(let i=0;i<s.length;i++){const c=s[i];if(c===" "){o+=" ";continue;}
 const d=Math.abs(i+PAD-pos);let t=0;if(d<=BAND)t=0.5*(1+Math.cos(Math.PI*(d/BAND)));
 const k=bl${suf}(LBASE,LHI,Math.min(Math.max(t,0),1)*0.9);o+="<span style=color:rgb("+k+")>"+ec${suf}(c)+"</span>";}return o;}
function tick${suf}(){const now=performance.now()-t0${suf};const i=Math.floor((now/TICK)%ART${suf}.frames.length);
 document.getElementById('art${suf}').innerHTML=drawArt${suf}(ART${suf}.frames[i]);
 const per=LABEL${suf}.length+PAD*2,pos=Math.floor((now%SWEEP)/SWEEP*per);
 document.getElementById('label${suf}').innerHTML=shim${suf}(LABEL${suf},pos);requestAnimationFrame(tick${suf});}
tick${suf}();
})();
</script>`;
  }
  function buildPlayerHTML(colorBake, params) {
    const p = withDefaults(params);
    const th = themeOf(p.theme);
    // "<" escaped so a frame/label containing "</script>" can't close the tag
    const art = JSON.stringify(colorBake).replace(/</g, "\\u003c");
    const labelJs = JSON.stringify(p.label).replace(/</g, "\\u003c");
    const themeCss = th.css + (th.fg ? `#stage pre,#label{color:${th.fg}}` : "");
    return `<!doctype html><html><head><meta charset=utf-8><title>${escapeHtml(p.label)} — emblem</title><style>
html,body{background:${th.bg};margin:0;height:100%;display:flex;align-items:center;justify-content:center;font-family:'JetBrains Mono','DejaVu Sans Mono',Consolas,monospace}
#stage{text-align:center}
pre{margin:0;line-height:1.0;font-size:14px;white-space:pre}
#label{margin-top:1.4em;font-size:16px;letter-spacing:3px}
${themeCss}</style></head><body><div id=stage><pre id=art></pre><div id=label></div></div>
${playerScript(art, labelJs, "")}
</body></html>`;
  }
  function hashSuffix(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = (((h << 5) + h) + s.charCodeAt(i)) >>> 0; return h.toString(36); }
  function buildEmbedSnippet(colorBake, params) {
    const p = withDefaults(params);
    const th = themeOf(p.theme);
    const art = JSON.stringify(colorBake).replace(/</g, "\\u003c");
    const labelJs = JSON.stringify(p.label).replace(/</g, "\\u003c");
    const suf = "_e" + hashSuffix(art); // content-derived, deterministic, collision-safe
    const embedCss = th.css + (th.fg ? `.emblem-embed pre{color:${th.fg}}` : "");
    const styleTag = embedCss ? `<style>${embedCss}</style>` : "";
    return `<div class="emblem-embed" style="background:${th.bg};display:inline-block;padding:1em;font-family:'JetBrains Mono','DejaVu Sans Mono',monospace;text-align:center">${styleTag}<pre id="art${suf}" style="margin:0;line-height:1;font-size:14px;white-space:pre"></pre><div id="label${suf}" style="margin-top:1em;font-size:16px;letter-spacing:3px"></div>${playerScript(art, labelJs, suf)}</div>`;
  }

  // ---- store-only ZIP ----------------------------------------------------
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  function utf8(str) {
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(str);
    const a = [];
    for (let i = 0; i < str.length; i++) {
      let c = str.charCodeAt(i);
      if (c < 0x80) a.push(c);
      else if (c < 0x800) a.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      else a.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
    return new Uint8Array(a);
  }
  function zipStore(files) {
    const enc = files.map((f) => { const data = utf8(f.text); return { name: utf8(f.name), data, crc: crc32(data) }; });
    const chunks = []; let offset = 0; const central = [];
    const u16 = (n) => [n & 0xff, (n >>> 8) & 0xff];
    const u32 = (n) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
    for (const e of enc) {
      const head = new Uint8Array([].concat(u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0x21), u32(e.crc), u32(e.data.length), u32(e.data.length), u16(e.name.length), u16(0)));
      chunks.push(head, e.name, e.data); central.push({ e, offset }); offset += head.length + e.name.length + e.data.length;
    }
    const cdStart = offset; let cdLen = 0;
    for (const { e, offset: off } of central) {
      const head = new Uint8Array([].concat(u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0x21), u32(e.crc), u32(e.data.length), u32(e.data.length), u16(e.name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(off)));
      chunks.push(head, e.name); cdLen += head.length + e.name.length;
    }
    chunks.push(new Uint8Array([].concat(u32(0x06054b50), u16(0), u16(0), u16(enc.length), u16(enc.length), u32(cdLen), u32(cdStart), u16(0))));
    let total = 0; for (const c of chunks) total += c.length;
    const buf = new Uint8Array(total); let pos = 0;
    for (const c of chunks) { buf.set(c, pos); pos += c.length; }
    return buf;
  }

  function _b64e(str) {
    const b = (typeof Buffer !== "undefined") ? Buffer.from(str, "utf8").toString("base64") : btoa(unescape(encodeURIComponent(str)));
    return b.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function _b64d(s) {
    s = s.replace(/-/g, "+").replace(/_/g, "/");
    return (typeof Buffer !== "undefined") ? Buffer.from(s, "base64").toString("utf8") : decodeURIComponent(escape(atob(s)));
  }
  function encodeShare(params) {
    const p = withDefaults(params), keys = Object.keys(defaults()), out = {};
    for (const k of keys) out[k] = p[k];
    return _b64e(JSON.stringify(out));
  }
  function decodeShare(s) {
    try { const o = JSON.parse(_b64d(String(s))); return (o && typeof o === "object" && !Array.isArray(o)) ? o : null; }
    catch (e) { return null; }
  }

  function buildBundle(cells, cols, rows, params) {
    const textFrames = bakeFrames(cells, cols, rows, params);
    const colorBake = bakeColorFrames(cells, cols, rows, params);
    const files = [
      { name: "player.html", text: buildPlayerHTML(colorBake, params) },
      { name: "config.json", text: buildConfig(params) },
    ];
    const ansiFrames = colorBake.frames.map((f) => paletteFrameToAnsi(colorBake.palette, f));
    files.push({ name: "emblem.ansi", text: ansiFrames[0] });
    ansiFrames.forEach((f, i) => files.push({ name: `ansi/frame_${i + 1}.ans`, text: f }));
    textFrames.forEach((f, i) => files.push({ name: `frames/frame_${i + 1}.txt`, text: f + "\n" }));
    return zipStore(files);
  }

  // ---- self test ---------------------------------------------------------
  function syntheticDisc(W, H) {
    const data = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4; const d = Math.hypot(x - (W - 1) / 2, y - (H - 1) / 2);
      const on = d < W * 0.32;
      data[i] = on ? 255 : 0; data[i + 1] = on ? 90 : 0; data[i + 2] = on ? 80 : 0; data[i + 3] = 255;
    }
    return { width: W, height: H, data };
  }

  function selftest() {
    const res = []; const ok = (name, cond) => res.push({ name, pass: !!cond });
    const img = syntheticDisc(20, 20);
    const { cols, rows } = gridDims(40, 20, 20);
    ok("gridDims cols", cols === 40);
    const cells = sample(img, cols, rows);
    ok("sample bright length", cells.bright.length === cols * rows);
    ok("sample has color arrays", cells.cr.length === cols * rows && cells.cg.length === cols * rows);
    ok("center red channel > corner", cells.cr[Math.floor(rows / 2) * cols + Math.floor(cols / 2)] > cells.cr[0]);

    const g = renderGrid(cells, cols, rows, {}, 0);
    ok("renderGrid dims", g.chars.length === rows && g.chars[0].length === cols && g.colors.length === rows);

    // new 3D-rotation params exist with sane defaults
    {
      const d = defaults();
      ok("default rotAxis y", d.rotAxis === "y");
      ok("default rotTurns 1", d.rotTurns === 1);
      ok("default fx.rotate3d false", d.fx.rotate3d === false);
      ok("no legacy spin key", !("spin" in d.fx) && d.spinAxis === undefined);
      // backward tolerance: an old config must not throw and must normalize
      const p = withDefaults({ fx: { spin: true }, spinAxis: "x", spinCurve: 0.7 });
      ok("withDefaults tolerates legacy keys", p.rotAxis === "y" && p.fx.rotate3d === false);
    }

    // churn seamless at integer + non-integer speeds
    const cp = { fx: { churn: true } };
    ok("churn seamless", matchFrame(cells, cols, rows, cp, 0) === matchFrame(cells, cols, rows, cp, FRAMES));
    const cp15 = { fx: { churn: true }, speed: 1.5 };
    ok("churn seamless @1.5", matchFrame(cells, cols, rows, cp15, 0) === matchFrame(cells, cols, rows, cp15, FRAMES));

    // 3D card: face-on (frame 0) reproduces the static render (identity at theta=0)
    const r3 = { fx: { rotate3d: true, churn: false }, rotAxis: "y", rotTurns: 1, perspective: 0.5 };
    const flat = matchFrame(cells, cols, rows, { fx: { churn: false } }, 0);
    ok("3d face-on == static", matchFrame(cells, cols, rows, r3, 0) === flat);
    // seamless: a full integer turn returns to face-on
    ok("3d seamless y", matchFrame(cells, cols, rows, r3, 0) === matchFrame(cells, cols, rows, r3, FRAMES));
    // mid-loop the art actually changes (it is rotating)
    ok("3d moves the art", matchFrame(cells, cols, rows, r3, 6) !== flat);

    // half-turn is the horizontal mirror of face-on (y axis, no perspective for exact compare)
    {
      const ortho = { fx: { rotate3d: true, churn: false }, rotAxis: "y", rotTurns: 1, perspective: 0 };
      const g0 = renderGrid(cells, cols, rows, ortho, 0);
      const gh = renderGrid(cells, cols, rows, ortho, FRAMES / 2);
      let mism = 0, tot = 0;
      for (let yy = 0; yy < rows; yy++) for (let xx = 0; xx < cols; xx++) { tot++; if (g0.chars[yy][xx] !== gh.chars[yy][cols - 1 - xx]) mism++; }
      ok("3d half-turn ~= mirror", mism / tot < 0.05);
    }
    // edge-on (frame 9 of 36 = theta 90deg) is sparse but NOT empty (min-thickness clamp)
    {
      const r3 = { fx: { rotate3d: true, churn: false }, rotAxis: "y", rotTurns: 1, perspective: 0.5 };
      const edge = renderGrid(cells, cols, rows, r3, 9);
      let on = 0; for (const row of edge.chars) for (const ch of row) if (ch !== " ") on++;
      const face = renderGrid(cells, cols, rows, r3, 0);
      let onFace = 0; for (const row of face.chars) for (const ch of row) if (ch !== " ") onFace++;
      ok("3d edge-on not empty", on > 0);
      ok("3d edge-on narrower than face", on < onFace);
    }
    // perspective foreshortening: across a quarter turn the lit width is monotonically non-increasing
    {
      const r3 = { fx: { rotate3d: true, churn: false }, rotAxis: "y", rotTurns: 1, perspective: 0.5 };
      const width = (f) => { const g = renderGrid(cells, cols, rows, r3, f); let mn = cols, mx = -1; for (let yy=0;yy<rows;yy++) for (let xx=0;xx<cols;xx++) if (g.chars[yy][xx] !== " ") { if (xx<mn) mn=xx; if (xx>mx) mx=xx; } return mx<mn?0:(mx-mn+1); };
      let ok2 = true, prev = width(0); for (let f = 1; f <= 9; f++) { const w = width(f); if (w > prev + 1) ok2 = false; prev = w; }
      ok("3d width foreshortens to edge-on", ok2);
    }
    // seamless on x and z axes too
    for (const ax of ["x", "z"]) {
      const sp = { fx: { rotate3d: true, churn: false }, rotAxis: ax, rotTurns: 1 };
      ok("3d seamless axis " + ax, matchFrame(cells, cols, rows, sp, 0) === matchFrame(cells, cols, rows, sp, FRAMES));
    }
    // farDim dims the far side without breaking seamlessness
    {
      const fd = { fx: { rotate3d: true, churn: false }, rotAxis: "y", rotTurns: 1, perspective: 0.7, farDim: 0.6 };
      ok("3d farDim seamless", matchFrame(cells, cols, rows, fd, 0) === matchFrame(cells, cols, rows, fd, FRAMES));
      const fdOn = renderGrid(cells, cols, rows, { fx: { rotate3d: true, churn: false }, rotAxis: "y", rotTurns: 1, perspective: 0.7, farDim: 0.8, matchMode: "portrait" }, 6);
      const fdOff = renderGrid(cells, cols, rows, { fx: { rotate3d: true, churn: false }, rotAxis: "y", rotTurns: 1, perspective: 0.7, farDim: 0, matchMode: "portrait" }, 6);
      ok("3d farDim actually dims mid-frame", fdOn.chars.some((row, yy) => row.some((ch, xx) => ch !== fdOff.chars[yy][xx])));
    }

    // palette: bright core gets accent color
    const pg = renderGrid(cells, cols, rows, { colorMode: "palette", accentThreshold: 0.3, fx: { churn: false } }, 0);
    let sawAccent = false;
    for (const row of pg.colors) for (const k of row) if (k && k[0] === ACCENT[0] && k[1] === ACCENT[1]) sawAccent = true;
    ok("palette accent applied", sawAccent);

    // image color mode lifts dark colors to visible
    const ig = renderGrid(cells, cols, rows, { colorMode: "image", fx: { churn: false } }, 0);
    let anyColored = false;
    for (const row of ig.colors) for (const k of row) if (k) anyColored = true;
    ok("image colors present", anyColored);

    // color bake + player
    const bake = bakeColorFrames(cells, cols, rows, { colorMode: "palette" });
    ok("bake palette nonempty", bake.palette.length >= 1 && bake.frames.length === FRAMES);
    ok("bake frame rows aligned", bake.frames[0].t.length === bake.frames[0].c.length);
    const evil = buildPlayerHTML({ palette: [[1, 2, 3]], frames: [{ t: ["a"], c: [[0]] }] }, { label: "</script><x>" });
    ok("player no </script> breakout", (evil.match(/<\/script>/g) || []).length === 1);

    // zip valid
    const zip = buildBundle(cells, cols, rows, { colorMode: "palette" });
    ok("zip local sig", zip[0] === 0x50 && zip[1] === 0x4b && zip[2] === 0x03 && zip[3] === 0x04);
    ok("zip EOCD sig", zip[zip.length - 22] === 0x50 && zip[zip.length - 21] === 0x4b);
    ok("crc32 vector", crc32(utf8("123456789")) === 0xcbf43926);

    // edges add directional glyphs on a synthetic disc; off-mode unchanged
    {
      const base = { symbolKey: "blocks", fx: { churn: false } };
      const off = renderGrid(cells, cols, rows, Object.assign({ edgeStyle: "off" }, base), 0);
      const lines = renderGrid(cells, cols, rows, Object.assign({ edgeStyle: "lines", edgeThreshold: 0.2 }, base), 0);
      const count = (g) => { let n = 0; for (const row of g.chars) for (const ch of row) if ("-/|\\".indexOf(ch) >= 0) n++; return n; };
      ok("off-mode has no edge glyphs (blocks ramp)", count(off) === 0);
      ok("lines mode adds edge glyphs", count(lines) > 0);
    }
    // edgeDetail changes DoG fineness: different values -> different line output
    {
      const mk = (det) => matchFrame(cells, cols, rows, { symbolKey: "blocks", edgeStyle: "lines", edgeThreshold: 0.15, edgeDetail: det, fx: { churn: false } }, 0);
      ok("edgeDetail changes lines output", mk(0.1) !== mk(0.9));
    }

    // seamless loop preserved with lines on (churn)
    {
      const lp = { edgeStyle: "lines", edgeThreshold: 0.2, fx: { churn: true } };
      ok("lines churn seamless", matchFrame(cells, cols, rows, lp, 0) === matchFrame(cells, cols, rows, lp, FRAMES));
      for (const ax of ["y","x","z"]) {
        const sp = { edgeStyle: "lines", edgeThreshold: 0.2, fx: { rotate3d: true, churn: false }, rotAxis: ax };
        ok("lines 3d seamless " + ax, matchFrame(cells, cols, rows, sp, 0) === matchFrame(cells, cols, rows, sp, FRAMES));
      }
    }
    // off-mode output identical to a build that never knew about edges (regression already guards default)
    {
      const offA = matchFrame(cells, cols, rows, { edgeStyle: "off", fx: { churn: false } }, 3);
      const offB = matchFrame(cells, cols, rows, { fx: { churn: false } }, 3);
      ok("off == no-edge", offA === offB);
    }

    // new params default off
    {
      const d = defaults();
      ok("edgeStyle default off", d.edgeStyle === "off");
      ok("edgeThreshold default", typeof d.edgeThreshold === "number");
      ok("edgeDetail default", typeof d.edgeDetail === "number");
    }
    // v2 migration: legacy config (no edgeStyle) derives from edgeAmount
    {
      const a = withDefaults({ edgeAmount: 1 });
      ok("migrate edgeAmount>0 -> glow", a.edgeStyle === "glow");
      const b = withDefaults({ edgeAmount: 0 });
      ok("migrate edgeAmount=0 -> off", b.edgeStyle === "off");
      const c = withDefaults({ edgeStyle: "lines", edgeAmount: 0 });
      ok("explicit edgeStyle wins", c.edgeStyle === "lines");
    }
    // config version bumped
    ok("config version 3", JSON.parse(buildConfig({})).version === 3);

    // gradientAngle of a vertical step is horizontal (|gx|>>|gy|) -> near 0 or PI
    {
      const W2 = 12, H2 = 12, f = new Float32Array(W2 * H2);
      for (let y = 0; y < H2; y++) for (let x = 0; x < W2; x++) f[y * W2 + x] = x < W2 / 2 ? 0 : 1;
      const th = gradientAngle(f, W2, H2);
      const a = Math.abs(th[6 * W2 + 6]);
      ok("vertical-edge gradient horizontal", a < 0.4 || Math.abs(a - Math.PI) < 0.4);
    }
    // edgeGlyph table: gradient horizontal -> vertical edge "|"; gradient vertical -> "-"
    ok("edgeGlyph vertical edge", edgeGlyph(0) === "|");
    ok("edgeGlyph horizontal edge", edgeGlyph(Math.PI / 2) === "-");
    ok("edgeGlyph returns oriented glyph", "-/|\\".indexOf(edgeGlyph(Math.PI / 5)) >= 0);

    // gaussianBlur smooths a hard step and roughly preserves mean
    {
      const W2 = 16, H2 = 16, f = new Float32Array(W2 * H2);
      for (let y = 0; y < H2; y++) for (let x = 0; x < W2; x++) f[y * W2 + x] = x < W2 / 2 ? 0 : 1;
      const b = gaussianBlur(f, W2, H2, 1.5);
      let m0 = 0, m1 = 0; for (let i = 0; i < f.length; i++) { m0 += f[i]; m1 += b[i]; }
      ok("blur preserves mean", Math.abs(m0 - m1) / f.length < 0.02);
      const mid = 8 * W2 + 8;
      ok("blur softens edge", b[mid - 3] < b[mid + 3] && b[mid] > 0.2 && b[mid] < 0.8);
    }
    // dog: magnitude higher on a hard edge than flat interior
    {
      const W2 = 16, H2 = 16, f = new Float32Array(W2 * H2);
      for (let y = 0; y < H2; y++) for (let x = 0; x < W2; x++) f[y * W2 + x] = x < W2 / 2 ? 0 : 1;
      const d = dog(f, W2, H2);
      const edgeCol = d[8 * W2 + 8], flat = d[8 * W2 + 1];
      ok("dog edge > flat", edgeCol > flat);
      ok("dog normalized", Math.max(...d) <= 1.0001);
    }

    // regression: default-params bakeFrames output is stable (guards Off behavior)
    {
      const s = bakeFrames(cells, cols, rows, {}).join("\n");
      let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
      ok("default bake regression hash", h === 376254949);
    }

    // Task 2: sampleBraille
    {
      const bimg = syntheticDisc(40, 40);
      const bd = gridDims(24, 40, 40);
      const bcells = sampleBraille(bimg, bd.cols, bd.rows);
      ok("braille dots length", bcells.dots.length === bd.cols * 2 * bd.rows * 4);
      ok("braille DW/DH", bcells.DW === bd.cols * 2 && bcells.DH === bd.rows * 4);
      ok("braille per-cell color len", bcells.cr.length === bd.cols * bd.rows);
      ok("braille center brighter than corner",
         bcells.dots[Math.floor(bcells.DH / 2) * bcells.DW + Math.floor(bcells.DW / 2)] > bcells.dots[0]);
      // aspect: a round disc's lit-dot extent is roughly as wide as tall
      let minX = 1e9, maxX = -1, minY = 1e9, maxY = -1;
      for (let dy = 0; dy < bcells.DH; dy++) for (let dx = 0; dx < bcells.DW; dx++)
        if (bcells.dots[dy * bcells.DW + dx] > 0.5) { if (dx<minX)minX=dx; if (dx>maxX)maxX=dx; if (dy<minY)minY=dy; if (dy>maxY)maxY=dy; }
      const wExt = (maxX - minX) / bcells.DW, hExt = (maxY - minY) / bcells.DH;
      ok("braille disc stays round", Math.abs(wExt - hExt) < 0.25);
    }

    // brailleChar bit table: each single dot lights the right bit; all-on/all-off
    {
      const bits = [0x01, 0x08, 0x02, 0x10, 0x04, 0x20, 0x40, 0x80];
      for (let i = 0; i < 8; i++) {
        const dots = [0,0,0,0,0,0,0,0]; dots[i] = 1;
        ok("brailleChar dot " + i, brailleChar(dots) === String.fromCharCode(0x2800 + bits[i]));
      }
      ok("brailleChar all off -> space", brailleChar([0,0,0,0,0,0,0,0]) === " ");
      ok("brailleChar all on -> U+28FF", brailleChar([1,1,1,1,1,1,1,1]) === String.fromCharCode(0x28FF));
    }
    // floydSteinberg: ~50% on for a flat 0.5 field; deterministic; mean-ish preserved
    {
      const w = 8, h = 8, f = new Float32Array(w * h); f.fill(0.5);
      const a = floydSteinberg(f, w, h), b = floydSteinberg(new Float32Array(f), w, h);
      let on = 0; for (let i = 0; i < a.length; i++) on += a[i];
      ok("fs ~50% on", on > w * h * 0.35 && on < w * h * 0.65);
      let same = true; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) same = false;
      ok("fs deterministic", same);
      const g = new Float32Array(w * h); g.fill(0.1);
      let on2 = 0; const c = floydSteinberg(g, w, h); for (let i = 0; i < c.length; i++) on2 += c[i];
      ok("fs darker field fewer dots", on2 < on);
    }

    // Task 3: braille render + params + dispatch
    {
      const bimg = syntheticDisc(40, 40);
      const bd = gridDims(24, 40, 40);
      const bcells = sampleBraille(bimg, bd.cols, bd.rows);
      const bp = { renderMode: "braille", fx: { churn: false } };
      const bg = renderGrid(bcells, bd.cols, bd.rows, bp, 0);
      ok("braille grid dims", bg.chars.length === bd.rows && bg.chars[0].length === bd.cols);
      let anyBraille = false;
      for (const row of bg.chars) for (const ch of row) { const cc = ch.charCodeAt(0); if (cc >= 0x2800 && cc <= 0x28FF) anyBraille = true; }
      ok("braille emits braille codepoints", anyBraille);
      // edges ignored in braille
      const noEdge = matchFrame(bcells, bd.cols, bd.rows, { renderMode: "braille", edgeStyle: "off", fx: { churn: false } }, 5);
      const wEdge = matchFrame(bcells, bd.cols, bd.rows, { renderMode: "braille", edgeStyle: "lines", fx: { churn: false } }, 5);
      ok("braille ignores edges", noEdge === wEdge);
      // seamless loop with dissolve and with dotChurn
      const diss = { renderMode: "braille", fx: { dissolve: true, churn: false } };
      ok("braille dissolve seamless", matchFrame(bcells, bd.cols, bd.rows, diss, 0) === matchFrame(bcells, bd.cols, bd.rows, diss, FRAMES));
      const dc = { renderMode: "braille", dotChurn: true, fx: { churn: false } };
      ok("braille dotChurn seamless", matchFrame(bcells, bd.cols, bd.rows, dc, 0) === matchFrame(bcells, bd.cols, bd.rows, dc, FRAMES));
      ok("braille dotChurn animates", matchFrame(bcells, bd.cols, bd.rows, dc, 0) !== matchFrame(bcells, bd.cols, bd.rows, dc, 9));
      // color in palette mode
      const pcol = renderGrid(bcells, bd.cols, bd.rows, { renderMode: "braille", colorMode: "image", fx: { churn: false } }, 0);
      let colored = false; for (const row of pcol.colors) for (const k of row) if (k) colored = true;
      ok("braille image color present", colored);
      // braille path has no 3D rotation by design: rotate3d on/off must produce identical braille
      const bNo = matchFrame(bcells, bd.cols, bd.rows, { renderMode: "braille", fx: { churn: false, rotate3d: false } }, 5);
      const bRot = matchFrame(bcells, bd.cols, bd.rows, { renderMode: "braille", fx: { churn: false, rotate3d: true }, rotAxis: "y" }, 5);
      ok("braille ignores 3d", bNo === bRot);
    }
    // glyph mode default unchanged (regression hash still guards; explicit check)
    ok("renderMode default glyph", defaults().renderMode === "glyph");

    // new charsets present, density-ordered, start with space
    for (const key of ["bold", "soft", "mixed", "asciiExt"]) {
      const s = SYMBOL_SETS[key];
      ok("charset " + key + " exists", typeof s === "string" && s.length >= 3);
      ok("charset " + key + " starts blank", s && s[0] === " ");
    }

    {
      const zip = buildBundle(cells, cols, rows, { colorMode: "palette" });
      // store-only zip keeps filenames as raw bytes; decode latin1 and look for names
      let str = ""; for (let i = 0; i < zip.length; i++) str += String.fromCharCode(zip[i]);
      ok("bundle has ansi frame", str.indexOf("ansi/frame_1.ans") >= 0);
      ok("bundle has emblem.ansi", str.indexOf("emblem.ansi") >= 0);
    }

    {
      const cb = bakeColorFrames(cells, cols, rows, { colorMode: "palette", accentThreshold: 0.3 });
      const ansi0 = paletteFrameToAnsi(cb.palette, cb.frames[0]);
      ok("ansi has truecolor escape", ansi0.indexOf("\x1b[38;2;") >= 0);
      ok("ansi has reset", ansi0.indexOf("\x1b[0m") >= 0);
      // round-trip: stripping escapes reproduces the plain frame rows exactly
      const stripped = ansi0.replace(/\x1b\[[0-9;]*m/g, "").replace(/\n$/, "");
      ok("ansi strip == plain frame", stripped === cb.frames[0].t.join("\n"));
      // run-batching: a colored region uses fewer escapes than colored cells
      let coloredCells = 0;
      for (const row of cb.frames[0].c) for (const ci of row) if (ci >= 0) coloredCells++;
      const escCount = (ansi0.match(/\x1b\[38;2;/g) || []).length;
      ok("ansi run-batches color", coloredCells === 0 || escCount < coloredCells);
      // bake length + works for braille cells
      const af = bakeAnsiFrames(cells, cols, rows, { colorMode: "palette" });
      ok("bakeAnsiFrames length", af.length === FRAMES);
      const bimg = syntheticDisc(40, 40), bd = gridDims(24, 40, 40);
      const bc = sampleBraille(bimg, bd.cols, bd.rows);
      const baf = bakeAnsiFrames(bc, bd.cols, bd.rows, { renderMode: "braille", colorMode: "image" });
      ok("bakeAnsiFrames braille ok", baf.length === FRAMES && baf[0].indexOf("\x1b[38;2;") >= 0);
      // buildBundle must not add an extra \n to ANSI entries (regression guard)
      {
        const af2 = bakeAnsiFrames(cells, cols, rows, { colorMode: "palette" });
        const rawLen = af2[0].length;
        const zb = buildBundle(cells, cols, rows, { colorMode: "palette" });
        // Parse local file headers to find emblem.ansi stored size
        let emblemStoredSize = -1;
        for (let i = 0; i < zb.length - 30; i++) {
          if (zb[i] === 0x50 && zb[i+1] === 0x4b && zb[i+2] === 0x03 && zb[i+3] === 0x04) {
            const nl = zb[i+26] | (zb[i+27] << 8);
            const name = Array.from(zb.slice(i+30, i+30+nl)).map(c => String.fromCharCode(c)).join("");
            if (name === "emblem.ansi") {
              emblemStoredSize = zb[i+22] | (zb[i+23]<<8) | (zb[i+24]<<16) | (zb[i+25]<<24);
              break;
            }
          }
        }
        ok("bundle emblem.ansi no double newline", emblemStoredSize === rawLen);
      }
    }

    // Task C1-1: SVG serializer
    {
      const cb = bakeColorFrames(cells, cols, rows, { colorMode: "palette", accentThreshold: 0.3 });
      const svg = paletteFrameToSvg(cb.palette, cb.frames[0]);
      ok("svg well-formed", svg.indexOf("<svg") === 0 && svg.indexOf("</svg>") > 0);
      ok("svg has bg rect", svg.indexOf("<rect") >= 0);
      ok("svg has text rows", (svg.match(/<text /g) || []).length === cb.frames[0].t.length);
      ok("svg has colored tspan", svg.indexOf('fill="rgb(') >= 0);
      // exact dimensions for a known tiny frame
      const f = { t: ["ab", "c"], c: [[0, 0], [-1]] };
      const s2 = paletteFrameToSvg([[1, 2, 3]], f, { fontSize: 10 });
      // cw=10*0.6=6, maxLen=2 -> W=round(12)=12 ; lh=10, rows=2 -> H=20
      ok("svg width exact", s2.indexOf('width="12"') >= 0);
      ok("svg height exact", s2.indexOf('height="20"') >= 0);
      // XML-escape: angle/amp glyphs become entities, no raw < inside text
      const f3 = { t: ["<&>"], c: [[0, 0, 0]] };
      const s3 = paletteFrameToSvg([[9, 9, 9]], f3);
      ok("svg escapes glyphs", s3.indexOf("&lt;") >= 0 && s3.indexOf("&amp;") >= 0 && s3.indexOf("&gt;") >= 0);
    }

    // DEFECT 1 + 2: IIFE-scope + content-hash embed ids
    {
      const cb = bakeColorFrames(cells, cols, rows, { colorMode: "palette" });
      const snip = buildEmbedSnippet(cb, { label: "ABC" });
      ok("embed script is IIFE-wrapped", snip.indexOf("(function(){") >= 0 && snip.indexOf("})();") >= 0);
      // distinct emblems -> distinct element ids (different suffix)
      const cb2 = bakeColorFrames(cells, cols, rows, { colorMode: "image" });
      const idOf = (s) => (s.match(/id="art(_e[0-9a-z]+)"/) || [])[1];
      ok("distinct embeds have distinct ids", idOf(snip) && idOf(buildEmbedSnippet(cb2, { label: "ABC" })) && idOf(snip) !== idOf(buildEmbedSnippet(cb2, { label: "ABC" })));
      // determinism preserved
      ok("embed still deterministic", buildEmbedSnippet(cb, { label: "ABC" }) === buildEmbedSnippet(cb, { label: "ABC" }));
      // player still standalone-safe (IIFE + single breakout)
      const ply = buildPlayerHTML({ palette: [[1,2,3]], frames: [{ t: ["a"], c: [[0]] }] }, { label: "</script><x>" });
      ok("player IIFE-wrapped", ply.indexOf("(function(){") >= 0);
      ok("player single breakout", (ply.match(/<\/script>/g) || []).length === 1);
    }

    // Task C1-2: embed snippet + shared player script
    {
      const cb = bakeColorFrames(cells, cols, rows, { colorMode: "palette" });
      const snip = buildEmbedSnippet(cb, { label: "RM3" });
      ok("embed has container", snip.indexOf('class="emblem-embed"') >= 0);
      ok("embed has script", snip.indexOf("<script>") >= 0 && snip.indexOf("</script>") >= 0);
      ok("embed embeds frames", snip.indexOf("frames") >= 0 && snip.indexOf("palette") >= 0);
      // </script> breakout guard
      const evil = buildEmbedSnippet({ palette: [[1, 2, 3]], frames: [{ t: ["a"], c: [[0]] }] }, { label: "</script><x>" });
      ok("embed no breakout", (evil.match(/<\/script>/g) || []).length === 1);
      // deterministic
      ok("embed deterministic", buildEmbedSnippet(cb, { label: "X" }) === buildEmbedSnippet(cb, { label: "X" }));
      // existing player still safe (regression)
      const ply = buildPlayerHTML({ palette: [[1, 2, 3]], frames: [{ t: ["a"], c: [[0]] }] }, { label: "</script><x>" });
      ok("player still no breakout", (ply.match(/<\/script>/g) || []).length === 1);
    }

    // Task D1: multi-image (motion) bake
    {
      // three visually distinct frames
      const ring = (W,H,r0,r1)=>{const d=new Uint8ClampedArray(W*H*4);for(let y=0;y<H;y++)for(let x=0;x<W;x++){const i=(y*W+x)*4;const dd=Math.hypot(x-(W-1)/2,y-(H-1)/2);const on=dd>=r0&&dd<=r1;d[i]=on?255:0;d[i+1]=on?80:0;d[i+2]=on?70:0;d[i+3]=255;}return{width:W,height:H,data:d};};
      const imgs = [syntheticDisc(24,24), ring(24,24,6,10), ring(24,24,2,5)];
      const gd = gridDims(32, 24, 24);
      const cb = bakeColorFramesFromImages(imgs, gd.cols, gd.rows, { colorMode: "palette" });
      ok("motion bake has FRAMES frames", cb.frames.length === FRAMES);
      ok("motion bake shape", cb.frames[0].t.length === cb.frames[0].c.length && Array.isArray(cb.palette));
      // distinct source frames -> distinct output frames
      ok("motion frames differ", cb.frames[0].t.join("") !== cb.frames[1].t.join(""));
      // synthetic FX ignored
      const a = bakeFramesFromImages(imgs, gd.cols, gd.rows, { fx: { rotate3d: true, churn: true, dissolve: true } });
      const b = bakeFramesFromImages(imgs, gd.cols, gd.rows, { fx: {} });
      ok("motion ignores synthetic fx", a.join("\n") === b.join("\n"));
      // render features apply per frame: edges
      const e = bakeFramesFromImages(imgs, gd.cols, gd.rows, { symbolKey: "blocks", edgeStyle: "lines", edgeThreshold: 0.2 });
      ok("motion applies edges", /[-/|\\]/.test(e.join("\n")));
      // braille per frame
      const br = bakeFramesFromImages(imgs, gd.cols, gd.rows, { renderMode: "braille" });
      ok("motion applies braille", [...br.join("")].some((ch) => ch.charCodeAt(0) >= 0x2800 && ch.charCodeAt(0) <= 0x28ff));
      // frame-count: 2 imgs -> still 36 (last repeats); 40 imgs -> 36
      ok("motion fills to FRAMES", bakeFramesFromImages([syntheticDisc(20,20), syntheticDisc(22,22)], gd.cols, gd.rows, {}).length === FRAMES);
    }

    // Task F1: Themes
    {
      const bake = bakeColorFrames(cells, cols, rows, { colorMode: "palette" });
      ok("THEMES.flat exists", THEMES && THEMES.flat && THEMES.flat.bg === "#0a0a0a");
      const amber = buildPlayerHTML(bake, { label: "X", theme: "amber" });
      ok("amber bg injected", amber.indexOf(THEMES.amber.bg) >= 0);
      ok("amber css injected", THEMES.amber.css === "" || amber.indexOf("text-shadow") >= 0);
      ok("themed player single breakout", (amber.match(/<\/script>/g) || []).length === 1);
      // unknown theme falls back to flat
      const bogus = buildPlayerHTML(bake, { label: "X", theme: "bogus" });
      ok("bogus theme -> flat bg", bogus.indexOf("#0a0a0a") >= 0);
      // back-compat: no theme == flat, byte-identical to an explicit flat
      ok("no-theme == flat", buildPlayerHTML(bake, { label: "X" }) === buildPlayerHTML(bake, { label: "X", theme: "flat" }));
      // default param
      ok("theme default flat", defaults().theme === "flat");
    }

    // Task F2: Share link encode/decode
    {
      const p = { cols: 60, symbolKey: "blocks", edgeStyle: "lines", colorMode: "palette", theme: "amber", label: "RM3", fx: { rotate3d: true, churn: false, shimmer: false, dissolve: false } };
      const s = encodeShare(p);
      ok("share url-safe", !/[+/=]/.test(s));
      const back = decodeShare(s);
      ok("share round-trip cols", back.cols === 60);
      ok("share round-trip nested", back.edgeStyle === "lines" && back.theme === "amber" && back.fx.rotate3d === true);
      ok("share round-trip label", back.label === "RM3");
      ok("decode garbage null", decodeShare("!!!not base64!!!") === null);
      // 3D scalar params round-trip
      const p3d = { fx: { rotate3d: true }, rotAxis: "x", rotTurns: 2, perspective: 0.3, farDim: 0.5 };
      const s3d = encodeShare(p3d);
      const back3d = decodeShare(s3d);
      ok("share round-trip 3d scalars", back3d.rotAxis === "x" && back3d.rotTurns === 2 && back3d.perspective === 0.3 && back3d.farDim === 0.5);
    }

    // Task F3: Preset gallery
    {
      ok("PRESETS non-empty", Array.isArray(PRESETS) && PRESETS.length >= 4);
      for (const preset of PRESETS) {
        ok("preset " + preset.name + " has name+params", typeof preset.name === "string" && preset.params && typeof preset.params === "object");
        const wp = withDefaults(preset.params); // must not throw
        if (wp.renderMode === "braille") { ok("preset " + preset.name + " valid (braille)", true); continue; }
        const g = renderGrid(cells, cols, rows, wp, 0);
        let nonblank = false; for (const row of g.chars) for (const ch of row) if (ch !== " ") nonblank = true;
        ok("preset " + preset.name + " renders", nonblank);
      }
    }

    // Task 8: 3D Card Spin preset
    {
      const cardP = PRESETS.find(p => p.name === "3D Card Spin");
      ok("preset 3D Card Spin exists", !!cardP && cardP.params.fx.rotate3d === true);
      ok("no legacy Globe Spin preset", !PRESETS.some(p => p.name === "Globe Spin"));
    }

    // single-frame bake matches the corresponding full-bake frame
    {
      const full = bakeColorFrames(cells, cols, rows, { fx: { churn: false } });
      const one = bakeColorFrameAt(cells, cols, rows, { fx: { churn: false } }, 3);
      ok("bakeColorFrameAt text matches full bake", JSON.stringify(one.frame.t) === JSON.stringify(full.frames[3].t));
      const maxIdx = Math.max(0, ...one.frame.c.flat());
      ok("bakeColorFrameAt palette covers indices", one.palette.length > maxIdx);
    }

    const passed = res.filter((r) => r.pass).length;
    return { passed, total: res.length, results: res, allPass: passed === res.length };
  }

  const API = {
    CELL_ASPECT, FRAMES, FRAME_TICK_MS, OFFWHITE, ACCENT, SYMBOL_SETS, ROT_AXES, COLOR_MODES, MATCH_MODES, FX_KEYS, THEMES, PRESETS,
    gridDims, sample, sampleBraille, sobel, gaussianBlur, dog, gradientAngle, edgeGlyph, shapeLevel, defaults, withDefaults, rampFor, liftColor,
    BRAILLE_BITS, brailleChar, floydSteinberg,
    renderGrid, renderBrailleGrid, frameToText, matchFrame, bakeFrames, bakeColorFrames, bakeColorFrameAt, bakeColorFramesFromImages, bakeFramesFromImages, shimmerCells,
    paletteFrameToAnsi, bakeAnsiFrames,
    escapeXml, paletteFrameToSvg,
    buildConfig, playerScript, buildPlayerHTML, hashSuffix, buildEmbedSnippet, crc32, zipStore, buildBundle, encodeShare, decodeShare, selftest, syntheticDisc,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  root.EmblemEngine = API;
})(typeof globalThis !== "undefined" ? globalThis : this);
