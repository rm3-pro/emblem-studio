#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const manifest = require("./release-manifest.json");
const outDir = path.join(repo, "dist", manifest.name);
const stageDir = path.join(outDir, manifest.name);

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}
function mkdirp(p) {
  fs.mkdirSync(p, { recursive: true });
}
function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}
function copyFile(rel) {
  const src = path.join(repo, rel);
  const dst = path.join(stageDir, rel);
  if (!fs.existsSync(src)) throw new Error(`missing release file: ${rel}`);
  mkdirp(path.dirname(dst));
  fs.copyFileSync(src, dst);
}
function readReleaseBytes(rel) {
  return fs.readFileSync(path.join(stageDir, rel));
}
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function u16(n) {
  return [n & 0xff, (n >>> 8) & 0xff];
}
function u32(n) {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}
function zipStoreBytes(files) {
  const enc = files.map((f) => ({
    name: Buffer.from(f.name, "utf8"),
    data: f.data,
    crc: crc32(f.data),
  }));
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const e of enc) {
    const head = Buffer.from([].concat(u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0x21), u32(e.crc), u32(e.data.length), u32(e.data.length), u16(e.name.length), u16(0)));
    chunks.push(head, e.name, e.data);
    central.push({ e, offset });
    offset += head.length + e.name.length + e.data.length;
  }
  const cdStart = offset;
  let cdLen = 0;
  for (const { e, offset: off } of central) {
    const head = Buffer.from([].concat(u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0x21), u32(e.crc), u32(e.data.length), u32(e.data.length), u16(e.name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(off)));
    chunks.push(head, e.name);
    cdLen += head.length + e.name.length;
  }
  chunks.push(Buffer.from([].concat(u32(0x06054b50), u16(0), u16(0), u16(enc.length), u16(enc.length), u32(cdLen), u32(cdStart), u16(0))));
  return Buffer.concat(chunks);
}

rmrf(outDir);
mkdirp(stageDir);
for (const rel of manifest.files) copyFile(rel);

const zipFiles = manifest.files.map((rel) => ({ name: `${manifest.name}/${rel}`, data: readReleaseBytes(rel) }));
const zip = zipStoreBytes(zipFiles);
const zipName = `${manifest.name}-v${manifest.version}.zip`;
const zipPath = path.join(outDir, zipName);
fs.writeFileSync(zipPath, zip);

const sums = [];
for (const rel of manifest.files) {
  sums.push(`${sha256(readReleaseBytes(rel))}  ${manifest.name}/${rel}`);
}
sums.push(`${sha256(zip)}  ${zipName}`);
fs.writeFileSync(path.join(outDir, "SHA256SUMS"), sums.join("\n") + "\n");
fs.writeFileSync(path.join(__dirname, "SHA256SUMS"), sums.join("\n") + "\n");

console.log(`Packaged ${manifest.files.length} files`);
console.log(path.relative(repo, zipPath));
console.log(path.relative(repo, path.join(outDir, "SHA256SUMS")));
console.log(path.relative(repo, path.join(__dirname, "SHA256SUMS")));
