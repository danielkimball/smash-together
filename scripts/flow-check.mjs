// Isolated real-emulator regression: never attaches to the player's browser.
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
const url = process.env.SMASH_URL || "http://127.0.0.1:8790";
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH,
  args: [
    "--autoplay-policy=no-user-gesture-required",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
  ],
});
const checks = [],
  errors = [],
  pages = [];
const record = (name, data = {}) => {
  checks.push({ name, ...data });
  console.log("PASS", name, JSON.stringify(data));
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function scene(p, n) {
  await p.waitForFunction(
    (n) =>
      smash.engine.loaded &&
      document.getElementById("busy").hidden &&
      smash.engine.inspect().scene === n,
    n,
    { timeout: 90000 },
  );
}
async function pad(p, index, ms = 130) {
  await p.evaluate((index) => {
    qaPad.buttons[index] = { value: 1, pressed: true };
  }, index);
  await wait(ms);
  await p.evaluate((index) => {
    qaPad.buttons[index] = { value: 0, pressed: false };
  }, index);
  await wait(220);
}
async function act(p, keys, count = 6, settle = 30) {
  await p.evaluate(
    ({ keys, count, settle }) =>
      new Promise((resolve, reject) => {
        const c = smash.controls,
          original = c.sample.bind(c);
        const timer = setTimeout(() => {
          c.sample = original;
          reject(Error("Controller input timed out"));
        }, 60000);
        let first = null,
          localFrame = 0;
        const duration =
          count + Math.max(settle, (smash.net.personalDelay || 0) + 8);
        c.sample = () => {
          const target = smash.net.running
            ? Math.max(0, smash.net.serverFrame + 1) + smash.net.personalDelay
            : localFrame++;
          first ??= target;
          const elapsed = target - first;
          if (elapsed < count) {
            c.keys = new Set(keys);
            const input = original();
            c.keys.clear();
            return input;
          }
          if (elapsed < duration) return { buttons: 0, x: 0, y: 0 };
          c.sample = original;
          clearTimeout(timer);
          resolve();
          return original();
        };
      }),
    { keys, count, settle },
  );
  const scheduled = await p.evaluate(() =>
    smash.net.running ? smash.net.lastSample : null,
  );
  if (scheduled !== null)
    await p.waitForFunction((f) => smash.net.frame > f, scheduled, {
      timeout: 30000,
    });
}
async function create(p) {
  await p.locator("#create-open").click();
  await p.locator("#create-room").click();
  await scene(p, 9);
  await p.locator('[data-native-input="a"]').click();
  await p.waitForFunction(() => smash.net.running, null, { timeout: 90000 });
  await scene(p, 16);
}
async function browse(p) {
  await p.locator("#native-online").click();
  await p.mouse.move(0, 0);
  await p.waitForFunction(() => smash.view === "browse");
}
try {
  await mkdir("artifacts", { recursive: true });
  for (let i = 0; i < 2; i++) {
    const c = await browser.newContext(
      i
        ? {
            viewport: { width: 390, height: 844 },
            isMobile: true,
            hasTouch: true,
          }
        : { viewport: { width: 1440, height: 900 } },
    );
    await c.addInitScript(() => {
      Object.defineProperty(document, "hidden", { get: () => false });
      window.qaPad = null;
      Object.defineProperty(navigator, "getGamepads", {
        configurable: true,
        value: () => (qaPad ? [qaPad] : []),
      });
    });
    const p = await c.newPage();
    pages.push(p);
    p.on("pageerror", (e) => errors.push(e.message));
    await p.goto(url);
    await p.waitForFunction(() => window.smash);
    for (let press = 0; press < 3; press++) {
      if (
        await p.evaluate(
          () =>
            smash.view !== "home" || !document.getElementById("busy").hidden,
        )
      )
        break;
      await p.locator("#power-on").click();
      await p.mouse.move(0, 0);
      await wait(500);
    }
    await scene(p, 7);
    assert.equal(await p.locator("#rom-dialog").isVisible(), false);
    assert.equal(await p.locator("#testing-dialog").isVisible(), false);
  }
  const [a, b] = pages;
  record(
    "Fresh browsers enter real native Mode Select without a ROM or password prompt",
  );
  await browse(a);
  await a.screenshot({ path: "artifacts/flow-logo.png" });
  assert.ok(
    await a
      .locator(".lobby-logo img")
      .evaluate((img) => img.complete && img.naturalWidth > 0),
  );
  await a.evaluate(() => {
    qaPad = {
      id: "0079-0006-DragonRise N64 USB",
      index: 0,
      connected: true,
      mapping: "",
      buttons: Array.from({ length: 16 }, () => ({ value: 0, pressed: false })),
      axes: [0, 0],
    };
  });
  await a.waitForFunction(() => smash.controls.selected === "0");
  await pad(a, 8);
  await scene(a, 7);
  assert.equal(await a.evaluate(() => smash.view), "native");
  await browse(a);
  await create(a);
  await pad(a, 8);
  await a.waitForFunction(() => smash.view === "browse" && !smash.net.room);
  await create(a);
  await a.locator("#selection-back").click();
  await a.waitForFunction(() => smash.view === "browse" && !smash.net.room);
  await create(a);
  const canvas = await a.locator("#canvas").boundingBox();
  await a.mouse.click(
    canvas.x + canvas.width * 0.87,
    canvas.y + canvas.height * 0.04,
  );
  await a.waitForFunction(() => smash.view === "browse" && !smash.net.room);
  record(
    "N64 B exits selection, B exits multiplayer to Mode Select, top-right Back closes the room",
  );
  await a.evaluate(() => {
    qaPad = null;
    smash.controls.select("keyboard");
  });
  await create(a);
  await act(a, ["KeyW"], 28, 12);
  await act(a, ["KeyD"], 8, 12);
  await act(a, ["KeyJ"], 6, 20);
  assert.equal(
    await a.evaluate(() => smash.engine.inspect().players[0].selected),
    true,
  );
  await browse(b);
  await b.locator("#refresh-rooms").click();
  await b.locator(".room-row").first().click();
  await b.waitForFunction(
    () => smash.net.running && smash.net.connected.length === 2,
    null,
    { timeout: 90000 },
  );
  await a.waitForFunction(
    () => smash.net.running && smash.net.connected.length === 2,
    null,
    { timeout: 90000 },
  );
  await b.evaluate(() => smash.controls.touch.setMode("off"));
  await act(b, ["KeyW"], 28, 12);
  await act(b, ["KeyA"], 8, 12);
  await act(b, ["KeyJ"], 6, 20);
  assert.equal(
    await b.evaluate(() => smash.engine.inspect().players[1].selected),
    true,
  );
  await a.evaluate(() => {
    qaPad = {
      id: "0079-0006-DragonRise N64 USB",
      index: 0,
      connected: true,
      mapping: "",
      buttons: Array.from({ length: 16 }, () => ({ value: 0, pressed: false })),
      axes: [0, 0],
    };
    smash.controls.select("0");
  });
  await pad(a, 9);
  await scene(a, 21);
  await wait(600);
  await pad(a, 6);
  await scene(a, 22);
  await scene(b, 22);
  record("Mapped N64 Start starts the real match; native A picks the stage");
  await wait(3000);
  const before = await a.evaluate(() => ({
    frame: smash.net.frame,
    matches: smash.net.matches,
    repairs: smash.net.repairs,
  }));
  // Hold only the guest's incoming frame delivery and outgoing inputs for two seconds.
  await b.evaluate(() => {
    const n = smash.net;
    window.heldFrames = [];
    window.realReceive = n.receiveFrame.bind(n);
    window.realSend = n.sendGame.bind(n);
    n.receiveFrame = (m) => heldFrames.push(m);
    n.sendGame = (m, ...args) => {
      if (m.type !== "input") realSend(m, ...args);
    };
  });
  await wait(2200);
  const during = await a.evaluate(() => ({
    frame: smash.net.frame,
    late: smash.net.lateInputs,
    fps: smash.diagnostics().fps,
  }));
  assert.ok(
    during.frame - before.frame >= 105,
    JSON.stringify({ before, during }),
  );
  assert.ok(during.late > 0);
  await b.evaluate(() => {
    smash.net.receiveFrame = realReceive;
    smash.net.sendGame = realSend;
    heldFrames.forEach(realReceive);
  });
  await wait(5000);
  const after = await a.evaluate(() => ({
    frame: smash.net.frame,
    matches: smash.net.matches,
    repairs: smash.net.repairs,
  }));
  const guestFrame = await b.evaluate(() => smash.net.frame);
  assert.equal(after.repairs, before.repairs);
  assert.ok(after.matches > before.matches);
  assert.ok(Math.abs(after.frame - guestFrame) < 12);
  record(
    "One player stalled for two seconds: other player keeps moving, guest catches up, matching states without repair",
    { before, during, after, guestFrame },
  );
  await b.evaluate(() => {
    smash.controls.touch.setMode("auto");
    qaPad = {
      id: "0079-0006-DragonRise N64 USB",
      index: 0,
      connected: true,
      buttons: Array.from({ length: 16 }, () => ({ value: 0, pressed: false })),
      axes: [0, 0],
    };
  });
  await b.waitForFunction(() => !smash.controls.touch.enabled);
  assert.ok(await b.locator("#phone-tools").isVisible());
  await b.locator("[data-touch-toggle]").tap();
  assert.equal(await b.evaluate(() => smash.controls.touch.enabled), true);
  await b.locator("[data-touch-toggle]").tap();
  assert.equal(await b.evaluate(() => smash.controls.touch.enabled), false);
  await b.locator("#phone-tools [data-fullscreen]").tap();
  await b.waitForFunction(
    () =>
      !!document.fullscreenElement ||
      document.getElementById("fullscreen-help").open,
  );
  await b.screenshot({ path: "artifacts/flow-phone-portrait.png" });
  await b.setViewportSize({ width: 844, height: 390 });
  await b.screenshot({ path: "artifacts/flow-phone-landscape.png" });
  record(
    "Phone hides touch controller on USB connection; visible toggles restore/hide it and fullscreen opens",
  );
  await a.evaluate(() => document.getElementById("game-menu").click());
  await a.locator("#back-lobby").click();
  for (const p of [a, b])
    await p.waitForFunction(
      () => smash.net.running && smash.net.room.selecting,
    );
  await b.evaluate(() => {
    smash.controls.select("keyboard");
    smash.controls.touch.setMode("off");
  });
  await act(b, ["KeyW"], 28, 12);
  await act(b, ["KeyA"], 8, 12);
  await act(b, ["KeyJ"], 6, 20);
  assert.equal(
    await b.evaluate(() => smash.engine.inspect().players[1].selected),
    true,
  );
  await b.keyboard.down("KeyK");
  await wait(130);
  await b.keyboard.up("KeyK");
  await wait(350);
  assert.equal(
    await b.evaluate(() => smash.engine.inspect().players[1].selected),
    false,
  );
  assert.equal(await b.evaluate(() => !!smash.net.room), true);
  await b.keyboard.press("KeyK");
  await b.waitForFunction(() => smash.view === "browse" && !smash.net.room);
  await a.waitForFunction(
    () => smash.net.running && smash.net.connected.length === 1,
  );
  record(
    "B recalls a selected fighter; a separate B leaves only the guest and keeps the host room open",
  );
  assert.deepEqual(errors, []);
} catch (e) {
  console.error(e);
  for (const [i, p] of pages.entries()) {
    console.error(
      i,
      await p
        .evaluate(() => ({
          view: smash?.view,
          state: smash?.net.state,
          paused: smash?.paused,
          message: smash?.net.message,
          info: smash?.engine.loaded ? smash.engine.inspect() : null,
        }))
        .catch(() => null),
    );
    await p
      .screenshot({ path: `artifacts/flow-fail-${i}.png` })
      .catch(() => {});
  }
  process.exitCode = 1;
} finally {
  await writeFile(
    process.env.SMASH_REPORT || "artifacts/flow-check.json",
    JSON.stringify({ url, passed: !process.exitCode, checks, errors }, null, 2),
  );
  await browser.close();
}
