# Hosting handoff: Ryker primary, Dan backup

## Current truth

The permanent game is **https://danielkimball.github.io/smash-together/**. Source is `danielkimball/smash-together`, branch `main`; static deployment is `gh-pages`. The primary backend is **Ryker's Windows PC**, host ID `ryker-windows`, published with his own GitHub account `widdlewyter`. Dan's existing Mac laptop is the manual backup; his eventual Mac mini still needs its own setup. Both use free Cloudflare Quick Tunnels.

The game frontend stays on GitHub Pages. `public/js/service.js` reads `active-host.json` to find the active Cloudflare backend. Browser-local ROM, name and controller storage therefore stays at one origin. This is a direct frontend, with no iframe and no full-page redirect to changing tunnel URLs. Clients emulate locally and receive identical server-agreed input frames through Cloudflare. Late inputs are neutral for that player; the rest of the match continues. WebRTC remains available for peer diagnostics and state hashes.

**Implemented today:** one active backend, public health checks, automatic recovery of that host's expired tunnel, Windows x64 tunnel download, verified Windows login startup, guarded primary ownership, tested idle-only main updates, and a stable player URL. **Not implemented yet:** automatic switching between Ryker's and Dan's computers, shared room state, or preserving an active match across loss of the backend. The design below is the next milestone; do not confuse single-host tunnel recovery with multi-machine failover.

## v3.7 rollout

The audio/shared-device/live-lobby release uses room protocol 7 and build suffix `-smash-native-v7`. Let the normal idle-only updater validate and publish the backend and static assets together. Do not interrupt occupied rooms. After deployment, every player should refresh the permanent site (Windows: Ctrl+F5); cached older room clients receive a reload message. Use one tab per computer and **Players on this device** for multiple controllers. Listening is automatic, microphone capture remains explicit, and browser autoplay may still require **Audio & Voice → Enable sound**.

## What Ryker can tell Codex

> Pull the main branch of https://github.com/danielkimball/smash-together onto this Windows computer. Read AGENTS.md and HOSTING.md, install and verify it, then help me take over as the primary host. Use my GitHub account widdlewyter. Keep the permanent player URL and preserve Dan's backup plan. Verify the public connection before publishing my host address.

Ryker's **write** access was confirmed on 2026-10-22. The public code can be cloned immediately; publishing the active host address needs Ryker's own authenticated GitHub CLI.

## Windows setup

Use PowerShell and detect existing Git, Node, GitHub CLI and Chrome installations first. Node **20+ x64** is required by the supplied Windows tunnel downloader. Do not copy Mac executable paths. If prerequisites are absent, use official installers or an already-authorized package manager. No emulator compilation, Cloudflare account, domain purchase, router port-forwarding or inbound firewall exception is needed for the Quick Tunnel route.

```powershell
git clone --branch main --single-branch --depth 1 https://github.com/danielkimball/smash-together.git
Set-Location smash-together
npm ci
npm test
npm run check
New-Item -ItemType Directory -Force .local | Out-Null
Copy-Item config.example.json .local/config.json
```

Do not overwrite an existing `.local/config.json`; merge deliberately and keep a private backup. The example has `publishLink: false`, so first startup cannot replace Dan's current public backend. It intentionally has no ROM path, password or credentials. GitHub CLI login is per person; `gh auth status` and `gh api user --jq .login` must report Ryker's own account.

First verify foreground hosting:

```powershell
npm run host
```

The host runs Node on `127.0.0.1:8787`, downloads official checksum-verified cloudflared to `.local/bin/cloudflared.exe`, starts a Quick Tunnel and verifies its public `/api/status`. Logs show `SHARE_URL=...` only once the endpoint works. In a second PowerShell:

```powershell
Invoke-RestMethod http://127.0.0.1:8787/api/status
$Share = Get-Content .local/share.json -Raw | ConvertFrom-Json
Invoke-RestMethod ($Share.url + '/api/status')
```

Use Chrome at localhost to load Ryker's own original US ROM and create a test room. Test a second browser through the public URL, then a device on a different network. Check native menus, N64 mapping, a real battle, menu music, room joining and reconnect behavior. `CHROME_PATH` can point automated e2e checks at the installed Windows Chrome executable; automated contexts must exclude real paired controllers. Do not use Dan's Mac ROM path. The optional password testing endpoint stays disabled unless Ryker explicitly configures his own local copy and a password hash.

