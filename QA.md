# Release verification · v2.0.0 · 2026-10-21

The checks use Dan’s locally supplied original US ROM. No ROM, save, screenshot, or extracted game data is committed or served. Evidence remains in ignored `artifacts/`.

## Environment and scope

- Intel MacBook Pro, macOS 15.6.1, Node 20.11.0, installed Chrome driven through Playwright.
- Four isolated browser contexts represent four computers. All emulators execute on this laptop; this does not reproduce geographically separated networks.
- Desktop 1440 × 900 and phone 390 × 844 layouts checked. Fullscreen API toggle and a viewport-sized game canvas verified. The game preserves its 4:3 ratio.

## Release result

Four local browser contexts passed 18 checks. The deployed app then passed **19 browser checks** with the host on localhost and three guests on the public HTTPS tunnel (2026-10-22 01:03–01:05 UTC). The measured two-player fight averaged **59 FPS**, with zero unexpected repairs; the intentional memory corruption triggered one successful repair. No uncaught browser errors occurred. The public run also verified a guest reconnect during initial game preparation.

## Checks

- Ten Node tests pass: ROM byte order, Xbox preset, custom N64 buttons/axes, calibration, static-file confinement, no upload routes, same-origin upgrades, public/private listing, capacity, matching ROM/build, port conflicts, host-only lifecycle, readiness, relay isolation and reconnect tickets.
- Browser flow covers the room browser, four live controller cards, choosing an empty port, readiness, automatic character selection, four-player inputs, returning to the lobby, and a two-player rematch.
- Read-only checks against the verified US ROM’s scene state distinguish character selection (16) from a VS battle (22). The actual battle reports four human players, then two for the rematch. These assertions prevent advancing menus from being mistaken for gameplay.
- Screenshots visually confirm Mario, Donkey Kong, Link and Samus in Hyrule Castle, and a subsequent Mario/DK match. Desktop, mobile, controller setup and lobby layouts were reviewed.
- Multiplayer recovery covers loss of a direct channel with a dropped input, relay fallback, deliberate memory corruption and automatic repair, menu/controller pause and resume, a guest reconnecting to their original port, and the host closing the room.
- Local save/load/export/import, cached ROM reload, and saved per-device mappings pass. Gamepad API inputs are simulated; actual hardware pairing still needs the users’ devices.
- Syntax, asset links, pinned engine checksums, source archive contents and served-file confinement are checked before release.

`artifacts/e2e-report.json` records the latest full browser run, counts, timings and errors. Separate `e2e-local-four.json` and `e2e-public-four.json` retain local and public-route results when both are run.

## Fixes verified during this rework

- Wait through the Nintendo/HAL boot screen before the first Start input, so startup reliably reaches VS character selection.
- Keep sender identity and controller slot assignment on the server; host authority does not depend on being player 1.
- Restore every browser at the same snapshot boundary and wait for every connected player’s ready hash.
- Use full-mesh direct input channels with per-peer relay fallback and bounded repeated input history.
- Reserve disconnected players’ ports during a match; require their per-tab ticket to reclaim them. Return to lobby frees abandoned ports.
- Cancel obsolete preparation/synchronization when leaving or changing rounds. Defer synchronization while the initial character screen is being prepared.
- Preserve normal keyboard focus in menus and suppress the L + R + Start overlay chord from game inputs.

## Practical limits

- Delayed lockstep, no rollback. Latency and the slowest player’s computer affect responsiveness.
- The core exposes all four native controllers; unused character-selection hands may remain visible. The lobby/overlay accurately represent connected players. Untouched, unselected ports do not block a match.
- Chrome tested. Physical Xbox/N64 controllers, Safari, Firefox and mobile gameplay are not certified. There are no touchscreen game controls.
- Browser storage is per origin. A new tunnel hostname requires loading the ROM again; localhost keeps stable host storage. Export local saves before moving origins.
- The hosting computer must remain awake. Cloudflare Quick Tunnels are free temporary addresses, change on restart, and have no uptime guarantee.
- The legacy emulator emits nonfatal WebGL warnings; uncaught application errors are not accepted.
