// A mod pack can name a costume button (C-left for the crew uniform). Once a
// player's fighter is chosen on the native character screen, pressing Up
// twice or Down twice quickly (stick, D-pad or C) presses that button.
// It filters that player's own sampled input, so online every peer receives
// the same agreed button press; nothing changes without a pack.
import { BITS } from "./controls.js";

const WINDOW = 450,
  HOLD = 140;

export class CostumeGesture {
  constructor() {
    this.button = 0;
    this.players = new Map();
  }
  use(button) {
    this.button = BITS[button] || 0;
    this.players.clear();
  }
  filter(input, key, { scene, selected, now = performance.now() }) {
    if (!this.button || scene !== 16) {
      this.players.delete(key);
      return input;
    }
    const s = this.players.get(key) || { dir: 0, taps: [], until: 0 };
    this.players.set(key, s);
    const b = input.buttons;
    const dir =
      b & (BITS.du | BITS.cu) || input.y > 60
        ? 1
        : b & (BITS.dd | BITS.cd) || input.y < -60
          ? -1
          : 0;
    if (dir && dir !== s.dir && selected) {
      s.taps = s.taps.filter((t) => t.dir === dir && now - t.at < WINDOW);
      s.taps.push({ dir, at: now });
      if (s.taps.length >= 2) {
        s.taps = [];
        s.until = now + HOLD;
      }
    }
    s.dir = dir;
    return now < s.until
      ? { ...input, buttons: input.buttons | this.button }
      : input;
  }
}
