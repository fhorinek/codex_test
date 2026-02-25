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
FRONTEND_DIR="$ROOT_DIR/frontend"
BACKEND_DIR="$ROOT_DIR/backend"
BACKEND_VENV="$ROOT_DIR/backend/.venv"
BACKEND_PYTHON="$BACKEND_VENV/bin/python"

require_cmd npm "Install Node.js/npm and rerun ./run_test.sh."

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

if [[ ! -x "$BACKEND_VENV/bin/pip" ]]; then
  echo "Missing backend virtualenv pip: $BACKEND_VENV/bin/pip" >&2
  echo "Run ./setup_tests.sh to install runtime and test dependencies." >&2
  exit 1
fi

echo "Running backend unit tests..."
(
  cd "$BACKEND_DIR"
  "$BACKEND_PYTHON" -m coverage erase
  "$BACKEND_PYTHON" -m coverage run --rcfile .coveragerc -m unittest discover -s tests -v
  "$BACKEND_PYTHON" -m coverage report --rcfile .coveragerc -m
  "$BACKEND_PYTHON" -m coverage xml --rcfile .coveragerc -o coverage.xml
  "$BACKEND_PYTHON" -m coverage html --rcfile .coveragerc
)

echo "Running frontend coverage (c8) for unit tests..."
(
  cd "$FRONTEND_DIR"
  npm run test:coverage
)

echo "Running frontend e2e tests (including Chrome connect regression)..."
(
  cd "$FRONTEND_DIR"
  npm run test:e2e
  npm run test:e2e:chrome-connect
)

echo "All tests passed."
echo
echo "Reports:"
echo "  Backend coverage HTML : $BACKEND_DIR/htmlcov/index.html"
echo "  Backend coverage XML  : $BACKEND_DIR/coverage.xml"
echo "  Frontend c8 HTML      : $FRONTEND_DIR/coverage/c8/index.html"
echo "  Frontend c8 LCOV      : $FRONTEND_DIR/coverage/c8/lcov.info"
