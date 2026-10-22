import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { WebSocket } from "ws";
import { createApp } from "../server.mjs";
const rom = "e2929e10fccc0aa84e5776227e798abc07cedabf",
  build = "test-v1";
async function client(url) {
  const s = new WebSocket(url),
    queue = [],
    waiters = [];
  s.on("message", (data, binary) => {
    const v = binary ? data : JSON.parse(data);
    if (waiters.length) waiters.shift()(v);
    else queue.push(v);
  });
  await once(s, "open");
  return {
    s,
    send: (m) => s.send(JSON.stringify(m)),
    next: () =>
      queue.length
        ? Promise.resolve(queue.shift())
        : new Promise((resolve, reject) => {
            const timer = setTimeout(
              () => reject(Error("Packet timeout")),
              2500,
            );
            waiters.push((v) => {
              clearTimeout(timer);
              resolve(v);
            });
          }),
  };
}
async function setup(t) {
  const app = createApp({ port: 0 });
  const { port } = await app.ready;
  t.after(() => app.close());
  return {
    ...app,
    http: `http://127.0.0.1:${port}`,
    ws: `ws://127.0.0.1:${port}/room`,
  };
}
test("serves the game, isolates public assets, rejects writes and traversal", async (t) => {
  const a = await setup(t);
  const page = await fetch(a.http);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Smash Together/i);
  assert.match(
    page.headers.get("content-security-policy"),
    /frame-ancestors 'none'/,
  );
  assert.equal(
    (await fetch(a.http + "/engine/n64wasm.wasm")).headers.get("content-type"),
    "application/wasm",
  );
  for (const file of [
    "/server.mjs",
    "/package.json",
    "/.local/share.json",
    "/smash.z64",
    "/Super%20Smash%20Bros.%20(U)%20%5B!%5D.z64",
    "/%2e%2e%2fpackage.json",
  ])
    assert.equal((await fetch(a.http + file)).status, 404, file);
  assert.equal(
    (
      await fetch(a.http + "/", {
        method: "POST",
        body: "never accept ROM uploads",
      })
    ).status,
    405,
  );
});
async function until(c, type, predicate = () => true) {
  for (let i = 0; i < 30; i++) {
    const m = await c.next();
    if (m.type === type && predicate(m)) return m;
  }
  throw Error(`No ${type} packet`);
}
async function create(a, options = {}) {
  const h = await client(a.ws);
  h.send({ type: "create", rom, build, name: "Dan", ...options });
  const joined = await until(h, "joined");
  const { room } = await until(h, "room");
  return { h, token: joined.token, id: joined.id, room };
}
async function join(a, token, options = {}) {
  const g = await client(a.ws);
  g.send({ type: "join", rom, build, token, name: "Brother", ...options });
  return g;
}
test("public room directory hides private invitations and tracks four seats", async (t) => {
  const a = await setup(t),
    first = await create(a),
    privateRoom = await create(a, { listed: false });
  const list = (await (await fetch(a.http + "/api/rooms")).json()).rooms;
  assert.equal(list.length, 1);
  assert.equal(list[0].id, first.room.id);
  assert.equal(list[0].capacity, 4);
  assert.ok(!JSON.stringify(list).includes(first.token));
  assert.ok(!JSON.stringify(list).includes(privateRoom.token));
  const clients = [];
  for (let i = 0; i < 3; i++) {
    const c = await join(a, undefined, { roomId: first.room.id });
    clients.push(c);
    await until(c, "joined");
    const { room } = await until(c, "room");
    assert.equal(room.members.length, i + 2);
    assert.equal(room.members.at(-1).slot, i + 1);
  }
  const full = await join(a, first.token);
  assert.match((await until(full, "error")).message, /full/);
  const hidden = await join(a, undefined, { roomId: privateRoom.room.id });
  assert.match((await until(hidden, "error")).message, /closed|invalid/);
  const invited = await join(a, privateRoom.token);
  assert.equal((await until(invited, "joined")).type, "joined");
});
test("ROM/build agreement, occupied seats, ready gate and host authority", async (t) => {
  const a = await setup(t),
    { h, token, id } = await create(a, { capacity: 2 });
  const bad = await join(a, token, { rom: "0".repeat(40) });
  assert.match((await until(bad, "error")).message, /same ROM/);
  bad.send({ type: "join", token, rom, build: "old" });
  assert.match((await until(bad, "error")).message, /same ROM/);
  const g = await join(a, token);
  await until(g, "joined");
  await until(g, "room");
  g.send({ type: "seat", slot: 0 });
  assert.match((await until(g, "error")).message, /taken/);
  g.send({ type: "launch" });
  assert.match((await until(g, "error")).message, /Only the host/);
  h.send({ type: "launch" });
  assert.match((await until(h, "error")).message, /everyone must be ready/);
  h.send({ type: "ready", ready: true });
  g.send({ type: "ready", ready: true });
  await until(h, "room", (m) => m.room.members.every((p) => p.ready));
  h.send({ type: "launch" });
  assert.equal((await until(h, "launch")).match, 1);
  assert.equal((await until(g, "launch")).match, 1);
  g.send({ type: "game", payload: { type: "start", match: 1, epoch: 1 } });
  assert.match((await until(g, "error")).message, /Only the host/);
  g.s.send(Buffer.alloc(64));
  assert.match((await until(g, "error")).message, /Only the host/);
  h.send({
    type: "game",
    from: "spoof",
    payload: {
      type: "input",
      match: 1,
      epoch: 1,
      frame: 6,
      input: { buttons: 128, x: 85, y: 0 },
    },
  });
  const packet = await until(g, "game");
  assert.equal(packet.from, id);
  assert.equal(packet.payload.input.buttons, 128);
  h.s.send(Buffer.alloc(64, 23));
  assert.deepEqual(await g.next(), Buffer.alloc(64, 23));
  g.send({ type: "seat", slot: 0 });
  assert.match((await until(g, "error")).message, /Return to the lobby/);
});
test("seat selection preserves host identity and relay stays inside room", async (t) => {
  const a = await setup(t),
    { h, token, id } = await create(a),
    g = await join(a, token),
    other = await create(a);
  const guest = await until(g, "joined");
  await until(g, "room");
  h.send({ type: "seat", slot: 3 });
  const { room } = await until(
    h,
    "room",
    (m) => m.room.members.find((p) => p.id === id).slot === 3,
  );
  assert.equal(room.hostId, id);
  assert.equal(room.members.find((p) => p.id === id).ready, false);
  let leaked = false;
  other.h.s.on("message", () => (leaked = true));
  h.send({
    type: "signal",
    to: guest.id,
    signal: { candidate: { candidate: "test" } },
  });
  assert.equal((await until(g, "signal")).from, id);
  assert.equal(leaked, false);
});
test("disconnect reserves an active port; only its ticket can reconnect; lobby return frees it", async (t) => {
  const a = await setup(t),
    { h, token } = await create(a),
    g = await join(a, token);
  const joined = await until(g, "joined");
  await until(g, "room");
  h.send({ type: "ready", ready: true });
  g.send({ type: "ready", ready: true });
  await until(h, "room", (m) => m.room.members.every((p) => p.ready));
  h.send({ type: "launch" });
  await until(h, "launch");
  await until(g, "launch");
  g.s.close();
  await until(h, "room", (m) => m.room.phase === "paused");
  const stranger = await join(a, token);
  assert.match((await until(stranger, "error")).message, /started/);
  const back = await join(a, token, { ticket: joined.ticket });
  assert.equal((await until(back, "joined")).id, joined.id);
  await until(h, "reconnected");
  await until(back, "reconnected");
  back.s.close();
  await until(h, "room", (m) => m.room.phase === "paused");
  h.send({ type: "lobby" });
  const lobby = await until(h, "room", (m) => m.room.phase === "lobby");
  assert.equal(lobby.room.members.length, 1);
  const newGuest = await join(a, token);
  await until(newGuest, "joined");
  await until(newGuest, "room");
  h.s.close();
  assert.equal((await until(newGuest, "closed")).type, "closed");
  assert.equal(a.rooms.size, 0);
});
test("cross-origin browser WebSocket upgrades are rejected", async (t) => {
  const a = await setup(t),
    s = new WebSocket(a.ws, { origin: "https://unrelated.example" });
  const [error] = await once(s, "error");
  assert.match(error.message, /socket hang up|closed/i);
});
