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
