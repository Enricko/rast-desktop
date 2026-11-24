#!/usr/bin/env bash
# install-xpra-client.sh — fetch, verify and mount the OFFICIAL Xpra macOS client.
#
# RAST Desktop runs the official Xpra client as a managed subprocess and does
# NOT redistribute it (Xpra is GPLv2+; see docs/LICENSING.md). This script is
# what CI uses to obtain the unmodified upstream build from xpra.org:
#
#   1. download the per-architecture .dmg published at xpra.org/stable/MacOS/,
#   2. verify the SHA-1 published next to it (integrity only: xpra.org does not
#      publish a usable signing key for CI; the checksum is fetched from the
#      same origin and is therefore not a supply-chain guarantee),
#   3. mount it read-only with hdiutil,
#   4. resolve the bundle executable from Info.plist (CFBundleExecutable),
#   5. run `--version` and require an "xpra v..." answer.
#
# Usage:
#   scripts/macos/install-xpra-client.sh --arch arm64|x86_64 [--dest DIR]
#
# Output (also written to $DEST/install-report.txt):
#   XPRA_DMG=...        downloaded disk image
#   XPRA_MOUNT=...      mount point (already attached)
#   XPRA_APP=...        path of Xpra.app inside the mounted image
#   XPRA_BINARY=...     executable to run
#   XPRA_VERSION=...    `--version` output, one line
#
# The image stays mounted on purpose (the client runs from the mounted bundle).
# Callers must detach it with `hdiutil detach "$XPRA_MOUNT"` when done.
set -euo pipefail

ARCH=""
DEST="${RUNNER_TEMP:-/tmp}/xpra-client"
while [ "$#" -gt 0 ]; do
    case "$1" in
        --arch) ARCH="${2:-}"; shift 2 ;;
        --dest) DEST="${2:-}"; shift 2 ;;
        -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
        *) echo "install-xpra-client.sh: unknown argument: $1" >&2; exit 2 ;;
    esac
done

# Versions pinned deliberately: CI must be reproducible and the evidence must
# name the exact build that ran. Bump together with docs/PHASE1-MACOS.md.
XPRA_VERSION_TAG="7.0-r0"
case "$ARCH" in
    arm64)
        DMG_URL="https://xpra.org/stable/MacOS/arm64/Xpra-arm64-${XPRA_VERSION_TAG}.dmg"
        DMG_SHA1="01161232928ff2e724ef8ea402d9029c399218bf"
        ;;
    x86_64)
        DMG_URL="https://xpra.org/stable/MacOS/x86_64/Xpra-x86_64-${XPRA_VERSION_TAG}.dmg"
        DMG_SHA1="3999aed9965dc2422d3c983a70dd8439e033fc52"
        ;;
    *)
        echo "install-xpra-client.sh: --arch must be arm64 or x86_64 (got '${ARCH}')" >&2
        exit 2
        ;;
esac

mkdir -p "$DEST"
REPORT="$DEST/install-report.txt"
DMG="$DEST/Xpra-$ARCH.dmg"
MOUNT="$DEST/mnt"

sha1_of() { shasum -a 1 "$1" | awk '{print $1}'; }

echo "install-xpra-client: arch=$ARCH version=$XPRA_VERSION_TAG"
echo "install-xpra-client: url=$DMG_URL"
echo "install-xpra-client: expected_sha1=$DMG_SHA1"

if [ -f "$DMG" ] && [ "$(sha1_of "$DMG")" = "$DMG_SHA1" ]; then
    echo "install-xpra-client: reusing cached $DMG ($(stat -f%z "$DMG") bytes, SHA-1 verified)"
else
    rm -f "$DMG"
    for attempt in 1 2 3; do
        echo "install-xpra-client: download attempt $attempt"
        if curl -fL --retry 2 --retry-delay 3 --retry-all-errors -m 600 \
                -o "$DMG.part" "$DMG_URL" \
                -w 'download: http=%{http_code} bytes=%{size_download} speed=%{speed_download}B/s total=%{time_total}s\n'; then
            mv "$DMG.part" "$DMG"
            break
        fi
        sleep 3
    done
    if [ ! -f "$DMG" ]; then
        echo "install-xpra-client: download failed" >&2
        exit 1
    fi
fi

ACTUAL="$(sha1_of "$DMG")"
echo "install-xpra-client: actual_sha1=$ACTUAL"
if [ "$ACTUAL" != "$DMG_SHA1" ]; then
    echo "install-xpra-client: SHA-1 mismatch for $DMG" >&2
    exit 1
fi
echo "install-xpra-client: SHA-1 OK ($(stat -f%z "$DMG") bytes)"

mkdir -p "$MOUNT"
if hdiutil info | grep -q "mount-point: *$MOUNT\$"; then
    echo "install-xpra-client: $MOUNT already mounted, reusing"
else
    hdiutil detach "$MOUNT" -force >/dev/null 2>&1 || true
    echo "install-xpra-client: attaching $DMG"
    hdiutil attach -nobrowse -readonly -noautoopen -mountpoint "$MOUNT" "$DMG" | tee "$DEST/hdiutil-attach.log"
fi

# Only search the volume root: the image contains a non-listable .Trashes
# directory, so recursing from the mount point makes `find` fail.
APP="$(find "$MOUNT" -maxdepth 1 -name '*.app' -print 2>/dev/null | head -n 1 || true)"
if [ -z "$APP" ]; then
    echo "install-xpra-client: no .app bundle found in $DMG" >&2
    exit 1
fi
PLIST="$APP/Contents/Info.plist"
BUNDLE_EXE="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$PLIST" 2>/dev/null || true)"
BIN="$APP/Contents/MacOS/${BUNDLE_EXE:-Xpra}"
if [ ! -x "$BIN" ]; then
    BIN="$(find "$APP/Contents/MacOS" -maxdepth 1 -type f -perm -111 -iname '*xpra*' 2>/dev/null | head -n 1 || true)"
fi
if [ -z "${BIN:-}" ] || [ ! -x "$BIN" ]; then
    echo "install-xpra-client: no runnable Xpra executable in $APP" >&2
    exit 1
fi

# 60 s is plenty; the very first start initialises the bundled Python runtime.
VERSION_LINE="$(python3 - "$BIN" <<'PY'
import subprocess, sys
try:
    r = subprocess.run([sys.argv[1], "--version"], timeout=60, capture_output=True, text=True,
                       stdin=subprocess.DEVNULL)
except subprocess.TimeoutExpired:
    print("TIMEOUT"); sys.exit(124)
out = (r.stdout or "").strip()
print(out.splitlines()[0] if out else f"rc={r.returncode}")
sys.exit(r.returncode)
PY
)" || true

{
    echo "XPRA_DMG=$DMG"
    echo "XPRA_MOUNT=$MOUNT"
    echo "XPRA_APP=$APP"
    echo "XPRA_BINARY=$BIN"
    echo "XPRA_VERSION=$VERSION_LINE"
} | tee "$REPORT"
echo "install-xpra-client: bundle identifier $(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$PLIST" 2>/dev/null || echo '?')"

case "$VERSION_LINE" in
    xpra\ v*|Xpra\ v*|v[0-9]*) ;;
    *) echo "install-xpra-client: unexpected --version output: '$VERSION_LINE'" >&2; exit 1 ;;
esac
echo "install-xpra-client: OK"
