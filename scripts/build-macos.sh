#!/usr/bin/env bash
# build-macos.sh — build the unsigned/ad-hoc-universal RAST Desktop .dmg on macOS.
#
# This is the local/CI entry point for the packaging job. It builds the Tauri 2
# application in `desktop/` for BOTH Apple Silicon and Intel into one universal
# `.app`, bundles a `.dmg`, and prints verifiable facts about the result
# (architectures, code signature, Gatekeeper assessment, SHA-256).
#
# It must run on macOS (a real Mac or a GitHub Actions `macos-15` /
# `macos-15-intel` runner); the DMG cannot be produced on Linux.
#
# HONEST SIGNING REALITY (see docs/MACOS-BUILD.md and docs/PACKAGING.md):
#   * this repository has NO Apple Developer ID certificate and NO notarization
#     credentials, so the produced app is ad-hoc signed (or unsigned) and is NOT
#     notarized. Gatekeeper will refuse it on another Mac until the user
#     explicitly allows it. Nothing here claims otherwise.
#   * if a Developer ID identity and Apple credentials are ever configured, Tauri
#     picks them up via APPLE_SIGNING_IDENTITY / APPLE_ID / APPLE_PASSWORD /
#     APPLE_TEAM_ID and the script then reports the real signature.
#
# Usage:
#   scripts/build-macos.sh [--output-dir DIR]
#
# Environment:
#   RAST_SKIP_NPM_INSTALL=1   reuse an existing desktop/node_modules
#   TAURI_TARGET              override target triple (default: universal-apple-darwin)
#
# Exit codes: 0 built / 2 not macOS / 3 missing toolchain / 4 prerequisite missing
#             / 5 build failed / 6 no DMG produced
set -euo pipefail

OUTPUT_DIR="${PWD}/dist"
TARGET="${TAURI_TARGET:-universal-apple-darwin}"
while [ "$#" -gt 0 ]; do
    case "$1" in
        --output-dir) OUTPUT_DIR="${2:-dist}"; shift 2 ;;
        -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
        *) echo "build-macos.sh: unknown argument: $1" >&2; exit 2 ;;
    esac
done

if [ "$(uname -s)" != "Darwin" ]; then
    echo "::error::build-macos.sh must run on macOS (current: $(uname -s)); the .dmg cannot be built on Linux" >&2
    exit 2
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DESKTOP="$ROOT/desktop"
TAURI_DIR="$DESKTOP/src-tauri"
mkdir -p "$OUTPUT_DIR"

step() { echo; echo "===== $* ====="; }

step "environment"
{
    echo "macOS:      $(sw_vers -productVersion 2>/dev/null) ($(sw_vers -buildVersion 2>/dev/null))"
    echo "arch:       $(uname -m)"
    echo "xcode:      $(xcodebuild -version 2>/dev/null | tr '\n' ' ' || echo MISSING)"
    echo "rustc:      $(rustc --version 2>&1 || echo MISSING)"
    echo "cargo:      $(cargo --version 2>&1 || echo MISSING)"
    echo "node:       $(node --version 2>&1 || echo MISSING)"
    echo "npm:        $(npm --version 2>&1 || echo MISSING)"
    echo "target:     $TARGET"
} | tee "$OUTPUT_DIR/build-environment.txt" | sed 's/^/  /'

if ! command -v rustc >/dev/null 2>&1 || ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
    echo "::error::missing Rust or Node toolchain" >&2
    exit 3
fi
if [ ! -f "$TAURI_DIR/Cargo.toml" ]; then
    echo "::error::desktop/src-tauri/Cargo.toml is missing — the Tauri core has not landed on this ref yet" >&2
    exit 4
fi
if [ ! -f "$DESKTOP/package.json" ]; then
    echo "::error::desktop/package.json is missing" >&2
    exit 4
fi

step "Rust targets"
case "$TARGET" in
    universal-apple-darwin) RUST_TARGETS=(aarch64-apple-darwin x86_64-apple-darwin) ;;
    *) RUST_TARGETS=("$TARGET") ;;
esac
for t in "${RUST_TARGETS[@]}"; do
    if rustup target list --installed 2>/dev/null | grep -qx "$t"; then
        echo "  $t: installed"
    else
        echo "  $t: adding via rustup"
        rustup target add "$t"
    fi
done

