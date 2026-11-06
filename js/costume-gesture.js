// A mod pack can name costume controls: a button the game reads on the native
// character screen (C-left for the crew uniform, R for metal skins). Once a
// player's fighter is chosen, pressing Up twice or Down twice quickly (stick,
// D-pad or C) presses the vertical control's button; Left twice or Right
// twice (stick or D-pad) presses the horizontal one, optionally only for some
// fighters. It filters that player's own sampled input, so online every peer
// receives the same agreed button press; nothing changes without a pack.
import { BITS } from "./controls.js";

const WINDOW = 450,
  HOLD = 140;

export class CostumeGesture {
  constructor() {
    this.controls = [];
    this.players = new Map();
  }
  // A button name (older packs: the vertical gesture) or a list of
  // { gesture: "vertical" | "horizontal", button, fighters? }.
  use(controls) {
    const list =
      typeof controls === "string"
        ? [{ gesture: "vertical", button: controls }]
        : controls || [];
    this.controls = list
      .filter((c) => BITS[c.button])
      .map((c) => ({
        axis: c.gesture === "horizontal" ? "x" : "y",
        bit: BITS[c.button],
        fighters: Array.isArray(c.fighters) ? c.fighters : null,
      }));
    this.players.clear();
  }
  filter(input, key, { scene, selected, fighter, now = performance.now() }) {
    if (!this.controls.length || scene !== 16) {
      this.players.delete(key);
      return input;
    }
    const s = this.players.get(key) || {
      dir: { x: 0, y: 0 },
      taps: { x: [], y: [] },
      until: 0,
      bit: 0,
    };
    this.players.set(key, s);
    const b = input.buttons;
    const dirs = {
      y:
        b & (BITS.du | BITS.cu) || input.y > 60
          ? 1
          : b & (BITS.dd | BITS.cd) || input.y < -60
            ? -1
            : 0,
      x: b & BITS.dr || input.x > 60 ? 1 : b & BITS.dl || input.x < -60 ? -1 : 0,
    };
    for (const axis of ["y", "x"]) {
      const dir = dirs[axis];
      const control = this.controls.find(
        (c) => c.axis === axis && (!c.fighters || c.fighters.includes(fighter)),
      );
      if (dir && dir !== s.dir[axis] && selected && control) {
        const taps = s.taps[axis].filter(
          (t) => t.dir === dir && now - t.at < WINDOW,
        );
        taps.push({ dir, at: now });
        if (taps.length >= 2) {
          s.taps[axis] = [];
          s.until = now + HOLD;
          s.bit = control.bit;
        } else s.taps[axis] = taps;
      }
      s.dir[axis] = dir;
    }
    return now < s.until ? { ...input, buttons: input.buttons | s.bit } : input;
  }
}
