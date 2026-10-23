import test from "node:test";
import assert from "node:assert/strict";
import {
  Controls,
  BITS,
  evaluate,
  defaultProfile,
  bindingLabel,
} from "../public/js/controls.js";

function fixture(t, axes = [0, 0, -1, 3.285714]) {
  const pad = {
    id: "USB Gamepad (Vendor: 0079 Product: 0006)",
    index: 0,
    connected: true,
    mapping: "",
    axes,
    buttons: Array.from({ length: 18 }, () => ({ value: 0, pressed: false })),
  };
  const saved = new Map();
  const globals = {
    window: new EventTarget(),
    navigator: { getGamepads: () => [pad] },
    localStorage: {
      getItem: (key) => saved.get(key) ?? null,
      setItem: (key, value) => saved.set(key, String(value)),
    },
  };
  for (const [name, value] of Object.entries(globals)) {
    const before = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() =>
      before
        ? Object.defineProperty(globalThis, name, before)
        : delete globalThis[name],
    );
  }
  const controls = new Controls();
  controls.select("0");
  const button = (index, value) => {
    pad.buttons[index] = { value, pressed: !!value };
    controls.pollCapture();
  };
  return { controls, pad, saved, button };
}

test("resting Windows auxiliary axes cannot block remapping a detected button", async (t) => {
  const { controls, pad, button } = fixture(t);
  controls.beginCapture("a");
  await new Promise((resolve) => setTimeout(resolve, 300));
  controls.pollCapture();
  button(2, 1);
  assert.equal(controls.capture, null);
  assert.deepEqual(controls.profile.map.a, { kind: "button", index: 2 });
  assert.equal(
    controls.profile.map.cd,
    null,
    "A must replace the old yellow C-down action",
  );
  assert.equal(evaluate(controls.profile, pad).buttons, BITS.a);
});

test("a quick button press is captured immediately instead of discarded for 250 ms", (t) => {
  const { controls, button } = fixture(t);
  controls.beginCapture("a");
  button(11, 1);
  button(11, 0);
  assert.equal(controls.capture, null);
  assert.equal(controls.profile.map.a.index, 11);
});

test("reassignment removes duplicate actions, saves, and survives a profile reload", (t) => {
  const { controls, pad, saved } = fixture(t);
  controls.beginCapture("a");
  controls.finishCapture({ kind: "button", index: 2 });
  controls.select("keyboard");
  controls.select("0");
  pad.buttons[2].value = 1;
  assert.equal(evaluate(controls.profile, pad).buttons, BITS.a);
  assert.equal(controls.profile.map.cd, null);
  assert.equal(
    JSON.parse(saved.get("smash.controls.v1"))["usb:0079:0006"].map.a.index,
    2,
  );
});

test("guided button capture waits for release and accepts the very next press", (t) => {
  const { controls, button } = fixture(t);
  controls.beginCapture("a");
  button(2, 1);
  controls.beginCapture("b", { continueSequence: true });
  for (let i = 0; i < 10; i++) controls.pollCapture();
  assert.equal(controls.capture.action, "b");
  assert.equal(controls.capture.armed, false);
  button(2, 0);
  assert.equal(controls.capture.armed, true);
  button(8, 1);
  assert.equal(controls.capture, null);
  assert.equal(controls.profile.map.b.index, 8);
});

test("axis capture preserves one neutral position through consecutive directions", (t) => {
  const { controls, pad } = fixture(t);
  controls.beginCapture("up");
  pad.axes[1] = -1;
  controls.pollCapture();
  assert.equal(controls.capture, null);
  controls.beginCapture("down", { continueSequence: true });
  controls.pollCapture();
  assert.equal(controls.capture.armed, false);
  pad.axes[1] = 0;
  controls.pollCapture();
  pad.axes[1] = 1;
  controls.pollCapture();
  assert.equal(controls.capture, null);
  assert.equal(evaluate(controls.profile, pad).y, -85);
});

