# Release verification · Smash Portal v3.3.0 · 2026-10-22

- **21 Node tests** pass, including seekable H.264 video delivery (byte ranges, suffixes, HEAD, malformed ranges), revoked-tunnel log detection, outage thresholds, and the existing controller/room/winner tests.
- **17 public-route checks** pass on v3.3.0 using four isolated Chrome browsers and `https://give-legislation-stationery-foot.trycloudflare.com`: actual four-human battle, two-player rematch, direct-to-relay packet recovery, deliberate desync repair, shared pause, reserved reconnect, host exit, saves and reload persistence. The synchronized rematch recorded 124 matching state checks and zero unexpected repairs at 53 FPS; after the reconnect segment the two clients reported 57/58 FPS. All clients ran on this laptop, so this measures the public route under a multi-browser workload, not geographically separated play. Zero uncaught browser errors. `artifacts/portal-public-four.json`.
- **7 Portal flow and branding checks**: native opening → any key/tap → title → ROM overlay; invalid ROM rejection; original idle tutorial; verified and cached ROM handoff to actual Mode Select; controller Start/A and held-button guards; actual 1P Mode; brand fonts, idle/hover colors, create/join/controller dialogs and responsive desktop/phone/landscape layouts. `artifacts/portal-check.json` and `portal-*.png`.
- Fresh-browser controller startup also passes with Chrome's strict user-activation policy. An injected browser `NotAllowedError` separately verifies that blocked audio falls back to moving muted footage; controller navigation still opens the ROM gate, and Sound On enables audible playback after a click. `artifacts/portal-autoplay.json`.
- **7 native settings checks** pass: testing access, real typing, four-stock/no-items setup, rules inherited by a guest, rename propagation, actual battle, rematch persistence and unlimited Time. `artifacts/settings-check.json`.
- **11 phone checks** pass, including three-finger controls, all 14 buttons, cleanup on rotation, an unlocked fighter, a real guest victory, winner-only stage choice and a Mushroom Kingdom rematch. The two-browser phone segment ran at 60 FPS, 7 ms measured RTT and zero unexpected repairs. This is local browser emulation, not a claim about inter-city latency. `artifacts/mobile-check.json`.
- **3 WebKit phone checks** pass: WASM/native menu, full roster, room creation, touch fighter selection, landscape and shared Menu/resume. `artifacts/webkit-check.json`.
- Public v3.3.0 health, branded HTML/JS/CSS/logo/fonts, ranged video delivery, the desktop shortcut, and the legacy GitHub redirect have been checked against the running Cloudflare origin. `artifacts/portal-public-assets.json`.
- The legacy bookmark redirects directly to the live origin, with fullscreen/Gamepad permission available and an incorrect testing password rejected. `artifacts/direct-check.json`.

The supplied logo is used without repainting. Josefin Sans Semibold, Instrument Sans Condensed Medium Italic and Orbitron Medium are served locally with OFL notices. Native game pixels and rules remain native. Startup recordings stop decoding and release their network sources before gameplay. New rooms default to four input-buffer frames; larger buffers remain available for distant connections. The emulator binaries and netplay protocol are unchanged.

The Cloudflare host now waits for a publicly verified endpoint before advertising it. Log detection recreates a revoked Quick Tunnel even when cloudflared keeps retrying without exiting. Health checks are spaced at 20 seconds; startup has a three-minute DNS/registration grace period, and three consecutive failures recycle an established connection. Initial tests exposed macOS negative DNS caching for new tunnel names; the grace period prevents premature rotation. No system DNS settings were changed.

# Previous release · v3.2.0 · 2026-10-21

Tests use Dan's locally supplied original US ROM. No ROM or savestate is committed or served as a static asset. The v3.3.0 opening/title/attract recordings are intentionally served audiovisual previews; live emulation still requires ROM verification. QA reports and screenshots stay in ignored `artifacts/`.

## Completed checks

- **17 public-route four-browser checks** passed on v3.2.0 at `https://wider-reduced-makers-aims.trycloudflare.com`: four-human battle, two-player rematch at 60 FPS, zero unexpected repairs, a deliberately corrupted state repaired, relay fallback after a dropped input, pause/resume, reserved reconnect, host exit, saves and controller persistence. Zero uncaught browser errors. `artifacts/e2e-native-public-four.json`.
- **Direct public sharing verified:** the old GitHub bookmark redirects to the current Cloudflare origin with no iframe; fullscreen/Gamepad permissions and incorrect-password rejection pass. The desktop shortcut matches the tunnel and all eight checked public assets match the release. `artifacts/direct-check.json`, `artifacts/public-assets-check.json`. A full service reinstall was verified after fixing launchd's asynchronous removal race.
- **18 Node tests**: Xbox/N64 mapping and ROM normalization; HTTP confinement, room lifecycle, host authority, reserved reconnects, revision checks, protocol 4, direct sharing and password gating; winner choice for time/stock/teams, no contest, synchronization and replacement ports.
- **11 phone/gameplay checks** in Chrome using independent desktop and mobile contexts. Real multi-touch events verify stick + A + B together, all 14 N64 buttons, pointer cancellation and rotation. The phone joins a shared lobby, chooses a fighter and wins a real one-stock match against an unlocked Luigi. On the next stage screen only the winner can move or confirm. Shared Menu/resume preserves that choice. The winner starts an actual battle on unlocked Mushroom Kingdom. Zero browser errors or unexpected state repairs; the final two-browser segment rendered at 60 FPS. `artifacts/mobile-check.json`.
- **3 WebKit checks** with a phone viewport: the pinned WASM core loads and renders the native menu, all fighters are unlocked, a multiplayer room opens, pointer input selects Luigi, portrait/landscape fit, and Menu/resume works. `artifacts/webkit-check.json`. This exercises desktop WebKit with mobile emulation, not physical iPhone hardware.
- **7 native rules checks**: testing password, real name typing, rename propagation, guest inheritance, a real two-human four-stock/no-items battle, rematch rule preservation and unlimited Time. `artifacts/settings-check.json`.
- Visual inspection of portrait 390 × 844 and landscape 844 × 390 menus, character selection, stage selection and battle. A compact 375 × 667 portrait check also verifies separate face-button targets. All 12 portraits and Mushroom Kingdom are visible. Controls remain outside the 4:3 game area; landscape Menu/Start overlay the picture as in the supplied reference.
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
