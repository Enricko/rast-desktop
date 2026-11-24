# Packaging and distribution

Status: the packaging **workflows and build script exist and are exercised on
real macOS runners**; the first public `.dmg` release is **not produced yet**
because the Tauri desktop workspace (`desktop/src-tauri/`, `desktop/ui/`) is still
landing on `main`. That gap is stated explicitly, not hidden. Signing and
notarization are **BLOCKED** (no Apple Developer ID certificate/credentials exist
for this project) and automatic updates are **NOT IMPLEMENTED**.

Related documents: [MACOS-BUILD.md](MACOS-BUILD.md) (how the `.dmg` is built),
[PHASE1-MACOS.md](PHASE1-MACOS.md) (native client verification),
[LICENSING.md](LICENSING.md) (Xpra GPLv2+ is not bundled).

## 1. Artifact types and naming

| Artifact | Produced by | Notes |
| --- | --- | --- |
| `RAST Desktop_<version>_universal.dmg` (exact name set by `tauri.conf.json`) | `scripts/build-macos.sh`, `ci.yml` (artifact), `release.yml` (GitHub Release) | universal: arm64 + x86_64 in one app; ad-hoc/unsigned |
| `SHA256SUMS-dmg.txt` | build script / release workflow | checksums for manual download verification |
| `RELEASE-NOTES.txt` | release workflow | commit, ref, runner, explicit "unsigned/not notarized" statement |
| Workflow artifact `rast-desktop-macos-dmg-<sha>` | `ci.yml` | CI build evidence (dmg + app + `bundle-verification.txt` + logs) |

Versioning: semantic versioning in `desktop/src-tauri/tauri.conf.json` /
`desktop/package.json`; GitHub Release triggered by a `v*` tag (e.g. `v0.1.0`).
The tag, the app version, and the release title must match. Version bumps and
CHANGELOG entries are release-manager steps; the workflow only builds/uploads.

## 2. Install (user-facing)

1. Download the `.dmg` from the GitHub Release (HTTPS).
2. Verify the checksum before opening it:
   ```bash
   shasum -a 256 -c SHA256SUMS-dmg.txt
   ```
3. Open the `.dmg`, drag **RAST Desktop.app** to `/Applications`.
4. First launch: the build is unsigned/not notarized, so Gatekeeper refuses it.
   Allow it explicitly:
   ```bash
   xattr -dr com.apple.quarantine "/Applications/RAST Desktop.app"
   ```
   or System Settings → Privacy & Security → **Open Anyway**.
5. Install the official Xpra client from <https://xpra.org> (not bundled —
   GPLv2+, see [LICENSING.md](LICENSING.md)). Verified version for Phase 1:
   Xpra **7.0-r0** (`Xpra.app`, downloads and SHA-1s in
   [PHASE1-MACOS.md](PHASE1-MACOS.md)); the desktop core probes
   `Xpra attach --help` and adapts its flags per version.
6. Configure the RAST server URL and sign in with the user's own RAST account.

The launcher UI is the project's own UI. Remote application pixels are only ever
rendered by the native Xpra client, never by the WebView.

## 3. Uninstall (user-facing)

There is no installer and no system daemon; uninstall is a removal of the app
bundle and the user's local state:

```bash
# 1. quit RAST Desktop (menu-bar item -> Quit) and remove the app
rm -rf "/Applications/RAST Desktop.app"

# 2. remove the stored session cookie from the macOS Keychain
#    (service: tech.lufria.rast-desktop, account: <username>@<server-url>)
security delete-generic-password -s tech.lufria.rast-desktop   # repeat per account

# 3. remove local settings/caches (exact paths defined by the desktop core)
rm -rf "$HOME/Library/Application Support/tech.lufria.rast-desktop"
rm -rf "$HOME/Library/Caches/tech.lufria.rast-desktop"
rm -rf "$HOME/Library/Preferences/tech.lufria.rast-desktop.plist"

# 4. the official Xpra client is a separate program: remove it only if unused
#    (drag /Applications/Xpra.app to the Trash)
```

Uninstalling the Mac app never stops remote applications: they keep running in
the user's server-side Xpra session by design. Use the launcher's
"End application/End session" actions before removing the app if the remote
processes should stop too.

