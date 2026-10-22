import { Rounds } from "./rounds.js";
import { socketURL } from "./service.js";
const neutral = () => ({ buttons: 0, x: 0, y: 0 });
const bytesOf = async (stream) =>
  new Uint8Array(await new Response(stream).arrayBuffer());
export async function compress(bytes) {
  return bytesOf(
    new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate")),
  );
}
export async function decompress(bytes, limit = 18 * 1024 * 1024) {
  const reader = new Blob([bytes])
    .stream()
    .pipeThrough(new DecompressionStream("deflate"))
    .getReader();
  const parts = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > limit) throw Error("Game state exceeds the size limit.");
      parts.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const out = new Uint8Array(length);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
export class Netplay extends EventTarget {
  constructor(engine, controls) {
    super();
    Object.assign(this, {
      engine,
      controls,
      socket: null,
      id: "",
      token: "",
      state: "offline",
      running: false,
      epoch: 0,
      frame: 0,
      delay: 6,
      player: 0,
      room: null,
      matches: 0,
      repairs: 0,
      stalls: 0,
      rtt: 0,
      next: 0,
      lastEcho: 0,
      syncing: false,
      message: "",
    });
    this.peers = new Map();
    this.inputs = new Map();
    this.hashes = new Map();
    this.remoteHashes = new Map();
    this.sentInputs = new Map();
    this.rounds = new Rounds();
  }
  get isHost() {
    return this.id && this.id === this.room?.hostId;
  }
  get me() {
    return this.room?.members.find((p) => p.id === this.id);
  }
  get connected() {
    return this.room?.members.filter((p) => p.connected) || [];
  }
  get allConnected() {
    return (
      this.room?.members.length >= 1 &&
      this.room.members.every((p) => p.connected)
    );
  }
  get directCount() {
    return [...this.peers.values()].filter(
      (p) => p.channel?.readyState === "open",
    ).length;
  }
  emit() {
    this.dispatchEvent(new Event("change"));
  }
  status(state) {
    this.state = state;
    this.emit();
  }
  error(message) {
    this.running = false;
    this.syncing = false;
    this.message = message;
    this.status("error");
  }
  send(message) {
    if (this.socket?.readyState === 1)
      this.socket.send(JSON.stringify(message));
  }
  sendGame(payload, direct = true, to) {
    const data = {
      ...payload,
      epoch: this.epoch,
      match: this.room?.match,
      revision: this.room?.revision,
    };
    if (direct) {
      for (const p of this.connected) {
        if (p.id === this.id || (to && to !== p.id)) continue;
        const ch = this.peers.get(p.id)?.channel;
        if (ch?.readyState === "open") {
          try {
            ch.send(JSON.stringify(data));
            continue;
          } catch {}
        }
        this.send({ type: "game", to: p.id, payload: data });
      }
    } else this.send({ type: "game", to, payload: data });
  }
  async connect(options = {}) {
    this.leave();
    const connection = this.connectionGeneration;
    this.message = "";
    this.lastOptions = options;
    this.status("connecting");
    let address;
    try {
      address = await socketURL();
    } catch (error) {
      if (connection === this.connectionGeneration) this.error(error.message);
      return;
    }
    if (connection !== this.connectionGeneration) return;
    const ws = new WebSocket(address);
    this.socket = ws;
    ws.binaryType = "arraybuffer";
    ws.onopen = () =>
      this.send({
        ...options,
        type: options.token || options.roomId ? "join" : "create",
        protocol: 5,
        ticket: options.token
          ? sessionStorage.getItem("smash.ticket." + options.token)
          : undefined,
        rom: this.engine.romHash,
        build: this.engine.build + "-smash-native-v5",
      });
    ws.onmessage = (e) => {
      if (ws !== this.socket) return;
      if (e.data instanceof ArrayBuffer) {
        this.receiveState(e.data).catch((e) => this.error(e.message));
        return;
      }
      let m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return this.error("Invalid server response.");
      }
      if (m.type === "joined") {
        this.id = m.id;
        this.token = m.token;
        sessionStorage.setItem("smash.ticket." + m.token, m.ticket);
        this.lastOptions = { ...options, token: m.token };
      } else if (m.type === "room") this.updateRoom(m.room);
      else if (m.type === "frame") this.receiveFrame(m);
      else if (m.type === "pong" && typeof m.id === "number")
        this.relayRTT = Math.round(performance.now() - m.id);
      else if (m.type === "launch") {
        this.running = false;
        this.status("preparing");
        if (this.isHost) {
          const match = this.room.match;
          this.preparing = true;
          Promise.resolve(this.prepare?.())
            .then(() => {
              if (this.socket !== ws || this.room?.match !== match) return;
              this.preparing = false;
              if (
                this.socket === ws &&
                this.room?.match === match &&
                this.allConnected
              )
                return this.synchronize();
            })
            .catch((e) => {
              if (this.socket === ws && this.room?.match === match) {
                this.preparing = false;
                this.error(e.message);
              }
            });
        }
      } else if (m.type === "reconnected") {
        this.message = "";
        if (this.isHost) this.synchronize().catch((e) => this.error(e.message));
      } else if (m.type === "signal")
        this.receiveSignal(m.from, m.signal).catch(() => {});
      else if (m.type === "game") this.receive(m.from, m.payload);
      else if (m.type === "closed") this.error(m.message);
      else if (m.type === "error") {
        this.message = m.message;
        if (!this.room) this.status("error");
        else
          this.dispatchEvent(new CustomEvent("notice", { detail: m.message }));
      }
    };
    ws.onclose = () => {
      if (
        ws === this.socket &&
        this.state !== "offline" &&
        this.state !== "error"
      )
        this.error("Connection lost. Rejoin to reconnect your controller.");
    };
    ws.onerror = () => {
      if (ws === this.socket)
        this.error(
          "Could not reach the room server. Keep the host computer awake and try again.",
        );
    };
  }
  updateRoom(room) {
    const old = this.room,
      oldMatch = old?.match;
    this.room = room;
    this.player = this.me?.slot ?? 0;
    this.delay = room.delay;
    for (const [id, p] of this.peers) {
      if (!room.members.some((m) => m.id === id && m.connected)) {
        p.channel?.close();
        p.pc.close();
        this.peers.delete(id);
      }
    }
    for (const p of this.connected)
      if (p.id !== this.id) this.setupRTC(p.id).catch(() => {});
    const changed =
      old && (old.revision !== room.revision || oldMatch !== room.match);
    if (changed) {
      this.running = false;
      this.syncing = false;
      clearTimeout(this.syncTimeout);
      this.message = "";
      this.state = "syncing";
      this.epoch++;
    }
    if (
      !this.allConnected &&
      !(room.timing === "deadline" && !room.selecting && this.running)
    ) {
      this.running = false;
      this.syncing = false;
      clearTimeout(this.syncTimeout);
      this.message =
        "A controller disconnected. Waiting for that player to rejoin.";
      this.state = "waiting";
    } else if (oldMatch !== room.match) {
      this.state = "preparing";
    } else if (changed && this.isHost && !this.preparing) {
      const removed = old.members
        .filter((p) => !room.members.some((m) => m.slot === p.slot))
        .map((p) => p.slot);
      // Preserve every other fighter. A departed player's B tap returns only
      // their token to its hand before the new roster receives this state.
      if (removed.length) this.removePlayers?.(removed);
      this.synchronize().catch((e) => this.error(e.message));
    } else if (this.state === "connecting") this.state = "syncing";
    this.emit();
  }
  leave() {
    this.connectionGeneration = (this.connectionGeneration || 0) + 1;
    this.rounds.restore();
    clearTimeout(this.syncTimeout);
    const s = this.socket;
    this.socket = null;
    if (s?.readyState === 1) s.send(JSON.stringify({ type: "leave" }));
    s?.close();
    this.closeRTC();
    Object.assign(this, {
      running: false,
      syncing: false,
      preparing: false,
      token: "",
      id: "",
      room: null,
      epoch: 0,
      frame: 0,
      matches: 0,
      repairs: 0,
      rtt: 0,
      message: "",
    });
    this.inputs.clear();
    this.hashes.clear();
    this.remoteHashes.clear();
    this.sentInputs.clear();
    this.status("offline");
  }
  closeRTC() {
    for (const p of this.peers.values()) {
      p.channel?.close();
      p.pc.close();
    }
    this.peers.clear();
  }
  async setupRTC(id) {
    if (this.peers.has(id) || !window.RTCPeerConnection) return;
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
    });
    const peer = { pc, channel: null, candidates: [] };
    this.peers.set(id, peer);
    pc.onicecandidate = (e) => {
      if (e.candidate)
        this.send({
          type: "signal",
          to: id,
          signal: { candidate: e.candidate },
        });
    };
    pc.onconnectionstatechange = () => this.emit();
    pc.ondatachannel = (e) => this.attachChannel(id, e.channel);
    if (this.id < id) {
      this.attachChannel(id, pc.createDataChannel("inputs", { ordered: true }));
      await pc.setLocalDescription();
      this.send({
        type: "signal",
        to: id,
        signal: { description: pc.localDescription },
      });
    }
  }
  attachChannel(id, channel) {
    const p = this.peers.get(id);
    if (!p) return channel.close();
    p.channel = channel;
    channel.onopen = () => this.emit();
    channel.onclose = () => this.emit();
    channel.onerror = () => {};
    channel.onmessage = (e) => {
      if (typeof e.data !== "string" || e.data.length > 16000) return;
      try {
        const m = JSON.parse(e.data);
        // Lifecycle packets always use the server's ordered, authorized route.
        if (["input", "hash", "echo", "echo-reply"].includes(m.type))
          this.receive(id, m);
      } catch {
        this.error("Invalid peer packet.");
      }
    };
  }
  async receiveSignal(id, signal) {
    if (!this.connected.some((p) => p.id === id)) return;
    await this.setupRTC(id);
    const p = this.peers.get(id);
    if (!p) return;
    if (signal.description) {
      const desc = signal.description;
      if (desc.type !== (this.id < id ? "answer" : "offer")) return;
      await p.pc.setRemoteDescription(desc);
      for (const c of p.candidates) await p.pc.addIceCandidate(c);
      p.candidates = [];
      if (desc.type === "offer") {
        await p.pc.setLocalDescription();
        this.send({
          type: "signal",
          to: id,
          signal: { description: p.pc.localDescription },
        });
      }
    } else if (signal.candidate) {
      if (p.pc.remoteDescription) await p.pc.addIceCandidate(signal.candidate);
      else if (p.candidates.length < 50) p.candidates.push(signal.candidate);
    }
  }
  async synchronize() {
    if (!this.isHost || this.syncing || this.preparing || !this.allConnected)
      return;
    this.syncing = true;
    this.running = false;
    this.epoch++;
    this.frame = 0;
    this.readyPeers = new Set();
    this.status("syncing");
    this.sendGame({ type: "sync" }, false);
    const socket = this.socket,
      epoch = this.epoch,
      match = this.room.match,
      revision = this.room.revision;
    const raw = this.engine.snapshot();
    // Both sides restore so the core's transient interpreter state is identical.
    this.engine.restore(raw);
    this.expectedHash = this.engine.hash();
    const packed = await compress(raw);
    if (
      this.socket !== socket ||
      this.epoch !== epoch ||
      this.room?.match !== match ||
      this.room?.revision !== revision ||
      !this.allConnected
    )
      return;
    const meta = new TextEncoder().encode(
      JSON.stringify({
        epoch,
        match,
        revision,
        hash: this.expectedHash,
        delay: this.delay,
        rawSize: raw.length,
        rounds: this.rounds.snapshot(),
      }),
    );
    const packet = new Uint8Array(4 + meta.length + packed.length);
    new DataView(packet.buffer).setUint32(0, meta.length);
    packet.set(meta, 4);
    packet.set(packed, 4 + meta.length);
    if (socket.readyState !== 1)
      throw Error("The connection closed during synchronization.");
    socket.send(packet);
    if (this.connected.length === 1) {
      this.sendGame({ type: "start" }, false);
      this.start();
      return;
    }
    clearTimeout(this.syncTimeout);
    this.syncTimeout = setTimeout(() => {
      if (this.syncing)
        this.error("Synchronization timed out. Return to the lobby or rejoin.");
    }, 45000);
  }
  async receiveState(buffer) {
    if (this.isHost || !this.room) return;
    const socket = this.socket;
    if (buffer.byteLength < 4) throw Error("Invalid sync packet.");
    const size = new DataView(buffer).getUint32(0);
    if (size > 2048 || buffer.byteLength < 4 + size)
      throw Error("Invalid sync packet.");
    const meta = JSON.parse(
      new TextDecoder().decode(buffer.slice(4, 4 + size)),
    );
    if (meta.match !== this.room.match || meta.revision !== this.room.revision)
      return;
    if (
      !Number.isSafeInteger(meta.epoch) ||
      meta.epoch < this.epoch ||
      !Number.isInteger(meta.delay) ||
      meta.delay < 2 ||
      meta.delay > 15 ||
      meta.rawSize !== this.engine.module._netplay_get_state_size()
    )
      throw Error("Incompatible sync state.");
    this.running = false;
    this.status("syncing");
    this.epoch = meta.epoch;
    this.delay = meta.delay;
    const bytes = await decompress(
      new Uint8Array(buffer, 4 + size),
      meta.rawSize,
    );
    if (
      this.socket !== socket ||
      this.epoch !== meta.epoch ||
      this.room?.match !== meta.match ||
      this.room?.revision !== meta.revision
    )
      return;
    this.engine.restore(bytes);
    this.rounds.restore(meta.rounds);
    if (this.engine.hash() !== meta.hash)
      throw Error("Game state did not restore correctly. Reload and rejoin.");
    this.sendGame({ type: "ready", hash: meta.hash }, false, this.room.hostId);
  }
  start() {
    this.frame = 0;
    this.inputs.clear();
    this.hashes.clear();
    this.remoteHashes.clear();
    this.sentInputs.clear();
    this.serverFrame = -1;
    this.lastSample = this.delay - 1;
    this.lateInputs = 0;
    this.lastLate = [];
    this.jitterLead = this.delay;
    this.onTimeFrames = 0;
    this.lastRepeat = 0;
    this.running = true;
    this.next = performance.now() + 200;
    this.syncing = false;
    this.message = "";
    this.engine.flushAudio();
    this.status("playing");
    // Measure after native preparation, which can block the browser and would
    // otherwise be mistaken for network latency.
    this.send({ type: "ping", id: performance.now() });
  }
  receiveFrame(m) {
    if (
      !this.running ||
      m.epoch !== this.epoch ||
      m.match !== this.room?.match ||
      m.revision !== this.room?.revision ||
      !Number.isSafeInteger(m.frame) ||
      m.frame < this.frame ||
      !Array.isArray(m.inputs) ||
      m.inputs.length !== 4
    )
      return;
    if (m.frame > this.frame + 600) {
      this.error("Your connection fell too far behind. Reconnect to catch up.");
      return;
    }
    this.inputs.set(m.frame, m.inputs);
    this.serverFrame = Math.max(this.serverFrame, m.frame);
    this.lastLate = m.late || [];
    this.lateInputs += this.lastLate.length;
    // Adapt only the affected controller to jitter (including slow local
    // rendering). Healthy players keep their own smaller input buffer.
    if (this.lastLate.includes(this.player)) {
      this.jitterLead = Math.min(45, (this.jitterLead || this.delay) + 1);
      this.onTimeFrames = 0;
    } else if (++this.onTimeFrames >= 120) {
      this.jitterLead = Math.max(this.delay, this.jitterLead - 1);
      this.onTimeFrames = 0;
    }
  }
  receive(from, m) {
    const member = this.room?.members.find((p) => p.id === from && p.connected);
    if (
      !member ||
      !m ||
      !Number.isSafeInteger(m.epoch) ||
      m.match !== this.room.match ||
      m.revision !== this.room.revision
    )
      return;
    const host = from === this.room.hostId;
    if (m.type === "sync" && host && !this.isHost && m.epoch >= this.epoch) {
      this.epoch = m.epoch;
      this.running = false;
      this.status("syncing");
      return;
    }
    if (m.epoch !== this.epoch) return;
    if (m.type === "ready" && this.isHost && this.syncing) {
      if (m.hash !== this.expectedHash)
        return this.error("The games could not synchronize.");
      this.readyPeers.add(from);
      if (
        this.allConnected &&
        this.connected.every(
          (p) => p.id === this.id || this.readyPeers.has(p.id),
        )
      ) {
        clearTimeout(this.syncTimeout);
        this.sendGame({ type: "start" }, false);
        this.start();
      }
    } else if (m.type === "start" && host && !this.isHost) this.start();
    else if (m.type === "input" && this.room.timing !== "deadline") {
      if (
        !Number.isSafeInteger(m.frame) ||
        m.frame < this.frame ||
        m.frame > this.frame + 600
      )
        return;
      const i = m.input;
      if (
        !i ||
        !Number.isInteger(i.buttons) ||
        i.buttons < 0 ||
        i.buttons > 16383 ||
        !Number.isInteger(i.x) ||
        !Number.isInteger(i.y) ||
        Math.abs(i.x) > 127 ||
        Math.abs(i.y) > 127
      )
        return;
      const inputs = this.inputs.get(m.frame) || this.emptyInputs();
      const old = inputs[member.slot];
      if (old && (old.buttons !== i.buttons || old.x !== i.x || old.y !== i.y))
        return this.error("Conflicting controller data received.");
      inputs[member.slot] = i;
      this.inputs.set(m.frame, inputs);
    } else if (
      m.type === "hash" &&
      (this.isHost || host) &&
      Number.isSafeInteger(m.frame) &&
      m.frame >= this.frame - 600 &&
      m.frame <= this.frame + 600 &&
      /^[a-f0-9]{16}$/.test(m.hash)
    ) {
      if (!this.remoteHashes.has(m.frame))
        this.remoteHashes.set(m.frame, new Map());
      this.remoteHashes.get(m.frame).set(from, m.hash);
      this.compare(m.frame);
    } else if (m.type === "pause") {
      this.running = false;
      this.status("paused");
    } else if (m.type === "resync" && this.isHost)
      this.synchronize().catch((e) => this.error(e.message));
    else if (m.type === "echo")
      this.sendGame({ type: "echo-reply", sent: m.sent }, true, from);
    else if (m.type === "echo-reply") {
      this.rtt = Math.round(performance.now() - m.sent);
      this.emit();
    }
  }
  emptyInputs() {
    const active = new Set(this.room.members.map((p) => p.slot));
    return Array.from({ length: 4 }, (_, i) =>
      active.has(i) ? null : neutral(),
    );
  }
  compare(frame) {
    const own = this.hashes.get(frame),
      remote = this.remoteHashes.get(frame);
    if (!own || !remote) return;
    for (const [id, hash] of remote) {
      if (hash === null) continue;
      if (own !== hash && this.isHost) {
        this.repairs++;
        this.synchronize().catch((e) => this.error(e.message));
        return;
      }
      if (own === hash) this.matches++;
      remote.set(id, null);
    }
  }
  tick(time) {
    if (this.running && time - this.lastEcho > 2000) {
      this.lastEcho = time;
      this.sendGame({ type: "echo", sent: time });
      this.send({ type: "ping", id: time });
    }
    if (!this.running) return false;
    // Sample against the server's clock, independently of local rendering.
    // A slowed browser can catch up without moving everyone else's deadline.
    this.personalDelay = Math.max(
      this.delay,
      this.jitterLead || 0,
      Math.min(45, Math.ceil((this.relayRTT || 0) / (1000 / 60)) + 2),
    );
    const target = Math.max(0, this.serverFrame + 1) + this.personalDelay;
    if (target > this.lastSample) {
      const input = this.filterInput
        ? this.filterInput(this.controls.sample())
        : this.controls.sample();
      for (let f = Math.max(this.lastSample + 1, target - 5); f <= target; f++)
        this.sendGame({ type: "input", frame: f, input }, false);
      this.lastSample = target;
    }
    if (time + 1 < this.next && this.serverFrame - this.frame < 3) return false;
    const current = this.inputs.get(this.frame);
    if (!current?.every(Boolean)) {
      this.stalls++;
      return false;
    }
    // Fixed simulation-frame cadence on every peer, never a wall-clock UI
    // poll. Stage select ignores its first ten native ticks, so six-frame
    // sampling installs the input gate before any stage input is accepted.
    // Battles/results need only two polls per second; this keeps snapshot
    // copying off most gameplay frames on phones. Reuse inspection for UI.
    const inspectEvery = [22, 24].includes(this.rounds.scene) ? 30 : 6;
    if (this.frame % inspectEvery === 0)
      this.rounds.observe(this.engine.inspect(), this.room);
    this.engine.frame(this.rounds.filter(current, this.room));
    this.inputs.delete(this.frame);
    this.frame++;
    this.next = Math.max(
      this.next + 1000 / this.engine.fps,
      time - 1000 / this.engine.fps,
    );
    if (this.frame % 60 === 0) {
      const hash = this.engine.hash();
      this.hashes.set(this.frame, hash);
      this.sendGame(
        { type: "hash", frame: this.frame, hash },
        true,
        this.isHost ? undefined : this.room.hostId,
      );
      this.compare(this.frame);
      for (const map of [this.hashes, this.remoteHashes])
        for (const f of map.keys()) if (f < this.frame - 600) map.delete(f);
    }
    return true;
  }
  pause() {
    if (!this.running) return;
    this.running = false;
    this.sendGame({ type: "pause" }, false);
    this.status("paused");
  }
  resume() {
    if (!this.allConnected) return;
    this.message = "";
    if (this.isHost) this.synchronize().catch((e) => this.error(e.message));
    else this.sendGame({ type: "resync" }, false, this.room.hostId);
  }
}
