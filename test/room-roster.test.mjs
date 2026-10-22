import test from "node:test";
import assert from "node:assert/strict";
import { lineup, applyLineup, nextHost } from "../scripts/room-roster.mjs";
const roomOf = (n) => ({
  members: new Map(
    Array.from({ length: n }, (_, i) => [
      String(i),
      {
        id: String(i),
        slot: i < 4 ? i : -1,
        ready: true,
        socket: {},
        queue: i,
        joined: i,
        team: i < 2 ? 0 : 1,
      },
    ]),
  ),
  hostId: "0",
  queueCounter: n,
  rotation: "automatic",
  results: {
    teams: false,
    players: Array.from({ length: 4 }, (_, i) => ({
      id: String(i),
      slot: i,
      place: i,
      points: 4 - i,
      kos: 4 - i,
      team: i < 2 ? 0 : 1,
    })),
  },
});
test("FFA five through eight: replace lowest finishers, winner stays, FIFO queue", () => {
  for (let n = 5; n <= 8; n++) {
    const r = roomOf(n),
      expected = [
        ...Array.from({ length: Math.max(1, 8 - n) }, (_, i) => String(i)),
        ...Array.from({ length: Math.min(3, n - 4) }, (_, i) => String(i + 4)),
      ];
    assert.deepEqual(
      lineup(r).map((p) => p.id),
      expected,
    );
    applyLineup(r);
    assert.equal(r.members.get("0").slot, 0);
    assert.equal(
      new Set(
        [...r.members.values()].filter((p) => p.slot >= 0).map((p) => p.slot),
      ).size,
      4,
    );
    if (n === 8)
      assert.equal(
        [...r.members.values()]
          .filter((p) => p.slot < 0)
          .sort((a, b) => a.queue - b.queue)[0].id,
        "7",
      );
  }
});
test("seven-person teams pair odd spectator with higher-KO outgoing teammate", () => {
  const r = roomOf(7);
  r.results.teams = true;
  r.results.players[1].place = 0;
  assert.deepEqual(
    lineup(r).map((p) => p.id),
    ["0", "1", "4", "5"],
  );
  applyLineup(r);
  assert.deepEqual(
    [...r.members.values()]
      .filter((p) => p.slot < 0)
      .sort((a, b) => a.queue - b.queue)
      .map((p) => p.id),
    ["6", "2", "3"],
  );
  assert.equal(r.members.get("4").team, r.members.get("5").team);
});
test("host may sit out; manual lineup overrides results without changing ownership", () => {
  const r = roomOf(8);
  r.members.get("0").ready = false;
  assert.deepEqual(
    lineup(r).map((p) => p.id),
    ["4", "5", "6", "7"],
  );
  applyLineup(r);
  assert.equal(r.hostId, "0");
  assert.equal(r.members.get("0").slot, -1);
  r.override = ["4", "5", "6", "7"];
  applyLineup(r);
  assert.equal(r.hostId, "0");
  assert.deepEqual(
    [...r.members.values()].filter((p) => p.slot >= 0).map((p) => p.id),
    ["4", "5", "6", "7"],
  );
});
test("handoff uses active port order, then oldest connected spectator", () => {
  const r = roomOf(8);
  r.members.get("0").socket = null;
  assert.equal(nextHost(r).id, "1");
  for (const p of r.members.values()) if (p.slot >= 0) p.socket = null;
  assert.equal(nextHost(r).id, "4");
});

test("late arrivals fill empty fighter places before replacing anyone", () => {
  const r = roomOf(3);
  r.members.get("2").slot = -1;
  assert.deepEqual(
    lineup(r).map((p) => p.id),
    ["0", "1", "2"],
  );
});
