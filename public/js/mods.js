// Mod packs: private cosmetic changes applied to this browser's verified
// cartridge copy before the emulator starts. Packs are published encrypted;
// only people holding an install or invitation link can open them. A room
// runs its host's packs, and the room build includes their signature so the
// server never mixes modded and original simulations.
import { decodeVpk0, encodeVpk0 } from "./vpk0.js";

export const MOD_FORMAT = 1; // encrypted envelope version
// Pack format 2 adds absolute cartridge edits (code tables) and data written
// to the upper 4 MB of RDRAM, which the game never uses (its framebuffers and
// heaps end at 0x80400000; the emulator provides 8 MB).
export const PACK_FORMATS = [1, 2];
export const MOD_MEMORY_START = 0x80400000;
export const MOD_MEMORY_END = 0x80800000;
const ROM_SIZE = 16777216;
// US v1.0 relocatable file table (VetriTheRetri/ssb-decomp-re lbreloc.c).
export const FILE_TABLE = 0x1ac870;
export const FILE_COUNT = 2132;
const FILE_DATA = FILE_TABLE + (FILE_COUNT + 1) * 12;
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const KEY = /^[A-Za-z0-9_-]{43}$/;
const STORE = "smash.mods.v1";
const SESSION = "smash.cartridge.v1";

const text = new TextEncoder();
export const toHex = (bytes) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
export function fromHex(value) {
  if (typeof value !== "string" || !/^(?:[0-9a-f]{2})+$/i.test(value))
    throw Error("A mod contains invalid data.");
  return Uint8Array.from(value.match(/../g), (pair) => parseInt(pair, 16));
}
export function toBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
export function fromBase64Url(value) {
  const binary = atob(
    value.replace(/-/g, "+").replace(/_/g, "/") +
      "===".slice((value.length + 3) % 4),
  );
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}
async function digest(algorithm, bytes) {
  return toHex(new Uint8Array(await crypto.subtle.digest(algorithm, bytes)));
}

export function fileEntry(rom, id) {
  if (!Number.isInteger(id) || id < 0 || id >= FILE_COUNT)
    throw Error("A mod names a game file that does not exist.");
  const view = new DataView(rom.buffer, rom.byteOffset, rom.byteLength);
  const at = FILE_TABLE + id * 12,
    word = view.getUint32(at);
  return {
    compressed: word >>> 31 === 1,
    start: FILE_DATA + (word & 0x7fffffff),
    slot: view.getUint16(at + 6) * 4,
    size: view.getUint16(at + 10) * 4,
  };
}

const plain = (value, max) =>
  typeof value === "string" && value.trim() && value.length <= max;
// Costume controls on the character screen: a double-tap direction presses a
// button the game reads there, optionally only for some fighters (0-11).
export const CONTROL_BUTTONS = ["cu", "cr", "cd", "cl", "r", "l", "z"];
const validControls = (list) =>
  Array.isArray(list) &&
  list.length <= 4 &&
  list.every(
    (c) =>
      ["vertical", "horizontal"].includes(c?.gesture) &&
      CONTROL_BUTTONS.includes(c.button) &&
      (c.fighters === undefined ||
        (Array.isArray(c.fighters) &&
          c.fighters.length <= 12 &&
          c.fighters.every((k) => Number.isInteger(k) && k >= 0 && k < 12))),
  );

