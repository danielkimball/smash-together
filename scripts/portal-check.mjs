import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
const url = process.env.SMASH_URL || "http://localhost:8790";
const rom =
  process.env.SMASH_ROM ||
  "/Users/dankimball/Desktop/Super Smash Bros. (U) [!].z64";
const errors = [],
  checks = [];
const record = (name) => {
  checks.push(name);
  console.log("PASS", name);
};
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
await mkdir("artifacts", { recursive: true });
const context = await browser.newContext({
  viewport: { width: 1600, height: 1000 },
});
await context.addInitScript(() => {
  Object.defineProperty(navigator, "getGamepads", {
    configurable: true,
    value: () => window.testPads || [],
  });
});
const p = await context.newPage();
p.on("pageerror", (e) => errors.push(e.message));
async function shot(name) {
  await p.screenshot({ path: `artifacts/portal-${name}.png`, fullPage: true });
}
async function fits() {
  assert.ok(
    await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    "No horizontal overflow",
  );
}
try {
  await p.goto(url);
  await p.waitForFunction(
    () =>
      window.smash &&
      document.getElementById("attract-opening").currentTime > 1,
  );
  await p.evaluate(() => document.fonts.ready);
  await shot("opening");
  assert.equal(await p.evaluate(() => smash.engine.loaded), false);
  await p.keyboard.press("KeyQ");
  await p.waitForFunction(() => smash.attract.phase === "title");
  await p.waitForFunction(
    () => document.getElementById("attract-title").currentTime > 1,
  );
  await shot("title");
  await p.keyboard.press("Enter");
  await p.waitForSelector("#rom-dialog[open]");
  assert.equal(
    await p.evaluate(() => document.getElementById("attract-title").loop),
    true,
  );
  await shot("rom");
  record(
    "Original opening → any key → fiery title → ROM overlay; no cartridge loaded before verification",
  );
  await p.locator("#rom-dialog [data-close]").click();
  await p.evaluate(() => {
    const v = document.getElementById("attract-title");
    v.currentTime = v.duration - 0.3;
  });
  await p.waitForFunction(
    () => document.getElementById("attract-title").currentTime < 1,
  );
  await shot("fire-loop");
  assert.equal(await p.evaluate(() => smash.attract.phase), "title");
  assert.equal(await p.locator("#rom-dialog").evaluate((d) => d.open), false);
  record(
    "Idle fire stays silent and loops continuously without a tutorial transition",
  );
  await p.waitForTimeout(400);
  await p.locator("#power-on").click();
  await p.locator("#rom-file").setInputFiles({
    name: "invalid.z64",
    mimeType: "application/octet-stream",
    buffer: Buffer.alloc(64),
  });
  await p.waitForFunction(() =>
    document.getElementById("rom-error").textContent.includes("16 MB"),
  );
  assert.equal(await p.evaluate(() => smash.engine.loaded), false);
  await p.locator("#rom-file").setInputFiles(rom);
  await p.waitForFunction(
    () => smash.view === "native" && !smash.paused,
    null,
    { timeout: 90000 },
  );
  assert.equal(await p.evaluate(() => smash.engine.inspect().scene), 7);
  assert.equal(
    await p.evaluate(() =>
      [...document.querySelectorAll(".attract-display video")].every(
        (v) => v.paused && !v.getAttribute("src"),
      ),
    ),
    true,
  );
  await p.mouse.move(0, 0);
  await shot("mode-select");
  record(
    "Verified local ROM opens actual Mode Select; media downloads and decoders are stopped for gameplay",
  );
  await p.locator("#native-online").click();
  await p.waitForSelector("#browse-screen:not([hidden])");
  await p.waitForFunction(() =>
    document.getElementById("browser-status").textContent.includes("Updated"),
  );
  await fits();
  await shot("lobby-desktop");
  await p.locator("#player-name").fill("Dan");
  await p.mouse.move(0, 0);
  await p.waitForTimeout(200);
  assert.equal(
    await p
      .locator("#create-open")
      .evaluate((b) => getComputedStyle(b).backgroundColor),
    "rgb(130, 130, 170)",
  );
  await p.locator("#create-open").hover();
  await p.waitForFunction(
    () =>
      getComputedStyle(document.getElementById("create-open"))
        .backgroundColor === "rgb(255, 0, 40)",
  );
  assert.equal(
    await p
      .locator("#create-open")
      .evaluate((b) => getComputedStyle(b).backgroundColor),
    "rgb(255, 0, 40)",
  );
  assert.match(
    await p
      .locator("#create-open")
      .evaluate((b) => getComputedStyle(b).fontFamily),
    /Josefin Sans/,
  );
  await p.locator("#create-open").click();
  await p.locator("#room-name").fill("Portal night");
  await shot("create");
  await p.locator("#create-dialog [data-close]").click();
  await p.locator("#join-open").click();
  await shot("join");
  await p.locator("#join-dialog [data-close]").click();
  await p.locator(".header-actions [data-controls]").click();
  await shot("controller");
  await p.locator("#controls-dialog [data-close]").click();
  record(
    "Reference lobby, brand fonts, idle/hover colors, name input and branded create/join/controller modals",
  );
  for (const [name, width, height] of [
    ["phone", 390, 844],
    ["compact", 375, 667],
    ["landscape", 844, 390],
    ["wide", 1920, 1080],
  ]) {
    await p.setViewportSize({ width, height });
    await fits();
    await shot("lobby-" + name);
  }
  await p.setViewportSize({ width: 390, height: 844 });
  await p.locator("#create-open").click();
  await shot("create-phone");
  record(
    "Desktop, phone, compact phone and landscape lobby layouts fit without horizontal scrolling",
  );
  await p.locator("#create-dialog [data-close]").click();
  await p.locator("#brand-home").click();
  await p.waitForFunction(() => smash.view === "native" && !smash.paused);
  await p.locator("#native-single").click();
  await p.waitForFunction(() => smash.engine.inspect().scene === 8, null, {
    timeout: 30000,
  });
  record("1P Mode remains the actual original game menu");
  await p.reload();
  await p.waitForFunction(
    () =>
      window.smash &&
      document.getElementById("cartridge-badge").classList.contains("ready"),
  );
  await p.evaluate(() => {
    window.testPads = [
      {
        id: "Portal test controller",
        index: 0,
        connected: true,
        mapping: "standard",
        axes: [0, 0, 0, 0],
        buttons: Array.from({ length: 17 }, () => ({
          pressed: false,
          touched: false,
          value: 0,
        })),
      },
    ];
    smash.controls.select("0");
    testPads[0].buttons[9] = { pressed: true, value: 1 };
  });
  await p.waitForFunction(() => smash.attract.phase === "title");
  await p.waitForTimeout(600);
  assert.equal(
    await p.evaluate(() => smash.view),
    "home",
    "Holding Start must not skip two screens",
  );
  await p.evaluate(() => {
    testPads[0].buttons[9] = { pressed: false, value: 0 };
  });
  await p.waitForTimeout(100);
  await p.evaluate(() => {
    testPads[0].buttons[0] = { pressed: true, value: 1 };
  });
  await p.waitForFunction(
    () => smash.view === "native" && !smash.paused,
    null,
    { timeout: 90000 },
  );
  await p.waitForTimeout(600);
  assert.equal(
    await p.evaluate(() => smash.engine.inspect().scene),
    7,
    "Holding A through boot must leave the actual Mode Select open",
  );
  await p.evaluate(() => {
    testPads[0].buttons[0] = { pressed: false, value: 0 };
  });
  record(
    "A remembered ROM skips the picker; controller Start/A work and held buttons cannot double-advance",
  );
  assert.deepEqual(errors, []);
} catch (error) {
  await shot("failure").catch(() => {});
  throw error;
} finally {
  await writeFile(
    "artifacts/portal-check.json",
    JSON.stringify(
      { url, date: new Date().toISOString(), checks, errors },
      null,
      2,
    ),
  );
  await browser.close();
}
