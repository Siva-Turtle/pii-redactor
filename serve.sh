#!/bin/bash
# Shared by Start-Mac.command and start-linux.sh.
cd "$(dirname "$0")" || exit 1
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
