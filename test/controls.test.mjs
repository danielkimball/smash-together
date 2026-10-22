import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultProfile,
  evaluate,
  BITS,
  controllerKey,
  profileKind,
} from "../public/js/controls.js";
import { normalizeROM } from "../public/js/engine.js";
const gamepad = () => ({
  buttons: Array.from({ length: 17 }, () => ({ value: 0 })),
  axes: [0, 0, 0, 0],
});
test("DragonRise 0079:0006 preset follows Dan's N64 buttons without Xbox substitutions", () => {
  const id =
    "Generic   USB  Joystick   (STANDARD GAMEPAD Vendor: 0079 Product: 0006)";
  assert.equal(controllerKey(id), "usb:0079:0006");
  assert.equal(
    controllerKey("0079-0006-Generic USB Joystick"),
    controllerKey(id),
  );
  assert.equal(profileKind(id), "n64-usb");
  const profile = defaultProfile(profileKind(id)),
    pad = gamepad();
  for (const [index, bit] of [
    [6, BITS.a],
    [8, BITS.b],
    [7, BITS.z],
    [5, BITS.r],
    [4, BITS.l],
    [9, BITS.start],
    [0, BITS.cu],
    [2, BITS.cd],
    [3, BITS.cl],
    [1, BITS.cr],
    [12, BITS.du],
    [13, BITS.dd],
    [14, BITS.dl],
    [15, BITS.dr],
  ]) {
    pad.buttons[index].value = 1;
    assert.equal(evaluate(profile, pad).buttons, bit);
    pad.buttons[index].value = 0;
  }
  pad.axes = [1, -1, 0.09, 0];
  const input = evaluate(profile, pad);
  assert.ok(input.x > 60 && input.y > 60);
  assert.equal(
    input.buttons,
    0,
    "The unused third axis cannot become a C-button",
  );
});
test("Xbox preset provides attack, special, trigger grab, shield, jump and start", () => {
  const p = gamepad(),
    profile = defaultProfile();
  for (const [button, bit] of [
    [0, BITS.a],
    [2, BITS.b],
    [6, BITS.z],
    [5, BITS.r],
    [9, BITS.start],
    [3, BITS.cu],
  ]) {
    p.buttons[button].value = 1;
    assert.equal(evaluate(profile, p).buttons, bit);
    p.buttons[button].value = 0;
  }
  p.axes = [1, -1, 0, 0];
  const i = evaluate(profile, p);
  assert.ok(i.x > 60 && i.y > 60 && Math.hypot(i.x, i.y) < 96);
});
test("unusual N64 USB mappings can use independent buttons and signed axes", () => {
  const p = gamepad(),
    profile = defaultProfile();
  profile.map.a = { kind: "button", index: 11 };
  profile.map.up = { kind: "axis", index: 3, sign: 1 };
  profile.map.down = { kind: "axis", index: 3, sign: -1 };
  p.buttons[11].value = 1;
  p.axes[3] = 1;
  const i = evaluate(profile, p);
  assert.equal(i.buttons, BITS.a);
  assert.equal(i.y, 85);
});
test("calibration, deadzone, inversion and keyboard prevent drifting", () => {
  const p = gamepad(),
    profile = defaultProfile();
  profile.center = [0.08, -0.03];
  p.axes = [0.09, -0.05, 0, 0];
  assert.deepEqual(evaluate(profile, p), { buttons: 0, x: 0, y: 0 });
  p.axes[1] = -1;
  profile.invertY = true;
  assert.ok(evaluate(profile, p).y < 0);
  const k = evaluate(
    defaultProfile("keyboard"),
    null,
    new Set(["KeyW", "KeyJ", "Enter"]),
  );
  assert.deepEqual(k, { buttons: BITS.a | BITS.start, x: 0, y: 85 });
  assert.deepEqual(evaluate(profile, null), { buttons: 0, x: 0, y: 0 });
});
test("ROM byte-order normalization supports z64, v64 and n64 without modifying input", () => {
  const z = new Uint8Array(16777216);
  z.set([0x80, 0x37, 0x12, 0x40, 1, 2, 3, 4]);
  const v = z.slice(),
    n = z.slice();
  for (let i = 0; i < v.length; i += 2) [v[i], v[i + 1]] = [v[i + 1], v[i]];
  for (let i = 0; i < n.length; i += 4) {
    [n[i], n[i + 3]] = [n[i + 3], n[i]];
    [n[i + 1], n[i + 2]] = [n[i + 2], n[i + 1]];
  }
  assert.deepEqual(normalizeROM(z.buffer), z);
  assert.deepEqual(normalizeROM(v.buffer), z);
  assert.deepEqual(normalizeROM(n.buffer), z);
  assert.equal(v[0], 0x37);
  assert.throws(() => normalizeROM(new ArrayBuffer(10)), /16 MB/);
});
