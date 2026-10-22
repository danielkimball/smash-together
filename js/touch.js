import { BITS } from "./controls.js";

export class TouchControls {
  constructor(root, controls, { menu, wake }) {
    this.root = root;
    this.controls = controls;
    this.pointers = new Map();
    this.stick = root.querySelector(".touch-stick");
    this.thumb = root.querySelector(".stick-thumb");
    this.axis = { x: 0, y: 0 };
    this.enabled = false;
    this.media = matchMedia("(any-pointer: coarse)");
    try {
      this.mode = localStorage.getItem("smash.touch") || "auto";
    } catch {}
    this.media.addEventListener("change", () => this.refresh());
    root.addEventListener("contextmenu", (event) => event.preventDefault());
    root.addEventListener("pointerdown", (event) => {
      const target = event.target.closest("button[data-touch], .touch-stick");
      if (!target || controls.blocked || !this.enabled) return;
      event.preventDefault();
      wake();
      if (target === this.stick && this.stickPointer !== undefined) return;
      target.setPointerCapture(event.pointerId);
      this.pointers.set(event.pointerId, {
        target,
        action: target.dataset.touch,
      });
      if (target === this.stick) this.stickPointer = event.pointerId;
      this.move(event);
    });
    root.addEventListener("pointermove", (event) => this.move(event));
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"])
      root.addEventListener(type, (event) => this.release(event.pointerId));
    root.querySelector(".touch-menu").onclick = () => {
      this.reset();
      menu();
    };
    window.addEventListener("blur", () => this.reset());
    window.addEventListener("resize", () => this.reset());
    document.addEventListener("visibilitychange", () => this.reset());
    this.refresh();
  }
  refresh() {
    this.enabled =
      this.mode === "on" ||
      (this.mode !== "off" &&
        this.media.matches &&
        !this.controls.devices().length);
    document.body.dataset.touch = this.enabled ? "on" : "off";
    this.root.hidden = !this.enabled;
    if (!this.enabled) this.reset();
    for (const button of document.querySelectorAll("[data-touch-toggle]")) {
      button.textContent = this.enabled ? "Hide controls" : "Touch controls";
      button.setAttribute("aria-pressed", String(this.enabled));
    }
  }
  setMode(mode) {
    this.mode = mode;
    try {
      localStorage.setItem("smash.touch", mode);
    } catch {}
    this.refresh();
  }
  move(event) {
    const pointer = this.pointers.get(event.pointerId);
    if (!pointer) return;
    event.preventDefault();
    if (this.controls.blocked) return this.reset();
    if (event.pointerId === this.stickPointer) {
      const box = this.stick.getBoundingClientRect();
      let x = (event.clientX - box.left - box.width / 2) / (box.width * 0.34);
      let y = (box.top + box.height / 2 - event.clientY) / (box.height * 0.34);
      const length = Math.hypot(x, y);
      if (length < 0.08) x = y = 0;
      else if (length > 1) {
        x /= length;
        y /= length;
      }
      this.axis = { x: Math.round(x * 85), y: Math.round(y * 85) };
      this.thumb.style.transform = `translate(${x * 27}%, ${-y * 27}%)`;
    } else {
      const over = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest("button[data-touch]");
      pointer.action =
        over && this.root.contains(over) ? over.dataset.touch : undefined;
    }
    this.paint();
  }
  release(id) {
    if (!this.pointers.delete(id)) return;
    if (id === this.stickPointer) {
      this.stickPointer = undefined;
      this.axis = { x: 0, y: 0 };
      this.thumb.style.transform = "";
    }
    this.paint();
  }
  reset() {
    this.pointers.clear();
    this.stickPointer = undefined;
    this.axis = { x: 0, y: 0 };
    this.thumb.style.transform = "";
    this.paint();
  }
  paint() {
    const actions = new Set([...this.pointers.values()].map((p) => p.action));
    for (const button of this.root.querySelectorAll("[data-touch]"))
      button.setAttribute(
        "aria-pressed",
        String(actions.has(button.dataset.touch)),
      );
    this.stick.classList.toggle("pressed", this.stickPointer !== undefined);
  }
  sample() {
    let buttons = 0;
    for (const pointer of this.pointers.values())
      buttons |= BITS[pointer.action] || 0;
    return { buttons, ...this.axis, analog: this.stickPointer !== undefined };
  }
}
