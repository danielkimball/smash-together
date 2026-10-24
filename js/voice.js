import { assetURL } from "./service.js";
export class RoomVoice extends EventTarget {
  constructor(net) {
    super();
    this.net = net;
    this.muted = false;
    this.volume = 1;
    this.deafened = localStorage.getItem("smash.voiceMuted") === "true";
    this.levels = new Map();
    this.speaking = new Map();
    this.generation = this.micGeneration = 0;
    this.activityUntil = 0;
    net.addEventListener("voice", (e) => this.receive(e.detail));
    net.addEventListener("change", () => {
      if (net.state === "error") this.stop();
      else {
        if (net.room && !this.audioError) this.listen();
        this.settings();
      }
    });
    net.addEventListener("leave", () => this.stop());
    window.addEventListener("pagehide", () => this.stop());
    // Listening needs no microphone permission. If autoplay was blocked,
    // the next ordinary click/key resumes it; a visible Enable sound button
    // offers the same action for controller-only entry.
    const unlock = () => {
      if (net.room && !this.audioError) this.listen();
    };
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
  }
  emit() {
    this.dispatchEvent(new Event("change"));
  }
  get isListening() {
    return (
      !!this.net.room &&
      !!this.node &&
      this.ctx?.state === "running" &&
      !this.deafened
    );
  }
  get forced() {
    return !!(
      this.net.me?.muted ||
      (this.net.room?.muteSpectators && !this.net.localFighters.length)
    );
  }
  get blocked() {
    return !this.stream || this.muted || this.forced;
  }
  async listen() {
    if (!this.net.room) return;
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context || !window.AudioWorkletNode) {
      this.audioError =
        "Voice playback is unavailable in this browser. Use the HTTPS play link in an updated browser.";
      this.emit();
      return;
    }
    if (!this.ctx) {
      const generation = this.generation;
      const ctx = (this.ctx = new Context({ latencyHint: "interactive" }));
      ctx.onstatechange = () => {
        if (ctx === this.ctx) this.settings();
      };
      this.audioReady = ctx.audioWorklet
        .addModule(assetURL("js/voice-worklet.js"))
        .then(() => {
          if (generation !== this.generation || !this.net.room) return;
          this.node = new AudioWorkletNode(ctx, "room-voice", {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [1],
          });
          this.node.connect(ctx.destination);
          this.node.port.onmessage = ({ data: m }) => {
            if (m.type !== "packet" || this.blocked || !this.net.room) return;
            this.speaking.set(this.net.id, performance.now() + 350);
            this.activityUntil = performance.now() + 650;
            this.dispatchEvent(new Event("activity"));
            this.net.sendVoice(btoa(String.fromCharCode(...m.bytes)));
          };
          this.settings();
        })
        .catch((e) => {
          if (generation !== this.generation) return;
          this.audioError = e.message || "Voice playback could not start.";
          this.emit();
        });
    }
    // Do not await resume: a suspended context may wait for a future gesture.
    // Receiving audio and opening a microphone are independent operations.
    this.ctx.resume().catch(() => {});
    await this.audioReady;
  }
  async join() {
    if (this.stream || this.joining || !this.net.room) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      this.error =
        "This browser cannot access a microphone. You can still listen.";
      this.emit();
      return;
    }
    this.joining = true;
    this.error = "";
    const generation = ++this.micGeneration;
    this.emit();
    const audio = this.listen();
    try {
      // Only this explicit microphone button calls getUserMedia.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      if (generation !== this.micGeneration || !this.net.room) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      await audio;
      if (generation !== this.micGeneration || !this.node) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      this.stream = stream;
      this.muted = false;
      this.source = this.ctx.createMediaStreamSource(stream);
      this.source.connect(this.node);
      stream.getAudioTracks()[0].onended = () => this.stopMicrophone();
    } catch (e) {
      if (generation === this.micGeneration)
        this.error =
          e.name === "NotAllowedError"
            ? "Microphone permission was denied. You can still hear everyone. Allow the mic in your browser settings to speak."
            : e.message;
    } finally {
      if (generation === this.micGeneration) this.joining = false;
      this.settings();
    }
  }
  publish() {
    if (!this.net.room) return;
    const state = {
      enabled: !!this.stream && !this.blocked,
      listening: this.isListening && this.volume > 0,
    };
    const signature = JSON.stringify([this.net.id, state]);
    if (signature !== this.announced) {
      this.announced = signature;
      this.net.send({ type: "voice-state", ...state });
    }
  }
  settings() {
    if (this.net.room?.id && this.net.room.id !== this.lastRoomId) {
      this.lastRoomId = this.net.room.id;
      this.levels.clear();
    }
    if (this.forced && !this.wasForced) this.muted = true;
    this.wasForced = this.forced;
    const gains = {};
    for (const p of this.net.devices || []) {
      const hasFighter = (this.net.room?.members || []).some(
        (m) => (m.ownerId || m.id) === p.id && m.slot >= 0,
      );
      gains[p.id] =
        p.muted || (this.net.room?.muteSpectators && !hasFighter)
          ? 0
          : (this.levels.get(p.id) ?? 1);
      if (!p.voice || !gains[p.id] || !this.isListening) {
        this.node?.port.postMessage({ type: "remove", id: p.id });
        this.speaking.delete(p.id);
      }
    }
    this.node?.port.postMessage({
      type: "settings",
      enabled: !this.blocked,
      volume: this.deafened ? 0 : this.volume,
      gains,
    });
    for (const track of this.stream?.getAudioTracks() || [])
      track.enabled = !this.blocked;
    for (const id of this.speaking.keys())
      if (!this.net.devices.some((p) => p.id === id)) {
        this.node?.port.postMessage({ type: "remove", id });
        this.speaking.delete(id);
      }
    if (!this.isListening || !this.volume) this.activityUntil = 0;
    this.publish();
    this.emit();
  }
  muteAll(muted) {
    this.deafened = muted;
    localStorage.setItem("smash.voiceMuted", String(muted));
    if (!muted) this.listen();
    this.settings();
  }
  setLevel(id, value) {
    this.levels.set(id, Math.max(0, Math.min(1, value)));
    this.settings();
  }
  receive(m) {
    const p = this.net.devices.find((p) => p.id === m.from);
    const hasFighter = this.net.room?.members.some(
      (member) => (member.ownerId || member.id) === m.from && member.slot >= 0,
    );
    if (
      !this.isListening ||
      !this.volume ||
      !p?.voice ||
      p.muted ||
      (this.net.room.muteSpectators && !hasFighter) ||
      (this.levels.get(m.from) ?? 1) <= 0
    )
      return;
    try {
      const bytes = Array.from(atob(m.audio), (c) => c.charCodeAt(0));
      if (bytes.length !== 640) return;
      this.activityUntil = performance.now() + 650;
      this.dispatchEvent(new Event("activity"));
      this.node.port.postMessage({ type: "audio", id: m.from, bytes });
      this.speaking.set(m.from, performance.now() + 350);
    } catch {}
  }
  stopMicrophone() {
    this.micGeneration++;
    this.joining = false;
    const stream = this.stream;
    this.stream = null;
    this.source?.disconnect();
    this.source = null;
    for (const track of stream?.getTracks() || []) {
      track.onended = null;
      track.stop();
    }
    this.settings();
  }
  stop() {
    this.generation++;
    this.stopMicrophone();
    this.node?.disconnect();
    this.node = null;
    const ctx = this.ctx;
    this.ctx = null;
    this.audioReady = null;
    if (ctx) {
      ctx.onstatechange = null;
      ctx.close().catch(() => {});
    }
    this.speaking.clear();
    this.activityUntil = 0;
    this.audioError = this.error = "";
    this.publish();
    this.emit();
  }
}
