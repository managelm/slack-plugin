#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────
# ManageLM Slack Plugin — Build & package script
#
# Compiles TypeScript sources and creates a distributable tarball
# containing only production files (no sources, no devDependencies).
#
# Usage:  ./package.sh [--skip-build]
# Output: managelm-slack-<version>.tar.gz
#
# The tarball can be extracted and run directly with `node dist/app.js`
# or built into a Docker image.
# ──────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"
git config --global --add safe.directory "$ROOT_DIR" 2>/dev/null || true

VERSION=$(node -p "require('./package.json').version")
OUTFILE="managelm-slack-${VERSION}.tar.gz"
STAGING_DIR=$(mktemp -d)

trap 'rm -rf "$STAGING_DIR"' EXIT

# ── Flags ─────────────────────────────────────────────────────────
SKIP_BUILD=false
for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=true ;;
    *) echo "Unknown flag: $arg"; exit 1 ;;
  esac
done

# ── Build ─────────────────────────────────────────────────────────
if [ "$SKIP_BUILD" = false ]; then
  echo "▸ Installing dependencies..."
  npm ci

  echo "▸ Compiling TypeScript..."
  npx tsc
else
  echo "▸ Skipping build (--skip-build)"
  if [ ! -d dist ]; then
    echo "ERROR: dist/ missing. Run without --skip-build first."
    exit 1
  fi
fi

# ── Assemble staging directory ────────────────────────────────────
echo "▸ Assembling package..."

TARGET="$STAGING_DIR/managelm-slack"
mkdir -p "$TARGET"

# Compiled output
cp -r dist "$TARGET/"

# Production dependencies only
cp package.json package-lock.json "$TARGET/"
cd "$TARGET"
npm ci --omit=dev --ignore-scripts
cd "$ROOT_DIR"

# Config and docs
cp .env.example "$TARGET/"
cp Dockerfile "$TARGET/"
cp manifest.yaml "$TARGET/"
cp README.md "$TARGET/"
cp icon.png "$TARGET/" 2>/dev/null || true

# ── Safety: strip any .env files ──────────────────────────────────
find "$TARGET" -name '.env' -type f -delete

# ── Create tarball ────────────────────────────────────────────────
echo "▸ Creating tarball..."
tar czf "$ROOT_DIR/$OUTFILE" -C "$STAGING_DIR" managelm-slack

SIZE=$(du -h "$ROOT_DIR/$OUTFILE" | cut -f1)

# Restore ownership (scripts may run as root)
[[ "$ROOT_DIR" == "/" ]] && { echo "FATAL: ROOT_DIR is /"; exit 1; }
chown -R claude:claude "$ROOT_DIR"

echo ""
echo "Done: $OUTFILE ($SIZE)"
