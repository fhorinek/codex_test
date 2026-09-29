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
BACKEND_DIR="${ROOT_DIR}/backend"
VENV_DIR="${BACKEND_DIR}/.venv"
FRONTEND_DIR="${ROOT_DIR}/frontend"

require_cmd python3 "Install Python 3 (with venv support) and rerun ./setup.sh."
require_cmd npm "Install Node.js/npm and rerun ./setup.sh."

if [[ ! -d "$VENV_DIR" ]]; then
  python3 -m venv "$VENV_DIR"
fi

source "$VENV_DIR/bin/activate"
require_cmd pip "pip is missing from the backend virtualenv. Recreate it with ./setup.sh."
echo "Installing backend runtime dependencies..."
pip install --upgrade pip
pip install -r "$BACKEND_DIR/requirements.txt"

cd "$FRONTEND_DIR"

if [[ ! -f package.json ]]; then
  npm init -y
fi

echo "Installing frontend runtime and build dependencies..."
npm install --include=dev
