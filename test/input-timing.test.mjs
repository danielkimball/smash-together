import test from "node:test";
import assert from "node:assert/strict";
import { Netplay } from "../public/js/netplay.js";
import { InputTiming } from "../public/js/input-timing.js";
import { FrameClock } from "../scripts/frame-clock.mjs";

export function simulate({ rtt = 100, stallAt = 10000, stallFor = 2000 } = {}) {
  let time = 0,
    queue = [],
    received = [],
    late = 0;
  const net = new Netplay(
    {
      fps: 60,
      frame() {},
      inspect() {
        return { scene: 22 };
      },
      hash() {
        return "0000000000000000";
      },
      flushAudio() {},
    },
    {
      sample() {
        return { buttons: 128, x: 0, y: 0 };
      },
    },
    { now: () => time },
  );
  Object.assign(net, {
    id: "host",
    player: 0,
    room: {
      hostId: "host",
      timing: "deadline",
      selecting: false,
      match: 1,
      revision: 1,
      members: [{ id: "host", slot: 0, connected: true, ready: true }],
    },
    epoch: 1,
    delay: 4,
    running: true,
    serverFrame: -1,
    lastSample: 3,
    lateInputs: 0,
    next: 200,
    relayRTT: rtt,
  });
  net.rounds.scene = 22;
  const clock = new FrameClock({
    slots: [0, 1],
    delay: 4,
    now: () => time,
    emit: (frame) => {
      if (frame.late.includes(0)) late++;
      queue.push({
        at: time + rtt / 2,
        dir: "down",
        m: { ...frame, epoch: 1, match: 1, revision: 1 },
      });
    },
  });
  net.send = () => {};
  net.sendGame = (m) => {
    if (m.type === "input") queue.push({ at: time + rtt / 2, dir: "up", m });
  };
  const report = [];
  let nextClient = 0,
    nextReport = 0;
  for (time = 0; time < 30000; time += 2) {
    const stalled = time >= stallAt && time < stallAt + stallFor;
    const ready = queue.filter((p) => p.at <= time);
    queue = queue.filter((p) => p.at > time);
    for (const p of ready)
      if (p.dir === "up") clock.input(0, p.m.frame, p.m.input);
      else received.push(p.m);
    if (!stalled) {
      for (const m of received) net.receiveFrame(m);
      received = [];
    }
    // The other controller keeps meeting deadlines throughout the interruption.
    clock.input(1, clock.frame, { buttons: 128, x: 0, y: 0 });
    clock.tick();
    if (!stalled && time >= nextClient) {
      nextClient = time + 1000 / 60;
      for (let j = 0; j < 6; j++) if (!net.tick(time)) break;
    }
    if (time >= nextReport) {
      nextReport += 1000;
      report.push({
        sec: time / 1000,
        buffer: net.personalDelay,
        backlog: net.serverFrame - net.frame + 1,
        late,
      });
    }
  }
  return { report, clock, net };
}

test("short and long guest interruptions recover without permanent input lag or stopping other controllers", () => {
  for (const rtt of [20, 40, 100, 200])
    for (const stallFor of [250, 500, 2000]) {
      const { report, clock, net } = simulate({ rtt, stallFor });
      const normal = Math.max(4, Math.ceil(rtt / (1000 / 60)) + 2);
      for (const p of report.filter((p) => p.sec >= 13)) {
        assert.ok(p.buffer <= normal + 2, JSON.stringify({ rtt, stallFor, p }));
        assert.ok(p.backlog <= 2, JSON.stringify({ rtt, stallFor, p }));
      }
      assert.ok(
        clock.frame >= 1780,
        "server never waits for the slow controller",
      );
      assert.equal(
        clock.lateCounts[1],
        0,
        "healthy controller keeps every deadline",
      );
      assert.ok(net.sentInputs.size < 120, "input history stays bounded");
    }
});

