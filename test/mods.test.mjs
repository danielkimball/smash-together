import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import { WebSocket } from "ws";
import { decodeVpk0, encodeVpk0 } from "../public/js/vpk0.js";
import {
  FILE_TABLE,
  FILE_COUNT,
  fileEntry,
  patchCartridge,
  sealPack,
  openPack,
  modsSignature,
  parseRefs,
  formatRefs,
  validatePack,
  toBase64Url,
} from "../public/js/mods.js";
import { PROTOCOL } from "../public/js/protocol.js";
import { createApp, cleanMods } from "../server.mjs";

const ROM = "e2929e10fccc0aa84e5776227e798abc07cedabf";
const DATA = FILE_TABLE + (FILE_COUNT + 1) * 12;
const trees = {
  offsets: [
    [3, 6],
    [9, 13],
  ],
  lengths: [4, [6, 8]],
};
const sha1 = (bytes) => createHash("sha1").update(bytes).digest("hex");

function sample(size, seed = 7) {
  // Repetitive structure plus noise, like model data.
  const out = new Uint8Array(size);
  let s = seed;
  for (let i = 0; i < size; i++) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    out[i] = i % 97 < 40 ? i & 0xff : (s >>> 24) & 0x0f;
  }
  return out;
}
// A minimal 16 MB cartridge with one compressed and one raw file.
function cartridge() {
  const rom = new Uint8Array(16777216);
  const view = new DataView(rom.buffer);
  const model = sample(6000);
  const packed = encodeVpk0(model, { ...trees, method: 1 });
  const slot = Math.ceil((packed.length + 64) / 4) * 4;
  rom.set(packed, DATA);
  view.setUint32(FILE_TABLE + 5 * 12, 0x80000000);
  view.setUint16(FILE_TABLE + 5 * 12 + 6, slot / 4);
  view.setUint16(FILE_TABLE + 5 * 12 + 10, model.length / 4);
  const raw = sample(400, 3);
  view.setUint32(FILE_TABLE + 6 * 12, slot);
  view.setUint16(FILE_TABLE + 6 * 12 + 6, raw.length / 4);
  view.setUint16(FILE_TABLE + 6 * 12 + 10, raw.length / 4);
  rom.set(raw, DATA + slot);
  return { rom, model, raw };
}
function pack(edits, file = 5, original) {
  return {
    format: 1,
    id: "test-crew",
    name: "Test crew",
    version: 1,
    rom: ROM,
    mods: [
      {
        id: "blue-coat",
        name: "Blue coat",
        patches: [{ file, sha1: sha1(original), edits }],
      },
    ],
  };
}

test("VPK0 round-trips edited data in both sample methods", () => {
  for (const method of [0, 1]) {
    const data = sample(9000);
    const packed = encodeVpk0(data, { ...trees, method });
    assert.ok(packed.length < data.length * 0.8);
    const decoded = decodeVpk0(packed);
    assert.deepEqual(decoded.data, data);
    assert.equal(decoded.method, method);
    assert.deepEqual(decoded.offsets, trees.offsets);
    assert.deepEqual(decoded.lengths, trees.lengths);
  }
  assert.throws(() => decodeVpk0(new Uint8Array(16)), /Not a compressed/);
});

test("mods patch only the in-memory cartridge copy and fit in place", async () => {
  const { rom, model, raw } = cartridge();
  const before = rom.slice();
  const coat = pack([{ offset: 100, hex: "5e6874ff" }], 5, model);
  coat.mods[0].patches.push({
    file: 6,
    sha1: sha1(raw),
    edits: [{ offset: 8, hex: "c9a6" }],
  });
  const patched = await patchCartridge(rom, [validatePack(coat, ROM)]);
  assert.deepEqual(rom, before, "the verified original stays untouched");
  const entry = fileEntry(patched, 5);
  const file = decodeVpk0(
    patched.subarray(entry.start, entry.start + entry.slot),
  ).data;
  const expected = model.slice();
  expected.set([0x5e, 0x68, 0x74, 0xff], 100);
  assert.deepEqual(file, expected);
  assert.deepEqual(
    patched.subarray(FILE_TABLE, DATA),
    before.subarray(FILE_TABLE, DATA),
    "file table unchanged",
  );
  const rawEntry = fileEntry(patched, 6);
  assert.deepEqual(
    [...patched.subarray(rawEntry.start + 8, rawEntry.start + 10)],
    [0xc9, 0xa6],
  );
  assert.equal(await patchCartridge(rom, []), rom);
});

