#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND_DIR="$ROOT_DIR/frontend"
BACKEND_DIR="$ROOT_DIR/backend"
BACKEND_VENV="$ROOT_DIR/backend/.venv"
BACKEND_PYTHON="$BACKEND_VENV/bin/python"

if [[ ! -d "$FRONTEND_DIR" ]]; then
  echo "Missing frontend directory: $FRONTEND_DIR" >&2
  exit 1
fi

if [[ ! -d "$BACKEND_DIR" ]]; then
  echo "Missing backend directory: $BACKEND_DIR" >&2
  exit 1
fi

if [[ ! -d "$BACKEND_VENV" ]]; then
  echo "Missing backend virtualenv. Run ./setup.sh first." >&2
  exit 1
fi

if [[ ! -x "$BACKEND_PYTHON" ]]; then
  echo "Missing backend Python executable: $BACKEND_PYTHON" >&2
  exit 1
fi

echo "Running backend unit tests..."
(
  cd "$BACKEND_DIR"
  "$BACKEND_PYTHON" -m unittest discover -s tests -v
)

echo "Running frontend unit tests..."
(
  cd "$FRONTEND_DIR"
  npm run test:unit
)

echo "Running e2e tests..."
(
  cd "$FRONTEND_DIR"
  npm run test:e2e
)

echo "All tests passed."
