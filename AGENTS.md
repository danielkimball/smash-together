# Smash Portal: instructions for the next coding agent

Read this file, `HOSTING.md`, `README.md` and `QA.md` before changing or hosting the project. Check the actual checkout and live APIs; notes can become stale.

## People, repository and intent

- Dan owns `danielkimball/smash-together`. Ryker is Dan's brother, GitHub `widdlewyter`, and uses **Windows**. His write access was confirmed on 2026-10-22.
- `main` is application source, including these instructions. `gh-pages` is the deployed **contents of `public/`**, plus `.nojekyll`, `active-host.json`, legacy `server.json`, `deployment.json` and a short README. Do not replace the Pages branch with the source tree or publish `.local`.
- Permanent player address: **https://danielkimball.github.io/smash-together/**. Keep the frontend on this origin so ROMs, names and controller profiles survive backend changes. Route API/WebSocket connections to Cloudflare; do not redirect the full page to a rotating tunnel.
- Hosting target: Ryker's Windows computer becomes primary; Dan's laptop, later Mac mini, becomes backup. Ryker's Windows PC is the selected primary; Dan's existing Mac is the manual backup. The Mac mini is not configured yet. **Automatic multi-machine failover is a design/next task, not a completed feature.** Do not claim active matches survive losing the server.

## When Ryker says “pull Dan's project and start hosting”

Treat this as an instruction to do the work, using CLI/APIs first. Follow the Windows procedure in `HOSTING.md`; detect paths and installed tools instead of copying Dan's Mac paths. Install locked dependencies, verify the app locally, create a private config from the example, and start the host. First use `publishLink: false` so setup does not replace the current public backend before it works. Verify the actual public endpoint, then perform the documented primary-host handoff. Check live rooms before a cutover; a server change closes/replaces those rooms. Keep the user informed of that concrete impact.

Use Ryker's own GitHub login. Never copy Dan's credentials. The public source is already readable without accepting the invitation; repository writes require his own authenticated account. Windows startup can be managed with `scripts/windows-service.ps1`; the automatic Cloudflare download supports **x64 Windows** and Intel/Apple Silicon Macs. Windows hosting and login startup were exercised on Ryker's PC. See QA.md for the exact verification limits.

## Product behavior to preserve

- Smash Portal branding: black `#000000`, CRT white `#fafafa`, red `#ff0028`, idle blue `#8282aa`, yellow `#ffff00`, green `#22b573`. Local Josefin Sans Semibold headers/buttons, Instrument Sans Condensed Medium Italic copy, Orbitron Medium labels. Supplied logo in `public/brand`; do not redraw it.
- Original N64/Master Hand opening with music. Audible autoplay may require one click. Then a **silent looping fire title**, including behind the ROM modal; no title announcer and no How to Play transition. Verified/cached original US ROM opens the actual native Mode Select. Mouse hover highlights the native icon; no HTML Multiplayer overlay. VS opens the branded room browser while native menu music keeps playing.
- Name/Create/Join and all open rooms support controller up/down + A. The funny default name saves immediately. A on the name opens the controller keyboard; Start saves, B deletes. Typing works normally.
- DragonRise USB `0079:0006` preset, one-based labels: A7, B9, Z8, R6, L5, Start10; C up1/down3/left4/right2; axes 1/2; D-pad up13/down14/left15/right16. Keep user remaps/calibration. Storage keys use stable device IDs, not gamepad indices. macOS Launchpad is an OS shortcut; web mapping cannot consume it. Dan's OS setting was disabled, but his physical B-button check remains unconfirmed.
- Native rules and gameplay, all 12 fighters / 9 VS stages, winner-only next-stage selection, server-agreed controller frames, shared pause and reconnects must remain intact. Protocol 6, build suffix `-smash-native-v6`. Core binaries are pinned and unchanged.

## Engineering and operating practices

