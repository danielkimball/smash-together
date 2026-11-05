// VPK0 is the LZ + Huffman compression Super Smash Bros. uses for most of its
// relocatable data files. decodeVpk0 follows the game's own decoder
// (VetriTheRetri/ssb-decomp-re, src/sys/dma.c syDmaDecodeVpk0). encodeVpk0
// re-packs an edited file with the original stream's Huffman trees and an
// optimal parse, so lightly edited data fits back into its original ROM slot.
// Both run only while a mod pack prepares a cartridge, never per frame.

class BitReader {
  constructor(bytes, bit) {
    this.bytes = bytes;
    this.bit = bit;
  }
  read(n) {
    let value = 0;
    for (let i = 0; i < n; i++, this.bit++) {
      const byte = this.bytes[this.bit >> 3];
      if (byte === undefined) throw Error("Compressed game file ended early.");
      value = value * 2 + ((byte >> (7 - (this.bit & 7))) & 1);
    }
    return value;
  }
}

class BitWriter {
  constructor(capacity) {
    this.bytes = new Uint8Array(capacity);
    this.bit = 0;
  }
  write(value, n) {
    for (let i = n - 1; i >= 0; i--, this.bit++) {
      if (this.bit >> 3 >= this.bytes.length) {
        const grown = new Uint8Array(this.bytes.length * 2);
        grown.set(this.bytes);
        this.bytes = grown;
      }
      if (Math.floor(value / 2 ** i) % 2)
        this.bytes[this.bit >> 3] |= 0x80 >> (this.bit & 7);
    }
  }
  finish() {
    // The game reads the stream as big-endian 16-bit words.
    const bytes = Math.ceil(this.bit / 16) * 2;
    return this.bytes.slice(0, bytes);
  }
}

function readTree(reader) {
  const stack = [];
  for (;;) {
    if (reader.read(1)) {
      // A branch with fewer than two pending nodes ends the tree.
      if (stack.length < 2) break;
      const right = stack.pop(),
        left = stack.pop();
      stack.push([left, right]);
    } else stack.push(reader.read(8));
  }
  return stack[0] ?? null;
}

function treeValue(reader, tree) {
  if (tree === null) throw Error("Compressed game file has no code tree.");
  while (Array.isArray(tree)) tree = reader.read(1) ? tree[1] : tree[0];
  return reader.read(tree);
}

export function decodeVpk0(bytes) {
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== "vpk0")
    throw Error("Not a compressed game file.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size = view.getUint32(4);
  const reader = new BitReader(bytes, 64);
  const method = reader.read(8);
  const offsets = readTree(reader),
    lengths = readTree(reader);
  const data = new Uint8Array(size);
  let at = 0;
  while (at < size) {
    if (!reader.read(1)) {
      data[at++] = reader.read(8);
      continue;
    }
    let distance;
    if (method) {
      let value = treeValue(reader, offsets),
        extra = 0;
      if (value <= 2) {
        extra = value + 1;
        value = treeValue(reader, offsets);
      }
      distance = value * 4 + extra - 8;
    } else distance = treeValue(reader, offsets);
    const count = treeValue(reader, lengths);
    let from = at - distance;
    if (distance <= 0 || from < 0 || at + count > size)
      throw Error("Compressed game file is damaged.");
    for (let i = 0; i < count; i++) data[at++] = data[from++];
  }
  return { data, method, offsets, lengths, bits: reader.bit };
}

function codes(tree, prefix = 0, depth = 0, out = new Map()) {
  if (tree === null) return out;
  if (Array.isArray(tree)) {
    codes(tree[0], prefix * 2, depth + 1, out);
    codes(tree[1], prefix * 2 + 1, depth + 1, out);
  } else if (!out.has(tree) || out.get(tree).length > depth)
    out.set(tree, { code: prefix, length: depth });
  return out;
}

// The decoder reads at most 16 bits at once, and a zero-width read is
// undefined on the console, so only widths 1..16 encode a value.
function valueCoder(tree) {
  const table = codes(tree);
  const best = [];
  for (let need = 0; need <= 16; need++) {
    let choice = null;
    for (const [width, code] of table)
      if (width >= Math.max(1, need) && width <= 16) {
        const cost = code.length + width;
        if (!choice || cost < choice.cost) choice = { width, cost, code };
      }
    best[need] = choice;
  }
  return (value) => {
    const need = value === 0 ? 0 : Math.floor(Math.log2(value)) + 1;
    return need <= 16 ? best[need] : null;
  };
}

