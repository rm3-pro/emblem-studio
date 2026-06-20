const { encodeGif, lzwEncode } = require("./gif-encoder.js");

function lzwDecode(bytes, minCodeSize) {
  const clearCode = 1 << minCodeSize, eoiCode = clearCode + 1;
  let codeSize = minCodeSize + 1, dict = [], next;
  const reset = () => { dict = []; for (let i = 0; i < clearCode; i++) dict[i] = [i]; dict[clearCode] = null; dict[eoiCode] = null; next = eoiCode + 1; codeSize = minCodeSize + 1; };
  reset();
  let cur = 0, curBits = 0, pos = 0;
  const read = () => { while (curBits < codeSize) { cur |= bytes[pos++] << curBits; curBits += 8; } const c = cur & ((1 << codeSize) - 1); cur >>>= codeSize; curBits -= codeSize; return c; };
  const out = []; let prev = null;
  for (;;) {
    const code = read();
    if (code === clearCode) { reset(); prev = null; continue; }
    if (code === eoiCode) break;
    let entry;
    if (dict[code]) entry = dict[code];
    else if (code === next && prev) entry = prev.concat(prev[0]);
    else throw new Error("bad code " + code);
    for (const v of entry) out.push(v);
    if (prev) { dict[next++] = prev.concat(entry[0]); if (next === (1 << codeSize) && codeSize < 12) codeSize++; }
    prev = entry;
  }
  return out;
}

function run() {
  const res = []; const ok = (n, c) => res.push({ name: n, pass: !!c });
  const palette = [[0, 0, 0], [255, 255, 255]];
  const idx = Uint8Array.from([0, 1, 1, 0, 1, 0, 0, 1]);
  const gif = encodeGif({ width: 4, height: 2, palette, frames: [{ index: idx, delayMs: 80 }], loop: 0 });
  ok("GIF89a header", String.fromCharCode(...gif.slice(0, 6)) === "GIF89a");
  ok("trailer 0x3B", gif[gif.length - 1] === 0x3b);
  let s = ""; for (const x of gif) s += String.fromCharCode(x);
  ok("NETSCAPE loop ext", s.indexOf("NETSCAPE2.0") >= 0);
  // LZW round-trip (encoder correctness)
  const enc = lzwEncode(idx, 2);
  const dec = lzwDecode(enc, 2);
  ok("lzw round-trip", dec.length === idx.length && dec.every((v, i) => v === idx[i]));
  // larger random-ish frame round-trips
  const big = new Uint8Array(500); for (let i = 0; i < big.length; i++) big[i] = (i * 7 + (i >> 2)) & 1;
  const dec2 = lzwDecode(lzwEncode(big, 2), 2);
  ok("lzw round-trip 500", dec2.length === big.length && dec2.every((v, i) => v === big[i]));
  // delay encoded: locate the Graphic Control Extension and read its 2-byte LE delay
  const gce = gif.indexOf(0xf9);
  ok("GCE present", gce >= 0 && gif[gce - 1] === 0x21 && gif[gce + 1] === 0x04);
  // bytes after [0x21,0xf9,0x04,flags] are the u16 LE delay in centiseconds
  const delayCs = gif[gce + 3] | (gif[gce + 4] << 8);
  ok("delay = 8 centiseconds (80ms)", delayCs === 8);
  const passed = res.filter((r) => r.pass).length;
  return { passed, total: res.length, results: res, allPass: passed === res.length };
}
module.exports = { run, lzwDecode };
if (require.main === module) { const r = run(); console.log(JSON.stringify(r.results.filter((x) => !x.pass))); console.log(r.passed + "/" + r.total); process.exit(r.allPass ? 0 : 1); }
