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
