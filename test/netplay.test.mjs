import test from "node:test";
import assert from "node:assert/strict";
import { Netplay } from "../public/js/netplay.js";
test("direct peer input and control packets from an old roster are discarded", () => {
  const n = new Netplay({}, {});
  n.id = "host";
  n.room = {
    hostId: "host",
    match: 1,
    revision: 2,
    members: [
      { id: "host", slot: 0, connected: true },
      { id: "guest", slot: 1, connected: true },
    ],
  };
  n.epoch = 4;
  const packet = {
    type: "input",
    match: 1,
    revision: 1,
    epoch: 4,
    frame: 6,
    input: { buttons: 128, x: 0, y: 0 },
  };
  n.receive("guest", packet);
  assert.equal(n.inputs.size, 0);
  n.receive("guest", { ...packet, revision: 2 });
  assert.equal(n.inputs.get(6)[1].buttons, 128);
  n.running = true;
  n.state = "playing";
  n.receive("guest", { type: "pause", match: 1, revision: 1, epoch: 4 });
  assert.equal(n.running, true);
  n.receive("guest", { type: "pause", match: 1, revision: 2, epoch: 4 });
  assert.equal(n.state, "paused");
});
