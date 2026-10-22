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
  const a = await openPage();
  await a.locator("#native-single").click();
  await scene(a, 8);
  await clickNative(a, 190, 53);
  await scene(a, 17);
  await wait(1000);
  await clickNative(a, 86, 64);
  const selected = await a.evaluate(() => {
    const s = smash.engine.snapshot();
    return new DataView(s.buffer).getInt32(448 + 0x138ee8 + 0x58, true);
  });
  assert.ok(selected);
  record("1P menu and native character selection respond to pointer clicks");
  await a.locator("#game-menu").click();
  await a.locator("#quit-game").click();
  await scene(a, 7);
  await a.locator("#native-options").click();
  await scene(a, 57);
  await clickNative(a, 180, 100);
  await scene(a, 15);
  await a.locator("#pointer-menu").getByRole("button", { name: /^B / }).click();
  await scene(a, 57);
  await a.locator("#pointer-menu").getByRole("button", { name: /^B / }).click();
  await scene(a, 7);
  await a.locator("#native-data").click();
  await scene(a, 58);
  await clickNative(a, 180, 147);
  await scene(a, 59);
  await clickNative(a, 250, 120);
  record(
    "Options, Screen Adjust, Data and Sound Test support pointer navigation",
  );
  assert.deepEqual(errors, []);
} catch (e) {
  console.error(e);
  await pages[0]?.screenshot({ path: "artifacts/menu-failure.png" });
  console.log(await pages[0]?.evaluate(() => smash.engine.info));
  process.exitCode = 1;
} finally {
  await writeFile(
    "artifacts/menu-check.json",
    JSON.stringify({ checks, errors }, null, 2),
  );
  await browser.close();
}
