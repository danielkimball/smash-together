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
async function room(app) {
  const h = await client(app.ws);
  h.send({ type: "create", rom, build, name: "Dan" });
  const joined = await h.next();
  return { h, token: joined.token };
}
async function join(app, token) {
  const g = await client(app.ws);
  g.send({ type: "join", rom, build, token, name: "Brother" });
  return g;
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
test("private room requires matching ROM/build and has exactly two seats", async (t) => {
  const a = await setup(t),
    { h, token } = await room(a);
  assert.match(token, /^[a-f0-9]{36}$/);
  const bad = await client(a.ws);
  bad.send({ type: "join", rom: "0".repeat(40), build, token });
  assert.match((await bad.next()).message, /same ROM/);
  bad.send({ type: "join", rom, build: "old", token });
  assert.match((await bad.next()).message, /same ROM/);
  const g = await join(a, token);
  assert.equal((await g.next()).player, 1);
  assert.equal((await g.next()).name, "Dan");
  assert.equal((await h.next()).name, "Brother");
  const third = await join(a, token);
  assert.match((await third.next()).message, /two players/);
  const invalid = await join(a, "bad");
  assert.match((await invalid.next()).message, /invalid/);
});
test("relay routes only between room peers and host owns synchronization", async (t) => {
  const a = await setup(t),
    { h, token } = await room(a),
    g = await join(a, token);
  await g.next();
  await g.next();
  await h.next();
  const { h: unrelated } = await room(a);
  let leaked = false;
  unrelated.s.on("message", () => (leaked = true));
  h.send({
    type: "game",
    payload: {
      type: "input",
      epoch: 1,
      frame: 12,
      input: { buttons: 128, x: 85, y: 0 },
    },
  });
  assert.equal((await g.next()).payload.input.buttons, 128);
  g.send({ type: "game", payload: { type: "start", epoch: 1 } });
  assert.match((await g.next()).message, /Only the host/);
  g.s.send(Buffer.alloc(20));
  assert.match((await g.next()).message, /host and guest/);
  const state = Buffer.alloc(64, 23);
  h.s.send(state);
  assert.deepEqual(await g.next(), state);
  assert.equal(leaked, false);
});
test("guest can rejoin; host leaving destroys the room", async (t) => {
  const a = await setup(t),
    { h, token } = await room(a),
    g = await join(a, token);
  await g.next();
  await g.next();
  await h.next();
  g.s.close();
  assert.equal((await h.next()).type, "left");
  h.send({
    type: "game",
    payload: {
      type: "input",
      epoch: 1,
      frame: 123,
      input: { buttons: 0, x: 0, y: 0 },
    },
  });
  h.send({ type: "signal", signal: { candidate: {} } });
  h.s.send(Buffer.alloc(64));
  const g2 = await join(a, token);
  assert.equal((await g2.next()).type, "joined");
  await g2.next();
  await h.next();
  h.s.close();
  assert.equal((await g2.next()).type, "closed");
  await once(g2.s, "close");
  assert.equal(a.rooms.size, 0);
  const missing = await join(a, token);
  assert.match((await missing.next()).message, /closed/);
});
test("cross-origin browser WebSocket upgrades are rejected", async (t) => {
  const a = await setup(t);
  const s = new WebSocket(a.ws, { origin: "https://unrelated.example" });
  const [error] = await once(s, "error");
  assert.match(error.message, /socket hang up|closed/i);
});
