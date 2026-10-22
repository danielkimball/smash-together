import { assetURL } from "./service.js";
export class RoomVoice extends EventTarget {
  constructor(net) {
    super();
    this.net = net;
    this.muted = false;
    this.volume = 1;
    this.levels = new Map();
    this.speaking = new Map();
    net.addEventListener("voice", (e) => this.receive(e.detail));
    net.addEventListener("change", () => {
      if (net.state === "error") this.stop();
      else this.settings();
    });
    net.addEventListener("leave", () => this.stop());
    window.addEventListener("pagehide", () => this.stop());
  }
  emit() {
    this.dispatchEvent(new Event("change"));
  }
  async join() {
    if (this.stream || this.joining || !this.net.room) return;
    const Context = window.AudioContext || window.webkitAudioContext;
    if (
      !Context ||
      !window.AudioWorkletNode ||
      !navigator.mediaDevices?.getUserMedia
    ) {
      this.error =
        "Voice is unavailable in this browser. Open the HTTPS play link in an updated Chrome, Safari or Brave browser.";
      this.emit();
      return;
    }
    this.joining = true;
    this.error = "";
    this.emit();
    const generation = (this.generation = (this.generation || 0) + 1);
    const ctx = new Context({ latencyHint: "interactive" });
    this.ctx = ctx;
    // Both calls originate directly in the Join Voice gesture on iPhone.
    const resume = ctx.resume();
    try {
      if (!navigator.mediaDevices?.getUserMedia)
        throw Error(
          "Microphone access requires HTTPS and a supported browser.",
        );
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      if (this.generation !== generation || !this.net.room) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      this.stream = stream;
      await resume;
      await ctx.audioWorklet.addModule(assetURL("js/voice-worklet.js"));
      if (this.generation !== generation) return;
      this.node = new AudioWorkletNode(ctx, "room-voice", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      this.source = ctx.createMediaStreamSource(stream);
      this.source.connect(this.node);
      this.node.connect(ctx.destination);
      this.node.port.onmessage = ({ data: m }) => {
        if (
          m.type !== "packet" ||
          this.blocked ||
          this.net.socket?.bufferedAmount > 65536
        )
          return;
        this.speaking.set(this.net.id, performance.now() + 250);
        this.net.send({
          type: "voice",
          audio: btoa(String.fromCharCode(...m.bytes)),
        });
      };
      stream.getAudioTracks()[0].onended = () => this.stop();
      this.net.send({ type: "voice-state", enabled: true });
      this.settings();
    } catch (e) {
      if (this.generation === generation) {
        this.stop();
        this.error =
          e.name === "NotAllowedError"
            ? "Microphone permission was denied. Allow microphone access in this browser’s website settings, then tap Join Voice again."
            : e.message;
      }
    } finally {
      if (this.generation === generation) this.joining = false;
      this.emit();
    }
  }
  get blocked() {
    return (
      this.muted ||
      this.net.me?.muted ||
      (this.net.room?.muteSpectators && this.net.me?.slot < 0)
    );
  }
  settings() {
    if (!this.node) return;
    const forced = !!(
      this.net.me?.muted ||
      (this.net.room?.muteSpectators && this.net.me?.slot < 0)
    );
    if (forced && !this.forced) this.muted = true;
    this.forced = forced;
    const gains = {};
    for (const p of this.net.room?.members || [])
      gains[p.id] =
        p.muted || (this.net.room.muteSpectators && p.slot < 0)
          ? 0
          : (this.levels.get(p.id) ?? 1);
    this.node.port.postMessage({
      type: "settings",
      enabled: !this.blocked,
      volume: this.volume,
      gains,
    });
    for (const track of this.stream?.getAudioTracks() || [])
      track.enabled = !this.blocked;
    for (const id of this.speaking.keys())
      if (!this.net.room?.members.some((p) => p.id === id && p.voice)) {
        this.node.port.postMessage({ type: "remove", id });
        this.speaking.delete(id);
      }
    this.emit();
  }
  receive(m) {
    const p = this.net.room?.members.find((p) => p.id === m.from);
    if (
      !this.node ||
      !p?.voice ||
      p.muted ||
      (this.net.room.muteSpectators && p.slot < 0)
    )
      return;
    try {
      const bytes = Array.from(atob(m.audio), (c) => c.charCodeAt(0));
      if (bytes.length !== 640) return;
      this.node.port.postMessage({ type: "audio", id: m.from, bytes });
      this.speaking.set(m.from, performance.now() + 250);
    } catch {}
  }
  stop() {
    this.generation = (this.generation || 0) + 1;
    this.joining = false;
    this.net.send({ type: "voice-state", enabled: false });
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.source?.disconnect();
    this.node?.disconnect();
    this.node = null;
    this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.speaking.clear();
    this.emit();
  }
}