test("a raw trigger resting at -1 maps, releases, and does not capture its release as the next action", (t) => {
  const { controls, pad, button } = fixture(t);
  controls.beginCapture("z");
  pad.axes[2] = 1;
  controls.pollCapture();
  assert.equal(controls.capture, null);
  assert.equal(evaluate(controls.profile, pad).buttons, BITS.z);
  controls.beginCapture("r", { continueSequence: true });
  controls.pollCapture();
  assert.equal(controls.capture.armed, false);
  pad.axes[2] = -1;
  controls.pollCapture();
  assert.equal(controls.capture.action, "r");
  assert.equal(evaluate(controls.profile, pad).buttons, 0);
  button(5, 1);
  assert.equal(controls.profile.map.r.index, 5);
});

test("Windows HID hat null state and distinct cardinal/diagonal directions are supported", (t) => {
  const { controls, pad } = fixture(t);
  const neutral = pad.axes[3];
  for (const [action, direction] of [
    ["du", 0],
    ["dr", 2],
    ["dd", 4],
    ["dl", 6],
  ]) {
    pad.axes[3] = neutral;
    controls.beginCapture(action, { continueSequence: action !== "du" });
    controls.pollCapture();
    pad.axes[3] = (direction * 2) / 7 - 1;
    controls.pollCapture();
    assert.equal(controls.capture, null);
    assert.equal(controls.profile.map[action].direction, direction);
  }
  assert.equal(bindingLabel(controls.profile.map.du), "Hat 4 ↑");
  pad.axes[3] = -1;
  assert.equal(evaluate(controls.profile, pad).buttons, BITS.du);
  pad.axes[3] = -5 / 7;
  assert.equal(evaluate(controls.profile, pad).buttons, BITS.du | BITS.dr);
  pad.axes[3] = neutral;
  assert.equal(evaluate(controls.profile, pad).buttons, 0);
});

test("a stick held before setup is ignored until it returns to center", (t) => {
  const { controls, pad } = fixture(t, [1, 0, -1]);
  controls.beginCapture("left");
  controls.pollCapture();
  assert.equal(controls.capture.action, "left");
  pad.axes[0] = 0;
  controls.pollCapture();
  assert.equal(controls.capture.action, "left");
  pad.axes[0] = -1;
  controls.pollCapture();
  assert.equal(controls.capture, null);
  assert.equal(evaluate(controls.profile, pad).x, -85);
});

test("HID hat directions close to the null value still capture independently", (t) => {
  const { controls, pad } = fixture(t, [0, 0, -1, 9 / 7]);
  for (const direction of [6, 7]) {
    pad.axes[3] = 9 / 7;
    controls.beginCapture("dl");
    pad.axes[3] = (direction * 2) / 7 - 1;
    controls.pollCapture();
    assert.equal(controls.capture, null);
    assert.deepEqual(controls.profile.map.dl, {
      kind: "hat",
      index: 3,
      direction,
    });
    assert.equal(evaluate(controls.profile, pad).buttons, BITS.dl);
    pad.axes[3] = 9 / 7;
    assert.equal(evaluate(controls.profile, pad).buttons, 0);
  }
});

test("intentional custom Xbox-style bindings on an N64 adapter are not reset as a legacy preset", (t) => {
  const { controls } = fixture(t);
  controls.profile = defaultProfile("xbox");
  controls.beginCapture("a");
  controls.finishCapture({ kind: "button", index: 0 });
  controls.select("keyboard");
  controls.select("0");
  assert.equal(controls.profile.map.a.index, 0);
  assert.equal(controls.profile.customized, true);
});

test("changing devices cancels capture instead of assigning to another profile", (t) => {
  const { controls } = fixture(t);
  let canceled = false;
  controls.addEventListener("mapped", (event) => {
    canceled = event.detail?.canceled;
  });
  controls.beginCapture("a");
  controls.select("keyboard");
  assert.equal(controls.capture, null);
  assert.equal(canceled, true);
  assert.deepEqual(controls.profile.map.a, { kind: "key", code: "KeyJ" });
});
