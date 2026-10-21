#!/bin/bash
# Refreshes ../vendor from npm and Hugging Face. Only maintainers need this.
set -euo pipefail
cd "$(dirname "$0")"
npm install --no-audit --no-fund
N=node_modules
V=../vendor
mkdir -p $V/needle $V/pdfjs $V/model
npx esbuild $N/cactus-needle/dist/browser/index.js --bundle --format=esm --minify --outfile=$V/needle/needle-browser.js
cp $N/cactus-needle/dist/browser/worker.js $V/needle/worker.js
cp $N/cactus-needle/vendor/needle.wasm $V/needle/needle.wasm
cp $N/cactus-needle/vendor/LICENSE $V/needle/LICENSE-needle
cp $N/pdfjs-dist/build/pdf.min.mjs $N/pdfjs-dist/build/pdf.worker.min.mjs $V/pdfjs/
cp $N/jszip/dist/jszip.min.js $N/xlsx/dist/xlsx.full.min.js $N/pdf-lib/dist/pdf-lib.min.js $V/
# Model weights: pinned revision + checksum (same pin the cactus-needle package uses).
REV=2ae11323dc000f5e70c49f7403efa6af12ba9e67
SHA=c9d915eca282ed42d1a09b143b592adb4cc6744ffe2d294adf5cfc5548170c38
curl -fL -o $V/model/needle3.cact "https://huggingface.co/Cactus-Compute/needle3/resolve/$REV/needle3.cact"
echo "$SHA  $V/model/needle3.cact" | sha256sum -c -
echo "vendor/ refreshed."
