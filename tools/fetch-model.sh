#!/bin/bash
# Downloads the GLiNER onnx weights (183 MB, not committed: over GitHub's
# 100 MB file limit). No npm needed. Skips the download when the file is
# already present with the right SHA-256; verifies the checksum afterwards
# and fails loudly otherwise.
set -euo pipefail
cd "$(dirname "$0")"
DEST="../vendor/gliner/models/onnx-community/gliner_small-v2.1/onnx/model_quantized.onnx"
URL="https://huggingface.co/onnx-community/gliner_small-v2.1/resolve/main/onnx/model_quantized.onnx"
SHA="c76c90920547fd937aaf505e7f2de5ec73168bf1c25abbb55a298104cb061400"

sha_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    # macOS ships shasum instead of sha256sum.
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

if [ -f "$DEST" ]; then
  if [ "$(sha_of "$DEST")" = "$SHA" ]; then
    echo "OK: $DEST already present with the expected SHA-256."
    exit 0
  fi
  echo "SHA-256 mismatch on existing $DEST; re-downloading…" >&2
fi
mkdir -p "$(dirname "$DEST")"
# WHY .tmp + rename: a half-downloaded file must never look complete.
curl -fL -o "$DEST.tmp" "$URL"
mv "$DEST.tmp" "$DEST"
GOT="$(sha_of "$DEST")"
echo "SHA-256: $GOT  $DEST"
echo "expect: $SHA"
if [ "$GOT" != "$SHA" ]; then
  echo "ERROR: SHA-256 mismatch for $DEST (downloaded file kept for inspection)." >&2
  exit 1
fi
echo "OK: $DEST downloaded and verified."
