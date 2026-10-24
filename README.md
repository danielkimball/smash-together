# Native startup and simpler room controls — v3.8.0

The original ROM now starts once at normal speed when the site loads. Press Start to skip its opening/title; there is no separate intro or accelerated replay. Cached cartridges and the development auto-load work automatically. Without a cartridge, the branded Add your ROM screen uses the supplied box art and verifies your file locally before starting the game. The development build still skips that picker.

- Controller setup has Player 1/2/etc. tabs, compact controls, nine rows flowing down each column, and optional stick calibration. Only the mapping being captured turns red. Close stays visible on a scrolling screen.
- Additional lobby names have an inline ×. In character select, microphone icons mute/unmute locally and light up during speech; pencils edit names on your own device.
- Server settings starts with rotation, then each player’s next-round availability, immediate lineup selection, queue and host moderation. Teams and battle rules stay in the game. Kicking a primary player with local partners removes that whole device; kicking an additional local player removes only them. Removal displays a persistent notice and invalidates the previous reconnect identity; it is not a permanent ban.
- Native menu idle deadlines are extended without resetting choices, animation or music. Online peers do this on the same agreed frames. The game remains at character select while friends join or settings are open.
- Invite friends and Back follow Fullscreen in the wrapping toolbar. Invitations always show the link, Copy button and inline confirmation.

Refresh every player's tab after deployment: room protocol **8** / build suffix **-smash-native-v8** keeps the shared idle behavior consistent. The pinned emulator binaries and combat input model are unchanged. See QA.md for verification and the previously measured public-network limits.

# Compact local-player setup — v3.7.1

Use the small red **+ Add additional players on this screen** directly below **Change your name**. It opens the existing local-player setup. Added people get smaller editable name pills in one row; names save automatically and support the controller keyboard. At four people, the link becomes **Manage players on this screen**. Create, Join and the room list remain the main actions. Gameplay, network timing and emulator code are unchanged.

# Audio, shared-device players and live lobbies — v3.7.0

**Refresh every player's tab after this update.** Room protocol 7 keeps old and new clients from mixing; the pinned emulator binaries are unchanged.

- **One Audio & Voice panel:** game volume, voice volume, microphone and mute controls live together. Room voice plays automatically with your microphone off. If your browser blocks playback, click **Enable sound**; no microphone permission is needed to listen. The Audio button shows when playback is muted or needs a click.
- **Hear speech clearly:** automatic game-volume reduction is on by default. Speech lowers the game to 28% of your chosen level, then it smoothly returns after speech ends. Turn this off or adjust both sliders in Audio & Voice. **Mute all voices** and **Mute for me** never turn your microphone on. Host moderation still applies. People sharing one computer share its microphone and voice controls.
- **Several players on one computer:** use one tab. Open **Players on this device**, add each person's name, assign a different controller (or the keyboard), and use **Map buttons** if needed. Up to four local people join together, each with an independent fighter/queue place. Rooms still hold eight people with four fighting at once. Extra arrivals during a battle wait for the next round. Disconnecting a controller makes only that input neutral; refreshing or leaving removes the computer's whole group from connected counts and passes hosting to another device.
- **Keep choosing while friends connect:** joins, reconnects, ordinary departures and controller setup no longer pause the other players in character selection. Only the arriving device catches up. Menu/controller setup still shares a pause during actual combat. Explicit native team/lineup configuration and returning everyone to a fresh selection screen still rebuild the configured screen together.

See [QA.md](QA.md) for the measured checks and hardware/network limitations. The existing latency fixes and numeric Connection reports remain in place.

# Transport stabilization — v3.6.4

The primary host uses the previously working HTTP/2 default again. QUIC remains an explicit host option after connectivity verification. All gameplay performance improvements and Connection reports remain available. The audit found substantial local Wi-Fi jitter even with the game closed; an Ethernet comparison is still needed before calling online latency resolved. See [PERFORMANCE.md](PERFORMANCE.md).

