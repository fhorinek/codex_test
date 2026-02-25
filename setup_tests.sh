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

require_cmd python3 "Install Python 3 (with venv support) and rerun ./setup_tests.sh."
require_cmd npm "Install Node.js/npm and rerun ./setup_tests.sh."

# Install runtime dependencies first.
"${ROOT_DIR}/setup.sh"

source "$VENV_DIR/bin/activate"
require_cmd pip "pip is missing from the backend virtualenv. Recreate it with ./setup.sh."
echo "Installing backend test dependencies..."
pip install -r "$BACKEND_DIR/requirements-test.txt"

echo "Installing frontend test dependencies (devDependencies)..."
cd "$FRONTEND_DIR"
npm install
