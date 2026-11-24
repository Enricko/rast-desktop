# Building RAST Desktop on macOS

Status: build script and CI workflows are implemented and exercised on real
GitHub Actions macOS runners. The final `.dmg` packaging run is tracked in this
document with its run URL; **no build claim in this repository is made without a
real macOS run behind it**. Everything below that is not yet produced is marked
**BLOCKED** or **NOT VERIFIED**.

## What exists

| Piece | Path | Purpose |
| --- | --- | --- |
| Build entry point | `scripts/build-macos.sh` | universal (Apple Silicon + Intel) Tauri build, DMG verification, signing reality log, SHA-256 |
| CI | `.github/workflows/ci.yml` | Linux fmt/clippy/test/check + UI build; macOS cargo test + universal `.dmg`, uploaded as a workflow artifact |
| Release | `.github/workflows/release.yml` | on `v*` tags: universal `.dmg` + `SHA256SUMS-dmg.txt` attached to the GitHub Release |
| Native client verification | `.github/workflows/native-poc.yml` | Phase 1: official Xpra client attach evidence (see [PHASE1-MACOS.md](PHASE1-MACOS.md)) |
| macOS smoke | `.github/workflows/macos-smoke.yml` | feasibility: runner versions, network to RAST, official Xpra client install/run |

## Runner reality (verified 2026-11-24)

GitHub Actions standard hosted macOS images are what "real macOS hardware" means
for this project when no physical Mac is online:

| Label | CPU | OS seen in run | Notes |
| --- | --- | --- | --- |
| `macos-15` | arm64 (Apple M1 Virtual, 3 vCPU, 7 GB) | macOS 15.8.2 (24H232) | primary target |
| `macos-15-intel` | x86_64 | macOS 15.x (Intel image) | Intel coverage for the universal build |

`macos-14` and `macos-13` are **retired** by GitHub (macOS 14 images retired on
2026-11-02; see `actions/runner-images`); older references to those labels in
project notes are outdated — do not use them.

