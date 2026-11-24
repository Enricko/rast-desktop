# Licensing

Status: **current design (v1)** — RAST Desktop is MIT-licensed and **does not
bundle or redistribute the Xpra client**; the user installs the official client
from [xpra.org](https://xpra.org). Bundling is documented below as a **future
decision with concrete GPLv2+ obligations**, not as something already done.

If a bundled build is ever shipped, this document is the compliance checklist
that must be updated *before* the first such release, together with the
`THIRD-PARTY-NOTICES` generation step in the release workflow.

## 1. RAST Desktop itself

| Component | Where | License |
| --- | --- | --- |
| RAST Desktop repository (this one, `desktop/`, `scripts/`, docs) | macOS app + repo | **MIT** — see [LICENSE](../LICENSE) |
| RAST server (separate repository) | Linux server | see the RAST repository |

MIT is compatible with the GPLv2+ (MIT code can be included in a GPLv2+
work); the reverse direction matters only if GPL code is linked into RAST
Desktop, which it currently is not (separate process, user-installed).

## 2. Xpra (external program, GPLv2+)

**Facts**

* The official Xpra client is licensed **GPLv2 or later** (`COPYING` in the
  [Xpra repository](https://github.com/Xpra-org/xpra)).
* RAST Desktop starts it as a **separate subprocess**: `<Xpra.app>/Contents/MacOS/Xpra attach …`.
  The app does not link against Xpra libraries, does not copy Xpra code into the
  Tauri binary, and ships no Xpra binary or Python files inside its own bundle.
* The client is downloaded from xpra.org by the **user** (README "Requirements")
  or **by CI only for testing** (`scripts/macos/install-xpra-client.sh`), and is
  never committed to this repository nor included in a RAST Desktop release
  artifact. CI evidence uploads do not contain the Xpra binary.
* macOS Xpra.app builds are distributed unmodified by the Xpra project from
  xpra.org. RAST Desktop pins the exact builds used for verification and records
  their SHA-1 in CI (see [PHASE1-MACOS.md](PHASE1-MACOS.md)).

**What "separate program invoked by the user" means legally**: the GPL does not
reach RAST Desktop merely because a user runs a GPL program alongside it. There
is no derivative work and no distribution of Xpra by this project in v1.

**If Xpra is ever bundled inside the RAST Desktop .dmg/.app** (not in v1), the
following obligations apply and must be met:

1. **Distribute Xpra in GPLv2+-compliant form**: include the complete
   corresponding source of the exact Xpra version shipped (or a written offer
   valid for three years, GPLv2 §3), the upstream build scripts, and any patches
   applied. The Xpra project already publishes tarballs; the DMG build recipe
   for macOS must be included as well.
2. **License compatibility**: the combined distribution must be licensed under
   GPLv2+ as a whole *if it is a single work*. MIT code is compatible, so RAST
   Desktop's own code can remain MIT with GPLv2+ obligations attached to the
   combination; keep the MIT notice and add the GPL notice/source offer.
3. **No additional restrictions** on the GPL parts (GPLv2 §6): do not add EULA
   terms, DRM, or code-signing restrictions that forbid copying/modifying Xpra.
4. **Version pinning + security tracking**: bundle a specific, documented Xpra
   version, monitor Xpra security advisories/CVEs, and rebuild + re-release —
   bundling shifts update responsibility from the user to this project.
5. **Trademark/branding**: "Xpra" and its logo belong to the Xpra project; do not
   imply it is part of RAST Desktop or endorsed by the Xpra authors.
6. **Mixed third-party Python dependencies**: the macOS Xpra.app contains many
   third-party components with their own licenses (LGPL, BSD, MIT, Apache etc.).
   A bundled build must ship the union of their notices (`THIRD-PARTY-NOTICES`),
   which is materially more work than v1's separate-process design.
7. **Update the docs and the release checklist in the same change**: README
   "Requirements", `docs/PACKAGING.md` install/update flow, and this file.

**Decision for v1 (documented product decision):** do not bundle; require the
user to install the official client from xpra.org. This keeps the MIT project
simple, avoids redistributing a GPLv2+ program, and keeps security updates with
upstream + the user.

## 3. Build/runtime dependencies shipped in the .app

| Dependency | License | Notes |
| --- | --- | --- |
| [Tauri 2](https://tauri.app) (`tauri`, `tauri-build`, `tauri-runtime-wry`, wry) | MIT or Apache-2.0 | Rust crates linked into the macOS binary |
| [wry](https://github.com/tauri-apps/wry) / WKWebView | MIT or Apache-2.0 / Apple system framework | launcher UI only; remote app pixels never in the WebView |
| Rust standard library + linked crates | typically MIT or Apache-2.0 | exact set per `Cargo.lock` |
| macOS system frameworks (AppKit, WebKit, Security/Keychain, Foundation, …) | Apple SDK license | not redistributed; linked against the OS |
| Launcher UI assets in `desktop/ui/` | MIT (this repo) | no runtime framework: Vite/TypeScript build output only |
| Fonts/icons shipped with the UI | must be MIT/OFL-compatible | check before adding a third-party asset |

Dev-only tooling (Node, Vite, TypeScript, GitHub Actions, Playwright, Xpra CI
downloads) is **not** shipped inside the `.app` and does not need to be
redistributed; Playwright's browser binaries are used on CI runners only.

## 4. Third-party notices approach (planned, not yet shipped)

* Generate an inventory from the real dependency graph at release time:
  * Rust: `cargo about generate` or `cargo deny list` (choose one at release
    implementation; `cargo metadata`/`Cargo.lock` is the source of truth);
  * UI: check the production bundle only (`desktop/ui/dist`), not devDependencies;
  * Xpra: separate program, excluded by design in v1.
* Commit the generated notices as `THIRD-PARTY-NOTICES` in the release assets
  and place a copy in the `.app` (`Contents/Resources/THIRD-PARTY-NOTICES`) so it
  ships with the binary.
* The current workflows do **not** generate this file yet — this is explicitly a
  gap, tracked under packaging in [PACKAGING.md](PACKAGING.md). Do not claim a
  notices file exists until it is committed in a release.

## 5. Repository hygiene

* No secrets or credentials in the repository: test accounts live outside the
  repository (`/home/lufria/.config/rast-test/creds`) and CI uses GitHub
  secrets; logs are redacted by the native verification script.
* Downloaded external binaries (Xpra .dmg) are fetched at run time, SHA-1
  verified against the value published by xpra.org, and never committed.
* Evidence artifacts may contain screenshots of the remote test user's
  applications. Test accounts only — never a real user's session.

## 6. Questions this document answers

* *Does shipping RAST Desktop require GPL compliance?* Not in v1: Xpra is a
  user-installed separate program; the MIT app does not contain or link GPL code.
* *What changes if Xpra is bundled?* Section 2 applies in full: source offer,
  GPL-compatible combination, notices, version pinning, update responsibility.
* *Is the DMG's Gatekeeper/signing situation a licensing issue?* No — Apple's
  code-signing and notarization are distribution/security requirements, covered
  in [MACOS-BUILD.md](MACOS-BUILD.md) and [PACKAGING.md](PACKAGING.md).
