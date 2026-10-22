import { webkit } from "playwright";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
const browser = await webkit.launch({ headless: true });
const url = process.env.SMASH_URL || "http://localhost:8790";
const errors = [],
  checks = [];
let page;
const record = (n) => {
  checks.push(n);
  console.log("PASS", n);
};
async function frames(n) {
  const f = await page.evaluate(() => smash.engine.frames);
  await page.waitForFunction((f) => smash.engine.frames >= f, f + n, {
    timeout: 90000,
  });
}
async function key(k, n = 5) {
  await page.keyboard.down(k);
  await frames(n);
  await page.keyboard.up(k);
  await frames(20);
}
try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 1,
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "getGamepads", {
      configurable: true,
      value: () => [],
    });
  });
  page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(url);
  await page.locator("#testing-access").tap();
  await page.locator("#testing-password").fill(process.env.SMASH_TEST_PASSWORD);
  await page.locator("#testing-form button[type=submit]").tap();
  await page.waitForFunction(
    () => smash.view === "native" && !smash.paused,
    null,
    { timeout: 120000 },
  );
  assert.equal(
    await page.evaluate(() => smash.engine.inspect().unlocks.fighters),
    4095,
  );
  assert.equal(await page.evaluate(() => smash.controls.touch.enabled), true);
  await frames(30);
  await page.screenshot({ path: "artifacts/webkit-phone-menu.png" });
  record(
    "WebKit phone viewport loads WASM, renders the original menu and unlocks the roster",
  );
  await page.locator(".touch-menu").tap();
  await page.locator("#menu-dialog").waitFor({ state: "visible" });
  await page.locator("#resume-menu").tap();
  await page.waitForFunction(() => !smash.paused);
  await page.locator("#native-online").tap();
  await page.locator("#player-name").fill("WebKit phone");
  await page.locator("#create-open").tap();
  await page.locator("#create-room").tap();
  await page.waitForFunction(
    () =>
      smash.engine.inspect().scene === 9 &&
      !document.getElementById("busy").hidden === false,
    null,
    { timeout: 90000 },
  );
  // A genuine phone touch held for game frames, using WebKit's mouse-backed pointer input.
  await page.locator(".touch-a").hover();
  await page.mouse.down();
  await frames(6);
  await page.mouse.up();
  await page.waitForFunction(() => smash.net.running, null, { timeout: 90000 });
  await frames(40);
  assert.equal(await page.evaluate(() => smash.engine.inspect().scene), 16);
  await key("w", 28);
  await key("a", 10);
  await page.locator(".touch-a").hover();
  await page.mouse.down();
  await frames(6);
  await page.mouse.up();
  await frames(30);
  assert.equal(
    await page.evaluate(() => smash.engine.inspect().players[0].selected),
    true,
  );
  await page.screenshot({ path: "artifacts/webkit-phone-lobby.png" });
  record(
    "WebKit creates a multiplayer room and selects an unlocked fighter through the touch controller",
  );
  await page.setViewportSize({ width: 844, height: 390 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: "artifacts/webkit-landscape-lobby.png" });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await page.locator(".touch-menu").tap();
  await page.locator("#resume-menu").tap();
  await page.waitForFunction(() => smash.net.running, null, { timeout: 90000 });
  record(
    "WebKit landscape layout fits the viewport and shared Menu/resume works",
  );
  assert.deepEqual(errors, []);
} catch (e) {
  console.error(e);
  errors.push(e.stack);
  if (page) {
    await page
      .screenshot({ path: "artifacts/webkit-failure.png" })
      .catch(() => {});
    console.error(
      await page
        .evaluate(() => ({
          view: smash?.view,
          state: smash?.net.state,
          info: smash?.engine.loaded ? smash.engine.inspect() : null,
        }))
        .catch(() => null),
    );
  }
  process.exitCode = 1;
} finally {
  await writeFile(
    "artifacts/webkit-check.json",
    JSON.stringify(
      { finished: new Date().toISOString(), url, checks, errors },
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
