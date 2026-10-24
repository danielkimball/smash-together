import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { WebSocket } from "ws";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
async function setup(t, config = {}, options = {}) {
  const app = createApp({ port: 0, config, ...options });
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
  assert.match(await page.text(), /Smash Portal/i);
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
test("attract media supports seeking, suffix ranges, HEAD, and rejects invalid ranges", async (t) => {
  const a = await setup(t);
  const url = a.http + "/media/fire.mp4";
  const head = await fetch(url, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-type"), "video/mp4");
  assert.equal(head.headers.get("accept-ranges"), "bytes");
  const size = Number(head.headers.get("content-length"));
  assert.ok(size > 1000);
  const first = await fetch(url, { headers: { Range: "bytes=0-31" } });
  assert.equal(first.status, 206);
  assert.equal(first.headers.get("content-range"), `bytes 0-31/${size}`);
  assert.equal((await first.arrayBuffer()).byteLength, 32);
  const tail = await fetch(url, { headers: { Range: "bytes=-20" } });
  assert.equal(
    tail.headers.get("content-range"),
    `bytes ${size - 20}-${size - 1}/${size}`,
  );
  assert.equal((await tail.arrayBuffer()).byteLength, 20);
  for (const range of [
    `bytes=${size}-`,
    "bytes=9-2",
    "bytes=0-1,8-9",
    "bytes=-",
    "bytes=-0",
  ])
    assert.equal(
      (await fetch(url, { headers: { Range: range } })).status,
      416,
      range,
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
  h.send({ type: "create", protocol: 7, rom, build, name: "Dan", ...options });
  const joined = await until(h, "joined");
  const { room } = await until(h, "room");
  return { h, token: joined.token, id: joined.id, room };
}
async function join(a, token, options = {}) {
  const g = await client(a.ws);
  g.send({
    type: "join",
    protocol: 7,
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
  assert.equal(list[0].capacity, 8);
  assert.ok(!JSON.stringify(list).includes(first.token));
  assert.ok(!JSON.stringify(list).includes(privateRoom.token));
  const clients = [];
  for (let i = 0; i < 7; i++) {
    const c = await join(a, undefined, { roomId: first.room.id });
    clients.push(c);
    await until(c, "joined");
    const { room } = await until(c, "room");
    assert.equal(room.members.length, i + 2);
    assert.equal(room.members.at(-1).slot, i < 3 ? i + 1 : -1);
  }
  const full = await join(a, first.token);
  assert.match((await until(full, "error")).message, /full/);
  const hidden = await join(a, undefined, { roomId: privateRoom.room.id });
  assert.match((await until(hidden, "error")).message, /closed|invalid/);
  const invited = await join(a, privateRoom.token);
  assert.equal((await until(invited, "joined")).type, "joined");
});

test("update drain counts private rooms, blocks new rooms, permits joins and expires", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "smash-drain-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const maintenancePath = path.join(temp, "drain.json");
  const a = await setup(t, { hostId: "ryker-windows" }, { maintenancePath });
  const hidden = await create(a, { listed: false });
  await writeFile(
    maintenancePath,
    JSON.stringify({ expires: Date.now() + 60000 }),
  );
  const state = await (await fetch(a.http + "/api/status")).json();
  assert.equal(state.hostId, "ryker-windows");
  assert.equal(state.activeRooms, 1);
  assert.equal(state.updating, true);
  assert.equal(
    (await (await fetch(a.http + "/api/rooms")).json()).rooms.length,
    0,
  );
  const blocked = await client(a.ws);
  blocked.send({ type: "create", protocol: 7, rom, build });
  assert.match((await until(blocked, "error")).message, /installing an update/);
  const guest = await join(a, hidden.token);
  await until(guest, "joined");
  await writeFile(maintenancePath, JSON.stringify({ expires: Date.now() - 1 }));
  assert.equal(
    (await (await fetch(a.http + "/api/status")).json()).updating,
    false,
  );
  await create(a);
  assert.equal(a.rooms.size, 2);
});
test("solo room opens immediately; live joining preserves the existing timeline", async (t) => {
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
  assert.equal(next.revision, 1);
  assert.equal(next.epoch, 1);
  assert.ok(a.rooms.get(token).clock);
  assert.equal(next.members[1].slot, 1);
  g.send({ type: "seal", match: 1, revision: 1 });
  assert.match((await until(g, "error")).message, /Only the host/);
  g.send({
    type: "game",
    payload: { type: "start", match: 1, revision: 1, epoch: 2 },
  });
  assert.match((await until(g, "error")).message, /Only the host/);
  g.s.send(Buffer.alloc(64));
  assert.match((await until(g, "error")).message, /Only the host/);
  h.send({
    type: "game",
    payload: { type: "start", match: 1, revision: 1, epoch: 2 },
  });
  h.send({
    type: "game",
    from: "spoof",
    payload: {
      type: "input",
      match: 1,
      revision: 1,
      epoch: 2,
      frame: 6,
      input: { buttons: 128, x: 85, y: 0 },
    },
  });
  const agreed = await until(g, "frame", (m) => m.frame === 6);
  assert.deepEqual(agreed.inputs[0], { buttons: 128, x: 85, y: 0 });
  assert.deepEqual(agreed.late, [1]);
  assert.deepEqual(
    (await until(h, "frame", (m) => m.frame === 6)).inputs,
    agreed.inputs,
  );
  h.send({ type: "seal", match: 1, revision: 1 });
  await until(h, "room", (m) => !m.room.selecting);
  const stranger = await join(a, token);
  await until(stranger, "joined");
  assert.equal((await until(stranger, "room")).room.members.at(-1).slot, -1);
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
  // A newly created room may still receive its own asynchronous launch packet.
  // Only a signal delivered across rooms would be a leak.
  other.h.s.on("message", (data, binary) => {
    if (!binary && JSON.parse(data).type === "signal") leaked = true;
  });
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
test("live reconnect and host handoff preserve the running timeline", async (t) => {
  const a = await setup(t),
    { h, token, id } = await create(a),
    g = await join(a, token);
  const joined = await until(g, "joined");
  await until(g, "room");
  h.send({
    type: "game",
    payload: { type: "start", match: 1, revision: 2, epoch: 2 },
  });
  h.send({ type: "seal", match: 1, revision: 2 });
  await until(h, "frame", (m) => m.frame > 5);
  g.s.close();
  const dropped = (
    await until(h, "room", (m) => m.room.members.some((p) => !p.connected))
  ).room;
  assert.equal(dropped.revision, 2);
  const back = await join(a, token, { ticket: joined.ticket });
  assert.equal((await until(back, "joined")).id, joined.id);
  assert.equal((await until(back, "room")).room.revision, 2);
  await until(h, "snapshot-request", (m) => m.to === joined.id);
  h.s.close();
  const transferred = (
    await until(back, "room", (m) => m.room.hostId === joined.id)
  ).room;
  assert.equal(transferred.match, 1);
  assert.equal(transferred.revision, 2);
  assert.ok(
    (await until(back, "frame", (m) => m.frame > 7)).inputs[0].buttons === 0,
  );
  assert.equal(a.rooms.size, 1);
});
test("cross-origin browser WebSocket upgrades are rejected", async (t) => {
  const a = await setup(t),
    s = new WebSocket(a.ws, { origin: "https://unrelated.example" });
  const [error] = await once(s, "error");
  assert.match(error.message, /socket hang up|closed/i);
});

test("refresh hands off the host, counts only connected people, and reclaims the same public-room identity", async (t) => {
  const a = await setup(t),
    { h, token, id, room } = await create(a),
    ticket = a.rooms.get(token).members.get(id).ticket,
    g = await join(a, token),
    guest = await until(g, "joined"),
    f = await join(a, token);
  await until(f, "joined");
  await until(h, "room", (m) => m.room.members.length === 3);
  const count = async () =>
    (await (await fetch(a.http + "/api/rooms")).json()).rooms[0].count;
  assert.equal(await count(), 3);
  h.s.close();
  await until(g, "room", (m) => m.room.hostId === guest.id);
  assert.equal(await count(), 2);
  const back = await join(a, undefined, { roomId: room.id, ticket });
  assert.equal((await until(back, "joined")).id, id);
  const restored = (await until(back, "room")).room;
  assert.equal(restored.members.length, 3);
  assert.equal(
    restored.hostId,
    guest.id,
    "rejoining does not steal the baton back",
  );
  assert.equal(await count(), 3);
  back.send({ type: "leave" });
  await until(g, "room", (m) => !m.room.members.some((p) => p.id === id));
  assert.equal(await count(), 2);
  assert.equal(
    a.rooms.get(token).members.has(id),
    false,
    "explicit departure has no ghost reservation",
  );
});

test("a reload arriving before the old socket closes replaces only the ticket owner", async (t) => {
  const a = await setup(t),
    { h, token, id, room } = await create(a),
    ticket = a.rooms.get(token).members.get(id).ticket,
    g = await join(a, token),
    guest = await until(g, "joined");
  await until(g, "room");
  const closed = once(h.s, "close");
  const replacement = await join(a, undefined, { roomId: room.id, ticket });
  assert.equal((await until(replacement, "joined")).id, id);
  const updated = (await until(replacement, "room")).room;
  assert.equal(updated.hostId, guest.id);
  assert.equal(updated.members.length, 2);
  await closed;
  replacement.send({ type: "ping", id: 42 });
  assert.equal((await until(replacement, "pong")).id, 42);
  assert.equal(a.rooms.get(token).members.size, 2);
  assert.ok(a.rooms.get(token).members.get(id).socket);
});

test("expired reconnect reservations disappear without stopping the battle clock", async (t) => {
  const a = await setup(t, {}, { reconnectGraceMs: 80 }),
    { h, token } = await create(a),
    g = await join(a, token),
    guest = await until(g, "joined");
  await until(g, "room");
  h.send({
    type: "game",
    payload: { type: "start", match: 1, revision: 2, epoch: 2 },
  });
  h.send({ type: "seal", match: 1, revision: 2 });
  await until(h, "frame", (m) => m.frame > 3);
  const clock = a.rooms.get(token).clock;
  g.s.close();
  const removed = (
    await until(
      h,
      "room",
      (m) => !m.room.members.some((p) => p.id === guest.id),
    )
  ).room;
  assert.equal(removed.revision, 2);
  assert.equal(removed.epoch, 2);
  assert.equal(a.rooms.get(token).clock, clock);
  assert.ok(
    (await until(h, "frame", (m) => m.frame > 10)).inputs[1].buttons === 0,
  );
});

test("disconnected reservations cannot block a live player from an eight-person room", async (t) => {
  const a = await setup(t),
    { h, token } = await create(a);
  const guests = [];
  for (let i = 0; i < 7; i++) {
    const g = await join(a, token);
    const member = await until(g, "joined");
    await until(g, "room");
    guests.push({ g, member });
  }
  guests[6].g.s.close();
  await until(h, "room", (m) => m.room.members.some((p) => !p.connected));
  const replacement = await join(a, token);
  await until(replacement, "joined");
  const joined = (await until(replacement, "room")).room;
  assert.equal(joined.members.length, 8);
  assert.equal(
    joined.members.every((p) => p.connected),
    true,
  );
  assert.equal(
    joined.members.some((p) => p.id === guests[6].member.id),
    false,
  );
});

test("a silently lost connection is detected by heartbeat and passes host control", async (t) => {
  const a = await setup(t, {}, { heartbeatInterval: 40 }),
    { h, token, id } = await create(a),
    g = await join(a, token),
    guest = await until(g, "joined");
  await until(g, "room");
  h.s.pong = () => {}; // Simulate a client whose network has disappeared.
  const changed = (await until(g, "room", (m) => m.room.hostId === guest.id))
    .room;
  assert.equal(changed.members.find((p) => p.id === id).connected, false);
});

test("voice requires opt-in, stays inside the room, and enforces host mutes", async (t) => {
  const a = await setup(t),
    { h, token, id } = await create(a);
  const g = await join(a, token),
    joined = await until(g, "joined");
  await until(g, "room");
  const other = await create(a),
    received = [],
    outside = [];
  g.s.on("message", (data, binary) => {
    if (!binary) received.push(JSON.parse(data));
  });
  other.h.s.on("message", (data, binary) => {
    if (!binary) outside.push(JSON.parse(data));
  });
  const audio = Buffer.alloc(640, 127).toString("base64");
  const flush = async () => {
    h.send({ type: "ping", id: 123 });
    await until(h, "pong");
    await new Promise((r) => setTimeout(r, 20));
  };
  h.send({ type: "voice", audio });
  await flush();
  assert.equal(received.filter((m) => m.type === "voice").length, 0);
  h.send({ type: "voice-state", enabled: true });
  g.send({ type: "voice-state", enabled: true });
  await until(h, "room", (m) => m.room.members.every((p) => p.voice));
  h.send({ type: "voice", audio });
  await flush();
  assert.equal(received.filter((m) => m.type === "voice").length, 1);
  assert.equal(received.find((m) => m.type === "voice").from, id);
  assert.equal(outside.filter((m) => m.type === "voice").length, 0);
  g.send({ type: "voice-moderate", id, muted: true });
  assert.match((await until(g, "error")).message, /Only the host/);
  h.send({ type: "voice-moderate", id, muted: true });
  h.send({ type: "voice", audio });
  await flush();
  assert.equal(received.filter((m) => m.type === "voice").length, 1);
  h.send({ type: "voice-moderate", id, muted: false });
  h.send({ type: "availability", ready: false });
  h.send({ type: "voice-moderate", spectators: true });
  h.send({ type: "voice", audio });
  await flush();
  assert.equal(received.filter((m) => m.type === "voice").length, 1);
  const room = a.rooms.get(token);
  assert.equal(room.hostId, id);
  assert.equal(room.members.get(id).slot, -1);
  h.send({ type: "voice-moderate", spectators: false });
  h.send({ type: "voice", audio });
  await flush();
  assert.equal(received.filter((m) => m.type === "voice").length, 2);
  assert.equal(room.members.get(joined.id).muted, undefined);
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

test("open testing is an explicit host choice and does not publish its private file path", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "smash-testing-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const file = path.join(temp, "invalid.z64");
  await writeFile(file, "not a game");
  const a = await setup(t, { testing: { romPath: file, autoLoad: true } });
  const status = await (await fetch(a.http + "/api/status")).json();
  assert.equal(status.testingAutoLoad, true);
  assert.ok(!JSON.stringify(status).includes(temp));
  // No password is requested, but invalid cartridge bytes never reach a player.
  const response = await fetch(a.http + "/api/testing/cartridge", {
    method: "POST",
    body: "{}",
  });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal((await fetch(a.http + "/api/testing/cartridge")).status, 404);
});

test("a disconnected guest does not stop a running battle's clock", async (t) => {
  const a = await setup(t),
    { h, token } = await create(a),
    g = await join(a, token);
  await until(g, "joined");
  await until(g, "room");
  h.send({ type: "seal", match: 1, revision: 2 });
  h.send({
    type: "game",
    payload: { type: "start", match: 1, revision: 2, epoch: 1 },
  });
  await until(h, "frame");
  g.s.terminate();
  const state = (await until(h, "room", (m) => !m.room.members[1].connected))
    .room;
  assert.equal(state.phase, "playing");
  assert.equal(state.revision, 2);
  assert.deepEqual((await until(h, "frame", (m) => m.frame > 6)).inputs[1], {
    buttons: 0,
    x: 0,
    y: 0,
  });
});

test("stable frontend alone can read APIs, preflight testing access and open the room socket", async (t) => {
  const origin = "https://danielkimball.github.io";
  const a = await setup(t, { frontendUrl: origin + "/smash-together/" });
  const response = await fetch(a.http + "/api/status", {
    headers: { Origin: origin },
  });
  assert.equal(response.headers.get("access-control-allow-origin"), origin);
  assert.equal((await response.json()).publicUrl, origin + "/smash-together/");
  assert.equal((await fetch(a.http + "/")).status, 200);
  const preflight = await fetch(a.http + "/api/testing/cartridge", {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type",
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), origin);
  const denied = await fetch(a.http + "/api/rooms", {
    headers: { Origin: "https://unrelated.example" },
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get("access-control-allow-origin"), null);
  const socket = new WebSocket(a.ws, { origin });
  await once(socket, "open");
  socket.close();
  await once(socket, "close");
});

test("media sessions authenticate, isolate voice and snapshots, and cannot pause gameplay", async (t) => {
  const a = await setup(t);
  const { h, token, id } = await create(a);
  const g = await join(a, token);
  const joined = await until(g, "joined");
  const state = (await until(g, "room")).room;
  const room = a.rooms.get(token);
  const mediaURL = a.ws.replace("/room", "/media");
  const invalid = await client(mediaURL);
  const rejected = once(invalid.s, "close");
  invalid.send({ type: "attach-media", token, id, ticket: joined.ticket });
  assert.equal((await rejected)[0], 1008);
  const hm = await client(mediaURL),
    gm = await client(mediaURL);
  hm.send({
    type: "attach-media",
    token,
    id,
    ticket: room.members.get(id).ticket,
  });
  gm.send({
    type: "attach-media",
    token,
    id: joined.id,
    ticket: joined.ticket,
  });
  await until(hm, "media-ready");
  await until(gm, "media-ready");
  const mainPackets = [],
    mediaPackets = [];
  g.s.on("message", (data, binary) =>
    mainPackets.push(binary ? "binary" : JSON.parse(data).type),
  );
  gm.s.on("message", (data, binary) =>
    mediaPackets.push(binary ? "binary" : JSON.parse(data).type),
  );
  h.send({ type: "voice-state", enabled: true });
  g.send({ type: "voice-state", enabled: true });
  await until(h, "room", (m) => m.room.members.every((p) => p.voice));
  hm.send({ type: "voice", audio: Buffer.alloc(640, 127).toString("base64") });
  await until(gm, "voice");
  assert.ok(!mainPackets.includes("voice"));
  const game = { epoch: 1, match: state.match, revision: state.revision };
  h.send({ type: "game", payload: { ...game, type: "start" } });
  await until(g, "frame");
  const header = Buffer.from(
    JSON.stringify({ ...game, to: joined.id, frame: 0 }),
  );
  const packet = Buffer.alloc(4 + header.length + 200000);
  packet.writeUInt32BE(header.length);
  header.copy(packet, 4);
  hm.s.send(packet);
  assert.ok(Buffer.isBuffer(await gm.next()));
  assert.ok(!mainPackets.includes("binary"));
  hm.send({ type: "game", payload: { ...game, type: "pause" } });
  await until(g, "frame", (m) => m.frame >= 8);
  assert.ok(room.clock, "media cannot send lifecycle commands");
  const history = room.history;
  room.history = [{ frame: 500 }];
  hm.s.send(packet);
  assert.equal((await until(h, "snapshot-request")).to, joined.id);
  room.history = history;
  gm.s.close();
  await once(gm.s, "close");
  assert.ok(
    room.members.get(joined.id).socket,
    "media disconnect does not disconnect controller",
  );
  await until(g, "frame", (m) => m.frame >= 12);
  h.s.close();
  await once(hm.s, "close");
});

test("performance reports are bounded, rate limited, private to the room host and omit sensitive payloads", async (t) => {
  const logs = [];
  const a = await setup(
    t,
    {},
    { metricsInterval: 50, logPerformance: (x) => logs.push(x) },
  );
  const { h, token, id } = await create(a, { listed: false });
  const g = await join(a, token);
  const joined = await until(g, "joined");
  await until(g, "room");
  g.send({
    type: "performance",
    metrics: {
      fps: 59,
      relayRTT: 42,
      backlog: 2,
      token,
      audio: "secret-audio",
      name: "secret-name",
      stepAvgMs: -10,
      frameGapMs: Infinity,
    },
  });
  await new Promise((r) => setTimeout(r, 80));
  g.send({ type: "performance", metrics: { fps: 2 } });
  h.send({ type: "performance-report" });
  const report = await until(h, "performance-report");
  const metrics = report.room.members.find((p) => p.slot === 1).metrics;
  assert.deepEqual(metrics, { fps: 59, relayRTT: 42, backlog: 2 });
  assert.ok(logs.length);
  const output = JSON.stringify(logs);
  for (const secret of [
    token,
    id,
    joined.ticket,
    "secret-audio",
    "secret-name",
  ])
    assert.ok(!output.includes(secret));
  const received = [];
  g.s.on("message", (d) => received.push(JSON.parse(d).type));
  g.send({ type: "performance-report" });
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(!received.includes("performance-report"));
  const status = await (await fetch(a.http + "/api/status")).json();
  assert.ok(status.performance.eventLoopP99Ms >= 0);
  assert.ok(!JSON.stringify(status).includes(token));
});

test("eight-member room keeps 60 Hz deadlines with one missing controller and all voices active", async (t) => {
  const a = await setup(t),
    { h, token, id } = await create(a);
  const clients = [h],
    ids = [id];
  for (let i = 1; i < 8; i++) {
    const c = await join(a, token),
      j = await until(c, "joined");
    await until(c, "room");
    clients.push(c);
    ids.push(j.id);
  }
  const room = a.rooms.get(token),
    media = [];
  for (let i = 0; i < 8; i++) {
    const m = await client(a.ws.replace("/room", "/media"));
    media.push(m);
    m.send({
      type: "attach-media",
      token,
      id: ids[i],
      ticket: room.members.get(ids[i]).ticket,
    });
    await until(m, "media-ready");
    clients[i].send({ type: "voice-state", enabled: true });
  }
  await until(h, "room", (m) => m.room.members.every((p) => p.voice));
  const frames = Array.from({ length: 8 }, () => []),
    start = performance.now();
  const game = { epoch: 1, match: room.match, revision: room.revision };
  for (const [slot, c] of clients.entries())
    c.s.on("message", (d, binary) => {
      if (binary) return;
      const f = JSON.parse(d);
      if (f.type !== "frame") return;
      frames[slot].push(f);
      // Player two has lost upstream connectivity. Everyone else submits normally.
      if (slot < 4 && slot !== 1)
        c.send({
          type: "game",
          payload: {
            ...game,
            type: "input",
            frame: f.frame + 4,
            input: { buttons: 128, x: 0, y: 0 },
          },
        });
    });
  const voiceTimer = setInterval(() => {
    for (const m of media)
      m.send({
        type: "voice",
        audio: Buffer.alloc(640, 127).toString("base64"),
      });
  }, 40);
  t.after(() => clearInterval(voiceTimer));
  h.send({ type: "game", payload: { ...game, type: "start" } });
  await new Promise((r) => setTimeout(r, 900));
  clearInterval(voiceTimer);
  assert.ok(
    frames[0].length >= 37,
    `only ${frames[0].length} frames in ${performance.now() - start} ms`,
  );
  const steady = frames[0].filter((f) => f.frame >= 8);
  assert.ok(steady.every((f) => f.late.includes(1)));
  assert.ok(
    steady.every((f) => ![0, 2, 3].some((slot) => f.late.includes(slot))),
  );
  assert.ok(frames.every((f) => Math.abs(f.length - frames[0].length) <= 1));
});

test("latest inputs coexist with cached clients, release on disconnect and reset after authenticated rejoin", async (t) => {
  const a = await setup(t),
    { h, token } = await create(a),
    g = await join(a, token);
  const identity = await until(g, "joined");
  const { room } = await until(g, "room");
  assert.equal(room.inputMode, "latest");
  h.send({ type: "seal", match: 1, revision: room.revision });
  const game = (payload) => ({
    type: "game",
    payload: { match: 1, revision: room.revision, epoch: 1, ...payload },
  });
  h.send(game({ type: "start" }));
  const first = await until(h, "frame");
  const input = { buttons: 64, x: -80, y: 0 };
  g.send(game({ type: "input-state", sequence: 1, input }));
  g.send(
    game({
      type: "input-state",
      sequence: 1,
      input: { ...input, buttons: 128 },
    }),
  );
  g.send(
    game({
      type: "input-state",
      sequence: 2,
      epoch: 99,
      input: { ...input, buttons: 128 },
    }),
  );
  h.send(
    game({
      type: "input",
      frame: first.frame + 2,
      input: { buttons: 128, x: 80, y: 0 },
    }),
  );
  const hostFrame = await until(h, "frame", (m) => m.frame === first.frame + 2);
  const guestFrame = await until(
    g,
    "frame",
    (m) => m.frame === hostFrame.frame,
  );
  assert.deepEqual(hostFrame, guestFrame);
  assert.equal(hostFrame.inputs[0].buttons, 128);
  assert.deepEqual(hostFrame.inputs[1], input);
  assert.equal(hostFrame.sequences[1], 1);
  g.s.terminate();
  await until(
    h,
    "room",
    (m) => !m.room.members.find((p) => p.id === identity.id)?.connected,
  );
  const released = await until(h, "frame", (m) => m.frame > hostFrame.frame);
  assert.equal(released.inputs[1].buttons, 0);
  const returning = await join(a, token, { ticket: identity.ticket });
  assert.equal((await until(returning, "joined")).id, identity.id);
  await until(returning, "room");
  returning.send(
    game({
      type: "input-state",
      sequence: 0,
      input: { ...input, buttons: 128 },
    }),
  );
  assert.equal(
    (await until(returning, "frame", (m) => m.inputs[1].buttons === 128))
      .sequences[1],
    0,
  );
});
