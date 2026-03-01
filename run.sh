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
FRONTEND_DIR="$ROOT_DIR/frontend"
VENV_DIR="$BACKEND_DIR/.venv"
FRONTEND_BUILD_CACHE_DIR="$FRONTEND_DIR/.build-cache"
FRONTEND_BUILD_HASH_FILE="$FRONTEND_BUILD_CACHE_DIR/frontend-source.sha256"

hash_file() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
    return
  fi
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
    return
  fi
  echo "Missing required command: sha256sum (or shasum)" >&2
  exit 1
}

compute_frontend_source_hash() {
  (
    cd "$FRONTEND_DIR"
    local sources=(
      "index.html"
      "scripts"
      "styles"
      "assets"
      "tsconfig.json"
      "tsconfig.build.json"
      "package.json"
      "package-lock.json"
    )
    local files=()
    local source
    for source in "${sources[@]}"; do
      if [[ -f "$source" ]]; then
        files+=("$source")
        continue
      fi
      if [[ -d "$source" ]]; then
        while IFS= read -r file; do
          files+=("$file")
        done < <(find "$source" -type f | LC_ALL=C sort)
      fi
    done
    if [[ "${#files[@]}" -eq 0 ]]; then
      echo ""
      return
    fi
    local digest_file
    digest_file="$(mktemp)"
    local file
    for file in "${files[@]}"; do
      printf '%s %s\n' "$file" "$(hash_file "$file")" >>"$digest_file"
    done
    local combined_hash
    combined_hash="$(hash_file "$digest_file")"
    rm -f "$digest_file"
    echo "$combined_hash"
  )
}

if [[ ! -d "$VENV_DIR" ]]; then
  echo "Missing backend virtualenv. Run ./setup.sh first." >&2
  exit 1
fi

source "$VENV_DIR/bin/activate"
require_cmd pip "pip is missing from the backend virtualenv. Run ./setup.sh first."
require_cmd npm "npm is required to build the frontend. Run npm install in ./frontend first."

current_frontend_hash="$(compute_frontend_source_hash)"
cached_frontend_hash=""
if [[ -f "$FRONTEND_BUILD_HASH_FILE" ]]; then
  cached_frontend_hash="$(cat "$FRONTEND_BUILD_HASH_FILE")"
fi

frontend_dist_ready="false"
if [[ -f "$FRONTEND_DIR/dist/scripts/app.js" && -f "$FRONTEND_DIR/dist/index.html" && -f "$FRONTEND_DIR/dist/build-info.json" ]]; then
  frontend_dist_ready="true"
fi

if [[ "$frontend_dist_ready" == "true" && -n "$current_frontend_hash" && "$current_frontend_hash" == "$cached_frontend_hash" ]]; then
  echo "Frontend unchanged. Skipping rebuild."
else
  echo "Building frontend..."
  (
    cd "$FRONTEND_DIR"
    npm run build:dist
  )
  mkdir -p "$FRONTEND_BUILD_CACHE_DIR"
  printf '%s\n' "$current_frontend_hash" >"$FRONTEND_BUILD_HASH_FILE"
fi

echo "Server starting..."
python "$BACKEND_DIR/server.py"
