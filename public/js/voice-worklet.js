// Narrowband transport uses 16 kHz G.711 mu-law in short, transient packets.
// Audio stays in this room's relay; it is never recorded or written to disk.
const decode = (u) => {
  u = ~u & 255;
  const sample = (((u & 15) << 3) + 132) << ((u >> 4) & 7);
  return (u & 128 ? 132 - sample : sample - 132) / 32768;
};
const encode = (value) => {
  let pcm = Math.max(-32635, Math.min(32635, Math.round(value * 32768)));
  const sign = pcm < 0 ? 128 : 0;
  if (pcm < 0) pcm = -pcm;
  pcm += 132;
  let exponent = 7;
  for (
    let mask = 16384;
    exponent > 0 && !(pcm & mask);
    exponent--, mask >>= 1
  ) {}
  return ~(sign | (exponent << 4) | ((pcm >> (exponent + 3)) & 15)) & 255;
};
class RoomVoiceProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.peers = new Map();
    this.enabled = true;
    this.volume = 1;
    this.packet = new Uint8Array(640);
    this.at = 0;
    this.energy = 0;
    this.phase = 0;
    this.port.onmessage = ({ data: m }) => {
      if (m.type === "settings") {
        this.enabled = m.enabled;
        this.volume = m.volume;
        for (const [id, peer] of this.peers) peer.gain = m.gains[id] ?? 0;
        this.gains = m.gains;
      } else if (m.type === "audio") {
        let peer = this.peers.get(m.id);
        if (!peer) {
          peer = {
            samples: [],
            read: 0,
            phase: 0,
            ready: false,
            gain: this.gains?.[m.id] ?? 1,
          };
          this.peers.set(m.id, peer);
        }
        peer.samples.push(...m.bytes.map(decode));
        if (peer.samples.length - peer.read > 8000)
          peer.read = peer.samples.length - 1920;
        if (peer.samples.length - peer.read >= 1280) peer.ready = true;
      } else if (m.type === "remove") this.peers.delete(m.id);
    };
  }
  process(inputs, outputs) {
    const mic = inputs[0]?.[0],
      out = outputs[0]?.[0];
    if (!out) return true;
    const ratio = 16000 / sampleRate;
    for (let i = 0; i < out.length; i++) {
      this.phase += ratio;
      if (this.phase >= 1) {
        this.phase -= 1;
        const value = this.enabled ? mic?.[i] || 0 : 0;
        this.packet[this.at++] = encode(value);
        this.energy += value * value;
        if (this.at === 640) {
          const speaking = this.enabled && this.energy / 640 > 0.000025;
          if (speaking)
            this.port.postMessage({ type: "packet", bytes: this.packet });
          this.at = 0;
          this.energy = 0;
        }
      }
      let value = 0;
      for (const peer of this.peers.values()) {
        if (!peer.ready) continue;
        value += (peer.samples[peer.read] || 0) * peer.gain;
        peer.phase += ratio;
        if (peer.phase >= 1) {
          peer.phase -= 1;
          peer.read++;
        }
        if (peer.read >= peer.samples.length) peer.ready = false;
      }
      out[i] = Math.max(-1, Math.min(1, value * this.volume));
    }
    for (const peer of this.peers.values())
      if (peer.read > 2048) {
        peer.samples = peer.samples.slice(peer.read);
        peer.read = 0;
      }
    return true;
  }
}
registerProcessor("room-voice", RoomVoiceProcessor);
