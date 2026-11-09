#!/bin/bash
# DABcast GitHub Release Script
# Usage: GITHUB_TOKEN=ghp_xxx ./build/release.sh [version]
# If version is omitted, reads from server/package.json
set -e

REPO="DABodr/DABcast-diffusion-software"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

if [ -z "$GITHUB_TOKEN" ]; then
  echo "Error: GITHUB_TOKEN environment variable is required"
  echo "Usage: GITHUB_TOKEN=ghp_xxx ./build/release.sh [version]"
  exit 1
fi

VERSION="${1:-$(node -p "require('$ROOT_DIR/server/package.json').version")}"
TAG="v$VERSION"
DIST_DIR="$ROOT_DIR/dist"

echo "==> Releasing DABcast $TAG to $REPO"

# Check .deb files exist
AMD64_DEB="$DIST_DIR/dabcast_${VERSION}_amd64.deb"
ARM64_DEB="$DIST_DIR/dabcast_${VERSION}_arm64.deb"

for f in "$AMD64_DEB" "$ARM64_DEB"; do
  if [ ! -f "$f" ]; then
    echo "Error: $f not found — run ./build.sh first"
    exit 1
  fi
done

# Create the GitHub release (or reuse existing one)
echo "[1/3] Creating release $TAG..."
BODY_JSON=$(python3 -c "import sys,json; print(json.dumps(sys.stdin.read()))" <<< "${RELEASE_NOTES:-}")
RELEASE_JSON=$(curl -sf -X POST \
  "https://api.github.com/repos/$REPO/releases" \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"tag_name\": \"$TAG\",
    \"name\": \"DABcast $TAG\",
    \"body\": $BODY_JSON,
    \"draft\": false,
    \"prerelease\": false
  }") || true

# If release already exists, fetch it
if [ -z "$RELEASE_JSON" ] || echo "$RELEASE_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); exit(0 if 'upload_url' in d else 1)" 2>/dev/null; then
  : # release created successfully
else
  echo "    Release already exists — fetching existing release..."
  RELEASE_JSON=$(curl -sf \
    "https://api.github.com/repos/$REPO/releases/tags/$TAG" \
    -H "Authorization: Bearer $GITHUB_TOKEN")
fi

UPLOAD_URL=$(echo "$RELEASE_JSON" | python3 -c \
  "import sys,json; print(json.load(sys.stdin)['upload_url'])" | sed 's/{.*}//')
HTML_URL=$(echo "$RELEASE_JSON" | python3 -c \
  "import sys,json; print(json.load(sys.stdin)['html_url'])")

echo "    Release created: $HTML_URL"

# Upload amd64
echo "[2/3] Uploading dabcast_${VERSION}_amd64.deb..."
curl -sf -X POST "${UPLOAD_URL}?name=dabcast_${VERSION}_amd64.deb" \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Content-Type: application/octet-stream" \
  --data-binary "@$AMD64_DEB" > /dev/null
echo "    Done."

# Upload arm64
echo "[3/3] Uploading dabcast_${VERSION}_arm64.deb..."
curl -sf -X POST "${UPLOAD_URL}?name=dabcast_${VERSION}_arm64.deb" \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Content-Type: application/octet-stream" \
  --data-binary "@$ARM64_DEB" > /dev/null
echo "    Done."

echo ""
echo "==> Release $TAG published successfully"
echo "    $HTML_URL"
