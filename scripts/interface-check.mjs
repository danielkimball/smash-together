// Render-only checks use synthetic pads and stub all host APIs: no ROM/rooms.
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { writeFile, mkdir } from "node:fs/promises";
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH,
});
const context = await browser.newContext({
  viewport: { width: 1366, height: 768 },
});
await context.route("**/api/**", (r) =>
  r.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ testingAutoLoad: false, rooms: [] }),
  }),
);
await context.addInitScript(() => {
  const pads = [0, 1, 2].map((index) => ({
    index,
    id: `Synthetic pad ${index}`,
    mapping: "standard",
    connected: true,
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ value: 0, pressed: false })),
  }));
  Object.defineProperty(navigator, "getGamepads", { value: () => pads });
});
const page = await context.newPage(),
  errors = [],
  checks = [];
page.on("pageerror", (e) => errors.push(e.message));
const pass = (s) => {
  checks.push(s);
  console.log("PASS", s);
};
try {
  await mkdir("artifacts", { recursive: true });
  await page.goto(process.env.SMASH_URL || "http://127.0.0.1:8790");
  await page.waitForFunction(() => document.getElementById("rom-dialog").open);
  await page.screenshot({ path: "artifacts/rom-gate-v38.png" });
  assert.equal(
    await page
      .locator("#rom-dialog .rom-box")
      .evaluate((i) => i.naturalWidth > 0),
    true,
  );
  await page.locator('[data-close="rom-dialog"]').click();
  await page.locator(".header-actions [data-controls]").click();
  await page.evaluate(() => {
    smash.localPlayers.add();
    smash.localPlayers.add();
  });
  // Re-open to rebuild player choices from the changed local roster.
  await page.locator('[data-close="controls-dialog"]').click();
  await page.locator(".header-actions [data-controls]").click();
  assert.equal(await page.locator("#controller-players button").count(), 3);
  assert.equal(
    await page
      .locator('#controller-players button[aria-selected="true"]')
      .textContent(),
    "Player 1",
  );
  await page.locator("#controller-players button").nth(1).click();
  assert.equal(await page.evaluate(() => smash.controls.selected), "1");
  await page.locator("#controller-players button").first().click();
  const positions = await page
    .locator("[data-action]")
    .evaluateAll((bs) =>
      Object.fromEntries(
        bs.map((b) => [
          b.dataset.action,
          { x: b.parentElement.offsetLeft, y: b.parentElement.offsetTop },
        ]),
      ),
    );
  assert.equal(positions.a.x, positions.b.x);
  assert.ok(positions.b.y > positions.a.y);
  assert.equal(positions.start.y, positions.a.y);
  assert.ok(positions.start.x > positions.a.x);
  assert.equal(positions.cr.y, positions.dr.y);
  await page.locator('[data-action="b"]').click();
  await page.locator('[data-action="a"]').hover();
  assert.equal(await page.locator("[data-action].active").count(), 1);
  await page.waitForTimeout(200);
  const colors = await page
    .locator('[data-action="a"], [data-action="b"]')
    .evaluateAll((bs) => bs.map((b) => getComputedStyle(b).backgroundColor));
  assert.notEqual(colors[0], colors[1]);
  assert.equal(colors[1], "rgb(255, 0, 40)");
  assert.equal(await page.locator("#stick-calibration").isVisible(), false);
  const desktop = await page
    .locator("#controls-dialog")
    .evaluate((d) => ({ client: d.clientHeight, scroll: d.scrollHeight }));
  assert.ok(desktop.scroll <= desktop.client + 1, JSON.stringify(desktop));
  await page.screenshot({ path: "artifacts/controller-laptop-v38.png" });
  await page.keyboard.press("Escape");
  pass(
    "Player tabs select the correct controller; nine vertical rows have Start at top right; hover cannot mimic capture; laptop needs no scroll",
  );
  await page.locator("#calibrate").click();
  assert.equal(await page.locator("#stick-calibration").isVisible(), true);
  await page.setViewportSize({ width: 390, height: 700 });
  await page
    .locator("#controls-dialog")
    .evaluate((d) => (d.scrollTop = d.scrollHeight));
  const close = await page
    .locator('[data-close="controls-dialog"]')
    .boundingBox();
  assert.ok(
    close.y >= 0 && close.y + close.height < 100,
    JSON.stringify(close),
  );
  assert.equal(
    await page
      .locator("#controls-dialog")
      .evaluate((d) => d.scrollWidth <= d.clientWidth),
    true,
  );
  await page.screenshot({ path: "artifacts/controller-mobile-scroll-v38.png" });
  pass(
    "Calibration is opt-in; close button stays visible at the top even when the phone modal is fully scrolled",
  );
  await page.locator('[data-close="controls-dialog"]').click();
  await page.evaluate(() => {
    document.getElementById("home-screen").hidden = true;
    document.getElementById("browse-screen").hidden = false;
    document.body.dataset.view = "browse";
  });
  await page.screenshot({ path: "artifacts/local-names-mobile-v38.png" });
  const key = await page
    .locator("#lobby-local-names input")
    .first()
    .getAttribute("data-local-name");
  await page.locator("#lobby-local-names .remove-local-player").first().click();
  assert.equal(
    await page.locator(`#lobby-local-names [data-local-name="${key}"]`).count(),
    0,
  );
  assert.equal(
    await page.evaluate(
      (key) => smash.localPlayers.entries.some((p) => p.key === key),
      key,
    ),
    false,
  );
  pass(
    "Inline × removes the correct additional player and persists the roster",
  );
  assert.deepEqual(errors, []);
} finally {
  await writeFile(
    "artifacts/interface-check.json",
    JSON.stringify({ checks, errors }, null, 2),
  );
  await browser.close();
}