test("one delayed ping cannot inflate the normal input budget, sustained latency is respected", () => {
  let now = 0;
  const timing = new InputTiming(() => now);
  for (const rtt of [36, 38, 40, 39, 37, 1000, 41]) timing.recordRTT(rtt);
  assert.equal(timing.lead(4), 5);
  for (let i = 0; i < 9; i++) timing.recordRTT(180);
  assert.equal(timing.lead(4), 13);
  now = 600;
  timing.feedback(true, 550);
  for (let i = 0; i < 100; i++) timing.feedback(true, 550);
  assert.equal(timing.extra, 1, "burst changes margin only once");
  now = 1700;
  timing.feedback(false, 1650);
  assert.equal(timing.extra, 0);
});

test("start arriving ahead of a snapshot waits for its restoration", () => {
  const n = new Netplay({}, {});
  n.id = "guest";
  n.epoch = 3;
  n.room = {
    hostId: "host",
    match: 1,
    revision: 1,
    members: [
      { id: "host", connected: true },
      { id: "guest", connected: true },
    ],
  };
  let starts = 0;
  n.start = () => starts++;
  n.receive("host", { type: "start", epoch: 3, match: 1, revision: 1 });
  assert.equal(starts, 0);
  assert.equal(n.pendingStart, true);
  n.restoredEpoch = 3;
  n.receive("host", { type: "start", epoch: 3, match: 1, revision: 1 });
  assert.equal(starts, 1);
});

test("a badly delayed guest requests its own snapshot without a group resync", () => {
  let now = 1000;
  const n = new Netplay({}, {}, { now: () => now });
  Object.assign(n, {
    id: "guest",
    player: 1,
    epoch: 1,
    running: true,
    frame: 0,
    serverFrame: -1,
    lateInputs: 0,
    room: {
      hostId: "host",
      selecting: false,
      timing: "deadline",
      match: 1,
      revision: 1,
      members: [
        { id: "host", slot: 0, connected: true },
        { id: "guest", slot: 1, connected: true },
      ],
    },
  });
  const messages = [];
  n.send = (m) => messages.push(m);
  const packet = {
    epoch: 1,
    match: 1,
    revision: 1,
    inputs: Array.from({ length: 4 }, () => ({ buttons: 0, x: 0, y: 0 })),
    late: [],
  };
  for (let frame = 0; frame < 130; frame++)
    n.receiveFrame({ ...packet, frame });
  assert.deepEqual(messages, [{ type: "observe" }]);
  assert.equal(n.running, true);
  assert.equal(n.epoch, 1);
  now = 1200;
  for (let frame = 130; frame < 150; frame++)
    n.receiveFrame({ ...packet, frame });
  assert.equal(messages.length, 1);
});

test("targeted recovery preserves live frames that overtake the snapshot on the game channel", async () => {
  const { compress } = await import("../public/js/netplay.js");
  const hash = "0000000000000000";
  const n = new Netplay(
    {
      module: { _netplay_get_state_size: () => 1 },
      restore() {},
      hash: () => hash,
      flushAudio() {},
    },
    {},
  );
  Object.assign(n, {
    id: "guest",
    player: 1,
    epoch: 1,
    frame: 5,
    running: true,
    room: {
      hostId: "host",
      timing: "deadline",
      match: 1,
      revision: 1,
      members: [
        { id: "host", slot: 0, connected: true },
        { id: "guest", slot: 1, connected: true },
      ],
    },
  });
  const inputs = Array.from({ length: 4 }, () => ({ buttons: 0, x: 0, y: 0 }));
  for (const frame of [10, 11]) n.inputs.set(frame, inputs);
  const header = new TextEncoder().encode(
    JSON.stringify({
      to: "guest",
      frame: 10,
      epoch: 1,
      match: 1,
      revision: 1,
      delay: 4,
      rawSize: 1,
      hash,
    }),
  );
  const packed = await compress(new Uint8Array([0])),
    packet = new Uint8Array(4 + header.length + packed.length);
  new DataView(packet.buffer).setUint32(0, header.length);
  packet.set(header, 4);
  packet.set(packed, 4 + header.length);
  const restoring = n.receiveState(packet.buffer);
  n.receiveFrame({
    epoch: 1,
    match: 1,
    revision: 1,
    frame: 12,
    inputs,
    late: [],
  });
  await restoring;
  assert.equal(n.running, true);
  assert.equal(n.frame, 10);
  for (const frame of [10, 11, 12])
    assert.deepEqual(n.inputs.get(frame), inputs);
});
