# Phase 1 — native Xpra client verification on macOS

Status: **in progress** — the official native Xpra client is executed on real
GitHub Actions macOS runners against the live RAST server; the attach evidence,
numbers and blockers are recorded below from the actual workflow run/artifacts.
Nothing here is extrapolated from Linux, and anything that could not be measured
on a runner is listed as **not measured** with the reason.

This document is the macOS half of the Phase 1 question: *can the official
native Xpra client attach to the live RAST server from macOS and produce real
macOS windows, well enough to justify the native client design?* The Linux half
lives in `poc/` (Lead-owned).

## 1. What runs where

| Piece | Location | Purpose |
| --- | --- | --- |
| Workflow | `.github/workflows/native-poc.yml` | `workflow_dispatch`: mode `auto|broker|relay`, runner `macos-15` (arm64) or `macos-15-intel` (x86_64), optional app + optional HTML5 baseline |
| Client installer | `scripts/macos/install-xpra-client.sh` | download the **official** Xpra macOS `.dmg` from xpra.org, SHA-1 verify, mount, resolve bundle executable |
| Verification | `scripts/macos/phase1-native-verify.sh` | login, inventory, launch, attach, observe, reconnect, evidence + redaction |
| HTML5 baseline | `scripts/macos/html5-compare.cjs` | Playwright Chromium on the same runner/account/network |
| Cleanup | `scripts/macos/phase1-cleanup.sh` | `if: always()`: closes only the run this workflow started, revokes tokens, logs out, detaches the DMG |

Secrets used (repository-level, never printed): `RAST_TEST_URL`,
`RAST_TEST_USER`, `RAST_TEST_PASSWORD`, and optionally `RAST_ADMIN_USER`,
`RAST_ADMIN_PASSWORD` (read the server audit log). The scripts redact the login
cookie, CSRF token, stream token and full `wss` URL from every evidence file
before the artifact is uploaded.

## 2. Official Xpra macOS client used (from xpra.org, not bundled)

Pinned, SHA-1 verified at run time (no Xpra binary is committed to this repo):

| Architecture | URL | SHA-1 |
| --- | --- | --- |
| arm64 | <https://xpra.org/stable/MacOS/arm64/Xpra-arm64-7.0-r0.dmg> | `01161232928ff2e724ef8ea402d9029c399218bf` |
| x86_64 | <https://xpra.org/stable/MacOS/x86_64/Xpra-x86_64-7.0-r0.dmg> | `3999aed9965dc2422d3c983a70dd8439e033fc52` |

