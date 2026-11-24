# Phase 1 — native Xpra proof of concept

This directory contains the harnesses that answer one question before any
custom streaming engine is written:

> Does the official **native** Xpra client attach to the existing RAST Linux
> server securely and work well enough to justify a native macOS client?

The harness drives the official client (Xpra 6.5.5 on this Linux host, Xpra
7.0 on the macOS runners) against the **live production server** and records
functional checks and measurements.

## Attach paths

| Mode | Credential | Notes |
| --- | --- | --- |
| `relay-poc` | real RAST login cookie + same-origin headers injected via `poc/xpra_ws_headers/sitecustomize.py` | uses the *existing* authenticated HTML5 relay `/linux-apps/session/<key>/`; proves protocol/rendering/input today, before the Phase 3 broker exists |
| `broker` | single-use stream token in the URL (`POST /api/linux-apps/session/stream-token`, Phase 3) | the production design; no cookie/Origin hack |

Both modes REQUIRE `XPRA_WEBSOCKET_MASK=1`: the official Xpra client defaults to
unmasked WebSocket frames, which a standards-compliant relay
(tokio-tungstenite) must reject with a protocol error. See
`docs/PROTOCOL.md` §5.

## Run

```bash
# Functional matrix (attach, windows, typing, clipboard, resize, dialogs,
# minimize, close, reconnect, audio negotiation) + measurements
node poc/check.mjs --mode=relay-poc --label=linux-native-relay

# Production broker path (requires the Phase 3 server deployment)
node poc/check.mjs --mode=broker --label=linux-native-broker

# HTML5 comparison on the same host/account/network (uses the RAST repo's
# existing benchmark harness, see docs/PHASE1-MACOS.md and RAST docs/BENCHMARKS.md)
```

Credentials are read from `/home/lufria/.config/rast-test/creds` (never
printed). Results are written to `poc/tmp/<label>-<timestamp>/` as
`results.json`, `results.md` and client logs. Do not commit `poc/tmp/`.