# Relay update — v3.6.3

v3.6.3 tried Cloudflare's QUIC transport with automatic TCP fallback. The actual primary used HTTP/2 fallback, so no QUIC benefit was established there; v3.6.4 restores the prior default. Reports expose the transport actually connected. Actual network latency still varies; use the Connection report after a spike.

# Performance update — v3.6.2

Responsive play is the first priority. The renderer now uses its native vertex buffers, controllers reach the next available server tick with no deliberate future-frame buffer, and completed frames render without a two-frame queue. Voice remains available on its separate connection. Refresh every player's tab to load the update. See [the measured audit](PERFORMANCE.md) and [verification](QA.md).

# Testing update - v3.6

The permanent address stays on GitHub Pages; Cloudflare connects it to Ryker's PC behind the scenes. His testing host loads the game automatically when the site opens, without a ROM picker or password. New hosts still default to bring-your-own-ROM. No ROM is stored in Git or Pages.

- **Back:** B recalls your fighter token; press B again to leave character selection. Top-right **B - Back** leaves immediately. In the multiplayer menu, B returns to native Mode Select. Leaving transfers the room host role to the next connected fighter, then the oldest spectator.
- **Start:** the host's controller Start starts when everyone has chosen fighters. Your saved controller mapping applies.
- **Phone:** Auto hides touch controls when a USB/Bluetooth controller is detected. Visible **Touch controls / Hide controls** and **Fullscreen** buttons stay available. Browsers without page fullscreen show home-screen installation steps.
- **Lag:** late inputs affect that controller while others keep moving. Spectators and battle reconnects catch up from targeted snapshots without pausing the fighters. Manual pause and fighter-state repairs still synchronize everyone. Losing the Windows backend still ends the room. This is not rollback.
- **Brand:** the lobby uses Ryker's supplied animated SVG.

- **Eight people, four fighters:** open **Server settings** beside Menu and Audio & Voice. Late arrivals watch the live match. **Sit out next round** keeps you spectating until Ready; the host keeps their role. During a match, sitting out applies to the next round.
- **Winner stays:** with 5/6/7 ready people, replace the lowest 1/2/3 finishers. With eight, the winner stays, the first three waiting players enter, and the fourth waiter goes first next time. Fill empty fighter places before replacing anyone. Winners can voluntarily sit out. Tied places use points, KOs, then controller-port order.
- **Teams:** the losing pair rotates out for the next pair. With seven people, the remaining spectator pairs with the higher-KO outgoing teammate for the following turn; the lower-KO teammate waits for the next available turn. Choose teams in the native game. The host can override the next lineup, reorder the queue, or select manual rotation in Server settings.
- **Voice:** open **Audio & Voice** for game/voice volume, automatic game-volume reduction, microphone controls, mute-all and individual voice controls. Everyone can listen without turning on a mic. **Turn microphone on** requests permission explicitly. The host can mute a person or all spectators; allowing someone to speak never unmutes their mic automatically. Leaving the room releases the microphone. Audio is relayed without recording.
- **Touch and pointer:** separate phone layouts prevent overlap, quick taps register, and game controls prevent pinch zoom and text selection. Native menus and character selection accept pointer clicks; gameplay ignores them.

The older setup notes below also describe the standard, non-testing entry flow.

# Smash Portal · 64

A free, self-hosted, full-window browser app for up to eight friends, with four fighters at a time, to play the original US Super Smash Bros. N64 game online. Each player supplies their own ROM. Includes native menus, spectator queues, room voice, private invitations, configurable controllers, phone touch controls, all 12 fighters and 9 VS stages, winner-controlled stage selection, server-agreed multiplayer frames, local progress saves, and free HTTPS sharing from Windows or a Mac.

For Ryker's Windows hosting handoff and the Dan/Mac mini backup design, start with [AGENTS.md](AGENTS.md) and [HOSTING.md](HOSTING.md).

