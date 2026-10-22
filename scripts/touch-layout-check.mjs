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
  const p = await openPage(true);
  await browse(p);
  await create(p);
  await p.evaluate(() => smash.controls.touch.setMode("on"));
  for (const [w, h] of [
    [375, 667],
    [390, 844],
    [430, 932],
    [667, 375],
    [844, 390],
  ]) {
    await p.setViewportSize({ width: w, height: h });
    await wait(1000);
    const result = await p.evaluate(() => {
      const rect = (n) => {
        const r = n.getBoundingClientRect();
        return {
          x: r.x,
          y: r.y,
          w: r.width,
          h: r.height,
          label: n.getAttribute("aria-label") || n.dataset.touch || n.className,
        };
      };
      const buttons = [
        ...document.querySelectorAll(
          "#touch-controls button[data-touch],#touch-controls .touch-stick",
        ),
      ]
        .filter((n) => n.getBoundingClientRect().width > 0)
        .map(rect);
      const overlap = [];
      for (let i = 0; i < buttons.length; i++)
        for (let j = i + 1; j < buttons.length; j++) {
          const a = buttons[i],
            b = buttons[j];
          if (
            Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 1 &&
            Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 1
          )
            overlap.push([a.label, b.label]);
        }
      return {
        buttons,
        overlap,
        width: innerWidth,
        height: innerHeight,
        scale: visualViewport.scale,
        selection: getComputedStyle(document.querySelector(".touch-stick"))
          .userSelect,
        touch: getComputedStyle(document.querySelector(".touch-stick"))
          .touchAction,
      };
    });
    await p.screenshot({ path: `artifacts/touch-${w}x${h}.png` });
    assert.deepEqual(result.overlap, []);
    assert.equal(result.selection, "none");
    assert.equal(result.touch, "none");
    for (const b of result.buttons) {
      assert.ok(
        b.x >= -1 && b.y >= -1 && b.x + b.w <= w + 1 && b.y + b.h <= h + 1,
        JSON.stringify(b),
      );
    }
    record(`Touch layout ${w}x${h} has no overlapping or off-screen buttons`);
  }
  await p.setViewportSize({ width: 390, height: 844 });
  await wait(400);
  await p.evaluate(() => {
    smash.net.filterInput = () => ({ buttons: 0, x: 0, y: 0 });
  });
  const session = await p.context().newCDPSession(p);
  const point = async (sel, id) => {
    const b = await p.locator(sel).boundingBox();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2, id };
  };
  const stick = await point(".touch-stick", 1),
    aButton = await point(".touch-a", 2),
    bButton = await point(".touch-z", 3);
  stick.x += 35;
  await session.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [stick, aButton, bButton],
  });
  await wait(100);
  const sample = await p.evaluate(() => smash.controls.sample());
  assert.ok(sample.x > 50);
  assert.equal(sample.buttons & 160, 160);
  assert.equal(await p.evaluate(() => getSelection().toString()), "");
  assert.equal(await p.evaluate(() => visualViewport.scale), 1);
  await session.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await wait(100);
  assert.equal(await p.evaluate(() => smash.controls.sample().buttons), 0);
  record(
    "Real simultaneous touch events move the stick and press A+Z without selecting text or zooming",
  );
  assert.deepEqual(errors, []);
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  await writeFile(
    "artifacts/mobile-layout.json",
    JSON.stringify({ checks, errors }, null, 2),
  );
  await browser.close();
}
