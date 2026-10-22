import { chromium } from "playwright";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
const url = process.env.SMASH_URL || "http://localhost:8790";
const browser = await chromium.launch({
  headless: true,
  executablePath:
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  args: ["--autoplay-policy=user-gesture-required"],
});
const checks = [],
  errors = [];
try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "getGamepads", {
      configurable: true,
      value: () => window.testPads || [],
    });
    const play = HTMLMediaElement.prototype.play;
    // Deterministically exercise the browser's audible-autoplay rejection.
    HTMLMediaElement.prototype.play = function () {
      if (!this.muted && !navigator.userActivation.hasBeenActive)
        return Promise.reject(
          new DOMException("Click to play sound", "NotAllowedError"),
        );
      return play.call(this);
    };
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(url);
  await page.waitForFunction(
    () =>
      window.smash?.attract.audioBlocked &&
      document.getElementById("attract-opening").currentTime > 0.2,
  );
  assert.equal(
    await page.locator("#attract-hint").textContent(),
    "PLAY INTRO WITH SOUND",
  );
  await page.locator("#power-on").click();
  await page.waitForFunction(
    () =>
      !smash.attract.audioBlocked &&
      !document.getElementById("attract-opening").muted &&
      !document.getElementById("attract-opening").paused,
  );
  assert.equal(await page.evaluate(() => smash.attract.phase), "opening");
  checks.push(
    "A click replays the blocked original opening with sound instead of silently skipping it",
  );
  await page.waitForTimeout(400);
  await page.locator("#power-on").click();
  await page.waitForFunction(() => smash.attract.phase === "title");
  assert.equal(
    await page.locator("#attract-title").evaluate((v) => v.muted && v.loop),
    true,
  );
  checks.push("The following title is a silent fire loop");
  await page.evaluate(() => {
    document.getElementById("name-dialog").showModal();
    document.querySelector("#name-keys button").focus();
  });
  await page.evaluate(() => document.fonts.ready);
  const clipped = await page
    .locator("#name-keys button")
    .evaluateAll((buttons) =>
      buttons
        .filter((button) => {
          const range = document.createRange();
          range.selectNodeContents(button);
          return range.getBoundingClientRect().width > button.clientWidth + 1;
        })
        .map((button) => button.textContent),
    );
  assert.deepEqual(clipped, []);
  await page.screenshot({
    path: "artifacts/refinements-name-keyboard-phone.png",
  });
  checks.push("Every controller keyboard label fits on a phone");
  await context.close();
  const padContext = await browser.newContext();
  await padContext.addInitScript(() => {
    window.testPad = {
      id: "Test Xbox",
      index: 0,
      connected: true,
      mapping: "standard",
      axes: [0, 0, 0, 0],
      buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
    };
    Object.defineProperty(navigator, "getGamepads", {
      configurable: true,
      value: () => [testPad],
    });
  });
  const padPage = await padContext.newPage();
  padPage.on("pageerror", (e) => errors.push(e.message));
  await padPage.goto(url);
  await padPage.waitForFunction(() => window.smash);
  for (const phase of ["title", "rom"]) {
    await padPage.evaluate(
      () => (testPad.buttons[9] = { pressed: true, value: 1 }),
    );
    if (phase === "title")
      await padPage.waitForFunction(() => smash.attract.phase === "title");
    else await padPage.waitForSelector("#rom-dialog[open]");
    await padPage.evaluate(
      () => (testPad.buttons[9] = { pressed: false, value: 0 }),
    );
    await padPage.waitForTimeout(400);
  }
  checks.push(
    "Controller-only startup reaches the ROM modal under strict autoplay policy",
  );
  assert.deepEqual(errors, []);
  for (const check of checks) console.log("PASS", check);
} catch (error) {
  errors.push(error.message);
  throw error;
} finally {
  await writeFile(
    "artifacts/portal-autoplay.json",
    JSON.stringify(
      { date: new Date().toISOString(), url, checks, errors },
      null,
      2,
    ),
  );
  await browser.close();
}
