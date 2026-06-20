#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR/web"

node -e "const E=require('./engine.js');const r=E.selftest();console.log(JSON.stringify(r.results.filter(x=>!x.pass)));console.log('engine '+r.passed+'/'+r.total);process.exit(r.allPass?0:1)"
node gif-encoder.test.js
node motion-input.test.js
cd "$DIR"
node release/check-release.js

