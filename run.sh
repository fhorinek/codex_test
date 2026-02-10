#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
VENV_DIR="$BACKEND_DIR/.venv"

if [[ ! -d "$VENV_DIR" ]]; then
  echo "Missing backend virtualenv. Run ./setup.sh first." >&2
  exit 1
fi

source "$VENV_DIR/bin/activate"

echo "Server starting..."
python "$BACKEND_DIR/server.py"