## Play

Use **https://danielkimball.github.io/smash-together/** or **Desktop → Smash Together → Friends Link.webloc**. **Play Smash.command** also opens this permanent site. It hosts the game directly and remembers your ROM, controller settings and name even when the Cloudflare connection changes. There is no iframe. The host can still use **http://localhost:8787** for local development; localhost has its own separate saved data. Use Google Chrome or Microsoft Edge on both computers.

1. The verified cartridge starts the original N64 / Master Hand opening at normal speed. Press **Start / Enter** or tap **Press Start** to skip to the native title, then press Start again to open Mode Select. On a fresh non-testing browser, choose your original US `.z64`, `.v64`, or `.n64` ROM first; it is remembered locally. If the browser blocks sound, click **Enable sound**; this does not rewind the opening.
2. Choose **1P Mode** for single-player or **VS Mode** for online multiplayer. Use your controller, WASD + J, or click the native menu choices. Mouse hover highlights the actual game icon. The original menu music continues into the lobby. A funny default name is saved automatically; edit **Change your name**, or select it with controller A to open a keyboard. Up/down moves between your name, Create, Join and all open rooms below. Press A to select a room. Rooms support up to eight people, with two to four fighters and can be public or invite-only.
3. Creating a room first opens the **original VS Mode settings**. Choose Time or Stock, adjust minutes (including ∞) or lives, and open **VS Options → Item Switch** for item frequency and individual toggles. Handicap, team attack and damage ratio are also available. Stage Select stays enabled so the winner can choose the next stage. Use your controller, WASD + J/K, or the on-screen arrow/A/B controls. Choose **VS START** when ready; the room opens at character selection with those rules. Pick your fighter while friends join.
4. Click **Invite friends**, then **Copy invitation link**, and send it to your brother. He enters his name and loads his own ROM. He joins the next controller port on your existing screen. Your fighter stays selected while other friends arrive. There is no separate ready-up screen.
5. After everyone has selected, the host presses **Start / Enter** or **Start Match**, and chooses the first stage with A / J. After a completed match, press Start on the results screen to return to fighters; the **winner alone chooses the next stage**. In teams, the leading player on the winning team chooses (points, then KOs, then controller port). If the chooser leaves, the host chooses. New arrivals can spectate immediately and enter the next lineup.

The host can change the room name anytime: click **Rename** beside the room title during character selection, or **Menu → Rename room**. The new name appears for everyone and in the room browser without resetting fighter selections.

All **12 fighters** and **9 regular VS stages**, including **Mushroom Kingdom**, are unlocked in local play and online rooms.

On a phone, the touch controller appears automatically: purple below the game in portrait; dark controls beside the game in landscape. The stick, A/B/Z, L/R, D-pad, C buttons and Start support simultaneous fingers. **Menu** opens settings and shares a pause during actual combat. Rotate freely; held touches release when interrupted. **Controller setup → Phone touch controls** can show or hide the controls when using a paired pad.

Pair Bluetooth or USB controllers in the device’s settings, then press a button. **Controllers / Controller setup** includes Xbox and DragonRise N64 USB presets and a guided mapper for other adapters. Changes save automatically for that device, including calibration, even if its browser index changes. Keyboard works too.

The native menu and battle fill the available viewport, preserving the original 4:3 ratio. Character selection adds a narrow room header and four named controller indicators without covering the native fighter cards. **Fullscreen** also hides browser chrome. **Esc**, or **L + R + Start** on a mapped controller, opens the overlay menu.

For testing, a small **◇ in the bottom-right corner** of the entry screen or ROM dialog opens password access. The host can enable this in private `.local/config.json`; authorized testers then load the host’s local cartridge without a file picker. The ROM is never included in Git, GitHub Pages, static files or the source archive. Normal BYOR loading remains available.