export function validatePack(pack, romSha1) {
  if (!pack || !PACK_FORMATS.includes(pack.format) || !ID.test(pack.id || ""))
    throw Error("This mod pack needs a newer version of Smash Portal.");
  if (!plain(pack.name, 60) || !Number.isInteger(pack.version))
    throw Error("This mod pack is incomplete.");
  if (pack.rom !== romSha1)
    throw Error("This mod pack is for a different game.");
  if (!Array.isArray(pack.mods) || !pack.mods.length || pack.mods.length > 32)
    throw Error("This mod pack is incomplete.");
  let bytes = 0,
    memoryBytes = 0;
  for (const mod of pack.mods) {
    if (!ID.test(mod?.id || "") || !plain(mod.name, 80))
      throw Error("A mod in this pack is incomplete.");
    if (mod.summary !== undefined && !plain(mod.summary, 300))
      throw Error("A mod description is too long.");
    if (
      (mod.costumeButton !== undefined &&
        !["cu", "cr", "cd", "cl"].includes(mod.costumeButton)) ||
      (mod.controls !== undefined && !validControls(mod.controls))
    )
      throw Error("A mod in this pack has invalid controls.");
    const patches = mod.patches || [],
      rom = mod.rom || [],
      memory = mod.memory || [];
    if (
      !Array.isArray(patches) ||
      !Array.isArray(rom) ||
      !Array.isArray(memory) ||
      (pack.format === 1 && (rom.length || memory.length)) ||
      !(patches.length + rom.length + memory.length)
    )
      throw Error("A mod in this pack has no changes.");
    for (const edit of rom) {
      const want = fromHex(edit?.expect),
        next = fromHex(edit?.hex);
      if (
        !Number.isInteger(edit.offset) ||
        edit.offset < 0 ||
        want.length !== next.length ||
        next.length > 64 ||
        edit.offset + next.length > ROM_SIZE
      )
        throw Error("A mod in this pack has invalid changes.");
    }
    for (const region of memory) {
      const size = region?.size;
      if (
        !Number.isInteger(region.address) ||
        !Number.isInteger(size) ||
        size <= 0 ||
        region.address < MOD_MEMORY_START ||
        region.address + size > MOD_MEMORY_END ||
        region.address % 8 ||
        !Array.isArray(region.chunks) ||
        !Array.isArray(region.copies)
      )
        throw Error("A mod in this pack uses memory it may not.");
      memoryBytes += size;
      for (const chunk of region.chunks) {
        const length = fromHex(chunk?.hex).length;
        if (
          !Number.isInteger(chunk.at) ||
          chunk.at < 0 ||
          chunk.at + length > size
        )
          throw Error("A mod in this pack uses memory it may not.");
        bytes += length;
      }
      for (const copy of region.copies)
        if (
          !Number.isInteger(copy?.file) ||
          copy.file < 0 ||
          copy.file >= FILE_COUNT ||
          ![copy.at, copy.offset, copy.length].every(
            (n) => Number.isInteger(n) && n >= 0,
          ) ||
          copy.at + copy.length > size
        )
          throw Error("A mod in this pack uses memory it may not.");
    }
    for (const patch of patches) {
      if (
        !Number.isInteger(patch?.file) ||
        patch.file < 0 ||
        patch.file >= FILE_COUNT ||
        !/^[a-f0-9]{40}$/.test(patch.sha1 || "") ||
        !Array.isArray(patch.edits) ||
        !patch.edits.length ||
        patch.edits.length > 1024
      )
        throw Error("A mod in this pack has invalid changes.");
      for (const edit of patch.edits) {
        if (!Number.isInteger(edit?.offset) || edit.offset < 0)
          throw Error("A mod in this pack has invalid changes.");
        bytes += fromHex(edit.hex).length;
      }
    }
  }
  if (bytes > 2097152 || memoryBytes > 4194304)
    throw Error("This mod pack is too large.");
  return pack;
}

export async function sealPack(pack, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const secret = await crypto.subtle.importKey(
    "raw",
    fromBase64Url(key),
    "AES-GCM",
    false,
    ["encrypt"],
  );
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: text.encode(pack.id) },
    secret,
    text.encode(JSON.stringify(pack)),
  );
  return {
    smod: MOD_FORMAT,
    id: pack.id,
    iv: toBase64Url(iv),
    data: toBase64Url(new Uint8Array(data)),
  };
}

export async function openPack(sealed, key, romSha1) {
  if (sealed?.smod !== MOD_FORMAT || !ID.test(sealed.id || ""))
    throw Error("This mod pack needs a newer version of Smash Portal.");
  if (!KEY.test(key || "")) throw Error("That mod link is incomplete.");
  let bytes;
  try {
    const secret = await crypto.subtle.importKey(
      "raw",
      fromBase64Url(key),
      "AES-GCM",
      false,
      ["decrypt"],
    );
    bytes = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: fromBase64Url(sealed.iv),
          additionalData: text.encode(sealed.id),
        },
        secret,
        fromBase64Url(sealed.data),
      ),
    );
  } catch {
    throw Error("That mod link does not open this pack.");
  }
  const pack = validatePack(
    JSON.parse(new TextDecoder().decode(bytes)),
    romSha1,
  );
  if (pack.id !== sealed.id) throw Error("This mod pack is damaged.");
  return { ...pack, key, hash: (await digest("SHA-256", bytes)).slice(0, 16) };
}

// Room builds carry this so only identical cartridges share a simulation.
export async function modsSignature(packs) {
  if (!packs.length) return "";
  const list = packs
    .map((p) => `${p.id}:${p.hash}`)
    .sort()
    .join(",");
  return "+mods1." + (await digest("SHA-256", text.encode(list))).slice(0, 12);
}

