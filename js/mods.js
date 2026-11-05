// Mod packs: private cosmetic changes applied to this browser's verified
// cartridge copy before the emulator starts. Packs are published encrypted;
// only people holding an install or invitation link can open them. A room
// runs its host's packs, and the room build includes their signature so the
// server never mixes modded and original simulations.
import { decodeVpk0, encodeVpk0 } from "./vpk0.js";

export const MOD_FORMAT = 1;
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

export function validatePack(pack, romSha1) {
  if (!pack || pack.format !== MOD_FORMAT || !ID.test(pack.id || ""))
    throw Error("This mod pack needs a newer version of Smash Portal.");
  if (!plain(pack.name, 60) || !Number.isInteger(pack.version))
    throw Error("This mod pack is incomplete.");
  if (pack.rom !== romSha1)
    throw Error("This mod pack is for a different game.");
  if (!Array.isArray(pack.mods) || !pack.mods.length || pack.mods.length > 32)
    throw Error("This mod pack is incomplete.");
  let bytes = 0;
  for (const mod of pack.mods) {
    if (!ID.test(mod?.id || "") || !plain(mod.name, 80))
      throw Error("A mod in this pack is incomplete.");
    if (mod.summary !== undefined && !plain(mod.summary, 300))
      throw Error("A mod description is too long.");
    if (!Array.isArray(mod.patches) || !mod.patches.length)
      throw Error("A mod in this pack has no changes.");
    for (const patch of mod.patches) {
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
  if (bytes > 262144) throw Error("This mod pack is too large.");
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
      for (const patch of mod.patches) {
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
  return rom;
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
