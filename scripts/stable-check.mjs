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
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "getGamepads", {
      configurable: true,
      value: () => [],
    }),
  );
  page.on("pageerror", (e) => errors.push(e.message));
  assert.equal(
    publicUrl,
    shareUrl,
    "Invitations use the direct Cloudflare URL",
  );
  await page.goto(process.env.SMASH_LEGACY_URL || publicUrl);
  await page.waitForURL(shareUrl + "/", { timeout: 90000 });
  const game = page;
  await game.locator("#power-on").waitFor({ state: "visible", timeout: 60000 });
  assert.equal(
    page.frames().length,
    1,
    "The game is not embedded in an iframe",
  );
  assert.equal(new URL(page.url()).origin, new URL(shareUrl).origin);
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
  await page.screenshot({ path: "artifacts/direct-testing-entry.png" });
  assert.deepEqual(errors, []);
  console.log(
    "PASS direct Cloudflare game has no iframe, allows fullscreen/gamepad access and rejects an incorrect testing password",
  );
  await writeFile(
    "artifacts/direct-check.json",
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
