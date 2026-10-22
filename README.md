# Smash Portal · 64

A free, self-hosted, full-window browser app for two to four friends to play the original US Super Smash Bros. N64 game online. Each player supplies their own ROM. Includes the original game menus, a room browser, live character-selection rooms, private invitations, Xbox and remappable N64 controllers, portrait/landscape phone touch controls, keyboard controls, all 12 fighters and all 9 VS stages unlocked, winner-controlled stage selection, direct WebRTC connections, a WebSocket fallback, synchronized save states, local progress saves, and free HTTPS sharing from Windows or a Mac.

For Ryker's Windows hosting handoff and the Dan/Mac mini backup design, start with [AGENTS.md](AGENTS.md) and [HOSTING.md](HOSTING.md).

## Play

Use **https://danielkimball.github.io/smash-together/** or **Desktop → Smash Together → Friends Link.webloc**. **Play Smash.command** also opens this permanent site. It hosts the game directly and remembers your ROM, controller settings and name even when the Cloudflare connection changes. There is no iframe. The host can still use **http://localhost:8787** for local development; localhost has its own separate saved data. Use Google Chrome or Microsoft Edge on both computers.

1. Watch the original N64 / Master Hand opening, or press any key, controller button, or tap to skip to the native title screen. Press again to select your original US `.z64`, `.v64`, or `.n64` ROM once. It stays in this browser. The actual Smash **Mode Select** menu opens, with its original art and music.
2. Choose **1P Mode** for single-player or **VS Mode** for online multiplayer. Use your controller, WASD + J, or click the native menu choices. Mouse hover highlights the actual game icon. The original menu music continues into the lobby. A funny default name is saved automatically; edit **Change your name**, or select it with controller A to open a keyboard. Up/down moves between your name, Create, Join and all open rooms below. Press A to select a room. Rooms support 2–4 players and can be public or invite-only.
3. Creating a room first opens the **original VS Mode settings**. Choose Time or Stock, adjust minutes (including ∞) or lives, and open **VS Options → Item Switch** for item frequency and individual toggles. Handicap, team attack and damage ratio are also available. Stage Select stays enabled so the winner can choose the next stage. Use your controller, WASD + J/K, or the on-screen arrow/A/B controls. Choose **VS START** when ready; the room opens at character selection with those rules. Pick your fighter while friends join.
4. Click **Invite friends** and send the link to your brother. He enters his name and loads his own ROM. He joins the next controller port on your existing screen. Your fighter stays selected while other friends arrive. There is no separate ready-up screen.
5. After everyone has selected, the host presses **Start / Enter** or **Start Match**, and chooses the first stage with A / J. After a completed match, press Start on the results screen to return to fighters; the **winner alone chooses the next stage**. In teams, the leading player on the winning team chooses (points, then KOs, then controller port). If the chooser leaves, the host chooses. New players can join again when the group returns to character selection.

The host can change the room name anytime: click **Rename** beside the room title during character selection, or **Menu → Rename room**. The new name appears for everyone and in the room browser without resetting fighter selections.

All **12 fighters** and **9 regular VS stages**, including **Mushroom Kingdom**, are unlocked in local play and online rooms.

On a phone, the touch controller appears automatically: purple below the game in portrait; dark controls beside the game in landscape. The stick, A/B/Z, L/R, D-pad, C buttons and Start support simultaneous fingers. **Menu** opens shared pause/settings. Rotate freely; held touches release when interrupted. **Controller setup → Phone touch controls** can show or hide the controls when using a paired pad.

Pair Bluetooth or USB controllers in the device’s settings, then press a button. **Controllers / Controller setup** includes Xbox and DragonRise N64 USB presets and a guided mapper for other adapters. Changes save automatically for that device, including calibration, even if its browser index changes. Keyboard works too.

The native menu and battle fill the available viewport, preserving the original 4:3 ratio. Character selection adds a narrow room header and four named controller indicators without covering the native fighter cards. **Fullscreen** also hides browser chrome. **Esc**, or **L + R + Start** on a mapped controller, opens the overlay menu.

For testing, a small **◇ in the bottom-right corner** of the entry screen or ROM dialog opens password access. The host can enable this in private `.local/config.json`; authorized testers then load the host’s local cartridge without a file picker. The ROM is never included in Git, GitHub Pages, static files or the source archive. Normal BYOR loading remains available.

