# Public-path follow-up — v3.6.3

The deployed v3.6.2 test held ~59.9 FPS with zero repairs and ~49–50 ms median button-to-emulator completion, but failed the strict tail-latency/backlog target: p95 was 214–220 ms, and render backlog p95 six frames. Both clients saw the same 179 ms frame-delivery gap, RTT temporarily rose to 160 ms, emulator work stayed ~7.5–7.6 ms, and no browser long tasks were recorded. That points to shared delivery-path jitter rather than a sustained rendering bottleneck; it does not by itself identify the ISP, Wi-Fi or Cloudflare as the source.

The hosting launcher was hard-coded to `--protocol http2` from the initial commit. This carries tunnel streams over shared TCP, so the separate game/media WebSockets can still block behind packet loss on that connection. v3.6.3 uses Cloudflare's recommended **`auto` transport: QUIC first, with automatic HTTP/2 fallback when UDP connectivity cannot be established**. This reduces a possible shared-transport bottleneck; it cannot eliminate all network jitter. No firewall/router changes, new service, paid plan or credentials are required. Hosts can explicitly set `tunnelProtocol` to `http2` if their network requires it. [Cloudflare transport documentation](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/run-parameters/), [Cloudflare protocol selection source](https://github.com/cloudflare/cloudflared/blob/master/connection/protocol.go).

The host records the transport from successful registration logs, including chunked messages and later fallback. `/api/status.tunnelProtocol` reports `quic`, `http2`, or unknown. Private server performance logs and room-host exports include numeric `tunnelTransport` (0 unknown, 1 QUIC, 2 HTTP/2). A configured preference is never reported as proof of successful negotiation. Public benchmark reports now include server clock/room metrics as well as client timing.

A temporary isolated tunnel on Dan's Mac successfully negotiated QUIC using the same pinned cloudflared binary. It exposed only a test backend with cartridge/testing access disabled and did not publish a host registry or change primary ownership. The final public verification must distinguish this transport check from measurements on Ryker's actual network.

The v3.6.2 gameplay/renderer/startup fixes below remain unchanged. The v3.6.2 public performance failure is retained as evidence, not relabeled as a pass.

---

# Second latency audit — v3.6.2

Audited 2026-10-23, starting at v3.6.1 (`8aa794e`). Dan's priority is responsive gameplay above optional features. The first audit fixed the runaway delay feedback loop, but did not remove the renderer bottleneck or the deliberate input/render queues. This audit reproduces and addresses those remaining causes. Voice was off in the comparative combat measurements.

## Findings and fixes

1. **Graphics uploads exhausted the browser's frame budget.** Engine configuration left slot 46 at zero, disabling the existing Glide renderer's vertex buffer objects. The Emscripten client-array compatibility path then uploads individual vertex attributes for draws. A combat CPU profile spent roughly 1.36 seconds in `bufferSubData`, 0.95 seconds in `vertexAttribPointer`, and 0.38 seconds in `bindBuffer` during a ten-second run. The rendering call tree dominated emulator work. Under heavier combat, the browser accumulated already-agreed frames; newer controls waited behind that backlog even with healthy server timing.

   `Engine.load()` now enables the core's existing VBO option. The renderer uploads one interleaved buffer and reuses its attribute setup. No emulator JS/WASM or cartridge bytes changed. This lowers steady rendering work and, especially, expensive frame spikes. It also benefits offline play. Earlier failures attributed only to running multiple emulators on one Mac must be read with this newly identified software cost in mind.

