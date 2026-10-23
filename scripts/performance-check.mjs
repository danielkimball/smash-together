// Isolated real-emulator load/latency check. Never use a person's room/controller.
// Local test host with testing.autoLoad, SMASH_URL and CHROME_PATH are required.
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { browserHelpers } from "./browser-helpers.mjs";
const url = process.env.SMASH_URL || "http://127.0.0.1:8790";
const seconds = Math.max(10, Number(process.env.SMASH_BENCHMARK_SECONDS) || 60);
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
  report = { seconds, errors };
const { openPage, browse, join, scene, clickNative, wait } = browserHelpers(
  browser,
  { url, pages, errors },
);
try {
  await mkdir("artifacts", { recursive: true });
  const a = await openPage(),
    b = await openPage();
  await browse(a);
  await a.locator("#create-open").click();
  await a.locator("#visibility").selectOption("private");
  await a.locator("#create-room").click();
  await scene(a, 9);
  await a.locator('[data-native-input="a"]').click();
  await scene(a, 16);
  await a.waitForFunction(() => smash.net.running);
  await clickNative(a, 86, 64);
  await join(b, await a.evaluate(() => smash.net.token));
  await clickNative(b, 128, 64);
  await a.locator("#start-game").click();
  await scene(a, 21);
  await wait(900);
  await clickNative(a, 105, 45);
  await scene(a, 22);
  await scene(b, 22);
  for (const p of pages)
    await p.evaluate(() => {
      window.qaLatency = {
        start: performance.now(),
        frame: smash.engine.frames,
        repairs: smash.net.repairs,
        pending: [],
        latencies: [],
        costs: [],
        backlog: [],
      };
      const original = smash.engine.frame.bind(smash.engine);
      let last = 0;
      smash.engine.frame = (inputs) => {
        const begin = performance.now(),
          q = qaLatency;
        const buttons = inputs[smash.net.player]?.buttons || 0;
        let sent;
        if (buttons !== last) {
          const at = q.pending.findIndex((e) => e.buttons === buttons);
          if (at >= 0) {
            sent = q.pending[at].at;
            q.pending.splice(0, at + 1);
          }
          last = buttons;
        }
        const value = original(inputs);
        q.costs.push(performance.now() - begin);
        if (sent !== undefined) q.latencies.push(performance.now() - sent);
        q.backlog.push(Math.max(0, smash.net.serverFrame - smash.net.frame));
        return value;
      };
    });
  for (let i = 0; i < seconds * 2; i++) {
    for (const p of pages)
      await p.evaluate((i) => {
        const buttons = i % 2 ? 0 : 128;
        qaLatency.pending.push({ buttons, at: performance.now() });
        smash.controls.keys = buttons ? new Set(["KeyJ"]) : new Set();
      }, i);
    await wait(500);
  }
  await wait(100);
  report.clients = await Promise.all(
    pages.map((p) =>
      p.evaluate(() => {
        const q = qaLatency;
        const distribution = (values) => {
          const sorted = values.toSorted((a, b) => a - b);
          return {
            count: sorted.length,
            average: values.reduce((a, b) => a + b, 0) / (values.length || 1),
            median: sorted[Math.floor(sorted.length / 2)],
            p95: sorted[Math.floor(sorted.length * 0.95)],
            max: sorted.at(-1),
          };
        };
        return {
          fps:
            ((smash.engine.frames - q.frame) * 1000) /
            (performance.now() - q.start),
          scene: smash.engine.inspect().scene,
          inputMode: smash.net.room.inputMode,
          inputBuffer: smash.net.personalDelay,
          relayRTT: smash.net.relayRTT,
          state: smash.net.state,
          message: smash.net.message,
          matchingChecks: smash.net.matches,
          repairs: smash.net.repairs - q.repairs,
          buttonToEmulatorMs: distribution(q.latencies),
          stepMs: distribution(q.costs),
          backlog: distribution(q.backlog),
          samples: smash.net.performanceSamples.slice(-15),
        };
      }),
    ),
  );
  await a.screenshot({ path: "artifacts/performance-combat.png" });
  report.server = await a.evaluate(() => smash.net.roomPerformance);
  for (const client of report.clients) {
    assert.equal(client.inputMode, "latest");
    assert.equal(client.inputBuffer, 0);
    assert.equal(client.state, "playing");
    assert.equal(client.scene, 22);
    assert.equal(client.repairs, 0);
    assert.ok(client.matchingChecks > 5);
    assert.ok(client.fps >= 58, `Slow emulator: ${client.fps} FPS`);
    assert.ok(client.backlog.p95 <= 4, `Render backlog: ${client.backlog.p95}`);
    assert.ok(
      client.buttonToEmulatorMs.count >= seconds * 1.8,
      "Controller transitions were lost",
    );
    assert.ok(
      client.buttonToEmulatorMs.p95 <
        (Number(process.env.SMASH_BENCHMARK_MAX_LATENCY) || 100),
      "Input latency exceeded target",
    );
    assert.ok(
      client.samples.some((s) => s.inputAckSamples > 0 && s.inputAckAvgMs > 0),
      "No real input timing samples",
    );
  }
  assert.deepEqual(errors, []);
  console.log(
    "PASS sustained combat",
    JSON.stringify(report.clients.map(({ samples, ...client }) => client)),
  );
} catch (error) {
  report.failure = error.stack;
  console.error(error);
  process.exitCode = 1;
} finally {
  await writeFile(
    "artifacts/performance-check.json",
    JSON.stringify(report, null, 2),
  );
  await browser.close();
}
