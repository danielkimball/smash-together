// Authoring helpers for Smash 64 mod packs (Node only, never shipped to
// players). Reads the verified US cartridge's relocatable files and their
// pointer chains so generators can compute small, exact edits. Layouts follow
// VetriTheRetri/ssb-decomp-re (lbreloc.c, fttypes.h, objdef.h).
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { decodeVpk0 } from "../public/js/vpk0.js";
import { fileEntry, FILE_TABLE, FILE_COUNT } from "../public/js/mods.js";

export const ROM_SHA1 = "e2929e10fccc0aa84e5776227e798abc07cedabf";
export const COSTUME_TABLE = 0xa7030; // dFTParamCostumeIDs, 8 bytes per fighter
export const FIGHTERS = [
  { kind: 0, name: "Mario", main: 203, model: 296 },
  { kind: 1, name: "Fox", main: 209, model: 313 },
  { kind: 2, name: "Donkey Kong", main: 213, model: 317 },
  { kind: 3, name: "Samus", main: 217, model: 320 },
  { kind: 4, name: "Luigi", main: 221, model: 323 },
  { kind: 5, name: "Link", main: 225, model: 324 },
  { kind: 6, name: "Yoshi", main: 247, model: 338 },
  { kind: 7, name: "Captain Falcon", main: 236, model: 332 },
  { kind: 8, name: "Kirby", main: 229, model: 328 },
  { kind: 9, name: "Pikachu", main: 243, model: 341 },
  { kind: 10, name: "Jigglypuff", main: 233, model: 330 },
  { kind: 11, name: "Ness", main: 239, model: 335 },
];
// FTAttributes is the last 0x348 bytes of each main file.
export const ATTR = {
  size: 0x348,
  commonparts: 0x2d4,
  modelparts: 0x328,
  accesspart: 0x32c,
  textureparts: 0x330,
  sprites: 0x340,
};
export const JOINT_BASE = 4; // fp->joints[4 + DObjDesc index]

export async function loadRom(file) {
  const rom = new Uint8Array(await readFile(file));
  if (createHash("sha1").update(rom).digest("hex") !== ROM_SHA1)
    throw Error("Not the supported original US cartridge.");
  return rom;
}
export const sha1 = (b) => createHash("sha1").update(b).digest("hex");

const u16 = (b, o) => (b[o] << 8) | b[o + 1];
export const u32 = (b, o) =>
  ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
export const f32 = (b, o) =>
  new DataView(b.buffer, b.byteOffset).getFloat32(o, false);
export const s16 = (b, o) => (u16(b, o) << 16) >> 16;

function chain(data, start) {
  const words = [];
  for (let w = start, guard = 0; w !== 0xffff; guard++) {
    if (guard > 65536 || w * 4 + 4 > data.length)
      throw Error("Broken pointer chain");
    const value = u32(data, w * 4);
    words.push({ word: w, target: value & 0xffff, next: value >>> 16 });
    w = value >>> 16;
  }
  return words;
}

const cache = new Map();
export function gameFile(rom, id) {
  if (cache.has(id)) return cache.get(id);
  const entry = fileEntry(rom, id);
  const view = new DataView(rom.buffer, rom.byteOffset);
  const at = FILE_TABLE + id * 12;
  const internHead = view.getUint16(at + 4),
    externHead = view.getUint16(at + 8);
  const slot = rom.subarray(
    entry.start,
    entry.start + (entry.compressed ? entry.slot : entry.size),
  );
  const codec = entry.compressed ? decodeVpk0(slot) : null;
  const data = codec ? codec.data : slot.slice();
  const next =
    id + 1 <= FILE_COUNT
      ? fileEntry(rom, Math.min(id + 1, FILE_COUNT - 1))
      : null;
  const nextStart =
    FILE_TABLE +
    (FILE_COUNT + 1) * 12 +
    (view.getUint32(FILE_TABLE + (id + 1) * 12) & 0x7fffffff);
  const idsStart = entry.start + entry.slot;
  const externIds = [];
  for (let o = idsStart; o + 2 <= nextStart; o += 2)
    externIds.push(u16(rom, o));
  const intern = internHead === 0xffff ? [] : chain(data, internHead);
  const externList = externHead === 0xffff ? [] : chain(data, externHead);
  const file = {
    id,
    data,
    entry,
    internHead,
    externHead,
    intern,
    internAt: new Map(intern.map((r) => [r.word * 4, r.target * 4])),
    extern: externList.map((r, i) => ({ ...r, file: externIds[i] })),
    externIds,
    next,
  };
  file.externAt = new Map(
    file.extern.map((r) => [
      r.word * 4,
      { file: r.file, offset: r.target * 4 },
    ]),
  );
  cache.set(id, file);
  return file;
}
// Resolve a pointer word: { file, offset } or null.
export function pointer(rom, file, offset) {
  if (file.internAt.has(offset))
    return { file: file.id, offset: file.internAt.get(offset) };
  if (file.externAt.has(offset)) return file.externAt.get(offset);
  return null;
}

