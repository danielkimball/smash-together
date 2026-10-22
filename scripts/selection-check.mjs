// Focused live-room behavior: renaming, departure, replacement and menu routing.
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
const url = process.env.SMASH_URL || "http://localhost:8787",
  rom = process.env.SMASH_ROM;
if (!rom) throw Error("Set SMASH_ROM to your own US ROM.");
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
const checks = [],
  errors = [],
  pages = [];
const record = (name) => {
  checks.push(name);
  console.log("PASS", name);
};
async function play(p) {
  await p.waitForFunction(() => smash.net.running, null, { timeout: 90000 });
}
async function act(p, input, count = 6, settle = 30) {
  await p.evaluate(
    ({ input, count, settle }) =>
      new Promise((resolve, reject) => {
        const c = smash.controls,
          original = c.sample.bind(c);
        let n = 0;
        const timer = setTimeout(() => {
          c.sample = original;
          reject(Error("Input timed out"));
        }, 60000);
        c.sample = () => {
          if (n++ < count) return input;
          if (n < count + settle) return { buttons: 0, x: 0, y: 0 };
          c.sample = original;
          clearTimeout(timer);
          resolve();
          return original();
        };
      }),
    { input: { buttons: 0, x: 0, y: 0, ...input }, count, settle },
  );
}
try {
  for (let i = 0; i < 2; i++) {
    const c = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    await c.addInitScript(
      () => (
        Object.defineProperty(document, "hidden", { get: () => false }),
        Object.defineProperty(navigator, "getGamepads", {
          configurable: true,
          value: () => [],
        })
      ),
    );
    const p = await c.newPage();
    p.on("pageerror", (e) => errors.push(e.message));
    pages.push(p);
    await p.goto(url);
    await p.keyboard.press("Enter");
    await p.locator("#rom-file").setInputFiles(rom);
    await p.waitForFunction(
      () => smash.view === "native" && !smash.paused,
      null,
      { timeout: 90000 },
    );
    await p.locator("#native-online").click();
    await p.locator("#player-name").fill(i ? "Brother" : "Dan");
  }
  const [a, b] = pages;
  await a.locator("#create-open").click();
  await a.locator("#room-name").fill("Selection continuity");
  await a.locator("#create-room").click();
  await a.waitForFunction(
    () =>
      !document.getElementById("room-setup").hidden &&
      document.getElementById("busy").hidden &&
      smash.engine.inspect().scene === 9,
    null,
    { timeout: 90000 },
  );
  await a.locator('[data-native-input="a"]').click();
  await play(a);
  await b.locator("#refresh-rooms").click();
  await b
    .locator(".room-row")
    .filter({ hasText: "Selection continuity" })
    .click();
  await play(b);
  await play(a);
  await act(a, { y: 85 }, 28, 12);
  await act(a, { x: 85 }, 8, 12);
  await act(a, { buttons: 128 });
  await act(b, { y: 85 }, 28, 12);
  await act(b, { x: 85 }, 3, 12);
  await act(b, { buttons: 128 });
  assert.ok(
    await a.evaluate(() =>
      smash.engine
        .inspect()
        .players.slice(0, 2)
        .every((p) => p.selected),
    ),
  );
  const beforeRename = await a.evaluate(() => ({
    match: smash.net.room.match,
    revision: smash.net.room.revision,
    epoch: smash.net.epoch,
    frame: smash.net.frame,
  }));
  assert.equal(await b.locator("#rename-open").isVisible(), false);
  await a.locator("#rename-open").click();
  assert.equal(
    await a.locator("#rename-name").inputValue(),
    "Selection continuity",
  );
  await a.locator("#rename-name").fill("Brothers Arena");
  await a.locator("#rename-name").press("Enter");
  for (const p of pages)
    await p.waitForFunction(
      () =>
        document.getElementById("room-title").textContent === "Brothers Arena",
    );
  const afterRename = await a.evaluate(() => ({
    match: smash.net.room.match,
    revision: smash.net.room.revision,
    epoch: smash.net.epoch,
    frame: smash.net.frame,
    selected: smash.engine
      .inspect()
      .players.slice(0, 2)
      .every((p) => p.selected),
    running: smash.net.running,
  }));
  assert.equal(afterRename.match, beforeRename.match);
  assert.equal(afterRename.revision, beforeRename.revision);
  assert.equal(afterRename.epoch, beforeRename.epoch);
  assert.ok(afterRename.frame >= beforeRename.frame);
  assert.equal(afterRename.selected, true);
  assert.equal(afterRename.running, true);
  assert.ok(
    (await (await fetch(url + "/api/rooms")).json()).rooms.some(
      (r) => r.name === "Brothers Arena",
    ),
  );
  await mkdir("artifacts", { recursive: true });
  await a.screenshot({ path: "artifacts/rename-room-desktop.png" });
  await a.setViewportSize({ width: 390, height: 844 });
  assert.equal(await a.locator("#rename-open").isVisible(), true);
  await a.screenshot({ path: "artifacts/rename-room-mobile.png" });
  await a.setViewportSize({ width: 1440, height: 900 });
  record(
    "Host renames the room for everyone and the directory without resetting fighters or synchronization; guests have no rename button",
  );
  await b.evaluate(() => document.getElementById("game-menu").click());
  await b.locator("#quit-game").click();
  await a.waitForFunction(
    () => smash.net.running && smash.net.room.members.length === 1,
    null,
    { timeout: 60000 },
  );
  const retained = await a.evaluate(() => smash.engine.inspect());
  assert.equal(retained.players[0].selected, true);
  assert.equal(retained.players[1].selected, false);
  assert.equal(retained.players[1].holding, false);
  record(
    "Explicit leave recalls and parks only the departed token; host fighter stays selected",
  );
  await b.locator("#refresh-rooms").click();
  await b.locator(".room-row").filter({ hasText: "Brothers Arena" }).click();
  await play(b);
  await play(a);
  assert.equal(await b.evaluate(() => smash.net.player), 1);
  await act(b, { y: 85 }, 28, 12);
  await act(b, { buttons: 128 });
  assert.equal(
    await b.evaluate(() => smash.engine.inspect().players[1].selected),
    true,
  );
  assert.equal(await a.locator("#start-game").isEnabled(), true);
  record(
    "A replacement receives the freed controller port and can choose a fighter",
  );
  await a.evaluate(() => document.getElementById("game-menu").click());
  await a.locator("#rename-menu").click();
  await a.locator("#rename-name").fill("One more match");
  await a.locator("#rename-save").click();
  await b.waitForFunction(() => smash.net.room.name === "One more match");
  assert.equal(await a.locator("#menu-dialog").isVisible(), true);
  record("Pause-menu Rename updates the room and returns to the existing menu");
  await a.locator("#quit-game").click();
  await a.locator("[data-home]").click();
  await a.waitForFunction(
    () => smash.view === "native" && !smash.paused,
    null,
    { timeout: 90000 },
  );
  await a.locator("#native-single").click();
  await a.waitForFunction(() => smash.view === "game");
  assert.equal(await a.evaluate(() => smash.engine.inspect().scene), 8);
  record("Single player click enters the original 1P Mode menu");
  await a.keyboard.press("Escape");
  await a.locator("#quit-game").click();
  await a.waitForFunction(() => smash.view === "native" && !smash.paused);
  assert.equal(await a.evaluate(() => smash.engine.inspect().scene), 7);
  assert.equal(
    await a.evaluate(() => GL.currentContext.GLctx.isContextLost()),
    false,
  );
  record(
    "Leaving single player returns to the native main menu with live graphics",
  );
  assert.deepEqual(errors, []);
} catch (e) {
  console.error(e);
  errors.push(e.message);
  process.exitCode = 1;
  for (const [i, p] of pages.entries())
    await p
      .screenshot({ path: `artifacts/selection-fail-${i}.png` })
      .catch(() => {});
} finally {
  await mkdir("artifacts", { recursive: true });
  await writeFile(
    "artifacts/selection-check.json",
    JSON.stringify(
      {
        finished: new Date().toISOString(),
        checks,
        errors,
        passed: !errors.length,
      },
      null,
      2,
    ),
  );
  await Promise.race([
    browser.close(),
    new Promise((r) => setTimeout(r, 3000)),
  ]);
  process.exit(process.exitCode || 0);
}