2. **Every new control was queued several frames into the future.** v3.6.1's bounded input lead prevented runaway buffering, but the minimum four frames still added about 67 ms before networking, rendering and game response. Raising the lead for higher RTT added more delay.

   New clients publish current state on change, with a 50 ms heartbeat. The server advertises `inputMode: "latest"` and samples each controller at its next fixed 60 Hz tick. There is no deliberate future-frame input window or latency setting to tune. A delayed connection affects its own controller without moving anybody else's deadline. Brief jitter retains held state; more than 150 ms of silence releases that controller to neutral. Press/release arriving between two ticks retains a one-frame press, so short taps cannot disappear. Sequence checks reject duplicates/old states; disconnect and authenticated replacement clear the slot immediately. Existing epoch, roster, role and input validation still apply. Already-agreed frames never change. Cached clients using the previous frame-numbered input protocol continue to work until refreshed.

3. **The renderer left two received frames waiting.** The app's catch-up loop stopped while it still had up to two complete server frames available. At a steady 60 Hz this maintained about 33 ms of avoidable display-side backlog. It now drains received frames within the existing bounded callback budget (up to six steps, 12 ms normally / 20 ms when behind). It never waits for missing controllers or predicts a different state locally.

4. **Input timing now measures the whole acknowledged application path.** The clock includes the accepted sequence per controller in the agreed frame. Each client measures from publishing that sample until finishing the corresponding emulator step. Reports/logs add `inputAckSamples`, `inputAckAvgMs` and `inputAckP95Ms`. Samples/maps remain bounded and the server's numeric privacy allowlist remains enforced. No actual controller states, audio, ROM/state bytes, identities or tickets are logged. The panel correctly displays a zero intentional input buffer instead of falling back to the old setting.

5. **Concurrent cartridge startup could advance a local menu inside a live room.** A broader join/pause test initially triggered an automatic state repair. Per-frame tracing found 556 local menu steps on a guest while multiplayer was already running; its game inputs otherwise matched the host. Automatic testing download and manual file selection could both pass the early `engine.loaded` check, then both finish. The second completion reopened the local main menu after the first had consumed the Join action. A shared `loading` boolean also let callers proceed before engine initialization finished.

   Cartridge acceptance, host download and engine initialization now each have a shared completion promise. Duplicate completions join the existing operation, and a late automatic download recognizes an already loaded cartridge. Local menu preparation stops if multiplayer has started. The same broad two-player scenario then passed without unexpected repairs, including deliberate desync recovery later in the test. This is a reproduced startup bug; it does not establish the cause of Dan's separate white-screen screenshot. `load-race-check.mjs` explicitly overlaps automatic/manual loading and checks for stray local steps in a room. State-mismatch diagnostic events now record only numeric frame, slot and backlog.

## Comparable local measurements

Two isolated Chrome contexts on Dan's Intel Mac, the real pinned emulator and original US cartridge, private localhost room, same native fighters/stage and repeated attack/release input, voice off. Fresh browser runs compare successive changes. These are short diagnostic comparisons, not physical controller-to-photon or separate-house measurements. Timing here ends at entry to the emulator step.

| Configuration | Combat FPS per client | Mean emulator step | Queued frames at end | Median injected-button → emulator |
| --- | --- | --- | --- | --- |
| v3.6.1 renderer and timing | 56.5–56.8 | ~11.4 ms (p95 ~25 ms) | 84–87 | 167–197 ms; p95 ~1.45–1.50 seconds |
| VBO renderer only | ~60 | 7.3–7.7 ms | 2 | ~124 ms |
| VBO + latest input | ~60 | ~7.2 ms | 3 | ~55 ms |
| VBO + latest input + drain received frames | ~60 | ~7.2 ms | 1 | 22.5–24.6 ms; p95 34.6–43.5 ms |

Ignored diagnostic artifacts: `renderer-baseline.json`, `renderer-vbo.json`, `renderer-latest.json`, `renderer-drained.json`, and `combat-baseline.cpuprofile`. The initial profiler run was more expensive and reached larger backlogs; do not use its numbers interchangeably with the unprofiled comparison.