// Material/costume animation scripts (AObjEvent32 streams).
export const OPS = [
  "End",
  "Jump",
  "Wait",
  "SetValBlock",
  "SetVal",
  "SetValRateBlock",
  "SetValRate",
  "SetTargetRate",
  "SetVal0RateBlock",
  "SetVal0Rate",
  "SetValAfterBlock",
  "SetValAfter",
  "C12",
  "SetInterp",
  "SetAnim",
  "SetFlags",
  "C16",
  "C17",
  "SetExtValAfterBlock",
  "SetExtValAfter",
  "SetExtValBlock",
  "SetExtVal",
  "C22",
  "C23",
];
export function parseScript(data, offset, limit = 512) {
  const commands = [];
  let o = offset;
  while (o < offset + limit) {
    const word = u32(data, o),
      op = word >>> 25,
      flags = (word >>> 15) & 0x3ff,
      payload = word & 0x7fff;
    const tracks = [];
    for (let b = 0; b < 10; b++) if (flags & (1 << b)) tracks.push(b);
    let size = 4;
    if ([3, 4, 8, 9, 10, 11, 18, 19, 20, 21].includes(op))
      size += 4 * tracks.length;
    else if ([5, 6].includes(op)) size += 8 * tracks.length;
    else if (op === 7) size += 4 * tracks.length;
    else if ([1, 14].includes(op)) size += 4;
    else if (op === 22) size += 4 * tracks.length;
    const values = [];
    for (let i = 4; i < size; i += 4) values.push(u32(data, o + i));
    commands.push({
      offset: o,
      op,
      name: OPS[op] || `op${op}`,
      flags,
      tracks,
      payload,
      values,
      size,
    });
    o += size;
    if (op === 0 || op === 1 || op === 14) break;
  }
  return commands;
}
// A costume script steps one value per frame: frame i holds values[i].
export function costumeFrames(commands) {
  const frames = [];
  for (const c of commands) {
    if ([10, 11, 18, 19].includes(c.op)) frames.push(c);
    else if (c.op === 2 || c.op === 0) break;
    else return null;
  }
  if (frames.length < 2) return null;
  const ext = frames[0].op >= 18;
  if (frames.some((c) => c.op >= 18 !== ext)) return null;
  if (frames.some((c) => c.flags !== frames[0].flags)) return null;
  return { ext, tracks: frames[0].tracks, frames };
}

export function dobjDescs(data, offset) {
  const out = [];
  for (let o = offset; ; o += 44) {
    const id = u32(data, o);
    out.push({
      offset: o,
      id,
      dl: o + 4,
      translate: [f32(data, o + 8), f32(data, o + 12), f32(data, o + 16)],
      rotate: [f32(data, o + 20), f32(data, o + 24), f32(data, o + 28)],
      scale: [f32(data, o + 32), f32(data, o + 36), f32(data, o + 40)],
    });
    if (id === 18 || out.length > 64) break;
  }
  return out;
}