Keep the game tab visible. During actual combat, Menu and controller setup pause everyone; Resume synchronizes everyone again. Those dialogs leave character selection running. Server settings and Audio & Voice open without pausing. **Return to character selection** opens a fresh selection screen for the group. A network-disconnected guest’s fighter and port are reserved: **Reconnect** restores the existing state using the original tab’s ticket. Explicitly leaving during selection frees the port and recalls that player's token. The room host leaving transfers control to the next connected player. Losing the backend still closes the room.

Only joined fighters send inputs. Each person added in Players on this device owns a separate input stream through the same browser connection. The emulator exposes four native controller ports, so empty hands may appear before people arrive. The colored name indicators show the actual connected players; untouched, unselected ports do not block a match. Controller assignments follow the current lineup; spectators have no controller port.

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

N64 adapters differ: the guided mapper accepts exposed buttons, signed axes and Windows HID hat directions. The live preview shows raw inputs, stick position and mapped actions. Adjust deadzone, range or vertical inversion as needed. Controllers must appear in the browser Gamepad API; pairing alone does not guarantee a particular adapter works. Physical controller hardware must be checked on your devices. Local play can use the selected input plus up to three additional gamepads.

The DragonRise **0079:0006** preset uses the displayed one-based numbers: A7, B9, Z8, R6, L5, Start10; C up1/down3/left4/right2; stick axes 1/2; D-pad up13/down14/left15/right16. On macOS, turn off the Game Controllers Home-button Launchpad shortcut if the adapter's B button also activates it. Web input mapping cannot suppress an operating-system shortcut.

### Saves

The local game’s overlay menu offers **Save progress / Load progress** to keep a full snapshot in the current browser. **Export save / Import save** transfers a `.smash64` snapshot between computers or origins. These controls are available outside multiplayer. Each newly created online room starts at character selection; local saves are separate from online matches. ROM, controller and name storage belongs to the browser and address. Use the permanent site consistently; old temporary links and localhost cannot transfer their storage automatically. Select your ROM once on the permanent site. The app requests persistent browser storage, but private browsing or clearing site data still removes it. Export saves before clearing browser data.

## Hosting, cost and stopping

Ryker's Windows PC is primary. Use **Desktop > Smash Portal** for Play, Start Hosting, Stop Hosting and Restart Hosting. Hosting starts when Ryker signs in; lock with Windows+L and keep the PC awake. Tested updates from main deploy automatically when all rooms are empty. Dan's Mac is the manual backup; switching to Dan's server and recovering matches after backend loss are not automatic. Full operating instructions are in [HOSTING.md](HOSTING.md). The Mac-specific commands below apply only to Mac hosts.

The app, runtime, relay and sharing software cost $0. Players need no account. GitHub Pages serves the permanent game frontend; your laptop supplies the live room service and fallback relay through Cloudflare.

**Desktop → Smash Together → Start Sharing.command** starts the login service. **Stop Sharing.command** stops the website, relay, tunnel and idle-sleep prevention. **Play Smash.command** starts the service if needed and opens Chrome. The service is installed for the current macOS user and starts at login.

Keep the laptop plugged in with its lid open while hosting. `caffeinate -i` prevents idle system sleep, but does not override closing the lid or manually sleeping the Mac. Display sleep is allowed. A server restart closes rooms; create a fresh invitation afterward. Use `node scripts/service.mjs restart` for application updates: it keeps the existing tunnel connection and hostname alive.

A [Cloudflare Quick Tunnel](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/) gives the laptop a free temporary HTTPS address without opening router ports. It has no uptime guarantee and its hostname changes when restarted. The host verifies public health before advertising a URL; it recreates revoked tunnels and connections that fail three consecutive 20-second health probes. The permanent frontend discovers that relay through `active-host.json`; invitations and **Friends Link.webloc** use the permanent site. Tunnel rotation no longer changes the browser's storage origin. Static game assets load from GitHub Pages, and the active server fixes the shared input timeline. Logs and the current relay URL remain in unpublished `.local/`. No domain purchase is required.

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

