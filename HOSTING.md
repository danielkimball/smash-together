# Hosting handoff: Ryker primary, Dan backup

## Current truth

The permanent game is **https://danielkimball.github.io/smash-together/**. Source is `danielkimball/smash-together`, branch `main`; static deployment is `gh-pages`. The live backend currently runs on **Dan's Mac laptop** through a free Cloudflare Quick Tunnel. **Ryker (`widdlewyter`) uses Windows** and is intended to become the primary host. Dan's laptop, later his Mac mini, is intended to be backup.

The game frontend stays on GitHub Pages. `public/js/service.js` reads `server.json` to find the active Cloudflare backend. Browser-local ROM, name and controller storage therefore stays at one origin. This is a direct frontend, with no iframe and no full-page redirect to changing tunnel URLs. Clients emulate locally, use direct WebRTC inputs when possible, and fall back to the active host's WebSocket relay.

**Implemented today:** one active backend, public health checks, automatic recovery of that host's expired tunnel, Windows x64 tunnel download, Windows startup script, and a stable player URL. **Not implemented yet:** automatic switching between Ryker's and Dan's computers, shared room state, or preserving an active match across loss of the backend. The design below is the next milestone; do not confuse single-host tunnel recovery with multi-machine failover.

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

The script registers a task for the current user's login and keeps logs in `.local/host.log`. It runs with that user's permissions, so their GitHub credentials remain available. `-ExecutionPolicy Bypass` applies only to that PowerShell process, not the machine's global policy. If Task Scheduler registration is restricted, `start` can run the host in the background for the current session; report that login startup was not installed. Keep the computer awake and signed in. This implementation has been prepared from macOS; its first Windows execution, Task Scheduler behavior and power behavior require verification on Ryker's actual machine.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/windows-service.ps1 start
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/windows-service.ps1 stop
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/windows-service.ps1 restart
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/windows-service.ps1 uninstall
```

A full Windows host restart closes rooms and may rotate the tunnel. `uninstall` removes the login task but keeps source and private data. Do not run the foreground host and the scheduled task simultaneously.

## Promote Ryker without two competing publishers

1. Verify Ryker's local and public endpoints, game version, browser CORS access and a real test room before replacing the public address. Check the current public `/api/rooms`; schedule any cutover around active players.
2. **On Dan's host**, remove `pagesRepo` from private `.local/config.json` and set `publishLink: false`. Removing `pagesRepo` also disarms older already-running publisher code. Keep `frontendUrl` and any private testing config. Dan can keep his backend running, but it must not overwrite the single active `server.json` record.
3. **On Ryker's host**, set `publishLink: true`, keep `pagesRepo: "danielkimball/smash-together"`, and `frontendUrl: "https://danielkimball.github.io/smash-together/"`. Set `ghPath` only if `gh` is not on PATH; use the locally detected executable path.
4. With his verified tunnel running, publish its address:

   ```powershell
   $Share = Get-Content .local/share.json -Raw | ConvertFrom-Json
   node scripts/publish-link.mjs $Share.url
   ```

5. Verify the **deployed** `https://danielkimball.github.io/smash-together/server.json` points to Ryker, not merely that the GitHub commit exists. Pages publication can be queued; the old host must remain available during that interval. If necessary, request the configured Pages build through `gh api --method POST repos/danielkimball/smash-together/pages/builds` and observe its result.
6. Open the permanent game in two isolated browsers and verify ROM loading, create/join, actual gameplay, an invitation and reconnect. Existing rooms on Dan's backend do not migrate; finish them or create fresh rooms on Ryker's backend. Do not clear browser storage during the move.
7. Update `AGENTS.md` and this file with the verified active host, operating system and test results. Never commit `.local` or credentials.

### Manual recovery until automatic failover exists

If Ryker's backend is unavailable, start/verify Dan's host publicly, ensure Ryker's publisher is disabled, restore Dan's `pagesRepo`, enable his `publishLink`, and run `node scripts/publish-link.mjs <verified-Dan-tunnel>`. Wait for deployed `server.json` and verify the permanent site. Players recreate rooms; a lost match does not silently continue on another server.

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
5. Test host isolation, simultaneous registry writes, primary-down at entry, loss during a room, secondary-down, transient failures, stale cached registry, primary recovery, room-affinity invites, ROM/profile persistence, and power/network loss on both real machines. Keep CORS restricted to the permanent frontend and preserve password gating.

This delivers **automatic availability for new sessions** without pretending the two in-memory servers are one room server. For seamless continuation of an active match, add an independent coordinator and replicated authoritative room state: membership/tickets, room tokens, host authority, roster revision, match generation, last agreed frame/snapshot, input history and winner metadata. Define which host owns the room and prevent both backends advancing it. Test host failure mid-frame and mid-snapshot before advertising seamless recovery.

Do not put two independent in-memory room servers behind replicas of one tunnel and assume it is failover: requests can reach servers with different room state. The current state lives in memory and is not shared. Account-based Cloudflare hosting or a coordinator can be evaluated later; no paid service or new account has been configured in this handoff.

## Operations and latency

- Keep players on the permanent origin. A new machine/browser or cleared site data needs its own first ROM load; existing permanent-site data stays in that browser during host changes.
- Public `gh-pages` contains only the safe `public/` payload plus the registry and notices. Update app source on `main`. Use a separate Pages checkout for publishing; preserve the live registry when copying static files. Rebuild corresponding source after code changes.
- For Mac hosting, `node scripts/service.mjs install` manages launchd; `restart` only restarts the backend while retaining a healthy tunnel. `shortcuts` refreshes Desktop links without restarting. The Mac uses `caffeinate -i`; lid closure/manual sleep still stops availability.
- Faster bandwidth helps snapshots and relayed inputs, but round-trip latency, jitter and client frame speed affect gameplay. Direct WebRTC remains preferred. Start with the four-frame buffer; use larger buffers only when the actual connection needs them. Measure two-house performance instead of calling a local multi-browser check a remote-latency result.
- Quick Tunnels are temporary and carry no uptime guarantee. The host already recycles revoked/unhealthy tunnels. See [Cloudflare's Quick Tunnel documentation](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/) and [Microsoft's scheduled-task documentation](https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/register-scheduledtask).