Keep every game tab visible. Opening a menu pauses everyone; Resume synchronizes everyone again. **Return to character selection** opens a fresh selection screen for the group. A network-disconnected guest’s fighter and port are reserved: **Reconnect** restores the existing state using the original tab’s ticket. Explicitly leaving during selection frees the port and recalls that player's token. The host leaving closes the room; there is no host migration.

Only joined players send inputs. The emulator exposes four native controller ports, so empty hands may appear before people arrive. The colored name indicators show the actual connected players; untouched, unselected ports do not block a match. Controller assignments are automatic and fixed for the duration of a room.

### Controls

| N64 action          | Xbox preset                     | Keyboard       |
| ------------------- | ------------------------------- | -------------- |
| Move / aim          | Left stick                      | W A S D        |
| A / attack / select | A                               | J              |
| B / special / back  | X                               | K              |
| Z / grab            | Left trigger                    | L              |
| R / shield          | Right bumper                    | O              |
| Start               | Menu / Start                    | Enter          |
| C / jump            | Y, B, or right stick left/right | I, Space, 1, 3 |
| D-pad / taunt       | D-pad                           | Arrow keys     |

N64 adapters differ: the guided mapper accepts any exposed button or signed axis. The live preview shows raw inputs, stick position and mapped actions. Adjust deadzone, range or vertical inversion as needed. Controllers must appear in the browser Gamepad API; pairing alone does not guarantee a particular adapter works. Physical controller hardware must be checked on your devices. Local play can use the selected input plus up to three additional gamepads.

The DragonRise **0079:0006** preset uses the displayed one-based numbers: A7, B9, Z8, R6, L5, Start10; C up1/down3/left4/right2; stick axes 1/2; D-pad up13/down14/left15/right16. On macOS, turn off the Game Controllers Home-button Launchpad shortcut if the adapter's B button also activates it. Web input mapping cannot suppress an operating-system shortcut.

### Saves

The local game’s overlay menu offers **Save progress / Load progress** to keep a full snapshot in the current browser. **Export save / Import save** transfers a `.smash64` snapshot between computers or origins. These controls are available outside multiplayer. Each newly created online room starts at character selection; local saves are separate from online matches. ROM, controller and name storage belongs to the browser and address. Use the permanent site consistently; old temporary links and localhost cannot transfer their storage automatically. Select your ROM once on the permanent site. The app requests persistent browser storage, but private browsing or clearing site data still removes it. Export saves before clearing browser data.

## Hosting, cost and stopping

Ryker's Windows PC is primary. Use **Desktop > Smash Portal** for Play, Start Hosting, Stop Hosting and Restart Hosting. Hosting starts when Ryker signs in; lock with Windows+L and keep the PC awake. Tested updates from main deploy automatically when all rooms are empty. Dan's Mac is the manual backup; failover and match migration are not automatic. Full operating instructions are in [HOSTING.md](HOSTING.md). The Mac-specific commands below apply only to Mac hosts.

The app, runtime, relay and sharing software cost $0. Players need no account. GitHub Pages serves the permanent game frontend; your laptop supplies the live room service and fallback relay through Cloudflare.

**Desktop → Smash Together → Start Sharing.command** starts the login service. **Stop Sharing.command** stops the website, relay, tunnel and idle-sleep prevention. **Play Smash.command** starts the service if needed and opens Chrome. The service is installed for the current macOS user and starts at login.

Keep the laptop plugged in with its lid open while hosting. `caffeinate -i` prevents idle system sleep, but does not override closing the lid or manually sleeping the Mac. Display sleep is allowed. A server restart closes rooms; create a fresh invitation afterward. Use `node scripts/service.mjs restart` for application updates: it keeps the existing tunnel connection and hostname alive.

A [Cloudflare Quick Tunnel](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/) gives the laptop a free temporary HTTPS address without opening router ports. It has no uptime guarantee and its hostname changes when restarted. The host verifies public health before advertising a URL; it recreates revoked tunnels and connections that fail three consecutive 20-second health probes. The permanent frontend discovers that relay through `active-host.json`; invitations and **Friends Link.webloc** use the permanent site. Tunnel rotation no longer changes the browser's storage origin. Static game assets load from GitHub Pages, and direct WebRTC still carries game inputs when available. Logs and the current relay URL remain in unpublished `.local/`. No domain purchase is required.

Service commands:

```sh
node scripts/service.mjs status
node scripts/service.mjs start
node scripts/service.mjs restart
node scripts/service.mjs stop
node scripts/service.mjs uninstall
```

## Setup on another Mac / migrate to the Mac mini

