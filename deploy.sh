#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────
# ManageLM Slack Plugin — Deploy script
#
# Tags, pushes to GitHub with full history, and creates a GitHub
# release with the tarball attached.
#
# Prerequisites:
#   - package.sh has been run (tarball exists)
#   - GITHUB_TOKEN env var or ../github-token file
#
# Usage:  ./deploy.sh
# ──────────────────────────────────────────────────────────────────
set -euo pipefail

cd "$(dirname "$0")"

# Load GitHub token from shared config
TOKEN_FILE="$(dirname "$0")/../.github-token"
if [ -z "${GITHUB_TOKEN:-}" ] && [ -f "$TOKEN_FILE" ]; then
  source "$TOKEN_FILE"
fi

# Allow git to operate on claude-owned repo when running as root
git config --global --add safe.directory "$(pwd)" 2>/dev/null || true

PLUGIN_NAME="managelm-slack"
GITHUB_REPO="managelm/slack-plugin"
VERSION=$(node -p "require('./package.json').version")
TAG="v${VERSION}"
TARBALL="${PLUGIN_NAME}-${VERSION}.tar.gz"

# ── Preflight checks ─────────────────────────────────────────────
if [ ! -f "$TARBALL" ]; then
  echo "ERROR: $TARBALL not found. Run ./package.sh first."
  exit 1
fi

if [ -z "${GITHUB_TOKEN:-}" ]; then
  echo "ERROR: GITHUB_TOKEN env var is required."
  exit 1
fi

if ! git remote get-url github &>/dev/null; then
  echo "▸ Adding github remote..."
  git remote add github "https://${GITHUB_TOKEN}@github.com/${GITHUB_REPO}.git"
else
  git remote set-url github "https://${GITHUB_TOKEN}@github.com/${GITHUB_REPO}.git"
fi

# ── Check for uncommitted changes (tracked files only) ───────────
if [ -n "$(git diff --name-only HEAD 2>/dev/null)" ]; then
  echo "ERROR: Uncommitted changes in tracked files. Commit or stash first."
  git diff --name-only HEAD
  exit 1
fi

# ── Tag ──────────────────────────────────────────────────────────
echo "▸ Tagging ${TAG}..."
git tag -f "$TAG" -m "Release ${VERSION}"

# ── Push to origin (Gitea) ───────────────────────────────────────
BRANCH=$(git rev-parse --abbrev-ref HEAD)
echo "▸ Pushing to origin..."
git push origin "$BRANCH" --tags 2>/dev/null || true

# ── Push to GitHub (with full history) ───────────────────────────
echo "▸ Pushing to GitHub..."
git push github "${BRANCH}:main" --tags --force

# ── Delete existing release if re-deploying same version ─────────
EXISTING=$(curl -s -o /dev/null -w "%{http_code}" \
  "https://api.github.com/repos/${GITHUB_REPO}/releases/tags/${TAG}" \
  -H "Authorization: token ${GITHUB_TOKEN}")
if [ "$EXISTING" = "200" ]; then
  echo "▸ Deleting existing release ${TAG}..."
  RELEASE_ID=$(curl -s \
    "https://api.github.com/repos/${GITHUB_REPO}/releases/tags/${TAG}" \
    -H "Authorization: token ${GITHUB_TOKEN}" | jq -r '.id')
  curl -s -X DELETE \
    "https://api.github.com/repos/${GITHUB_REPO}/releases/${RELEASE_ID}" \
    -H "Authorization: token ${GITHUB_TOKEN}" > /dev/null
fi

# ── Create GitHub release ────────────────────────────────────────
echo "▸ Creating GitHub release ${TAG}..."

RELEASE_BODY="## ManageLM Slack Plugin ${VERSION}

### Download
- \`${TARBALL}\` — ready-to-run package (includes compiled JS, production dependencies, Dockerfile)

### Install
\`\`\`bash
tar xzf ${TARBALL}
cd ${PLUGIN_NAME}
cp .env.example .env   # edit with your credentials
node dist/app.js
\`\`\`

See [documentation](https://www.managelm.com/plugins/slack.html) for full setup guide."

RELEASE_RESPONSE=$(curl -s -X POST \
  "https://api.github.com/repos/${GITHUB_REPO}/releases" \
  -H "Authorization: token ${GITHUB_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "$(jq -n \
    --arg tag "$TAG" \
    --arg name "$PLUGIN_NAME $VERSION" \
    --arg body "$RELEASE_BODY" \
    '{tag_name: $tag, name: $name, body: $body, draft: false, prerelease: false}'
  )")

UPLOAD_URL=$(echo "$RELEASE_RESPONSE" | jq -r '.upload_url' | sed 's/{[^}]*}//')

if [ "$UPLOAD_URL" = "null" ] || [ -z "$UPLOAD_URL" ]; then
  echo "WARNING: Failed to create release. Response:"
  echo "$RELEASE_RESPONSE" | jq -r '.message // .'
  echo ""
  echo "Tag and code were pushed. Create the release manually at:"
  echo "  https://github.com/${GITHUB_REPO}/releases/new?tag=${TAG}"
  [[ "$(pwd)" == "/" ]] && { echo "FATAL: pwd is /"; exit 1; }
  chown -R claude:claude "$(pwd)"
  exit 1
fi

# ── Upload tarball as release asset ──────────────────────────────
echo "▸ Uploading ${TARBALL}..."
curl -s -X POST "${UPLOAD_URL}?name=${TARBALL}" \
  -H "Authorization: token ${GITHUB_TOKEN}" \
  -H "Content-Type: application/gzip" \
  --data-binary "@${TARBALL}" | jq -r '.state' > /dev/null

RELEASE_URL=$(echo "$RELEASE_RESPONSE" | jq -r '.html_url')

# Restore ownership (scripts may run as root)
[[ "$(pwd)" == "/" ]] && { echo "FATAL: pwd is /"; exit 1; }
chown -R claude:claude "$(pwd)"

echo ""
echo "Done: ${PLUGIN_NAME} ${VERSION}"
echo "  Tag:     ${TAG}"
echo "  Release: ${RELEASE_URL}"
echo "  Asset:   ${TARBALL}"
