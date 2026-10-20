#!/usr/bin/env bash
#
# Build Puter Proxy.app.
#
# Produces a self-contained bundle: Swift executable, the Node server with its
# dependencies, a Tor binary, and the UI. Swift is compiled directly with
# swiftc because building an Xcode project would require full Xcode; the
# Command Line Tools SDK is enough for an AppKit + WebKit app.
#
# Usage:
#   ./macapp/build.sh              # build to macapp/dist/Puter Proxy.app
#   ./macapp/build.sh --open       # build and launch
#   ./macapp/build.sh --no-runtime # skip Node/Tor copying (fast UI iteration)

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
DIST="$HERE/dist"
APP="$DIST/Puter Proxy.app"
NAME="PuterProxy"
BUNDLE_ID="com.ashton.puterproxy"
VERSION="1.0.0"

OPEN_AFTER=0
WITH_RUNTIME=1
for arg in "$@"; do
  case "$arg" in
    --open) OPEN_AFTER=1 ;;
    --no-runtime) WITH_RUNTIME=0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

echo "==> Cleaning"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/runtime" "$DIST"

# ---------------------------------------------------------------- compile
echo "==> Compiling Swift"
# main.swift must come first and must be so named: Swift only allows top-level
# expressions in that file, and treats every other file as a library.
SWIFT_SRC=(
  "$HERE/Sources/main.swift"
  "$HERE/Sources/App.swift"
  "$HERE/Sources/Supervisor.swift"
  "$HERE/Sources/Autopilot.swift"
  "$HERE/Sources/Config.swift"
)

# Ad-hoc signing keeps Gatekeeper quiet on the build machine. Distribution to
# another Mac requires a Developer ID signature and notarisation.
swiftc \
  -O \
  -target arm64-apple-macosx13.0 \
  -framework AppKit \
  -framework WebKit \
  -framework CryptoKit \
  -o "$APP/Contents/MacOS/$NAME" \
  "${SWIFT_SRC[@]}"

echo "    binary: $(du -h "$APP/Contents/MacOS/$NAME" | cut -f1)"

# ---------------------------------------------------------------- Info.plist
echo "==> Writing Info.plist"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Puter Proxy</string>
  <key>CFBundleDisplayName</key><string>Puter Proxy</string>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleExecutable</key><string>$NAME</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
  <!-- Loopback only: the app talks to its own server. No inbound exposure. -->
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key><true/>
  </dict>
</dict>
</plist>
PLIST

# ---------------------------------------------------------------- UI
echo "==> Copying UI"
cp "$HERE/Sources/ui/index.html" "$APP/Contents/Resources/index.html"

# The supervisor shim lives beside the executable so it is always found.
cp "$HERE/Sources/launcher.js" "$APP/Contents/MacOS/launcher.js"

# ---------------------------------------------------------------- runtime
if [ "$WITH_RUNTIME" -eq 1 ]; then
  echo "==> Bundling Node runtime"
  NODE_BIN=""
  for c in /Users/ashtonphillips/.workbuddy-ai/binaries/node/versions/22.22.2-6/bin/node \
           "$(command -v node 2>/dev/null || true)"; do
    if [ -n "$c" ] && [ -x "$c" ]; then NODE_BIN="$c"; break; fi
  done
  if [ -z "$NODE_BIN" ]; then
    echo "    ERROR: no node binary found; install Node 20+ or pass --no-runtime" >&2
    exit 1
  fi
  cp "$NODE_BIN" "$APP/Contents/Resources/runtime/node"
  chmod +x "$APP/Contents/Resources/runtime/node"
  echo "    node: $("$APP/Contents/Resources/runtime/node" --version)"

  echo "==> Bundling Node server"
  SERVER="$APP/Contents/Resources/server"
  mkdir -p "$SERVER"
  cp -R "$ROOT/src" "$SERVER/src"
  cp "$ROOT/package.json" "$SERVER/package.json"
  cp "$ROOT/package-lock.json" "$SERVER/package-lock.json" 2>/dev/null || true

  # Production dependencies only. npm's devDependencies are absent from the
  # published package anyway, but --omit=dev keeps the bundle honest.
  echo "    installing production dependencies"
  ( cd "$SERVER" && npm install --omit=dev --no-audit --no-fund --silent )

  echo "==> Bundling Tor"
  TOR_CANDIDATES=(
    "/Applications/Tor Browser.app/Contents/MacOS/Tor/tor"
    "/opt/homebrew/bin/tor"
    "/usr/local/bin/tor"
  )
  TOR_SRC=""
  for c in "${TOR_CANDIDATES[@]}"; do
    if [ -x "$c" ]; then TOR_SRC="$c"; break; fi
  done
  if [ -n "$TOR_SRC" ]; then
    cp "$TOR_SRC" "$APP/Contents/Resources/runtime/tor"
    chmod +x "$APP/Contents/Resources/runtime/tor"
    # Tor Browser's build links libevent with @executable_path, so the dylib
    # must travel with it or the binary fails at launch with a dyld error.
    TOR_DIR="$(dirname "$TOR_SRC")"
    if [ -f "$TOR_DIR/libevent-2.1.7.dylib" ]; then
      cp "$TOR_DIR/libevent-2.1.7.dylib" "$APP/Contents/Resources/runtime/"
    fi
    echo "    tor: $("$APP/Contents/Resources/runtime/tor" --version 2>/dev/null | head -1)"
  else
    echo "    WARNING: no tor binary found; the app will fall back to a system tor"
  fi
else
  echo "==> Skipping runtime bundling (--no-runtime)"
fi

# ---------------------------------------------------------------- sign
echo "==> Signing (ad-hoc)"
codesign --force --deep --sign - "$APP" 2>&1 | sed 's/^/    /' || {
  echo "    WARNING: ad-hoc signing failed; the app may still run locally" >&2
}

echo ""
echo "Built: $APP"
echo "Size:  $(du -sh "$APP" | cut -f1)"
echo ""
echo "Run it:  open \"$APP\""

if [ "$OPEN_AFTER" -eq 1 ]; then
  open "$APP"
fi
