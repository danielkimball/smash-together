import { chromium } from "playwright";
import assert from "node:assert/strict";
import { writeFile, mkdir } from "node:fs/promises";
const url = process.env.SMASH_URL || "http://127.0.0.1:8787";
const rom = process.env.SMASH_ROM;
if (!rom) throw Error("Set SMASH_ROM to your own original US ROM.");
const { shareUrl, publicUrl } = await (await fetch(url + "/api/status")).json();
if (!shareUrl)
  throw Error("Internet sharing is required for this invite-flow check.");
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.CHROME_PATH ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  args: [
    "--autoplay-policy=no-user-gesture-required",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
  ],
});
const errors = [],
  checks = [];
async function wait(p, state) {
  await p.waitForFunction((s) => smash.net.state === s, state, {
    timeout: 180000,
  });
}
const record = (name) => {
  checks.push(name);
  console.log("PASS", name);
};
try {
  const contexts = await Promise.all([
    browser.newContext(),
    browser.newContext(),
  ]);
  for (const c of contexts)
    await c.addInitScript(
      () => (
        Object.defineProperty(document, "hidden", { get: () => false }),
        Object.defineProperty(navigator, "getGamepads", {
          configurable: true,
          value: () => [],
        })
      ),
    );
  const [a, bPage] = await Promise.all(contexts.map((c) => c.newPage()));
  const b = bPage;
  for (const p of [a, b]) p.on("pageerror", (e) => errors.push(e.message));
  await a.goto(url);
  await a.keyboard.press("Enter");
  await a.locator("#rom-file").setInputFiles(rom);
  await a.waitForFunction(
    () => smash.view === "native" && !smash.paused,
    null,
    { timeout: 90000 },
  );
  await a.locator("#native-online").click();
  await a.locator("#player-name").fill("Dan");
  await a.locator("#create-open").click();
  await a.locator("#room-name").fill("Invite flow check");
  await a.locator("#visibility").selectOption("private");
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
  await wait(a, "playing");
  const token = await a.evaluate(() => smash.net.token);
  assert.ok(
    !(await (await fetch(url + "/api/rooms")).text()).includes(
      "Invite flow check",
    ),
  );
  await a.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text) => {
          window.qaInvite = text;
        },
      },
    }),
  );
  await a.locator("#copy-invite").click();
  await a.waitForFunction(() => window.qaInvite);
  const link = await a.evaluate(() => qaInvite);
  assert.equal(
    link,
    `${(publicUrl || shareUrl).replace(/\/$/, "")}/#room=${token}`,
  );
  record(
    "Multiplayer prompts for local ROM and copies the public invite from localhost",
  );
  await a.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw Error("Clipboard unavailable");
        },
      },
    }),
  );
  await a.locator("#copy-invite").click();
  await a.locator("#invite-dialog").waitFor({ state: "visible" });
  assert.equal(await a.locator("#invite-link").inputValue(), link);
  assert.equal(await a.locator("#invite-link").getAttribute("readonly"), "");
  await a.locator("#invite-dialog button.primary").click();
  await wait(a, "playing");
  record(
    "Clipboard denial offers a selected read-only invite without leaving the room",
  );
  await bPage.goto(link);
  assert.equal(bPage.frames().length, 1);
  await b.locator("#join-dialog").waitFor({ state: "visible" });
  await b.locator("#join-name").fill("Brother");
  await b.locator("#join-room").click();
  await b.locator("#rom-dialog").waitFor({ state: "visible" });
  await b.locator("#rom-dialog [data-testing]").click();
  await b
    .locator("#testing-password")
    .pressSequentially(process.env.SMASH_TEST_PASSWORD);
  await b.locator("#testing-password").press("Enter");
  await wait(b, "playing");
  await a.waitForFunction(() => smash.net.room.members.length === 2);
  assert.equal(await b.evaluate(() => smash.net.token), token);
  assert.equal(await b.evaluate(() => smash.net.me.name), "Brother");
  record(
    "A fresh invited browser names itself, loads its ROM, and reaches the live character-selection room",
  );
  await a.waitForFunction(() => smash.net.running && smash.net.frame > 60);
  await a.evaluate(() => document.getElementById("game-menu").click());
  await a.locator("#back-lobby").click();
  await a.waitForFunction(
    () => smash.net.running && smash.net.room.match === 2,
  );
  await b.waitForFunction(
    () => smash.net.running && smash.net.room.match === 2,
  );
  assert.equal(await a.evaluate(() => smash.engine.inspect().scene), 16);
  record(
    "Rematch returns everyone directly to an open character-selection room",
  );
  await a.evaluate(() => {
    window.qaPad = {
      id: "QA Xbox controller",
      index: 0,
      connected: true,
      mapping: "standard",
      axes: [0, 0, 0, 0],
      buttons: Array.from({ length: 17 }, () => ({ value: 0, pressed: false })),
    };
    Object.defineProperty(navigator, "getGamepads", { value: () => [qaPad] });
  });
  await a.waitForFunction(() => smash.controls.selected === "0");
  await a.evaluate(() => {
    for (const i of [4, 5, 9]) qaPad.buttons[i] = { value: 1, pressed: true };
  });
  await a.locator("#menu-dialog").waitFor({ state: "visible" });
  await wait(b, "paused");
  await a.evaluate(() => {
    for (const i of [4, 5, 9]) qaPad.buttons[i] = { value: 0, pressed: false };
  });
  await a.locator("#resume-menu").click();
  for (const p of [a, b]) await wait(p, "playing");
  record("Mapped controller chord opens the overlay and pauses all players");
  assert.deepEqual(errors, []);
  record("No uncaught browser errors");
} catch (e) {
  process.exitCode = 1;
  errors.push(e.message);
  console.error(e);
} finally {
  await mkdir("artifacts", { recursive: true });
  await writeFile(
    "artifacts/invite-check.json",
    JSON.stringify(
      {
        finished: new Date().toISOString(),
        checks,
        errors,
        passed: !errors.length,
      },
      null,
      2,
    ) + "\n",
  );
  await Promise.race([
    browser.close(),
    new Promise((r) => setTimeout(r, 3000)),
  ]);
  process.exit(process.exitCode || 0);
}
