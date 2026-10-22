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
      this.room?.members.length >= 2 &&
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
    const data = { ...payload, epoch: this.epoch, match: this.room?.match };
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
  connect(options = {}) {
    this.leave();
    this.message = "";
    this.lastOptions = options;
    this.status("connecting");
    const ws = new WebSocket(
      `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/room`,
    );
    this.socket = ws;
    ws.binaryType = "arraybuffer";
    ws.onopen = () =>
      this.send({
        ...options,
        type: options.token || options.roomId ? "join" : "create",
        ticket: options.token
          ? sessionStorage.getItem("smash.ticket." + options.token)
          : undefined,
        rom: this.engine.romHash,
        build: this.engine.build + "-smash-lobbies-v2",
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
    const oldMatch = this.room?.match;
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
    if (room.phase === "lobby") {
      this.running = false;
      this.syncing = false;
      this.preparing = false;
      clearTimeout(this.syncTimeout);
      this.message = "";
      this.state = "lobby";
      if (oldMatch !== room.match) this.epoch = 0;
    } else if (!this.allConnected) {
      this.running = false;
      this.syncing = false;
      clearTimeout(this.syncTimeout);
      this.message =
        "A controller disconnected. Waiting for that player to rejoin.";
      this.state = "waiting";
    } else if (this.state === "connecting") this.state = "syncing";
    this.emit();
  }
  leave() {
    clearTimeout(this.syncTimeout);
    const s = this.socket;
    this.socket = null;
    s?.close();
    this.closeRTC();
    Object.assign(this, {
      running: false,
      syncing: false,
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
    if (
      !this.isHost ||
      this.syncing ||
      this.preparing ||
      !this.allConnected ||
      this.room.phase === "lobby"
    )
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
      match = this.room.match;
    const raw = this.engine.snapshot();
    // Both sides restore so the core's transient interpreter state is identical.
    this.engine.restore(raw);
    this.expectedHash = this.engine.hash();
    const packed = await compress(raw);
    if (
      this.socket !== socket ||
      this.epoch !== epoch ||
      this.room?.match !== match ||
      !this.allConnected
    )
      return;
    const meta = new TextEncoder().encode(
      JSON.stringify({
        epoch,
        match,
        hash: this.expectedHash,
        delay: this.delay,
        rawSize: raw.length,
      }),
    );
    const packet = new Uint8Array(4 + meta.length + packed.length);
    new DataView(packet.buffer).setUint32(0, meta.length);
    packet.set(meta, 4);
    packet.set(packed, 4 + meta.length);
    if (socket.readyState !== 1)
      throw Error("The connection closed during synchronization.");
    socket.send(packet);
    clearTimeout(this.syncTimeout);
    this.syncTimeout = setTimeout(() => {
      if (this.syncing)
        this.error("Synchronization timed out. Return to the lobby or rejoin.");
    }, 45000);
  }
  async receiveState(buffer) {
    if (this.isHost || !this.room || this.room.phase === "lobby") return;
    const socket = this.socket;
    if (buffer.byteLength < 4) throw Error("Invalid sync packet.");
    const size = new DataView(buffer).getUint32(0);
    if (size > 2048 || buffer.byteLength < 4 + size)
      throw Error("Invalid sync packet.");
    const meta = JSON.parse(
      new TextDecoder().decode(buffer.slice(4, 4 + size)),
    );
    if (meta.match !== this.room.match) return;
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
      this.room?.match !== meta.match
    )
      return;
    this.engine.restore(bytes);
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
    this.lastRepeat = 0;
    for (let f = 0; f < this.delay; f++)
      this.inputs.set(f, Array.from({ length: 4 }, neutral));
    this.running = true;
    this.next = performance.now() + 200;
    this.syncing = false;
    this.message = "";
    this.engine.flushAudio();
    this.status("playing");
  }
  receive(from, m) {
    const member = this.room?.members.find((p) => p.id === from && p.connected);
    if (
      !member ||
      !m ||
      !Number.isSafeInteger(m.epoch) ||
      m.match !== this.room.match ||
      this.room.phase === "lobby"
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
    else if (m.type === "input") {
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
    }
    if (!this.running || time + 1 < this.next) return false;
    // Repeating recent inputs covers transport switches and start packets crossing transports.
    if (time - this.lastRepeat > 250) {
      this.lastRepeat = time;
      for (const [frame, input] of this.sentInputs)
        this.sendGame({ type: "input", frame, input });
    }
    const target = this.frame + this.delay,
      inputs = this.inputs.get(target) || this.emptyInputs();
    if (!inputs[this.player]) {
      inputs[this.player] = this.controls.sample();
      this.inputs.set(target, inputs);
      this.sentInputs.set(target, inputs[this.player]);
      this.sendGame({
        type: "input",
        frame: target,
        input: inputs[this.player],
      });
      for (const f of this.sentInputs.keys())
        if (f < target - 2 * this.delay - 5) this.sentInputs.delete(f);
    }
    const current = this.inputs.get(this.frame);
    if (!current?.every(Boolean)) {
      this.stalls++;
      this.next = time;
      return false;
    }
    this.engine.frame(current);
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
    if (!this.allConnected || this.room?.phase === "lobby") return;
    this.message = "";
    if (this.isHost) this.synchronize().catch((e) => this.error(e.message));
    else this.sendGame({ type: "resync" }, false, this.room.hostId);
  }
}