export async function patchCartridge(base, packs, romSha1) {
  if (!packs.length) return base;
  const rom = base.slice();
  const files = new Map();
  for (const pack of [...packs].sort((a, b) => a.id.localeCompare(b.id)))
    for (const mod of pack.mods)
      for (const patch of mod.patches || []) {
        const file = files.get(patch.file) || {
          sha1: patch.sha1,
          edits: [],
          names: [],
        };
        if (file.sha1 !== patch.sha1)
          throw Error(`${mod.name} conflicts with another mod.`);
        for (const edit of patch.edits)
          file.edits.push({ offset: edit.offset, bytes: fromHex(edit.hex) });
        file.names.push(mod.name);
        files.set(patch.file, file);
      }
  if (romSha1 && (await digest("SHA-1", base)) !== romSha1)
    throw Error("Mods need the original cartridge.");
  for (const [id, file] of files) {
    const entry = fileEntry(rom, id);
    const slot = rom.subarray(
      entry.start,
      entry.start + (entry.compressed ? entry.slot : entry.size),
    );
    const codec = entry.compressed ? decodeVpk0(slot) : null;
    const original = codec ? codec.data : slot.slice();
    if ((await digest("SHA-1", original)) !== file.sha1)
      throw Error(`${file.names[0]} does not match this cartridge.`);
    const edited = original.slice();
    for (const { offset, bytes } of file.edits) {
      if (offset + bytes.length > edited.length)
        throw Error(`${file.names[0]} changes data outside its game file.`);
      edited.set(bytes, offset);
    }
    if (!codec) {
      slot.set(edited);
      continue;
    }
    const packed = encodeVpk0(edited, codec);
    if (packed.length > slot.length)
      throw Error(`${file.names.join(", ")} is too large for the cartridge.`);
    slot.fill(0);
    slot.set(packed);
    const check = decodeVpk0(slot).data;
    if (check.length !== edited.length || check.some((b, i) => b !== edited[i]))
      throw Error(`${file.names[0]} could not be prepared.`);
  }
  // Absolute edits (code tables, file-table pointer heads), each verified
  // against the original cartridge bytes.
  const written = new Map();
  for (const pack of packs)
    for (const mod of pack.mods)
      for (const edit of mod.rom || []) {
        const want = fromHex(edit.expect),
          next = fromHex(edit.hex);
        if (want.some((b, i) => base[edit.offset + i] !== b))
          throw Error(`${mod.name} does not match this cartridge.`);
        next.forEach((b, i) => {
          const at = edit.offset + i;
          if (written.has(at) && written.get(at) !== b)
            throw Error(`${mod.name} conflicts with another mod.`);
          written.set(at, b);
          rom[at] = b;
        });
      }
  // The boot chip refuses a cartridge whose first megabyte (after 0x1000)
  // no longer matches the header checksum, so recompute it when needed.
  if ([...written.keys()].some((at) => at >= 0x1000 && at < 0x101000)) {
    const view = new DataView(rom.buffer, rom.byteOffset, rom.byteLength);
    const [crc1, crc2] = bootChecksum(rom);
    view.setUint32(0x10, crc1);
    view.setUint32(0x14, crc2);
  }
  return rom;
}

// CIC-NUS-6103 checksum (Smash 64 US) over 0x1000-0x101000.
export function bootChecksum(rom) {
  const view = new DataView(rom.buffer, rom.byteOffset, rom.byteLength);
  const seed = 0xa3886759;
  let t1 = seed,
    t2 = seed,
    t3 = seed,
    t4 = seed,
    t5 = seed,
    t6 = seed;
  for (let i = 0x1000; i < 0x101000; i += 4) {
    const d = view.getUint32(i);
    if ((t6 + d) >>> 0 < t6) t4 = (t4 + 1) >>> 0;
    t6 = (t6 + d) >>> 0;
    t3 = (t3 ^ d) >>> 0;
    const s = d & 0x1f;
    const r = s ? ((d << s) | (d >>> (32 - s))) >>> 0 : d;
    t5 = (t5 + r) >>> 0;
    t2 = (t2 > d ? t2 ^ r : t2 ^ t6 ^ d) >>> 0;
    t1 = (t1 + ((t5 ^ d) >>> 0)) >>> 0;
  }
  return [((t6 ^ t4) + t3) >>> 0, ((t5 ^ t2) + t1) >>> 0];
}