// Gather a fighter's model structure (both detail levels).
export function fighter(rom, f) {
  const main = gameFile(rom, f.main),
    model = gameFile(rom, f.model);
  // FTAttributes ends with the skeleton pointer; files pad to 16 bytes after.
  let end = main.data.length - 4;
  while (end > 0 && !main.internAt.has(end)) end -= 4;
  const A = end + 4 - ATTR.size;
  const ptr = (file, off) => pointer(rom, file, off);
  const filesById = (id) => gameFile(rom, id);
  const levels = [];
  const container = ptr(main, A + ATTR.commonparts);
  for (let level = 0; level < 2; level++) {
    const base = container.offset + level * 16;
    const descs = ptr(main, base),
      mobjsubs = ptr(main, base + 4),
      scripts = ptr(main, base + 8);
    if (!descs) continue;
    const descFile = filesById(descs.file);
    const joints = dobjDescs(descFile.data, descs.offset).map((d, i) => {
      const dl = ptr(descFile, d.dl);
      const subsPtr =
        mobjsubs && ptr(filesById(mobjsubs.file), mobjsubs.offset + i * 4);
      const scriptsPtr =
        scripts && ptr(filesById(scripts.file), scripts.offset + i * 4);
      const subs = [];
      if (subsPtr) {
        const sf = filesById(subsPtr.file);
        for (let k = 0; ; k++) {
          const p = ptr(sf, subsPtr.offset + k * 4);
          if (!p) break;
          subs.push({
            ...p,
            slot: { file: sf.id, offset: subsPtr.offset + k * 4 },
          });
        }
      }
      const costume = [];
      if (scriptsPtr) {
        const sf = filesById(scriptsPtr.file);
        for (let k = 0; k < Math.max(subs.length, 1); k++) {
          const p = ptr(sf, scriptsPtr.offset + k * 4);
          costume.push(
            p && {
              ...p,
              slot: { file: sf.id, offset: scriptsPtr.offset + k * 4 },
            },
          );
        }
      }
      return {
        index: i,
        joint: JOINT_BASE + i,
        ...d,
        dlPtr: dl,
        subs,
        costume,
      };
    });
    levels.push({ level, descs, mobjsubs, scripts, joints });
  }
  const tex = ptr(main, A + ATTR.textureparts);
  const head = tex ? main.data[tex.offset] : null;
  const access = ptr(main, A + ATTR.accesspart);
  const sprites = ptr(main, A + ATTR.sprites);
  let stockLuts = null;
  if (sprites) {
    const sf = filesById(sprites.file);
    const arr = ptr(sf, sprites.offset + 4);
    stockLuts = { array: arr, entries: [] };
    if (arr)
      for (let k = 0; k < 8; k++) {
        const p = ptr(filesById(arr.file), arr.offset + k * 4);
        if (!p) break;
        stockLuts.entries.push(p);
      }
  }
  return {
    ...f,
    main,
    model,
    attr: A,
    levels,
    head,
    access,
    sprites,
    stockLuts,
  };
}

// ---- Edits -------------------------------------------------------------

export const hex = (bytes) => Buffer.from(bytes).toString("hex");
export const be32 = (v) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v >>> 0);
  return b;
};
export const be16 = (v) => {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, v);
  return b;
};

// Collects byte edits for one decompressed file, plus the pointer words to
// drop from its internal relocation chain (they become absolute addresses).
export class FileEdits {
  constructor(rom, id) {
    this.rom = rom;
    this.file = gameFile(rom, id);
    this.edits = new Map();
    this.unlink = new Set();
  }
  set(offset, bytes) {
    for (let i = 0; i < bytes.length; i++) this.edits.set(offset + i, bytes[i]);
  }
  word(offset, value) {
    this.set(offset, be32(value));
  }
  // Replace a relocated pointer with an absolute address outside the file.
  absolute(offset, address) {
    if (!this.file.internAt.has(offset))
      throw Error(
        `File ${this.file.id} +${offset.toString(16)} is not a relocated pointer`,
      );
    this.unlink.add(offset / 4);
    this.word(offset, address);
  }
  // Returns { patch, rom } for the pack: file edits and any table-head edit.
  build() {
    const romEdits = [];
    if (this.unlink.size) {
      const kept = this.file.intern.filter((r) => !this.unlink.has(r.word));
      kept.forEach((r, i) => {
        const next = i + 1 < kept.length ? kept[i + 1].word : 0xffff;
        if (next !== r.next) this.set(r.word * 4, be16(next));
      });
      const head = kept.length ? kept[0].word : 0xffff;
      if (head !== this.file.internHead) {
        const at = FILE_TABLE + this.file.id * 12 + 4;
        romEdits.push({
          offset: at,
          expect: hex(this.rom.subarray(at, at + 2)),
          hex: hex(be16(head)),
        });
      }
    }
    const offsets = [...this.edits.keys()].sort((a, b) => a - b);
    const edits = [];
    for (const o of offsets) {
      const last = edits.at(-1);
      if (last && last.offset + last.bytes.length === o)
        last.bytes.push(this.edits.get(o));
      else edits.push({ offset: o, bytes: [this.edits.get(o)] });
    }
    return {
      patch: edits.length && {
        file: this.file.id,
        sha1: sha1(this.file.data),
        edits: edits.map((e) => ({ offset: e.offset, hex: hex(e.bytes) })),
      },
      rom: romEdits,
    };
  }
}