step "frontend build (desktop/ui)"
if [ -f "$DESKTOP/package.json" ] && grep -q '"build:ui"' "$DESKTOP/package.json"; then
    if [ "${RAST_SKIP_NPM_INSTALL:-0}" != "1" ]; then
        ( cd "$DESKTOP" && npm install --no-audit --no-fund 2>&1 | tee "$OUTPUT_DIR/npm-install.log" | tail -20 )
    fi
    ( cd "$DESKTOP" && npm run build:ui 2>&1 | tee "$OUTPUT_DIR/ui-build.log" | tail -40 )
    if [ -d "$DESKTOP/ui/dist" ]; then
        echo "ui/dist: $(find "$DESKTOP/ui/dist" -type f | wc -l | tr -d ' ') files, $(du -sh "$DESKTOP/ui/dist" | awk '{print $1}')"
    else
        echo "::warning::desktop/ui/dist was not produced; the Tauri bundle may fail or embed an empty UI"
    fi
else
    echo "::warning::desktop/package.json has no build:ui script; skipping the UI build"
fi

step "Tauri universal build"
BUILD_START=$(date +%s)
set +e
( cd "$DESKTOP" && npm run build -- --target "$TARGET" ) 2>&1 | tee "$OUTPUT_DIR/tauri-build.log" | tail -60
BUILD_RC=${PIPESTATUS[0]}
set -e
BUILD_END=$(date +%s)
echo "tauri build rc=$BUILD_RC after $(( BUILD_END - BUILD_START )) s"
if [ "$BUILD_RC" -ne 0 ]; then
    echo "::error::tauri build failed (rc=$BUILD_RC) — see the tauri-build.log artifact"
    exit 5
fi

step "locate bundles"
BUNDLE_BASE="$TAURI_DIR/target/$TARGET/release/bundle"
DMG="$(find "$BUNDLE_BASE/dmg" -maxdepth 1 -name '*.dmg' -print 2>/dev/null | head -n 1 || true)"
APP="$(find "$BUNDLE_BASE/macos" -maxdepth 1 -name '*.app' -print 2>/dev/null | head -n 1 || true)"
if [ -z "$DMG" ] || [ ! -f "$DMG" ]; then
    echo "::error::tauri build succeeded but no .dmg was produced under $BUNDLE_BASE/dmg" >&2
    find "$TAURI_DIR/target" -maxdepth 6 -name '*.dmg' -print 2>/dev/null | head -5 >&2 || true
    exit 6
fi

step "verify the produced app / dmg"
{
    echo "dmg: $DMG"
    echo "dmg_size_bytes: $(stat -f%z "$DMG")"
    echo "dmg_sha256: $(shasum -a 256 "$DMG" | awk '{print $1}')"
    if [ -n "$APP" ]; then
        echo "app: $APP"
        echo "app_size_bytes: $(du -sk "$APP" | awk '{print $1 * 1024}')"
        echo "--- lipo -info (universal?) ---"
        lipo -info "$APP/Contents/MacOS/"* 2>&1 || true
        echo "--- codesign -dv (signature reality) ---"
        codesign -dv --verbose=4 "$APP" 2>&1 || true
        echo "--- codesign --verify --deep --strict ---"
        if codesign --verify --deep --strict "$APP" 2>&1; then
            echo "codesign_verify: OK"
        else
            echo "codesign_verify: FAILED"
        fi
        echo "--- spctl (Gatekeeper assessment) ---"
        if spctl -a -vvv -t exec "$APP" 2>&1; then
            echo "spctl: accepted"
        else
            echo "spctl: rejected (expected for an ad-hoc/unsigned build without notarization)"
        fi
    else
        echo "app: not found (only the dmg was produced)"
    fi
} | tee "$OUTPUT_DIR/bundle-verification.txt"

# copy the deliverables into a stable output directory
cp -f "$DMG" "$OUTPUT_DIR/" 2>/dev/null || true
if [ -n "$APP" ] && [ -d "$APP" ]; then
    cp -R "$APP" "$OUTPUT_DIR/" 2>/dev/null || true
fi
( cd "$OUTPUT_DIR" && ls -1 *.dmg 2>/dev/null | while read -r f; do shasum -a 256 "$f"; done > SHA256SUMS-dmg.txt )
echo
echo "deliverables in $OUTPUT_DIR:"
ls -la "$OUTPUT_DIR" | sed 's/^/  /'

step "Gatekeeper note"
cat <<'EOM'
This build is NOT notarized and has no Developer ID signature (no Apple
certificate exists for this project). On another Mac, Gatekeeper blocks it on
first launch until the user explicitly allows it:

  xattr -dr com.apple.quarantine <path>/RAST Desktop.app   # remove quarantine
  # or: System Settings > Privacy & Security > "Open Anyway"

Verify what this exact build is before shipping it anywhere:
  codesign -dv --verbose=4 "<path>/RAST Desktop.app"
  spctl -a -vvv -t exec "<path>/RAST Desktop.app"
See docs/MACOS-BUILD.md and docs/PACKAGING.md.
EOM
echo "build-macos.sh: OK"
