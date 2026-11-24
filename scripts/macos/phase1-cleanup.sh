#!/usr/bin/env bash
# phase1-cleanup.sh — safety net for the native-poc workflow.
#
# The verification script closes what it started in its own EXIT trap, but a
# cancelled/timed-out job skips that trap. This script runs with `if: always()`
# and makes sure the t-alice session is left exactly as it was found:
#   * if measurements.txt recorded a run THIS workflow started and it is still
#     running, close that run (never the whole session, never another user);
#   * revoke outstanding stream tokens issued during the test;
#   * log out the test session;
#   * detach the mounted Xpra .dmg.
#
# It never closes the native session itself: pre-existing apps (e.g. the XTerm
# from a previous test) are the user's state, not ours.
set -uo pipefail
umask 077

EVIDENCE_DIR="${EVIDENCE_DIR:-evidence/phase1}"
while [ "$#" -gt 0 ]; do
    case "$1" in
        --evidence-dir) EVIDENCE_DIR="${2:-evidence/phase1}"; shift 2 ;;
        *) echo "phase1-cleanup.sh: unknown argument: $1" >&2; exit 2 ;;
    esac
done
RAST_URL="${RAST_URL:-}"
RAST_USER="${RAST_USER:-}"
RAST_PASSWORD="${RAST_PASSWORD:-}"

echo "cleanup: evidence dir $EVIDENCE_DIR"
MEAS="$EVIDENCE_DIR/measurements.txt"
run_value() { grep -m1 "^$1=" "$MEAS" 2>/dev/null | cut -d= -f2-; }
RUN_ID="$(run_value run_id)"
CREATED="$(run_value run_created_by_us)"
echo "cleanup: launched_run_id=${RUN_ID:-<none>} created_by_workflow=${CREATED:-<unknown>}"

if [ -n "$RUN_ID" ] && [ "$CREATED" = "1" ] && [ -n "$RAST_URL" ] && [ -n "$RAST_USER" ] && [ -n "$RAST_PASSWORD" ]; then
    JAR="$(mktemp "${RUNNER_TEMP:-/tmp}/rast-cleanup-cookies.XXXXXX")"
    LOGIN_HTTP=$(curl -sS -m 60 -c "$JAR" -H 'Content-Type: application/json' -H 'X-RAST-Desktop: 1' \
        -d "$(jq -nc --arg u "$RAST_USER" --arg p "$RAST_PASSWORD" '{username:$u,password:$p}')" \
        -o /dev/null -w '%{http_code}' "$RAST_URL/api/auth/login" 2>/dev/null || echo 000)
    echo "cleanup: login http=$LOGIN_HTTP"
    if [ "$LOGIN_HTTP" = "200" ]; then
        CSRF=$(curl -sS -m 30 -b "$JAR" -H 'X-RAST-Desktop: 1' "$RAST_URL/api/auth/me" 2>/dev/null | jq -r '.csrfToken // empty')
        STATE=$(curl -sS -m 60 -b "$JAR" -H 'X-RAST-Desktop: 1' "$RAST_URL/api/linux-apps/session" 2>/dev/null |
            jq -r --arg r "$RUN_ID" '.session.apps[]? | select(.runId == $r) | .status' 2>/dev/null)
        echo "cleanup: run status on server: '${STATE:-<not found>}'"
        if [ -n "$STATE" ] && [ "$STATE" != "exited" ]; then
            CODE=$(curl -sS -m 60 -b "$JAR" -H "X-CSRF-Token: $CSRF" -H 'X-RAST-Desktop: 1' \
                -H 'Content-Type: application/json' -d '{}' -o /dev/null -w '%{http_code}' \
                "$RAST_URL/api/linux-apps/session/runs/$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1]))' "$RUN_ID")/close" 2>/dev/null || echo 000)
            echo "cleanup: close run http=$CODE"
        else
            echo "cleanup: run already stopped, nothing to close"
        fi
        curl -sS -m 30 -X DELETE -b "$JAR" -H "X-CSRF-Token: $CSRF" -H 'X-RAST-Desktop: 1' \
            -o /dev/null -w 'cleanup: revoke tokens http=%{http_code}\n' \
            "$RAST_URL/api/linux-apps/session/stream-tokens" 2>/dev/null || true
        curl -sS -m 30 -b "$JAR" -H "X-CSRF-Token: $CSRF" -H 'X-RAST-Desktop: 1' \
            -H 'Content-Type: application/json' -d '{}' -o /dev/null -w 'cleanup: logout http=%{http_code}\n' \
            "$RAST_URL/api/auth/logout" 2>/dev/null || true
    fi
    rm -f "$JAR"
else
    echo "cleanup: no workflow-started run recorded — leaving the session untouched"
fi

# Detach the official Xpra client image if this job mounted it.
DEST="${RUNNER_TEMP:-/tmp}/xpra-client"
if [ -f "$DEST/install-report.txt" ]; then
    MOUNT=$(grep -m1 '^XPRA_MOUNT=' "$DEST/install-report.txt" | cut -d= -f2-)
    if [ -n "${MOUNT:-}" ] && hdiutil info | grep -q "mount-point: *$MOUNT\$"; then
        hdiutil detach "$MOUNT" -force >/dev/null 2>&1 || true
        echo "cleanup: detached $MOUNT"
    fi
fi
echo "cleanup: done"
