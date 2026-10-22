# Release verification · v3.0.0 · 2026-10-21

Checks use the user's locally supplied original US ROM. No ROM, save, screenshot or extracted game data is committed or served. Evidence stays in ignored `artifacts/`.

## Environment

Intel MacBook Pro, macOS 15.6.1, Node 20.11.0 and installed Chrome through Playwright. Isolated browser contexts represent separate foreground computers. Desktop 1440 × 900 and phone 390 × 844 layouts checked. The entire menu and battle occupy the viewport at the original 4:3 ratio; character selection leaves room for connection indicators.

## Local result

The full four-browser check passed with **zero uncaught browser errors**. It entered an actual four-human battle (Mario, DK, Link and Samus), returned to open character selection, and ran a two-human rematch. Two-player fighting averaged **59 FPS**, with zero unexpected state repairs. One deliberate memory corruption was detected and repaired.

The focused selection check also passed: leaving recalls and parks only the departing player's token, a replacement receives the freed port and selects a fighter, clicking Single Player enters native 1P Mode, and leaving returns to the live native Mode Select screen.

Evidence: `artifacts/e2e-native-local-four.json`, `artifacts/selection-check.json`, native menu/character-selection/battle screenshots.

## Covered behavior

- Thirteen Node tests cover controllers and ROM byte order; HTTP confinement and no upload route; public/private listing, capacity, version/ROM agreement, host authority, reserved reconnect tickets, explicit departure, room isolation, and rejecting obsolete roster input/snapshots over both relay and direct connections.
- Actual Smash Mode Select art/music with native controller/keyboard navigation. Selecting VS Mode opens the room browser. Accessible mouse targets also open native 1P/options/data or online play.
- A solo host selects a native fighter while the room remains open. A fresh invited guest and two public-room guests receive distinct controller ports, the host's existing fighter choice and matching game states.
- Guest reconnect preserves all selected fighters. Only the host starts, after connected members have chosen. Roster sealing precedes the native Start input. The room directory shows the battle as closed to new arrivals.
- Real native scene assertions distinguish Mode Select (7), 1P Mode (8), character selection (16), and an actual VS battle (22). Battle state confirms four then two human fighters. No menu-only progression is counted as gameplay.
- Controller mapping supports custom button and signed-axis bindings, live preview, shared pause and saved profiles. Inputs use a simulated Gamepad API; physical pairing requires the users' hardware.
- Direct-to-relay transport switch with a dropped input, hash mismatch repair, shared pause/resume, guest reconnect, host departure, local save/load/export/import and cache persistence.
- Syntax, linked assets, pinned engine provenance, source archive and game-data exclusion checks are required before release.

## Implementation safeguards

The browser reads the verified US scene and selection state through the pinned core's official serializer. It never modifies ROM bytes or writes game memory. Menu preparation uses native controller inputs. Native graphics stay active underneath the loading overlay, preventing the hidden canvas from losing its WebGL context during preparation.

Roster revisions invalidate asynchronous snapshots and old inputs when people arrive or leave. Match generations cancel obsolete menu preparation. Every browser restores a host snapshot before resuming. A host can run alone; all connected members must acknowledge the snapshot when peers are present. A network loss reserves a port, whereas explicit departure during selection recalls its token using native input and parks its hand outside the portraits.

## Practical limits

- Delayed lockstep, no rollback. Hardware speed and real inter-city latency affect responsiveness. Multi-browser tests on one laptop do not certify geographically separated networks.
- The pinned core exposes all four native controllers; unused hands can appear before anyone joins. Room indicators show actual connected players. New arrivals take the next free port automatically.
- Chrome tested. Physical Xbox/N64 devices, other browsers and mobile gameplay are not certified. There are no touch game controls.
- The legacy renderer emits nonfatal WebGL uniform warnings. Visual checks require a live WebGL context; blank rendering is not accepted as a passing screenshot.
- Browser storage is per origin. Keep the host on localhost and export local saves before changing origins. New tunnel addresses require each guest to load their ROM again.
- The laptop must stay awake. Free Cloudflare Quick Tunnel addresses change on restart. Moving hosting to an awake Mac mini allows the laptop to be off.