## 4. Update verification stance (manual updates, no auto-update)

Updates are **manual downloads** for now:

1. Download the new `.dmg` from the GitHub Release page over HTTPS (GitHub is the
   only distribution channel).
2. Verify the SHA-256 checksum from `SHA256SUMS-dmg.txt` published in the same
   release before installing.
3. Compare the version shown in the release title/tag with the app version.
4. Replace the app in `/Applications`; user settings/Keychain survive because the
   bundle identifier is stable.

Trust model and its limits, stated honestly:

* TLS + GitHub release integrity is the transport trust; the SHA-256 checksum
  protects against corrupted/incomplete downloads, **not** against a compromised
  release account;
* because the app is **not signed with a Developer ID and not notarized**, macOS
  cannot verify the publisher; this is a real security gap for distribution to
  third parties;
* **auto-update is not implemented**: no Tauri updater plugin, no update server,
  no update signature keys. Do not claim or imply automatic updates.

Before automatic updates may be implemented: (a) obtain a Developer ID
certificate and notarize; (b) implement the Tauri updater with a signed update
manifest key pair; (c) document rollback; (d) update this section and
`docs/PROTOCOL.md` if the update feed is served by the RAST server.

## 5. Release process

1. Ensure `main` is green (`ci.yml` Linux + macOS jobs pass) and the desktop
   workspace is present.
2. Bump the version in `desktop/src-tauri/tauri.conf.json` and
   `desktop/package.json` (owner: desktop-core) and record it in the release
   notes.
3. Tag `v<version>` and push the tag: `git tag v0.1.0 && git push origin v0.1.0`.
4. `release.yml` builds on `macos-15`, uploads the `.dmg`, `SHA256SUMS-dmg.txt`
   and `RELEASE-NOTES.txt` to the GitHub Release (the release body already
   states the unsigned/not-notarized reality and the Gatekeeper override).
5. Verify the release page: asset present, checksum matches the local download,
   release notes state the signing gap.
6. Record the run URL in [MACOS-BUILD.md](MACOS-BUILD.md).

Pre-release dry run: `workflow_dispatch` the `release.yml` workflow to build the
`.dmg` and inspect the workflow artifact without publishing a GitHub Release
(the publish step is guarded by `startsWith(github.ref, 'refs/tags/v')`).

## 6. Verification matrix and current gaps

| Check | Status |
| --- | --- |
| Universal binary contains arm64 + x86_64 | verified by `lipo -info` in `dist/bundle-verification.txt` once a build runs |
| App launches on real macOS hardware | Phase 1 native client verification runs on `macos-15` runners; the Tauri app itself launches there too in the packaging job evidence (`tauri build` produces the app; interactive launch evidence is listed as remaining work) |
| DMG mounts, app copies to /Applications | verified manually when a DMG artifact exists (Tauri default DMG layout) |
| Code signature validity (Developer ID) | **BLOCKED**: no certificate; build is ad-hoc/unsigned |
| Notarization / Gatekeeper acceptance without override | **BLOCKED**: no Apple credentials |
| Automatic updates | **NOT IMPLEMENTED** |
| Notices file (`THIRD-PARTY-NOTICES`) in the app | **NOT IMPLEMENTED** (planned; see [LICENSING.md](LICENSING.md) §4) |
| Physical-Mac install test (not a hosted runner) | **NOT AVAILABLE**: the offline physical Mac is unreachable; all macOS evidence is from GitHub Actions runners and labeled as such |
| Intel real-hardware install test | runner-only (`macos-15-intel`); universal binary covers Intel but no physical Intel Mac was used |

## 7. What is intentionally not claimed

* Not notarized, not Developer-ID signed, not "safe for distribution by anyone
  but the project owner".
* No auto-update, no delta updates, no update feed.
* No App Store distribution (App Store requires signing/notarization and
  sandboxing decisions that are out of scope).
* Xpra is not bundled; the user installs it from xpra.org.
* No "works on all Macs" claim: evidence covers `macos-15` arm64 and
  `macos-15-intel` runners; a physical user Mac is listed as unavailable.