Each browser runs the same pinned N64Wasm emulator locally. The room checks ROM and engine identities. The host configures the native rules before the room opens and can then run alone in character selection. Every new match in that room restores its configured selection snapshot. When a friend joins or reconnects, only that browser receives a compressed snapshot and subsequent agreed frames; the other browsers keep running. People sharing one browser use one emulator and one snapshot transfer, with independent controller streams. The server fixes one four-controller input set at each frame deadline. Current controller state is sampled at the next deadline, without waiting for other players or queuing it several frames ahead. Brief jitter retains a held input; a controller silent for more than 150 ms becomes neutral. Short button taps are retained between ticks. Agreed past frames never change. Older room protocols are rejected with a reload message. A stalled client consumes the same buffered frames at a bounded catch-up rate. State hashes are compared every 60 frames. Selection and spectator mismatches repair only the affected browser; a fighter mismatch during combat still restores the group from the host's authoritative state.

This is **server sequencing, not rollback**. Slow hardware or a slow connection can still cause local stalls and audio underruns. WebSocket delivery carries agreed frames and snapshots; WebRTC uses a public Cloudflare STUN service for peer latency and state hashes. No paid TURN service is needed. Ordinary save states are roughly 16 MB before compression.

Rooms have unguessable invitation tokens, up to eight members and four controller ports, build/ROM checks, message limits, origin checking and host-only snapshot authority. The server forwards state without writing it to disk. Only the `public` directory is served. It has no ROM upload route, analytics or user accounts. An optional POST-only testing endpoint validates a server-side password hash, limits failed attempts, and serves the configured local cartridge with no-store headers. It is disabled unless configured. Public rooms are listed on this server; invite-only rooms require the invitation token. Active match reconnects also require the reserved player’s per-tab ticket. The server stamps each sender’s identity and controls seats and lifecycle messages. Match/configuration revisions invalidate obsolete preparation and snapshots. Live lobby joins/leaves retain the agreed timeline; departed controller inputs and queued actions are cleared, and only their native tokens are recalled. The host seals the roster before sending the native Start input. The app reads verified US scene and fighter-selection state through the pinned core’s official serializer; it does not patch the ROM; session preparation enables the full native roster, Mushroom Kingdom, Sound Test and Item Switch. Online room setup also enables Stage Select. Native results determine the next chooser; every peer filters stage inputs at the same simulation-frame cadence, and snapshots carry winner identity across synchronization. Public internet traffic traverses the tunnel provider, and direct WebRTC connections can reveal peer network addresses to the other player. Keep invitations between the intended players.

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

`upstream/m64wasm` is a Git submodule. Restore it with `git submodule update --init`. The distributed `.wasm` and JS are unmodified copies from the pinned upstream `dist`; `public/source/manifest.json` records their hashes. Runtime `assets.zip` replaces the upstream fonts with OFL-licensed Abel. No ROM or executable game data is included. The supplied box art is served locally from `public/media`; the opening and live gameplay come from the verified ROM.

To rebuild the emulator: install/activate **Emscripten 2.0.7**, enter `upstream/m64wasm/code`, run `make clean` then `make`, and copy `dist/n64wasm.js` and `dist/n64wasm.wasm` to `public/engine/`. Change the protocol/build identifier when changing emulator behavior. `python3 scripts/package-source.py` rebuilds safe font assets, notices, the manifest, and the downloadable corresponding source archive. The archive includes the emulator code and build Makefile, application source, tests, and licenses, without ROMs or local service data.

Application code is GPL-3.0-or-later. N64Wasm's wrapper is MIT; incorporated emulator components keep their respective GPL/LGPL/BSD/MIT licenses and copyright notices. See `public/credits.html` and the source archive. Abel, Josefin Sans, Instrument Sans and Orbitron are SIL OFL; ws is MIT. The supplied Smash Portal branding and game artwork retains their respective ownership. Cloudflared is downloaded from its official release with a pinned SHA-256 check. This independent project is not affiliated with Nintendo or HAL Laboratory.

