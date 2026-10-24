import { Rounds } from "./rounds.js";
import { socketURL } from "./service.js";
import { InputTiming } from "./input-timing.js";
import { PROTOCOL, ROOM_BUILD } from "./protocol.js";
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
  constructor(engine, controls, { now = () => performance.now() } = {}) {
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
    this.frameCommands = new Map();
    this.hashes = new Map();
    this.remoteHashes = new Map();
    this.sentInputs = new Map();
    this.sentStates = new Map();
    this.frameSequences = new Map();
    this.inputSequence = 0;
    this.lastAppliedSequence = -1;
    this.inputLatencies = [];
    this.rounds = new Rounds();
    this.now = now;
    this.inputTiming = new InputTiming(now);
    this.performanceSamples = [];
    this.performanceEvents = [];
    this.observations = new Map();
    this.localStreams = new Map();
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
  get players() {
    return this.room?.members.filter((p) => p.slot >= 0) || [];
  }
  get devices() {
    return this.connected.filter((p) => !p.ownerId || p.ownerId === p.id);
  }
  get localMembers() {
    return this.connected.filter((p) => (p.ownerId || p.id) === this.id);
  }
  get localFighters() {
    return this.localMembers.filter((p) => p.slot >= 0);
  }
  get participants() {
    return this.devices.filter(
      (p) =>
        p.id === this.room.hostId ||
        this.players.some((m) => (m.ownerId || m.id) === p.id),
    );
  }
  get allConnected() {
    return (
      this.room &&
      (!this.room.selecting || this.players.every((p) => p.connected))
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
  connectMedia() {
    if (
      this.mediaSocket ||
      !this.room?.mediaTransport ||
      this.socket?.readyState !== 1 ||
      !this.ticket
    )
      return;
    const generation = this.connectionGeneration;
    const address = new URL(this.socket.url);
    address.pathname = "/media";
    const ws = new WebSocket(address);
    this.mediaSocket = ws;
    this.mediaReady = false;
    ws.binaryType = "arraybuffer";
    ws.onopen = () =>
      ws.send(
        JSON.stringify({
          type: "attach-media",
          token: this.token,
          id: this.id,
          ticket: this.ticket,
        }),
      );
    ws.onmessage = (event) => {
      if (ws !== this.mediaSocket || generation !== this.connectionGeneration)
        return;
      if (event.data instanceof ArrayBuffer) {
        this.receiveState(event.data).catch((e) => this.error(e.message));
        return;
      }
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.type === "media-ready") {
        this.mediaReady = true;
        this.recordPerformanceEvent("media-connected");
      } else if (message.type === "voice")
        this.dispatchEvent(new CustomEvent("voice", { detail: message }));
      else if (message.type === "frame") this.receiveFrame(message);
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      if (ws !== this.mediaSocket) return;
      this.mediaSocket = null;
      this.mediaReady = false;
      this.recordPerformanceEvent("media-disconnected");
      if (
        generation === this.connectionGeneration &&
        this.room &&
        this.socket?.readyState === 1
      )
        this.mediaRetry = setTimeout(() => this.connectMedia(), 2000);
    };
  }
  sendVoice(audio) {
    const socket = this.room?.mediaTransport
      ? this.mediaReady && this.mediaSocket
      : this.socket;
    if (socket?.readyState !== 1 || socket.bufferedAmount > 8192) {
      this.voiceDropped = (this.voiceDropped || 0) + 1;
      return;
    }
    socket.send(JSON.stringify({ type: "voice", audio }));
    this.voiceSent = (this.voiceSent || 0) + 1;
  }
  async sendState(packet, observation = false) {
    const generation = this.connectionGeneration;
    // Live state transfers may briefly wait for the separate channel.
    // The room/game socket stays available for controller deadlines throughout.
    for (
      let n = 0;
      observation && this.room?.mediaTransport && !this.mediaReady && n < 100;
      n++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (generation !== this.connectionGeneration) return;
    }
    // Group sync deliberately pauses the room; retain its ordered lifecycle
    // channel. Only live transfers need isolation from controller deadlines.
    const socket =
      observation && this.mediaReady ? this.mediaSocket : this.socket;
    if (observation && this.room?.mediaTransport && !this.mediaReady)
      throw Error(
        "Spectator transfer is reconnecting. Please rejoin in a moment.",
      );
    if (socket?.readyState !== 1)
      throw Error("The connection closed during synchronization.");
    for (let n = 0; socket.bufferedAmount > 65536 && n < 200; n++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (generation !== this.connectionGeneration) return;
      if (socket.readyState !== 1) throw Error("State transfer disconnected.");
    }
    if (socket.bufferedAmount > 65536)
      throw Error("State transfer is congested. Please rejoin in a moment.");
    socket.send(packet);
    this.recordPerformanceEvent("snapshot-sent", {
      bytes: packet.length,
      observation,
      transport: observation && this.mediaReady ? "media" : "game",
    });
  }
  sendGame(payload, direct = true, to) {
    const data = {
      ...payload,
      epoch: this.epoch,
      match: this.room?.match,
      revision: this.room?.revision,
    };
    if (direct) {
      for (const p of this.devices) {
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
    this.leave(!(options.token === this.token && this.state === "error"));
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
        protocol: PROTOCOL,
        ticket: options.token
          ? sessionStorage.getItem("smash.ticket." + options.token)
          : options.roomId
            ? sessionStorage.getItem("smash.room-ticket." + options.roomId)
            : undefined,
        rom: this.engine.romHash,
        build: this.engine.build + ROOM_BUILD,
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
        this.ticket = m.ticket;
        sessionStorage.setItem("smash.ticket." + m.token, m.ticket);
        this.lastOptions = { ...options, token: m.token };
      } else if (m.type === "room") this.updateRoom(m.room);
      else if (m.type === "snapshot-request")
        this.sendObservation(m.to).catch((e) =>
          this.dispatchEvent(new CustomEvent("notice", { detail: e.message })),
        );
      else if (m.type === "voice")
        this.dispatchEvent(new CustomEvent("voice", { detail: m }));
      else if (m.type === "frame") this.receiveFrame(m);
      else if (m.type === "performance-report") this.roomPerformance = m;
      else if (m.type === "pong" && typeof m.id === "number") {
        this.relayRTT = Math.round(this.now() - m.id);
        if (this.now() >= this.inputTiming.recoverUntil)
          this.inputTiming.recordRTT(this.relayRTT);
      } else if (m.type === "launch") {
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
      else if (m.type === "kicked") {
        sessionStorage.removeItem("smash.ticket." + this.token);
        sessionStorage.removeItem("smash.room-ticket." + this.room?.id);
        this.lastOptions = null;
        this.leave();
        this.dispatchEvent(new CustomEvent("kicked", { detail: m }));
      } else if (m.type === "local-removed") {
        this.dispatchEvent(new CustomEvent("local-removed", { detail: m }));
      } else if (m.type === "closed") this.error(m.message);
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
    if (this.ticket)
      sessionStorage.setItem("smash.room-ticket." + room.id, this.ticket);
    this.connectMedia();
    this.player = this.me?.slot ?? -1;
    this.delay = room.delay;
    for (const [id, p] of this.peers) {
      if (!room.members.some((m) => m.id === id && m.connected)) {
        p.channel?.close();
        p.pc.close();
        this.peers.delete(id);
      }
    }
    for (const p of this.devices)
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
        .filter(
          (p) =>
            p.slot >= 0 &&
            !room.members.some((m) => m.id === p.id && m.slot === p.slot),
        )
        .map((p) => p.slot);
      // Preserve every other fighter. A departed player's B tap returns only
      // their token to its hand before the new roster receives this state.
      if (removed.length) this.removePlayers?.(removed);
      this.applyTeams?.(room);
      this.synchronize().catch((e) => this.error(e.message));
    } else if (this.state === "connecting") this.state = "syncing";
    if (!old && room.phase !== "starting") {
      this.epoch = room.epoch;
      this.pendingFrames = new Map();
      this.state = "syncing";
    }
    if (old && old.hostId !== room.hostId) {
      this.dispatchEvent(
        new CustomEvent("notice", {
          detail: `${room.members.find((p) => p.id === room.hostId)?.name || "Next player"} is now hosting.`,
        }),
      );
      if (!this.isHost && !this.running && room.phase !== "starting")
        this.send({ type: "observe" });
      if (
        this.isHost &&
        !this.running &&
        !this.syncing &&
        !this.preparing &&
        !this.restoring &&
        this.allConnected
      ) {
        if (room.phase === "starting") {
          this.preparing = true;
          const generation = this.connectionGeneration;
          Promise.resolve(this.prepare?.())
            .then(() => {
              if (generation !== this.connectionGeneration) return;
              this.preparing = false;
              return this.synchronize();
            })
            .catch((e) => this.error(e.message));
        } else this.synchronize().catch((e) => this.error(e.message));
      }
    }
    this.emit();
  }
  leave(voluntary = true) {
    this.connectionGeneration = (this.connectionGeneration || 0) + 1;
    this.rounds.restore();
    this.pendingFrames = new Map();
    this.restoring = false;
    this.pendingStart = false;
    this.lastEcho = 0;
    this.restoredEpoch = null;
    clearTimeout(this.mediaRetry);
    const media = this.mediaSocket;
    this.mediaSocket = null;
    this.mediaReady = false;
    media?.close();
    this.relayRTT = 0;
    this.inputTiming.samples = [];
    this.inputTiming.reset();
    this.observations.clear();
    this.observationTail = null;
    this.observationRequested = false;
    this.lastObservationRequest = -Infinity;
    this.roomPerformance = null;
    this.serverFrame = -1;
    this.dispatchEvent(new Event("leave"));
    clearTimeout(this.syncTimeout);
    const s = this.socket;
    this.socket = null;
    if (voluntary && s?.readyState === 1)
      s.send(JSON.stringify({ type: "leave" }));
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
      reportedRound: -1,
      matches: 0,
      repairs: 0,
      rtt: 0,
      message: "",
    });
    this.inputs.clear();
    this.frameCommands.clear();
    this.hashes.clear();
    this.remoteHashes.clear();
    this.sentInputs.clear();
    this.sentStates.clear();
    this.localStreams.clear();
    this.frameSequences.clear();
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
    await this.sendState(packet);
    if (
      this.socket !== socket ||
      this.epoch !== epoch ||
      this.room?.revision !== revision
    )
      return;
    if (this.participants.length === 1) {
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
  async sendObservation(to) {
    if (
      !this.isHost ||
      !this.running ||
      !this.connected.some((p) => p.id === to)
    )
      return;
    // A mismatching spectator can request another repair every hash interval.
    // One compression/transfer at a time per spectator avoids a snapshot storm.
    if (this.observations.has(to)) return;
    const generation = this.connectionGeneration;
    const operation = Promise.resolve(this.observationTail)
      .catch(() => {})
      .then(() => {
        if (
          generation === this.connectionGeneration &&
          this.isHost &&
          this.running
        )
          return this.sendObservationState(to);
      });
    this.observationTail = operation;
    this.observations.set(to, operation);
    try {
      await operation;
    } finally {
      if (this.observations.get(to) === operation) this.observations.delete(to);
    }
  }
  async sendObservationState(to) {
    const generation = this.connectionGeneration,
      socket = this.socket;
    const raw = this.engine.snapshot();
    const header = {
      to,
      frame: this.frame,
      epoch: this.epoch,
      match: this.room.match,
      revision: this.room.revision,
      hash: this.engine.hash(),
      delay: this.delay,
      rawSize: raw.length,
      rounds: this.rounds.snapshot(),
    };
    const packed = await compress(raw);
    if (
      generation !== this.connectionGeneration ||
      this.epoch !== header.epoch ||
      this.room?.revision !== header.revision ||
      socket.readyState !== 1
    )
      return;
    const meta = new TextEncoder().encode(JSON.stringify(header));
    const packet = new Uint8Array(4 + meta.length + packed.length);
    new DataView(packet.buffer).setUint32(0, meta.length);
    packet.set(meta, 4);
    packet.set(packed, 4 + meta.length);
    await this.sendState(packet, true);
  }
  async receiveState(buffer) {
    if (!this.room) return;
    const socket = this.socket;
    if (buffer.byteLength < 4) throw Error("Invalid sync packet.");
    const size = new DataView(buffer).getUint32(0);
    if (size > 2048 || buffer.byteLength < 4 + size)
      throw Error("Invalid sync packet.");
    const meta = JSON.parse(
      new TextDecoder().decode(buffer.slice(4, 4 + size)),
    );
    if (
      meta.match !== this.room.match ||
      meta.revision !== this.room.revision ||
      (Number.isSafeInteger(meta.epoch) && meta.epoch < this.epoch)
    )
      return;
    if (meta.to && this.running && meta.frame < this.frame) {
      this.observationRequested = false;
      return; // Already caught up while this snapshot was travelling.
    }
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
    this.restoring = true;
    this.pendingFrames = this.pendingFrames || new Map();
    // Live frames can overtake the snapshot on the other connection. Preserve
    // them, then merge the ordered replay following the media snapshot.
    if (meta.to)
      for (const [frame, inputs] of this.inputs) {
        if (frame >= meta.frame)
          this.pendingFrames.set(frame, {
            frame,
            inputs,
            commands: this.frameCommands.get(frame),
            epoch: meta.epoch,
            match: meta.match,
            revision: meta.revision,
          });
      }
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
    this.observationRequested = false;
    this.restoredEpoch = meta.epoch;
    this.rounds.restore(meta.rounds);
    if (this.engine.hash() !== meta.hash)
      throw Error("Game state did not restore correctly. Reload and rejoin.");
    this.restoring = false;
    if (meta.to) this.start(meta.frame, this.pendingFrames);
    else {
      this.sendGame(
        { type: "ready", hash: meta.hash },
        false,
        this.room.hostId,
      );
      if (this.pendingStart) {
        this.pendingStart = false;
        this.start(0, this.pendingFrames);
      }
    }
  }
  start(frame = 0, buffered = new Map()) {
    this.frame = frame;
    this.inputs.clear();
    this.frameCommands.clear();
    this.hashes.clear();
    this.remoteHashes.clear();
    this.sentInputs.clear();
    this.sentStates.clear();
    this.localStreams.clear();
    this.frameSequences.clear();
    this.lastPublishedInput = null;
    this.lastControllerSampleTime = null;
    this.lastAppliedSequence = -1;
    this.serverFrame = frame - 1;
    this.lastSample = frame + this.delay - 1;
    this.lateInputs = 0;
    this.lastLate = [];
    this.jitterLead = this.delay;
    this.inputTiming.reset();
    this.lastInputTick = this.now();
    this.lastFrameAt = 0;
    this.ownLateInputs = 0;
    this.maxFrameGap = 0;
    this.stepCost = { count: 0, total: 0, max: 0 };
    this.onTimeFrames = 0;
    this.lastRepeat = 0;
    this.running = true;
    this.next = this.now() + 200;
    this.syncing = false;
    this.message = "";
    this.engine.flushAudio();
    this.status("playing");
    // Measure after native preparation, which can block the browser and would
    // otherwise be mistaken for network latency.
    this.send({ type: "ping", id: this.now() });
    this.pendingFrames = new Map();
    for (const m of buffered.values()) this.receiveFrame(m);
  }
  receiveFrame(m) {
    if (
      !this.running &&
      this.room &&
      m.epoch >= this.epoch &&
      m.match === this.room.match &&
      m.revision === this.room.revision
    ) {
      this.pendingFrames ||= new Map();
      this.pendingFrames.set(m.frame, m);
      if (this.pendingFrames.size > 900)
        this.pendingFrames.delete(this.pendingFrames.keys().next().value);
      return;
    }
    if (
      !this.running ||
      m.epoch !== this.epoch ||
      m.match !== this.room?.match ||
      m.revision !== this.room?.revision ||
      !Number.isSafeInteger(m.frame) ||
      m.frame < this.frame ||
      this.inputs.has(m.frame) ||
      !Array.isArray(m.inputs) ||
      m.inputs.length !== 4
    )
      return;
    const arrival = this.now();
    // Recover only this browser after a long interruption. Replaying seconds
    // of video/audio can cost more than restoring the existing host snapshot.
    // Fighters keep submitting inputs and everyone else's timeline continues.
    if (
      !this.observationRequested &&
      !this.isHost &&
      m.frame > this.frame + 90 &&
      arrival - (this.lastObservationRequest ?? -Infinity) >= 5000
    ) {
      this.lastObservationRequest = arrival;
      this.observationRequested = true;
      this.recordPerformanceEvent("catch-up-request", {
        backlog: m.frame - this.frame,
      });
      this.send({ type: "observe" });
    }
    if (
      m.frame > this.frame + 600 &&
      (!this.observationRequested ||
        arrival - this.lastObservationRequest > 10000)
    ) {
      this.error("Your connection fell too far behind. Reconnect to catch up.");
      return;
    }
    this.inputs.set(m.frame, m.inputs);
    if (Number.isSafeInteger(m.sequences?.[this.player]))
      this.frameSequences.set(m.frame, m.sequences[this.player]);
    if (m.commands?.length) this.frameCommands.set(m.frame, m.commands);
    this.serverFrame = Math.max(this.serverFrame, m.frame);
    if (this.lastFrameAt)
      this.maxFrameGap = Math.max(
        this.maxFrameGap || 0,
        arrival - this.lastFrameAt,
      );
    this.lastFrameAt = arrival;
    // Bound memory even if the media channel is slow while recovering.
    if (this.inputs.size > 900) {
      const oldest = this.inputs.keys().next().value;
      this.inputs.delete(oldest);
      this.frameCommands.delete(oldest);
      this.frameSequences.delete(oldest);
    }
    this.lastLate = m.late || [];
    this.lateInputs += this.lastLate.length;
    const ownLate = this.lastLate.includes(this.player);
    if (ownLate) this.ownLateInputs = (this.ownLateInputs || 0) + 1;
    if (this.room.inputMode !== "latest")
      this.inputTiming.feedback(ownLate, this.sentInputs.get(m.frame));
    this.sentInputs.delete(m.frame);
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
        this.participants.every(
          (p) => p.id === this.id || this.readyPeers.has(p.id),
        )
      ) {
        clearTimeout(this.syncTimeout);
        this.sendGame({ type: "start" }, false);
        this.start();
      }
    } else if (m.type === "start" && host && !this.isHost) {
      if (this.restoring || this.restoredEpoch !== m.epoch)
        this.pendingStart = true;
      else this.start(0, this.pendingFrames);
    } else if (m.type === "input" && this.room.timing !== "deadline") {
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
    } else if (m.type === "pause" && !this.room.selecting) {
      this.running = false;
      this.status("paused");
    } else if (m.type === "resync" && this.isHost) {
      if (this.room.selecting && this.running)
        this.sendObservation(from).catch((e) =>
          this.dispatchEvent(new CustomEvent("notice", { detail: e.message })),
        );
      else this.synchronize().catch((e) => this.error(e.message));
    } else if (m.type === "echo")
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
      if (
        own !== hash &&
        this.isHost &&
        (this.room.selecting ||
          !this.players.some((p) => (p.ownerId || p.id) === id))
      ) {
        this.sendObservation(id).catch(() => {});
        remote.set(id, null);
        continue;
      }
      if (own !== hash && this.isHost) {
        this.recordPerformanceEvent("state-mismatch", {
          frame,
          slot: this.room.members.find((p) => p.id === id)?.slot ?? -1,
          backlog: Math.max(0, this.serverFrame - this.frame + 1),
        });
        this.repairs++;
        this.synchronize().catch((e) => this.error(e.message));
        return;
      }
      if (own === hash) this.matches++;
      remote.set(id, null);
    }
  }
  tick(time) {
    if (this.running && time - (this.lastInputTick ?? time) > 250) {
      this.inputTiming.interrupt();
      this.recordPerformanceEvent("browser-interruption", {
        ms: Math.round(time - this.lastInputTick),
      });
    }
    this.lastInputTick = time;
    if (this.running && time - this.lastEcho > 2000) {
      this.lastEcho = time;
      this.sendGame({ type: "echo", sent: time });
      this.send({ type: "ping", id: time });
    }
    if (!this.running) return false;
    // Sample against the server's clock, independently of local rendering.
    // A slowed browser can catch up without moving everyone else's deadline.
    const latest = this.room.inputMode === "latest";
    this.personalDelay = latest
      ? 0
      : this.inputTiming.lead(this.delay, this.relayRTT || 0);
    this.jitterLead = this.personalDelay;
    const target = Math.max(0, this.serverFrame + 1) + this.personalDelay;
    if (
      this.localFighters.length &&
      (latest
        ? this.lastControllerSampleTime !== time
        : target > this.lastSample)
    ) {
      this.lastControllerSampleTime = time;
      for (const player of this.localFighters) {
        if (!player.ready && this.room.selecting) continue;
        let stream = this;
        if (player.id !== this.id) {
          if (!this.localStreams.has(player.id))
            this.localStreams.set(player.id, { lastSample: this.lastSample });
          stream = this.localStreams.get(player.id);
        }
        if (stream.slot !== player.slot) {
          stream.slot = player.slot;
          stream.lastPublishedInput = null;
        }
        const sampled = this.samplePlayer
          ? this.samplePlayer(player)
          : this.controls.sample();
        const input = this.filterInput
          ? this.filterInput(sampled, player)
          : sampled;
        const targetPlayer =
          player.id === this.id ? {} : { playerId: player.id };
        if (latest) {
          const previous = stream.lastPublishedInput;
          if (
            (this.socket?.bufferedAmount || 0) < 8192 &&
            (!previous ||
              previous.buttons !== input.buttons ||
              previous.x !== input.x ||
              previous.y !== input.y ||
              this.now() - stream.lastPublishedAt >= 50)
          ) {
            const sequence = ++this.inputSequence;
            stream.lastPublishedAt = this.now();
            stream.lastPublishedInput = { ...input };
            if (player.id === this.id)
              this.sentStates.set(sequence, stream.lastPublishedAt);
            if (this.sentStates.size > 256)
              this.sentStates.delete(this.sentStates.keys().next().value);
            this.sendGame(
              { type: "input-state", sequence, input, ...targetPlayer },
              false,
            );
          }
        } else
          for (
            let f = Math.max(stream.lastSample + 1, this.serverFrame + 1);
            f <= target;
            f++
          ) {
            this.sendGame(
              { type: "input", frame: f, input, ...targetPlayer },
              false,
            );
            this.sentInputs.set(f, this.now());
          }
        stream.lastSample = target;
      }
      this.lastSample = target;
      for (const id of this.localStreams.keys())
        if (!this.localFighters.some((p) => p.id === id))
          this.localStreams.delete(id);
      for (const f of this.sentInputs.keys())
        if (f < this.serverFrame - 120) this.sentInputs.delete(f);
    }
    // The 60 Hz server stream already paces the game. A second local deadline
    // retained catch-up debt after a stall and left fresh frames unrendered.
    if (
      this.room.timing !== "deadline" &&
      time + 1 < this.next &&
      this.serverFrame - this.frame < 3
    )
      return false;
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
    if (this.frame % inspectEvery === 0) {
      const info = this.engine.inspect();
      this.rounds.observe(info, this.room);
      if (this.frame % 600 === 0 && info.scene !== 22 && info.scene !== 24)
        this.engine.keepMenuAlive?.();
      if (
        this.isHost &&
        info.scene === 24 &&
        info.results?.ticks >= 2 &&
        info.results.kind !== 4 &&
        this.reportedRound !== this.room.round
      ) {
        this.reportedRound = this.room.round;
        this.send({
          type: "results",
          round: this.room.round,
          teams: info.results.teams,
          players: info.results.players.filter((p) => p.present),
        });
      }
    }
    const inputs = current.map((input) => ({ ...input }));
    for (const command of this.frameCommands.get(this.frame) || []) {
      if (command.releaseSlot) {
        const info = this.engine.inspect();
        if (info.scene === 16 && info.players[command.slot]?.selected)
          inputs[command.slot] = { buttons: 64, x: 0, y: 0 };
        continue;
      }
      if (
        command.scene === 21 &&
        command.id !== this.rounds.chooser(this.room)?.id
      )
        continue;
      if (command.button) {
        if (this.engine.inspect().scene === command.scene)
          inputs[command.slot].buttons |= command.button;
      } else this.engine.menuPointer(command);
    }
    this.frameCommands.delete(this.frame);
    const stepStarted = this.now();
    this.engine.frame(this.rounds.filter(inputs, this.room));
    const sequence = this.frameSequences.get(this.frame);
    if (sequence > this.lastAppliedSequence) {
      const sent = this.sentStates.get(sequence);
      if (sent !== undefined) {
        this.inputLatencies.push(this.now() - sent);
        if (this.inputLatencies.length > 256) this.inputLatencies.shift();
      }
      this.lastAppliedSequence = sequence;
      for (const key of this.sentStates.keys())
        if (key <= sequence) this.sentStates.delete(key);
    }
    this.frameSequences.delete(this.frame);
    const stepMs = this.now() - stepStarted;
    this.stepCost ||= { count: 0, total: 0, max: 0 };
    this.stepCost.count++;
    this.stepCost.total += stepMs;
    this.stepCost.max = Math.max(this.stepCost.max, stepMs);
    this.inputs.delete(this.frame);
    this.frame++;
    this.next = Math.min(
      Math.max(
        this.next + 1000 / this.engine.fps,
        time - 1000 / this.engine.fps,
      ),
      time + 1000 / this.engine.fps,
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
  recordPerformanceEvent(type, detail = {}) {
    this.performanceEvents.push({
      at: new Date().toISOString(),
      type,
      ...detail,
    });
    if (this.performanceEvents.length > 100) this.performanceEvents.shift();
  }
  samplePerformance(fps, voiceActive = false, longTasks = 0) {
    const latencies = this.inputLatencies.toSorted((a, b) => a - b);
    const sample = {
      fps,
      relayRTT: this.relayRTT || 0,
      typicalRTT: this.inputTiming.rtt,
      inputBuffer: this.personalDelay ?? this.delay,
      inputAckSamples: latencies.length,
      inputAckAvgMs: Math.round(
        latencies.reduce((a, b) => a + b, 0) / (latencies.length || 1),
      ),
      inputAckP95Ms: Math.round(
        latencies[Math.floor(latencies.length * 0.95)] || 0,
      ),
      backlog: Math.max(0, (this.serverFrame || 0) - this.frame + 1),
      frameGapMs: Math.round(this.maxFrameGap || 0),
      stepAvgMs:
        Math.round(
          ((this.stepCost?.total || 0) / (this.stepCost?.count || 1)) * 10,
        ) / 10,
      stepMaxMs: Math.round((this.stepCost?.max || 0) * 10) / 10,
      ownLateInputs: this.ownLateInputs || 0,
      repairs: this.repairs,
      gameQueuedBytes: this.socket?.bufferedAmount || 0,
      mediaQueuedBytes: this.mediaSocket?.bufferedAmount || 0,
      mediaConnected: Number(!!this.mediaReady),
      voiceActive: Number(voiceActive),
      voiceSent: this.voiceSent || 0,
      voiceDropped: this.voiceDropped || 0,
      frame: this.frame,
      longTasks,
    };
    this.performanceSamples.push({ at: new Date().toISOString(), ...sample });
    if (this.performanceSamples.length > 120) this.performanceSamples.shift();
    this.maxFrameGap = 0;
    this.inputLatencies = [];
    this.stepCost = { count: 0, total: 0, max: 0 };
    if (this.room) {
      this.send({ type: "performance", metrics: sample });
      if (this.isHost) this.send({ type: "performance-report" });
    }
    return sample;
  }
  pause() {
    if (
      !this.running ||
      this.room?.selecting ||
      (this.engine.info?.scene ??
        this.engine.inspect?.()?.scene ??
        this.rounds.scene) !== 22 ||
      (!this.localFighters.length && !this.isHost)
    )
      return;
    this.running = false;
    this.sendGame({ type: "pause" }, false);
    this.status("paused");
  }
  resume() {
    if (this.running || !this.allConnected) return;
    this.message = "";
    if (this.isHost) this.synchronize().catch((e) => this.error(e.message));
    else this.sendGame({ type: "resync" }, false, this.room.hostId);
  }
}
