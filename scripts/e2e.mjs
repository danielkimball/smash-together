import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { root } from "./share.mjs";
const rom = process.env.SMASH_ROM;
if (!rom) throw Error("Set SMASH_ROM to your own original US ROM path.");
await access(rom);
const local = process.env.SMASH_URL || "http://127.0.0.1:8787";
const remote =
  process.env.SMASH_GUEST_URL === "public"
    ? (await (await fetch(local + "/api/status")).json()).shareUrl
    : process.env.SMASH_GUEST_URL || local;
if (!remote) throw Error("Public sharing is not ready.");
const dir = path.join(root, "artifacts");
await mkdir(dir, { recursive: true });
const report = {
  started: new Date().toISOString(),
  host: local,
  guest: remote,
  checks: [],
  errors: [],
};
const record = (name, data) => {
  report.checks.push({ name, ...data });
  console.log("PASS", name, data ? JSON.stringify(data) : "");
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.CHROME_PATH ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  args: [
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--autoplay-policy=no-user-gesture-required",
  ],
});
const contexts = [],
  pages = [];
try {
  for (const url of [local, remote]) {
    const context = await browser.newContext({
      viewport: { width: 1400, height: 1100 },
    });
    contexts.push(context);
    const page = await context.newPage();
    pages.push(page);
    page.on("pageerror", (e) => report.errors.push(e.message));
    await page.goto(url);
  }
  const [a, b] = pages;
  await a.screenshot({
    path: path.join(dir, "home-desktop.png"),
    fullPage: true,
  });
  await a.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  );
  await a.screenshot({
    path: path.join(dir, "home-mobile.png"),
    fullPage: true,
  });
  await a.setViewportSize({ width: 1400, height: 1100 });
  record("Responsive desktop and phone layouts");
  await a
    .locator("#rom-file")
    .setInputFiles({
      name: "invalid.z64",
      mimeType: "application/octet-stream",
      buffer: Buffer.alloc(32),
    });
  await a.waitForFunction(() =>
    document.getElementById("toast").textContent.includes("16 MB"),
  );
  assert.equal(await a.evaluate(() => smash.engine.loaded), false);
  record("Invalid ROM rejected");
  for (const page of pages) {
    await page.locator("#rom-file").setInputFiles(rom);
    await page.waitForFunction(
      () => smash.engine.loaded,
      {},
      { timeout: 60000 },
    );
    await page.locator("#pause").click();
  }
  record("Both independent browsers boot verified local ROMs");
  // Simulate a Gamepad API device: hardware pairing itself remains a physical check.
  await a.evaluate(() => {
    window.qaPad = {
      id: "QA N64 USB adapter",
      index: 0,
      mapping: "",
      connected: true,
      buttons: Array.from({ length: 17 }, () => ({ value: 0, pressed: false })),
      axes: [0, 0, 0, 0],
    };
    Object.defineProperty(navigator, "getGamepads", {
      configurable: true,
      value: () => [window.qaPad],
    });
  });
  await a.locator("#controls-open").click();
  await a.locator("#device").selectOption("0");
  await a.evaluate(() => (qaPad.buttons[0] = { value: 1, pressed: true }));
  await a.waitForFunction(() =>
    document.getElementById("control-test").textContent.includes("Attack"),
  );
  await a.evaluate(() => (qaPad.buttons[0] = { value: 0, pressed: false }));
  await a.locator('[data-action="a"]').click();
  await sleep(550);
  await a.evaluate(() => (qaPad.buttons[7] = { value: 1, pressed: true }));
  await a.waitForFunction(() => smash.controls.profile.map.a.index === 7);
  await a.evaluate(() => (qaPad.buttons[7] = { value: 0, pressed: false }));
  await a.locator('[data-action="up"]').click();
  await sleep(550);
  await a.evaluate(() => (qaPad.axes[3] = 1));
  await a.waitForFunction(
    () =>
      smash.controls.profile.map.up.index === 3 &&
      smash.controls.profile.map.up.sign === 1,
  );
  await a.evaluate(() => (qaPad.axes[3] = 0));
  await a.screenshot({
    path: path.join(dir, "controller-setup.png"),
    fullPage: true,
  });
  await a.locator("#device").selectOption("keyboard");
  await a.locator('[data-close="controls-dialog"]').click();
  record("Gamepad preview, N64 button/axis remapping and saved profiles");
  await a.locator("#delay").selectOption("9");
  await a.locator("#player-name").fill("Dan");
  await a.locator("#create-room").click();
  await a.waitForFunction(() => smash.net.token);
  const token = await a.evaluate(() => smash.net.token);
  await b.locator("#player-name").fill("Brother");
  await b.locator("#invite-input").fill(token);
  await b.locator("#join-room").click();
  for (const p of pages)
    await p.waitForFunction(
      () => smash.net.state === "playing",
      {},
      { timeout: 60000 },
    );
  await a.waitForFunction(() => smash.net.matches >= 3, {}, { timeout: 30000 });
  assert.equal(await a.evaluate(() => smash.net.repairs), 0);
  record("Initial synchronization without desync repairs");
  async function frames(p, count) {
    const start = await p.evaluate(() => smash.net.frame);
    await p.waitForFunction(
      (target) => smash.net.running && smash.net.frame >= target,
      start + count,
      { timeout: 45000 },
    );
  }
  async function act(p, keys, count = 6, settle = 60) {
    await p.evaluate(
      ({ keys, count, settle }) =>
        new Promise((resolve, reject) => {
          const controls = smash.controls,
            original = controls.sample.bind(controls);
          let active = count,
            quiet = settle;
          const timeout = setTimeout(() => {
            controls.sample = original;
            reject(Error("Scripted input timed out"));
          }, 45000);
          controls.sample = () => {
            if (active-- > 0) {
              controls.keys = new Set(keys);
              const input = original();
              controls.keys.clear();
              return input;
            }
            if (quiet-- > 0) return { buttons: 0, x: 0, y: 0 };
            controls.sample = original;
            clearTimeout(timeout);
            resolve();
            return original();
          };
        }),
      { keys, count, settle },
    );
  }
  await act(a, ["Enter"], 10, 210);
  await a.locator("#canvas").screenshot({ path: path.join(dir, "title.png") });
  await act(a, ["Enter"], 10, 180);
  await a
    .locator("#canvas")
    .screenshot({ path: path.join(dir, "main-menu.png") });
  await act(a, ["KeyS"], 10, 60);
  await a
    .locator("#canvas")
    .screenshot({ path: path.join(dir, "vs-highlight.png") });
  await act(a, ["KeyJ"], 10, 180);
  await a
    .locator("#canvas")
    .screenshot({ path: path.join(dir, "vs-options.png") });
  await act(a, ["KeyJ"], 10, 180);
  await a
    .locator("#canvas")
    .screenshot({ path: path.join(dir, "fighter-menu.png") });
  await act(a, ["KeyW"], 28, 12);
  await act(a, ["KeyD"], 8, 12);
  await act(a, ["KeyJ"], 6, 20);
  await act(b, ["KeyW"], 28, 12);
  await act(b, ["KeyD"], 3, 12);
  await act(b, ["KeyJ"], 6, 20);
  await a
    .locator("#canvas")
    .screenshot({ path: path.join(dir, "fighters-selected.png") });
  await act(a, ["Enter"], 6, 110);
  await act(a, ["KeyJ"], 6, 240);
  // Allow the stage fly-in and countdown to finish before testing attacks.
  await frames(a, 300);
  const before = await a.evaluate(() => ({
    frames: smash.engine.frames,
    time: performance.now(),
    checks: smash.net.matches,
  }));
  await Promise.all([act(a, ["KeyD"], 20, 1), act(b, ["KeyA"], 20, 1)]);
  for (let i = 0; i < 8; i++)
    await Promise.all([
      act(a, ["KeyJ"], 9, 14),
      act(b, [i % 2 ? "KeyJ" : "KeyK"], 9, 14),
    ]);
  await frames(a, 240);
  const after = await a.evaluate(() => ({
    frames: smash.engine.frames,
    time: performance.now(),
    checks: smash.net.matches,
    repairs: smash.net.repairs,
    audio: smash.engine.audio.ctx.state,
  }));
  assert.ok(after.checks > before.checks + 3);
  assert.equal(after.repairs, 0);
  assert.equal(after.audio, "running");
  for (const [i, p] of pages.entries())
    await p.screenshot({
      path: path.join(dir, `fight-player-${i + 1}.png`),
      fullPage: true,
    });
  record(
    "Scripted gameplay inputs and matching state checks (screenshots require visual verification)",
    {
      fps: Math.round(
        ((after.frames - before.frames) * 1000) / (after.time - before.time),
      ),
      matches: after.checks,
      repairs: after.repairs,
    },
  );
  // Drop one input packet during the direct-to-relay change; redundant history must recover it.
  await a.evaluate(() => {
    const n = smash.net,
      send = n.sendGame.bind(n);
    let dropped = false;
    n.sendGame = (m, ...rest) => {
      if (m.type === "input" && !dropped) {
        dropped = true;
        return;
      }
      return send(m, ...rest);
    };
    n.closeRTC();
  });
  await frames(a, 240);
  assert.notEqual(
    await a.evaluate(() => smash.net.channel?.readyState),
    "open",
  );
  assert.equal(await a.evaluate(() => smash.net.repairs), 0);
  record("Direct connection loss, lost input, and relay fallback recover");
  const prior = await a.evaluate(() => smash.net.epoch);
  await b.evaluate(() => smash.engine.module._netplay_corrupt_rdram());
  await a.waitForFunction(
    (epoch) =>
      smash.net.repairs === 1 &&
      smash.net.epoch > epoch &&
      smash.net.running &&
      smash.net.frame > 180,
    prior,
    { timeout: 45000 },
  );
  record("Deliberate memory desync detected and automatically repaired");
  await b.locator("#controls-open").click();
  for (const p of pages)
    await p.waitForFunction(() => smash.net.state === "paused");
  const pausedFrame = await a.evaluate(() => smash.net.frame);
  await sleep(300);
  assert.equal(await a.evaluate(() => smash.net.frame), pausedFrame);
  await b.locator('[data-close="controls-dialog"]').click();
  await a.waitForFunction(
    () => smash.net.running && smash.net.frame > 120,
    {},
    { timeout: 45000 },
  );
  record("Controller setup pauses both peers and resumes in sync");
  await b.locator("#leave-room").click();
  await a.waitForFunction(() => smash.net.state === "waiting");
  await sleep(2400);
  assert.equal(await a.evaluate(() => smash.net.state), "waiting");
  await b.locator("#invite-input").fill(token);
  await b.locator("#join-room").click();
  await a.waitForFunction(
    () => smash.net.running && smash.net.frame > 180,
    {},
    { timeout: 45000 },
  );
  record("Guest disconnect and invitation reuse retain the match");
  report.finalMultiplayer = await Promise.all(
    pages.map((p) =>
      p.evaluate(() => ({
        ...smash.diagnostics(),
        transport: smash.net.channel?.readyState,
      })),
    ),
  );
  await a.locator("#leave-room").click();
  await b.waitForFunction(() => smash.net.state === "error");
  await b.locator("#leave-room").click();
  record("Host leaving closes the room cleanly");
  const savedHash = await a.evaluate(() => smash.engine.hash());
  await a.locator("#save").click();
  await a.waitForFunction(() =>
    document.getElementById("toast").textContent.includes("Progress saved"),
  );
  const downloadEvent = a.waitForEvent("download");
  await a.locator("#export-save").click();
  const download = await downloadEvent;
  const savePath = path.join(dir, "qa-progress.smash64");
  await download.saveAs(savePath);
  await a.evaluate(() => {
    const restore = smash.engine.restore.bind(smash.engine);
    smash.engine.restore = (bytes) => {
      restore(bytes);
      window.qaRestoredHash = smash.engine.hash();
    };
  });
  await a.locator("#load-save").click();
  await a.waitForFunction(() => window.qaRestoredHash);
  assert.equal(await a.evaluate(() => qaRestoredHash), savedHash);
  await a.locator("#pause").click();
  await a.evaluate(() => (window.qaRestoredHash = null));
  await a.locator("#save-file").setInputFiles(savePath);
  await a.waitForFunction(() => window.qaRestoredHash);
  assert.equal(await a.evaluate(() => qaRestoredHash), savedHash);
  record("Local save/load and exported save round trip");
  await a.reload();
  await a.waitForFunction(() => !document.getElementById("rom-loaded").hidden);
  assert.equal(await a.evaluate(() => smash.engine.loaded), false);
  assert.equal(
    await a.evaluate(
      () => smash.controls.saved["QA N64 USB adapter"].map.a.index,
    ),
    7,
  );
  record("ROM and custom controller profile survive reload");
  assert.deepEqual(report.errors, []);
  record("No uncaught browser errors");
  report.passed = true;
} catch (e) {
  report.passed = false;
  report.failure = e.stack;
  console.error(e);
  for (const [i, p] of pages.entries())
    try {
      await p.screenshot({
        path: path.join(dir, `failure-${i}.png`),
        fullPage: true,
      });
    } catch {}
  process.exitCode = 1;
} finally {
  report.finished = new Date().toISOString();
  await writeFile(
    path.join(dir, "e2e-report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  await browser.close();
}
