#!/bin/bash
# serve.sh fetches the AI model on first run when missing, then serves.
cd "$(dirname "$0")" && exec ./serve.sh "$@"