test("mods refuse the wrong data, overflowing edits and oversized files", async () => {
  const { rom, model } = cartridge();
  const wrong = pack([{ offset: 0, hex: "00" }], 5, model);
  wrong.mods[0].patches[0].sha1 = "0".repeat(40);
  await assert.rejects(patchCartridge(rom, [wrong]), /does not match/);
  await assert.rejects(
    patchCartridge(rom, [pack([{ offset: 5999, hex: "0000" }], 5, model)]),
    /outside/,
  );
  const noise = toBase64Url(randomBytes(3000));
  const scramble = [...noise].map((c) => c.charCodeAt(0).toString(16)).join("");
  await assert.rejects(
    patchCartridge(rom, [pack([{ offset: 0, hex: scramble }], 5, model)]),
    /too large/,
  );
  assert.throws(
    () => validatePack({ ...pack([], 5, model), rom: "1".repeat(40) }, ROM),
    /different game/,
  );
});

test("packs open only with their key and sign rooms by content", async () => {
  const { model } = cartridge();
  const key = toBase64Url(randomBytes(32));
  const plain = pack([{ offset: 1, hex: "ff" }], 5, model);
  const sealed = await sealPack(plain, key);
  assert.ok(!JSON.stringify(sealed).includes("Blue coat"));
  const opened = await openPack(sealed, key, ROM);
  assert.equal(opened.name, "Test crew");
  assert.match(opened.hash, /^[a-f0-9]{16}$/);
  await assert.rejects(
    openPack(sealed, toBase64Url(randomBytes(32)), ROM),
    /does not open/,
  );
  await assert.rejects(
    openPack({ ...sealed, id: "other" }, key, ROM),
    /does not open/,
  );
  const a = { id: "a", hash: "1".repeat(16) },
    b = { id: "b", hash: "2".repeat(16) };
  assert.equal(await modsSignature([]), "");
  assert.equal(await modsSignature([a, b]), await modsSignature([b, a]));
  assert.match(await modsSignature([a]), /^\+mods1\.[a-f0-9]{12}$/);
  assert.notEqual(
    await modsSignature([a]),
    await modsSignature([{ ...a, hash: "3".repeat(16) }]),
  );
  const refs = [{ id: "test-crew", key }];
  assert.deepEqual(parseRefs(formatRefs(refs)), refs);
  assert.throws(() => parseRefs("test-crew.short"), /incomplete/);
});