**Sustained check:** the new `scripts/performance-check.mjs` runs sixty seconds of real two-player combat and 120 button transitions per client. Both clients held 60 FPS, with no lost transitions, 64–65 matching state checks and zero repairs. Average emulator steps were 7.9–8.0 ms; backlog p95 was zero, maximum one/two frames. This check times through **completion** of the emulator step: median 32.5–32.6 ms, p95 43.3–43.6 ms, maximum 49.7–54.3 ms. The extra step cost explains the difference from the entry-timed diagnostic table. Screenshot visually checked; fighters, scenery and HUD render correctly.

**Four-fighter rendering check:** one real browser plus three synthetic network controllers also held 60 FPS for sixty seconds with all four fighters active. Step time averaged 10.2 ms (p95 11.6 ms); backlog p95 zero, maximum two frames. `scripts/four-fighter-check.mjs` checks native four-player battle state and timing, not independent emulator agreement for the synthetic controllers. Running four complete emulators on this one Mac still overloaded shared hardware and failed; that stress-test limit is recorded in QA.md.

Run on an isolated host with testing auto-load enabled:

```sh
SMASH_URL=http://127.0.0.1:8790 CHROME_PATH='/path/to/chrome' node scripts/performance-check.mjs
```

It creates its own private room, excludes real gamepads, closes its disposable browser contexts, and writes only ignored local artifacts. `SMASH_BENCHMARK_SECONDS` adjusts duration. The default local p95 input threshold is 100 ms; `SMASH_BENCHMARK_MAX_LATENCY` can explicitly set a different threshold for a remote test. Test environments must not join a person's room or use production controllers.

A separate ten-second read of Ryker's public relay (v3.6.1 backend, before rollout) received 600 frames at 60.04 FPS. Server clock maximum lateness was 16 ms with zero hiccups. Delivery gap median was 14.9 ms, p95 32.5 ms and maximum 188.8 ms. The isolated spike shows why network delivery still matters; this short probe does not establish how often it happens during normal play. Its temporary private room was explicitly closed.

## Remaining boundaries and audit notes

- Voice and live spectator transfers stay on `/media`, separate from `/room`; the prior queue isolation and coalescing remain. They were not responsible for the reproduced voice-off graphics/input backlog. Keep optional voice available, with bounded disposable audio queues.
- The pinned native core still hashes 8 MB of memory each step. Read-only inspection uses its full serializer: measured ~3.2 ms per inspection and ~14 ms for a copied full snapshot. Battle inspection is already limited to twice per second, and live snapshot transfers are serialized. Rebuilding the emulator solely to remove those costs was unnecessary to achieve the measured 60 FPS result; the binary provenance remains intact.
- The latest-input design is still authoritative server sequencing, without rollback/local prediction. Physical input sampling, network transit, server tick alignment, native game response and display scanout still take time. Zero intentional buffer does not mean zero physical latency. Simulated RTTs of 20/40/100/200 ms verify that application acknowledgements stay within RTT plus two browser ticks and that an interrupted player cannot stop another controller.
- A genuinely underpowered browser or a congested network can still fall behind. `inputAckP95Ms` plus backlog/step time/RTT distinguishes the source. Same-Mac tests cannot certify four independent devices, physical controllers, mobile microphones or two-house play. Refresh every tab after rollout.
- Dan's earlier white rules-screen screenshot was not reproduced exactly; forced WebGL loss produced a different black canvas. Reduced graphics overhead is not proof that this separate screenshot trigger is fixed.

See [QA.md](QA.md) for the final regression and deployment results. The previous audit below is historical; its four-frame minimum describes the compatibility path, not the updated client.

---

# Smash Portal latency audit — v3.6.1

Audited 2026-10-22 (America/Denver), source v3.6.0 at `93e1db7`. Dan reported severe lag after the latest changes, including with voice disabled. His requirement is preserved: one slow connection must not stop the other players.

## Findings and changes

### 1. A short interruption caused a long input-delay penalty — reproduced

