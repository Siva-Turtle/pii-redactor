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
# Self-hosted UI fonts (OFL): Fraunces 500 (headings) + Inter 400/500/600
# (body), latin subset woff2 only (~90 KB total, no network at runtime).
mkdir -p $V/fonts
cp $N/@fontsource/fraunces/files/fraunces-latin-500-normal.woff2 $V/fonts/fraunces-500.woff2
cp $N/@fontsource/inter/files/inter-latin-400-normal.woff2 $V/fonts/inter-400.woff2
cp $N/@fontsource/inter/files/inter-latin-500-normal.woff2 $V/fonts/inter-500.woff2
cp $N/@fontsource/inter/files/inter-latin-600-normal.woff2 $V/fonts/inter-600.woff2
# Sync SHA-512 + raw AES-CBC for Office password removal (js/office-crypto.js).
# Only sha512 and cbc are bundled; the alias resolves noble's node crypto shim.
cat > .noble-entry.mjs <<'EOF'
export { sha512 } from "@noble/hashes/sha512";
export { cbc } from "@noble/ciphers/aes";
EOF
npx esbuild .noble-entry.mjs --bundle --format=esm --minify --alias:@noble/hashes/crypto=./node_modules/@noble/hashes/esm/crypto.js --outfile=$V/noble-crypto.min.mjs
rm .noble-entry.mjs
# Model weights: pinned revision + checksum (same pin the cactus-needle package uses).
REV=2ae11323dc000f5e70c49f7403efa6af12ba9e67
SHA=c9d915eca282ed42d1a09b143b592adb4cc6744ffe2d294adf5cfc5548170c38
curl -fL -o $V/model/needle3.cact "https://huggingface.co/Cactus-Compute/needle3/resolve/$REV/needle3.cact"
echo "$SHA  $V/model/needle3.cact" | sha256sum -c -
echo "vendor/ refreshed."
