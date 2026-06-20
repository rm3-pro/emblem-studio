/* Minimal animated GIF89a encoder. Pure JS, dual Node/browser, no deps.
 * Operates on INDEXED frames (palette supplied) — no color quantization. */
(function (root) {
  "use strict";

  function lzwEncode(indices, minCodeSize) {
    const clearCode = 1 << minCodeSize;
    const eoiCode = clearCode + 1;
    let codeSize = minCodeSize + 1;
    let dict = new Map();
    const reset = () => { dict = new Map(); for (let i = 0; i < clearCode; i++) dict.set(String(i), i); };
    reset();
    let next = eoiCode + 1;
    const out = [];
    let cur = 0, curBits = 0;
    const emit = (code) => {
      cur |= code << curBits; curBits += codeSize;
      while (curBits >= 8) { out.push(cur & 0xff); cur >>>= 8; curBits -= 8; }
    };
    emit(clearCode);
    if (indices.length === 0) { emit(eoiCode); if (curBits > 0) out.push(cur & 0xff); return Uint8Array.from(out); }
    let w = String(indices[0]);
    for (let i = 1; i < indices.length; i++) {
      const k = indices[i];
      const wk = w + "," + k;
      if (dict.has(wk)) { w = wk; }
      else {
        emit(dict.get(w));
        if (next < 4096) {
          dict.set(wk, next++);
          if (next > (1 << codeSize) && codeSize < 12) codeSize++;
        } else {
          emit(clearCode); reset(); next = eoiCode + 1; codeSize = minCodeSize + 1;
        }
        w = String(k);
      }
    }
    emit(dict.get(w));
    emit(eoiCode);
    if (curBits > 0) out.push(cur & 0xff);
    return Uint8Array.from(out);
  }

  function encodeGif(opts) {
    const { width, height, palette, frames, loop = 0 } = opts;
    let gctBits = 1; while ((1 << gctBits) < palette.length) gctBits++;   // entries = 2^gctBits
    if (gctBits > 8) throw new Error("palette too large (>256)");
    const gctEntries = 1 << gctBits;
    const minCodeSize = Math.max(2, gctBits);
    const b = [];
    const u16 = (n) => { b.push(n & 0xff, (n >>> 8) & 0xff); };
    for (const ch of "GIF89a") b.push(ch.charCodeAt(0));
    u16(width); u16(height);
    b.push(0x80 | ((gctBits - 1) << 4) | (gctBits - 1)); // GCT present, color-res, GCT size
    b.push(0, 0);
    for (let i = 0; i < gctEntries; i++) { const c = palette[i] || [0, 0, 0]; b.push(c[0] & 0xff, c[1] & 0xff, c[2] & 0xff); }
    b.push(0x21, 0xff, 0x0b); for (const ch of "NETSCAPE2.0") b.push(ch.charCodeAt(0)); b.push(0x03, 0x01); u16(loop); b.push(0x00);
    for (const fr of frames) {
      const delayCs = Math.round((fr.delayMs == null ? 80 : fr.delayMs) / 10);
      b.push(0x21, 0xf9, 0x04, 0x00); u16(delayCs); b.push(0x00, 0x00);   // GCE: no transparency, disposal 0
      b.push(0x2c); u16(0); u16(0); u16(width); u16(height); b.push(0x00); // image descriptor, no LCT
      b.push(minCodeSize);
      const data = lzwEncode(fr.index, minCodeSize);
      for (let i = 0; i < data.length; i += 255) {
        const end = Math.min(i + 255, data.length);
        b.push(end - i); for (let j = i; j < end; j++) b.push(data[j]);
      }
      b.push(0x00);
    }
    b.push(0x3b);
    return Uint8Array.from(b);
  }

  const API = { encodeGif, lzwEncode };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  root.GifEncoder = API;
})(typeof globalThis !== "undefined" ? globalThis : this);
