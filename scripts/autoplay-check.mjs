// Native autoplay and BYOR checks in disposable contexts; no real controllers.
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
const url = process.env.SMASH_URL || "http://127.0.0.1:8790";
if (!process.env.SMASH_ROM)
  throw Error("Set SMASH_ROM to your original US cartridge.");
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH,
  args: ["--autoplay-policy=user-gesture-required"],
});
const checks = [],
  errors = [];
const pass = (s) => {
  checks.push(s);
  console.log("PASS", s);
};
async function context() {
  const c = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  await c.addInitScript(() => {
    Object.defineProperty(navigator, "getGamepads", { value: () => [] });
    // Emulate autoplay denial deterministically, independent of Chrome's
    // machine-level media engagement or headless policy exceptions.
    window.qaAudioUnlocked = false;
    document.addEventListener("pointerdown", () => {
      window.qaAudioUnlocked = true;
    });
    const Base = window.AudioContext;
    window.AudioContext = class extends Base {
      constructor(...args) {
        super(...args);
        if (!window.qaAudioUnlocked) this.suspend();
      }
      resume() {
        return window.qaAudioUnlocked ? super.resume() : new Promise(() => {});
      }
    };
  });
  const p = await c.newPage();
  p.on("pageerror", (e) => errors.push(e.message));
  return { c, p };
}
try {
  await mkdir("artifacts", { recursive: true });
  const { c, p } = await context();
  await p.goto(url);
  await p.waitForFunction(
    () =>
      window.smash?.engine.loaded &&
      !document.getElementById("native-opening").hidden,
    null,
    { timeout: 90000 },
  );
  await p.waitForFunction(
    () => document.getElementById("game-sound").hidden === false,
  );
  const before = await p.evaluate(() => smash.engine.frames);
  await p.waitForTimeout(700);
  assert.ok((await p.evaluate(() => smash.engine.frames)) > before + 20);
  await p.locator("#game-sound").click();
  await p.waitForFunction(() => smash.engine.audio.ctx.state === "running");
  assert.ok((await p.evaluate(() => smash.engine.frames)) > before + 20);
  assert.equal(await p.locator("video").count(), 0);
  pass(
    "Blocked sound never blocks native startup; Enable sound resumes audio without replaying the opening",
  );
  await c.close();
  const second = await context();
  await second.c.route("**/api/**", (r) =>
    r.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ testingAutoLoad: false, rooms: [] }),
    }),
  );
  await second.p.goto(url);
  await second.p.waitForFunction(
    () => document.getElementById("rom-dialog").open,
  );
  await second.p
    .locator("#rom-file")
    .setInputFiles({
      name: "invalid.z64",
      mimeType: "application/octet-stream",
      buffer: Buffer.alloc(32),
    });
  await second.p.waitForFunction(
    () => !document.getElementById("rom-error").hidden,
  );
  assert.equal(await second.p.evaluate(() => smash.engine.loaded), false);
  await second.p.locator("#rom-file").setInputFiles(process.env.SMASH_ROM);
  await second.p.waitForFunction(
    () =>
      smash.engine.loaded && !document.getElementById("native-opening").hidden,
    null,
    { timeout: 90000 },
  );
  assert.equal(await second.p.locator("#rom-dialog").isVisible(), false);
  const fileFrames = await second.p.evaluate(() => smash.engine.frames);
  assert.ok(fileFrames < 120);
  pass(
    "BYOR gate rejects invalid files and starts the valid cartridge at its real beginning",
  );
  await second.p.reload();
  await second.p.waitForFunction(
    () =>
      window.smash?.engine.loaded &&
      !document.getElementById("native-opening").hidden,
    null,
    { timeout: 90000 },
  );
  assert.equal(await second.p.locator("#rom-dialog").isVisible(), false);
  assert.ok((await second.p.evaluate(() => smash.engine.frames)) < 120);
  pass(
    "Reload validates the saved cartridge and boots natively without prompting or fast-forwarding",
  );
  await second.c.close();
  assert.deepEqual(errors, []);
} finally {
  await writeFile(
    "artifacts/portal-autoplay.json",
    JSON.stringify({ checks, errors }, null, 2),
  );
  await browser.close();
}
