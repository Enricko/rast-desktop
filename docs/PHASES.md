# Mission phases — status and evidence

This is the single honest status board. `done` requires evidence committed in
this repository (or the RAST repository) and, for anything macOS-specific, a
real macOS build/test run (GitHub Actions macOS runners are real macOS
hardware; a physical user Mac is noted separately where applicable).

| Phase | Scope | Status |
| --- | --- | --- |
| 1 | Native Xpra proof of concept + measured comparison vs. HTML5 | in progress — Linux native-client harness + macOS runner verification |
| 2 | Desktop client foundation (Tauri, repo, architecture) | in progress |
| 3 | Authentication and session broker | in progress — `docs/PROTOCOL.md` v1 |
| 4 | Native application launcher UI | in progress |
| 5 | Native window integration (focus, resize, dialogs, Retina, monitors, restore) | not started |
| 6 | Native input and clipboard | not started |
| 7 | Performance optimisation | not started |
| 8 | Optional custom streaming engine | gated on Phase 1/7 measurements |
| 9 | Application compatibility matrix | not started |
| 10 | Packaging and distribution (macOS bundle, DMG, signing, notarisation) | not started |
| 11 | Git and release workflow | in progress — this repository initialised |

Detailed evidence is added per phase as it lands. Rules:

* Never mark a phase `done` without a command line that reproduces the result.
* Anything verified on Linux only is marked `Linux-only`.
* The offline physical Mac (`enrickos-macbook-air` in the Tailscale tailnet) is
  the only real user hardware; if it is unreachable, macOS verification uses
  GitHub Actions runners and the remaining gap is listed under "Blockers".
