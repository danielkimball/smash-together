import test from "node:test";
import assert from "node:assert/strict";
import { FrameClock } from "../scripts/frame-clock.mjs";

test("server Start pulse reaches every agreed frame even if the host input packet is late", () => {
  let now = 0;
  const frames = [];
  const clock = new FrameClock({
    slots: [0, 1],
    delay: 4,
    now: () => now,
    emit: (f) => frames.push(f),
  });
  clock.pulse(0, 16);
  for (let frame = 0; frame < 10; frame++) {
    now = 200 + (frame * 1000) / 60 + 0.01;
    clock.tick();
  }
  assert.deepEqual(
    frames.filter((f) => f.inputs[0].buttons & 16).map((f) => f.frame),
    [2, 3, 4, 5, 6, 7],
  );
  assert.ok(frames.every((f) => f.inputs[1].buttons === 0));
});

test("a missing player cannot stall the agreed timeline or rewrite past inputs", () => {
  let now = 0;
  const frames = [];
  const clock = new FrameClock({
    slots: [0, 1],
    delay: 4,
    now: () => now,
    emit: (f) => frames.push(f),
  });
  const attack = { buttons: 128, x: 0, y: 0 };
  for (let frame = 0; frame < 120; frame++) {
    clock.input(0, frame, attack);
    if (frame < 20 || frame > 90) clock.input(1, frame, attack);
    now = 200 + frame * (1000 / 60) + 0.01;
    clock.tick();
  }
  assert.equal(frames.length, 120);
  assert.deepEqual(frames[60].late, [1]);
  assert.equal(frames[60].inputs[0].buttons, 128);
  assert.equal(frames[60].inputs[1].buttons, 0);
  assert.equal(frames[110].inputs[1].buttons, 128);
  assert.equal(clock.input(1, 60, attack), false);
});

test("unassigned slots, huge queues and invalid controller data are rejected", () => {
  const clock = new FrameClock({
    slots: [0],
    delay: 4,
    emit() {},
    now: () => 0,
  });
  const neutral = { buttons: 0, x: 0, y: 0 };
  assert.equal(clock.input(1, 4, neutral), false);
  assert.equal(clock.input(0, 121, neutral), false);
  assert.equal(clock.input(0, 4, { ...neutral, x: Infinity }), false);
  clock.input(0, 4, neutral);
  clock.input(0, 4, { ...neutral, buttons: 128 });
  assert.equal(clock.pending.get(4)[0].buttons, 0);
});

test("latest input reaches the next tick, retains short taps and ignores obsolete packets", () => {
  let time = 200;
  const frames = [];
  const clock = new FrameClock({
    slots: [0],
    delay: 4,
    now: () => time,
    emit: (f) => frames.push(f),
  });
  clock.next = time;
  const idle = { buttons: 0, x: 0, y: 0 };
  assert.equal(clock.inputState(0, 1, { ...idle, buttons: 128 }), true);
  assert.equal(clock.inputState(0, 2, idle), true);
  assert.equal(clock.inputState(0, 1, { ...idle, x: 80 }), false);
  assert.equal(clock.inputState(0, 2, { ...idle, x: 80 }), false);
  assert.equal(clock.inputState(1, 1, idle), false);
  assert.equal(clock.inputState(0, 3, { ...idle, x: Infinity }), false);
  clock.tick();
  assert.equal(
    frames[0].inputs[0].buttons,
    128,
    "tap cannot vanish between ticks",
  );
  assert.equal(frames[0].sequences[0], 2);
  time += 17;
  clock.tick();
  assert.equal(frames[1].inputs[0].buttons, 0, "release on following tick");
  assert.equal(
    frames[0].inputs[0].buttons,
    128,
    "agreed past frames are immutable",
  );
});

test("jitter holds briefly, silent inputs release, and another player keeps moving", () => {
  let time = 0;
  const frames = [];
  const clock = new FrameClock({
    slots: [0, 1],
    delay: 4,
    now: () => time,
    emit: (f) => frames.push(f),
  });
  for (let f = 0; f < 120; f++) {
    time = 200 + (f * 1000) / 60 + 0.01;
    clock.inputState(0, f, { buttons: 128, x: 80, y: 0 });
    if (f < 10 || f > 80) clock.inputState(1, f, { buttons: 64, x: -80, y: 0 });
    clock.tick();
  }
  assert.equal(frames.length, 120);
  assert.equal(frames[14].inputs[1].buttons, 64);
  assert.equal(frames[20].inputs[1].buttons, 0);
  assert.equal(frames[20].inputs[1].x, 0);
  assert.deepEqual(frames[20].late, [1]);
  assert.ok(frames.every((f) => f.inputs[0].x === 80));
  assert.equal(frames[90].inputs[1].buttons, 64);
  clock.release(1);
  assert.equal(
    clock.inputState(1, 0, { buttons: 0, x: 0, y: 0 }),
    true,
    "rejoined session can restart sequence",
  );
});
