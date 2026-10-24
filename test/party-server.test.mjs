import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { WebSocket } from "ws";
import { createApp } from "../server.mjs";
import { PROTOCOL } from "../public/js/protocol.js";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const identity = {
  protocol: PROTOCOL,
  rom: "e2929e10fccc0aa84e5776227e798abc07cedabf",
  build: "party-test",
};
const locals = (count) =>
  Array.from({ length: count }, (_, i) => ({
    key: `local-${i}`,
    name: `Partner ${i + 1}`,
    controller: `Controller ${i + 2}`,
  }));
async function setup(t) {
  const app = createApp({ port: 0 });
  const { port } = await app.ready;
  t.after(() => app.close());
  const connect = async (options) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/room`);
    const messages = [];
    socket.on("message", (data, binary) => {
      if (!binary) messages.push(JSON.parse(data));
    });
    await once(socket, "open");
    const c = {
      socket,
      messages,
      send: (m) => socket.send(JSON.stringify(m)),
      async until(predicate, after = 0) {
        const limit = Date.now() + 3000;
        while (Date.now() < limit) {
          const match = messages.slice(after).find(predicate);
          if (match) return match;
          await wait(5);
        }
        throw Error("Timed out waiting for expected room packet");
      },
    };
    c.send({
      ...identity,
      type: options.token ? "join" : "create",
      name: "Player",
      ...options,
    });
    const joined = await c.until(
      (m) => m.type === "joined" || m.type === "error",
    );
    if (joined.type === "error") return { ...c, error: joined.message };
    Object.assign(c, joined);
    c.room = (await c.until((m) => m.type === "room")).room;
    return c;
  };
  const start = async (c) => {
    const r = app.rooms.get(c.token);
    c.send({
      type: "game",
      payload: {
        type: "start",
        epoch: 1,
        match: r.match,
        revision: r.revision,
      },
    });
    await c.until((m) => m.type === "frame");
    return r.clock;
  };
  const game = (c, payload) => {
    const r = app.rooms.get(c.token);
    c.send({
      type: "game",
      payload: {
        epoch: r.clockEpoch,
        match: r.match,
        revision: r.revision,
        ...payload,
      },
    });
  };
  return { ...app, connect, start, game, http: `http://127.0.0.1:${port}` };
}
test("one connection can own four people without duplicate room or frame deliveries", async (t) => {
  const app = await setup(t),
    h = await app.connect({ locals: locals(3) });
  assert.equal(h.room.members.length, 4);
  assert.deepEqual(
    h.room.members.map((p) => p.slot),
    [0, 1, 2, 3],
  );
  assert.ok(h.room.members.every((p) => p.ownerId === h.id));
  await app.start(h);
  await wait(80);
  const frames = h.messages.filter((m) => m.type === "frame");
  assert.equal(frames.length, new Set(frames.map((m) => m.frame)).size);
  const g = await app.connect({ token: h.token });
  assert.equal(g.room.members.find((p) => p.id === g.id).slot, -1);
  assert.equal(
    (await (await fetch(app.http + "/api/rooms")).json()).rooms[0].count,
    5,
  );
});
test("owned controller inputs are independent and cannot spoof another device's player", async (t) => {
  const app = await setup(t),
    h = await app.connect({ locals: locals(1) }),
    g = await app.connect({ token: h.token });
  const clock = await app.start(h),
    room = app.rooms.get(h.token);
  const partner = [...room.members.values()].find((p) => p.ownerId === h.id);
  app.game(h, {
    type: "input-state",
    sequence: 1,
    input: { buttons: 128, x: 85, y: 0 },
  });
  app.game(h, {
    type: "input-state",
    playerId: partner.id,
    sequence: 2,
    input: { buttons: 64, x: -85, y: 0 },
  });
  app.game(g, {
    type: "input-state",
    sequence: 1,
    input: { buttons: 32, x: 0, y: 85 },
  });
  app.game(h, {
    type: "input-state",
    playerId: g.id,
    sequence: 999,
    input: { buttons: 8192, x: 0, y: 0 },
  });
  const after = h.messages.length;
  const frame = await h.until(
    (m) => m.type === "frame" && m.inputs[0].buttons === 128,
    after,
  );
  assert.deepEqual(
    frame.inputs.slice(0, 3).map((i) => i.buttons),
    [128, 64, 32],
  );
  assert.equal(clock.latest.get(2).sequence, 1);
  g.send({ type: "availability", id: partner.id, ready: false });
  await wait(20);
  assert.equal(partner.ready, true);
  h.send({ type: "pointer", playerId: partner.id, scene: 16, x: 100, y: 60 });
  await wait(10);
  assert.ok(
    clock.commands.some(
      (c) => c.command.id === partner.id && c.command.slot === 1,
    ),
  );
  const count = clock.commands.length;
  h.send({ type: "pointer", playerId: g.id, scene: 16, x: 100, y: 60 });
  await wait(10);
  assert.ok(clock.commands.length <= count);
});
test("live lobby join, leave and local lineup changes preserve the server clock", async (t) => {
  const app = await setup(t),
    h = await app.connect({ locals: locals(1) });
  const clock = await app.start(h),
    room = app.rooms.get(h.token),
    revision = room.revision;
  const g = await app.connect({ token: h.token });
  assert.equal(room.clock, clock);
  assert.equal(room.revision, revision);
  assert.ok(
    h.messages.some((m) => m.type === "snapshot-request" && m.to === g.id),
  );
  app.game(g, { type: "pause" });
  await wait(20);
  assert.equal(room.clock, clock);
  const partner = [...room.members.values()].find((p) => p.ownerId === h.id);
  h.send({ type: "availability", id: partner.id, ready: false });
  await wait(20);
  assert.equal(room.clock, clock);
  assert.equal(partner.slot, -1);
  h.send({ type: "availability", id: partner.id, ready: true });
  await wait(20);
  assert.equal(room.clock, clock);
  assert.equal(partner.slot, 1);
  h.send({ type: "local-players", locals: [] });
  await wait(20);
  assert.equal(room.clock, clock);
  assert.equal(room.members.has(partner.id), false);
  assert.ok(
    clock.commands.some((c) => c.command.slot === 1 && c.command.releaseSlot),
  );
  g.send({ type: "leave" });
  await wait(20);
  assert.equal(room.clock, clock);
  assert.equal(room.members.size, 1);
});
test("refresh reconnects an entire device with the same identities and hands hosting to another device", async (t) => {
  const app = await setup(t),
    h = await app.connect({ locals: locals(1) }),
    g = await app.connect({ token: h.token });
  const clock = await app.start(h),
    room = app.rooms.get(h.token);
  const ids = [...room.members.values()]
    .filter((p) => (p.ownerId || p.id) === h.id)
    .map((p) => p.id);
  h.socket.close();
  await once(h.socket, "close");
  await g.until((m) => m.type === "room" && m.room.hostId === g.id);
  assert.equal(
    (await (await fetch(app.http + "/api/rooms")).json()).rooms[0].count,
    1,
  );
  assert.equal(room.clock, clock);
  const again = await app.connect({
    token: h.token,
    ticket: h.ticket,
    locals: locals(1),
  });
  assert.equal(again.id, h.id);
  assert.equal(room.hostId, g.id);
  assert.deepEqual(
    [...room.members.values()]
      .filter((p) => (p.ownerId || p.id) === h.id)
      .map((p) => p.id),
    ids,
  );
  assert.equal([...room.members.values()].filter((p) => p.socket).length, 3);
  assert.equal(room.clock, clock);
  again.send({ type: "leave" });
  await wait(20);
  assert.equal(room.members.size, 1);
});
test("group admission and edits enforce room capacity atomically", async (t) => {
  const app = await setup(t),
    h = await app.connect({ locals: locals(3) });
  await app.connect({ token: h.token, locals: locals(2) });
  const room = app.rooms.get(h.token);
  assert.equal(room.members.size, 7);
  const full = await app.connect({ token: h.token, locals: locals(1) });
  assert.match(full.error, /full/);
  assert.equal(room.members.size, 7);
  h.send({ type: "local-players", locals: [...locals(3), { key: "extra" }] });
  await h.until((m) => m.type === "error");
  assert.equal(room.members.size, 7);
  assert.equal(
    [...room.members.values()].filter((p) => p.ownerId === h.id).length,
    3,
  );
});
test("listen-only devices receive voice once and can deafen without enabling their microphone", async (t) => {
  const app = await setup(t),
    h = await app.connect({}),
    g = await app.connect({ token: h.token, locals: locals(1) });
  h.send({ type: "voice-state", enabled: true, listening: true });
  g.send({ type: "voice-state", enabled: false, listening: true });
  await h.until(
    (m) =>
      m.type === "room" && m.room.members.find((p) => p.id === g.id)?.listening,
  );
  const audio = Buffer.alloc(640, 127).toString("base64");
  h.send({ type: "voice", audio });
  await g.until((m) => m.type === "voice");
  assert.equal(g.messages.filter((m) => m.type === "voice").length, 1);
  assert.equal(app.rooms.get(h.token).members.get(g.id).voice, false);
  g.send({ type: "voice-state", enabled: false, listening: false });
  await h.until(
    (m) =>
      m.type === "room" &&
      !m.room.members.find((p) => p.id === g.id)?.listening,
    h.messages.length - 1,
  );
  h.send({ type: "voice", audio });
  await wait(30);
  assert.equal(g.messages.filter((m) => m.type === "voice").length, 1);
  g.send({ type: "voice", audio });
  await wait(30);
  assert.equal(h.messages.filter((m) => m.type === "voice").length, 0);
});