// Upper-RDRAM data: literal bytes plus copies from original game files.
export class Blob {
  constructor(address, size) {
    this.address = address;
    this.size = size;
    this.bytes = new Uint8Array(size);
    this.explicit = new Uint8Array(size);
    this.copies = [];
    this.at = 0;
  }
  align(n = 8) {
    this.at = Math.ceil(this.at / n) * n;
    return this;
  }
  get here() {
    return this.address + this.at;
  }
  reserve(length) {
    if (this.at + length > this.size) throw Error("Blob is full");
    const at = this.at;
    this.at += length;
    return at;
  }
  literal(bytes) {
    const at = this.reserve(bytes.length);
    this.bytes.set(bytes, at);
    this.explicit.fill(1, at, at + bytes.length);
    return this.address + at;
  }
  words(values) {
    const out = new Uint8Array(values.length * 4);
    values.forEach((v, i) => out.set(be32(v), i * 4));
    return this.literal(out);
  }
  copy(file, offset, length) {
    const at = this.reserve(length);
    this.copies.push({ at, file, offset, length });
    return this.address + at;
  }
  // Overwrite part of an earlier region (e.g. patch one word of a copy).
  put(address, bytes) {
    const at = address - this.address;
    this.bytes.set(bytes, at);
    this.explicit.fill(1, at, at + bytes.length);
  }
  // Copies are applied first at runtime, then literal chunks (which may
  // override parts of a copy). Chunks never span copied bytes.
  region() {
    const used = this.at;
    const covered = new Uint8Array(used);
    for (const c of this.copies) covered.fill(1, c.at, c.at + c.length);
    const chunks = [];
    let i = 0;
    while (i < used) {
      if (!this.explicit[i]) {
        i++;
        continue;
      }
      let j = i,
        last = i;
      while (j < used && (this.explicit[j] || (!covered[j] && j - last < 16))) {
        if (this.explicit[j]) last = j;
        j++;
      }
      chunks.push({ at: i, hex: hex(this.bytes.slice(i, last + 1)) });
      i = last + 1;
    }
    return {
      address: this.address,
      size: Math.ceil(used / 8) * 8,
      chunks,
      copies: this.copies,
    };
  }
}

// ---- F3DEX2 display lists ------------------------------------------------

