// Measures one real browser rendering four fighters. The other three members
// are synthetic controller senders, not independent emulators/determinism proof.
import { chromium } from "playwright";
import { WebSocket } from "ws";
import { once } from "node:events";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { browserHelpers } from "./browser-helpers.mjs";
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH,
  args: [
    "--autoplay-policy=no-user-gesture-required",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
  ],
});
const pages = [],
  errors = [],
  bots = [],
  report = { errors, syntheticControllers: 3 };
const { openPage, browse, scene, clickNative, wait } = browserHelpers(browser, {
  url: process.env.SMASH_URL || "http://127.0.0.1:8790",
  pages,
  errors,
});
async function humanCount(page) {
  return page.evaluate(() => {
    const state = smash.engine.snapshot();
    const word = (address) =>
      new DataView(state.buffer).getUint32(448 + (address & 0x7fffff), true);
    const byte = (address) => state[448 + ((address & 0x7fffff) ^ 3)];
    const battle = word(0x800a50e8);
    return battle ? byte(battle + 4) : 0;
  });
}
let combat = false;
try {
  await mkdir("artifacts", { recursive: true });
  const p = await openPage();
  await browse(p);
  await p.locator("#create-open").click();
  await p.locator("#visibility").selectOption("private");
  await p.locator("#create-room").click();
  await scene(p, 9);
  await p.locator('[data-native-input="a"]').click();
  await scene(p, 16);
  await p.waitForFunction(() => smash.net.running);
  await clickNative(p, 86, 64);
  const identity = await p.evaluate(() => ({
    url: smash.net.socket.url,
    token: smash.net.token,
    rom: smash.engine.romHash,
    build: smash.engine.build + "-smash-native-v7",
  }));
  for (let i = 0; i < 3; i++) {
    const ws = new WebSocket(identity.url),
      bot = { ws, epoch: 0, sequence: 0, running: false };
    bots.push(bot);
    const send = (message) => {
      if (ws.readyState === 1) ws.send(JSON.stringify(message));
    };
    bot.send = send;
    const game = (payload) =>
      send({
        type: "game",
        payload: {
          ...payload,
          epoch: bot.epoch,
          match: bot.room?.match,
          revision: bot.room?.revision,
        },
      });
    ws.on("message", (data, binary) => {
      if (binary) {
        const size = data.readUInt32BE();
        const meta = JSON.parse(data.subarray(4, 4 + size));
        bot.epoch = meta.epoch;
        game({ type: "ready", hash: meta.hash });
        return;
      }
      const m = JSON.parse(data);
      if (m.type === "room") bot.room = m.room;
      if (m.type === "game" && m.payload.type === "sync") {
        bot.running = false;
        bot.epoch = m.payload.epoch;
      }
      if (m.type === "game" && m.payload.type === "start") {
        bot.running = true;
        bot.epoch = m.payload.epoch;
      }
      if (m.type === "error") errors.push(m.message);
    });
    ws.on("error", (e) => errors.push(e.message));
    await once(ws, "open");
    send({
      ...identity,
      url: undefined,
      type: "join",
      protocol: 7,
      name: "Synthetic controller",
    });
    bot.timer = setInterval(() => {
      if (bot.running)
        game({
          type: "input-state",
          sequence: ++bot.sequence,
          input: {
            buttons:
              combat && Math.floor(bot.sequence / 10) % 2
                ? i % 2
                  ? 64
                  : 128
                : 0,
            x: 0,
            y: 0,
          },
        });
    }, 50);
    await p.waitForFunction(
      (n) => smash.net.running && smash.net.connected.length === n,
      i + 2,
      { timeout: 90000 },
    );
  }
  for (const [i, bot] of bots.entries()) {
    bot.send({ type: "pointer", scene: 16, x: [128, 170, 210][i], y: 64 });
    await p.waitForFunction(
      (slot) => smash.engine.inspect().players[slot]?.selected,
      i + 1,
    );
  }
  await p.locator("#start-game").click();
  await scene(p, 21);
  await wait(900);
  await clickNative(p, 105, 45);
  await scene(p, 22);
  assert.equal(await humanCount(p), 4);
  await p.evaluate(() => {
    window.qaFour = {
      at: performance.now(),
      frame: smash.engine.frames,
      cost: [],
      backlog: [],
    };
    const run = smash.engine.frame.bind(smash.engine);
    smash.engine.frame = (inputs) => {
      const now = performance.now();
      const v = run(inputs);
      qaFour.cost.push(performance.now() - now);
      qaFour.backlog.push(Math.max(0, smash.net.serverFrame - smash.net.frame));
      return v;
    };
  });
  combat = true;
  for (let i = 0; i < 120; i++) {
    await p.evaluate(
      (i) => (smash.controls.keys = i % 2 ? new Set() : new Set(["KeyJ"])),
      i,
    );
    await wait(500);
  }
  report.client = await p.evaluate(() => {
    const q = qaFour,
      dist = (values) => {
        const v = values.toSorted((a, b) => a - b);
        return {
          average: values.reduce((a, b) => a + b, 0) / values.length,
          p95: v[Math.floor(v.length * 0.95)],
          max: v.at(-1),
        };
      };
    return {
      fps:
        ((smash.engine.frames - q.frame) * 1000) / (performance.now() - q.at),
      scene: smash.engine.inspect().scene,
      state: smash.net.state,
      stepMs: dist(q.cost),
      backlog: dist(q.backlog),
      samples: smash.net.performanceSamples.slice(-12),
    };
  });
  report.client.humans = await humanCount(p);
  await p.screenshot({ path: "artifacts/four-fighter-combat.png" });
  assert.equal(report.client.state, "playing");
  assert.equal(report.client.scene, 22);
  assert.equal(report.client.humans, 4);
  assert.ok(report.client.fps >= 58);
  assert.ok(report.client.backlog.p95 <= 4);
  assert.deepEqual(errors, []);
  const { samples, ...metrics } = report.client;
  console.log(
    "PASS one real emulator with four active fighters for 60 seconds",
    JSON.stringify(metrics),
  );
} catch (error) {
  report.failure = error.stack;
  console.error(error);
  process.exitCode = 1;
} finally {
  for (const bot of bots) {
    clearInterval(bot.timer);
    bot.send({ type: "leave" });
    bot.ws.close();
  }
  await writeFile(
    "artifacts/four-fighter-check.json",
    JSON.stringify(report, null, 2),
  );
  await browser.close();
}
