# Smash Together · 64

A free, self-hosted browser app for two friends to play the original US Super Smash Bros. N64 game online. Each player supplies their own ROM. Includes private invitations, Xbox and remappable N64 controllers, keyboard controls, direct WebRTC connections, a WebSocket fallback, synchronized save states, local progress saves, and free HTTPS sharing from a Mac.

## Play on this laptop

Open **http://localhost:8787**, or double-click **Desktop → Smash Together → Play Smash.command**. Use Google Chrome or Microsoft Edge on both computers.

1. Choose your original US `.z64`, `.v64`, or `.n64` ROM. It is verified and remembered in this browser. It is never uploaded or served by the app. On later visits click **Power on**.
2. Pair a controller in macOS/Windows Bluetooth settings, or plug it in by USB. Press a button, open **Controller setup**, and select it. Xbox controllers have a preset. For an N64 controller/USB adapter, use **Guided setup** or click individual mappings. Calibrate with the stick released. Mappings are remembered per device.
3. Enter your name, select a connection buffer, and click **Create private room**. Use **Copy invite link** and send that link to your friend. The app copies the public HTTPS address even when you play through localhost.
4. Your friend opens the invitation, loads their own ROM, configures their controller, and clicks **Join your friend**. You control player 1; your friend controls player 2.
5. Press **Start** to skip the intro, then Start again for the main menu. Choose **VS Mode → VS Start**. Move each hand to a fighter and press **A** to select; press Start, choose a stage with A, and play. Unselected player 3/4 slots are ignored by the game.

Keep both game tabs visible. Opening controller setup pauses both players and resumes with a synchronized state. Either player can pause or request a resync. If a guest disconnects, the host retains the invitation and current game so the guest can leave/rejoin. If the host leaves, create a new room.

### Controls

| N64 action | Xbox preset | Keyboard |
|---|---|---|
| Move / aim | Left stick | W A S D |
| A / attack / select | A | J |
| B / special / back | X | K |
| Z / grab | Left trigger | L |
| R / shield | Right bumper | O |
| Start | Menu / Start | Enter |
| C / jump | Y, B, or right stick left/right | I, Space, 1, 3 |
| D-pad / taunt | D-pad | Arrow keys |

N64 adapters differ: the guided mapper accepts any exposed button or signed axis. The live preview shows raw inputs, stick position and mapped actions. Adjust deadzone, range or vertical inversion as needed. Controllers must appear in the browser Gamepad API; pairing alone does not guarantee a particular adapter works. Physical controller hardware must be checked on your devices. Local play can use the selected input plus up to three additional gamepads.

### Saves

**Save progress / Load save** keeps a full snapshot in the current browser. **Export save / Import save** transfers a `.smash64` snapshot between computers or origins. These controls are available outside multiplayer. Load a local save before creating a room if you want to continue it with your friend. A new temporary sharing URL has separate browser storage; the host should use localhost for stable saved data. Export saves before clearing browser data.

## Hosting, cost and stopping

The app, runtime, relay and sharing software cost $0. There are no accounts, paid APIs or subscriptions required. Your laptop supplies compute and bandwidth.

**Desktop → Smash Together → Start Sharing.command** starts the login service. **Stop Sharing.command** stops the website, relay, tunnel and idle-sleep prevention. **Play Smash.command** starts the service if needed and opens Chrome. The service is installed for the current macOS user and starts at login.

Keep the laptop plugged in with its lid open while hosting. `caffeinate -i` prevents idle system sleep, but does not override closing the lid or manually sleeping the Mac. Display sleep is allowed. A server restart closes rooms; create a fresh invitation afterward.

A [Cloudflare Quick Tunnel](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/) gives the laptop a free temporary HTTPS address without opening router ports. It has no uptime guarantee and its hostname changes when restarted. This is suitable for the temporary laptop setup. The app automatically copies the current address. Logs and the current URL are in `.local/`; these files are not published. A future persistent hostname can use an existing domain and a named tunnel, but the current setup requires no domain purchase.

Service commands:

```sh
node scripts/service.mjs status
node scripts/service.mjs start
node scripts/service.mjs stop
node scripts/service.mjs uninstall
```

## Setup on another Mac / migrate to the Mac mini

