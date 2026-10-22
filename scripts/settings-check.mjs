import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
const url = process.env.SMASH_URL || "http://localhost:8790";
const browser = await chromium.launch({
  headless: true,
  executablePath:
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  args: [
    "--autoplay-policy=no-user-gesture-required",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
  ],
});
const pages = [],
  checks = [],
  errors = [];
const record = (name) => {
  checks.push(name);
  console.log("PASS", name);
};
async function native(p, action) {
  const before = await p.evaluate(() => smash.engine.frames);
  await p.locator(`[data-native-input="${action}"]`).click();
  await p.waitForFunction((f) => smash.engine.frames > f + 22, before, {
    timeout: 30000,
  });
}
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
async function act(p, keys, count = 6, settle = 30) {
  await p.evaluate(
    ({ keys, count, settle }) =>
      new Promise((resolve, reject) => {
        const c = smash.controls,
          original = c.sample.bind(c);
        let active = count,
          quiet = settle;
        const timeout = setTimeout(() => {
          c.sample = original;
          reject(Error("Input timed out"));
        }, 90000);
        c.sample = () => {
          if (active-- > 0) {
            c.keys = new Set(keys);
            const input = original();
            c.keys.clear();
            return input;
          }
          if (quiet-- > 0) return { buttons: 0, x: 0, y: 0 };
          c.sample = original;
          clearTimeout(timeout);
          resolve();
          return original();
        };
      }),
    { keys, count, settle },
  );
}

