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
  }") || RELEASE_JSON=""

# If POST failed (empty or missing upload_url), fetch existing release
if ! echo "$RELEASE_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); exit(0 if 'upload_url' in d else 1)" 2>/dev/null; then
  echo "    Release already exists — fetching existing release..."
  RELEASE_JSON=$(curl -sf \
    "https://api.github.com/repos/$REPO/releases/tags/$TAG" \
    -H "Authorization: Bearer $GITHUB_TOKEN")
fi

UPLOAD_URL=$(echo "$RELEASE_JSON" | python3 -c \
  "import sys,json; print(json.load(sys.stdin)['upload_url'])" | sed 's/{.*}//')
HTML_URL=$(echo "$RELEASE_JSON" | python3 -c \
  "import sys,json; print(json.load(sys.stdin)['html_url'])")
RELEASE_ID=$(echo "$RELEASE_JSON" | python3 -c \
  "import sys,json; print(json.load(sys.stdin)['id'])")

echo "    Release created: $HTML_URL"

# Helper: upload one asset, skip if already present
upload_asset() {
  local name="$1"
  local file="$2"
  # Check if asset already exists on this release
  local exists
  exists=$(curl -sf \
    "https://api.github.com/repos/$REPO/releases/$RELEASE_ID/assets" \
    -H "Authorization: Bearer $GITHUB_TOKEN" | \
    python3 -c "import sys,json; assets=json.load(sys.stdin); print('yes' if any(a['name']=='$name' for a in assets) else 'no')")
  if [ "$exists" = "yes" ]; then
    echo "    Already uploaded — skipping."
    return 0
  fi
  curl -sf -X POST "${UPLOAD_URL}?name=${name}" \
    -H "Authorization: Bearer $GITHUB_TOKEN" \
    -H "Content-Type: application/octet-stream" \
    --data-binary "@$file" > /dev/null
  echo "    Done."
}

# Upload amd64
echo "[2/3] Uploading dabcast_${VERSION}_amd64.deb..."
upload_asset "dabcast_${VERSION}_amd64.deb" "$AMD64_DEB"

# Upload arm64
echo "[3/3] Uploading dabcast_${VERSION}_arm64.deb..."
upload_asset "dabcast_${VERSION}_arm64.deb" "$ARM64_DEB"

echo ""
echo "==> Release $TAG published successfully"
echo "    $HTML_URL"