export const gfx = {
  pipeSync: () => [0xe7000000, 0],
  end: () => [0xdf000000, 0],
  call: (address) => [0xde000000, address >>> 0],
  branch: (address) => [0xde010000, address >>> 0],
  textureOff: () => [0xd7000000, 0],
  geometry: (clear, set) => [0xd9000000 | (~clear & 0xffffff), set >>> 0],
  // G_SETOTHERMODE_L alpha compare: 0 none, 1 threshold.
  alphaCompare: (mode) => [0xe2001e01, mode],
  blendColor: (r, g, b, a) => [
    0xf9000000,
    ((r << 24) | (g << 16) | (b << 8) | a) >>> 0,
  ],
  // G_SETOTHERMODE_L render mode (both cycles' blender words OR'd).
  renderMode: (bits) => [0xe200001c, bits >>> 0],
  combine: (w0, w1) => [w0 >>> 0, w1 >>> 0],
  vertex: (address, count, start = 0) => [
    0x01000000 | (count << 12) | ((start + count) << 1),
    address >>> 0,
  ],
  tri2: (a, b, c, d, e, f) => [
    0x06000000 | (a << 17) | (b << 9) | (c << 1),
    (d << 17) | (e << 9) | (f << 1),
  ],
  tri1: (a, b, c) => [0x05000000 | (a << 17) | (b << 9) | (c << 1), 0],
};
export const G_CULL_BACK = 0x400;
// Fighters draw with fog in cycle 1 and AA_ZB_OPA_SURF2, whose alpha comes
// from coverage. Cut-outs need the game's own TEX_EDGE2 (CVG_X_ALPHA) so the
// alpha threshold discards pixels without writing color or depth.
export const RM_FIGHTER_OPA = 0xc4112078;
export const RM_FIGHTER_CUTOUT = 0xc4113078;
// PRIM*SHADE, alpha PRIM; then *ENV (the game's per-fighter shade tint).
export const COMBINE_PRIM_ALPHA = [0xfc327e05, 0xff17f7ff];
// Same color, alpha (1 - PRIM)*ENV: visible exactly when the material hides.
export const COMBINE_INVERSE_ALPHA = [
  (0xfc327e05 & ~0x7e00) | (6 << 12) | (5 << 9),
  (0xff17f7ff & ~0x7e00) | (3 << 12) | (7 << 9),
];
export const dl = (...commands) => commands.flat();

// ---- Costume scripts -----------------------------------------------------

const OP = { valBlock: 10, val: 11, extBlock: 18, ext: 19, wait: 2, end: 0 };
export const cmd = (op, flags, payload) =>
  ((op << 25) | (flags << 15) | (payload & 0x7fff)) >>> 0;
export const floatBits = (v) => {
  const b = new DataView(new ArrayBuffer(4));
  b.setFloat32(0, v);
  return b.getUint32(0);
};

// ---- Geometry ------------------------------------------------------------

function rotation([x, y, z]) {
  const [cx, sx, cy, sy, cz, sz] = [
    Math.cos(x),
    Math.sin(x),
    Math.cos(y),
    Math.sin(y),
    Math.cos(z),
    Math.sin(z),
  ];
  // R = Rz * Ry * Rx (X applied first), row-major.
  return [
    [cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx],
    [sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx],
    [-sy, cy * sx, cy * cx],
  ];
}
const mul = (a, b) =>
  a.map((r) =>
    [0, 1, 2].map((j) => r[0] * b[0][j] + r[1] * b[1][j] + r[2] * b[2][j]),
  );
const apply = (m, v) => m.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
const transpose = (m) => [0, 1, 2].map((i) => [0, 1, 2].map((j) => m[j][i]));

