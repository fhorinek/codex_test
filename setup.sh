#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="${ROOT_DIR}/backend"
VENV_DIR="${BACKEND_DIR}/.venv"
FRONTEND_DIR="${ROOT_DIR}/frontend"

if [[ ! -d "$VENV_DIR" ]]; then
  python3 -m venv "$VENV_DIR"
fi

source "$VENV_DIR/bin/activate"
echo "Installing backend dependencies..."
pip install --upgrade pip
pip install -r "$BACKEND_DIR/requirements.txt"

cd "$FRONTEND_DIR"

if [[ ! -f package.json ]]; then
  npm init -y
fi

echo "Installing frontend dependencies..."
npm install