Verified on the runner: `Xpra.app` bundle id `org.xpra.xpra`, version **7.0-r0**,
`Xpra.app/Contents/MacOS/Xpra --version` → `xpra v7.0-r0`, `attach --help` rc=0
(41,146 bytes) on both arm64 and Intel runners (smoke run
<https://github.com/Enricko/rast-desktop/actions/runs/45467052448>).

## 3. Attach paths

### 3.1 `broker` — production design (Phase 3)

`POST /api/linux-apps/session/stream-token` returns
`{protocol, token, url: wss://…/linux-apps/native/<token>/, ttlSeconds, transport, session, xpra}`.
The single-use token in the URL is the credential; no browser headers are sent.
This requires the RAST update that advertises `bootstrap.desktop.streamTokens=true`.
Until that update is deployed the endpoint answers **404** and the workflow says
so explicitly:

```
server does not support desktop.streamTokens yet
(POST /api/linux-apps/session/stream-token -> HTTP 404)
```

### 3.2 `relay` — early Phase 1 PoC path (works on the current 0.18.3 server)

Attach through the **existing** authenticated HTML5 relay
`wss://<host>/linux-apps/session/<key>/`. That relay validates a same-origin
`Origin` header and a real RAST login cookie on the WebSocket upgrade. The
official Xpra **7.0** client supports injecting exactly those headers through
environment variables (no monkeypatching needed):

```
XPRA_WEBSOCKET_HEADERS_MODULES=default,origin,env_cookie
XPRA_WEBSOCKET_ORIGIN=https://desktop.lufria.tech
XPRA_WS_COOKIE=rast_session=<cookie value>        # handled as a secret, never logged
```

For Xpra **6.x** (which lacks those env modules) the PoC shim
`poc/xpra_ws_headers/sitecustomize.py` monkeypatches the default header module
instead. The workflow only enables the relay path when the server does not offer
the broker endpoint; when the broker is deployed the token path is used and no
cookie/Origin is sent.

### 3.3 Mandatory: `XPRA_WEBSOCKET_MASK=1`

The official client defaults to **unmasked** WebSocket frames
(`XPRA_WEBSOCKET_MASK` defaults to false in
`xpra/net/websockets/protocol.py`). RFC 6455 requires client frames to be
masked, and the RAST relay (tokio-tungstenite) is standards-compliant, so an
unmasked client is closed right after its first frame ("0 packets received /
not an xpra server"). Every attach in this workflow therefore sets
`XPRA_WEBSOCKET_MASK=1`; see `docs/PROTOCOL.md` §5 (commit `0c0e3c6`).

## 4. Validated Xpra 7.0-r0 argv (macOS)

Flags are validated against `Xpra attach --help` at run time (the supervisor must
do the same per Xpra version). On 7.0-r0 the **value forms** are listed and the
6.x negations are not; the verified macOS argv is:

```
<Xpra.app>/Contents/MacOS/Xpra attach <wss-url> \
  --sharing=yes \
  --clipboard=yes --clipboard-direction=both \
  --audio=yes --speaker=on --microphone=no \
  --av-sync=yes \
  --opengl=auto \
  --notifications=no --exit-with-client=no \
  --mdns=no --printing=no --webcam=no \
  --splash=no
# --encodings/--quality/--min-quality/--speed/--min-speed/--video-scaling are
# only added when the server actually publishes a runtime profile; on 0.18.3 the
# runtime values are null, so the client defaults are used and this is recorded.
```

`--no-mdns`, `--no-printing` and `--no-webcam` do **not** appear in 7.0's
`attach --help` (7.0 uses `--mdns=no` / `--printing=no` / `--webcam=no`); the
workflow derives the flags dynamically instead of hardcoding them. The exact
argv used in a run is recorded in `evidence/phase1/measurements.txt`
(`xpra_flags=…`) and in `summary.json`.

## 5. Results — run 1 (relay PoC path, pre-broker server)

> Filled from the workflow run and its uploaded artifact; see the artifact
> `phase1-native-macos-<runner>-<run id>` on the run page.

| Item | Value |
| --- | --- |
| Workflow run | _to be recorded_ |
| Runner | `macos-15` (arm64, macOS 15.x) |
| Server | https://desktop.lufria.tech — RAST version _to be recorded_ |
| `bootstrap.desktop.streamTokens` | absent (server update not deployed): broker attach `HTTP 404`, recorded, relay PoC path used |
| Test account | `t-alice` (dedicated test user); app launched: _to be recorded_ |
| Attach #1 | _to be recorded_ |
| Attach #2 after client kill (reconnect) | _to be recorded_ |
| First macOS window after attach | _to be recorded_ |
| Negotiated encodings / `xpra info` | _to be recorded_ |
| Server-side confirmation | _to be recorded_ |
| Screenshots | `screenshot-attach-1.png`, `screenshot-attach-2.png` in the artifact |
| Cleanup | only the run started by the workflow is closed; pre-existing apps and the session are untouched |

## 6. HTML5 baseline (same runner / account / network)

The workflow can run Playwright Chromium on the same runner after the native
test: login over the RAST API, ensure the same app is running, then open the
existing browser streaming page `/linux-apps/session/<key>/` and measure
`navigation → first non-empty <canvas>` (`scripts/macos/html5-compare.cjs`,
results in `evidence/phase1/html5/html5.json` + screenshot). This is the honest
same-hardware/same-network comparison; it is **not** the RAST launcher
click-path (the desktop core is not required for the streaming baseline and its
UI was still landing while this was measured).

| Metric | Native client | HTML5 (Chromium) |
| --- | --- | --- |
| Attach / navigate → first frame | _to be recorded_ | _to be recorded_ |
| Client/log | `xpra-attach-1.log` | `html5.html5-session.png` |

## 7. Not measured / blocked (explicit)

* **Broker (Phase 3) attach on macOS** — `POST /api/linux-apps/session/stream-token`
  returns 404 until the RAST server update is deployed. The workflow detects it
  (`bootstrap.desktop.streamTokens`), records it, and uses the relay PoC path.
  Re-runnable unchanged once the Lead announces the deployment.
* **Input/clipboard/resize/focus behaviour** — not measured here; Phase 5/6.
  A native window appearing and being capturable is evidence of window hosting,
  not of input integration.
* **Retina/scaling, multi-monitor, audio devices** — hosted runners have a
  virtual display and no audio hardware; not measured. Not claimed.
* **Physical Mac hardware** — none is online; all macOS evidence is from GitHub
  Actions runners and labeled as such. Intel coverage is `macos-15-intel`.
* **TCC (accessibility/screen recording)** — probed empirically: on the hosted
  runners `launchctl gui/<uid>` works, AppleScript System Events works and
  `screencapture` produces a real PNG, so window/screenshot evidence is
  available there. This says nothing about a managed corporate Mac where TCC is
  usually locked down.
* **Long-run stability / performance under load** — not measured (single short
  attach + reconnect).
* **Code signing / notarization of the Tauri app** — unrelated to this streaming
  verification and still blocked (see `docs/MACOS-BUILD.md`).

## 8. Reproduce

```bash
# from GitHub: Actions -> "Phase 1 native Xpra verification (macOS)" -> Run workflow
#   mode: auto    (broker when deployed, relay PoC otherwise)
#   runner: macos-15 (arm64) or macos-15-intel
gh workflow run native-poc.yml -f mode=auto -f runner=macos-15 -f html5=true
```

Artifacts: `phase1-native-macos-<runner>-<run id>` containing
`summary.json`/`summary.md`, `measurements.txt`, version + attach logs,
`xpra-attach-*.log`, `windows-*.txt`, `screenshot-attach-*.png`,
`xpra-info.log`, `api/*.json` (sanitized), `html5/html5.json` + screenshot,
`cleanup.log`; tokens/cookies are redacted (`<REDACTED_STREAM_TOKEN>` etc.).
