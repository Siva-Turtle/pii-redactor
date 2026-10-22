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
cp $N/tesseract.js/dist/tesseract.min.js $N/tesseract.js/dist/worker.min.js $V/tesseract/
cp $N/tesseract.js-core/tesseract-core*.js $N/tesseract.js-core/tesseract-core*.wasm $V/tesseract/
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
# GLiNER PII (zero-shot, Knowledgator pii-small token-level, ModernBERT
# encoder): bundle npm `gliner` 0.0.19 (MIT) and copy the onnxruntime-web
# 1.19.2 (MIT) single-thread wasm files it loads.
mkdir -p $V/gliner $V/gliner/models/knowledgator/gliner-pii-small-v1.0/onnx ../models/knowledgator/gliner-pii-small-v1.0
npx esbuild $N/gliner/dist/index.mjs --bundle --format=esm --minify --outfile=$V/gliner/gliner.bundle.js
cp $N/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs $N/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm $V/gliner/
# Model + tokenizer: knowledgator/gliner-pii-small-v1.0 (Apache-2.0). The onnx
# file lives under vendor/ (explicit modelPath in js/gliner-worker.js); the
# tokenizer files are ALSO copied to top-level /models/ (transformers.js
# default localModelPath, resolved from tokenizerPath
# "knowledgator/gliner-pii-small-v1.0").
HF="https://huggingface.co/knowledgator/gliner-pii-small-v1.0/resolve/main"
for f in gliner_config.json tokenizer.json tokenizer_config.json special_tokens_map.json; do
  curl -fL -o $V/gliner/models/knowledgator/gliner-pii-small-v1.0/$f "$HF/$f"
  cp $V/gliner/models/knowledgator/gliner-pii-small-v1.0/$f ../models/knowledgator/gliner-pii-small-v1.0/$f
done
# The 83 MB onnx weights are NOT committed (keeps the repo light);
# fetch-model.sh downloads them with a SHA-256 check (skips when present).
bash fetch-model.sh
# Compatibility fixes for the vendored GLiNER.js 0.0.19 stack (both verified
# in-browser; without them the model loads but returns noise):
# 1. tokenizer.json ships BPE merges as arrays (["Ġ","Ġ"]); the bundled
#    transformers 2.17.2 BPE loader calls .split on each entry, so rewrite
#    them to the old "a b" string form (lossless, re-applied on refresh).
# 2. the bundle hardcodes BOS id 1 (DeBERTa's [CLS]); this tokenizer's CLS is
#    50281 and transformers 2.17.2 exposes no cls_token_id, so derive it from
#    encode("[CLS]") instead (falls back to 1 for other models).
PYBIN=python3; command -v python3 >/dev/null 2>&1 || PYBIN=python
$PYBIN - <<'EOF'
import io, json
for p in ["../vendor/gliner/models/knowledgator/gliner-pii-small-v1.0/tokenizer.json",
          "../models/knowledgator/gliner-pii-small-v1.0/tokenizer.json"]:
    t = json.load(io.open(p, encoding="utf-8"))
    m = t["model"]["merges"]
    if m and isinstance(m[0], list):
        t["model"]["merges"] = [" ".join(pair) for pair in m]
        io.open(p, "w", encoding="utf-8").write(json.dumps(t, ensure_ascii=False))
        print("merges converted:", p)
b = "../vendor/gliner/gliner.bundle.js"
s = io.open(b, encoding="utf-8").read()
old = "i=[0],c=[1],u=[1],d=1"
new = 'i=[0],c=[this.tokenizer.cls_token_id??this.tokenizer.encode("[CLS]").slice(1,-1)[0]??1],u=[1],d=1'
if old in s:
    io.open(b, "w", encoding="utf-8").write(s.replace(old, new))
    print("BOS patched:", b)
elif new not in s:
    raise SystemExit("bundle BOS pattern not found; check gliner.bundle.js")
EOF
# English OCR data (tessdata_fast, Apache-2.0). Pinned checksum: the file
# lives on a moving branch, so a mismatch fails loudly for a maintainer to
# re-pin instead of silently vendoring new bytes.
TESSDATA_SHA=7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2
if [ ! -f $V/tesseract/eng.traineddata ] || ! echo "$TESSDATA_SHA  $V/tesseract/eng.traineddata" | sha256sum -c -; then
  curl -fL -o $V/tesseract/eng.traineddata "https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/eng.traineddata"
  echo "$TESSDATA_SHA  $V/tesseract/eng.traineddata" | sha256sum -c -
fi
echo "vendor/ refreshed."