1. Check `git status`, active service/processes, local `/api/status`, public health and `/api/rooms`. Preserve unrelated changes and live games. The frontend reads only `active-host.json`. Normal publication requires matching hostId and GitHub account; switching owners requires explicit --promote. Older Dan processes can write legacy server.json without changing the selected host. Never automatically promote a backup.
2. Node 20+; `npm ci` installs the lockfile. Run `npm test` and `npm run check`. Run relevant isolated-browser checks for behavior changes. Set `SMASH_URL`, `SMASH_ROM`, `CHROME_PATH` and optional `SMASH_TEST_PASSWORD` deliberately; never let a test control a real paired controller or join a person's room.
3. Never commit/publish ROMs (`.z64/.v64/.n64`), saves, `.local`, passwords, tokens, logs, `node_modules` or `artifacts`. ROM validation/caching stays browser-local. Testing defaults to password gating. Ryker explicitly enabled `testing.autoLoad: true`: no picker/password prompt; background byte validation stays intact. Leave testing disabled on new hosts.
4. Use GitHub CLI/API for source, collaborator and deployment operations; do not open browsers to do API-capable work. Use separate disposable browser contexts only for necessary rendering/gameplay checks.
5. Do not change emulator binaries casually. Verify `public/source/manifest.json`, retain licenses and rebuild corresponding source with `python scripts/package-source.py` after source changes. The upstream submodule is pinned; restore it before packaging.
6. Keep GitHub player origin fixed. GitHub Pages handles static files; the active computer handles room signaling, compressed snapshots and fallback relay. Game simulation runs in each player's browser. Fast upload helps hosting, but latency/jitter and every player's hardware still matter. The server fixes inputs at 60 Hz without waiting for missing controllers. Updated clients retain held input through brief jitter, then become neutral after 150 ms of silence. Clients catch up from the identical frame stream. This is not rollback; do not promise zero lag.
7. Keep the host signed in, online and awake. Prefer wired networking where available. Do not expose router ports, disable firewalls, change global power policies or introduce paid services as an assumed prerequisite.
8. Diagnose before broad rewrites. Mac backend-only restart preserves a healthy tunnel; Windows full host restart can rotate it. Check a new tunnel publicly before advertising it. Verify `active-host.json` through the deployed Pages URL, not just a successful Git push. GitHub builds can be delayed.
9. Windows main updates run every minute through scripts/windows-updater.ps1. They validate a separate candidate, defer while any public or private room exists, and publish through a separate Pages checkout. Preserve the ownership guard, private data and source archive; leave a deliberately stopped host stopped.
10. After a change, update this handoff if roles change, `HOSTING.md` for operating instructions and `QA.md` with what actually passed. Distinguish automated tests, real Windows/controller checks, and actual two-house performance.

## Code map / known traps

`server.mjs`: HTTP/rooms/testing/CORS. `public/js/service.js`: stable frontend asset paths and backend discovery. `netplay.js`: transport and synchronization. `engine.js`: native emulator/state. `app.js`: menus, lobby, controller keyboard and continuous menu music. `controls.js`: mappings. `attract.js`: recorded opening/silent fire. `rounds.js`: winner authority. `scripts/host.mjs`, `share.mjs`, `publish-link.mjs`: hosting and public link publication.

Preserve the live canvas under overlays; screenshots of a hidden WebGL canvas can be blank. Native character selection ignores Start during its first second. Release held Start/A between entry screens. Native mouse hover changes menu selection, so tests must move the pointer away before keyboard-only navigation. Storage is per browser and origin; old temporary links cannot automatically donate their cache to the permanent site.

## v3.5 navigation and networking

B in selection recalls your placed token first; a separate B with no selected fighter leaves the room. Top-right Back always leaves. B in the multiplayer browser returns to native Mode Select. Host Start is read independently of network deadlines; an authorized server seal schedules the native Start pulse on the agreed timeline. Do not restore the old native-back-to-lobby loop. Touch Auto hides controls when a browser-visible controller exists; the phone toolbar can show/hide them or enter fullscreen. Supplied vector is `public/brand/smash-portal-animated.svg`, copied without redrawing.

The server clock (`scripts/frame-clock.mjs`) stamps one shared input set per frame. Peer packets never override it. Test missing guest inputs and delayed guest frame delivery, catch-up and matching hashes. Mid-battle disconnect reserves the fighter with neutral inputs; room host loss transfers authority to the next connected fighter, then the oldest spectator. Battle reconnects and spectators use targeted snapshots plus frame history. Selection roster changes, explicit pause and fighter-state repairs synchronize the group. Backend server loss still closes rooms. Preserve permanent origin, host ownership, idle updates and pinned emulator bytes.

## v3.6 rooms, voice and pointer input

Eight members, four fighters, FIFO spectator queue. Read `scripts/room-roster.mjs` before changing rotations. FFA keeps the winner unless they sit out; fill vacant fighter places first. Teams preserve the winning pair, with the seven-person higher-KO pairing documented in README. Host overrides are authoritative. Changing availability during a battle affects the next lineup, not current controller input. Host role is independent of fighter slot.

RoomVoice requires an explicit Join Voice gesture. The host enforces individual and spectator mutes; allowing a muted person to speak never unmutes their local microphone. AudioWorklet mixes transient 16 kHz mu-law packets over the secure media WebSocket, without TURN or recording. Players and Voice panels do not pause matches. Windows Playwright WebKit lacks AudioContext/mediaDevices; the game remains usable silently and voice explains the limitation. This does not establish physical iPhone microphone behavior.

