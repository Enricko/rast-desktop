#!/usr/bin/env bash
# phase1-native-verify.sh — Phase 1 verification of the OFFICIAL native Xpra
# client on macOS, against the live RAST server.
#
# Two attach paths are supported:
#
#   broker  — production design (Phase 3): POST /api/linux-apps/session/stream-token
#             returns a single-use wss:// URL; the token in the URL is the
#             credential. No browser headers are needed. Requires a server that
#             advertises bootstrap.desktop.streamTokens=true; until the RAST
#             update is deployed the endpoint answers 404 and this script reports
#             exactly that ("server does not support desktop.streamTokens yet").
#
#   relay   — Phase 1 PoC fallback (works on today's 0.18.3 server): attach through
#             the EXISTING authenticated HTML5 relay `/linux-apps/session/<key>/`.
#             That relay validates a same-origin `Origin` header and a real RAST
#             login cookie on every WebSocket upgrade, so the official client is
#             started with:
#                 XPRA_WEBSOCKET_HEADERS_MODULES=default,origin,env_cookie
#                 XPRA_WEBSOCKET_ORIGIN=<server origin>
#                 XPRA_WS_COOKIE=rast_session=<cookie value>
#             (Xpra 7.0 has built-in support for these; the 6.x client needs the
#             Poc sitecustomize shim from poc/xpra_ws_headers/ instead.)
#
# BOTH paths require XPRA_WEBSOCKET_MASK=1: the official client defaults to
# unmasked WebSocket frames, which RFC 6455 / tokio-tungstenite (our relay)
# correctly rejects. See docs/PROTOCOL.md §5.
#
# The script NEVER prints or uploads the login cookie, the CSRF token, the
# stream token or the full ws(s) URL: secrets live in $SECRET_DIR (outside the
# evidence directory) and are redacted from every evidence file on exit.
#
# Environment (passed by .github/workflows/native-poc.yml):
#   RAST_URL              https://desktop.lufria.tech
#   RAST_USER             ordinary test user (t-alice)
#   RAST_PASSWORD         its password
#   RAST_ADMIN_USER       optional admin account, used to read the server audit log
#   RAST_ADMIN_PASSWORD
#   XPRA_BIN              /path/to/Xpra.app/Contents/MacOS/Xpra
#   EVIDENCE_DIR          where evidence is written (default: evidence/phase1)
#   HTML5_JSON            optional extra JSON file merged into summary.json
#
# Usage: phase1-native-verify.sh [--mode auto|broker|relay] [--app NAME]
#
# Exit codes: 0 verified / 10 login failed / 20 no usable attach path
#             30 attach failed / 40 attach ok but no window observed
set -uo pipefail
umask 077

MODE="auto"
APP_PREF=""
EVIDENCE_DIR="${EVIDENCE_DIR:-evidence/phase1}"
while [ "$#" -gt 0 ]; do
    case "$1" in
        --mode) MODE="${2:-auto}"; shift 2 ;;
        --app) APP_PREF="${2:-}"; shift 2 ;;
        --evidence-dir) EVIDENCE_DIR="${2:-}"; shift 2 ;;
        *) echo "phase1-native-verify.sh: unknown argument: $1" >&2; exit 2 ;;
    esac
done

RAST_URL="${RAST_URL:-}"
RAST_USER="${RAST_USER:-}"
RAST_PASSWORD="${RAST_PASSWORD:-}"
RAST_ADMIN_USER="${RAST_ADMIN_USER:-}"
RAST_ADMIN_PASSWORD="${RAST_ADMIN_PASSWORD:-}"
XPRA_BIN="${XPRA_BIN:-}"

mkdir -p "$EVIDENCE_DIR/api" "$EVIDENCE_DIR/tools"
EVIDENCE_DIR="$(cd "$EVIDENCE_DIR" && pwd)"
SECRET_DIR="$(mktemp -d "${RUNNER_TEMP:-/tmp}/rast-phase1-secrets.XXXXXX")"
JAR="$SECRET_DIR/cookies.txt"
ADMIN_JAR="$SECRET_DIR/admin-cookies.txt"
STREAM_JSON="$SECRET_DIR/stream-token.json"
MEASURE="$EVIDENCE_DIR/measurements.txt"
STATE="$EVIDENCE_DIR/state.txt"
: > "$MEASURE"
: > "$STATE"
STATE_SET() { printf '%s=%s\n' "$1" "${2:-}" >> "$STATE"; }
REC() { printf '%s=%s\n' "$1" "${2:-}" >> "$MEASURE"; }
stage() { echo; echo "===== $* ====="; }
warn() { echo "::warning::$*"; echo "WARNING: $*" >> "$EVIDENCE_DIR/warnings.txt"; }
fail_stage() { echo "::error::$*"; echo "STAGE_FAILURE: $*" >> "$EVIDENCE_DIR/failures.txt"; }

CSRF=""
STREAM_TOKEN=""
WS_URL=""
COOKIE_VALUE=""
RUN_ID=""
RUN_CREATED_BY_US=0
SESSION_KEY=""
XPRA_PID=""
STATUS="unknown"

now_ms() { python3 -c 'import time; print(int(time.time() * 1000))'; }

redact_evidence() {
    local f token url cookie csrf
    token="${STREAM_TOKEN:-}"
    url="${WS_URL:-}"
    cookie="${COOKIE_VALUE:-}"
    csrf="${CSRF:-}"
    find "$EVIDENCE_DIR" -type f ! -name '*.png' ! -name '*.jpg' -print0 2>/dev/null |
    while IFS= read -r -d '' f; do
        if [ -n "$token" ]; then sed -i '' "s#${token}#<REDACTED_STREAM_TOKEN>#g" "$f" 2>/dev/null || true; fi
        if [ -n "$url" ]; then sed -i '' "s#${url}#<REDACTED_STREAM_URL>#g" "$f" 2>/dev/null || true; fi
        if [ -n "$cookie" ]; then sed -i '' "s#${cookie}#<REDACTED_COOKIE>#g" "$f" 2>/dev/null || true; fi
        if [ -n "$csrf" ]; then sed -i '' "s#${csrf}#<REDACTED_CSRF>#g" "$f" 2>/dev/null || true; fi
    done
    rm -f "$JAR" "$ADMIN_JAR" "$STREAM_JSON" 2>/dev/null || true
    # keep the secrets directory itself empty
    rmdir "$SECRET_DIR" 2>/dev/null || true
}

