// The server fixes one input set per frame. A late controller never holds up
// the other controllers, and no browser independently guesses game state.
const validInput = (input) =>
  input &&
  Number.isInteger(input.buttons) &&
  input.buttons >= 0 &&
  input.buttons <= 16383 &&
  Number.isInteger(input.x) &&
  Math.abs(input.x) <= 127 &&
  Number.isInteger(input.y) &&
  Math.abs(input.y) <= 127;
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
    this.commands = [];
    this.maxLatenessMs = 0;
    this.hiccups = 0;
    this.lateCounts = [0, 0, 0, 0];
    this.latest = new Map();
  }
  // New clients publish current state, not a prediction of a future frame.
  // Keep a short tap even if press/release arrive between the same two ticks.
  inputState(slot, sequence, input) {
    const previous = this.latest.get(slot);
    if (
      !this.slots.includes(slot) ||
      !Number.isSafeInteger(sequence) ||
      sequence < 0 ||
      sequence <= (previous?.sequence ?? -1) ||
      !validInput(input)
    )
      return false;
    this.latest.set(slot, {
      sequence,
      input: { buttons: input.buttons, x: input.x, y: input.y },
      at: this.now(),
      pressed:
        (previous?.pressed || 0) |
        (input.buttons & ~(previous?.input.buttons || 0)),
    });
    return true;
  }
  release(slot) {
    this.latest.delete(slot);
    for (const row of this.pending.values()) delete row[slot];
    this.pulses = this.pulses.filter((pulse) => pulse.slot !== slot);
    this.commands = this.commands.filter(
      (entry) => entry.command.slot !== slot,
    );
  }
  pulse(slot, buttons, count = 6, offset = 2) {
    if (this.slots.includes(slot))
      this.pulses.push({
        slot,
        buttons,
        from: this.frame + offset,
        until: this.frame + offset + count,
      });
  }
  input(slot, frame, input) {
    if (
      !this.slots.includes(slot) ||
      !Number.isSafeInteger(frame) ||
      frame < this.frame ||
      frame > this.frame + 120 ||
      !validInput(input)
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
    this.maxLatenessMs = Math.max(this.maxLatenessMs, time - this.next);
    // Do not create a large burst after an OS scheduling hiccup.
    if (time - this.next > 100) {
      this.hiccups++;
      this.next = time;
    }
    for (let n = 0; n < 6 && time >= this.next; n++) {
      const row = this.pending.get(this.frame) || [];
      const sequences = [-1, -1, -1, -1];
      for (const slot of this.slots) {
        const state = this.latest.get(slot);
        if (!state) continue; // Compatibility with cached, frame-buffered clients.
        // Brief jitter keeps a held stick/button steady. A silent controller
        // releases within 150 ms; it can never hold the other players up.
        if (time - state.at <= 150) {
          row[slot] = {
            ...state.input,
            buttons: state.input.buttons | state.pressed,
          };
          sequences[slot] = state.sequence;
        } else delete row[slot];
        state.pressed = 0;
      }
      const late =
        this.frame < this.delay ? [] : this.slots.filter((slot) => !row[slot]);
      for (const slot of late) this.lateCounts[slot]++;
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
      const commands = this.commands
        .filter((c) => c.at === this.frame)
        .map((c) => c.command);
      this.commands = this.commands.filter((c) => c.at > this.frame);
      this.emit({ frame: this.frame++, inputs, late, commands, sequences });
      this.next += 1000 / 60;
    }
  }
}