function writeTree(writer, tree) {
  const visit = (node) => {
    if (Array.isArray(node)) {
      visit(node[0]);
      visit(node[1]);
      writer.write(1, 1);
    } else {
      writer.write(0, 1);
      writer.write(node, 8);
    }
  };
  if (tree !== null) visit(tree);
  writer.write(1, 1);
}

export function encodeVpk0(data, { method, offsets, lengths }) {
  const offsetValue = valueCoder(offsets),
    lengthValue = valueCoder(lengths);
  const offsetParts = (distance) => {
    if (!method) {
      const one = offsetValue(distance);
      return one && { cost: one.cost, parts: [[one, distance]] };
    }
    if (distance % 4 === 0) {
      const value = (distance + 8) / 4,
        one = offsetValue(value);
      return one && { cost: one.cost, parts: [[one, value]] };
    }
    const extra = distance % 4,
      value = (distance + 8 - extra) / 4,
      first = offsetValue(extra - 1),
      second = offsetValue(value);
    return (
      first &&
      second && {
        cost: first.cost + second.cost,
        parts: [
          [first, extra - 1],
          [second, value],
        ],
      }
    );
  };
  let maxLength = 0;
  for (let n = 1; n < 1 << 16 && lengthValue(n); n = n * 2 + 1) maxLength = n;
  const lengthCost = new Int32Array(maxLength + 1).fill(-1);
  for (let n = 1; n <= maxLength; n++)
    lengthCost[n] = lengthValue(n)?.cost ?? -1;
  const size = data.length;
  const cost = new Float64Array(size + 1).fill(Infinity);
  const choiceDistance = new Int32Array(size + 1),
    choiceLength = new Int32Array(size + 1);
  cost[0] = 0;
  const head = new Int32Array(65536).fill(-1),
    previous = new Int32Array(size).fill(-1);
  const offsetCache = new Map();
  const cachedOffset = (distance) => {
    if (!offsetCache.has(distance))
      offsetCache.set(distance, offsetParts(distance));
    return offsetCache.get(distance);
  };
  const bestByLength = new Float64Array(maxLength + 2),
    distanceByLength = new Int32Array(maxLength + 2);
  for (let i = 0; i < size; i++) {
    const here = cost[i];
    if (here + 9 < cost[i + 1]) {
      cost[i + 1] = here + 9;
      choiceLength[i + 1] = 1;
      choiceDistance[i + 1] = 0;
    }
    if (i + 1 < size) {
      const key = (data[i] << 8) | data[i + 1];
      let longest = 0,
        visited = 0;
      bestByLength.fill(Infinity);
      for (let j = head[key]; j >= 0 && visited < 256; j = previous[j]) {
        visited++;
        const distance = i - j;
        const limit = Math.min(maxLength, size - i);
        let length = 2;
        while (length < limit && data[j + length] === data[i + length])
          length++;
        const offset = cachedOffset(distance);
        if (!offset) continue;
        if (offset.cost < bestByLength[length]) {
          bestByLength[length] = offset.cost;
          distanceByLength[length] = distance;
        }
        if (length > longest) longest = length;
        if (length === maxLength && offset.cost <= bestByLength[maxLength])
          break;
      }
      // Each length can use the cheapest offset reaching at least that far.
      let runCost = Infinity,
        runDistance = 0;
      for (let length = longest; length >= 2; length--) {
        if (bestByLength[length] < runCost) {
          runCost = bestByLength[length];
          runDistance = distanceByLength[length];
        }
        if (lengthCost[length] < 0) continue;
        const total = here + 1 + runCost + lengthCost[length];
        if (total < cost[i + length]) {
          cost[i + length] = total;
          choiceLength[i + length] = length;
          choiceDistance[i + length] = runDistance;
        }
      }
      previous[i] = head[key];
      head[key] = i;
    }
  }
  const tokens = [];
  for (let at = size; at > 0; at -= choiceLength[at])
    tokens.push([choiceDistance[at], choiceLength[at], at - choiceLength[at]]);
  tokens.reverse();
  const writer = new BitWriter(size + 64);
  for (const c of "vpk0") writer.write(c.charCodeAt(0), 8);
  writer.write(size, 32);
  writer.write(method, 8);
  writeTree(writer, offsets);
  writeTree(writer, lengths);
  for (const [distance, length, at] of tokens) {
    if (!distance) {
      writer.write(0, 1);
      writer.write(data[at], 8);
      continue;
    }
    writer.write(1, 1);
    for (const [coder, value] of cachedOffset(distance).parts) {
      writer.write(coder.code.code, coder.code.length);
      writer.write(value, coder.width);
    }
    const coder = lengthValue(length);
    writer.write(coder.code.code, coder.code.length);
    writer.write(length, coder.width);
  }
  return writer.finish();
}
