const { gifToImageDatas } = require("./motion-input.js");
const { encodeGif } = require("./gif-encoder.js");
function run() {
  const res = []; const ok = (n, c) => res.push({ name: n, pass: !!c });
  // 3-frame 4x2 GIF: frame k filled with palette index k%2
  const W = 4, H = 2, palette = [[0, 0, 0], [255, 0, 0]];
  const frames = [0, 1, 0].map((v) => ({ index: Uint8Array.from(new Array(W * H).fill(v)), delayMs: 80 }));
  const gif = encodeGif({ width: W, height: H, palette, frames, loop: 0 });
  const out = gifToImageDatas(gif, 36);
  ok("count == 36", out.length === 36);
  ok("imagedata bytes", out[0].width === W && out[0].height === H && out[0].data.length === W * H * 4);
  // frame 0 is black, a later resampled frame maps onto the red frame
  ok("frame0 black", out[0].data[0] === 0 && out[0].data[1] === 0);
  ok("some frame red", out.some((d) => d.data[0] === 255 && d.data[1] === 0));
  const passed = res.filter((r) => r.pass).length;
  return { passed, total: res.length, results: res, allPass: passed === res.length };
}
module.exports = { run };
if (require.main === module) { const r = run(); console.log(JSON.stringify(r.results.filter((x) => !x.pass))); console.log(r.passed + "/" + r.total); process.exit(r.allPass ? 0 : 1); }
