import test from "node:test";
import assert from "node:assert/strict";
import { Engine } from "../public/js/engine.js";
test("menu keepalive extends the idle deadline without changing native choices, total ticks or queued audio", () => {
  const e = new Engine(null),
    state = new Uint8Array(0x800000 + 448);
  const data = new DataView(state.buffer);
  state[448 + (0xa4ad0 ^ 3)] = 16;
  data.setInt32(448 + 0x13bdcc, 17990, true);
  data.setInt32(448 + 0x13bdd0, 18000, true);
  e.snapshot = () => state.slice();
  const output = state.slice();
  e.module = {
    HEAPU8: output,
    _netplay_get_state_size: () => output.length,
    _netplay_get_state_buffer: () => 0,
    _netplay_unserialize_state: () => 1,
  };
  let flushes = 0;
  e.flushAudio = () => flushes++;

  e.keepMenuAlive();
  assert.equal(
    new DataView(output.buffer).getInt32(448 + 0x13bdd0, true),
    35990,
  );
  data.setInt32(448 + 0x13bdd0, 35990, true);
  assert.deepEqual(output, state);
  assert.equal(flushes, 0);
  e.restore(state);
  assert.equal(flushes, 1);
});
test("keepalive never restores or edits a battle, results screen or opening", () => {
  const e = new Engine(null),
    state = new Uint8Array(0x800000 + 448);
  e.snapshot = () => state.slice();
  e.restore = () => assert.fail("must not restore this scene");
  for (const scene of [1, 22, 24, 28, 52, 53, 54, 61]) {
    state[448 + (0xa4ad0 ^ 3)] = scene;
    e.keepMenuAlive();
  }
});
