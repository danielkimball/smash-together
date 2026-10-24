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

test("peer inputs cannot override the server's agreed frames", () => {
  const n = new Netplay({}, {});
  n.id = "host";
  n.epoch = 1;
  n.running = true;
  n.serverFrame = -1;
  n.lateInputs = 0;
  n.room = {
    timing: "deadline",
    hostId: "host",
    match: 1,
    revision: 2,
    members: [
      { id: "host", slot: 0, connected: true },
      { id: "guest", slot: 1, connected: true },
    ],
  };
  n.receive("guest", {
    type: "input",
    epoch: 1,
    match: 1,
    revision: 2,
    frame: 0,
    input: { buttons: 128, x: 0, y: 0 },
  });
  assert.equal(n.inputs.size, 0);
  const inputs = Array.from({ length: 4 }, () => ({ buttons: 0, x: 0, y: 0 }));
  n.receiveFrame({ epoch: 1, match: 1, revision: 1, frame: 0, inputs });
  assert.equal(n.inputs.size, 0);
  n.receiveFrame({
    epoch: 1,
    match: 1,
    revision: 2,
    frame: 0,
    inputs,
    late: [1],
  });
  assert.equal(n.inputs.get(0)[1].buttons, 0);
  assert.equal(n.lateInputs, 1);
});

test("local players share one sync participant while publishing independent controller states", () => {
  let now = 0;
  const n = new Netplay({}, {}, { now: () => now });
  n.id = "host";
  n.room = {
    hostId: "host",
    selecting: true,
    inputMode: "latest",
    timing: "deadline",
    match: 1,
    revision: 1,
    members: [
      { id: "host", ownerId: "host", slot: 0, ready: true, connected: true },
      {
        id: "partner",
        ownerId: "host",
        localKey: "second",
        slot: 1,
        ready: true,
        connected: true,
      },
      { id: "guest", ownerId: "guest", slot: 2, ready: true, connected: true },
    ],
  };
  n.player = 0;
  n.running = true;
  n.serverFrame = -1;
  let second = 64;
  n.samplePlayer = (p) => ({
    buttons: p.id === "host" ? 128 : second,
    x: 0,
    y: 0,
  });
  const packets = [];
  n.sendGame = (m) => packets.push(m);
  n.tick((now = 1));
  assert.equal(n.participants.length, 2);
  assert.equal(n.devices.length, 2);
  assert.deepEqual(
    packets.map((p) => [p.playerId || "host", p.input.buttons]),
    [
      ["host", 128],
      ["partner", 64],
    ],
  );
  n.tick((now = 20));
  assert.equal(packets.length, 2);
  second = 0;
  n.tick((now = 21));
  assert.equal(packets.length, 3);
  assert.equal(packets.at(-1).playerId, "partner");
  n.room.members[0].slot = -1;
  second = 32;
  n.tick((now = 22));
  assert.equal(packets.at(-1).input.buttons, 32);
  assert.equal(n.localFighters.length, 1);
});

test("lobby catch-up repairs only the requesting device; a running room does not resume through a new sync", () => {
  const n = new Netplay({}, {});
  n.id = "host";
  n.epoch = 2;
  n.running = true;
  n.room = {
    hostId: "host",
    selecting: true,
    match: 1,
    revision: 1,
    members: [
      { id: "host", slot: 0, connected: true },
      { id: "guest", slot: 1, connected: true },
    ],
  };
  const targeted = [];
  let syncs = 0;
  n.sendObservation = async (id) => targeted.push(id);
  n.synchronize = async () => syncs++;
  n.receive("guest", { type: "resync", epoch: 2, match: 1, revision: 1 });
  n.hashes.set(60, "0000000000000001");
  n.remoteHashes.set(60, new Map([["guest", "0000000000000002"]]));
  n.compare(60);
  n.resume();
  assert.deepEqual(targeted, ["guest", "guest"]);
  assert.equal(syncs, 0);
  assert.equal(n.running, true);
});

test("shared menu pause is limited to actual battles", () => {
  const engine = { info: { scene: 16 } },
    n = new Netplay(engine, {});
  n.id = "host";
  n.room = {
    hostId: "host",
    selecting: true,
    members: [{ id: "host", slot: 0, connected: true }],
  };
  n.running = true;
  const sent = [];
  n.sendGame = (m) => sent.push(m);
  n.pause();
  n.room.selecting = false;
  engine.info.scene = 21;
  n.pause();
  assert.equal(sent.length, 0);
  assert.equal(n.running, true);
  engine.info.scene = 22;
  n.pause();
  assert.equal(n.state, "paused");
  assert.deepEqual(sent, [{ type: "pause" }]);
  // Restoring a snapshot clears the cached scene until the first new frame.
  // Opening setup immediately after Resume must still pause actual combat.
  n.running = true;
  engine.info = null;
  engine.inspect = () => ({ scene: 22 });
  n.rounds.scene = -1;
  n.pause();
  assert.equal(n.running, false);
  assert.equal(sent.length, 2);
});