Stop the foreground process before installing background startup:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/windows-service.ps1 install
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/windows-service.ps1 status
```

The script registers a task for the current user's login and keeps logs in `.local/host.log`. It runs with that user's permissions, so their GitHub credentials remain available. `-ExecutionPolicy Bypass` applies only to that PowerShell process, not the machine's global policy. If Task Scheduler registration is restricted, `start` can run the host in the background for the current session; report that login startup was not installed. Keep the computer awake and signed in. The login task and background hosting were installed and exercised on Ryker's Windows PC. Locking does not sign the user out. The runner requests that Windows stay awake while allowing the screen to turn off; this cannot override manual Sleep, Hibernate, shutdown or loss of power.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/windows-service.ps1 start
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/windows-service.ps1 stop
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/windows-service.ps1 restart
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/windows-service.ps1 uninstall
```

A full Windows host restart closes rooms and may rotate the tunnel. `uninstall` removes the login task but keeps source and private data. Do not run the foreground host and the scheduled task simultaneously.

## Primary ownership and manual backup

The permanent frontend uses only `active-host.json`, never legacy `server.json`. This protects it from Dan's older automatic publisher without requiring access to his computer. Current publishers must match both the registered `hostId` and GitHub account. A collaborator can deliberately promote a different host; ordinary startup and auto updates cannot do so. This is an operational guard, not an access-control boundary against repository owners.

For an initial promotion or an explicitly requested backup handoff:

1. Install current main on the destination and assign a unique private `hostId` (Ryker: `ryker-windows`; Dan: `dan-mac`). Start with `publishLink: false`. Use that person's own GitHub login.
2. Verify the destination public `/api/status`, matching host ID, CORS and a game. Check the current host's `activeRooms`, including private rooms, before cutting over. Existing matches cannot migrate.
3. Enable `publishLink` on the destination, with `pagesRepo` and `frontendUrl` set to this repository and permanent address. Explicitly run `node scripts/publish-link.mjs <verified-tunnel-url> --promote`.
4. Wait for the **deployed** `active-host.json` to match the destination. Publish current static assets with `node scripts/publish-pages.mjs` if necessary, then test the permanent site in two browsers.
5. The previous record is retained as backup information. A Quick Tunnel can expire; always verify the backup anew before promoting it. Ordinary publication by the old primary is now rejected. Older code can only modify ignored legacy `server.json`. Disable publication on the old machine when access is available, but changing its private configuration is no longer required for the guard to work.

If Ryker goes offline, Dan's machine does **not** take over automatically. Someone must start and verify that machine and explicitly promote it using these steps. Return to Ryker using another explicit promotion. Players create fresh rooms after backend loss. Do not clear browser storage or change the player address. Already-open old frontend tabs should reload once after this upgrade.

## Windows automatic updates and everyday controls

Ryker's checkout is `C:\Users\ryker\Documents\SmashPortalHost\app`. Private tool paths, host ID and publication settings live in `.local/config.json`. GitHub authentication stays in Windows Credential Manager; the ROM remains outside the checkout. Ryker has explicitly enabled open testing: `testing.autoLoad: true` loads his local cartridge without a picker or password. Anyone who can reach this host can use that endpoint during testing. Set `autoLoad` to false to restore password access, or remove `testing` to restore bring-your-own-ROM only. ROM bytes and the private path never enter Git or Pages. Background validation still prevents incompatible games.

Set private `autoUpdate: true` and `pythonPath`, along with `nodePath`, `gitPath` and `ghPath` where required. Install the updater using:

`powershell -NoProfile -ExecutionPolicy Bypass -File scripts/windows-updater.ps1 install`

The current user's login task checks `origin/main` every minute. It prepares a separate candidate, installs locked dependencies, runs tests/checks, and rebuilds corresponding source with the pinned submodule. A temporary drain prevents new rooms during the final idle check; both public and private rooms count. It waits for all rooms to close, switches to the tested commit, restarts and verifies the public connection, and publishes safe static files while preserving host records. Server startup failure restores the prior commit. Commits pushed from this hosting checkout also get validated and restarted. A private runtime marker prevents repeating a completed restart merely because Pages is delayed. Stalled Pages build requests are retried after five minutes; unsuccessful publication is retried on the next update check. Source edits stop deployment instead of being overwritten. Failed validation leaves the running version in place. A deliberately stopped host stays stopped.

