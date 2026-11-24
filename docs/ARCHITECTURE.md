# Architecture

RAST Desktop is a macOS application that lets a person work with applications
installed on their own RAST Linux server as if they were local macOS apps.

## What it is

| Layer | Runs where | Responsibility |
| --- | --- | --- |
| **Launcher UI** | macOS, inside the RAST Desktop WebView | Connected-server header, app discovery/search/categories, favourites, recents, running apps, connection quality, settings. Own UI only. |
| **Desktop core** (Rust) | macOS | Login, Keychain credential storage, RAST API client, session broker client, Xpra client supervision, app/run lifecycle, settings persistence, tray menu. |
| **Xpra native client** (official, external) | macOS | Receives the Xpra seamless stream and creates one real macOS window per remote top-level window; native input, clipboard, audio, scaling, multi-monitor. Spawned and supervised as a subprocess. |
| **RAST server** (existing) | Linux server | Authentication/authorisation, native Linux app inventory, launch/stop APIs, per-user Xpra seamless session, window state, isolation. New in this project: a short-lived stream-token broker and authenticated native WebSocket relay. |
| **Xpra session** (existing) | Linux server | Per-user seamless X server (Xvfb or GPU Xorg) where the Linux applications run. Bound to loopback only. |

## Hard rules (from the mission)

1. **No Docker, containers, VMs or Linux emulation.** Applications execute as
   native processes on the remote Linux server. The macOS app never emulates.
2. **No website wrapper.** The launcher UI is our own UI; the RAST web
   interface is not embedded or iframed anywhere in the product.
3. **No full remote desktop in a viewer.** Xpra seamless mode is used: every
   remote top-level window is forwarded separately. The remote Xpra toolbar,
   remote window decorations and remote desktop background are never shown.
4. **No rendering in a WebView.** Remote application pixels only ever come from
   the native Xpra client's AppKit windows.
5. **No unauthenticated Xpra/X11 ports.** Xpra keeps listening on the server's
   loopback interface; the only remote entry point is the authenticated HTTPS
   API and the token-scoped WSS relay.
6. **No root, no shell.** The Mac user never gets a shell or root on the
   server; the desktop client speaks the RAST API and the stream broker only.
7. **Per-user isolation and server-side state.** One Linux identity and one
   Xpra session per RAST user; windows and applications live on the server, so
   detaching or quitting the Mac client never kills them.
8. **The browser client keeps working.** Every server change is additive and
   backwards compatible; the HTML5 desktop remains fully supported.

## Why the official Xpra client

Xpra's macOS client already implements the hard parts of native integration:
seamless AppKit windows, keyboard mapping, clipboard, audio, Retina scaling,
multi-monitor and reconnection. Phase 1 measures whether that client is good
enough before any custom engine is written (Phase 8 is explicitly gated on a
measured bottleneck).

In this design the Xpra client is a **managed subprocess**, not a library: RAST
Desktop starts it with a tokenised WSS URL, watches it, restarts it on
unexpected exit with a fresh token, and kills it on detach/logout. It is **not
bundled or redistributed** by RAST Desktop at this stage — the user installs
the official build from xpra.org (see [LICENSING.md](LICENSING.md)).

Consequence, stated honestly: all forwarded application windows belong to the
Xpra client process. Its app icon appears in the Dock/⌘-Tab, not one icon per
remote application. Per-application macOS identity is *not* claimed. See
[PHASES.md](PHASES.md) Phase 5.

## Data flow

```
                        1. login (HTTPS, cookie)          RAST server
  Launcher UI ──invoke──▶ Desktop core ──────────────────▶ /api/auth/login
                                │ stores cookie in Keychain
                                │
                          2. app inventory
                                │◀───────────────────────── /api/linux-apps
                                │
                          3. launch (authenticated)
                                │─────────────────────────▶ /api/linux-apps/{id}/launch
                                │                          starts/uses the per-user Xpra session
                                │
                          4. stream token (short-lived, single use)
                                │─────────────────────────▶ /api/linux-apps/session/stream-token
                                │◀───────────────────────── {url: wss://…/linux-apps/native/<token>/}
                                │
                          5. spawn xpra attach <url> (sharing, clipboard, audio)
                                │── subprocess ──▶ Xpra.app ──── WSS ───▶ broker relay ──▶ loopback Xpra
                                │                                              (seamless windows)
                          6. one macOS window per remote window; native input/clipboard/audio
```

## Connection paths

* **Public path (default):** macOS → HTTPS/WSS `public_url` → reverse proxy
  (Cloudflare tunnel + nginx on the server host) → RAST → loopback Xpra. Same
  authenticated path as the browser client.
* **Private path (optional, Phase 7):** a private VPN/LAN route to the same
  RAST HTTPS endpoint. It is the same authenticated endpoint, just over a
  shorter network path; no new port, no reduced authentication. The launcher
  lets the user configure the server URL; it does not bypass TLS or auth.

## Launcher vs. streaming window lifecycle

* Closing the launcher window hides the launcher; the desktop core keeps
  running (macOS menu-bar item), so forwarded application windows stay usable.
* "Detach windows" / quitting RAST Desktop stops the local Xpra client only.
  **Remote applications keep running** (server-side state), and reconnecting
  restores their windows.
* Only "End application" / "End session" in the launcher stops the remote
  processes (explicit RAST API calls).

## Alternatives considered

| Option | Why not (now) |
| --- | --- |
| Embed the RAST HTML5 desktop in a WebView (Electron/Tauri) | Forbidden by the mission; renders remote pixels in a WebView and reproduces the whole Web OS. |
| RDP/VNC/SPICE full-session viewer | Forbidden: renders the whole remote desktop, not independently managed application windows. |
| Reimplement the Xpra protocol in Rust immediately | Phase 8 is gated on measurement; reusing the official client first is the required sequence. |
| Bundle Xpra inside the .app | Licensing and update/security obligations; deferred and evaluated in [LICENSING.md](LICENSING.md). |
| Per-window VNC on the legacy Docker backend | The native Linux apps runtime is the supported production runtime; legacy streaming is out of scope. |
