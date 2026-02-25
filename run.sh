#!/usr/bin/env bash
set -euo pipefail

require_cmd() {
  local cmd="$1"
  local hint="${2:-}"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd" >&2
    if [[ -n "$hint" ]]; then
      echo "$hint" >&2
    fi
    exit 1
  fi
}

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
VENV_DIR="$BACKEND_DIR/.venv"

if [[ ! -d "$VENV_DIR" ]]; then
  echo "Missing backend virtualenv. Run ./setup.sh first." >&2
  exit 1
fi

source "$VENV_DIR/bin/activate"
require_cmd pip "pip is missing from the backend virtualenv. Run ./setup.sh first."

echo "Server starting..."
python "$BACKEND_DIR/server.py"
