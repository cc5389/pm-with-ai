#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if ! command -v node >/dev/null 2>&1; then
  if [[ -x /tmp/node-v24.21.0-linux-x64/bin/node ]]; then
    export PATH="/tmp/node-v24.21.0-linux-x64/bin:$PATH"
  else
    echo "Install Node.js 24 or newer, run npm ci, then run this script again." >&2
    exit 1
  fi
fi
exec npm run dev -- "$@"
