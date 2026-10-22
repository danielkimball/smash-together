import { chromium } from "playwright";
import assert from "node:assert/strict";
import { writeFile, mkdir } from "node:fs/promises";
const url = process.env.SMASH_URL || "http://127.0.0.1:8787";
const rom = process.env.SMASH_ROM;
if (!rom) throw Error("Set SMASH_ROM to your own original US ROM.");
const { shareUrl } = await (await fetch(url + "/api/status")).json();
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
    timeout: 60000,
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
    await c.addInitScript(() =>
      Object.defineProperty(document, "hidden", { get: () => false }),
    );
  const [a, b] = await Promise.all(contexts.map((c) => c.newPage()));
  for (const p of [a, b]) p.on("pageerror", (e) => errors.push(e.message));
  await a.goto(url);
  await a.locator("#multiplayer").click();
  await a.locator("#player-name").fill("Dan");
  await a.locator("#create-open").click();
  await a.locator("#room-name").fill("Invite flow check");
  await a.locator("#visibility").selectOption("private");
  await a.locator("#create-room").click();
  await a.locator("#rom-dialog").waitFor({ state: "visible" });
  await a.locator("#rom-file").setInputFiles(rom);
  await wait(a, "lobby");
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
  assert.equal(link, `${shareUrl}/#room=${token}`);
  record(
    "Create room prompts for local ROM and copies the public invite from localhost",
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
  assert.equal(await a.evaluate(() => smash.net.state), "lobby");
  record(
    "Clipboard denial offers a selected read-only invite without leaving the room",
  );
  await b.goto(link);
  await b.locator("#join-dialog").waitFor({ state: "visible" });
  await b.locator("#join-name").fill("Brother");
  await b.locator("#join-room").click();
  await b.locator("#rom-dialog").waitFor({ state: "visible" });
  await b.locator("#rom-file").setInputFiles(rom);
  await wait(b, "lobby");
  await a.waitForFunction(() => smash.net.room.members.length === 2);
  assert.equal(await b.evaluate(() => smash.net.token), token);
  assert.equal(await b.evaluate(() => smash.net.me.name), "Brother");
  record(
    "A fresh invited browser names itself, loads its ROM, and reaches the correct waiting lobby",
  );
  for (const p of [a, b]) await p.locator("#ready-button").click();
  await a.locator("#start-game").click();
  await wait(a, "preparing");
  await a.locator("#game-back-lobby").click();
  for (const p of [a, b]) await wait(p, "lobby");
  for (const p of [a, b]) await p.locator("#ready-button").click();
  await a.locator("#start-game").click();
  for (const p of [a, b]) await wait(p, "playing");
  assert.equal(
    await a.evaluate(() => smash.engine.snapshot()[448 + (0xa4ad0 ^ 3)]),
    16,
  );
  record(
    "Cancel startup back to lobby, then start again at multiplayer character selection",
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
} finally {
  await mkdir("artifacts", { recursive: true });
  await writeFile(
    "artifacts/invite-check.json",
    JSON.stringify(
      { finished: new Date().toISOString(), checks, errors },
      null,
      2,
    ) + "\n",
  );
  await browser.close();
}
