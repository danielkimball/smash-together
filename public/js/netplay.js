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
    this.engine = engine;
    this.controls = controls;
    this.socket = null;
    this.player = 0;
    this.token = "";
    this.state = "offline";
    this.running = false;
    this.epoch = 0;
    this.frame = 0;
    this.delay = 6;
    this.inputs = new Map();
    this.hashes = new Map();
    this.remoteHashes = new Map();
    this.rtt = 0;
    this.matches = 0;
    this.repairs = 0;
    this.stalls = 0;
    this.next = 0;
    this.peerName = "";
    this.channel = null;
    this.pc = null;
    this.candidates = [];
    this.lastEcho = 0;
    this.syncing = false;
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
    this.message = message;
    this.status("error");
  }
  send(message) {
    if (this.socket?.readyState === 1)
      this.socket.send(JSON.stringify(message));
  }
  sendGame(payload, direct = true) {
    const data = { ...payload, epoch: this.epoch };
    if (direct && this.channel?.readyState === "open") {
      try {
        this.channel.send(JSON.stringify(data));
        return;
      } catch {}
    }
    this.send({ type: "game", payload: data });
  }
  async connect({ token = "", name = "Player", delay = 6 } = {}) {
    this.leave();
    this.message = "";
    this.delay = delay;
    this.status("connecting");
    const ws = new WebSocket(
      `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/room`,
    );
    this.socket = ws;
    ws.binaryType = "arraybuffer";
    ws.onopen = () =>
      this.send({
        type: token ? "join" : "create",
        token,
        name,
        delay,
        rom: this.engine.romHash,
        build: this.engine.build + "-smash-v1",
      });
    ws.onmessage = (event) => {
      if (ws !== this.socket) return;
      if (event.data instanceof ArrayBuffer) {
        this.receiveState(event.data).catch((e) => this.error(e.message));
        return;
      }
      let m;
      try {
        m = JSON.parse(event.data);
      } catch {
        return this.error("Invalid server response.");
      }
      if (m.type === "joined") {
        this.token = m.token;
        this.player = m.player;
        this.delay = m.delay;
        this.peerName = m.peer || "";
        this.status(this.player === 0 ? "waiting" : "syncing");
      } else if (m.type === "peer") {
        this.peerName = m.name;
        this.peerConnected = true;
        this.message = "";
        this.setupRTC().catch(() => {});
        if (this.player === 0)
          this.synchronize().catch((e) => this.error(e.message));
        this.emit();
      } else if (m.type === "signal")
        this.receiveSignal(m.signal).catch(() => {});
      else if (m.type === "game") this.receive(m.payload);
      else if (m.type === "left") {
        this.running = false;
        this.syncing = false;
        clearTimeout(this.syncTimeout);
        this.peerConnected = false;
        this.peerName = "";
        this.closeRTC();
        this.status("waiting");
        this.message = m.message;
        this.emit();
      } else if (m.type === "closed" || m.type === "error")
        this.error(m.message);
    };
    ws.onclose = () => {
      if (ws === this.socket && this.state !== "offline")
        this.error(
          this.message || "Connection lost. Rejoin the invitation to continue.",
        );
    };
    ws.onerror = () => {
      if (ws === this.socket)
        this.error(
          "Could not reach the room server. Keep the host laptop awake and check the invitation address.",
        );
    };
  }
  leave() {
    clearTimeout(this.syncTimeout);
    if (this.socket) {
      const s = this.socket;
      this.socket = null;
      s.close();
    }
    this.closeRTC();
    this.running = false;
    this.syncing = false;
    this.peerConnected = false;
    this.peerName = "";
    this.token = "";
    this.epoch = 0;
    this.frame = 0;
    this.matches = 0;
    this.repairs = 0;
    this.rtt = 0;
    this.sentInputs = new Map();
    this.inputs.clear();
    this.hashes.clear();
    this.remoteHashes.clear();
    this.status("offline");
  }
  closeRTC() {
    this.channel?.close();
    this.pc?.close();
    this.channel = null;
    this.pc = null;
    this.candidates = [];
  }
  async setupRTC() {
    if (this.pc || !window.RTCPeerConnection) return;
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
    });
    this.pc = pc;
    pc.onicecandidate = (e) => {
      if (e.candidate)
        this.send({ type: "signal", signal: { candidate: e.candidate } });
    };
    pc.onconnectionstatechange = () => this.emit();
    pc.ondatachannel = (e) => this.attachChannel(e.channel);
    if (this.player === 0) {
      this.attachChannel(pc.createDataChannel("inputs", { ordered: true }));
      await pc.setLocalDescription();
      this.send({
        type: "signal",
        signal: { description: pc.localDescription },
      });
    }
  }
  attachChannel(channel) {
    this.channel = channel;
    channel.onopen = () => this.emit();
    channel.onclose = () => this.emit();
    channel.onerror = () => {};
    channel.onmessage = (e) => {
      if (typeof e.data !== "string" || e.data.length > 16000) return;
      try {
        this.receive(JSON.parse(e.data));
      } catch {
        this.error("Invalid peer packet.");
      }
    };
  }
  async receiveSignal(signal) {
    await this.setupRTC();
    const pc = this.pc;
    if (!pc) return;
    if (signal.description) {
      const desc = signal.description;
      if (
        (this.player === 0 && desc.type !== "answer") ||
        (this.player === 1 && desc.type !== "offer")
      )
        return;
      await pc.setRemoteDescription(desc);
      for (const c of this.candidates) await pc.addIceCandidate(c);
      this.candidates = [];
      if (desc.type === "offer") {
        await pc.setLocalDescription();
        this.send({
          type: "signal",
          signal: { description: pc.localDescription },
        });
      }
    } else if (signal.candidate) {
      if (pc.remoteDescription) await pc.addIceCandidate(signal.candidate);
      else if (this.candidates.length < 50)
        this.candidates.push(signal.candidate);
    }
  }
  async synchronize() {
    if (this.player !== 0 || this.syncing || !this.peerConnected) return;
    this.syncing = true;
    this.running = false;
    this.epoch++;
    this.frame = 0;
    this.status("syncing");
    this.sendGame({ type: "sync" }, false);
    const socket = this.socket,
      epoch = this.epoch;
    const raw = this.engine.snapshot();
    // Restore the host too: the core resets transient interpreter state on load.
    // Both players must begin from the same restore boundary.
    this.engine.restore(raw);
    const hash = this.engine.hash();
    const packed = await compress(raw);
    if (this.socket !== socket || this.epoch !== epoch || !this.peerConnected)
      return;
    const meta = new TextEncoder().encode(
      JSON.stringify({
        epoch: this.epoch,
        hash,
        delay: this.delay,
        rawSize: raw.length,
      }),
    );
    const packet = new Uint8Array(4 + meta.length + packed.length);
    new DataView(packet.buffer).setUint32(0, meta.length);
    packet.set(meta, 4);
    packet.set(packed, 4 + meta.length);
    if (this.socket?.readyState !== 1)
      throw Error("The connection closed during synchronization.");
    this.socket.send(packet);
    this.expectedHash = hash;
    clearTimeout(this.syncTimeout);
    this.syncTimeout = setTimeout(() => {
      if (this.syncing) {
        this.syncing = false;
        this.error("Synchronization timed out. Ask your friend to rejoin.");
      }
    }, 45000);
  }
  async receiveState(buffer) {
    if (this.player !== 1) return;
    this.running = false;
    this.status("syncing");
    const socket = this.socket;
    if (buffer.byteLength < 4) throw Error("Invalid sync packet.");
    const size = new DataView(buffer).getUint32(0);
    if (size > 2048 || buffer.byteLength < 4 + size)
      throw Error("Invalid sync packet.");
    const meta = JSON.parse(
      new TextDecoder().decode(buffer.slice(4, 4 + size)),
    );
    if (
      !Number.isSafeInteger(meta.epoch) ||
      meta.epoch < this.epoch ||
      !Number.isInteger(meta.delay) ||
      meta.delay < 2 ||
      meta.delay > 15 ||
      meta.rawSize !== this.engine.module._netplay_get_state_size()
    )
      throw Error("Incompatible sync state.");
    this.epoch = meta.epoch;
    this.delay = meta.delay;
    const bytes = await decompress(
      new Uint8Array(buffer, 4 + size),
      meta.rawSize,
    );
    if (this.socket !== socket || this.epoch !== meta.epoch) return;
    this.engine.restore(bytes);
    if (this.engine.hash() !== meta.hash)
      throw Error(
        "Game state did not restore correctly. Reload the game and rejoin.",
      );
    this.sendGame({ type: "ready", hash: meta.hash }, false);
  }
  start() {
    this.frame = 0;
    this.inputs.clear();
    this.hashes.clear();
    this.remoteHashes.clear();
    this.sentInputs = new Map();
    this.lastRepeat = 0;
    for (let f = 0; f < this.delay; f++)
      this.inputs.set(f, [neutral(), neutral()]);
    this.running = true;
    this.next = performance.now() + 150;
    this.syncing = false;
    this.engine.flushAudio();
    this.status("playing");
  }
  receive(m) {
    if (!m || !Number.isSafeInteger(m.epoch)) return;
    if (m.type === "sync" && this.player === 1 && m.epoch >= this.epoch) {
      this.epoch = m.epoch;
      this.running = false;
      this.status("syncing");
      return;
    }
    if (m.epoch !== this.epoch) return;
    if (m.type === "ready" && this.player === 0 && this.syncing) {
      if (m.hash !== this.expectedHash)
        return this.error("The two games could not synchronize.");
      clearTimeout(this.syncTimeout);
      this.sendGame({ type: "start" }, false);
      this.start();
    } else if (m.type === "start" && this.player === 1) {
      this.start();
    } else if (m.type === "input") {
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
      const pair = this.inputs.get(m.frame) || [null, null];
      const old = pair[1 - this.player];
      if (old && JSON.stringify(old) !== JSON.stringify(i))
        return this.error("Conflicting controller data received.");
      pair[1 - this.player] = i;
      this.inputs.set(m.frame, pair);
    } else if (
      m.type === "hash" &&
      Number.isSafeInteger(m.frame) &&
      m.frame >= this.frame - 600 &&
      m.frame <= this.frame + 600 &&
      /^[a-f0-9]{16}$/.test(m.hash)
    ) {
      this.remoteHashes.set(m.frame, m.hash);
      this.compare(m.frame);
    } else if (m.type === "pause") {
      this.running = false;
      this.status("paused");
    } else if (m.type === "resync" && this.player === 0)
      this.synchronize().catch((e) => this.error(e.message));
    else if (m.type === "echo")
      this.sendGame({ type: "echo-reply", sent: m.sent });
    else if (m.type === "echo-reply") {
      this.rtt = Math.round(performance.now() - m.sent);
      this.emit();
    }
  }
  compare(frame) {
    const a = this.hashes.get(frame),
      b = this.remoteHashes.get(frame);
    if (!a || !b) return;
    if (a !== b && this.player === 0) {
      this.repairs++;
      this.synchronize().catch((e) => this.error(e.message));
    } else if (a === b) {
      this.matches++;
    }
    this.hashes.delete(frame);
    this.remoteHashes.delete(frame);
  }
  tick(time) {
    if (this.peerConnected && time - this.lastEcho > 2000) {
      this.lastEcho = time;
      this.sendGame({ type: "echo", sent: time });
    }
    if (!this.running || time + 1 < this.next) return false;
    // Reliable transports can change mid-match. Replay a short input history so
    // a channel closing (or a start message crossing transports) cannot deadlock.
    if (time - this.lastRepeat > 250) {
      this.lastRepeat = time;
      for (const [frame, input] of this.sentInputs)
        this.sendGame({ type: "input", frame, input });
    }
    const target = this.frame + this.delay,
      pair = this.inputs.get(target) || [null, null];
    if (!pair[this.player]) {
      pair[this.player] = this.controls.sample();
      this.inputs.set(target, pair);
      this.sentInputs.set(target, pair[this.player]);
      this.sendGame({ type: "input", frame: target, input: pair[this.player] });
      for (const f of this.sentInputs.keys())
        if (f < target - 2 * this.delay - 5) this.sentInputs.delete(f);
    }
    const current = this.inputs.get(this.frame);
    if (!current?.[0] || !current?.[1]) {
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
      this.sendGame({ type: "hash", frame: this.frame, hash });
      this.compare(this.frame);
      for (const f of this.hashes.keys())
        if (f < this.frame - 600) this.hashes.delete(f);
      for (const f of this.remoteHashes.keys())
        if (f < this.frame - 600) this.remoteHashes.delete(f);
    }
    return true;
  }
  pause() {
    this.running = false;
    this.sendGame({ type: "pause" }, false);
    this.status("paused");
  }
  resume() {
    if (this.player === 0)
      this.synchronize().catch((e) => this.error(e.message));
    else this.sendGame({ type: "resync" }, false);
  }
}