Toolchain observed on the arm64 smoke runner (evidence:
<https://github.com/Enricko/rast-desktop/actions/runs/45467052448>):

```
macOS 15.8.2 build 24H232      rustc/cargo 1.100.0     Xcode 16.4
Apple M1 (Virtual) arm64       node v22.23.5            npm 10.9.9
python3 3.15.2, jq, hdiutil, Homebrew 7.0.14
```

## Build from source on a Mac

Prerequisites: macOS 12+, Xcode command line tools, Rust stable (`rustup`),
Node 20+ (Node 22 is what CI uses).

```bash
# from the repository root
rustup target add aarch64-apple-darwin x86_64-apple-darwin
cd desktop && npm install && npm run build:ui && cd ..
scripts/build-macos.sh --output-dir dist
```

What the script does, in order:

1. refuses to run on non-macOS;
2. records environment facts into `dist/build-environment.txt`;
3. adds the two Rust targets;
4. builds the launcher UI (`npm run build:ui`, output `desktop/ui/dist`);
5. runs `npm run build -- --target universal-apple-darwin` inside `desktop/`
   (Tauri bundle: `.app` + `.dmg`);
6. locates the bundle under
   `desktop/src-tauri/target/universal-apple-darwin/release/bundle/`;
7. reports real facts: `lipo -info` (universal?), `codesign -dv --verbose=4`,
   `codesign --verify --deep --strict`, `spctl -a -vvv`, DMG SHA-256;
8. copies deliverables + checksums into `dist/`.

Exit codes: `0` built, `2` not macOS, `3` missing toolchain, `4` prerequisite
missing (e.g. the Tauri core has not landed on this ref), `5` build failed,
`6` build "succeeded" without a `.dmg` (treated as failure).

The Tauri configuration (`desktop/src-tauri/tauri.conf.json`, owned by the
desktop core) is the source of truth for bundle identity, minimum macOS version
and DMG layout. The build script does not modify it.

## Code signing and notarization — BLOCKED, documented honestly

**There is no Apple Developer ID certificate and no notarization credentials for
this project.** Therefore:

* the `.app` in the `.dmg` is **unsigned or ad-hoc signed** (Tauri bundler
  behaviour without a signing identity);
* **notarization is not performed**;
* Gatekeeper on another Mac will reject the app on first launch until the user
  explicitly allows it.

The build logs this reality instead of hiding it
(`dist/bundle-verification.txt`): `codesign -dv` shows a signature with
`Signature=adhoc`/no Authority (or `code object is not signed at all`), and
`spctl -a` rejects the app. Those exact values are preserved in the CI artifact
and in the workflow run log.

If a Developer ID certificate and Apple credentials are ever provisioned, the
Tauri bundler picks up `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD` and
`APPLE_TEAM_ID` automatically and the same logs will then show the real
signature/notarization result. Until that happens, no signing/notarization claim
may be made anywhere in the project.

### Gatekeeper install instructions given to users

```bash
# after downloading and verifying the checksum (see PACKAGING.md)
xattr -dr com.apple.quarantine "/Applications/RAST Desktop.app"
# or: System Settings → Privacy & Security → "Open Anyway"
```

Rationale and long-term fix: a Developer ID certificate + notarization (Apple
Developer Program) is required; that is a project/admin decision and is tracked
as a blocker, not as done work.

## Automatic updates — NOT IMPLEMENTED, NOT CLAIMED

No Tauri updater plugin is configured and no update endpoint exists. There is no
auto-update. Releases are manual downloads verified by SHA-256 (see
[PACKAGING.md](PACKAGING.md)). Auto-update must not be claimed or implied until
(a) an updater is implemented, (b) update signatures are configured, and (c) the
signing/notarization blocker above is resolved (macOS updaters require a
trustworthy signed app).

## CI notes

* The Linux job installs `libwebkit2gtk-4.1-dev`, `libayatana-appindicator3-dev`,
  `librsvg2-dev`, `patchelf` — required by Tauri 2 on Linux for `cargo check`.
* The macOS job adds both Rust targets and runs `scripts/build-macos.sh`, then
  uploads the `.dmg`, the `.app` and the verification logs as workflow
  artifacts (`rast-desktop-macos-dmg-<sha>`).
* Until `desktop/src-tauri/Cargo.toml` exists on the built ref, the build/test
  steps are skipped with a visible notice (the repository-sanity checks still
  run). This is intentional so CI does not lie about a build that cannot exist
  yet.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `must run on macOS` | the `.dmg` cannot be built on Linux; use a Mac or `macos-15` runner |
| `desktop/src-tauri/Cargo.toml is missing` | the Tauri core has not landed on this ref/branch yet |
| `no .dmg was produced` | the Tauri bundle step failed; see `dist/tauri-build.log` |
| `spctl: rejected` | expected: ad-hoc/unsigned build without notarization (see above) |
| UI shows blank window | `desktop/ui/dist` missing/empty — run `npm run build:ui` first |
| `xcodebuild` complaints about targets | `rustup target add aarch64-apple-darwin x86_64-apple-darwin` |

## Evidence log

| Run | What it proves | Result |
| --- | --- | --- |
| <https://github.com/Enricko/rast-desktop/actions/runs/45467052448> | macOS smoke: runner OS/arch/toolchain, RAST network, official Xpra 7.0-r0 client downloaded (SHA-1 verified), `--version`, `attach --help` on arm64 + Intel runners | ✅ success (both jobs) |
| `native-poc.yml` run | Phase 1 native client attach evidence | see [PHASE1-MACOS.md](PHASE1-MACOS.md) |
| `ci.yml` macOS job | `cargo test` + universal `.dmg` artifact | pending desktop-core landing on main; then re-run and recorded here |
| `release.yml` | tagged `.dmg` attached to a GitHub Release | pending the first version tag; workflow implemented |

Update this table in the same commit that produces new evidence. Never record a
run as successful without its URL.
