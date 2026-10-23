// Isolated browser regression for refresh, room counts and controller setup.
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { browserHelpers } from "./browser-helpers.mjs";

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
  checks = [];
const { wait, boot, browse, openPage, create, join } = browserHelpers(browser, {
  url,
  pages,
  errors,
});
const record = (name) => {
  checks.push(name);
  console.log("PASS", name);
};
const report = { checks, errors, passed: false };
try {
  await mkdir("artifacts", { recursive: true });
  const a = await openPage(),
    b = await openPage(),
    c = await openPage();
  await browse(a);
  await create(a);
  const original = await a.evaluate(() => ({
    id: smash.net.id,
    token: smash.net.token,
    roomId: smash.net.room.id,
  }));
  await join(b, original.token);
  await join(c, original.token);
  await a.waitForFunction(
    () => smash.net.running && smash.net.connected.length === 3,
  );
  const nextHost = await b.evaluate(() => smash.net.id);
  const roomCount = async () =>
    (await (await fetch(url + "/api/rooms")).json()).rooms.find(
      (r) => r.id === original.roomId,
    )?.count;
  assert.equal(await roomCount(), 3);
  await a.reload();
  await b.waitForFunction(
    () =>
      smash.net.isHost && smash.net.running && smash.net.connected.length === 2,
  );
  assert.equal(await roomCount(), 2);
  await b.locator("#game-hud [data-room-panel]").click();
  assert.equal(await b.locator("#room-members .member-row").count(), 2);
  await b.locator('[data-close="players-dialog"]').click();
  record(
    "Host refresh passes control and immediately shows only the two connected players",
  );
  await boot(a);
  await browse(a);
  await a.locator("#room-list button").first().click();
  await a.waitForFunction(
    () => smash.net.running && smash.net.connected.length === 3,
    null,
    { timeout: 90000 },
  );
  const rejoined = await a.evaluate(() => ({
    id: smash.net.id,
    host: smash.net.room.hostId,
    members: smash.net.room.members.length,
  }));
  assert.equal(rejoined.id, original.id);
  assert.equal(rejoined.host, nextHost);
  assert.equal(rejoined.members, 3);
  assert.equal(await roomCount(), 3);
  record(
    "Public room rejoin after refresh reuses identity without duplicate players or taking host back",
  );
  await a.evaluate(() => document.getElementById("game-menu").click());
  await a.locator("#quit-game").click();
  await a.waitForFunction(() => smash.view === "browse");
  await b.waitForFunction(
    () =>
      smash.net.connected.length === 2 &&
      smash.net.room.members.length === 2 &&
      smash.net.running,
  );
  assert.equal(await roomCount(), 2);
  record(
    "Explicit leave clears the membership completely and preserves the remaining room",
  );
  await b.context().close();
  await c.context().close();

  await a.locator(".header-actions [data-controls]").click();
  await a.locator('[data-action="a"]').click();
  await a.keyboard.down("KeyX");
  await a.waitForFunction(() => smash.controls.capture?.action === "b");
  await a.keyboard.down("KeyX"); // Native repeat must not map the next action.
  assert.equal(await a.evaluate(() => smash.controls.capture?.action), "b");
  await a.keyboard.up("KeyX");
  await a.keyboard.press("KeyC");
  await a.waitForFunction(() => smash.controls.capture?.action === "z");
  assert.deepEqual(
    await a.evaluate(() => [
      smash.controls.profile.map.a.code,
      smash.controls.profile.map.b.code,
    ]),
    ["KeyX", "KeyC"],
  );
  await a.keyboard.press("Escape");
  assert.equal(await a.evaluate(() => smash.controls.capture), null);
  assert.equal(await a.locator("#mapping-prompt").isVisible(), false);
  record(
    "Click one mapping, press consecutive keys; auto-advance ignores held-key repeat and Escape stops setup",
  );
  await a.evaluate(() => {
    window.qaPad = {
      id: "QA sequence controller",
      index: 0,
      connected: true,
      buttons: Array.from({ length: 18 }, () => ({ value: 0, pressed: false })),
      axes: [0, 0],
    };
    Object.defineProperty(navigator, "getGamepads", {
      configurable: true,
      value: () => [qaPad],
    });
  });
  await a.locator("#device").selectOption("0");
  await a.locator('[data-action="a"]').click();
  const actions = [
    "a",
    "b",
    "z",
    "r",
    "l",
    "start",
    "cu",
    "cd",
    "cl",
    "cr",
    "up",
    "down",
    "left",
    "right",
    "du",
    "dd",
    "dl",
    "dr",
  ];
  for (const [index, action] of actions.entries()) {
    await a.waitForFunction(
      (action) =>
        smash.controls.capture?.action === action &&
        smash.controls.capture.armed,
      action,
    );
    await a.evaluate((index) => {
      qaPad.buttons[index] = { value: 1, pressed: true };
    }, index);
    await a.waitForFunction(
      ({ action, index }) =>
        smash.controls.profile.map[action]?.index === index &&
        smash.controls.capture?.action !== action,
      { action, index },
    );
    if (index === 0) {
      await wait(400);
      assert.equal(await a.evaluate(() => smash.controls.capture?.action), "b");
      assert.equal(
        await a.evaluate(() => smash.controls.capture?.armed),
        false,
      );
    }
    await a.evaluate((index) => {
      qaPad.buttons[index] = { value: 0, pressed: false };
    }, index);
  }
  assert.equal(await a.evaluate(() => smash.controls.capture), null);
  assert.equal(await a.locator("#mapping-prompt").isVisible(), false);
  const saved = await a.evaluate(
    () =>
      JSON.parse(localStorage.getItem("smash.controls.v1"))[
        "QA sequence controller"
      ].map,
  );
  for (const [index, action] of actions.entries())
    assert.equal(saved[action].index, index);
  record(
    "All 18 controller actions map in sequence, require release between presses, finish and persist automatically",
  );
  assert.deepEqual(errors, []);
  report.passed = true;
} catch (error) {
  report.failure = error.stack;
  console.error(error);
  process.exitCode = 1;
} finally {
  await writeFile(
    "artifacts/session-check.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  await browser.close();
}
