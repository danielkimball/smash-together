// Mod pack authoring. Plain packs and their keys stay in .local/mods; only
// the encrypted envelope in public/mods is published.
//
//   node scripts/mods.mjs build .local/mods/<id>.json   (needs SMASH_ROM)
//   node scripts/mods.mjs link <id>
//   node scripts/mods.mjs open public/mods/<id>.json "<install link>"
//   node scripts/mods.mjs preview .local/mods/<id>.json <out.z64>
//
// Authoring edits may use { offset | offsets, hex | rgba | rgba5551 }; build
// normalizes every edit to { offset, hex } and records each file's SHA-1 so a
// pack can only apply to the exact data it was made for.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { root } from "./share.mjs";
import { decodeVpk0 } from "../public/js/vpk0.js";
import {
  fileEntry,
  validatePack,
  sealPack,
  openPack,
  patchCartridge,
  parseRefs,
  toBase64Url,
  toHex,
} from "../public/js/mods.js";

const FRONTEND = "https://danielkimball.github.io/smash-together/";
const ROM_SHA1 = "e2929e10fccc0aa84e5776227e798abc07cedabf"; // engine.js
const keyDir = path.join(root, ".local/mods");
const [command, ...args] = process.argv.slice(2);

async function cartridge() {
  const file = process.env.SMASH_ROM;
  if (!file) throw Error("Set SMASH_ROM to your original US cartridge.");
  const rom = new Uint8Array(await readFile(file));
  if (createHash("sha1").update(rom).digest("hex") !== ROM_SHA1)
    throw Error("SMASH_ROM is not the supported original US cartridge.");
  return rom;
}
function gameFile(rom, id) {
  const entry = fileEntry(rom, id);
  const slot = rom.subarray(
    entry.start,
    entry.start + (entry.compressed ? entry.slot : entry.size),
  );
  return entry.compressed ? decodeVpk0(slot).data : slot.slice();
}
const number = (value) =>
  typeof value === "string" ? Number.parseInt(value, 16) : value;
function rgb(value) {
  const hex = String(value).replace(/^#/, "");
  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(hex))
    throw Error(`Invalid color ${value}`);
  return hex;
}
function rgba5551(value) {
  const hex = rgb(value);
  const [r, g, b] = [0, 2, 4].map((i) =>
    Math.round((Number.parseInt(hex.slice(i, i + 2), 16) * 31) / 255),
  );
  const alpha = hex.length === 8 && hex.slice(6) === "00" ? 0 : 1;
  return ((r << 11) | (g << 6) | (b << 1) | alpha)
    .toString(16)
    .padStart(4, "0");
}
function normalizeEdit(edit) {
  const offsets = edit.offsets || [edit.offset];
  let hex;
  if (edit.hex) hex = edit.hex.toLowerCase();
  else if (edit.rgba) {
    const value = rgb(edit.rgba);
    hex = (value.length === 6 ? value + "ff" : value).toLowerCase();
  } else if (edit.rgba5551) hex = edit.rgba5551.map(rgba5551).join("");
  else throw Error("Each edit needs hex, rgba or rgba5551.");
  return offsets.map((offset) => ({ offset: number(offset), hex }));
}
async function readPlain(file) {
  const plain = JSON.parse(await readFile(file, "utf8"));
  const rom = await cartridge();
  const pack = {
    format: plain.format,
    id: plain.id,
    name: plain.name,
    version: plain.version,
    rom: ROM_SHA1,
    mods: plain.mods.map((mod) => ({
      id: mod.id,
      name: mod.name,
      ...(mod.summary ? { summary: mod.summary } : {}),
      patches: mod.patches.map((patch) => ({
        file: patch.file,
        sha1: createHash("sha1")
          .update(gameFile(rom, patch.file))
          .digest("hex"),
        edits: patch.edits.flatMap(normalizeEdit),
      })),
    })),
  };
  return { pack: validatePack(pack, ROM_SHA1), rom };
}
async function keyFor(id, create = false) {
  const file = path.join(keyDir, `${id}.key`);
  try {
    return (await readFile(file, "utf8")).trim();
  } catch (error) {
    if (!create) throw Error(`No key for ${id} in .local/mods.`);
    await mkdir(keyDir, { recursive: true });
    const key = toBase64Url(randomBytes(32));
    await writeFile(file, key + "\n", { mode: 0o600 });
    return key;
  }
}
const installLink = (id, key) => `${FRONTEND}#mods=${id}.${key}`;

if (command === "build") {
  const { pack, rom } = await readPlain(args[0]);
  // Prove it fits and round-trips on the real cartridge before publishing.
  const patched = await patchCartridge(rom, [pack], ROM_SHA1);
  const changed = patched.reduce((n, b, i) => n + (b !== rom[i]), 0);
  const key = await keyFor(pack.id, true);
  const sealed = await sealPack(pack, key);
  const opened = await openPack(sealed, key, ROM_SHA1);
  await mkdir(path.join(root, "public/mods"), { recursive: true });
  const out = path.join(root, "public/mods", `${pack.id}.json`);
  await writeFile(out, JSON.stringify(sealed) + "\n");
  console.log(
    JSON.stringify(
      {
        published: path.relative(root, out),
        pack: pack.id,
        version: pack.version,
        hash: opened.hash,
        mods: pack.mods.map((m) => m.name),
        romBytesChanged: changed,
      },
      null,
      2,
    ),
  );
  console.log("Install link (keep private):", installLink(pack.id, key));
} else if (command === "link") {
  console.log(installLink(args[0], await keyFor(args[0])));
} else if (command === "open") {
  const sealed = JSON.parse(await readFile(args[0], "utf8"));
  const ref = parseRefs(new URL(args[1]).hash.match(/mods=([^&]+)/)?.[1])[0];
  const pack = await openPack(sealed, ref.key, ROM_SHA1);
  console.log(JSON.stringify(pack, null, 2));
} else if (command === "preview") {
  // Writes a patched cartridge for local emulator checks. Never commit it.
  const { pack, rom } = await readPlain(args[0]);
  const patched = await patchCartridge(rom, [pack], ROM_SHA1);
  await writeFile(args[1], patched);
  console.log("Wrote", args[1], toHex(patched.subarray(0, 4)));
} else {
  console.log(
    "Usage: node scripts/mods.mjs build|link|open|preview … (see file header)",
  );
  process.exitCode = 1;
}