// Bind-pose world rotation/translation of every joint (DObjDesc ids are depths).
export function bindPose(joints) {
  const stack = [];
  return joints.map((j) => {
    const depth = j.id & 0xfff;
    stack.length = depth;
    const parent = stack[depth - 1] || {
      r: [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
      t: [0, 0, 0],
    };
    const r = mul(parent.r, rotation(j.rotate));
    const t = apply(parent.r, j.translate).map((v, i) => v + parent.t[i]);
    const pose = { r, t };
    stack[depth] = pose;
    return pose;
  });
}

// Vertex positions referenced by a display list (follows sub-DL calls).
export function dlVertices(rom, file, offset, seen = new Set()) {
  const out = [];
  for (let o = offset, n = 0; n < 4096; o += 8, n++) {
    const w0 = u32(file.data, o),
      op = w0 >>> 24;
    if (op === 0xdf) break;
    if (op === 0x01) {
      const count = (w0 >>> 12) & 0xff,
        p = pointer(rom, file, o + 4);
      if (p && p.file === file.id)
        for (let k = 0; k < count; k++) {
          const v = p.offset + k * 16;
          out.push([
            s16(file.data, v),
            s16(file.data, v + 2),
            s16(file.data, v + 4),
          ]);
        }
    }
    if (op === 0xde) {
      const p = pointer(rom, file, o + 4);
      if (p && p.file === file.id && !seen.has(p.offset)) {
        seen.add(p.offset);
        out.push(...dlVertices(rom, file, p.offset, seen));
      }
      if ((w0 >>> 16) & 1) break;
    }
  }
  return out;
}

// A Stahlhelm-like dome with a flared skirt, in a joint's local space.
// up/forward are unit vectors in that space; returns F3DEX2 lit vertices
// (16 bytes each, with normals) and triangle index lists per batch.
export function helmetMesh({
  center,
  up,
  forward,
  radius,
  height,
  segments = 14,
}) {
  const norm = (v) => {
    const l = Math.hypot(...v) || 1;
    return v.map((x) => x / l);
  };
  const cross = (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  up = norm(up);
  let side = norm(cross(up, forward));
  const front = norm(cross(side, up));
  const point = (theta, phi, rScale, drop) => {
    // theta around up (0 = front), phi elevation above the brim plane.
    const ring = Math.cos(phi) * radius * rScale;
    const h = Math.sin(phi) * height - drop;
    const dir = front.map(
      (f, i) => f * Math.cos(theta) + side[i] * Math.sin(theta),
    );
    return center.map((c, i) => c + dir[i] * ring + up[i] * h);
  };
  const normalAt = (theta, phi, flare = 0) => {
    const dir = front.map(
      (f, i) => f * Math.cos(theta) + side[i] * Math.sin(theta),
    );
    return norm(
      dir.map(
        (d, i) =>
          (d * Math.cos(phi) * height) / radius +
          up[i] * (Math.sin(phi) - flare),
      ),
    );
  };
  // Rings: elevation (radians), radius scale, extra drop at back (skirt).
  const rings = [
    { phi: (70 * Math.PI) / 180, r: 1, drop: 0 },
    { phi: (42 * Math.PI) / 180, r: 1, drop: 0 },
    { phi: (14 * Math.PI) / 180, r: 1, drop: 0 },
    { phi: 0, r: 1.02, drop: 0, skirt: true },
    { phi: 0, r: 1.2, drop: 0.32, skirt: true, flare: 0.6 },
  ];
  const vertex = (p, n) => {
    const b = new Uint8Array(16),
      v = new DataView(b.buffer);
    p.forEach((x, i) => v.setInt16(i * 2, Math.round(x)));
    n.forEach((x, i) =>
      v.setInt8(12 + i, Math.max(-127, Math.min(127, Math.round(x * 127)))),
    );
    b[15] = 0xff;
    return b;
  };
  const ringVerts = rings.map((ring) =>
    Array.from({ length: segments }, (_, k) => {
      const theta = (2 * Math.PI * k) / segments;
      // Short visor at the front, deeper skirt at the back and sides.
      const back = (1 - Math.cos(theta)) / 2;
      const drop = ring.skirt ? radius * ring.drop * (0.35 + 0.65 * back) : 0;
      return vertex(
        point(theta, ring.phi, ring.r, drop),
        normalAt(theta, ring.phi, ring.flare || 0),
      );
    }),
  );
  const top = vertex(
    center.map((c, i) => c + up[i] * height),
    up,
  );
  // Batches: [vertices, triangles] with indices into that batch.
  const batches = [];
  batches.push({
    verts: [top, ...ringVerts[0]],
    tris: Array.from({ length: segments }, (_, k) => [
      0,
      1 + k,
      1 + ((k + 1) % segments),
    ]),
  });
  for (let r = 0; r + 1 < rings.length; r++) {
    const a = ringVerts[r],
      b = ringVerts[r + 1];
    const tris = [];
    for (let k = 0; k < segments; k++) {
      const k2 = (k + 1) % segments;
      tris.push([k, segments + k, segments + k2], [k, segments + k2, k2]);
    }
    batches.push({ verts: [...a, ...b], tris });
  }
  return batches;
}

// Evaluate a costume script the way setup does (lbCommonAddMObjFor…):
// the material animation is sampled once at time = costume index. Returns
// per-track values for times 0..count-1, or null for unsupported commands.
// Tracks: "m<n>" material (f32 bits) and "e<n>" color (RGBA).
export function sampleScript(commands, count) {
  const events = new Map();
  let T = 0;
  for (const c of commands) {
    const ext = c.op >= 18 && c.op <= 21;
    if ([3, 4, 10, 11, 18, 19, 20, 21].includes(c.op)) {
      const linear = [3, 4, 20, 21].includes(c.op);
      c.tracks.forEach((track, i) => {
        const k = (ext ? "e" : "m") + track;
        if (!events.has(k)) events.set(k, []);
        events
          .get(k)
          .push({ start: T, dur: c.payload, value: c.values[i], linear });
      });
      if ([3, 10, 18, 20].includes(c.op)) T += c.payload;
    } else if (c.op === 2) T += c.payload;
    else if (c.op === 0 || c.op === 1 || c.op === 14) break;
    else return null;
    if (T > 1000) break;
  }
  const lerp = (a, b, t, color) => {
    if (!color) {
      const fa = new DataView(Uint32Array.of(a).buffer).getFloat32(0, true);
      const fb = new DataView(Uint32Array.of(b).buffer).getFloat32(0, true);
      return floatBits(fa + (fb - fa) * t);
    }
    let out = 0;
    for (let s = 24; s >= 0; s -= 8) {
      const ca = (a >>> s) & 255,
        cb = (b >>> s) & 255;
      out |= Math.round(ca + (cb - ca) * t) << s;
    }
    return out >>> 0;
  };
  const tracks = new Map();
  for (const [k, list] of events) {
    const color = k[0] === "e";
    const values = [];
    for (let t = 0; t < count; t++) {
      let base = null,
        value = null;
      for (const e of list) {
        if (e.start > t) break;
        const prev = value ?? base ?? e.value;
        base = prev;
        if (e.linear)
          value = e.dur
            ? lerp(prev, e.value, Math.min(1, (t - e.start) / e.dur), color)
            : e.value;
        else value = t >= e.start + e.dur ? e.value : prev;
        // a pending step keeps the previous value until it lands
        base = prev;
      }
      values.push(value);
    }
    tracks.set(k, values);
  }
  return tracks;
}

// ---- Draw-order analysis -------------------------------------------------

// Flatten a display list, following calls into other display lists (not the
// per-material segment 0x0E calls). Commands keep their source location so
// pointer words can be resolved.
export function flattenDL(rom, fileId, offset, out = []) {
  const file = gameFile(rom, fileId);
  for (let o = offset, n = 0; n < 4096; o += 8, n++) {
    const w0 = u32(file.data, o),
      w1 = u32(file.data, o + 4),
      op = w0 >>> 24;
    if (op === 0xde && w1 >>> 24 !== 0x0e) {
      const p = pointer(rom, file, o + 4);
      if (!p) throw Error(`Unresolved call in ${fileId}+${o.toString(16)}`);
      flattenDL(rom, p.file, p.offset, out);
      if ((w0 >>> 16) & 1) return out;
      continue;
    }
    if (op === 0xdf) return out;
    out.push({ w0, w1, op, file: fileId, offset: o, ptr: pointer(rom, file, o + 4) });
  }
  throw Error("Display list too long");
}
// Vertex-buffer slots a display list reads before loading them (inherited
// from the previous joint, as the game's smooth joints do) and slots it loads.
export function slotUse(cmds) {
  const reads = new Set(),
    writes = new Set();
  const read = (s) => {
    if (!writes.has(s)) reads.add(s);
  };
  for (const c of cmds) {
    if (c.op === 0x01) {
      const n = (c.w0 >>> 12) & 0xff,
        end = (c.w0 >>> 1) & 0x7f;
      for (let s = end - n; s < end; s++) writes.add(s);
    } else if (c.op === 0x05 || c.op === 0x06 || c.op === 0x07) {
      [16, 8, 0].forEach((b) => read(((c.w0 >>> b) & 0xff) / 2));
      if (c.op !== 0x05) [16, 8, 0].forEach((b) => read(((c.w1 >>> b) & 0xff) / 2));
    }
  }
  return { reads, writes };
}
// Model-part alternatives per joint index (FTModelPartContainer): each
// descriptor holds [id][detail] parts of 20 bytes {dl, mobjsubs, costume
// script, main script, flags}; ids run until the next known structure.
export function modelParts(rom, F) {
  const c = pointer(rom, F.main, F.attr + ATTR.modelparts);
  if (!c) return new Map();
  const cf = gameFile(rom, c.file);
  const joints = F.levels[0].joints.filter((j) => j.id !== 18).length;
  const descs = [];
  for (let i = 0; i < joints; i++) {
    const p = pointer(rom, cf, c.offset + 4 * i);
    if (p) descs.push({ index: i, ...p });
  }
  const bounds = (file) => {
    const f = gameFile(rom, file);
    // starts of every pointed-to structure in that file bound a descriptor
    return [...new Set([...f.internAt.values(), f.data.length, ...(file === c.file ? [c.offset] : [])])].sort((a, b) => a - b);
  };
  const out = new Map();
  for (const d of descs) {
    const b = bounds(d.file);
    const next = b.find((x) => x > d.offset);
    const ids = Math.max(1, Math.floor((next - d.offset) / 40));
    const df = gameFile(rom, d.file);
    const parts = [];
    for (let id = 0; id < ids; id++)
      for (let level = 0; level < 2; level++) {
        const at = d.offset + (id * 2 + level) * 20;
        parts.push({ id, level, at, file: d.file, dl: pointer(rom, df, at), subs: pointer(rom, df, at + 4), costume: pointer(rom, df, at + 8), main: pointer(rom, df, at + 12), flags: df.data[at + 16] });
      }
    out.set(d.index, { ...d, ids, parts });
  }
  return out;
}
// The game draws joints in DObjDesc order; Yoshi-style joints (parts flags 1)
// point at two lists: one before and one after the joint's own matrix.
export function drawSteps(rom, F, level) {
  const c = pointer(rom, F.main, F.attr + ATTR.commonparts);
  const flags = gameFile(rom, c.file).data[c.offset + level * 16 + 12] & 15;
  const parts = modelParts(rom, F);
  const L = F.levels[level];
  const steps = [];
  const lists = (p) => {
    if (!p) return [null, null];
    if (flags !== 1) return [null, p];
    const af = gameFile(rom, p.file);
    return [pointer(rom, af, p.offset), pointer(rom, af, p.offset + 4)];
  };
  for (const j of L.joints) {
    if (j.id === 18) break;
    const variants = [j.dlPtr];
    const mp = parts.get(j.index);
    if (mp)
      for (const part of mp.parts)
        if (part.level === level && part.dl) variants.push(part.dl);
    const pre = [],
      post = [];
    for (const v of variants) {
      const [a, b] = lists(v);
      if (a) pre.push(flattenDL(rom, a.file, a.offset));
      if (b) post.push(flattenDL(rom, b.file, b.offset));
    }
    steps.push({ joint: j.joint, index: j.index, phase: "pre", variants: pre });
    steps.push({ joint: j.joint, index: j.index, phase: "post", variants: post });
  }
  return { flags, steps };
}
// Slots that display lists from step "at" on still expect to find loaded; an
// accessory drawn just before that step must not overwrite them.
export function protectedSlots(steps, at) {
  const out = new Set(),
    rewritten = new Set();
  for (let i = at; i < steps.length; i++) {
    const uses = steps[i].variants.map(slotUse);
    if (!uses.length) continue;
    for (const u of uses) for (const r of u.reads) if (!rewritten.has(r)) out.add(r);
    const always = [...uses[0].writes].filter((w) => uses.every((u) => u.writes.has(w)));
    for (const w of always) rewritten.add(w);
  }
  return out;
}
// Largest contiguous run of unprotected slots: [start, end).
export function freeRun(prot, size = 32) {
  let best = [0, 0];
  for (let a = 0; a < size; a++) {
    if (prot.has(a)) continue;
    let b = a;
    while (b < size && !prot.has(b)) b++;
    if (b - a > best[1] - best[0]) best = [a, b];
    a = b;
  }
  return best;
}
