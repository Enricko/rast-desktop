# Agent and contributor contract

This repository is developed by a small team of agents/contributors working in
parallel on the same checkout (`/home/lufria/rast-desktop` on the build host).
The RAST server repository is `/home/lufria/RAST`.

## Ground rules

1. **Truthfulness is a feature.** Never state that something works on macOS
   unless a real macOS build/run produced evidence in this repository. Record
   exact commands, versions, commit hashes and raw results. "Not verified yet"
   is an acceptable status; an unsupported claim is not.
2. **No unauthenticated streaming.** Xpra/X11 listeners stay on the server's
   loopback interface. The only public streaming entry point is the
   token-scoped WSS relay. Never add a bind on `0.0.0.0`, never disable auth,
   never print a stream token or cookie.
3. **Do not disrupt the live production user.** Testing uses the dedicated
   `t-*` accounts (`/home/lufria/.config/rast-test/creds`) and only that
   account's own native session. Never stop or restart another user's session
   or a system service that serves them.
4. **No secrets in the repository.** Never commit credentials, cookies,
   tokens, private keys, or screenshots containing them. Test credentials are
   read from `/home/lufria/.config/rast-test/creds` at runtime.
5. **Additive server changes only.** The browser HTML5 client must keep
   working. Document protocol changes in `docs/PROTOCOL.md` in the same commit.
6. **No Docker/VM/emulation and no WebView rendering of remote apps.** Those
   are product-level constraints; pull requests that violate them are rejected.
7. **Only the Lead deploys to the production server and merges to `main`.**
   Teammates work on their branch and push it. Teammates do not run
   `scripts/deploy-release.sh` or edit `/etc/rast/*`, systemd units, or nginx.
8. **Commit/push milestones.** Conventional commits (`feat:`, `fix:`,
   `docs:`, `test:`, `chore:`), no force-push, rebase on `origin/main` before
   pushing.

## Ownership / write scopes

| Scope | Owner | Files |
| --- | --- | --- |
| Repo skeleton, architecture, protocol, phases, final integration | **Lead** | `README.md`, `LICENSE`, `AGENTS.md`, `docs/ARCHITECTURE.md`, `docs/PROTOCOL.md`, `docs/PHASES.md`, `docs/SECURITY-MODEL.md`, `docs/LICENSING.md`, `poc/**` |
| Tauri Rust core | **desktop-core** | `desktop/src-tauri/**`, `desktop/package.json`, `desktop/package-lock.json` |
| Launcher UI | **desktop-ui** | `desktop/ui/**` (except generated `desktop/ui/dist`), `desktop/ui/package.json` |
| CI/CD, macOS runners, packaging | **macos-ci** | `.github/workflows/**`, `scripts/**`, `docs/MACOS-BUILD.md`, `docs/PACKAGING.md` |
| RAST server broker | **server-broker** | in `/home/lufria/RAST`: `src/linux_apps/native_broker.rs` (new), `src/linux_apps/mod.rs`, `src/api/linux_apps.rs` (additive), `src/main.rs`/`src/lib.rs` routing wiring, `docs/API.md`, `docs/NATIVE-BROKER.md`, inline `#[cfg(test)]` tests |

Advisory only: coordinate before touching another owner's files.

## Layout and commands

```
desktop/                Tauri 2 application
  package.json          npm scripts: dev, build (UI), tauri
  ui/                   Vite + TypeScript launcher UI (no framework)
  src-tauri/            Rust core (crate `rast-desktop`)
poc/                    Phase 1 native Xpra harness (Node 20)
.github/workflows/      CI: Linux check, macOS build, native verification
scripts/                helper scripts
```

Local verification (Linux is enough for compile checks):

```bash
cd desktop && npm install
npm run build:ui                                  # vite build -> ui/dist
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets
cargo test  --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml  # needs webkit2gtk-4.1 on Linux
```

macOS-only: `npm run tauri build` (DMG bundling) — always executed on GitHub
Actions macOS runners and recorded in `docs/MACOS-BUILD.md`.

Server verification:

```bash
cd /home/lufria/RAST && cargo test --locked --lib
scripts/deploy-release.sh   # Lead only, as root
```

## Coordination

* Each owner posts a short status to the Lead after: branch pushed, first green
  test, blocker found, or work complete.
* Shared interface questions go to the Lead; the Lead updates
  `docs/PROTOCOL.md` and notifies everyone.
* The Lead runs the final acceptance and writes the results, commit hashes and
  remaining blockers.