Menu pointers are commands on the shared server frame timeline. Only menus reposition native cursors through the official serializer; all gameplay scenes ignore pointer input. Emulator binaries and ROM remain unchanged. Main-menu clicks wait for native initialization before reading the selected row. Touch taps retain a short minimum pulse; interruption releases held controls.

Focused checks: `room-check.mjs`, `touch-layout-check.mjs`, `menu-check.mjs`, `rotation-check.mjs` and `webkit-room-check.mjs` in scripts. They use isolated contexts and local ROM access. Avoid running many emulator suites together: competing renderers on this PC can fall behind the server clock. QA.md distinguishes automated checks from physical iPhone/Bluetooth and two-house testing.


## v3.6.1 latency regression fixes

Read `PERFORMANCE.md` before changing timing. Preserve independent 60 Hz server deadlines: a missing controller must not stall others. `public/js/input-timing.js` uses median RTT plus a bounded, rate-limited jitter margin; unsent/historical missed frames must not inflate the buffer. Do not reintroduce local frame-clock debt on top of the server timeline. A badly delayed non-host can request a targeted snapshot without pausing the group.

Voice and live snapshots use a ticket-authenticated `/media` connection. Group sync stays on `/room`. Replay history follows targeted snapshots on their transfer connection; preserve already received live frames across restoration because channels can arrive in either order. Coalesce/serialize observation transfers, bound queues and keep media disconnect independent of controller lifetime. Protocol/core binaries remain unchanged.

Numeric telemetry is bounded and private (`.local/performance.jsonl`, five-second browser samples and a downloadable Connection report). Never add microphone data, ROM/state bytes, actual controller inputs, names, IP addresses or invitation/ticket values to logs. The eight-member network test is synthetic; real browser tests share one Mac CPU/GPU and cannot certify geographically separated performance.

Room counts and member/voice panels show connected people. Explicit leave removes immediately; unexpected disconnect reserves identity for 30 seconds, with five-second heartbeats for silent loss. Expiry does not stop the battle clock. Same-tab public joins reuse the room ticket, and authenticated replacement of an old socket cannot steal hosting back. Never deduplicate by display name. Controller mapping advances from any selected row; require gamepad release and ignore keyboard repeats. `scripts/session-check.mjs` covers refresh/rejoin counts, handoff, and all 18 mappings.

## v3.6.2 performance priority

Dan explicitly prioritizes responsive gameplay over every optional feature. Read the second audit at the top of `PERFORMANCE.md`. Engine config slot 46 enables the existing renderer's VBO path; disabling it causes repeated per-attribute graphics uploads and reproduced multi-second combat backlog. JS/WASM binaries remain pinned and unchanged. Do not leave already received frames waiting in the app render loop; drain them within the bounded callback budget.

The server advertises `inputMode: "latest"`. Updated clients send monotonic `input-state` sequences on changes plus 50 ms heartbeats, with no future input window. The clock uses current state at its next fixed tick, retains short button presses between ticks, and releases a silent controller after 150 ms. Disconnect/session replacement clears held state and sequences immediately. Old `input` packets remain supported per slot for cached clients; InputTiming is now that compatibility path only. Preserve slot authorization, epoch/revision checks, immutable agreed frames, and independent slow-player behavior. This is still not rollback.

Numeric input acknowledgement measurements follow sequence IDs through the server frame into the emulator; they do not measure physical controller or display scanout delay. `scripts/performance-check.mjs` runs sustained private two-browser combat and checks FPS, backlog, controller transitions and matching states. Existing flow/e2e fault injection must drop both `input` and `input-state` packets. Keep voice/media isolation, session cleanup and guided mapping from v3.6.1.

Cartridge acceptance, automatic host download and core startup each share a completion promise. Never restore the old early-return `loading` boolean: a second load could start local menu emulation inside a live room. `runSequence` must not advance local menu frames when netplay is running. `scripts/load-race-check.mjs` exercises overlapping automatic/manual loads; do not dismiss the broad test’s duplicate-load case as merely a harness artifact.

Use `scripts/four-fighter-check.mjs` to isolate one browser rendering all four fighters, with three explicitly synthetic network controllers. Do not describe it as four independently emulating devices. Four full browser emulators overload Dan’s Intel Mac; the two-real-browser combat check and synthetic-controller rendering check have distinct scopes.

## v3.6.3 public-path follow-up

The v3.6.2 public test exposed simultaneous delivery/RTT spikes despite 60 FPS; its p95 latency target failed. Do not hide that result behind local measurements. Hosting now defaults to Cloudflare `auto` (QUIC with HTTP/2 fallback), with optional private `tunnelProtocol` override. Record protocol only after successful registration; `/api/status.tunnelProtocol` and numeric `server.tunnelTransport` expose it. Preserve automatic fallback and health recycling; do not open router ports/change firewalls or claim that QUIC guarantees zero jitter. See PERFORMANCE.md for evidence and source links.
