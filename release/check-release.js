#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const manifest = require("./release-manifest.json");

const repo = path.resolve(__dirname, "..");
const failures = [];
const fail = (msg) => failures.push(msg);

for (const rel of manifest.files) {
  if (!fs.existsSync(path.join(repo, rel))) fail(`missing manifest file: ${rel}`);
}

const html = fs.readFileSync(path.join(repo, "web/index.html"), "utf8");
const remoteRefs = html.match(/\bsrc=["']https?:\/\//gi) || [];
if (remoteRefs.length) fail(`remote runtime references found: ${remoteRefs.join(", ")}`);

for (const label of ["Export bundle", "Copy current frame", "Download SVG", "Export GIF", "Export WebM"]) {
  if (!html.includes(label)) fail(`missing UI label: ${label}`);
}

const readme = fs.readFileSync(path.join(repo, "README.md"), "utf8");
for (const phrase of ["Static (no install)", "SHA256SUMS", "Browser support", "Privacy"]) {
  if (!readme.includes(phrase)) fail(`README missing phrase: ${phrase}`);
}

const tauri = JSON.parse(fs.readFileSync(path.join(repo, "src-tauri/tauri.conf.json"), "utf8"));
if (tauri.version !== manifest.version) fail(`tauri version ${tauri.version} != manifest ${manifest.version}`);

const cargo = fs.readFileSync(path.join(repo, "src-tauri/Cargo.toml"), "utf8");
if (!cargo.includes(`version = "${manifest.version}"`)) fail(`Cargo.toml version != ${manifest.version}`);

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("release checks passed");
