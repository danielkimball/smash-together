// The server fixes one input set per frame. A late controller never holds up
// the other controllers, and no browser independently guesses game state.
export class FrameClock {
  constructor({ slots, delay, emit, now = () => performance.now() }) {
    Object.assign(this, {
      slots,
      delay,
      emit,
      now,
      frame: 0,
      pending: new Map(),
    });
    this.next = now() + 200;
    this.pulses = [];
  }
  pulse(slot, buttons, count = 6) {
    if (this.slots.includes(slot))
      this.pulses.push({
        slot,
        buttons,
        from: this.frame + 2,
        until: this.frame + 2 + count,
      });
  }
  input(slot, frame, input) {
    if (
      !this.slots.includes(slot) ||
      !Number.isSafeInteger(frame) ||
      frame < this.frame ||
      frame > this.frame + 120 ||
      !input ||
      !Number.isInteger(input.buttons) ||
      input.buttons < 0 ||
      input.buttons > 16383 ||
      !Number.isInteger(input.x) ||
      Math.abs(input.x) > 127 ||
      !Number.isInteger(input.y) ||
      Math.abs(input.y) > 127
    )
      return false;
    const row = this.pending.get(frame) || [];
    // First input wins; repeated or conflicting packets cannot rewrite a frame.
    if (!row[slot])
      row[slot] = { buttons: input.buttons, x: input.x, y: input.y };
    this.pending.set(frame, row);
    return true;
  }
  tick() {
    const time = this.now();
    // Do not create a large burst after an OS scheduling hiccup.
    if (time - this.next > 100) this.next = time;
    for (let n = 0; n < 6 && time >= this.next; n++) {
      const row = this.pending.get(this.frame) || [];
      const late =
        this.frame < this.delay ? [] : this.slots.filter((slot) => !row[slot]);
      const inputs = Array.from(
        { length: 4 },
        (_, slot) => row[slot] || { buttons: 0, x: 0, y: 0 },
      );
      for (const pulse of this.pulses)
        if (this.frame >= pulse.from && this.frame < pulse.until)
          inputs[pulse.slot] = {
            ...inputs[pulse.slot],
            buttons: inputs[pulse.slot].buttons | pulse.buttons,
          };
      this.pulses = this.pulses.filter((pulse) => this.frame + 1 < pulse.until);
      this.pending.delete(this.frame);
      this.emit({ frame: this.frame++, inputs, late });
      this.next += 1000 / 60;
    }
  }
}
