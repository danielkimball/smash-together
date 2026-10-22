import test from "node:test";
import assert from "node:assert/strict";
import { Rounds } from "../public/js/rounds.js";
const room = {
  hostId: "dan",
  members: [
    { id: "dan", slot: 0, connected: true },
    { id: "bro", slot: 1, connected: true },
    { id: "third", slot: 2, connected: true },
  ],
};
const result = (players, teams = false, kind = 1) => ({
  scene: 24,
  results: {
    ticks: 140,
    teams,
    kind,
    players: players.map((p, slot) => ({
      slot,
      present: true,
      kos: 0,
      points: 0,
      ...p,
    })),
  },
});
test("host picks first; actual winner alone picks after stock or time results", () => {
  for (const kind of [0, 1]) {
    const flow = new Rounds();
    assert.equal(flow.chooser(room).id, "dan");
    flow.observe(
      result([{ place: 1 }, { place: 0 }, { place: 2 }], false, kind),
      room,
    );
    assert.equal(flow.chooser(room).id, "bro");
    flow.observe({ scene: 21 }, room);
    const inputs = [0, 1, 2, 3].map(() => ({ buttons: 128, x: 85, y: 0 }));
    assert.deepEqual(flow.filter(inputs, room), [
      { buttons: 0, x: 0, y: 0 },
      inputs[1],
      { buttons: 0, x: 0, y: 0 },
      { buttons: 0, x: 0, y: 0 },
    ]);
    flow.observe({ scene: 22 }, room);
    assert.equal(flow.filter(inputs, room), inputs);
  }
});
test("team winner uses score, then KOs, then port; no contest awards no new winner", () => {
  const flow = new Rounds();
  flow.observe(
    result(
      [
        { place: 1 },
        { place: 0, points: 2, kos: 4 },
        { place: 0, points: 2, kos: 5 },
      ],
      true,
      3,
    ),
    room,
  );
  assert.equal(flow.winnerId, "third");
  flow.observe({ scene: 22 }, room);
  flow.observe(result([{ place: 0 }, { place: 0 }], false, 4), room);
  assert.equal(flow.winnerId, "third");
});
test("winner survives synchronization; a replacement in the same port cannot inherit the choice", () => {
  const flow = new Rounds();
  flow.observe(result([{ place: 1 }, { place: 0 }]), room);
  const guest = new Rounds();
  guest.restore(flow.snapshot());
  assert.equal(guest.chooser(room).id, "bro");
  const changed = {
    ...room,
    members: [room.members[0], { id: "replacement", slot: 1, connected: true }],
  };
  assert.equal(guest.chooser(changed).id, "dan");
});
