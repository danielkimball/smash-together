import test from "node:test";
import assert from "node:assert/strict";
import { RoomVoice } from "../public/js/voice.js";
import { AudioSettings } from "../public/js/audio-settings.js";
function fixture(t) {
  const tracks = [],
    calls = [];
  let permission = async () => {
    const track = {
      enabled: true,
      stop() {
        this.stopped = true;
      },
    };
    tracks.push(track);
    return { getAudioTracks: () => [track], getTracks: () => [track] };
  };
  class Context {
    constructor() {
      this.state = "suspended";
      this.audioWorklet = { addModule: async () => {} };
    }
    async resume() {
      this.state = "running";
      this.onstatechange?.();
    }
    async close() {
      this.state = "closed";
    }
    createMediaStreamSource() {
      return { connect() {}, disconnect() {} };
    }
  }
  class Worklet {
    constructor() {
      this.messages = [];
      this.port = { postMessage: (m) => this.messages.push(m) };
    }
    connect() {}
    disconnect() {}
  }
  const storage = new Map();
  const globals = {
    window: Object.assign(new EventTarget(), {
      AudioContext: Context,
      AudioWorkletNode: Worklet,
    }),
    AudioWorkletNode: Worklet,
    localStorage: {
      getItem: (key) => storage.get(key),
      setItem: (key, value) => storage.set(key, value),
    },
    navigator: {
      mediaDevices: {
        getUserMedia: (...args) => {
          calls.push(args);
          return permission();
        },
      },
    },
  };
  for (const [name, value] of Object.entries(globals)) {
    const old = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() =>
      old
        ? Object.defineProperty(globalThis, name, old)
        : delete globalThis[name],
    );
  }
  const net = Object.assign(new EventTarget(), {
    id: "me",
    state: "playing",
    sent: [],
    voicePackets: [],
    send(m) {
      this.sent.push(m);
    },
    sendVoice(packet) {
      this.voicePackets.push(packet);
    },
  });
  net.me = { id: "me", slot: 0, connected: true };
  net.devices = [
    net.me,
    { id: "friend", slot: 1, connected: true, voice: true },
  ];
  net.localFighters = [net.me];
  net.room = { id: "first-room", members: net.devices };
  const voice = new RoomVoice(net);
  t.after(() => voice.stop());
  return {
    net,
    voice,
    calls,
    tracks,
    setPermission: (next) => {
      permission = next;
    },
  };
}
const packet = {
  from: "friend",
  audio: Buffer.alloc(640, 127).toString("base64"),
};
test("joining a room automatically starts listening without requesting a microphone", async (t) => {
  const { net, voice, calls } = fixture(t);
  net.dispatchEvent(new Event("change"));
  await voice.audioReady;
  assert.equal(voice.isListening, true);
  assert.equal(calls.length, 0);
  assert.equal(voice.stream, undefined);
  assert.deepEqual(net.sent.at(-1), {
    type: "voice-state",
    enabled: false,
    listening: true,
  });
  voice.receive(packet);
  assert.equal(voice.node.messages.filter((m) => m.type === "audio").length, 1);
});
test("microphone denial leaves listening and incoming audio intact", async (t) => {
  const { voice, calls, setPermission } = fixture(t);
  setPermission(async () => {
    throw new DOMException("Denied", "NotAllowedError");
  });
  await voice.join();
  assert.equal(calls.length, 1);
  assert.equal(voice.isListening, true);
  assert.equal(voice.stream, undefined);
  assert.match(voice.error, /still hear everyone/);
  voice.receive(packet);
  assert.ok(voice.node.messages.some((m) => m.type === "audio"));
});
test("individual and all-voice mute drop playback while microphone mute remains independent", async (t) => {
  const { voice, tracks, net } = fixture(t);
  await voice.join();
  voice.setLevel("friend", 0);
  voice.receive(packet);
  assert.equal(voice.node.messages.filter((m) => m.type === "audio").length, 0);
  voice.setLevel("friend", 1);
  voice.receive(packet);
  assert.equal(voice.node.messages.filter((m) => m.type === "audio").length, 1);
  voice.muteAll(true);
  voice.receive(packet);
  assert.equal(voice.node.messages.filter((m) => m.type === "audio").length, 1);
  assert.equal(tracks[0].enabled, true);
  assert.equal(net.sent.at(-1).enabled, true);
  assert.equal(net.sent.at(-1).listening, false);
  voice.muteAll(false);
  voice.muted = true;
  voice.settings();
  assert.equal(tracks[0].enabled, false);
  assert.equal(voice.isListening, true);
  assert.equal(net.sent.at(-1).enabled, false);
});
test("host microphone mute cannot silently turn the microphone back on", async (t) => {
  const { voice, tracks, net } = fixture(t);
  await voice.join();
  net.me.muted = true;
  voice.settings();
  assert.equal(tracks[0].enabled, false);
  net.me.muted = false;
  voice.settings();
  assert.equal(voice.muted, true);
  assert.equal(tracks[0].enabled, false);
  assert.equal(voice.isListening, true);
});
test("a late microphone permission result after leaving closes its tracks", async (t) => {
  const { voice, net, setPermission } = fixture(t);
  let resolve;
  setPermission(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const pending = voice.join();
  await voice.audioReady;
  net.room = null;
  voice.stop();
  const track = {
    stop() {
      this.stopped = true;
    },
  };
  resolve({ getTracks: () => [track] });
  await pending;
  assert.equal(track.stopped, true);
  assert.equal(voice.node, null);
  assert.equal(voice.stream, null);
});
test("speech ducks game volume without overwriting the user's chosen level and restores it", async (t) => {
  const { voice } = fixture(t);
  const engine = {
    setVolume(v) {
      this.volume = v;
    },
    setVoiceGain(v) {
      this.voiceGain = v;
    },
  };
  const audio = new AudioSettings(engine, voice);
  await voice.listen();
  audio.setGame(0.4);
  voice.receive(packet);
  assert.equal(engine.volume, 0.4);
  assert.equal(engine.voiceGain, 0.28);
  audio.setGame(0.7);
  audio.tick(voice.activityUntil + 1);
  assert.equal(engine.volume, 0.7);
  assert.equal(engine.voiceGain, 1);
  voice.receive(packet);
  voice.muteAll(true);
  assert.equal(engine.voiceGain, 1);
  assert.equal(new AudioSettings(engine, voice).game, 0.7);
});

test("zero voice volume stops delivery and ducking without turning off the microphone", async (t) => {
  const { voice, net, tracks } = fixture(t);
  const engine = {
    setVolume() {},
    setVoiceGain(v) {
      this.voiceGain = v;
    },
  };
  const audio = new AudioSettings(engine, voice);
  await voice.join();
  voice.receive(packet);
  assert.equal(engine.voiceGain, 0.28);
  audio.setVoice(0);
  assert.equal(net.sent.at(-1).listening, false);
  assert.equal(net.sent.at(-1).enabled, true);
  assert.equal(tracks[0].enabled, true);
  assert.equal(engine.voiceGain, 1);
  audio.setVoice(1);
  assert.equal(net.sent.at(-1).listening, true);
});
test("individual mute survives a same-room reconnect and resets for a different room", async (t) => {
  const { voice, net } = fixture(t);
  await voice.listen();
  voice.setLevel("friend", 0);
  voice.stop();
  await voice.listen();
  assert.equal(voice.levels.get("friend"), 0);
  voice.receive(packet);
  assert.equal(voice.node.messages.filter((m) => m.type === "audio").length, 0);
  net.room = { ...net.room, id: "different-room" };
  voice.settings();
  assert.equal(voice.levels.size, 0);
});
