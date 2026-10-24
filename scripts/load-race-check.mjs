import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { browserHelpers } from "./browser-helpers.mjs";
if (!process.env.SMASH_ROM)
  throw Error("Set SMASH_ROM to your original US cartridge.");
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
const pages = [],
  errors = [],
  report = { errors };
const { openPage, browse, scene, wait, boot } = browserHelpers(browser, {
  url,
  pages,
  errors,
});
try {
  await mkdir("artifacts", { recursive: true });
  const host = await openPage();
  await browse(host);
  await host.locator("#create-open").click();
  await host.locator("#visibility").selectOption("private");
  await host.locator("#create-room").click();
  await scene(host, 9);
  await host.locator('[data-native-input="a"]').click();
  await scene(host, 16);
  await host.waitForFunction(() => smash.net.running);
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  await context.addInitScript(() => {
    Object.defineProperty(document, "hidden", { get: () => false });
    Object.defineProperty(navigator, "getGamepads", {
      value: () => [],
      configurable: true,
    });
  });
  // Let a manual file selection finish while the host download is pending.
  await context.route("**/api/testing/cartridge", async (route) => {
    const response = await route.fetch();
    await new Promise((resolve) => setTimeout(resolve, 800));
    await route.fulfill({ response });
  });
  const guest = await context.newPage();
  pages.push(guest);
  guest.on("pageerror", (e) => errors.push(e.message));
  await guest.goto(
    url + "/#room=" + (await host.evaluate(() => smash.net.token)),
  );
  await guest.waitForFunction(() => window.smash);
  await guest.evaluate(() => {
    window.qaRogueFrames = 0;
    const frame = smash.engine.frame.bind(smash.engine);
    smash.engine.frame = (inputs) => {
      if (smash.net.running && inputs.length !== 4) qaRogueFrames++;
      return frame(inputs);
    };
  });
  await guest.locator("#join-name").fill("Load race check");
  await guest.locator("#join-room").click();
  await guest.locator("#rom-file").setInputFiles(process.env.SMASH_ROM);
  await boot(guest);
  await guest.waitForFunction(() => smash.net.running, null, {
    timeout: 90000,
  });
  await wait(5000);
  report.guest = await guest.evaluate(() => ({
    rogueFrames: qaRogueFrames,
    view: smash.view,
    scene: smash.engine.inspect().scene,
    state: smash.net.state,
    matches: smash.net.matches,
    members: smash.net.connected.length,
  }));
  report.repairs = await host.evaluate(() => smash.net.repairs);
  assert.equal(report.guest.rogueFrames, 0);
  assert.equal(report.guest.view, "game");
  assert.equal(report.guest.scene, 16);
  assert.equal(report.guest.state, "playing");
  assert.equal(report.guest.members, 2);
  assert.ok(report.guest.matches >= 3);
  assert.equal(report.repairs, 0);
  assert.deepEqual(errors, []);
  console.log(
    "PASS overlapping automatic/manual load joins once, never runs local menu frames online, and stays synchronized",
    JSON.stringify(report),
  );
} catch (error) {
  report.failure = error.stack;
  console.error(error);
  process.exitCode = 1;
} finally {
  await writeFile(
    "artifacts/load-race-check.json",
    JSON.stringify(report, null, 2),
  );
  await browser.close();
}
