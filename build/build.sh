#!/bin/bash
# DABcast .deb build script
# Requires: npx (npm), dpkg-deb
# Tools installed on first run via npx (no global install needed)
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
SERVER_DIR="$ROOT_DIR/server"
WEB_DIR="$ROOT_DIR/web"
DIST_DIR="$ROOT_DIR/dist"
DEB_STAGE="$DIST_DIR/deb-stage"

# Architecture cible (défaut : amd64)
# Usage: ./build.sh [amd64|arm64]
ARCH="${1:-amd64}"
case "$ARCH" in
  # Node.js 24 LTS embedded (supported until April 2028; Node 18 reached end of life in April 2025)
  amd64) PKG_TARGET="node24-linux-x64" ;;
  arm64) PKG_TARGET="node24-linux-arm64" ;;
  *) echo "Architecture inconnue: $ARCH (valeurs valides: amd64, arm64)"; exit 1 ;;
esac

# Read version from server/package.json
VERSION=$(node -p "require('$SERVER_DIR/package.json').version")
DEB_NAME="dabcast_${VERSION}_${ARCH}"

echo "==> Building DABcast v$VERSION ($ARCH)"
echo ""

# ── 0. Cleanup ────────────────────────────────────────────────────────────────
# Remove intermediate files only — preserve already-built .deb packages
mkdir -p "$DIST_DIR"
rm -rf "$DIST_DIR/server.cjs" "$DIST_DIR/dabcast-bin" "$DIST_DIR/web" "$DEB_STAGE"

# ── 1. npm install (server) ───────────────────────────────────────────────────
echo "[1/5] Installing server dependencies..."
npm ci --prefix "$SERVER_DIR" --quiet

# ── 2. Bundle server (ESM → CommonJS) with esbuild ───────────────────────────
echo "[2/5] Bundling server with esbuild..."
npx esbuild "$SERVER_DIR/src/index.js" \
  --bundle \
  --platform=node \
  --format=cjs \
  --target=node24 \
  --outfile="$DIST_DIR/server.cjs" \
  --external:bcrypt \
  --loader:.jwk=text \
  --define:process.env.NODE_ENV='"production"' \
  --define:__APP_VERSION__='"'"$VERSION"'"'

# ── 3. Package server binary with pkg ─────────────────────────────────────────
echo "[3/5] Packaging binary with @yao-pkg/pkg (Node.js 24 embedded)..."
echo "      (First run may download pkg targets — please wait)"
npx @yao-pkg/pkg@6.25.0 "$DIST_DIR/server.cjs" \
  --targets "$PKG_TARGET" \
  --no-bytecode --public \
  --output "$DIST_DIR/dabcast-bin"

# ── 4. Minify frontend ────────────────────────────────────────────────────────
echo "[4/5] Minifying frontend..."
mkdir -p "$DIST_DIR/web"

# Minify app.js
npx esbuild "$WEB_DIR/app.js" \
  --minify \
  --outfile="$DIST_DIR/web/app.js"

# Minify integrated login page assets
npx esbuild "$WEB_DIR/login.js" \
  --minify \
  --outfile="$DIST_DIR/web/login.js"

# Minify style.css
npx esbuild "$WEB_DIR/style.css" \
  --minify \
  --outfile="$DIST_DIR/web/style.css"

npx esbuild "$WEB_DIR/login.css" \
  --minify \
  --outfile="$DIST_DIR/web/login.css"

# Copy HTML and image assets as-is
cp "$WEB_DIR/index.html" "$DIST_DIR/web/index.html"
cp "$WEB_DIR/login.html" "$DIST_DIR/web/login.html"
for f in "$WEB_DIR"/*.png "$WEB_DIR"/*.ico; do
  [ -f "$f" ] && cp "$f" "$DIST_DIR/web/" || true
done

# ── 5. Assemble .deb stage directory ─────────────────────────────────────────
echo "[5/5] Assembling .deb package..."

# DEBIAN control files
mkdir -p "$DEB_STAGE/DEBIAN"
cp "$SCRIPT_DIR/debian/control" "$DEB_STAGE/DEBIAN/control"
sed -i "s/^Version:.*/Version: $VERSION/" "$DEB_STAGE/DEBIAN/control"
sed -i "s/^Architecture:.*/Architecture: $ARCH/" "$DEB_STAGE/DEBIAN/control"
cp "$SCRIPT_DIR/debian/postinst"  "$DEB_STAGE/DEBIAN/postinst"
cp "$SCRIPT_DIR/debian/prerm"     "$DEB_STAGE/DEBIAN/prerm"
cp "$SCRIPT_DIR/debian/postrm"    "$DEB_STAGE/DEBIAN/postrm"
cp "$SCRIPT_DIR/debian/conffiles" "$DEB_STAGE/DEBIAN/conffiles"
chmod 755 "$DEB_STAGE/DEBIAN/postinst" \
           "$DEB_STAGE/DEBIAN/prerm" \
           "$DEB_STAGE/DEBIAN/postrm"

# Binary
mkdir -p "$DEB_STAGE/opt/dabcast/bin"
cp "$DIST_DIR/dabcast-bin" "$DEB_STAGE/opt/dabcast/bin/dabcast"
chmod 755 "$DEB_STAGE/opt/dabcast/bin/dabcast"

# Frontend (minified)
mkdir -p "$DEB_STAGE/opt/dabcast/web"
cp -r "$DIST_DIR/web/." "$DEB_STAGE/opt/dabcast/web/"

# Shipped defaults (demo preset — optional, app falls back to empty preset if absent)
mkdir -p "$DEB_STAGE/opt/dabcast/defaults"
if [ -f "$ROOT_DIR/data/presets/demo.json" ]; then
  cp "$ROOT_DIR/data/presets/demo.json" "$DEB_STAGE/opt/dabcast/defaults/demo.json"
else
  echo "WARNING: data/presets/demo.json not found — package will ship without demo preset (app will start with empty preset)"
fi

# Shipped MOT logos (service logos bundled with the demo preset)
# Copy only regular files (skip FIFOs created at runtime by odr-padenc)
if [ -d "$ROOT_DIR/data/mot" ]; then
  while IFS= read -r f; do
    rel="${f#$ROOT_DIR/data/}"
    dest="$DEB_STAGE/opt/dabcast/defaults/$rel"
    mkdir -p "$(dirname "$dest")"
    cp "$f" "$dest"
  done < <(find "$ROOT_DIR/data/mot" -type f)
fi

# Systemd service
mkdir -p "$DEB_STAGE/lib/systemd/system"
cp "$SCRIPT_DIR/dabcast.service" "$DEB_STAGE/lib/systemd/system/dabcast.service"

# /etc/default/dabcast — machine-specific overrides (dablin GUI, port, data dir)
mkdir -p "$DEB_STAGE/etc/default"
cp "$SCRIPT_DIR/debian/dabcast.default" "$DEB_STAGE/etc/default/dabcast"

# Empty data directories (created by postinst, but structure documented here)
mkdir -p "$DEB_STAGE/var/lib/dabcast"

# Build the .deb
DEB_FILE="$DIST_DIR/${DEB_NAME}.deb"
dpkg-deb --build --root-owner-group "$DEB_STAGE" "$DEB_FILE"

# ── Done ──────────────────────────────────────────────────────────────────────
DEB_SIZE=$(du -sh "$DEB_FILE" | cut -f1)
echo ""
echo "Done! Package: $DEB_FILE ($DEB_SIZE)"
echo ""
echo "Install with:"
echo "  sudo dpkg -i $DEB_FILE"
echo "  sudo systemctl status dabcast"
