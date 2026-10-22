import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { WebSocket } from "ws";
import { createHash } from "node:crypto";
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
async function setup(t, config = {}) {
  const app = createApp({ port: 0, config });
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
  h.send({ type: "create", protocol: 4, rom, build, name: "Dan", ...options });
  const joined = await until(h, "joined");
  const { room } = await until(h, "room");
  return { h, token: joined.token, id: joined.id, room };
}
async function join(a, token, options = {}) {
  const g = await client(a.ws);
  g.send({
    type: "join",
    protocol: 4,
    rom,
    build,
    token,
    name: "Brother",
    ...options,
  });
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
test("solo room opens immediately; joining changes roster revision, not the match", async (t) => {
  const a = await setup(t),
    { h, token, id, room } = await create(a, { capacity: 2 });
  assert.equal(room.phase, "starting");
  assert.equal(room.selecting, true);
  assert.equal(room.members.length, 1);
  assert.equal((await until(h, "launch")).match, 1);
  h.send({
    type: "game",
    payload: { type: "start", match: 1, revision: 1, epoch: 1 },
  });
  await until(h, "room", (m) => m.room.phase === "selecting");
  const bad = await join(a, token, { rom: "0".repeat(40) });
  assert.match((await until(bad, "error")).message, /same ROM/);
  const g = await join(a, token);
  await until(g, "joined");
  const next = (await until(g, "room")).room;
  assert.equal(next.match, 1);
  assert.equal(next.revision, 2);
  assert.equal(next.members[1].slot, 1);
  g.send({ type: "seal", match: 1, revision: 2 });
  assert.match((await until(g, "error")).message, /Only the host/);
  g.send({
    type: "game",
    payload: { type: "start", match: 1, revision: 2, epoch: 2 },
  });
  assert.match((await until(g, "error")).message, /Only the host/);
  g.s.send(Buffer.alloc(64));
  assert.match((await until(g, "error")).message, /Only the host/);
  h.send({
    type: "game",
    from: "spoof",
    payload: {
      type: "input",
      match: 1,
      revision: 2,
      epoch: 2,
      frame: 6,
      input: { buttons: 128, x: 85, y: 0 },
    },
  });
  assert.equal((await until(g, "game")).from, id);
  h.send({ type: "seal", match: 1, revision: 2 });
  await until(h, "room", (m) => !m.room.selecting);
  const stranger = await join(a, token);
  assert.match((await until(stranger, "error")).message, /started/);
});
test("old roster input and snapshots cannot reach a newly joined controller", async (t) => {
  const a = await setup(t),
    { h, token } = await create(a),
    g = await join(a, token);
  await until(g, "joined");
  await until(g, "room");
  const packet = (revision) => {
    const header = Buffer.from(JSON.stringify({ match: 1, revision }));
    const bytes = Buffer.alloc(8 + header.length);
    bytes.writeUInt32BE(header.length);
    header.copy(bytes, 4);
    return bytes;
  };
  h.send({
    type: "game",
    payload: { type: "input", match: 1, revision: 1, epoch: 1 },
  });
  h.s.send(packet(1));
  h.s.send(packet(2));
  assert.deepEqual(await g.next(), packet(2));
  h.send({ type: "seal", match: 1, revision: 1 });
  h.send({
    type: "game",
    payload: { type: "start", match: 1, revision: 2, epoch: 3 },
  });
  const { room } = await until(h, "room", (m) => m.room.phase === "selecting");
  assert.equal(room.selecting, true);
});
test("explicit leave frees a selection port; signal relay stays within its room", async (t) => {
  const a = await setup(t),
    { h, token, id } = await create(a),
    g = await join(a, token),
    other = await create(a);
  const guest = await until(g, "joined");
  await until(g, "room");
  let leaked = false;
  other.h.s.on("message", () => (leaked = true));
  h.send({
    type: "signal",
    to: guest.id,
    signal: { candidate: { candidate: "test" } },
  });
  assert.equal((await until(g, "signal")).from, id);
  assert.equal(leaked, false);
  g.send({ type: "leave" });
  const r = (
    await until(
      h,
      "room",
      (m) => m.room.members.length === 1 && m.room.revision === 3,
    )
  ).room;
  assert.equal(r.selecting, true);
  const replacement = await join(a, token);
  await until(replacement, "joined");
  assert.equal((await until(replacement, "room")).room.members[1].slot, 1);
});
test("network loss reserves the fighter and port; only its ticket can reconnect in battle", async (t) => {
  const a = await setup(t),
    { h, token } = await create(a),
    g = await join(a, token);
  const joined = await until(g, "joined");
  await until(g, "room");
  h.send({ type: "seal", match: 1, revision: 2 });
  await until(h, "room", (m) => !m.room.selecting);
  g.s.close();
  await until(h, "room", (m) => m.room.phase === "paused");
  const stranger = await join(a, token);
  assert.match((await until(stranger, "error")).message, /started/);
  const back = await join(a, token, { ticket: joined.ticket });
  assert.equal((await until(back, "joined")).id, joined.id);
  const r = (await until(back, "room")).room;
  assert.equal(r.revision, 4);
  assert.ok(r.members.every((p) => p.connected));
  back.s.close();
  await until(h, "room", (m) => m.room.revision === 5);
  h.send({ type: "lobby" });
  const lobby = (await until(h, "room", (m) => m.room.match === 2)).room;
  assert.equal(lobby.members.length, 1);
  assert.equal(lobby.selecting, true);
  await until(h, "launch");
  const fresh = await join(a, token);
  await until(fresh, "joined");
  await until(fresh, "room");
  h.s.close();
  await until(fresh, "closed");
  assert.equal(a.rooms.size, 0);
});
test("cross-origin browser WebSocket upgrades are rejected", async (t) => {
  const a = await setup(t),
    s = new WebSocket(a.ws, { origin: "https://unrelated.example" });
  const [error] = await once(s, "error");
  assert.match(error.message, /socket hang up|closed/i);
});

test("outdated browser pages get an explicit reload instruction", async (t) => {
  const a = await setup(t),
    c = await client(a.ws);
  c.send({ type: "create", rom, build });
  assert.match((await until(c, "error")).message, /Reload/);
  assert.equal(a.rooms.size, 0);
});

test("host can rename a live room without changing its roster or match", async (t) => {
  const a = await setup(t),
    { h, token } = await create(a),
    g = await join(a, token);
  await until(g, "joined");
  const before = (await until(g, "room")).room;
  g.send({ type: "rename", name: "Guest change" });
  assert.match((await until(g, "error")).message, /Only the host/);
  h.send({ type: "rename", name: "  Brothers Arena  " });
  const after = (
    await until(g, "room", (m) => m.room.name === "Brothers Arena")
  ).room;
  assert.equal(after.match, before.match);
  assert.equal(after.revision, before.revision);
  assert.deepEqual(after.members, before.members);
  assert.equal(
    (await (await fetch(a.http + "/api/rooms")).json()).rooms[0].name,
    "Brothers Arena",
  );
  h.send({ type: "rename", name: "   " });
  assert.match((await until(h, "error")).message, /Enter a room name/);
});

test("testing cartridge is opt-in, password-gated, rate-limited and absent from public configuration", async (t) => {
  const disabled = await setup(t);
  assert.equal(
    (
      await fetch(disabled.http + "/api/testing/cartridge", {
        method: "POST",
        body: "{}",
      })
    ).status,
    405,
  );
  const enabled = await setup(t, {
    publicUrl: "https://example.github.io/smash/",
    testing: {
      romPath: "/unserved/private/game.z64",
      passwordHash: createHash("sha256").update("unit-test-only").digest("hex"),
    },
  });
  const status = await fetch(enabled.http + "/api/status");
  const config = await status.json();
  assert.equal(config.publicUrl, config.shareUrl);
  assert.equal(config.testingAvailable, true);
  assert.ok(!JSON.stringify(config).includes("private"));
  assert.ok(!JSON.stringify(config).includes("password"));
  assert.match(
    (await fetch(enabled.http)).headers.get("content-security-policy"),
    /frame-ancestors 'none'/,
  );
  assert.equal(
    (await fetch(enabled.http + "/api/testing/cartridge")).status,
    404,
  );
  for (let i = 0; i < 8; i++) {
    const response = await fetch(enabled.http + "/api/testing/cartridge", {
      method: "POST",
      body: JSON.stringify({ password: "wrong" }),
    });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  assert.equal(
    (
      await fetch(enabled.http + "/api/testing/cartridge", {
        method: "POST",
        body: "{}",
      })
    ).status,
    429,
  );
});