`7f7a81c` replaced peer-to-peer input lockstep with a 60 Hz server deadline. This prevents one missing controller from stopping everybody. However, the client added one input-buffer frame **for every late frame**, including historical frames delivered after an interruption and frames the browser had never submitted. It removed only one buffer frame per 120 on-time frames.

The result was a positive feedback loop. Raising the target by a large amount also left holes because the sender filled at most six frames. Those holes were then counted as more evidence of a slow connection. A single delayed ping could independently raise the target, because the latest RTT directly controlled it.

A deterministic replay with 40 ms RTT and a 250 ms interruption raised the old buffer from 5 to 21 frames (350 ms). It remained at 12 frames 19 seconds later. At 100 ms RTT, a two-second interruption reached the 45-frame limit (750 ms), and remained at 37 frames 17 seconds after recovery. These are scheduled input-buffer times, not complete controller-to-display measurements.

An isolated two-browser, real-emulator reproduction with voice off reached **45 frames after a 500 ms guest interruption**, despite about 20 ms relay RTT. The patched reproduction retained **4 frames (about 67 ms)**. Reports are local, ignored artifacts: `audit-timing-before.json`, `audit-browser-before.json`, `audit-browser-after.json`.

**Fix:** `InputTiming` uses a rolling median RTT, distinguishes submitted packets from unsent/old misses, limits jitter adjustments to once per 500 ms and at most four extra frames, and removes extra margin after healthy delivery. Long local interruptions reset that margin. Sending fills the available future window instead of leaving holes. The server's immutable deadlines, missing-player neutral inputs and shared frame sequence remain intact.

### 2. Catch-up could retain extra delay or overload the affected browser

The client applied its own frame clock on top of the server clock. Fast-forwarding advanced that local clock into the future, leaving fresh frames queued unnecessarily. The render loop also had little spare budget for catching up.

**Fix:** server frame availability paces online play. Catch-up gets a bounded 20 ms callback budget, versus 12 ms normally, and at most six simulation steps per callback. A guest more than 90 frames behind requests its own authoritative snapshot through the existing targeted recovery path. It does not pause or resynchronize the group. Requests are deduplicated and rate-limited; snapshots that arrive after the browser already caught up are discarded. The room host cannot recover from itself; an overloaded host browser still needs adequate local emulation capacity.

### 3. Live spectator snapshots shared the controller upload — code-confirmed contention

`d9767f3` added live spectators and voice. A joining or mismatching spectator could make the room host serialize/compress a full game state and upload one large binary message on the same ordered WebSocket as controller inputs. Multiple requests could also start overlapping compression jobs. Voice used this same connection. Disabling voice does not remove the snapshot or timing issues.

**Fix:** a separately authenticated `/media` WebSocket carries voice and live targeted snapshots. Controller frames retain `/room`. Transfers are serialized, duplicate requests coalesced, and voice drops stale audio instead of building a send queue. Closing the media connection does not remove a controller. Authority and mute checks remain on the server. Group synchronization intentionally pauses the room and retains the original ordered game connection. Old cached clients remain compatible but need a refresh to gain the isolation.

Separate connections remove application-level queuing behind a large snapshot; they still share the physical uplink and Cloudflare tunnel. They cannot create bandwidth or eliminate loss on those shared links. [WebSocket send queues](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/bufferedAmount).

### 4. Insufficient observability — fixed

The old panel showed FPS, one RTT and buffer size, but had no history or server timing record. New bounded reports distinguish scheduled input delay, network frame gaps, local emulation time, rendering backlog, missing deadlines, media congestion and server scheduling.

