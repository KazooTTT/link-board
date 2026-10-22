#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
exec /usr/bin/python3 -m http.server "${PORT:-8812}" --bind 127.0.0.1
