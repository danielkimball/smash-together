// MIPS III (R4300) disassembler and small assembler for mod hooks. Node only.
// Supports the integer, branch, load/store and FPU-move instructions that
// short hooks need; anything else throws so mistakes stay loud.
export const REG = ["zero","at","v0","v1","a0","a1","a2","a3","t0","t1","t2","t3","t4","t5","t6","t7","s0","s1","s2","s3","s4","s5","s6","s7","t8","t9","k0","k1","gp","sp","fp","ra"];
const R = (n) => REG[n];
const F = (n) => "f" + n;
const s16 = (v) => (v << 16) >> 16;
const hex = (v) => (v < 0 ? "-0x" + (-v).toString(16) : "0x" + v.toString(16));
export function disasm(word, pc) {
  const op = word >>> 26, rs = (word >>> 21) & 31, rt = (word >>> 16) & 31, rd = (word >>> 11) & 31, sa = (word >>> 6) & 31, fn = word & 63;
  const imm = word & 0xffff, simm = s16(imm), target = (((pc + 4) & 0xf0000000) | ((word & 0x3ffffff) << 2)) >>> 0;
  const br = (pc + 4 + (simm << 2)) >>> 0;
  if (word === 0) return "nop";
  if (op === 0) {
    const n = { 0: "sll", 2: "srl", 3: "sra", 4: "sllv", 6: "srlv", 7: "srav", 8: "jr", 9: "jalr", 12: "syscall", 13: "break", 16: "mfhi", 17: "mthi", 18: "mflo", 19: "mtlo", 20: "dsllv", 22: "dsrlv", 23: "dsrav", 24: "mult", 25: "multu", 26: "div", 27: "divu", 28: "dmult", 29: "dmultu", 30: "ddiv", 31: "ddivu", 32: "add", 33: "addu", 34: "sub", 35: "subu", 36: "and", 37: "or", 38: "xor", 39: "nor", 42: "slt", 43: "sltu", 44: "dadd", 45: "daddu", 46: "dsub", 47: "dsubu", 56: "dsll", 58: "dsrl", 59: "dsra", 60: "dsll32", 62: "dsrl32", 63: "dsra32", 52: "teq" }[fn] || "special" + fn;
    if ([0, 2, 3, 56, 58, 59, 60, 62, 63].includes(fn)) return `${n} ${R(rd)}, ${R(rt)}, ${sa}`;
    if ([4, 6, 7, 20, 22, 23].includes(fn)) return `${n} ${R(rd)}, ${R(rt)}, ${R(rs)}`;
    if (fn === 8) return `jr ${R(rs)}`;
    if (fn === 9) return `jalr ${R(rd)}, ${R(rs)}`;
    if ([16, 18].includes(fn)) return `${n} ${R(rd)}`;
    if ([17, 19].includes(fn)) return `${n} ${R(rs)}`;
    if (fn >= 24 && fn <= 31) return `${n} ${R(rs)}, ${R(rt)}`;
    return `${n} ${R(rd)}, ${R(rs)}, ${R(rt)}`;
  }
  if (op === 1) {
    const n = { 0: "bltz", 1: "bgez", 2: "bltzl", 3: "bgezl", 16: "bltzal", 17: "bgezal" }[rt] || "regimm" + rt;
    return `${n} ${R(rs)}, ${hex(br)}`;
  }
  if (op === 2) return `j ${hex(target)}`;
  if (op === 3) return `jal ${hex(target)}`;
  if ([4, 5, 20, 21].includes(op)) return `${{ 4: "beq", 5: "bne", 20: "beql", 21: "bnel" }[op]} ${R(rs)}, ${R(rt)}, ${hex(br)}`;
  if ([6, 7, 22, 23].includes(op)) return `${{ 6: "blez", 7: "bgtz", 22: "blezl", 23: "bgtzl" }[op]} ${R(rs)}, ${hex(br)}`;
  if (op === 15) return `lui ${R(rt)}, ${hex(imm)}`;
  if ([8, 9, 10, 11, 24, 25].includes(op)) return `${{ 8: "addi", 9: "addiu", 10: "slti", 11: "sltiu", 24: "daddi", 25: "daddiu" }[op]} ${R(rt)}, ${R(rs)}, ${hex(simm)}`;
  if ([12, 13, 14].includes(op)) return `${{ 12: "andi", 13: "ori", 14: "xori" }[op]} ${R(rt)}, ${R(rs)}, ${hex(imm)}`;
  const mem = { 32: "lb", 33: "lh", 34: "lwl", 35: "lw", 36: "lbu", 37: "lhu", 38: "lwr", 39: "lwu", 40: "sb", 41: "sh", 42: "swl", 43: "sw", 46: "swr", 47: "cache", 55: "ld", 63: "sd", 26: "ldl", 27: "ldr", 44: "sdl", 45: "sdr" };
  if (mem[op]) return `${mem[op]} ${R(rt)}, ${hex(simm)}(${R(rs)})`;
  if ([49, 53, 57, 61].includes(op)) return `${{ 49: "lwc1", 53: "ldc1", 57: "swc1", 61: "sdc1" }[op]} ${F(rt)}, ${hex(simm)}(${R(rs)})`;
  if (op === 16) return `cop0 ${hex(word)}`;
  if (op === 17) {
    const fmt = rs, ft = rt, fs = rd, fd = sa;
    if (fmt === 0) return `mfc1 ${R(rt)}, ${F(fs)}`;
    if (fmt === 1) return `dmfc1 ${R(rt)}, ${F(fs)}`;
    if (fmt === 2) return `cfc1 ${R(rt)}, $${fs}`;
    if (fmt === 4) return `mtc1 ${R(rt)}, ${F(fs)}`;
    if (fmt === 5) return `dmtc1 ${R(rt)}, ${F(fs)}`;
    if (fmt === 6) return `ctc1 ${R(rt)}, $${fs}`;
    if (fmt === 8) return `${["bc1f", "bc1t", "bc1fl", "bc1tl"][rt & 3]} ${hex(br)}`;
    const suf = { 16: "s", 17: "d", 20: "w", 21: "l" }[fmt] || "?";
    const fns = { 0: "add", 1: "sub", 2: "mul", 3: "div", 4: "sqrt", 5: "abs", 6: "mov", 7: "neg", 8: "round.l", 9: "trunc.l", 10: "ceil.l", 11: "floor.l", 12: "round.w", 13: "trunc.w", 14: "ceil.w", 15: "floor.w", 32: "cvt.s", 33: "cvt.d", 36: "cvt.w", 37: "cvt.l" };
    if (fn >= 48) return `c.${["f","un","eq","ueq","olt","ult","ole","ule","sf","ngle","seq","ngl","lt","nge","le","ngt"][fn - 48]}.${suf} ${F(fs)}, ${F(ft)}`;
    const n = fns[fn] || "cop1fn" + fn;
    if (fn <= 3) return `${n}.${suf} ${F(fd)}, ${F(fs)}, ${F(ft)}`;
    return `${n}.${suf} ${F(fd)}, ${F(fs)}`;
  }
  return `.word ${hex(word)}`;
}
// ---- assembler (subset) ----
const rn = (r) => { const i = REG.indexOf(r.replace("$", "")); if (i < 0) throw Error("reg " + r); return i; };
const fnum = (f) => +f.replace(/^\$?f/, "");
const num = (v, labels) => {
  v = v.trim();
  if (labels && labels.has(v)) return labels.get(v);
  if (/^%hi\((.+)\)$/.test(v)) { const x = num(RegExp.$1, labels); return ((x >>> 16) + ((x & 0x8000) ? 1 : 0)) & 0xffff; }
  if (/^%lo\((.+)\)$/.test(v)) { const x = num(RegExp.$1, labels); return x & 0xffff; }
  const neg = v.startsWith("-");
  const n = Number(neg ? v.slice(1) : v);
  if (Number.isNaN(n)) throw Error("number " + v);
  return neg ? -n : n;
};
const I = (op, rs, rt, imm) => ((op << 26) | (rs << 21) | (rt << 16) | (imm & 0xffff)) >>> 0;
const Rt = (rs, rt, rd, sa, fn) => ((rs << 21) | (rt << 16) | (rd << 11) | (sa << 6) | fn) >>> 0;
export function assemble(source, origin) {
  const lines = source.split("\n").map((l) => l.replace(/[#;].*$/, "").trim()).filter(Boolean);
  // pass 1: labels
  const labels = new Map();
  let pc = origin;
  const items = [];
  for (const l of lines) {
    const m = l.match(/^([A-Za-z_.][\w.]*):\s*(.*)$/);
    let rest = l;
    if (m) { labels.set(m[1], pc); rest = m[2]; }
    if (!rest) continue;
    if (/^li\s/.test(rest)) { const [r, v] = rest.slice(3).split(",").map((s) => s.trim()); items.push({ pc, text: `lui ${r}, %hi(${v})` }); items.push({ pc: pc + 4, text: `addiu ${r}, ${r}, %lo(${v})` }); pc += 8; continue; }
    if (/^la\s/.test(rest)) { const [r, v] = rest.slice(3).split(",").map((s) => s.trim()); items.push({ pc, text: `lui ${r}, %hi(${v})` }); items.push({ pc: pc + 4, text: `addiu ${r}, ${r}, %lo(${v})` }); pc += 8; continue; }
    items.push({ pc, text: rest }); pc += 4;
  }
  const words = items.map(({ pc, text }) => {
    const [mn, ...a] = text.replace(",", " ").split(/\s+/);
    const args = text.slice(mn.length).split(",").map((s) => s.trim()).filter(Boolean);
    const memArg = (s) => { const m = s.match(/^(.*)\((\$?\w+)\)$/); return [num(m[1] || "0", labels), rn(m[2])]; };
    const branch = (t) => { const d = (num(t, labels) - (pc + 4)) >> 2; if (d < -32768 || d > 32767) throw Error("branch range"); return d; };
    const sop = { addu: 33, subu: 35, and: 36, or: 37, xor: 38, nor: 39, slt: 42, sltu: 43 };
    switch (mn) {
      case "nop": return 0;
      case "lui": return I(15, 0, rn(args[0]), num(args[1], labels));
      case "addiu": return I(9, rn(args[1]), rn(args[0]), num(args[2], labels));
      case "slti": return I(10, rn(args[1]), rn(args[0]), num(args[2], labels));
      case "sltiu": return I(11, rn(args[1]), rn(args[0]), num(args[2], labels));
      case "andi": return I(12, rn(args[1]), rn(args[0]), num(args[2], labels));
      case "ori": return I(13, rn(args[1]), rn(args[0]), num(args[2], labels));
      case "xori": return I(14, rn(args[1]), rn(args[0]), num(args[2], labels));
      case "move": return Rt(rn(args[1]), 0, rn(args[0]), 0, 37);
      case "sll": return Rt(0, rn(args[1]), rn(args[0]), num(args[2]), 0);
      case "srl": return Rt(0, rn(args[1]), rn(args[0]), num(args[2]), 2);
      case "jr": return Rt(rn(args[0]), 0, 0, 0, 8);
      case "jalr": return Rt(rn(args[0]), 0, 31, 0, 9);
      case "j": return ((2 << 26) | ((num(args[0], labels) >>> 2) & 0x3ffffff)) >>> 0;
      case "jal": return ((3 << 26) | ((num(args[0], labels) >>> 2) & 0x3ffffff)) >>> 0;
      case "beq": return I(4, rn(args[0]), rn(args[1]), branch(args[2]));
      case "bne": return I(5, rn(args[0]), rn(args[1]), branch(args[2]));
      case "beqz": return I(4, rn(args[0]), 0, branch(args[1]));
      case "bnez": return I(5, rn(args[0]), 0, branch(args[1]));
      case "b": return I(4, 0, 0, branch(args[0]));
      case "blez": return I(6, rn(args[0]), 0, branch(args[1]));
      case "bgtz": return I(7, rn(args[0]), 0, branch(args[1]));
      case "bltz": return I(1, rn(args[0]), 0, branch(args[1]));
      case "bgez": return I(1, rn(args[0]), 1, branch(args[1]));
      case "lb": case "lh": case "lw": case "lbu": case "lhu": case "sb": case "sh": case "sw": {
        const op = { lb: 32, lh: 33, lw: 35, lbu: 36, lhu: 37, sb: 40, sh: 41, sw: 43 }[mn];
        const [off, base] = memArg(args[1]);
        return I(op, base, rn(args[0]), off);
      }
      case "lwc1": case "swc1": { const [off, base] = memArg(args[1]); return I(mn === "lwc1" ? 49 : 57, base, fnum(args[0]), off); }
      case "mtc1": return ((17 << 26) | (4 << 21) | (rn(args[0]) << 16) | (fnum(args[1]) << 11)) >>> 0;
      case "mfc1": return ((17 << 26) | (0 << 21) | (rn(args[0]) << 16) | (fnum(args[1]) << 11)) >>> 0;
      default:
        if (sop[mn] !== undefined) return Rt(rn(args[1]), rn(args[2]), rn(args[0]), 0, sop[mn]);
        throw Error("asm: " + text);
    }
  });
  return { words, labels, end: pc };
}
