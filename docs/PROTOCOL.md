# Client ↔ server protocol (v1, draft)

This document is the contract between **RAST Desktop** (`desktop/`) and the
**RAST server**. It is implemented on the server by
`src/linux_apps/native_broker.rs` (+ routing in `src/api/linux_apps.rs`) and on
the client by `desktop/src-tauri/src/broker.rs`.

Status: **v1 draft** — implemented by the Phase 3 server change and the Phase 2
client foundation. Any change must be made in this document first, in the same
commit as the code.

## Rules

* HTTPS only for the public server URL. WSS only for streaming.
* Never log, print, persist, hash-into-file or send to crash reports: the
  `rast_session` cookie value, passwords, stream tokens, or a WS URL containing
  a token. The only permitted persistence is the macOS Keychain item for the
  session cookie.
* The server keeps all Xpra/X11 listeners on loopback. No endpoint may accept a
  non-TLS public connection to Xpra directly.
* All new server endpoints are additive; the browser clients must keep working.

## 1. Existing authentication (unchanged)

```
POST /api/auth/login
{"username": "...", "password": "..."}
→ 200 {user, csrfToken, expiresAt} + Set-Cookie: rast_session=<token>; HttpOnly; Secure; ...
```

* The desktop core performs the login over HTTPS, stores the `rast_session`
  cookie **value** in the macOS Keychain (service `tech.lufria.rast-desktop`,
  account `<username>@<server-url>`), and never stores the password.
* Every API call sends `Cookie: rast_session=<value>`.
* Every mutating call sends `X-CSRF-Token: <csrfToken>` (from the login
  response or `GET /api/auth/me`).
* `401` means the session expired/revoked: delete the Keychain item and show
  the login screen. `403 password change required` is surfaced with the
  server's message.
* Logout: `POST /api/auth/logout` (then delete the Keychain item).

## 2. Desktop capabilities (new, additive)

`GET /api/bootstrap` (public) gains an optional object:

```json
{"desktop": {"protocol": 1, "streamTokens": true, "minClientVersion": "0.1.0"}}
```

The client requires `streamTokens: true`; an older server without the object is
reported as "This RAST server does not support RAST Desktop yet (needs RAST
x.y.z or newer)" and the launcher stays on the server-settings screen. The
client sends `X-RAST-Desktop: 1` on API requests for server-side logs/audit.

## 3. Inventory and lifecycle (existing API, used as-is)

| Purpose | Endpoint |
| --- | --- |
| Session/profile/user | `GET /api/auth/me` |
| Apps + current native session | `GET /api/linux-apps` |
| Discovered host applications | `GET /api/linux-apps/discovered` |
| Start session without launching | `POST /api/linux-apps/session/prewarm` |
| Launch managed app | `POST /api/linux-apps/{id}/launch` |
| Launch discovered app | `POST /api/linux-apps/discovered/{id}/launch` |
| Current session | `GET /api/linux-apps/session` |
| Stop one run | `POST /api/linux-apps/session/runs/{run}/close` |
| Stop whole session | `POST /api/linux-apps/session/close` |
| App icon | `GET /api/linux-apps/{id}/icon` |
| Discovered app icon | `GET /api/linux-apps/discovered/{id}/icon` |

`NativeSession` (also returned by launch) carries at least
`{id/key, appId|null, appName, url, display, ...}`; the desktop core treats it
as opaque apart from the fields it needs to show status.

## 4. Stream broker (new in Phase 3)

### 4.1 Issue a stream token

```
POST /api/linux-apps/session/stream-token
Cookie: rast_session=…      X-CSRF-Token: …
{}   (no body required)
→ 200
{
  "protocol": 1,
  "token": "<43-char base64url, 32 random bytes>",
  "url": "wss://desktop.lufria.tech/linux-apps/native/<token>/",
  "expiresAt": 1795550000000,
  "ttlSeconds": 120,
  "transport": "xpra-websocket",
  "session": { … NativeSession … },
  "xpra": {"sharing": true, "protocol": 1}
}
```

* The token is **single-use**: it is consumed by the first successful
  WebSocket upgrade. Obtain a fresh token for every (re)connect.
* TTL: 120 seconds (server constant `STREAM_TOKEN_TTL`). Expired, unknown,
  already-consumed tokens are rejected.
