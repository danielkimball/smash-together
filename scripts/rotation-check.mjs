import { browserHelpers } from "./browser-helpers.mjs";
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
const url = process.env.SMASH_URL || "http://127.0.0.1:8790";
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH,
  args: [
    "--autoplay-policy=no-user-gesture-required",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
  ],
});
const pages = [],
  checks = [],
  errors = [];
const record = (name, data = {}) => {
  checks.push({ name, ...data });
  console.log("PASS", name, JSON.stringify(data));
};
const { wait, scene, pad, act, create, browse, openPage, clickNative, join } =
  browserHelpers(browser, { url, pages, errors });

try {
  await mkdir("artifacts", { recursive: true });
  const a = await openPage(),
    b = await openPage(),
    c = await openPage();
  await browse(a);
  await a.locator("#create-open").click();
  await a.locator("#create-room").click();
  await scene(a, 9);
  await clickNative(a, 250, 82);
  await clickNative(a, 190, 119);
  await clickNative(a, 190, 119);
  await clickNative(a, 190, 42);
  await a.waitForFunction(() => smash.net.running, null, { timeout: 90000 });
  await scene(a, 16);
  const token = await a.evaluate(() => smash.net.token);
  await join(b, token);
  await a.waitForFunction(() => smash.net.running);
  await wait(1500);
  // Teams are chosen with the native controls, not a duplicate web setting.
  await clickNative(a, 80, 25);
  await clickNative(a, 120, 136);
  await a.waitForFunction(
    () =>
      smash.net.running &&
      smash.engine.inspect().teams &&
      smash.engine.info.players[1].team === 1,
    null,
    { timeout: 30000 },
  );
  record("Native team controls update mode and player colors");
  await clickNative(a, 80, 25);
  await a.waitForFunction(
    () => smash.net.running && !smash.engine.inspect().teams,
  );
  await clickNative(a, 86, 64);
  await clickNative(b, 128, 64);
  await a.locator("#start-game").click();
  await scene(a, 21);
  await wait(1000);
  await clickNative(a, 105, 85);
  await scene(a, 22);
  assert.equal(
    await a.evaluate(() => smash.engine.inspect().rules.mode),
    "stock",
  );
  assert.equal(await a.evaluate(() => smash.engine.info.rules.lives), 1);
  await join(c, token);
  await scene(c, 22);
  // Let player two walk off so the result has an unambiguous winner.
  await wait(3500);
  await act(b, ["KeyD"], 600, 30);
  await a.waitForFunction(
    () => smash.engine.inspect().scene === 24 && !!smash.net.room.results,
    null,
    { timeout: 45000 },
  );
  const results = await a.evaluate(() => smash.net.room.results);
  console.log("RESULTS", JSON.stringify(results));
  const winner = results.players.find((p) => p.place === 0).id;
  const cID = await c.evaluate(() => smash.net.id);
  const next = await a.evaluate(() => smash.net.room.nextLineup);
  assert.ok(next.includes(winner));
  assert.ok(next.includes(cID));
  await clickNative(a, 160, 215);
  await scene(a, 16);
  await a.waitForFunction(() => smash.net.running && smash.net.room.selecting);
  await c.waitForFunction(() => smash.net.running && smash.net.player >= 0);
  assert.ok(
    await a.evaluate(
      () => smash.net.room.members.find((p) => p.id === smash.net.id).slot >= 0,
    ),
  );
  assert.equal(
    await a.evaluate(
      () => smash.net.room.members.filter((p) => p.slot >= 0).length,
    ),
    3,
  );
  record(
    "Native results keep the winner, then promote the waiting spectator at character selection",
    { results },
  );
  assert.deepEqual(errors, []);
} catch (e) {
  console.error(e);
  for (let i = 0; i < pages.length; i++) {
    console.log(
      "STATE",
      i,
      await pages[i].evaluate(() => ({
        net: smash.net.state,
        room: smash.net.room,
        info: smash.engine.info,
      })),
    );
    await pages[i].screenshot({ path: `artifacts/rotation-failure-${i}.png` });
  }
  process.exitCode = 1;
} finally {
  await writeFile(
    "artifacts/rotation-check.json",
    JSON.stringify({ checks, errors }, null, 2),
  );
  await browser.close();
}
