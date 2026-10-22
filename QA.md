# Release verification · v3.2.0 · 2026-10-21

Tests use Dan's locally supplied original US ROM. No ROM, save, screenshot or extracted game data is committed or served. Reports and visual evidence stay in ignored `artifacts/`.

## Completed checks

- **18 Node tests**: Xbox/N64 mapping and ROM normalization; HTTP confinement, room lifecycle, host authority, reserved reconnects, revision checks, protocol 4, direct sharing and password gating; winner choice for time/stock/teams, no contest, synchronization and replacement ports.
- **11 phone/gameplay checks** in Chrome using independent desktop and mobile contexts. Real multi-touch events verify stick + A + B together, all 14 N64 buttons, pointer cancellation and rotation. The phone joins a shared lobby, chooses a fighter and wins a real one-stock match against an unlocked Luigi. On the next stage screen only the winner can move or confirm. Shared Menu/resume preserves that choice. The winner starts an actual battle on unlocked Mushroom Kingdom. Zero browser errors or unexpected state repairs; the final two-browser segment rendered at 60 FPS. `artifacts/mobile-check.json`.
- **3 WebKit checks** with a phone viewport: the pinned WASM core loads and renders the native menu, all fighters are unlocked, a multiplayer room opens, pointer input selects Luigi, portrait/landscape fit, and Menu/resume works. `artifacts/webkit-check.json`. This exercises desktop WebKit with mobile emulation, not physical iPhone hardware.
- **7 native rules checks**: testing password, real name typing, rename propagation, guest inheritance, a real two-human four-stock/no-items battle, rematch rule preservation and unlimited Time. `artifacts/settings-check.json`.
- Visual inspection of portrait 390 × 844 and landscape 844 × 390 menus, character selection, stage selection and battle. All 12 portraits and Mushroom Kingdom are visible. Controls remain outside the 4:3 game area; landscape Menu/Start overlay the picture as in the supplied reference.
- Syntax, linked assets, pinned JS/WASM hashes and ROM exclusion pass. Corresponding source is rebuilt before release.

## Multiplayer behavior

Native results (scene 24) supply ranking, points and KOs. The host picks first; afterward the winner picks. Teams use points, KOs, then controller port to select the winning team's representative. No contest retains the previous choice; if that person leaves, the host chooses. Identity, not just port number, persists in synchronization metadata.

Every peer reads at a fixed simulation-frame cadence and neutralizes other players' stage-selection inputs before advancing the emulator. Menu polling occurs every six frames, before stage selection's native ten-tick input guard. Battle/results polling occurs every thirty frames to reduce copying on phones. UI reads reuse those observations. Character-selection Start waits until the native first-second input guard expires, including on rematches.

Session preparation sets native backup unlock flags and the twelve-fighter mask through the official serializer. Online room setup keeps Stage Select enabled. ROM bytes and shipped runtime binaries are unchanged. Canvas rendering remains active underneath loading overlays.

## Sharing

Invites and the desktop Friends Link use the current direct Cloudflare URL. Framing is disabled. The old GitHub page only redirects to Cloudflare and preserves room invitations. Routine backend restarts retain the tunnel; a full service restart can rotate it and refreshes the desktop shortcut and optional legacy redirect.

## Practical limits

- Delayed lockstep, no rollback. Physical phone speed and geographically separated networks still affect responsiveness; local multi-browser tests do not certify those conditions.
- Physical Xbox/N64 pairing requires the actual devices. Test contexts exclude Dan's real paired controllers and use isolated simulated inputs.
- The pinned core exposes four native controller ports; unused hands can appear before friends join. Named indicators show actual people. New arrivals wait for character selection during an active match.
- The renderer emits nonfatal WebGL uniform warnings; screenshots must have a live rendering context.
- Storage is per game origin. A new tunnel address can require the ROM or testing password again. Host localhost storage stays stable.
- The laptop must stay on and awake while hosting. Moving the service to an awake Mac mini allows the laptop to be off.
