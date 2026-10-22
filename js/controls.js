export const ACTIONS = [
  ["a", "A · Attack"],
  ["b", "B · Special"],
  ["z", "Z · Grab"],
  ["r", "R · Shield"],
  ["l", "L"],
  ["start", "Start"],
  ["cu", "C ↑ · Jump"],
  ["cd", "C ↓ · Jump"],
  ["cl", "C ← · Jump"],
  ["cr", "C → · Jump"],
  ["up", "Stick ↑"],
  ["down", "Stick ↓"],
  ["left", "Stick ←"],
  ["right", "Stick →"],
  ["du", "D-pad ↑"],
  ["dd", "D-pad ↓"],
  ["dl", "D-pad ←"],
  ["dr", "D-pad →"],
];
export const BITS = {
  dr: 1,
  dl: 2,
  dd: 4,
  du: 8,
  start: 16,
  z: 32,
  b: 64,
  a: 128,
  cr: 256,
  cl: 512,
  cd: 1024,
  cu: 2048,
  r: 4096,
  l: 8192,
};
const b = (index) => ({ kind: "button", index }),
  axis = (index, sign) => ({ kind: "axis", index, sign }),
  key = (code) => ({ kind: "key", code });
export function controllerKey(id) {
  if (!id || id === "keyboard") return "keyboard";
  const usb =
    id.match(/vendor:\s*([0-9a-f]{4})\s+product:\s*([0-9a-f]{4})/i) ||
    id.match(/^([0-9a-f]{4})-([0-9a-f]{4})-/i);
  return usb
    ? `usb:${usb[1]}:${usb[2]}`.toLowerCase()
    : id.replace(/\s+/g, " ").trim();
}
export function profileKind(id) {
  return id === "keyboard"
    ? "keyboard"
    : controllerKey(id) === "usb:0079:0006"
      ? "n64-usb"
      : "xbox";
}
export function defaultProfile(kind = "xbox") {
  const map =
    kind === "keyboard"
      ? {
          a: key("KeyJ"),
          b: key("KeyK"),
          z: key("KeyL"),
          l: key("KeyU"),
          r: key("KeyO"),
          start: key("Enter"),
          cu: key("KeyI"),
          cd: key("Space"),
          cl: key("Digit1"),
          cr: key("Digit3"),
          up: key("KeyW"),
          down: key("KeyS"),
          left: key("KeyA"),
          right: key("KeyD"),
          du: key("ArrowUp"),
          dd: key("ArrowDown"),
          dl: key("ArrowLeft"),
          dr: key("ArrowRight"),
        }
      : kind === "n64-usb"
        ? {
            a: b(6),
            b: b(8),
            z: b(7),
            r: b(5),
            l: b(4),
            start: b(9),
            cu: b(0),
            cd: b(2),
            cl: b(3),
            cr: b(1),
            up: axis(1, -1),
            down: axis(1, 1),
            left: axis(0, -1),
            right: axis(0, 1),
            du: b(12),
            dd: b(13),
            dl: b(14),
            dr: b(15),
          }
        : {
            a: b(0),
            b: b(2),
            z: b(6),
            l: b(4),
            r: b(5),
            start: b(9),
            cu: b(3),
            cd: b(1),
            cl: axis(2, -1),
            cr: axis(2, 1),
            up: axis(1, -1),
            down: axis(1, 1),
            left: axis(0, -1),
            right: axis(0, 1),
            du: b(12),
            dd: b(13),
            dl: b(14),
            dr: b(15),
          };
  return { map, deadzone: 0.12, range: 1, center: [], invertY: false };
}
export function bindingLabel(binding) {
  if (!binding) return "Not set";
  if (binding.kind === "key")
    return binding.code.replace("Key", "").replace("Digit", "");
  if (binding.kind === "button") return `Button ${binding.index + 1}`;
  return `Axis ${binding.index + 1} ${binding.sign > 0 ? "+" : "−"}`;
}
export function evaluate(profile, pad, keys = new Set()) {
  const read = (name, analog = false) => {
    const bind = profile.map[name];
    if (!bind) return 0;
    if (bind.kind === "key") return keys.has(bind.code) ? 1 : 0;
    if (!pad) return 0;
    if (bind.kind === "button") return pad.buttons[bind.index]?.value || 0;
    let value =
      ((pad.axes[bind.index] || 0) - (profile.center[bind.index] || 0)) *
      bind.sign;
    if (analog)
      value =
        Math.max(0, (value - profile.deadzone) / (1 - profile.deadzone)) *
        profile.range;
    return Math.min(1, Math.max(0, value));
  };
  let buttons = 0;
  for (const [action, bit] of Object.entries(BITS))
    if (read(action) > 0.5) buttons |= bit;
  let x = (read("right", true) - read("left", true)) * 85,
    y = (read("up", true) - read("down", true)) * 85;
  if (profile.invertY) y = -y;
  const len = Math.hypot(x, y);
  if (len > 95) {
    x *= 95 / len;
    y *= 95 / len;
  }
  return { buttons, x: Math.round(x) || 0, y: Math.round(y) || 0 };
}
export class Controls extends EventTarget {
  constructor() {
    super();
    this.keys = new Set();
    this.capture = null;
    this.selected = "keyboard";
    this.saved = {};
    this.blocked = false;
    try {
      this.saved = JSON.parse(
        localStorage.getItem("smash.controls.v1") || "{}",
      );
    } catch {}
    this.profile = this.loadProfile();
    window.addEventListener("keydown", (event) => {
      if (event.target.closest("input,select,textarea")) return;
      if (this.capture) {
        event.preventDefault();
        this.finishCapture(key(event.code));
        return;
      }
      if (
        !this.blocked &&
        Object.values(this.profile.map).some(
          (b) => b?.kind === "key" && b.code === event.code,
        )
      )
        event.preventDefault();
      this.keys.add(event.code);
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));
    window.addEventListener("blur", () => this.keys.clear());
    window.addEventListener("gamepadconnected", () =>
      this.dispatchEvent(new Event("devices")),
    );
    window.addEventListener("gamepaddisconnected", () =>
      this.dispatchEvent(new Event("devices")),
    );
  }
  devices() {
    return [...(navigator.getGamepads?.() || [])].filter(Boolean);
  }
  pad() {
    return this.selected === "keyboard"
      ? null
      : this.devices().find((p) => String(p.index) === this.selected) || null;
  }
  id() {
    return this.selected === "keyboard"
      ? "keyboard"
      : this.pad()?.id || "generic";
  }
  loadProfile() {
    const id = this.id(),
      key = controllerKey(id);
    const saved =
      this.saved[key] ||
      this.saved[id] ||
      Object.entries(this.saved).find(
        ([name]) => controllerKey(name) === key,
      )?.[1];
    // Replace only the old untouched Xbox preset for this N64 adapter.
    const legacyXbox =
      profileKind(id) === "n64-usb" &&
      saved &&
      JSON.stringify(saved.map) === JSON.stringify(defaultProfile("xbox").map);
    return structuredClone(
      saved && !legacyXbox ? saved : defaultProfile(profileKind(id)),
    );
  }
  select(id) {
    this.selected = id;
    this.profile = this.loadProfile();
    this.keys.clear();
  }
  persist() {
    this.saved[this.id()] = structuredClone(this.profile);
    this.saved[controllerKey(this.id())] = structuredClone(this.profile);
    localStorage.setItem("smash.controls.v1", JSON.stringify(this.saved));
    localStorage.setItem("smash.inputChoice", controllerKey(this.id()));
    navigator.storage?.persist?.().catch(() => {});
  }
  sample() {
    if (this.blocked || this.capture) return { buttons: 0, x: 0, y: 0 };
    const input = evaluate(this.profile, this.pad(), this.keys);
    const touch = this.touch?.sample();
    if (touch) {
      input.buttons |= touch.buttons;
      if (touch.analog) {
        input.x = touch.x;
        input.y = touch.y;
      }
    }
    if (
      (input.buttons & (BITS.l | BITS.r | BITS.start)) ===
      (BITS.l | BITS.r | BITS.start)
    )
      return { buttons: 0, x: 0, y: 0 };
    return input;
  }
  sampleOther(pad) {
    return evaluate(
      this.saved[controllerKey(pad.id)] ||
        this.saved[pad.id] ||
        defaultProfile(profileKind(pad.id)),
      pad,
    );
  }
  beginCapture(action) {
    this.keys.clear();
    this.capture = { action, armed: false, started: performance.now() };
  }
  cancelCapture() {
    this.capture = null;
    this.dispatchEvent(new Event("mapped"));
  }
  finishCapture(binding) {
    if (!this.capture) return;
    this.profile.map[this.capture.action] = binding;
    this.capture = null;
    this.persist();
    this.dispatchEvent(new Event("mapped"));
  }
  pollCapture() {
    if (!this.capture || performance.now() - this.capture.started < 250) return;
    const pad = this.pad();
    if (!pad) return;
    const active =
      pad.buttons.some((b) => b.value > 0.55) ||
      pad.axes.some(
        (a, i) => Math.abs(a - (this.profile.center[i] || 0)) > 0.65,
      );
    if (!this.capture.armed) {
      if (!active) this.capture.armed = true;
      return;
    }
    for (let i = 0; i < pad.buttons.length; i++)
      if (pad.buttons[i].value > 0.55) return this.finishCapture(b(i));
    for (let i = 0; i < pad.axes.length; i++) {
      const v = pad.axes[i] - (this.profile.center[i] || 0);
      if (Math.abs(v) > 0.65) return this.finishCapture(axis(i, Math.sign(v)));
    }
  }
  async calibrate() {
    const samples = [];
    for (let i = 0; i < 25; i++) {
      const p = this.pad();
      if (!p) throw Error("Connect and select a controller first.");
      samples.push([...p.axes]);
      await new Promise((r) => setTimeout(r, 20));
    }
    this.profile.center = samples[0].map(
      (_, i) => samples.reduce((s, a) => s + a[i], 0) / samples.length,
    );
    this.persist();
  }
}