1. Install Node.js 20 or newer (a current LTS is recommended), Git, and Chrome. No emulator compilation is needed to run the supplied app.
2. Copy this project to the mini, excluding `node_modules`, `.local`, `.git` if you do not need history, and `artifacts`. Keep `public/engine`. Normal BYOR play does not need a server ROM. Testing password access additionally needs the host’s local ROM path.
3. In the project folder run `npm ci --omit=dev`, then `node scripts/service.mjs install`. The installer chooses the correct, checksum-verified Cloudflare binary for Intel or Apple Silicon and creates shortcuts with the new machine's paths.
4. Transfer `.local/config.json` separately and update the testing ROM path for the mini. Keep `frontendUrl`, `pagesRepo` and GitHub CLI authentication so the host can update the permanent site's relay address. Do not publish this config. Open `http://localhost:8787` on the mini to check it, then verify the permanent site from another computer. Existing permanent-site browser storage remains in place; create and share a new room invitation.
5. Stop the service on the old laptop after verifying the mini works. Keep the mini awake and signed into the user that owns its login service.

For foreground development, run `npm ci`, `npm start` and, in a second terminal, `npm run share`. A manual server binds only `127.0.0.1:8787`. `HOST` and `PORT` can be set for development. HTTPS or localhost is required for Web Crypto, controllers and audio; plain LAN HTTP is not supported. No browser extension is required.

## How multiplayer works

Each browser runs the same pinned N64Wasm emulator locally. The room checks ROM and engine identities. The host configures the native rules before the room opens and can then run alone in character selection. Every new match in that room restores its configured selection snapshot. When a friend joins, all clients pause briefly while the host sends a compressed snapshot of the current selection; **all** players restore it so the interpreter begins from the same boundary. Each frame is executed only once every active player’s frame-numbered input is available. New rooms default to the responsive four-frame buffer. Inputs can be delayed by 4/6/9/12 frames (about 67/100/150/200 ms at 60 FPS); choose a larger buffer for high latency. A short repeated input history covers direct-to-relay transitions. State hashes are compared every 60 frames; mismatches pause and restore the host's authoritative state automatically.

This is **delayed lockstep, not rollback**. Slow hardware or a slow connection can cause stalls and audio underruns. Direct peer connections use a public Cloudflare STUN service. When that is unavailable or blocked, the laptop's WebSocket relay carries inputs, avoiding a paid TURN service. Snapshots use the relay even with a direct input connection. Ordinary save states are roughly 16 MB before compression.

Rooms have unguessable invitation tokens, two to four seats, build/ROM checks, message limits, origin checking and host-only snapshot authority. The server forwards state without writing it to disk. Only the `public` directory is served. It has no ROM upload route, analytics or user accounts. An optional POST-only testing endpoint validates a server-side password hash, limits failed attempts, and serves the configured local cartridge with no-store headers. It is disabled unless configured. Public rooms are listed on this server; invite-only rooms require the invitation token. Active match reconnects also require the reserved player’s per-tab ticket. The server stamps each sender’s identity and controls seats and lifecycle messages. Roster revisions invalidate obsolete input and snapshots during joins/leaves; match generations cancel old preparation. The host seals the roster before sending the native Start input. The app reads verified US scene and fighter-selection state through the pinned core’s official serializer; it does not patch the ROM; session preparation enables the full native roster, Mushroom Kingdom, Sound Test and Item Switch. Online room setup also enables Stage Select. Native results determine the next chooser; every peer filters stage inputs at the same simulation-frame cadence, and snapshots carry winner identity across synchronization. Public internet traffic traverses the tunnel provider, and direct WebRTC connections can reveal peer network addresses to the other player. Keep invitations between the intended players.

## Verification

```sh
npm test                       # controls, byte order, server/room isolation
npm run check                  # syntax, runtime provenance, served-file audit
SMASH_ROM='/absolute/path/your.z64' npm run test:e2e
SMASH_ROM='/absolute/path/your.z64' node scripts/invite-check.mjs # requires live sharing
```

The end-to-end test needs a locally supplied ROM and Chrome. It never places that ROM in the project or server. It exercises four isolated browsers (set `SMASH_PLAYERS=2` for a two-browser check), native menu navigation, solo fighter selection, late arrivals preserving fighters, automatic player ports, rematches, actual battles, state checks, transport fallback, pause/resume, deliberate desync repair, guest rejoin, controller mapping, and save persistence. Screenshots and results go to the ignored `artifacts/` folder. See `QA.md` for the completed checks and practical limits.

