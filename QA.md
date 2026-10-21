# Release verification · 2026-10-21

The checks below use the original, locally supplied US ROM. No ROM or save files are committed, distributed, or placed in the public directory. Test screenshots and snapshots stay in the ignored `artifacts/` folder.

## Environment

- Intel MacBook Pro, macOS 15.6.1, 64 GB RAM.
- Node.js 20.11.0; installed Google Chrome through Playwright.
- Two isolated browser contexts. Host through localhost; guest through the live public HTTPS tunnel.
- Both simulated players execute the emulator on this laptop. This verifies the public route and protocol, but does not reproduce two geographically separated networks.

## Completed result

Latest full browser run: **passed**, 2026-10-21 23:41:59–23:43:10 UTC. Fourteen browser checks passed with no uncaught application errors. The gameplay measurement averaged **58 FPS**, with 40 matching state comparisons before fault injection and 52 by the end of the session. There were zero unexpected repairs; the single intentional memory corruption produced exactly one successful automatic repair.

The final screenshots were visually checked: Mario and Donkey Kong are selected independently, enter Hyrule Castle, and both move during the live match. The two browsers show the same positions and running match timer. Responsive desktop, phone and controller-setup layouts were also inspected.

## Automated checks

- 9 Node tests: ROM byte-order conversion, Xbox preset, configurable N64 axes/buttons, calibration/deadzone, static-file confinement, no ROM uploads, origin restrictions, private room compatibility/capacity, relay isolation, host authority, disconnect/rejoin and late-packet handling.
- Browser checks: responsive desktop/mobile layout, rejected invalid ROM, real ROM boot in both contexts, Gamepad API preview, button/axis remapping and persistence, synchronized game startup, scripted game inputs, checksums, direct-channel loss with an intentionally dropped input, WebSocket fallback, deliberate memory corruption and automatic repair, controller-dialog pause/resume, guest rejoin, host leave, local saves, export/import and cached ROM reload.
- Syntax, linked assets and pinned runtime SHA-256 checks.
- Source archive scan: no ROMs, save states, credentials, `.local` files or proprietary upstream font binaries.
- Source and license downloads available with the app.
- Login service starts correctly, stops the server/tunnel cleanly, and restarts with a fresh public address. Idle sleep prevention is tied to the service's PID.

`artifacts/e2e-report.json` records the latest browser run and measured FPS. Screenshots of character selection and the fight are reviewed separately: advancing synchronized menu frames alone does not prove gameplay. Earlier test-driver timing problems were corrected to count sampled input frames exactly.

## Corrections made during verification

- Restore both host and guest from the same synchronization boundary to normalize transient interpreter state.
- Retain and repeat a bounded input history to recover packets crossing direct/relay transitions.
- Reject already consumed input frames so retransmissions do not accumulate stale entries.
- Drop late relay/ICE/snapshot packets after a guest leaves; they must not turn the waiting host into an error state.
- Cancel obsolete synchronization work when leaving a room.
- Allow a verified ROM to play even if the browser refuses persistent storage.

## Practical limits

- Netplay uses delayed lockstep, with no rollback or input prediction. Network delay and slower computers affect responsiveness.
- Physical Xbox/N64 hardware was not available to certify. Gamepad API behavior, button/axis mapping and persistence were tested with simulated devices. Pair and test the actual adapters in Controller setup.
- Chrome was tested. Edge uses the same browser engine; Safari, Firefox and mobile gameplay were not certified. Phone layout was checked, but there is no touch-controller interface.
- The legacy emulator emits nonfatal WebGL warnings in Chrome. Rendering and game-state progression are checked independently; no uncaught application errors are accepted.
- Cloudflare Quick Tunnels are temporary and have no uptime guarantee. Hostname changes mean fresh invitations and separate browser storage for clients using the new origin.
