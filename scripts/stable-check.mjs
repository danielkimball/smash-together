import { chromium } from "playwright";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
const { publicUrl, shareUrl } = await (
  await fetch(
    new URL("/api/status", process.env.SMASH_URL || "http://localhost:8787"),
  )
).json();
const browser = await chromium.launch({
  headless: true,
  executablePath:
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
});
const errors = [];
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(publicUrl);
  const game = await (await page.waitForSelector("#game")).contentFrame();
  await game.locator("#power-on").waitFor({ state: "visible", timeout: 60000 });
  await page.locator("#connection").waitFor({ state: "hidden" });
  assert.equal(new URL(page.url()).origin, new URL(publicUrl).origin);
  assert.ok(game.url().startsWith(shareUrl));
  assert.deepEqual(
    await page.locator("#game").evaluate((el) => {
      const r = el.getBoundingClientRect();
      return [r.width, r.height];
    }),
    [1440, 900],
  );
  assert.equal(await game.evaluate(() => document.fullscreenEnabled), true);
  assert.equal(
    await game.evaluate(() =>
      (document.permissionsPolicy || document.featurePolicy).allowsFeature(
        "gamepad",
      ),
    ),
    true,
  );
  await game.locator("#testing-access").click();
  await game.locator("#testing-password").pressSequentially("incorrect-test");
  await game.locator("#testing-password").press("Enter");
  await game.waitForFunction(() =>
    document
      .getElementById("testing-error")
      .textContent.includes("not correct"),
  );
  assert.equal(await game.evaluate(() => smash.engine.loaded), false);
  await page.screenshot({ path: "artifacts/stable-testing-entry.png" });
  assert.deepEqual(errors, []);
  console.log(
    "PASS stable address embeds the full-window game, delegates fullscreen/gamepad access and rejects an incorrect testing password",
  );
  await writeFile(
    "artifacts/stable-check.json",
    JSON.stringify(
      {
        passed: true,
        finished: new Date().toISOString(),
        publicUrl,
        shareUrl,
        fullscreen: true,
        gamepad: true,
        errors,
      },
      null,
      2,
    ),
  );
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  await Promise.race([
    browser.close(),
    new Promise((r) => setTimeout(r, 3000)),
  ]);
  process.exit(process.exitCode || 0);
}
