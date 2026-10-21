// Browser integration for the pinned N64Wasm core. ROM bytes never leave this browser.
export const ROM_SHA1 = "e2929e10fccc0aa84e5776227e798abc07cedabf";
export async function sha1(data) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-1", data))]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}
export function normalizeROM(buffer) {
  const bytes = new Uint8Array(buffer.slice(0));
  if (bytes.length !== 16777216)
    throw Error(
      "Choose the original 16 MB US Smash Bros. ROM (.z64, .v64, or .n64).",
    );
  if (bytes[0] === 0x37 && bytes[1] === 0x80)
    for (let i = 0; i < bytes.length; i += 2)
      [bytes[i], bytes[i + 1]] = [bytes[i + 1], bytes[i]];
  else if (bytes[0] === 0x40 && bytes[3] === 0x80)
    for (let i = 0; i < bytes.length; i += 4) {
      [bytes[i], bytes[i + 3]] = [bytes[i + 3], bytes[i]];
      [bytes[i + 1], bytes[i + 2]] = [bytes[i + 2], bytes[i + 1]];
    }
  return bytes;
}
export class Engine {
  constructor(canvas) {
    this.canvas = canvas;
    this.loaded = false;
    this.frames = 0;
    this.audio = null;
    this.logs = [];
    this.volume = 0.55;
  }
  async load(bytes) {
    if (this.loaded) return;
    const self = this;
    window.myApp = {
      rivetsData: {
        inputController: { updateMobileControls() {} },
        currentFPS: 0,
      },
      localCallback() {},
      SaveSram() {},
      SaveStateEvent() {},
      ExportEepEvent() {},
      ExportSraEvent() {},
      ExportFlaEvent() {},
      fullscreen() {
        self.canvas.requestFullscreen?.();
      },
      loadCloud() {},
      saveCloud() {},
    };
    await new Promise((resolve, reject) => {
      window.Module = {
        canvas: this.canvas,
        noInitialRun: true,
        locateFile: (file) => "/engine/" + file,
        print: (text) => {
          self.logs.push(text);
          if (self.logs.length > 100) self.logs.shift();
        },
        printErr: (text) => {
          self.logs.push(text);
          console.warn(text);
        },
        onRuntimeInitialized: resolve,
        onAbort: (reason) => reject(Error(String(reason))),
      };
      const script = document.createElement("script");
      script.src = "/engine/n64wasm.js";
      script.onerror = () => reject(Error("Could not load the game engine."));
      document.head.append(script);
    });
    this.module = window.Module;
    window.FS.writeFile(
      "assets.zip",
      new Uint8Array(await (await fetch("/engine/assets.zip")).arrayBuffer()),
    );
    window.FS.writeFile("custom.v64", bytes);
    const config = Array(48).fill("0");
    for (let i = 0; i < 15; i++) config[i] = "-1";
    for (let i = 15; i < 34; i++) config[i] = "Unassigned";
    config[39] = "1"; // game scheduler owns frame pacing
    window.FS.writeFile("config.txt", config.join("\n") + "\n");
    window.FS.writeFile("cheat.txt", "");
    this.module.callMain(["custom.v64"]);
    this.module._netplay_set_enabled(1);
    this.module._toggleFPS(0);
    this.build = this.module.cwrap("netplay_get_build_id", "string", [])();
    this.loaded = true;
    this.fps = this.module._netplay_get_fps() || 60;
  }
  frame(inputs) {
    for (let p = 0; p < 4; p++) {
      const i = inputs[p] || { buttons: 0, x: 0, y: 0 };
      this.module._netplay_set_controller_input(p, i.buttons, i.x, i.y);
    }
    if (!this.module._netplay_run_frame())
      throw Error("The game engine could not advance.");
    this.frames++;
  }
  hash() {
    const m = this.module;
    return (
      (m._netplay_get_state_hash_high() >>> 0).toString(16).padStart(8, "0") +
      (m._netplay_get_state_hash_low() >>> 0).toString(16).padStart(8, "0")
    );
  }
  snapshot() {
    const m = this.module;
    if (!m._netplay_serialize_state())
      throw Error("Could not save the game state.");
    return m.HEAPU8.slice(
      m._netplay_get_state_buffer(),
      m._netplay_get_state_buffer() + m._netplay_get_state_size(),
    );
  }
  restore(bytes) {
    const m = this.module;
    if (bytes.length !== m._netplay_get_state_size())
      throw Error("Incompatible game state.");
    m.HEAPU8.set(bytes, m._netplay_get_state_buffer());
    if (!m._netplay_unserialize_state(bytes.length))
      throw Error("Could not restore the game state.");
    this.flushAudio();
  }
  async audioStart() {
    if (!this.loaded) return;
    if (!this.audio) {
      const ctx = new AudioContext({
        sampleRate: 44100,
        latencyHint: "interactive",
      });
      const gain = ctx.createGain();
      gain.gain.value = this.volume;
      gain.connect(ctx.destination);
      const processor = ctx.createScriptProcessor(1024, 0, 2);
      this.audio = {
        ctx,
        gain,
        processor,
        read: this.module._neilGetAudioWritePosition(),
      };
      processor.onaudioprocess = (event) => {
        const m = this.module,
          a = this.audio,
          write = m._neilGetAudioWritePosition();
        const ring = new Int16Array(
          m.HEAP16.buffer,
          m._neilGetSoundBufferResampledAddress(),
          64000,
        );
        const left = event.outputBuffer.getChannelData(0),
          right = event.outputBuffer.getChannelData(1);
        if ((write - a.read + 64000) % 64000 > 12000)
          a.read = (write - 4000 + 64000) % 64000;
        for (let i = 0; i < left.length; i++) {
          if (a.read !== write) {
            left[i] = ring[a.read] / 32768;
            right[i] = ring[a.read + 1] / 32768;
            a.read = (a.read + 2) % 64000;
          } else {
            left[i] = right[i] = 0;
          }
        }
        m._neil_set_buffer_remaining((write - a.read + 64000) % 64000);
      };
      processor.connect(gain);
    }
    await this.audio.ctx.resume();
  }
  flushAudio() {
    if (this.audio) this.audio.read = this.module._neilGetAudioWritePosition();
  }
  setVolume(value) {
    this.volume = value;
    if (this.audio) this.audio.gain.gain.value = value;
  }
}