- Browser: five-second samples, last 120 samples (about ten minutes), last 100 diagnostic events. **Menu → Connection → Download performance report** exports JSON. Host exports include the latest anonymized room reports.
- Server: one structured entry every 30 seconds while rooms exist, in `.local/performance.jsonl`; rotation keeps the current file and one predecessor at roughly 5 MB each. These are private host files, never public assets.
- Metrics: FPS, typical/current RTT, input-buffer frames, pending simulation frames, frame-delivery gaps, emulator step time, own missed deadlines, repairs, game/media queued bytes, voice packet/drop counters, main-thread long tasks, server event-loop utilization/delay, memory and per-slot missing deadlines.
- Only numeric allowlisted client fields are stored. No microphones, audio packets, ROMs, snapshots, controller contents, addresses, invitation tickets, player names or room names are logged. Client reports are measurements supplied by that client, not trusted server facts.
- `/api/status` exposes only aggregate server health. Room reports require the room host. The server's event-loop histogram uses a 20 ms sampling interval; values near 20 ms are expected, not proof of a 20 ms game delay. [Node performance measurements](https://nodejs.org/api/perf_hooks.html#perf_hooksmonitoreventloopdelayoptions).

## Room membership and controller setup

The room directory counted all retained member records, including disconnected reconnect reservations. Those reservations had no expiry. Joining through the public directory also omitted the saved reconnect ticket, so refreshing and joining could create a second identity. These are separate from the latency feedback loop.

The directory and player/voice panels now count/display connected people. Explicit leave removes the member and hands off authority immediately. Unexpected disconnection reserves the identity for 30 seconds, then removes it without stopping the battle clock. Reservations cannot block admission to an otherwise available room. Five-second WebSocket heartbeats detect silent connection loss within approximately ten seconds; an orderly page exit closes the connection promptly. No server can instantly distinguish a silent lost network from a delayed packet.

Same-tab public-directory joins reuse the saved ticket. A valid ticket can replace an old connection whose close has not arrived yet; stale sockets cannot keep sending as that member. Rejoining does not take the host role back from the successor. Host succession prefers connected fighters, then the oldest connected spectator. Refresh retains the short reconnect window; explicit Leave clears membership completely. The browser stores tickets per tab, not by display name.

Controller setup advances to the next action after every successful mapping, whether started from Guided setup or an individual row. Gamepads must return to neutral before the next capture; held keyboard repeats are ignored. Escape stops the sequence and each completed mapping saves immediately.

## Infrastructure observations

The deployed `active-host.json` selected Ryker's Windows PC and both app/backend were v3.6.0. Legacy `server.json` pointed at Dan's Mac but the current frontend ignores it. No host ownership change was required. Twenty read-only WebSocket pings from Dan's machine to Ryker's public relay measured 26 ms minimum, 40 ms median and 55 ms maximum/p95. This short sample does not establish conditions during the reported games.

A 300 Mbps **download** speed does not measure input round-trip delay, jitter, upload congestion or the ability of each player's browser to emulate at 60 FPS. Static assets come from GitHub Pages; the server coordinates inputs, while every browser runs its own N64 emulator. This remains authoritative delayed input, without rollback or local prediction.

## Reading a performance report

| Measurement | Interpretation |
| --- | --- |
| High RTT with a correspondingly larger buffer | Network path needs more time; inspect the affected player's link and the relay route. |
| Low RTT, a large buffer after a short interruption | The reproduced v3.6.0 buffer regression; refresh to v3.6.1. |
| Increasing backlog, low FPS, expensive emulator steps | This browser cannot keep up. Several emulators on one machine compete for CPU/GPU. |
| Large frame-delivery gaps with cheap emulator steps | Network delivery or main-thread scheduling interruption; compare long-task counts and server clock lateness. |
| High server clock lateness/hiccups across clients | Backend scheduling or host load; inspect the host's process load and log. |
| Media queue or voice drops, healthy game queue | Media congestion is isolated; controller deadlines should continue. |
| Missed deadlines only for one slot | That player's input did not arrive in time; other slots continue. |

See QA.md for the checks actually completed. Same-machine browser tests and network simulations are not certification of every physical phone, controller, ISP or geographically separated match.