* Bound to the caller's user id **and** native session id. A token cannot be
  used by another user, and stops working when the session it names is gone.
* At most 8 outstanding tokens per user (oldest evicted).
* Errors: `401` not signed in; `403` CSRF/account inactive; `404` no native
  session (call launch/prewarm first); `409` native runtime disabled;
  `429` rate limited.
* The server stores only `SHA-256(token)` in memory, never the token itself,
  and never logs the token or the URL.

### 4.2 Revoke outstanding tokens

```
DELETE /api/linux-apps/session/stream-tokens
→ 200 {"revoked": <n>}
```

The client calls this on logout/detach best-effort. Tokens also die with their
TTL, with the session, and when the user's RAST login session is revoked.

### 4.3 Native WebSocket attach

```
GET /linux-apps/native/<token>/<optional-rest>?<query>
Upgrade: websocket
```

* The **token is the credential** for this WebSocket; no cookie and no browser
  `Origin` header is required (native clients are not browsers). TLS is
  mandatory in production (the issued URL is `wss://`).
* The server validates and consumes the token atomically *before* upgrading,
  then relays binary frames to `ws://127.0.0.1:<xpra-port>/<rest?query>`.
  Xpra still listens only on loopback.
* Invalid/expired/consumed token → `401` and the connection is closed. The
  response body never echoes the token.
* The relay is transparent after the upgrade (Xpra's own ping/reconnect
  semantics apply); it closes when the session is torn down.
* The token must be treated as a secret by the client: it may appear in process
  arguments of the locally spawned Xpra client only; it is never written to
  logs, settings files, or telemetry.

### 4.4 Audit

Server audit events (existing activity log, no secrets):
`linux_apps.stream_token.issued`, `linux_apps.stream_token.denied`,
`linux_apps.stream.attached` (user id, session id, remote address class).

## 5. Xpra client invocation (client side)

```
<Xpra.app>/Contents/MacOS/Xpra attach <url> \
  --sharing=yes \
  --clipboard=yes --clipboard-direction=both \
  --audio=yes --speaker=on --microphone=no \
  --encodings=<profile encoding order> \
  --quality=<profile quality> --min-quality=<…> --speed=<…> --min-speed=<…> \
  --video-scaling=<…> --av-sync=yes \
  --opengl=auto --dpi=<detected scaling> \
  --no-mdns --no-printing --no-webcam --notifications=no \
  --exit-with-client=no
```

Exact flag set is validated in `poc/` and on macOS CI; unsupported flags are
dropped per Xpra version (the supervisor probes `xpra attach --help` once).

Supervision:

* `attach` is restarted on unexpected exit with a **fresh token**, backoff
  1 s → 2 s → 5 s → 15 s, at most 5 consecutive attempts, while the server
  session exists.
* If the RAST session ended (`GET /api/linux-apps/session` → null) the client
  stops retrying and says so.
* Detach (user or logout) kills the client; it never calls session-close.

## 6. Ownership and sharing policy (v1)

* One Xpra seamless session per RAST user (existing server behaviour).
* Browser (HTML5) and native desktop clients **may attach simultaneously** at
  this stage. Both observe the same server-owned windows. The native connection
  always uses `--sharing=yes`, exactly like the existing HTML5 viewer's
  `?sharing=yes` behaviour.
* Input: a client forwards only input that occurred on its own windows; no
  synthetic global input is generated. Arbitration/duplication behaviour is
  measured and documented in `docs/INPUT-CLIPBOARD.md`; the X11 window manager
  on the server remains authoritative for focus and geometry.
* Geometry: clients never set geometry for windows they do not host; the X11
  window manager owns sizes. Retina/scaling is applied client-side only.
* Focus: attaching/detaching a client never raises or focuses a window in
  another client; no automatic focus transfer.
* Future v2 (not implemented, must be verified on macOS before use): explicit
  single-owner mode where one client holds input ownership and the other is
  read-only, with token transfer.

## 7. Versioning

* Client header `X-RAST-Desktop: 1`.
* Server minimum: the RAST release that ships `desktop.streamTokens`
  (documented in the RAST CHANGELOG when merged). Older servers are refused
  with an actionable message.
* Breaking changes bump `protocol` to 2 and require a new document section;
  the client supports only protocol 1 until then.