// Data a pack places in upper RDRAM once the emulator starts. Copies come
// from the player's own original cartridge; packs carry only new bytes.
export function modMemory(base, packs) {
  const files = new Map();
  const original = (id) => {
    if (!files.has(id)) {
      const entry = fileEntry(base, id);
      const slot = base.subarray(
        entry.start,
        entry.start + (entry.compressed ? entry.slot : entry.size),
      );
      files.set(id, entry.compressed ? decodeVpk0(slot).data : slot);
    }
    return files.get(id);
  };
  const regions = [];
  for (const pack of packs)
    for (const mod of pack.mods)
      for (const region of mod.memory || []) {
        const bytes = new Uint8Array(region.size);
        for (const copy of region.copies) {
          const data = original(copy.file);
          if (copy.offset + copy.length > data.length)
            throw Error(`${mod.name} copies data outside its game file.`);
          bytes.set(
            data.subarray(copy.offset, copy.offset + copy.length),
            copy.at,
          );
        }
        // New bytes go on top of copies (e.g. one entry of a copied palette).
        for (const chunk of region.chunks)
          bytes.set(fromHex(chunk.hex), chunk.at);
        for (const other of regions)
          if (
            region.address < other.address + other.bytes.length &&
            other.address < region.address + bytes.length
          )
            throw Error(`${mod.name} conflicts with another mod.`);
        regions.push({ address: region.address, bytes });
      }
  return regions;
}

// "id.key,id.key" from install links and invitations.
export function parseRefs(value) {
  if (!value) return [];
  return decodeURIComponent(value)
    .split(",")
    .map((part) => {
      const [id, key] = part.split(".");
      if (!ID.test(id || "") || !KEY.test(key || ""))
        throw Error("That mod link is incomplete.");
      return { id, key };
    });
}
export const formatRefs = (packs) =>
  packs.map((p) => `${p.id}.${p.key}`).join(",");

function readStore() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) || "{}");
    return Array.isArray(saved.packs) ? saved.packs : [];
  } catch {
    return [];
  }
}
function writeStore(packs) {
  try {
    localStorage.setItem(STORE, JSON.stringify({ packs }));
  } catch {
    throw Error("This browser could not save the mod pack.");
  }
}

export class ModLibrary {
  constructor({ romSha1, fetchSealed }) {
    this.romSha1 = romSha1;
    this.fetchSealed = fetchSealed;
  }
  list() {
    return readStore();
  }
  enabled() {
    return this.list().filter((p) => p.enabled);
  }
  find(id) {
    return this.list().find((p) => p.id === id);
  }
  async open(ref, { refresh = true } = {}) {
    const saved = this.find(ref.id);
    let sealed = saved?.key === ref.key ? saved.sealed : null;
    if (refresh || !sealed)
      try {
        sealed = await this.fetchSealed(ref.id);
      } catch (error) {
        if (!sealed) throw error;
      }
    const pack = await openPack(sealed, ref.key, this.romSha1);
    if (saved && saved.key === ref.key)
      this.remember(pack, sealed, saved.enabled);
    return pack;
  }
  remember(pack, sealed, enabled) {
    const packs = this.list().filter((p) => p.id !== pack.id);
    packs.push({
      id: pack.id,
      key: pack.key,
      enabled,
      name: pack.name,
      version: pack.version,
      hash: pack.hash,
      mods: pack.mods.map((m) => ({
        id: m.id,
        name: m.name,
        summary: m.summary,
      })),
      sealed,
    });
    packs.sort((a, b) => a.name.localeCompare(b.name));
    writeStore(packs);
  }
  async install(ref) {
    const sealed = await this.fetchSealed(ref.id);
    const pack = await openPack(sealed, ref.key, this.romSha1);
    this.remember(pack, sealed, true);
    return pack;
  }
  setEnabled(id, enabled) {
    writeStore(this.list().map((p) => (p.id === id ? { ...p, enabled } : p)));
  }
  remove(id) {
    writeStore(this.list().filter((p) => p.id !== id));
  }
}

// A tab keeps its cartridge choice until reload: invitations can run a
// room's mods without installing them, and a later reload restores them.
export function sessionCartridge() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(SESSION) || "null");
    return Array.isArray(saved) ? saved : null;
  } catch {
    return null;
  }
}
export function setSessionCartridge(refs) {
  try {
    if (refs) sessionStorage.setItem(SESSION, JSON.stringify(refs));
    else sessionStorage.removeItem(SESSION);
  } catch {}
}