Use **Desktop > Smash Portal > Start Hosting / Stop Hosting / Restart Hosting / Play Smash**. Full restart closes rooms and may take a few minutes to restore the free public connection. Logs: `.local/host.log` and `.local/updates.log`. Remove the updater with `scripts/windows-updater.ps1 uninstall`; host `uninstall` is separate.

Windows tasks and hosting shortcuts use a small GUI-subsystem launcher compiled locally from `scripts/windows-runner.cs`. It starts PowerShell with no console window, preserves task exit codes and keeps errors in `.local/launcher-*.log`. This avoids the brief console flash caused by scheduling PowerShell directly with `-WindowStyle Hidden`. Install scripts build the launcher using Windows' existing .NET Framework; no additional download is needed. Generated executables stay in `.local`, outside Git and Pages.

Keep this PC plugged in, connected to the internet and signed in. **Windows+L** is safe. In **Settings > System > Power & battery (or Power) > Screen, sleep & hibernate timeouts**, set plugged-in sleep to **Never**. The screen may turn off. Ryker's plugged-in sleep and hibernate timeouts were already Never. Do not choose Sleep/Hibernate or shut down; after reboot, sign in once to start these tasks. Running before login would require a separately configured service and is not claimed here.

## Automatic failover design and implementation order

Keep the permanent frontend and use a **two-host registry**, instead of letting both computers overwrite one `url`. Example target shape (not accepted by today's client yet):

```json
{
  "version": 2,
  "preferredHost": "ryker",
  "hosts": {
    "ryker": { "url": "https://primary-example.trycloudflare.com" },
    "dan": { "url": "https://backup-example.trycloudflare.com" }
  }
}
```

1. Each host updates only its own registry entry using the GitHub file SHA for conflict detection and retry. Publish only a publicly verified endpoint. Registry updates happen when a tunnel address changes; **do not use GitHub commits/Pages builds as a heartbeat**. Preserve the other host's record.
2. The frontend probes both actual `/api/status` endpoints with bounded timeouts. Prefer Ryker for **new** rooms; use Dan when Ryker is unhealthy. Probe the host URLs directly, so choosing an already-registered backup does not wait for a Pages build. Show a useful availability/error state and retry transient failures.
3. Bind every room/socket/invitation to a stable `hostId`, in addition to its unguessable room token. Aggregate public room lists from healthy hosts and route joins to the room's owning backend. Keep existing backup rooms on Dan when Ryker returns; only new rooms switch back. This avoids players entering different servers for the same room.
4. If a room's backend disappears, pause and explain that the host connection was lost. Try the original backend for reconnect; if it is gone, offer to create a new backup room. Never send an existing room token to an unrelated empty backend and imply the match survived.
5. Test host isolation, simultaneous registry writes, primary-down at entry, loss during a room, secondary-down, transient failures, stale cached registry, primary recovery, room-affinity invites, ROM/profile persistence, and power/network loss on both real machines. Keep CORS restricted to the permanent frontend and preserve the configured testing-access mode.

This delivers **automatic availability for new sessions** without pretending the two in-memory servers are one room server. For seamless continuation of an active match, add an independent coordinator and replicated authoritative room state: membership/tickets, room tokens, host authority, roster revision, match generation, last agreed frame/snapshot, input history and winner metadata. Define which host owns the room and prevent both backends advancing it. Test host failure mid-frame and mid-snapshot before advertising seamless recovery.

Do not put two independent in-memory room servers behind replicas of one tunnel and assume it is failover: requests can reach servers with different room state. The current state lives in memory and is not shared. Account-based Cloudflare hosting or a coordinator can be evaluated later; no paid service or new account has been configured in this handoff.

## Operations and latency

- Keep players on the permanent origin. A new machine/browser or cleared site data needs its own first ROM load; existing permanent-site data stays in that browser during host changes.
- Public `gh-pages` contains only the safe `public/` payload plus the registry and notices. Update app source on `main`. Use a separate Pages checkout for publishing; preserve the live registry when copying static files. Rebuild corresponding source after code changes.
- For Mac hosting, `node scripts/service.mjs install` manages launchd; `restart` only restarts the backend while retaining a healthy tunnel. `shortcuts` refreshes Desktop links without restarting. The Mac uses `caffeinate -i`; lid closure/manual sleep still stops availability.
- Faster bandwidth helps snapshots and relayed inputs, but round-trip latency, jitter and client frame speed affect gameplay. Inputs use server-agreed frames with deadlines. Updated clients send their current controller state for the next server tick, with no deliberate future-frame buffer. Brief jitter holds input for at most 150 ms before neutral; this never waits for the affected player. Cached older clients keep their legacy buffered path until refreshed. Measure two-house performance instead of calling a local multi-browser check a remote-latency result.
- Quick Tunnels are temporary and carry no uptime guarantee. The host already recycles revoked/unhealthy tunnels. See [Cloudflare's Quick Tunnel documentation](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/) and [Microsoft's scheduled-task documentation](https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/register-scheduledtask).

## v3.6 room handoff and lag limits

Missing inputs and brief delivery stalls do not freeze other players. The server fixes every frame; browsers cannot independently predict different outcomes. A guest with slow Wi-Fi experiences delayed or missed controls and catches up when delivery resumes. Battle disconnects leave neutral controllers. Battle reconnects and spectators receive targeted snapshots and replay frame history while others continue. Losing the room host transfers authority to the next connected fighter, then the oldest spectator. Losing the Windows backend still ends the room. Manual pause and fighter-state repairs still synchronize the group. Slow devices cannot be made full-speed by networking changes. This is server sequencing, not rollback or automatic server failover.

## Voice and larger rooms

Rooms allow eight people and four active fighters. Spectators run the game locally and can join room voice. Voice requires explicit microphone permission and uses transient audio packets over a separate secure media connection. Several people talking add upload traffic to this Windows host; silence suppression limits unused traffic. No microphone is captured on the server and no recording is stored. Players and Voice buttons are beside Menu in the game toolbar. See README for rotation rules.

A browser room host is different from this Windows hosting computer. Room-host handoff is automatic within this running backend. Switching from Ryker's server to Dan's and recovering matches after backend loss are still not implemented. Preserve the manual backup procedure and primary ownership guard.


## Performance monitoring

The server writes private, numeric performance summaries every 30 seconds while rooms exist to `.local/performance.jsonl`, rotating at approximately 5 MB to `.local/performance.jsonl.1`. Read the latest entries on Windows with `Get-Content .local/performance.jsonl -Tail 10`. No audio, game-state content, player names, room names, IP addresses or invitation/reconnect tickets are recorded. Aggregate backend scheduling metrics are also in `/api/status`; per-room reports require that room's host connection.

Players can use **Menu → Connection → Download performance report** after a bad moment. The report contains up to ten minutes of five-second browser measurements. The room host's export also includes the latest anonymized member reports. Compare input acknowledgement latency (`inputAckAvgMs`, `inputAckP95Ms`, with `inputAckSamples`), backlog, emulator frame cost, RTT and delivery gaps before deciding a problem is bandwidth. Acknowledgement timing runs from publishing the controller sample to finishing the emulator frame that includes it; it excludes physical controller sampling, display scanout and any native game animation delay. `inputBuffer: 0` means no deliberate queued-input delay, not zero network latency. See [PERFORMANCE.md](PERFORMANCE.md) for the audit, measurements and interpretation.

Gameplay uses the original `/room` WebSocket. Voice and live spectator/recovery snapshots use an additional authenticated `/media` WebSocket at the same backend origin. Cloudflare forwards both without router changes. Each room member can have one of each; losing media does not disconnect their controller. Planned group synchronization retains its ordered room connection. Refresh old tabs after deployment to enable the new transport, vertex-buffer renderer and immediate input timing.


## Tunnel transport

v3.6.4 defaults to `tunnelProtocol: "http2"`, the primary's previously working transport. The v3.6.3 QUIC-first experiment registered only HTTP/2 on the actual host and a later restart had a prolonged publication delay; no public QUIC benefit is established. An operator can explicitly try `tunnelProtocol: "auto"` (QUIC with HTTP/2 fallback) or `"quic"` after verifying connectivity. This needs no inbound router ports or firewall changes. Keep the working default on the primary until host logs and gameplay measurements justify a change.

`/api/status.tunnelProtocol` shows the last successfully registered transport, not merely the requested setting. Private performance records and host downloads encode `tunnelTransport` as 0 unknown, 1 QUIC, 2 HTTP/2. Compare clock lateness, RTT, delivery gaps and input acknowledgement p95: a zero input buffer and 60 FPS do not rule out intermittent network latency. [Cloudflare's protocol/fallback behavior](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/run-parameters/).