build_summary() {
    local rc="$1"
    export RAST_URL RAST_USER MODE STATUS rc
    export EVIDENCE_DIR
    python3 - "$EVIDENCE_DIR" "$rc" <<'PY' > "$EVIDENCE_DIR/summary.log" 2>&1
import json, os, pathlib, sys, time

ev = pathlib.Path(sys.argv[1])
rc = int(sys.argv[2])

def read_json(name, default=None):
    p = ev / name
    try:
        return json.loads(p.read_text())
    except Exception:
        return default

def read_text(name):
    try:
        return (ev / name).read_text(errors="replace")
    except Exception:
        return ""

measure = {}
for line in read_text("measurements.txt").splitlines():
    if "=" in line:
        k, v = line.split("=", 1)
        measure[k.strip()] = v.strip()

def num(k):
    try:
        return int(measure[k])
    except Exception:
        return None

def contains_any(text, needles):
    low = text.lower()
    return [n for n in needles if n.lower() in low]

attach_logs = sorted(ev.glob("xpra-attach-*.log"))
attach_info = []
for p in attach_logs:
    txt = p.read_text(errors="replace")
    attach_info.append({
        "log": p.name,
        "bytes": len(txt),
        "attach_evidence": contains_any(txt, [
            "attached to", "connection established", "server version",
            "handshake", "hello", "connected to", "xpra server",
        ]),
        "client_errors": [ln for ln in txt.splitlines() if ln.lower().find("error") >= 0][:20],
        "last_lines": txt.splitlines()[-25:],
    })

window_files = {}
for p in sorted(ev.glob("windows-*.txt")):
    lines = p.read_text(errors="replace").splitlines()
    window_files[p.name] = {
        "total": len(lines),
        "layer0": sum(1 for ln in lines if "layer=0" in ln),
        "xpra_owned": sum(1 for ln in lines if "owner=Xpra" in ln or "owner=xpra" in ln),
        "sample": [ln for ln in lines if "layer=0" in ln][:20],
    }

screens = []
for p in sorted(ev.glob("screenshot-*.png")):
    screens.append({"file": p.name, "bytes": p.stat().st_size})

api = {}
for name in ["bootstrap.json", "login-summary.json", "me-summary.json", "inventory.json",
             "session-before.json", "discovered.json", "launch.json",
             "session-after-launch.json", "session-after-attach.json",
             "session-after-attach-2.json", "stream-token-summary.json",
             "server-logs.json", "attach-help-summary.json"]:
    api[name] = read_json("api/" + name)

xpra_version = read_text("xpra-version.log").strip().splitlines()
xpra_version = next((ln for ln in xpra_version if ln.lower().startswith("xpra")), measure.get("xpra_version", ""))

html5 = read_json("html5/html5.json") or read_json("html5-summary.json")

warnings = [ln for ln in read_text("warnings.txt").splitlines() if ln.strip()]
failures = [ln for ln in read_text("failures.txt").splitlines() if ln.strip()]

blockers = []
status = measure.get("status", "unknown")
if status == "blocked_no_attach_path":
    blockers.append(measure.get("blocked_reason", "no usable attach path"))
if measure.get("broker_supported") == "0":
    blockers.append("server does not support desktop.streamTokens yet "
                    "(POST /api/linux-apps/session/stream-token returned "
                    + measure.get("broker_http", "?") + ")")

summary = {
    "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "exitCode": rc,
    "status": status,
    "attachPath": measure.get("attach_path"),
    "host": {
        "os": measure.get("host_os"),
        "arch": measure.get("host_arch"),
        "hardware": measure.get("host_hw"),
        "runner": os.environ.get("RUNNER_NAME", ""),
    },
    "xpra": {
        "version": xpra_version,
        "binary": measure.get("xpra_binary", ""),
        "flags": (measure.get("xpra_flags", "") or "").split(),
        "environment": {
            "XPRA_WEBSOCKET_MASK": "1",
            "_note": "unmasked frames are rejected by the standards-compliant relay (see PROTOCOL §5)",
        },
    },
    "server": {
        "url": os.environ.get("RAST_URL", ""),
        "bootstrap": api.get("bootstrap.json"),
        "brokerSupported": measure.get("broker_supported") == "1",
        "brokerHttpStatus": num("broker_http"),
    },
    "auth": {
        "user": measure.get("login_user"),
        "loginMs": num("login_ms"),
        "csrfPresent": measure.get("csrf_present"),
    },
    "session": {
        "key": measure.get("session_key"),
        "viewersBefore": num("viewers_before"),
        "viewersAfterAttach": num("viewers_after_attach"),
        "viewersAfterAttach2": num("viewers_after_attach2"),
    },
    "app": {
        "id": measure.get("app_id"),
        "name": measure.get("app_name"),
        "runId": measure.get("run_id"),
        "preexisting": measure.get("run_preexisting") == "1",
    },
    "attach": {
        "attempt1Ms": num("attach1_ms"),
        "attempt2Ms": num("attach2_ms"),
        "window1Ms": num("window1_ms"),
        "tokenRequestMs": num("token_ms"),
        "launchMs": num("launch_ms"),
        "client": attach_info,
        "xpraInfo": {
            "ran": measure.get("xpra_info_ran") == "1",
            "exitCode": num("xpra_info_rc"),
            "file": "xpra-info.log",
        },
    },
    "windows": {
        "newWindowsAfterAttach": num("new_windows"),
        "newNormalWindowsAfterAttach": num("new_layer0_windows"),
        "afterSecondAttach": num("new_windows_2"),
        "applescriptWindowCount": num("applescript_windows"),
        "files": window_files,
    },
    "screenshots": screens,
    "serverSide": {
        "logEntriesAfterStart": num("server_log_entries"),
        "streamActions": api.get("server-logs.json"),
    },
    "html5": html5,
    "blockers": blockers,
    "warnings": warnings,
    "failures": failures,
}

out = ev / "summary.json"
out.write_text(json.dumps(summary, indent=2, sort_keys=False) + "\n")

def fmt(v, unit=""):
    return f"{v}{unit}" if v is not None else "not measured"

md = []
md.append(f"# Phase 1 native Xpra verification — macOS ({summary['host']['arch'] or 'unknown arch'})")
md.append("")
md.append(f"- **Status: `{status}`** (exit {rc})")
md.append(f"- Attach path: `{measure.get('attach_path')}`")
md.append(f"- Server: {os.environ.get('RAST_URL','')} — RAST version "
          f"{(api.get('bootstrap.json') or {}).get('version','?')}")
md.append(f"- Host: {summary['host']['os']} / {summary['host']['arch']} / {summary['host']['hardware']}")
md.append(f"- Xpra client: **{xpra_version}** (`{summary['xpra']['binary']}`)")
md.append(f"- Test user: {measure.get('login_user')}; app: {measure.get('app_name')} "
          f"(run {measure.get('run_id')})")
md.append("")
md.append("## Attach")
md.append("")
md.append(f"| Measurement | Value |")
md.append("| --- | --- |")
md.append(f"| Attach #1 (first attach line, ms) | {fmt(num('attach1_ms'))} |")
md.append(f"| Attach #2 after reconnect (ms) | {fmt(num('attach2_ms'))} |")
md.append(f"| First new macOS window after attach (ms) | {fmt(num('window1_ms'))} |")
md.append(f"| Stream-token request (ms) | {fmt(num('token_ms'))} |")
md.append(f"| App launch request (ms) | {fmt(num('launch_ms'))} |")
md.append(f"| Server session viewers before → after | "
          f"{measure.get('viewers_before','?')} → {measure.get('viewers_after_attach','?')} |")
md.append("")
md.append("## Negotiated protocol / encodings")
md.append("")
for a in attach_info:
    md.append(f"- `{a['log']}`: {a['bytes']} bytes; attach evidence: "
              f"{', '.join(a['attach_evidence']) or 'none'}")
md.append(f"- `xpra info`: {'ran' if measure.get('xpra_info_ran')=='1' else 'not available'}"
          f" (rc {measure.get('xpra_info_rc','?')})")
md.append("")
md.append("## macOS window evidence")
md.append("")
md.append(f"- New windows observed after attach: {fmt(num('new_windows'))} "
          f"(normal layer-0: {fmt(num('new_layer0_windows'))})")
md.append(f"- AppleScript window count: {fmt(num('applescript_windows'))}")
for s in screens:
    md.append(f"- Screenshot `{s['file']}`: {s['bytes']} bytes")
md.append("")
md.append("## Server-side confirmation")
md.append("")
md.append(f"- Session viewers after attach: {measure.get('viewers_after_attach','?')}")
md.append(f"- Activity-log entries seen after start: {fmt(num('server_log_entries'))}")
md.append(f"- Matching stream/attach audit events: {len(api.get('server-logs.json') or [])}")
md.append("")
if html5:
    md.append("## HTML5 comparison (same runner, same account, same network)")
    md.append("")
    md.append("```json")
    md.append(json.dumps(html5, indent=2)[:4000])
    md.append("```")
    md.append("")
if blockers:
    md.append("## Blockers")
    md.append("")
    for b in blockers:
        md.append(f"- {b}")
    md.append("")
if warnings or failures:
    md.append("## Warnings / failures")
    md.append("")
    for w in warnings + failures:
        md.append(f"- {w}")
    md.append("")
(ev / "summary.md").write_text("\n".join(md) + "\n")
print("summary written:", out)
PY
    cat "$EVIDENCE_DIR/summary.md" 2>/dev/null | head -5 || true
}