### Permanent frontend and testing configuration

Private `.local/config.json` supports optional `testing: { romPath, passwordHash, autoLoad }`, `frontendUrl` (the permanent Pages URL), `pagesRepo` (owner/repo) and `ghPath`. The password hash is SHA-256; do not place a plaintext password or ROM in the repository. The server allows API requests and room sockets from the configured frontend origin. Direct tunnel pages remain available during a frontend rollout. Localhost remains usable. Without `frontendUrl`, direct hosting still works. The old `publicUrl` setting is ignored. `scripts/publish-link.mjs` updates the guarded `active-host.json` through the host's own GitHub CLI authentication. Publish the `public/` directory to the Pages branch alongside `.nojekyll` and `active-host.json`. The old `launcher/` redirect is retained for legacy deployments; it is not the current frontend.

The emulator's redundant DOM keyboard handlers are removed after initialization; the app supplies keyboard, controller and touch input. Native unlocks are applied to browser-local session save data through the official serializer; ROM bytes are unchanged. All other match rules use the original menus.

## Smash Portal opening and branding

The black / CRT white / red / idle blue / yellow / green palette is defined in `public/portal.css`. Headers and buttons use Josefin Sans Semibold, medium copy uses Instrument Sans Condensed Medium Italic, and small labels use Orbitron Medium. Fonts are local, with their OFL notices. The supplied logo is preserved in `public/brand`.

The opening, title, menus and gameplay all come from the verified cartridge. The pre-ROM screen uses the box art Dan supplied from [Gamers Go Retro](https://www.gamersgoretro.com/cdn/shop/files/7b30af812aea2f4ebe069f0ca5ca868f7664f279_1746994509_super-smash-bros-64-esrbjpg-56e71e_5feb8988-67b9-450e-9caf-e86c604ff19f.webp?v=1755136349&width=1946). No third-party image request is made by the player’s browser. Artwork retains its respective ownership.

Use `node scripts/interface-check.mjs` for isolated UI checks, `node scripts/native-startup-check.mjs` for native startup/room controls and the full five-minute idle regression, and `node scripts/autoplay-check.mjs` for browser sound permission. Set `SMASH_URL` to a disposable development host and `CHROME_PATH` explicitly. Native checks require testing auto-load on that isolated host. Older recorded-intro suites are historical and superseded.

## Diagnosing lag

Open **Menu → Connection → Download performance report** after a lag spike. The app keeps about ten minutes of timing samples; the backend keeps rotating private performance logs. v3.6.2 removes unnecessary graphics uploads, future input buffering and the extra render queue. The report includes measured input acknowledgement latency through the emulator, along with FPS, frame cost and network timing. Earlier fixes still separate live spectator transfers and voice from controller traffic, and let a delayed guest recover without pausing everyone. Voice remains optional and supported. See [the latency audit](PERFORMANCE.md) and [hosting diagnostics](HOSTING.md#performance-monitoring).

A fast download connection alone does not guarantee responsive play: upload congestion, round-trip latency and the browser's ability to emulate at 60 FPS matter too. The connection report shows these separately. Refresh every player's tab after updating.

Room counts show connected people. Leaving passes hosting to the next connected fighter, then a spectator. Refresh/disconnection has a 30-second identity reservation; rejoining from the same tab reclaims it without creating a duplicate or taking hosting back. An expired reservation joins as a new member; battle arrivals spectate until the next lineup.

In **Controller setup**, let go of the sticks, click any mapping and press the remaining buttons in sequence. Setup advances automatically, waits for release between presses, and saves each mapping with a confirmation. Reassigning an input removes its previous action so, for example, A does not also trigger C-down. Unused Windows axes resting at an endpoint do not block setup. Escape stops the sequence; **Reset preset** restores the device defaults.
