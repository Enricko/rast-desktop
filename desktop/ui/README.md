# RAST Desktop launcher UI

The macOS launcher UI of [RAST Desktop](../../README.md): server setup, sign-in,
application discovery/search/favourites/recents, launching, streaming status and
settings.

It is **own UI only**. Remote application pixels are rendered by the official
native Xpra client (one real macOS window per remote window); this WebView never
renders remote content and never performs HTTP. Everything network-, Keychain-
and Xpra-related happens in the Rust core (`desktop/src-tauri`), which the UI
reaches through Tauri `invoke` commands and events. The interface contract is
[`desktop/UI-CONTRACT.md`](../UI-CONTRACT.md).

## Stack

- Vite + TypeScript, **no UI framework** (hand-built DOM, ~70 kB JS / ~35 kB CSS
  before gzip).
- Runtime dependency: `@tauri-apps/api` only.
- Build output: `desktop/ui/dist` — referenced by `desktop/src-tauri/tauri.conf.json`
  (`frontendDist`); the Tauri dev server expects **http://localhost:5173**.
- Fonts: system stack (`-apple-system`, SF Pro fallback) — nothing is downloaded
  at runtime; compatible with the core's strict WebView CSP (`img-src 'self' data:`,
  no remote `connect-src`).

## Commands

```bash
cd desktop/ui
npm install            # dependencies (vite, typescript, @tauri-apps/api)

npm run dev            # Vite dev server on http://localhost:5173 (used by `tauri dev`)
npm run build          # tsc --noEmit && vite build -> dist/
npm run typecheck      # tsc --noEmit
npm run mock           # build, then serve dist/ for browser preview on :4173
npm run screenshots    # serve dist/, drive headless Chromium, write docs/screenshots
```

`npm run build` runs on Linux (no Mac required) and is what
`npm --prefix ui run build` in `desktop/package.json` executes.

## Screens and states

| Screen | Notes |
| --- | --- |
| First run / server setup | HTTPS-only URL validation, capability check, actionable errors ("needs a newer RAST"). |
| Sign in | Username/password, "Remember me" (session in the macOS Keychain via the core), honest 401/403/429/network error copy. |
| Launcher | Header (server + RAST version, signed-in user, connection-quality indicator with basis label, settings), sidebar (All/Favorites/Recent/Running/categories + counts), fuzzy search, grid/list views, app cards with icons, running badges, favourite toggle, launch action; "Running now" panel with per-app streaming state, *End application*, *Detach windows*, *End session*; skeleton/empty/error/offline states; keyboard navigation. |
| Settings dialog | Server (change server → re-login), quality profile (balanced/responsive/high), clipboard and audio toggles, Xpra path override + check, detach-on-quit, start-at-login (hidden while the core reports it unsupported), About block, sign out. |
| About dialog | Client, server, desktop-protocol and Xpra versions/status, plus the explicit statement that remote windows are Xpra windows, not WebView content. |

Launching is asynchronous: the UI shows `launching → connecting → attached` (or
`reconnecting`/`detached`/`failed` with the core's safe message) from
`launch-state` / `stream-status` events, and always keeps *End application* and
*Detach windows* distinct: ending stops remote processes, detaching only closes
the local windows.

Connection quality is deliberately labelled as **server reachability** (the
core's `basis: "https-reachability"`), not as a video-quality measure.

## Bridge and mock mode

- `src/bridge.ts` — the single adapter to the Rust core: one `invoke` per
  contract command, one event subscription per contract event. Errors are
  normalised to the contract's `{ code, message, action? }` shape (`src/errors.ts`)
  so screens branch on codes, never on raw strings.
- `src/mock.ts` — a full mock bridge with representative fixture data (12 mixed
  managed/discovered applications) used for browser development and for the
  committed screenshots. It is selected automatically when Tauri internals are
  absent; `VITE_RAST_MOCK=1` forces it for harnesses that shim Tauri globals.
  The mock never contacts a network and never stores credentials. The launcher
  footer labels mock mode as demo data.
- `src/types.ts` — the contract types (`ClientState`, `AppsView`, `StreamStatus`,
  `ConnectionState`, `Settings`, events, …).

Mock scenarios (`?state=`):

| Scenario | Shows |
| --- | --- |
| `first-run` | No server configured (default first-run screen) |
| `login` | Server configured, signed out |
| `launcher` (default) | Signed in, 12 applications |
| `list` | Same inventory in list view |
| `running` | Two attached applications + running panel |
| `settings` / `about` | Launcher with the dialog open |
| `reconnect` | Repeating Xpra reconnect loop (events) |
| `offline` | Server unreachable, last inventory shown |
| `error` | `list_apps` fails → error state with retry |
| `loading` | Inventory never resolves → skeleton state |
| `empty` | Signed in, no applications |
| `unsupported` | Server without RAST Desktop capability ("needs a newer RAST") |
| `xpra-missing` | Xpra.app not installed → honest install hint, failed stream |

The mock sign-in accepts any username with a password of 4+ characters; use
password `change-me` (403 password change), username `rate-limited` (429) or an
unknown username (401) to preview error handling.

## Screenshots

Committed verification PNGs were produced **from the production build** by
`npm run screenshots` (static `dist/`, headless Chromium from
`~/.cache/ms-playwright`, `?capture=1` freezes animations):

```
docs/screenshots/launcher-{first-run,login,grid,running,settings}-{1440x900,1024x700}.png
```

These are WebView-content captures at the requested viewport sizes; the native
window frame/titlebar is provided by macOS (Tauri), not drawn by the UI.

## Privacy and persistence rules

- No `fetch`/`XMLHttpRequest`/WebSocket calls from the UI; the CSP only allows
  local assets and Tauri IPC.
- No cookies, CSRF tokens, stream tokens or session URLs are ever available to
  the UI (see contract rules).
- No `localStorage`/`sessionStorage` for credentials; non-sensitive preferences
  are persisted by the core via `get_settings`/`save_settings`.
- Icons are fetched by the core and rendered only as `data:` URLs from
  `app_icons`; relative `iconUrl` values are diagnostics-only and never loaded.
- Remote applications are never rendered in this WebView, and hiding/closing the
  launcher never stops them.

## Known limitations (honest)

- Start-at-login is hidden because the core reports `startAtLogin.supported =
  false` in v1; the UI implements the row for when it becomes supported.
- `detachOnQuit` is accepted by the core but v1 always detaches the local client
  on quit (remote applications keep running either way).
- Screenshot verification is **Linux-only**; native macOS window behaviour is
  verified by macOS CI in `.github/workflows` (owned by `macos-ci`).
- Mock fixtures are demo data, clearly labelled in the UI footer.