cleanup() {
    local rc=$?
    exec 2>/dev/null
    echo "cleanup: start (script rc=$rc)" > "$EVIDENCE_DIR/cleanup.log"
    if [ -n "${XPRA_PID:-}" ] && kill -0 "$XPRA_PID" 2>/dev/null; then
        kill -TERM "$XPRA_PID" 2>/dev/null || true
        for _ in 1 2 3 4 5; do kill -0 "$XPRA_PID" 2>/dev/null || break; sleep 1; done
        kill -KILL "$XPRA_PID" 2>/dev/null || true
        echo "cleanup: killed xpra client pid $XPRA_PID" >> "$EVIDENCE_DIR/cleanup.log"
    fi
    if [ -n "${CSRF:-}" ] && [ -s "${JAR:-/nonexistent}" ]; then
        if [ "${RUN_CREATED_BY_US:-0}" = "1" ] && [ -n "${RUN_ID:-}" ]; then
            echo "cleanup: closing the run this workflow started ($RUN_ID)" >> "$EVIDENCE_DIR/cleanup.log"
            curl -sS -m 60 -b "$JAR" -H "X-CSRF-Token: $CSRF" -H 'X-RAST-Desktop: 1' \
                -H 'Content-Type: application/json' -d '{}' \
                -o /dev/null -w 'close_run_http=%{http_code}\n' \
                "$RAST_URL/api/linux-apps/session/runs/$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1]))' "$RUN_ID")/close" \
                >> "$EVIDENCE_DIR/cleanup.log" 2>&1
        else
            echo "cleanup: run was pre-existing or not created by us — not closing it" >> "$EVIDENCE_DIR/cleanup.log"
        fi
        curl -sS -m 30 -X DELETE -b "$JAR" -H "X-CSRF-Token: $CSRF" -H 'X-RAST-Desktop: 1' \
            -o /dev/null -w 'revoke_tokens_http=%{http_code}\n' \
            "$RAST_URL/api/linux-apps/session/stream-tokens" >> "$EVIDENCE_DIR/cleanup.log" 2>&1
        curl -sS -m 30 -b "$JAR" -H "X-CSRF-Token: $CSRF" -H 'X-RAST-Desktop: 1' \
            -H 'Content-Type: application/json' -d '{}' -o /dev/null -w 'logout_http=%{http_code}\n' \
            "$RAST_URL/api/auth/logout" >> "$EVIDENCE_DIR/cleanup.log" 2>&1
    fi
    if [ -n "${ADMIN_CSRF:-}" ] && [ -s "${ADMIN_JAR:-/nonexistent}" ]; then
        curl -sS -m 30 -b "$ADMIN_JAR" -H "X-CSRF-Token: $ADMIN_CSRF" -H 'X-RAST-Desktop: 1' \
            -H 'Content-Type: application/json' -d '{}' -o /dev/null -w 'admin_logout_http=%{http_code}\n' \
            "$RAST_URL/api/auth/logout" >> "$EVIDENCE_DIR/cleanup.log" 2>&1 || true
    fi
    redact_evidence
    trap - EXIT
    exit "$rc"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
stage "0. environment"
REC host_os "$(sw_vers -productVersion 2>/dev/null) ($(sw_vers -buildVersion 2>/dev/null))"
REC host_arch "$(uname -m)"
REC host_hw "$(sysctl -n hw.model 2>/dev/null), $(sysctl -n hw.ncpu 2>/dev/null) cpus, $(sysctl -n hw.memsize 2>/dev/null) bytes"
REC runner_name "${RUNNER_NAME:-}"
{
    echo "mode requested: $MODE"
    echo "rast url: ${RAST_URL}"
    echo "rast user: ${RAST_USER}"
    echo "xpra binary: ${XPRA_BIN}"
    echo "os: $(sw_vers 2>/dev/null | tr '\n' ' ')"
    echo "arch: $(uname -m)"
    echo "hardware: $(sysctl -n hw.model 2>/dev/null)"
    echo "secrets provided: RastUrl=$([ -n "$RAST_URL" ] && echo yes || echo no) User=$([ -n "$RAST_USER" ] && echo yes || echo no) Password=$([ -n "$RAST_PASSWORD" ] && echo yes || echo no) AdminUser=$([ -n "$RAST_ADMIN_USER" ] && echo yes || echo no) AdminPassword=$([ -n "$RAST_ADMIN_PASSWORD" ] && echo yes || echo no)"
} | tee "$EVIDENCE_DIR/environment.log"

if [ -z "$RAST_URL" ] || [ -z "$RAST_USER" ] || [ -z "$RAST_PASSWORD" ]; then
    fail_stage "missing RAST_URL / RAST_USER / RAST_PASSWORD (repository secrets not configured?)"
    REC status blocked_no_attach_path
    REC blocked_reason "missing repository secrets"
    build_summary 20
    exit 20
fi
if [ -z "$XPRA_BIN" ] || [ ! -x "$XPRA_BIN" ]; then
    fail_stage "XPRA_BIN is not an executable: '${XPRA_BIN}'"
    REC status blocked_no_attach_path
    REC blocked_reason "Xpra client not installed"
    build_summary 20
    exit 20
fi
REC xpra_binary "$XPRA_BIN"
REC status unknown

"$XPRA_BIN" --version > "$EVIDENCE_DIR/xpra-version.log" 2>&1 || true
"$XPRA_BIN" attach --help > "$EVIDENCE_DIR/xpra-attach-help.log" 2>&1 || true
REC xpra_version "$(grep -m 1 -i '^xpra v' "$EVIDENCE_DIR/xpra-version.log" 2>/dev/null | tr -d '\r')"
echo "xpra --version: $(cat "$EVIDENCE_DIR/xpra-version.log" 2>/dev/null | head -2 | tr '\n' ' ')"
echo "attach --help: $(wc -l < "$EVIDENCE_DIR/xpra-attach-help.log") lines"

# ---------------------------------------------------------------------------
stage "1. login via HTTPS API"
LOGIN_START=$(now_ms)
LOGIN_HTTP=$(curl -sS -m 60 -c "$JAR" -H 'Content-Type: application/json' -H 'X-RAST-Desktop: 1' \
    -d "$(jq -nc --arg u "$RAST_USER" --arg p "$RAST_PASSWORD" '{username:$u,password:$p}')" \
    -o "$SECRET_DIR/login.json" -w '%{http_code}' "$RAST_URL/api/auth/login" 2>"$EVIDENCE_DIR/api/login-curl.err" || echo 000)
REC login_ms "$(( $(now_ms) - LOGIN_START ))"
REC login_http "$LOGIN_HTTP"
echo "login: http=$LOGIN_HTTP"
if [ "$LOGIN_HTTP" != "200" ]; then
    fail_stage "login failed (http=$LOGIN_HTTP) — check repository secrets RAST_TEST_USER/RAST_TEST_PASSWORD"
    REC status blocked_no_attach_path
    REC blocked_reason "login failed http=$LOGIN_HTTP"
    build_summary 10
    exit 10
fi
CSRF="$(jq -r '.csrfToken // empty' "$SECRET_DIR/login.json")"
REC csrf_present "$([ -n "$CSRF" ] && echo yes || echo no)"
jq -c '.user | {id,username,displayName,role,superAdmin,active}' "$SECRET_DIR/login.json" > "$EVIDENCE_DIR/api/login-summary.json"
REC login_user "$(jq -r '.username // "?"' "$EVIDENCE_DIR/api/login-summary.json")"
COOKIE_VALUE="$(awk -F '\t' '$6 == "rast_session" {print $7; exit}' "$JAR" 2>/dev/null || true)"
echo "login: user=$(cat "$EVIDENCE_DIR/api/login-summary.json") csrf=$([ -n "$CSRF" ] && echo present || echo MISSING)"

api_get() { # path outfile -> prints http code
    curl -sS -m 90 -b "$JAR" -H 'X-RAST-Desktop: 1' -o "$2" -w '%{http_code}' "$RAST_URL$1"
}
api_post() { # path outfile [body] -> prints http code
    local body="${3:-}"; [ -n "$body" ] || body='{}'
    curl -sS -m 120 -b "$JAR" -H 'X-RAST-Desktop: 1' -H "X-CSRF-Token: $CSRF" \
        -H 'Content-Type: application/json' -d "$body" -o "$2" -w '%{http_code}' "$RAST_URL$1"
}

# ---------------------------------------------------------------------------
stage "2. server capabilities + native session"
BOOT_HTTP=$(curl -sS -m 60 -o "$EVIDENCE_DIR/api/bootstrap.json" -w '%{http_code}' "$RAST_URL/api/bootstrap" || echo 000)
echo "bootstrap: http=$BOOT_HTTP version=$(jq -r '.version // "?"' "$EVIDENCE_DIR/api/bootstrap.json" 2>/dev/null)"
ME_HTTP=$(api_get /api/auth/me "$SECRET_DIR/me.json")
echo "auth/me: http=$ME_HTTP"
jq 'del(.csrfToken, .user.email)' "$SECRET_DIR/me.json" > "$EVIDENCE_DIR/api/me-summary.json" 2>/dev/null || true

INV_HTTP=$(api_get /api/linux-apps "$EVIDENCE_DIR/api/inventory.json")
echo "linux-apps: http=$INV_HTTP"
jq '{nativeEnabled, dockerEnabled, runtime: (.runtime // null), session: (.session // null | {id,status,viewers,url,displayBackend,renderer,separateWindows,apps: [.apps[]? | {appId,name,runId,status}]})}' \
    "$EVIDENCE_DIR/api/inventory.json" > "$EVIDENCE_DIR/api/inventory-summary.json" 2>/dev/null || true
SESSION_JSON="$EVIDENCE_DIR/api/session-before.json"
SESS_HTTP=$(api_get /api/linux-apps/session "$SESSION_JSON")
SESSION_ID="$(jq -r '.session.id // empty' "$SESSION_JSON" 2>/dev/null)"
SESSION_KEY="$(jq -r '.session.url // empty' "$SESSION_JSON" 2>/dev/null | sed -E 's#^/linux-apps/session/([^/]+)/.*#\1#')"
VIEWERS_BEFORE="$(jq -r '.session.viewers // empty' "$SESSION_JSON" 2>/dev/null)"
REC session_http "$SESS_HTTP"
REC session_id "$SESSION_ID"
REC session_key "$SESSION_KEY"
REC session_url_path "$(jq -r '.session.url // empty' "$SESSION_JSON" 2>/dev/null)"
REC viewers_before "$VIEWERS_BEFORE"
echo "session: http=$SESS_HTTP id=$SESSION_ID key=${SESSION_KEY:-<none>} viewers=${VIEWERS_BEFORE:-?}"
echo "session apps: $(jq -c '[.session.apps[]? | {name,runId,status}]' "$SESSION_JSON" 2>/dev/null)"

# remember pre-existing runs so cleanup never ends something we did not start
jq -r '.session.apps[]? | "\(.appId) \(.runId)"' "$SESSION_JSON" 2>/dev/null > "$EVIDENCE_DIR/api/preexisting-runs.txt" || true

if [ -z "$SESSION_ID" ]; then
    stage "2b. prewarm native session"
    PRE_HTTP=$(api_post /api/linux-apps/session/prewarm "$EVIDENCE_DIR/api/prewarm.json")
    echo "prewarm: http=$PRE_HTTP $(head -c 300 "$EVIDENCE_DIR/api/prewarm.json" 2>/dev/null)"
    for _ in $(seq 1 30); do
        sleep 2
        api_get /api/linux-apps/session "$SESSION_JSON" >/dev/null 2>&1 || true
        SESSION_ID="$(jq -r '.session.id // empty' "$SESSION_JSON" 2>/dev/null)"
        [ -n "$SESSION_ID" ] && break
    done
    SESSION_KEY="$(jq -r '.session.url // empty' "$SESSION_JSON" 2>/dev/null | sed -E 's#^/linux-apps/session/([^/]+)/.*#\1#')"
    REC session_id "$SESSION_ID"
    REC session_key "$SESSION_KEY"
    echo "session after prewarm: id=$SESSION_ID key=${SESSION_KEY:-<none>}"
fi

if [ -z "$SESSION_KEY" ]; then
    fail_stage "no native session key discovered (server returned no /linux-apps/session/<key>/ URL)"
    REC status blocked_no_attach_path
    REC blocked_reason "no native session URL"
    build_summary 20
    exit 20
fi

# ---------------------------------------------------------------------------
stage "3. choose and launch a lightweight app"
DISC_HTTP=$(api_get /api/linux-apps/discovered "$EVIDENCE_DIR/api/discovered.json")
echo "discovered: http=$DISC_HTTP apps=$(jq -r '.apps | length' "$EVIDENCE_DIR/api/discovered.json" 2>/dev/null)"
jq '{enabled, policy, apps: [.apps[]? | {id,name,terminal,categories,canLaunch,status}]}' \
    "$EVIDENCE_DIR/api/discovered.json" > "$EVIDENCE_DIR/api/discovered-summary.json" 2>/dev/null || true

APP_ID=""
APP_NAME=""
if [ -n "$APP_PREF" ]; then
    read -r APP_ID APP_NAME < <(jq -r --arg p "$APP_PREF" \
        '[.apps[]? | select((.name | ascii_downcase) == ($p | ascii_downcase)) | select(.canLaunch == true)] | first // empty | "\(.id) \(.name)"' \
        "$EVIDENCE_DIR/api/discovered.json" 2>/dev/null || true)
fi
if [ -z "$APP_ID" ]; then
    # terminal-ish apps first (light), skipping apps that are already running
    RUNNING_JSON="$(jq -c '[.session.apps[]?.appId]' "$SESSION_JSON" 2>/dev/null || echo '[]')"
    read -r APP_ID APP_NAME < <(jq -r --argjson running "$RUNNING_JSON" '
        [.apps[]? | select(.canLaunch == true and .status == "ready")]
        | (map(select(.name | test("alacritty|xterm|terminal|kitty|foot|^st$"; "i"))) + .)
        | map(select((.id as $id | $running | index($id)) | not))
        | .[0] // empty | "\(.id) \(.name)"' "$EVIDENCE_DIR/api/discovered.json" 2>/dev/null || true)
fi
if [ -z "$APP_ID" ]; then
    fail_stage "no launchable discovered app (GET /api/linux-apps/discovered)"
    REC status blocked_no_attach_path
    REC blocked_reason "no launchable app"
    build_summary 20
    exit 20
fi
REC app_id "$APP_ID"
REC app_name "$APP_NAME"
echo "app: $APP_NAME ($APP_ID)"

LAUNCH_START=$(now_ms)
LAUNCH_HTTP=$(api_post "/api/linux-apps/$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1]))' "$APP_ID")/launch" \
    "$EVIDENCE_DIR/api/launch.json")
REC launch_ms "$(( $(now_ms) - LAUNCH_START ))"
REC launch_http "$LAUNCH_HTTP"
echo "launch: http=$LAUNCH_HTTP $(jq -c '{run:(.run|{appId,name,runId,status,error}),session:(.session|{id,status,viewers})}' "$EVIDENCE_DIR/api/launch.json" 2>/dev/null)"
RUN_ID="$(jq -r '.run.runId // empty' "$EVIDENCE_DIR/api/launch.json" 2>/dev/null)"
REC run_id "$RUN_ID"
if [ -z "$RUN_ID" ]; then
    warn "launch returned no runId; continuing with the existing session"
else
    if grep -qxF "$APP_ID $RUN_ID" "$EVIDENCE_DIR/api/preexisting-runs.txt" 2>/dev/null; then
        REC run_preexisting 1
        echo "run $RUN_ID already existed before this run — cleanup will NOT close it"
    else
        REC run_preexisting 0
        RUN_CREATED_BY_US=1
        echo "run $RUN_ID was started by this workflow — cleanup will close it"
    fi
    REC run_created_by_us "$RUN_CREATED_BY_US"
fi
sleep 2
api_get /api/linux-apps/session "$EVIDENCE_DIR/api/session-after-launch.json" >/dev/null 2>&1 || true

# wait for the run to report running (bounded)
for _ in $(seq 1 20); do
    ST="$(jq -r --arg r "$RUN_ID" '.session.apps[]? | select(.runId == $r) | .status' "$EVIDENCE_DIR/api/session-after-launch.json" 2>/dev/null)"
    [ "$ST" = "running" ] && break
    sleep 2
    api_get /api/linux-apps/session "$EVIDENCE_DIR/api/session-after-launch.json" >/dev/null 2>&1 || true
done

# ---------------------------------------------------------------------------
stage "4. attach path selection"
BOOT_DESKTOP="$(jq -r '.desktop // empty' "$EVIDENCE_DIR/api/bootstrap.json" 2>/dev/null)"
echo "bootstrap.desktop=${BOOT_DESKTOP:-<absent>}"
BROKER_SUPPORTED=0
RELAY_SUPPORTED=0
ATTACH_PATH=""

issue_stream_token() { # prints http code, leaves $STREAM_JSON
    local s t
    s=$(now_ms)
    t=$(api_post "/api/linux-apps/session/stream-token" "$STREAM_JSON")
    REC token_ms "$(( $(now_ms) - s ))"
    echo "$t"
}

if [ "$MODE" = "auto" ] || [ "$MODE" = "broker" ]; then
    TOKEN_HTTP=$(issue_stream_token)
    REC broker_http "$TOKEN_HTTP"
    echo "POST /api/linux-apps/session/stream-token -> http=$TOKEN_HTTP"
    if [ "$TOKEN_HTTP" = "200" ]; then
        BROKER_SUPPORTED=1
        STREAM_TOKEN="$(jq -r '.token // empty' "$STREAM_JSON")"
        WS_URL="$(jq -r '.url // empty' "$STREAM_JSON")"
        jq '{protocol, transport, ttlSeconds, expiresAt, xpra, session: (.session // null | {id,status,appName}),
             url: ((.url // "") | sub("/[A-Za-z0-9_-]+/$"; "/<redacted-token>/"))}' \
            "$STREAM_JSON" > "$EVIDENCE_DIR/api/stream-token-summary.json" 2>/dev/null || true
        echo "stream token: protocol=$(jq -r '.protocol' "$STREAM_JSON") ttl=$(jq -r '.ttlSeconds' "$STREAM_JSON")s transport=$(jq -r '.transport' "$STREAM_JSON") url=<redacted>"
    else
        jq '{http: '"$TOKEN_HTTP"', error: (.error // .)}' "$STREAM_JSON" > "$EVIDENCE_DIR/api/stream-token-summary.json" 2>/dev/null || true
        warn "server does not support desktop.streamTokens yet (POST /api/linux-apps/session/stream-token -> HTTP $TOKEN_HTTP)"
    fi
fi

if [ "$BROKER_SUPPORTED" = "1" ]; then
    ATTACH_PATH="broker"
elif [ "$MODE" = "relay" ] || { [ "$MODE" = "auto" ] && [ -n "$SESSION_KEY" ] && [ -n "$COOKIE_VALUE" ]; }; then
    RELAY_SUPPORTED=1
    ATTACH_PATH="relay-poc"
    HOST="$(python3 -c 'import sys,urllib.parse;print(urllib.parse.urlsplit(sys.argv[1]).netloc)' "$RAST_URL")"
    WS_URL="wss://$HOST/linux-apps/session/$SESSION_KEY/"
    echo "relay-poc path: using existing authenticated HTML5 relay /linux-apps/session/<key>/ (key present, cookie present)"
fi
REC broker_supported "$BROKER_SUPPORTED"
REC attach_path "$ATTACH_PATH"
if [ -z "$ATTACH_PATH" ]; then
    fail_stage "no usable attach path: broker endpoint unavailable (HTTP ${TOKEN_HTTP:-n/a}) and relay fallback not possible"
    REC status blocked_no_attach_path
    REC blocked_reason "server does not support desktop.streamTokens yet and relay fallback unavailable"
    build_summary 20
    exit 20
fi
echo "attach path: $ATTACH_PATH"

# ---------------------------------------------------------------------------
stage "5. build version-validated Xpra argv"
HELP="$EVIDENCE_DIR/xpra-attach-help.log"
has_flag() { grep -q -- "$1" "$HELP" 2>/dev/null; }
FLAGS=()
add_flag() { if has_flag "$1"; then FLAGS+=("$2"); else warn "flag $1 not offered by this Xpra version — skipped"; fi; }
# macOS/Xpra 7.0 spellings (help-validated; 6.x negations --no-mdns/--no-printing/
# --no-webcam are NOT offered by 7.0 and must not be emitted).
add_flag "--sharing" "--sharing=yes"
add_flag "--clipboard=" "--clipboard=yes"
add_flag "--clipboard-direction" "--clipboard-direction=both"
add_flag "--audio=" "--audio=yes"
add_flag "--speaker=" "--speaker=on"
add_flag "--microphone=" "--microphone=no"
add_flag "--av-sync" "--av-sync=yes"
add_flag "--opengl=" "--opengl=auto"
add_flag "--notifications=" "--notifications=no"
add_flag "--exit-with-client=" "--exit-with-client=no"
add_flag "--mdns=" "--mdns=no"
add_flag "--printing=" "--printing=no"
add_flag "--webcam=" "--webcam=no"
add_flag "--splash=" "--splash=no"
# Only pass quality/encoding knobs when the server actually publishes a profile.
PROFILE_JSON="$EVIDENCE_DIR/api/inventory.json"
read -r P_ENCODING P_QUALITY P_MINQ P_SPEED P_MINS P_VSCALE <<EOF2
$(jq -r '[.runtime.encoding, .runtime.quality, .runtime.minQuality, .runtime.speed, .runtime.minSpeed, .runtime.videoScaling] | map(if . == null then "" else tostring end) | join(" ")' "$PROFILE_JSON" 2>/dev/null || echo "      ")
EOF2
[ -n "${P_ENCODING:-}" ] && add_flag "--encodings" "--encodings=$P_ENCODING"
[ -n "${P_QUALITY:-}" ] && add_flag "--quality" "--quality=$P_QUALITY"
[ -n "${P_MINQ:-}" ] && add_flag "--min-quality" "--min-quality=$P_MINQ"
[ -n "${P_SPEED:-}" ] && add_flag "--speed" "--speed=$P_SPEED"
[ -n "${P_MINS:-}" ] && add_flag "--min-speed" "--min-speed=$P_MINS"
[ -n "${P_VSCALE:-}" ] && add_flag "--video-scaling" "--video-scaling=$P_VSCALE"
REC xpra_flags "${FLAGS[*]}"
echo "argv: $XPRA_BIN attach <redacted-url> ${FLAGS[*]}"

# ---------------------------------------------------------------------------
# macOS window enumeration helper (CoreGraphics; no TCC permission needed for
# owner/PID/layer/bounds; window titles may be redacted by macOS).
WINLIST="$EVIDENCE_DIR/tools/listwindows"
cat > "$EVIDENCE_DIR/tools/listwindows.swift" <<'SWIFT'
import CoreGraphics
import Foundation
let options: CGWindowListOption = [.optionAll]
guard let windows = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
    FileHandle.standardError.write(Data("CGWindowListCopyWindowInfo failed\n".utf8)); exit(1)
}
for w in windows {
    let owner = w[kCGWindowOwnerName as String] as? String ?? "?"
    let pid = w[kCGWindowOwnerPID as String] as? Int ?? -1
    let layer = w[kCGWindowLayer as String] as? Int ?? -1
    let num = w[kCGWindowNumber as String] as? Int ?? -1
    let name = (w[kCGWindowName as String] as? String ?? "").replacingOccurrences(of: "\n", with: " ")
    let b = w[kCGWindowBounds as String] as? [String: Any] ?? [:]
    let onscreen = w[kCGWindowIsOnscreen as String] as? Bool ?? false
    print("owner=\(owner) pid=\(pid) layer=\(layer) window=\(num) onscreen=\(onscreen) bounds=\(b["X"] ?? "?"),\(b["Y"] ?? "?"),\(b["Width"] ?? "?"),\(b["Height"] ?? "?") name=\(name)")
}
SWIFT
HAVE_WINLIST=0
if xcrun --find swiftc >/dev/null 2>&1 && swiftc -O "$EVIDENCE_DIR/tools/listwindows.swift" -o "$WINLIST" > "$EVIDENCE_DIR/tools/swiftc.log" 2>&1; then
    HAVE_WINLIST=1
    echo "window lister: compiled ($WINLIST)"
else
    warn "could not compile the CoreGraphics window lister (see tools/swiftc.log)"
fi

list_windows() { if [ "$HAVE_WINLIST" = "1" ]; then "$WINLIST" 2>/dev/null || true; else osascript -e 'tell application "System Events" to get name of every process whose background only is false' 2>/dev/null || true; fi; }
list_windows > "$EVIDENCE_DIR/windows-before.txt" || true
BEFORE_LINES="$EVIDENCE_DIR/windows-before.txt"
echo "windows before attach: $(wc -l < "$BEFORE_LINES" | tr -d ' ') entries"

count_new_windows() { # tag -> prints "total layer0"
    local tag="$1" nowf="$EVIDENCE_DIR/windows-after-$tag.txt"
    list_windows > "$nowf" || true
    local total layer0
    total=$(comm -13 <(sort "$BEFORE_LINES") <(sort "$nowf") 2>/dev/null | wc -l | tr -d ' ')
    layer0=$(comm -13 <(sort "$BEFORE_LINES") <(sort "$nowf") 2>/dev/null | grep -c 'layer=0' || true)
    printf '%s %s\n' "$total" "${layer0:-0}"
}

applescript_window_count() {
    local n=""
    for pname in Xpra xpra; do
        n=$(osascript -e "tell application \"System Events\" to count windows of process \"$pname\"" 2>/dev/null || true)
        case "$n" in ''|*[!0-9]*) n="" ;; *) break ;; esac
    done
    printf '%s' "${n:-}"
}

attach_and_observe() { # tag url -> sets ATTACH_EVIDENCE, ATTACH_MS, WINDOW_MS, NEW_TOTAL, NEW_LAYER0
    local tag="$1" url="$2"
    local log="$EVIDENCE_DIR/xpra-attach-$tag.log"
    local start_ms cap_ms deadline
    ATTACH_EVIDENCE=""
    ATTACH_MS=""
    WINDOW_MS=""
    NEW_TOTAL=""
    NEW_LAYER0=""
    start_ms=$(now_ms)
    list_windows > "$EVIDENCE_DIR/windows-before-$tag.txt" || true
    (
        export XPRA_WEBSOCKET_MASK=1
        if [ "$ATTACH_PATH" = "relay-poc" ]; then
            export XPRA_WEBSOCKET_HEADERS_MODULES="default,origin,env_cookie"
            export XPRA_WEBSOCKET_ORIGIN="$RAST_URL"
            export XPRA_WS_COOKIE="rast_session=$COOKIE_VALUE"
        fi
        export XPRA_LOG_DIR="$EVIDENCE_DIR/xpra-client-$tag"
        mkdir -p "$XPRA_LOG_DIR"
        exec "$XPRA_BIN" attach "$url" "${FLAGS[@]}"
    ) > "$log" 2>&1 &
    XPRA_PID=$!
    echo "attach[$tag]: started pid=$XPRA_PID, waiting for connection evidence (log: $(basename "$log"))"
    deadline=$(( start_ms + 150000 ))
    while [ "$(now_ms)" -lt "$deadline" ]; do
        if grep -qiE 'attached to|connection established|server version|handshake complete|hello|connected to' "$log" 2>/dev/null; then
            ATTACH_MS=$(( $(now_ms) - start_ms ))
            ATTACH_EVIDENCE="log-match"
            break
        fi
        if ! kill -0 "$XPRA_PID" 2>/dev/null; then
            echo "attach[$tag]: client exited before attach evidence"
            break
        fi
        sleep 1
    done
    cap_ms=$(now_ms)
    if [ -z "$ATTACH_EVIDENCE" ]; then
        # capture the failure text for the summary (redacted later)
        tail -60 "$log" >> "$EVIDENCE_DIR/attach-failure-$tag.txt" 2>/dev/null || true
        REC "attach${tag}_failed_after_ms" "$(( cap_ms - start_ms ))"
        echo "attach[$tag]: NO attach evidence after $(( cap_ms - start_ms )) ms"
    else
        echo "attach[$tag]: attach evidence after $ATTACH_MS ms"
    fi
    # wait for a real macOS window to appear (CoreGraphics diff) up to 90 s
    deadline=$(( $(now_ms) + 90000 ))
    while [ "$(now_ms)" -lt "$deadline" ]; do
        read -r NEW_TOTAL NEW_LAYER0 < <(count_new_windows "$tag")
        if [ "${NEW_LAYER0:-0}" -gt 0 ]; then
            WINDOW_MS=$(( $(now_ms) - start_ms ))
            break
        fi
        kill -0 "$XPRA_PID" 2>/dev/null || break
        sleep 2
    done
    read -r NEW_TOTAL NEW_LAYER0 < <(count_new_windows "$tag")
    cp "$EVIDENCE_DIR/windows-after-$tag.txt" "$EVIDENCE_DIR/windows-observed-$tag.txt" 2>/dev/null || true
    echo "attach[$tag]: new windows total=${NEW_TOTAL:-?} layer0=${NEW_LAYER0:-?} window_evidence_ms=${WINDOW_MS:-none}"
    REC "new_windows_${tag}" "${NEW_TOTAL:-}"
    REC "new_layer0_windows_${tag}" "${NEW_LAYER0:-}"
}

# ---------------------------------------------------------------------------
stage "6. attach attempt 1"
ATTACH_START_GLOBAL=$(now_ms)
attach_and_observe 1 "$WS_URL"
REC attach1_ms "$ATTACH_MS"
REC window1_ms "$WINDOW_MS"
REC new_windows "$NEW_TOTAL"
REC new_layer0_windows "$NEW_LAYER0"

sleep 2
api_get /api/linux-apps/session "$EVIDENCE_DIR/api/session-after-attach.json" >/dev/null 2>&1 || true
REC viewers_after_attach "$(jq -r '.session.viewers // empty' "$EVIDENCE_DIR/api/session-after-attach.json" 2>/dev/null)"
echo "session after attach: $(jq -c '{session:(.session|{id,status,viewers}),runs:[.session.apps[]?|{name,runId,status}]}' "$EVIDENCE_DIR/api/session-after-attach.json" 2>/dev/null)"

APPS_SCRIPT_COUNT="$(applescript_window_count)"
REC applescript_windows "$APPS_SCRIPT_COUNT"
echo "AppleScript window count: ${APPS_SCRIPT_COUNT:-<unavailable>}"

if kill -0 "$XPRA_PID" 2>/dev/null; then
    lsof -nP -p "$XPRA_PID" -a -iTCP -sTCP:ESTABLISHED > "$EVIDENCE_DIR/lsof-connection.txt" 2>/dev/null || true
    echo "established TCP sockets: $(grep -c ESTABLISHED "$EVIDENCE_DIR/lsof-connection.txt" 2>/dev/null || echo 0)"
    ps -o pid,ppid,%cpu,%mem,etime,command -p "$XPRA_PID" > "$EVIDENCE_DIR/process.txt" 2>/dev/null || true
fi

screencapture -x "$EVIDENCE_DIR/screenshot-attach-1.png" 2> "$EVIDENCE_DIR/screencapture-1.err" || warn "screencapture failed (TCC screen recording?)"
[ -f "$EVIDENCE_DIR/screenshot-attach-1.png" ] && echo "screenshot-attach-1.png: $(stat -f%z "$EVIDENCE_DIR/screenshot-attach-1.png") bytes"

# negotiated encodings/capabilities: try `xpra info` with a fresh credential
stage "6b. xpra info (negotiated encodings/capabilities)"
INFO_URL=""
if [ "$ATTACH_PATH" = "broker" ]; then
    T2=$(issue_stream_token)
    if [ "$T2" = "200" ]; then INFO_URL="$(jq -r '.url // empty' "$STREAM_JSON")"; fi
else
    INFO_URL="$WS_URL"
fi
if [ -n "$INFO_URL" ]; then
    if [ "$ATTACH_PATH" = "relay-poc" ]; then
        export XPRA_WEBSOCKET_HEADERS_MODULES="default,origin,env_cookie"
        export XPRA_WEBSOCKET_ORIGIN="$RAST_URL"
        export XPRA_WS_COOKIE="rast_session=$COOKIE_VALUE"
    fi
    python3 - "$XPRA_BIN" info "$INFO_URL" > "$EVIDENCE_DIR/xpra-info.log" 2>&1 <<'PY'
import subprocess, sys, os
env = {**os.environ, "XPRA_WEBSOCKET_MASK": "1"}
try:
    r = subprocess.run([sys.argv[1], "info", sys.argv[2]], timeout=120, capture_output=True,
                       text=True, stdin=subprocess.DEVNULL, env=env)
    print(r.stdout or "")
    if r.stderr:
        print("--- stderr ---")
        print(r.stderr)
    sys.exit(r.returncode)
except subprocess.TimeoutExpired:
    print("TIMEOUT after 120s"); sys.exit(124)
PY
    INFO_RC=$?
    REC xpra_info_ran 1
    REC xpra_info_rc "$INFO_RC"
    echo "xpra info: rc=$INFO_RC output lines=$(wc -l < "$EVIDENCE_DIR/xpra-info.log" | tr -d ' ')"
    grep -iE 'encoding|codec|capab|protocol|version' "$EVIDENCE_DIR/xpra-info.log" | head -40 >> "$EVIDENCE_DIR/xpra-info-encodings.txt" 2>/dev/null || true
else
    REC xpra_info_ran 0
    warn "xpra info skipped: no fresh credential available"
fi

# ---------------------------------------------------------------------------
stage "7. server-side confirmation (authenticated API + admin audit log)"
if [ -n "$RAST_ADMIN_USER" ] && [ -n "$RAST_ADMIN_PASSWORD" ]; then
    ADMIN_HTTP=$(curl -sS -m 60 -c "$ADMIN_JAR" -H 'Content-Type: application/json' -H 'X-RAST-Desktop: 1' \
        -d "$(jq -nc --arg u "$RAST_ADMIN_USER" --arg p "$RAST_ADMIN_PASSWORD" '{username:$u,password:$p}')" \
        -o "$SECRET_DIR/admin-login.json" -w '%{http_code}' "$RAST_URL/api/auth/login" || echo 000)
    ADMIN_CSRF="$(jq -r '.csrfToken // empty' "$SECRET_DIR/admin-login.json" 2>/dev/null)"
    echo "admin login: http=$ADMIN_HTTP"
    if [ "$ADMIN_HTTP" = "200" ]; then
        LOG_HTTP=$(curl -sS -m 90 -b "$ADMIN_JAR" -H 'X-RAST-Desktop: 1' \
            -o "$SECRET_DIR/logs.json" -w '%{http_code}' "$RAST_URL/api/logs?perPage=100&page=1" || echo 000)
        echo "GET /api/logs: http=$LOG_HTTP"
        python3 - "$SECRET_DIR/logs.json" "$EVIDENCE_DIR/api/server-logs.json" "$ATTACH_START_GLOBAL" <<'PY'
import json, sys
src, dst, start = sys.argv[1], sys.argv[2], int(sys.argv[3])
try:
    data = json.load(open(src))
except Exception:
    json.dump([], open(dst, "w")); sys.exit(0)
items = data.get("items", data if isinstance(data, list) else [])
recent = [i for i in items if int(i.get("createdAt", 0)) >= start]
interesting = [i for i in recent if "stream" in str(i.get("action", "")).lower()
               or i.get("objectType") in ("linux-app", "linux_app")]
json.dump(interesting, open(dst, "w"), indent=2)
print(f"server log: {len(items)} entries fetched, {len(recent)} new since test start, "
      f"{len(interesting)} stream/linux-app entries")
PY
        REC server_log_entries "$(jq -r 'length' "$EVIDENCE_DIR/api/server-logs.json" 2>/dev/null || echo 0)"
    else
        warn "admin login failed (http=$ADMIN_HTTP); server-side audit log not collected"
    fi
else
    warn "RAST_ADMIN_USER/PASSWORD not provided; server-side audit log not collected"
fi

# ---------------------------------------------------------------------------
stage "8. reconnection: kill the client, attach again"
if [ -n "$XPRA_PID" ] && kill -0 "$XPRA_PID" 2>/dev/null; then
    kill -TERM "$XPRA_PID" 2>/dev/null || true
    for _ in $(seq 1 20); do kill -0 "$XPRA_PID" 2>/dev/null || break; sleep 1; done
    kill -KILL "$XPRA_PID" 2>/dev/null || true
    echo "client killed; session should survive on the server"
else
    warn "client was not running before the reconnect test"
fi
XPRA_PID=""
sleep 2
api_get /api/linux-apps/session "$EVIDENCE_DIR/api/session-after-kill.json" >/dev/null 2>&1 || true
echo "session after client kill: $(jq -c '{session:(.session|{id,status,viewers})}' "$EVIDENCE_DIR/api/session-after-kill.json" 2>/dev/null)"

if [ "$ATTACH_PATH" = "broker" ]; then
    T3=$(issue_stream_token)
    [ "$T3" = "200" ] && WS_URL="$(jq -r '.url // empty' "$STREAM_JSON")"
    echo "fresh stream token for reconnect: http=$T3"
fi
attach_and_observe 2 "$WS_URL"
REC attach2_ms "$ATTACH_MS"
REC new_windows_2 "$NEW_TOTAL"
sleep 2
api_get /api/linux-apps/session "$EVIDENCE_DIR/api/session-after-attach-2.json" >/dev/null 2>&1 || true
REC viewers_after_attach2 "$(jq -r '.session.viewers // empty' "$EVIDENCE_DIR/api/session-after-attach-2.json" 2>/dev/null)"
screencapture -x "$EVIDENCE_DIR/screenshot-attach-2.png" 2> "$EVIDENCE_DIR/screencapture-2.err" || true
[ -f "$EVIDENCE_DIR/screenshot-attach-2.png" ] && echo "screenshot-attach-2.png: $(stat -f%z "$EVIDENCE_DIR/screenshot-attach-2.png") bytes"

# ---------------------------------------------------------------------------
stage "9. verdict"
ATTACH1_OK=0; ATTACH2_OK=0
grep -qiE 'attached to|connection established|server version|handshake complete|hello|connected to' "$EVIDENCE_DIR/xpra-attach-1.log" 2>/dev/null && ATTACH1_OK=1
grep -qiE 'attached to|connection established|server version|handshake complete|hello|connected to' "$EVIDENCE_DIR/xpra-attach-2.log" 2>/dev/null && ATTACH2_OK=1
NEW1_REC="$(grep -m1 '^new_layer0_windows=' "$MEASURE" 2>/dev/null | cut -d= -f2)"
NEW2_REC="$(grep -m1 '^new_layer0_windows_2=' "$MEASURE" 2>/dev/null | cut -d= -f2)"

if [ "$ATTACH1_OK" = "1" ] && [ "$ATTACH2_OK" = "1" ] && [ "${NEW1_REC:-0}" -gt 0 ] && [ "${NEW2_REC:-0}" -gt 0 ]; then
    STATUS="verified"
    REC status "$STATUS"
    echo "VERDICT: verified — two successful attaches, reconnection works, macOS windows observed"
    RC=0
elif [ "$ATTACH1_OK" = "1" ] || [ "$ATTACH2_OK" = "1" ]; then
    STATUS="partial"
    REC status "$STATUS"
    warn "attach worked but not every checkpoint passed (windows: attach1=${NEW1_REC:-?}, attach2=${NEW2_REC:-?})"
    RC=40
else
    STATUS="attach_failed"
    REC status "$STATUS"
    fail_stage "the official Xpra client did not attach to the server"
    tail -40 "$EVIDENCE_DIR/xpra-attach-1.log" 2>/dev/null || true
    RC=30
fi
REC attach1_ok "$ATTACH1_OK"
REC attach2_ok "$ATTACH2_OK"

build_summary "$RC"
redact_evidence
exit "$RC"
