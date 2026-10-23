import { assetURL } from "./service.js";
import { menuRows } from "./native-menus.js";
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
        locateFile: (file) => assetURL("engine/" + file),
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
      script.src = assetURL("engine/n64wasm.js");
      script.onerror = () => reject(Error("Could not load the game engine."));
      document.head.append(script);
    });
    this.module = window.Module;
    window.FS.writeFile(
      "assets.zip",
      new Uint8Array(
        await (await fetch(assetURL("engine/assets.zip"))).arrayBuffer(),
      ),
    );
    window.FS.writeFile("custom.v64", bytes);
    const config = Array(48).fill("0");
    for (let i = 0; i < 15; i++) config[i] = "-1";
    for (let i = 15; i < 34; i++) config[i] = "Unassigned";
    config[39] = "1"; // game scheduler owns frame pacing
    // Upload one interleaved vertex buffer per draw. Client-side arrays make
    // Emscripten re-upload each attribute separately and exhaust the frame budget.
    config[46] = "1";
    window.FS.writeFile("config.txt", config.join("\n") + "\n");
    window.FS.writeFile("cheat.txt", "");
    this.module.callMain(["custom.v64"]);
    // Our Controls layer supplies every controller through frame(). The core's
    // redundant DOM key handlers prevent normal typing and form submission
    // even while its game is paused, so remove only those keyboard handlers.
    for (const target of [window, document, this.canvas])
      for (const type of [
        "keydown",
        "keyup",
        "keypress",
        "mousedown",
        "mouseup",
        "mousemove",
        "touchstart",
        "touchmove",
        "touchend",
        "wheel",
      ])
        window.JSEvents.removeAllHandlersOnTarget(target, type);
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
    this.info = null;
    this.flushAudio();
  }
  unlockAll() {
    // Native LBBackupData: all twelve playable fighters (FTKind 0..11),
    // Mushroom Kingdom, Sound Test and Item Switch. Modify the session's
    // save data through the official serializer; the cartridge is unchanged.
    const state = this.snapshot();
    state[448 + ((0xa44e0 + 0x457) ^ 3)] |= 0x7f;
    state[448 + ((0xa44e0 + 0x458) ^ 3)] |= 0x0f;
    state[448 + ((0xa44e0 + 0x459) ^ 3)] = 0xff;
    this.restore(state);
  }
  menuPointer({ scene, slot = 0, x, y }) {
    if (this.inspect().scene !== scene || scene === 22) return false;
    if (scene === 24) return true;
    const state = this.snapshot(),
      data = new DataView(state.buffer, state.byteOffset, state.byteLength);
    const at = (address) => 448 + (address & 0x7fffff);
    const word = (address) => data.getUint32(at(address), true);
    const put = (address, value) => data.setUint32(at(address), value, true);
    if ([16, 17, 18, 19, 20].includes(scene)) {
      // MNPlayersSlotVS.cursor -> GObj.obj -> SObj.pos, from the US decomp symbols.
      const address =
        scene === 16
          ? 0x8013ba88 + slot * 0xbc
          : scene === 17
            ? 0x80138ee8
            : scene === 18
              ? 0x80138558 + slot * 0xb8
              : 0x80137648;
      const cursor = word(address),
        sprite = cursor && word(cursor + 0x74);
      if (!sprite || (sprite & 0x7fffff) > 0x7fff00) return false;
      const oldX = data.getFloat32(at(sprite + 0x58), true),
        oldY = data.getFloat32(at(sprite + 0x5c), true);
      const nx = Math.max(0, Math.min(280, x - 25)),
        ny = Math.max(10, Math.min(205, y - 3));
      data.setFloat32(at(sprite + 0x58), nx, true);
      data.setFloat32(at(sprite + 0x5c), ny, true);
      const next = word(sprite + 8);
      if (next) {
        data.setFloat32(
          at(next + 0x58),
          data.getFloat32(at(next + 0x58), true) + nx - oldX,
          true,
        );
        data.setFloat32(
          at(next + 0x5c),
          data.getFloat32(at(next + 0x5c), true) + ny - oldY,
          true,
        );
      }
    } else if (scene === 21) {
      if (x < 30 || x > 280 || y < 30 || y > 106) return false;
      const col = Math.max(0, Math.min(4, Math.floor((x - 30) / 50))),
        row = y < 68 ? 0 : 1;
      put(0x80134bd8, col + row * 5);
    } else return false;
    this.restore(state);
    return true;
  }
  setTeams(room) {
    if (!room.teamsConfigured || this.inspect().scene !== 16) return;
    const slot = room.members.find((p) => p.slot >= 0)?.slot ?? 0;
    const click = (x, y) => {
      this.menuPointer({ scene: 16, slot, x, y });
      for (let f = 0; f < 12; f++)
        this.frame(
          [0, 1, 2, 3].map((i) => ({
            buttons: i === slot && f < 2 ? 128 : 0,
            x: 0,
            y: 0,
          })),
        );
    };
    // Use native clicks so labels, costumes and team colors update together.
    if (this.inspect().teams !== room.teams) click(80, 25);
    if (room.teams)
      for (const p of room.members.filter((p) => p.slot >= 0)) {
        for (
          let i = 0;
          i < 3 && this.inspect().players[p.slot].team !== p.team;
          i++
        )
          click(51 + p.slot * 69, 136);
      }
    this.menuPointer({ scene: 16, slot, x: 36 + slot * 69, y: 205 });
    this.flushAudio();
  }
  enableStageSelect() {
    const state = this.snapshot();
    state[448 + ((0xa4d08 + 10) ^ 3)] = 1;
    this.restore(state);
  }
  inspect() {
    // Read-only introspection of the verified US cartridge. The pinned core's
    // official savestate stores word-swapped RDRAM at byte 448. No ROM patches
    // or game assets are needed. Symbols: VetriTheRetri/ssb-decomp-re,
    // symbols_us.txt, scdef.h and mntypes.h (MNPlayersSlotVS = 0xbc bytes).
    const m = this.module;
    if (!m._netplay_serialize_state())
      return this.info || { scene: -1, players: [] };
    const base = m._netplay_get_state_buffer() + 448;
    const byte = (address) => m.HEAPU8[base + ((address & 0x7fffff) ^ 3)];
    const word = (address) => m.HEAP32[(base + (address & 0x7fffff)) >>> 2];
    const scene = byte(0x800a4ad0);
    const players =
      scene === 16
        ? [0, 1, 2, 3].map((slot) => {
            const p = 0x8013ba88 + slot * 0xbc;
            return {
              slot,
              fighter: word(p + 0x48),
              selected: !!word(p + 0x88),
              kind: word(p + 0x84),
              holding: !!word(p) && word(p + 0x54) === 1,
              team: word(p + 0x40),
            };
          })
        : [];
    const rules = 0x800a4d08;
    this.info = {
      scene,
      players,
      selectionTicks: scene === 16 ? word(0x8013bdcc) : 0,
      unlocks: {
        features: byte(0x800a4937),
        fighters: (byte(0x800a4938) << 8) | byte(0x800a4939),
      },
      stage:
        scene === 21
          ? { slot: word(0x80134bd8), unlocked: byte(0x80134c1c) }
          : null,
      results:
        scene === 24
          ? {
              ticks: word(0x80139b78),
              exitTicks: word(0x80139c18),
              kind: word(0x80139c10),
              teams: !!word(0x80139c14),
              players: [0, 1, 2, 3].map((slot) => ({
                slot,
                present: !!word(0x80139bd0 + slot * 4),
                place: word(0x80139bb0 + slot * 4),
                points: word(0x80139ba0 + slot * 4),
                kos: word(0x80139b80 + slot * 4),
              })),
            }
          : null,
      teams: scene === 16 && !!word(0x8013bda8),
      rules: {
        mode: byte(rules + 3) & 2 ? "stock" : "time",
        teams: !!byte(rules + 2),
        time: byte(rules + 6),
        lives: byte(rules + 7) + 1,
        items: byte(rules + 28),
        itemMask: word(rules + 12) >>> 0,
        damage: byte(rules + 11),
        teamAttack: !!byte(rules + 9),
        stageSelect: !!byte(rules + 10),
      },
      menu:
        scene === 7
          ? { row: word(0x80132c88) }
          : scene === 9
            ? {
                row: word(0x80134948),
                rule: word(0x8013494c),
                time: word(0x80134950),
                lives: word(0x80134954) + 1,
              }
            : scene === 10
              ? { row: word(0x801348e0), hasItems: !!word(0x80134904) }
              : scene === 11
                ? { row: word(0x801333d8), items: word(0x80133420) }
                : menuRows[scene]
                  ? {
                      row: word(menuRows[scene].address),
                      confirmation: scene === 47 ? word(0x801330d0) : 0,
                    }
                  : null,
    };
    return this.info;
  }
  async audioStart() {
    if (!this.loaded) return;
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) return;
    if (!this.audio) {
      const ctx = new Context({
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