test("native team configuration clears old cleanup deadlines and team rotation rebuilds colors", async (t) => {
  const app = await setup(t),
    h = await app.connect({ locals: locals(3) });
  const clock = await app.start(h),
    room = app.rooms.get(h.token);
  // Removing a person schedules cleanup on this clock, then the host changes mode.
  h.send({ type: "local-players", locals: locals(2) });
  await wait(20);
  assert.ok(room.slotReady[3] > clock.frame);
  h.send({ type: "manage", teamsEnabled: true, teams: {} });
  await wait(20);
  assert.equal(room.clock, null);
  assert.deepEqual(room.slotReady, {});
  h.send({ type: "local-players", locals: locals(3) });
  await wait(20);
  app.game(h, { type: "start", epoch: 2 });
  await h.until((m) => m.type === "frame" && m.epoch === 2);
  const g = await app.connect({ token: h.token });
  assert.equal(room.members.get(g.id).slot, -1);
  h.send({
    type: "seal",
    match: room.match,
    revision: room.revision,
    teams: true,
    playerTeams: [0, 0, 1, 1],
  });
  await wait(20);
  h.send({
    type: "results",
    round: room.round,
    teams: true,
    players: [0, 1, 2, 3].map((slot) => ({
      slot,
      place: slot < 2 ? 0 : 1,
      kos: 4 - slot,
      points: 4 - slot,
    })),
  });
  await wait(20);
  assert.ok(room.results);
  const revision = room.revision;
  h.send({ type: "open", match: room.match, revision });
  await wait(20);
  assert.equal(room.selecting, true);
  assert.equal(room.revision, revision + 1);
  assert.equal(room.clock, null);
  assert.ok(room.members.get(g.id).slot >= 0);
  assert.equal(room.members.get(g.id).team, 1);
});