test("rooms list display-only mods and refuse a different cartridge", async (t) => {
  assert.deepEqual(
    cleanMods([
      { id: "dans-crew", name: "  Dan's   crew ", hash: "a".repeat(16) },
      { id: "Bad ID", name: "x", hash: "a".repeat(16) },
      { id: "keyless", name: "x", hash: "short", key: "secret" },
    ]),
    [{ id: "dans-crew", name: "Dan's crew", hash: "a".repeat(16) }],
  );
  assert.deepEqual(cleanMods("nope"), []);
  const app = createApp({ port: 0 });
  const { port } = await app.ready;
  t.after(() => app.close());
  const open = async () => {
    const s = new WebSocket(`ws://127.0.0.1:${port}/room`);
    const queue = [];
    s.on("message", (d, binary) => !binary && queue.push(JSON.parse(d)));
    await once(s, "open");
    const next = async (type) => {
      for (let i = 0; i < 100; i++) {
        const found = queue.findIndex((m) => m.type === type);
        if (found >= 0) return queue.splice(found, 1)[0];
        await new Promise((r) => setTimeout(r, 20));
      }
      throw Error("No " + type);
    };
    return { s, send: (m) => s.send(JSON.stringify(m)), next };
  };
  const mods = [{ id: "dans-crew", name: "Dan's crew", hash: "b".repeat(16) }];
  const host = await open();
  host.send({
    type: "create",
    protocol: PROTOCOL,
    rom: ROM,
    build: "core-smash-native-v8+mods1.0123456789ab",
    name: "Dan",
    roomName: "Crew night",
    mods: [{ ...mods[0], key: "never-stored" }],
  });
  const { token } = await host.next("joined");
  const room = (await host.next("room")).room;
  assert.deepEqual(room.mods, mods);
  const listed = await (
    await fetch(`http://127.0.0.1:${port}/api/rooms`)
  ).json();
  assert.deepEqual(listed.rooms[0].mods, mods);
  assert.ok(!JSON.stringify(listed).includes("never-stored"));
  const guest = await open();
  guest.send({
    type: "join",
    token,
    protocol: PROTOCOL,
    rom: ROM,
    build: "core-smash-native-v8",
    name: "Ryker",
  });
  const refused = await guest.next("error");
  assert.match(refused.message, /Dan's crew mods/);
  assert.deepEqual(refused.mods, mods);
  const crew = await open();
  crew.send({
    type: "join",
    token,
    protocol: PROTOCOL,
    rom: ROM,
    build: "core-smash-native-v8+mods1.0123456789ab",
    name: "Friend",
  });
  assert.equal((await crew.next("joined")).token, token);
  for (const c of [host, guest, crew]) c.s.close();
});

test("format 2 packs edit code tables, repair the boot checksum and place RAM data", async () => {
  const { rom, model } = cartridge();
  const { bootChecksum, modMemory } = await import("../public/js/mods.js");
  const code = 0x6d8d8;
  rom.set([0x24, 0x01, 0x00, 0x09], code);
  new DataView(rom.buffer).setUint32(0x10, bootChecksum(rom)[0]);
  new DataView(rom.buffer).setUint32(0x14, bootChecksum(rom)[1]);
  const pack = {
    format: 2,
    id: "test-crew",
    name: "Test crew",
    version: 2,
    rom: ROM,
    mods: [
      {
        id: "uniform",
        name: "Uniform",
        costumeButton: "cl",
        rom: [{ offset: code, expect: "24010009", hex: "2401000a" }],
        memory: [
          {
            address: 0x80600000,
            size: 16,
            chunks: [{ at: 2, hex: "abcd" }],
            copies: [{ at: 0, file: 5, offset: 0, length: 8 }],
          },
        ],
      },
    ],
  };
  validatePack(pack, ROM);
  const patched = await patchCartridge(rom, [pack]);
  assert.deepEqual(
    [...patched.subarray(code, code + 4)],
    [0x24, 0x01, 0x00, 0x0a],
  );
  const [crc1, crc2] = bootChecksum(patched);
  const view = new DataView(patched.buffer);
  assert.equal(
    view.getUint32(0x10),
    crc1,
    "header checksum follows the code edit",
  );
  assert.equal(view.getUint32(0x14), crc2);
  assert.notEqual(crc1, new DataView(rom.buffer).getUint32(0x10));
  const [region] = modMemory(rom, [pack]);
  assert.equal(region.address, 0x80600000);
  // Copy first, then new bytes on top of it.
  assert.deepEqual(
    [...region.bytes.subarray(0, 8)],
    [model[0], model[1], 0xab, 0xcd, ...model.subarray(4, 8)],
  );
  const wrong = structuredClone(pack);
  wrong.mods[0].rom[0].expect = "00000000";
  await assert.rejects(patchCartridge(rom, [wrong]), /does not match/);
  for (const bad of [
    { address: 0x80300000, size: 8, chunks: [], copies: [] },
    { address: 0x807ffff8, size: 16, chunks: [], copies: [] },
  ]) {
    const p = structuredClone(pack);
    p.mods[0].memory = [bad];
    assert.throws(() => validatePack(p, ROM), /memory/);
  }
  const twice = structuredClone(pack);
  twice.id = "other";
  twice.mods[0].rom = [];
  assert.throws(() => modMemory(rom, [pack, twice]), /conflicts/);
  const v1 = structuredClone(pack);
  v1.format = 1;
  assert.throws(() => validatePack(v1, ROM), /no changes/);
  const button = structuredClone(pack);
  button.mods[0].costumeButton = "a";
  assert.throws(() => validatePack(button, ROM), /controls/);
});

test("double tap Up or Down picks the pack's costume once a fighter is chosen", async () => {
  const { CostumeGesture } = await import("../public/js/costume-gesture.js");
  const g = new CostumeGesture();
  const up = { buttons: 0, x: 0, y: 80 },
    rest = { buttons: 0, x: 0, y: 0 },
    css = { scene: 16, selected: true };
  const run = (steps) =>
    steps.map(
      ([input, now, ctx = css]) =>
        g.filter(input, "p", { ...ctx, now }).buttons,
    );
  assert.deepEqual(
    run([
      [up, 0],
      [rest, 50],
      [up, 120],
    ]),
    [0, 0, 0],
    "no pack, no change",
  );
  g.use("cl");
  const out = run([
    [up, 0],
    [rest, 50],
    [up, 120],
    [up, 200],
    [rest, 300],
  ]);
  assert.equal(out[2] & 512, 512, "second Up presses C-left");
  assert.equal(out[3] & 512, 512, "held briefly so the game sees it");
  assert.equal(out[4] & 512, 0);
  g.use("cl");
  assert.equal(
    run([
      [up, 0],
      [rest, 50],
      [up, 900],
    ])[2] & 512,
    0,
    "too slow is two separate presses",
  );
  g.use("cl");
  assert.equal(
    run([
      [up, 0, { scene: 16, selected: false }],
      [rest, 50, { scene: 16, selected: false }],
      [up, 120, { scene: 16, selected: false }],
    ])[2] & 512,
    0,
    "moving the hand while choosing never picks a costume",
  );
  g.use("cl");
  const down = { buttons: 4, x: 0, y: 0 }; // D-pad down
  assert.equal(
    run([
      [down, 0],
      [rest, 40],
      [down, 100],
    ])[2] & 512,
    512,
  );
  g.use("cl");
  assert.equal(
    run([
      [up, 0, { scene: 22, selected: true }],
      [rest, 40, { scene: 22, selected: true }],
      [up, 90, { scene: 22, selected: true }],
    ])[2] & 512,
    0,
    "only on the character screen",
  );
});

test("controls: Left or Right twice presses the metal button only for its fighters", async () => {
  const { CostumeGesture } = await import("../public/js/costume-gesture.js");
  const g = new CostumeGesture();
  const controls = [
    { gesture: "vertical", button: "cl" },
    { gesture: "horizontal", button: "r", fighters: [0, 4] },
  ];
  const rest = { buttons: 0, x: 0, y: 0 };
  const doubleTap = (input, fighter) => {
    g.use(controls);
    return [input, rest, input].map(
      (step, i) =>
        g.filter(step, "p", { scene: 16, selected: true, fighter, now: [0, 50, 120][i] })
          .buttons,
    )[2];
  };
  const left = { buttons: 0, x: -80, y: 0 },
    dpadRight = { buttons: 1, x: 0, y: 0 },
    up = { buttons: 0, x: 0, y: 80 };
  assert.equal(doubleTap(left, 0) & 4096, 4096, "Mario: Left twice presses R");
  assert.equal(doubleTap(dpadRight, 4) & 4096, 4096, "Luigi: D-pad Right twice");
  assert.equal(doubleTap(left, 2), 0, "DK has no metal skin");
  assert.equal(doubleTap(up, 2) & 512, 512, "the uniform still works for everyone");
});

test("controls are validated", () => {
  const base = {
    format: 2,
    id: "c",
    name: "C",
    version: 1,
    rom: ROM,
    mods: [{ id: "m", name: "M", rom: [{ offset: 0x1000, expect: "00", hex: "00" }] }],
  };
  const ok = structuredClone(base);
  ok.mods[0].controls = [{ gesture: "horizontal", button: "r", fighters: [0, 4] }];
  validatePack(ok, ROM);
  for (const controls of [
    [{ gesture: "diagonal", button: "r" }],
    [{ gesture: "vertical", button: "a" }],
    [{ gesture: "horizontal", button: "r", fighters: [12] }],
    "r",
  ]) {
    const bad = structuredClone(base);
    bad.mods[0].controls = controls;
    assert.throws(() => validatePack(bad, ROM), /controls/);
  }
});