## Source, engine and licenses

The browser game uses [waveplate/M64Wasm](https://github.com/waveplate/M64Wasm), pinned at `f6b5d6cc31821ec501a94aa761eae022d08f5a9d`, based on Neil Barkhina's N64Wasm and the Mupen64Plus/libretro ecosystem. This is emulation, not a native Smash decompilation port. The [Smash decompilation](https://github.com/VetriTheRetri/ssb-decomp-re) is a separate project; its existence does not itself provide a browser multiplayer engine.

`upstream/m64wasm` is a Git submodule. Restore it with `git submodule update --init`. The distributed `.wasm` and JS are unmodified copies from the pinned upstream `dist`; `public/source/manifest.json` records their hashes. Runtime `assets.zip` replaces the upstream fonts with OFL-licensed Abel. No ROM or executable game data is included. The pre-ROM audiovisual attract recordings are served from `public/media`; live gameplay still requires the player’s verified ROM.

To rebuild the emulator: install/activate **Emscripten 2.0.7**, enter `upstream/m64wasm/code`, run `make clean` then `make`, and copy `dist/n64wasm.js` and `dist/n64wasm.wasm` to `public/engine/`. Change the protocol/build identifier when changing emulator behavior. `python3 scripts/package-source.py` rebuilds safe font assets, notices, the manifest, and the downloadable corresponding source archive. The archive includes the emulator code and build Makefile, application source, tests, and licenses, without ROMs or local service data.

Application code is GPL-3.0-or-later. N64Wasm's wrapper is MIT; incorporated emulator components keep their respective GPL/LGPL/BSD/MIT licenses and copyright notices. See `public/credits.html` and the source archive. Abel, Josefin Sans, Instrument Sans and Orbitron are SIL OFL; ws is MIT. The supplied Smash Portal branding and native game recordings retain their respective ownership. Cloudflared is downloaded from its official release with a pinned SHA-256 check. This independent project is not affiliated with Nintendo or HAL Laboratory.

### Permanent frontend and testing configuration

Private `.local/config.json` supports optional `testing: { romPath, passwordHash }`, `frontendUrl` (the permanent Pages URL), `pagesRepo` (owner/repo) and `ghPath`. The password hash is SHA-256; do not place a plaintext password or ROM in the repository. The server allows API requests and room sockets from the configured frontend origin. Direct tunnel pages remain available during a frontend rollout. Localhost remains usable. Without `frontendUrl`, direct hosting still works. The old `publicUrl` setting is ignored. `scripts/publish-link.mjs` updates the Pages `server.json` through the host's existing GitHub CLI authentication. Publish the `public/` directory to the Pages branch alongside `.nojekyll` and `server.json`. The old `launcher/` redirect is retained for legacy deployments; it is not the current frontend.

The emulator's redundant DOM keyboard handlers are removed after initialization; the app supplies keyboard, controller and touch input. Native unlocks are applied to browser-local session save data through the official serializer; ROM bytes are unchanged. All other match rules use the original menus.

## Smash Portal opening and branding

The black / CRT white / red / idle blue / yellow / green palette is defined in `public/portal.css`. Headers and buttons use Josefin Sans Semibold, medium copy uses Instrument Sans Condensed Medium Italic, and small labels use Orbitron Medium. Fonts are local, with their OFL notices. The supplied logo is preserved in `public/brand`.

Before a cartridge is loaded, the original N64 / Master Hand opening plays as a recording of the host's copy with its original audio. If browser autoplay blocks sound, click or press a key at **Play intro with sound** to replay it audibly; controller navigation can still skip it silently. The following title is a silent, looping fire clip with no announcer or How to Play transition. Press again to open the ROM modal; fire keeps moving behind it. Invalid ROMs remain blocked. A verified or remembered cartridge opens the live native Mode Select. VS Mode opens the branded lobby while the actual menu soundtrack continues. 1P, Options and Data remain native. Videos and their network requests are released before gameplay.

`SMASH_ROM='/absolute/path/your.z64' node scripts/capture-attract.mjs` reproduces the recordings using isolated Chrome and ffmpeg; temporary recordings and scene observations stay in ignored `artifacts/attract-capture`. No ROM or savestate is published. The capture is an audiovisual preview, not an emulated game available before ROM verification. `SMASH_ROM='/absolute/path/your.z64' SMASH_URL='http://localhost:8790' node scripts/portal-check.mjs` checks the entry flow, validation and responsive branding.
