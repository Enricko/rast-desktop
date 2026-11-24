# RAST Desktop

Native macOS client for [RAST](https://github.com/Enricko/rast) that runs Linux
applications from your own remote Linux server as **independent local desktop
windows** — while the application processes keep running on the server.

RAST Desktop is a **launcher, session broker client and window host**, not a
wrapped website and not a remote-desktop viewer:

* the launcher, settings, application discovery and connection management are a
  [Tauri 2](https://tauri.app) application (Rust core + macOS Keychain);
* each remote application window is rendered by the **official native Xpra
  client** running as a managed subprocess on the Mac, in *seamless* mode — one
  real macOS window per remote top-level window, delivered by the native client,
  never by a WebView and never as a full Linux desktop;
* authentication, application discovery, launch requests and streaming access
  are brokered by the existing RAST server over its authenticated HTTPS API.
  Short-lived, single-use stream tokens authorise the native streaming
  connection; Xpra and X11 ports stay bound to the server's loopback interface
  and are never exposed.

```
 macOS (this repository)                        Linux server (Enricko/rast)
┌──────────────────────────────┐   HTTPS     ┌────────────────────────────────┐
│ RAST Desktop (Tauri)         │────────────▶│ RAST server API (auth, apps,    │
│  launcher / settings / auth  │             │ launch, stream-token issuance) │
│  Keychain credential storage │             └──────────────┬─────────────────┘
│  Xpra supervisor             │   WSS (short-lived token)   │ loopback only
│        │ spawns              │────────────────────────────▶│ authenticated
│        ▼                     │                             │ native relay
│ Xpra.app (official client)   │                             ▼
│  one macOS window per        │                   Xpra seamless session
│  remote top-level window     │◀──────────────────  (Xvfb or GPU Xorg)  │
└──────────────────────────────┘   Xpra protocol         remote Linux apps
```

## Status

RAST Desktop is under active development. Verified vs. not-yet-verified status
is tracked honestly in [docs/PHASES.md](docs/PHASES.md); the macOS build and
the native-client verification are produced on real macOS runners in GitHub
Actions. Nothing here claims a macOS feature that has not been built or tested
on real macOS hardware.

## Repository layout

| Path | Contents |
| --- | --- |
| `desktop/` | Tauri application: `ui/` (launcher UI) and `src-tauri/` (Rust core) |
| `poc/` | Phase 1 native Xpra proof-of-concept harnesses and measurements |
| `docs/` | Architecture, protocol, security model, phases, licensing |
| `scripts/` | Build, verify and release helpers |
| `.github/workflows/` | CI (Linux + macOS), macOS packaging, native-client verification |

## Documentation

* [Architecture](docs/ARCHITECTURE.md) — components, decisions, non-goals.
* [Protocol](docs/PROTOCOL.md) — client/server contract, stream-token broker.
* [Security model](docs/SECURITY-MODEL.md) — authentication, tokens, isolation.
* [Phases](docs/PHASES.md) — mission phase status and evidence.
* [Licensing](docs/LICENSING.md) — Xpra licensing obligations.
* [Agent/contributor contract](AGENTS.md) — repository conventions and scopes.

## Requirements

* macOS 12 or newer (Apple Silicon primary, Intel where feasible);
* the official Xpra macOS client installed by the user (`Xpra.app`, from
  [xpra.org](https://xpra.org)) — RAST Desktop does not redistribute it; see
  [docs/LICENSING.md](docs/LICENSING.md);
* a RAST server (see the [RAST repository](https://github.com/Enricko/rast))
  with native Linux applications enabled, reachable over HTTPS.

RAST Desktop itself is built with Rust and Tauri. The launcher UI is a WebView
**of our own UI only**; remote application rendering is never inside a WebView.

## Building (development)

```bash
# Prerequisites: Node 20+, Rust stable, Tauri 2 CLI (installed via npm)
cd desktop
npm install
npm run tauri dev      # development app
npm run tauri build    # macOS bundle (must run on macOS)
```

Linux development machines can typecheck and `cargo check` the core
(`webKit2gtk` 4.1 required); producing a macOS `.app`/`.dmg` requires macOS or
the GitHub Actions macOS runners.

## License

MIT — see [LICENSE](LICENSE). The Xpra client is an external program with its
own license (GPLv2+); RAST Desktop does not link against or redistribute it in
the current design.