1. Install Node.js 20 or newer (a current LTS is recommended), Git, and Chrome. No emulator compilation is needed to run the supplied app.
2. Copy this project to the mini, excluding `node_modules`, `.local`, `.git` if you do not need history, and `artifacts`. Keep `public/engine`. The browser ROM remains on each player's computer; the server does not need it.
3. In the project folder run `npm ci --omit=dev`, then `node scripts/service.mjs install`. The installer chooses the correct, checksum-verified Cloudflare binary for Intel or Apple Silicon and creates shortcuts with the new machine's paths.
4. Open `http://localhost:8787` on the mini to check it, then use the current HTTPS address on other computers. Export/import progress if changing the browser origin where you play. Create and share a new room invitation.
5. Stop the service on the old laptop after verifying the mini works. Keep the mini awake and signed into the user that owns its login service.

For foreground development, run `npm ci`, `npm start` and, in a second terminal, `npm run share`. A manual server binds only `127.0.0.1:8787`. `HOST` and `PORT` can be set for development. HTTPS or localhost is required for Web Crypto, controllers and audio; plain LAN HTTP is not supported. No browser extension is required.

## How multiplayer works

Each browser runs the same pinned N64Wasm emulator locally. The room checks ROM and engine identities. The host sends a compressed complete snapshot; **both** peers restore it so the interpreter begins from the same boundary. Each frame is executed only once both frame-numbered inputs are available. Inputs are delayed by 4/6/9/12 frames (about 67/100/150/200 ms at 60 FPS); choose a larger buffer for high latency. A short repeated input history covers direct-to-relay transitions. State hashes are compared every 60 frames; mismatches pause and restore the host's authoritative state automatically.

This is **delayed lockstep, not rollback**. Slow hardware or a slow connection can cause stalls and audio underruns. Direct peer connections use a public Cloudflare STUN service. When that is unavailable or blocked, the laptop's WebSocket relay carries inputs, avoiding a paid TURN service. Snapshots use the relay even with a direct input connection. Ordinary save states are roughly 16 MB before compression.

Rooms have unguessable invitation tokens, two seats, build/ROM checks, message limits, origin checking and host-only snapshot authority. The server forwards state without writing it to disk. Only the `public` directory is served. It has no ROM upload route, analytics or user accounts. Anyone with an invitation can occupy the second seat. Public internet traffic traverses the tunnel provider, and direct WebRTC connections can reveal peer network addresses to the other player. Keep invitations between the intended players.

## Verification

```sh
npm test                       # controls, byte order, server/room isolation
npm run check                  # syntax, runtime provenance, served-file audit
SMASH_ROM='/absolute/path/your.z64' npm run test:e2e
```

The end-to-end test needs a locally supplied ROM and Chrome. It never places that ROM in the project or server. It exercises two isolated browsers, actual game frames, state checks, transport fallback, pause/resume, deliberate desync repair, guest rejoin, controller mapping, and save persistence. Screenshots and results go to the ignored `artifacts/` folder. See `QA.md` for the completed checks and practical limits.

## Source, engine and licenses

The browser game uses [waveplate/M64Wasm](https://github.com/waveplate/M64Wasm), pinned at `f6b5d6cc31821ec501a94aa761eae022d08f5a9d`, based on Neil Barkhina's N64Wasm and the Mupen64Plus/libretro ecosystem. This is emulation, not a native Smash decompilation port. The [Smash decompilation](https://github.com/VetriTheRetri/ssb-decomp-re) is a separate project; its existence does not itself provide a browser multiplayer engine.

`upstream/m64wasm` is a Git submodule. Restore it with `git submodule update --init`. The distributed `.wasm` and JS are unmodified copies from the pinned upstream `dist`; `public/source/manifest.json` records their hashes. Runtime `assets.zip` replaces the upstream fonts with OFL-licensed Abel. Nintendo game assets are not included.

To rebuild the emulator: install/activate **Emscripten 2.0.7**, enter `upstream/m64wasm/code`, run `make clean` then `make`, and copy `dist/n64wasm.js` and `dist/n64wasm.wasm` to `public/engine/`. Change the protocol/build identifier when changing emulator behavior. `python3 scripts/package-source.py` rebuilds safe font assets, notices, the manifest, and the downloadable corresponding source archive. The archive includes the emulator code and build Makefile, application source, tests, and licenses, without ROMs or local service data.

Application code is GPL-3.0-or-later. N64Wasm's wrapper is MIT; incorporated emulator components keep their respective GPL/LGPL/BSD/MIT licenses and copyright notices. See `public/credits.html` and the source archive. Abel is SIL OFL; ws is MIT. Cloudflared is downloaded from its official release with a pinned SHA-256 check. This independent project is not affiliated with Nintendo or HAL Laboratory.
