#!/bin/bash
# Shared by Start-Mac.command and start-linux.sh.
cd "$(dirname "$0")" || exit 1
# One-time 183 MB model download (skipped when already present, so this stays
# offline-friendly). The app still works without it (patterns only).
if [ ! -f "vendor/gliner/models/onnx-community/gliner_small-v2.1/onnx/model_quantized.onnx" ]; then
  echo "  AI model not found, downloading it now (one time, ~183 MB)..."
  if ! bash tools/fetch-model.sh; then
    echo "  Could not download the AI model. Continuing with pattern checks only."
  fi
fi
for py in python3 python; do
  if command -v "$py" >/dev/null 2>&1 && "$py" -c 'import sys; sys.exit(sys.version_info < (3, 6))' 2>/dev/null; then
    exec "$py" serve.py "$@"
  fi
done
echo
echo "  Python 3 was not found on this computer, and it is needed to start the tool."
echo "  Easiest fix: use the hosted web link your team shared (no install needed),"
echo "  or install Python from https://www.python.org/downloads/ and try again."
echo
read -r -p "  Press Enter to close. " _
exit 1