try {
  for (let i = 0; i < 2; i++) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    await context.addInitScript(
      () => (
        Object.defineProperty(document, "hidden", { get: () => false }),
        Object.defineProperty(navigator, "getGamepads", {
          configurable: true,
          value: () => [],
        })
      ),
    );
    const p = await context.newPage();
    pages.push(p);
    p.on("pageerror", (e) => errors.push(e.message));
    await p.goto(url);
    await p.locator("#testing-access").click();
    await p
      .locator("#testing-password")
      .pressSequentially(process.env.SMASH_TEST_PASSWORD);
    await p.locator("#testing-password").press("Enter");
    await p.waitForFunction(
      () => smash.view === "native" && !smash.paused,
      null,
      { timeout: 90000 },
    );
    await p.locator("#native-online").click();
    await p.locator("#player-name").fill("");
    await p.locator("#player-name").pressSequentially(i ? "Brother" : "Dan");
    assert.equal(
      await p.locator("#player-name").inputValue(),
      i ? "Brother" : "Dan",
    );
  }
  record(
    "Password testing access loads the host cartridge without a file picker; real name typing works after emulation starts",
  );
  const [a, b] = pages;
  await a.locator("#create-open").click();
  await a.locator("#room-name").fill("");
  await a.locator("#room-name").pressSequentially("Rules check");
  assert.equal(await a.locator("#room-name").inputValue(), "Rules check");
  await a.locator("#create-room").click();
  await scene(a, 9);
  await a.screenshot({ path: "artifacts/native-rules.png" });
  await native(a, "down");
  await native(a, "right"); // Stock
  await native(a, "down");
  await native(a, "right"); // Four lives
  assert.equal(await a.evaluate(() => smash.engine.inspect().menu.lives), 4);
  await native(a, "down");
  await native(a, "a");
  await scene(a, 10);
  assert.equal(
    await a.evaluate(() => smash.engine.inspect().menu.hasItems),
    true,
  );
  await a.screenshot({ path: "artifacts/native-vs-options.png" });
  await native(a, "up");
  await native(a, "a");
  await scene(a, 11); // wrap to Item Switch
  await native(a, "left");
  await native(a, "left");
  await native(a, "left");
  assert.equal(await a.evaluate(() => smash.engine.inspect().menu.items), 0);
  await a.screenshot({ path: "artifacts/native-item-switch.png" });
  await native(a, "b");
  await scene(a, 10);
  await native(a, "b");
  await scene(a, 9);
  await native(a, "down");
  await native(a, "a");
  await a.waitForFunction(() => smash.net.running, null, { timeout: 90000 });
  const chosen = await a.evaluate(() => smash.engine.inspect().rules);
  assert.equal(chosen.mode, "stock");
  assert.equal(chosen.lives, 4);
  assert.equal(chosen.items, 0);
  record(
    "Actual native VS settings configure Stock, four lives and no items before creating the character-selection room",
  );
  await b.locator("#refresh-rooms").click();
  await b.locator(".room-row").filter({ hasText: "Rules check" }).click();
  await b.waitForFunction(() => smash.net.running, null, { timeout: 90000 });
  assert.deepEqual(
    await b.evaluate(() => smash.engine.inspect().rules),
    chosen,
  );
  record(
    "A joining player receives the exact host-selected rules and native game state",
  );
  await a.locator("#rename-open").click();
  await a.locator("#rename-name").pressSequentially("Brothers Rules");
  await a.locator("#rename-name").press("Enter");
  await b.waitForFunction(() => smash.net.room.name === "Brothers Rules");
  record("Typing and Enter rename the live room for every player");
  for (const [i, p] of [a, b].entries()) {
    await act(p, ["KeyW"], 28, 12);
    await act(p, ["KeyD"], i ? 3 : 8, 12);
    await act(p, ["KeyJ"], 6, 20);
  }
  await a.locator("#start-game").click();
  await scene(a, 21);
  await act(a, [], 0, 110);
  await act(a, ["KeyJ"], 6, 180);
  await scene(a, 22);
  const battle = await a.evaluate(() => {
    const state = smash.engine.snapshot();
    const word = (a) =>
      new DataView(state.buffer).getUint32(448 + (a & 0x7fffff), true);
    const byte = (a) => state[448 + ((a & 0x7fffff) ^ 3)];
    const p = word(0x800a50e8);
    return {
      humans: byte(p + 4),
      mode: byte(p + 3),
      lives: byte(p + 7) + 1,
      items: byte(p + 28),
    };
  });
  assert.deepEqual(battle, { humans: 2, mode: 2, lives: 4, items: 0 });
  await a.screenshot({ path: "artifacts/configured-stock-battle.png" });
  record("Actual two-human battle uses four lives and no items");

  await a.evaluate(() => document.getElementById("game-menu").click());
  await a.locator("#back-lobby").click();
  await a.waitForFunction(
    () => smash.net.running && smash.net.room.match === 2,
    null,
    { timeout: 60000 },
  );
  assert.deepEqual(
    await a.evaluate(() => smash.engine.inspect().rules),
    chosen,
  );
  record("Returning to character selection retains the configured match rules");
  await a.evaluate(() => document.getElementById("game-menu").click());
  await a.locator("#quit-game").click();
  await a.locator("#create-open").click();
  await a.locator("#create-room").click();
  await scene(a, 9);
  await native(a, "down");
  await native(a, "down");
  await native(a, "left");
  await native(a, "left");
  await native(a, "left");
  assert.equal(await a.evaluate(() => smash.engine.inspect().menu.time), 100);
  await native(a, "up");
  await native(a, "up");
  await native(a, "a");
  await a.waitForFunction(() => smash.net.running, null, { timeout: 60000 });
  const unlimited = await a.evaluate(() => smash.engine.inspect().rules);
  assert.equal(unlimited.mode, "time");
  assert.equal(unlimited.time, 100);
  record("Native Time mode accepts the unlimited-time setting");
  assert.deepEqual(errors, []);
} catch (e) {
  errors.push(e.message);
  console.error(e);
  process.exitCode = 1;
  for (const [i, p] of pages.entries())
    await p
      .screenshot({ path: `artifacts/settings-fail-${i}.png` })
      .catch(() => {});
} finally {
  await mkdir("artifacts", { recursive: true });
  await writeFile(
    "artifacts/settings-check.json",
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
