// Isolated controller-dialog check. Synthetic Gamepad API only; no ROM or rooms.
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { ACTIONS, BITS } from "../public/js/controls.js";

const url = process.env.SMASH_URL || "http://127.0.0.1:8790";
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH,
});
const context = await browser.newContext({
  viewport: { width: 1280, height: 1000 },
});
const checks = [],
  errors = [];
const report = {
  url,
  simulatedController: true,
  checks,
  errors,
  passed: false,
};
const record = (name) => {
  checks.push(name);
  console.log("PASS", name);
};
// Keep this test independent of a host's optional cartridge auto-load setting.
await context.route("**/api/**", (route) =>
  route.fulfill({
    contentType: "application/json",
    headers: { "access-control-allow-origin": "*" },
    body: JSON.stringify({ testingAutoLoad: false, rooms: [] }),
  }),
);
await context.addInitScript(() => {
  Object.defineProperty(navigator, "platform", { get: () => "Win32" });
  window.qaPad = {
    id: "USB Gamepad (Vendor: 0079 Product: 0006)",
    index: Number(sessionStorage.getItem("qaPadIndex") || 0),
    connected: true,
    mapping: "",
    buttons: Array.from({ length: 18 }, () => ({ value: 0, pressed: false })),
    axes: [0, 0, -1, 9 / 7],
  };
  Object.defineProperty(navigator, "getGamepads", {
    configurable: true,
    value: () => (qaPad.connected ? [qaPad] : []),
  });
});
const page = await context.newPage();
page.on("pageerror", (error) => errors.push(error.message));
const button = (index, value) =>
  page.evaluate(
    ({ index, value }) => {
      qaPad.buttons[index] = { value, pressed: value > 0 };
    },
    { index, value },
  );
const axis = (index, value) =>
  page.evaluate(
    ({ index, value }) => {
      qaPad.axes[index] = value;
    },
    { index, value },
  );
const ready = (action) =>
  page.waitForFunction(
    (action) =>
      smash.controls.capture?.action === action && smash.controls.capture.armed,
    action,
  );
const mapped = (action) =>
  page.waitForFunction(
    (action) => smash.controls.capture?.action !== action,
    action,
  );
const open = async () => {
  await page.waitForFunction(() => window.smash);
  await page.locator(".header-actions [data-controls]").click();
  await page.waitForFunction(
    () => smash.controls.selected === String(qaPad.index),
  );
};
try {
  await mkdir("artifacts", { recursive: true });
  await page.goto(url);
  await open();
  assert.equal(await page.locator("#mac-controller-help").isVisible(), false);
  await button(2, 1);
  await page.waitForFunction(() =>
    document.getElementById("control-test").textContent.includes("C ↓"),
  );
  await button(2, 0);
  await page.locator('[data-action="a"]').click();
  await ready("a");
  await button(2, 1);
  await mapped("a");
  assert.equal(
    await page.locator('[data-action="a"]').textContent(),
    "Button 3",
  );
  assert.equal(
    await page.locator('[data-action="cd"]').textContent(),
    "Not set",
  );
  assert.match(
    await page.locator("#mapping-status").textContent(),
    /A · Attack → Button 3 saved.*C ↓/,
  );
  assert.equal(await page.locator("#control-test").textContent(), "A · Attack");
  await page.locator("#controls-dialog").evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.screenshot({ path: "artifacts/controller-assigned.png" });
  record(
    "Windows endpoint/hat idle axes allow A assignment, remove C-down, and show saved confirmation",
  );

  await page.waitForTimeout(350);
  assert.deepEqual(
    await page.evaluate(() => [
      smash.controls.capture.action,
      smash.controls.capture.armed,
    ]),
    ["b", false],
  );
  await button(2, 0);
  await ready("b");
  await button(8, 1);
  await mapped("b");
  assert.equal(
    await page.locator('[data-action="b"]').textContent(),
    "Button 9",
  );
  await button(8, 0);
  await page.keyboard.press("Escape");
  assert.equal(await page.evaluate(() => smash.controls.capture), null);
  assert.equal(await page.locator("#mapping-prompt").isVisible(), false);
  record(
    "Auto-advance waits for release, accepts the next press, and Escape stops capture",
  );

  await page.locator("#wizard").click();
  const bindings = [
    ...[2, 8, 7, 5, 4, 9, 0, 6, 3, 1].map((index) => ({
      kind: "button",
      index,
    })),
    { kind: "axis", index: 1, sign: -1 },
    { kind: "axis", index: 1, sign: 1 },
    { kind: "axis", index: 0, sign: -1 },
    { kind: "axis", index: 0, sign: 1 },
    ...[0, 4, 6, 2].map((direction) => ({ kind: "hat", index: 3, direction })),
  ];
  for (const [position, [action]] of ACTIONS.entries()) {
    const binding = bindings[position];
    await ready(action);
    if (binding.kind === "button") await button(binding.index, 1);
    else
      await axis(
        binding.index,
        binding.kind === "hat" ? (binding.direction * 2) / 7 - 1 : binding.sign,
      );
    await mapped(action);
    assert.deepEqual(
      await page.evaluate(
        (action) => smash.controls.profile.map[action],
        action,
      ),
      binding,
    );
    if (binding.kind === "button") await button(binding.index, 0);
    else await axis(binding.index, binding.kind === "hat" ? 9 / 7 : 0);
  }
  assert.equal(await page.evaluate(() => smash.controls.capture), null);
  assert.equal(await page.locator("#mapping-prompt").isVisible(), false);
  await axis(3, -5 / 7);
  await page.waitForFunction(() =>
    ["D-pad ↑", "D-pad →"].every((name) =>
      document.getElementById("control-test").textContent.includes(name),
    ),
  );
  assert.match(await page.locator("#control-test").textContent(), /D-pad ↑/);
  await axis(3, 9 / 7);
  record(
    "All 18 actions complete using buttons, opposing stick axes, and Windows HID hat directions",
  );

  const saved = await page.evaluate(() => smash.controls.profile);
  await page.evaluate(() => sessionStorage.setItem("qaPadIndex", "3"));
  await page.reload();
  await open();
  assert.deepEqual(await page.evaluate(() => smash.controls.profile), saved);
  assert.match(
    await page.locator("#controller-saved").textContent(),
    /^Custom mapping/,
  );
  await button(2, 1);
  await page.waitForFunction(
    () => document.getElementById("control-test").textContent === "A · Attack",
  );
  await button(2, 0);
  record("Assignments persist across full reload and a changed gamepad index");

  await page.locator('[data-action="a"]').click();
  await page.evaluate(() => {
    qaPad.connected = false;
  });
  await page.waitForFunction(
    () => smash.controls.selected === "keyboard" && !smash.controls.capture,
  );
  await page.locator('[data-action="a"]').click();
  await page.keyboard.down("KeyX");
  await mapped("a");
  await page.keyboard.down("KeyX");
  assert.equal(await page.evaluate(() => smash.controls.capture.action), "b");
  await page.keyboard.up("KeyX");
  await page.keyboard.press("KeyC");
  await mapped("b");
  await page.keyboard.press("Escape");
  assert.deepEqual(
    await page.evaluate(() => [
      smash.controls.profile.map.a.code,
      smash.controls.profile.map.b.code,
    ]),
    ["KeyX", "KeyC"],
  );
  record(
    "Disconnect cancels safely; keyboard mapping still advances and ignores key repeats",
  );

  await page.evaluate(() => {
    qaPad = {
      ...qaPad,
      id: "Xbox Controller (STANDARD GAMEPAD Vendor: 045e Product: 02ea)",
      connected: true,
      mapping: "standard",
      axes: [0, 0, 0, 0],
    };
    dispatchEvent(new Event("gamepadconnected"));
  });
  await page.locator("#device").selectOption("3");
  await page.locator('[data-action="a"]').click();
  await ready("a");
  await button(2, 1);
  await mapped("a");
  await button(2, 0);
  await page.keyboard.press("Escape");
  assert.equal(
    await page.locator('[data-action="b"]').textContent(),
    "Not set",
  );
  await button(2, 1);
  assert.equal(
    await page.evaluate(async () => {
      const { evaluate } = await import("./js/controls.js");
      return evaluate(smash.controls.profile, qaPad).buttons;
    }),
    BITS.a,
  );
  await button(2, 0);
  await page.locator("#preset").click();
  assert.equal(
    await page.locator('[data-action="a"]').textContent(),
    "Button 1",
  );
  assert.equal(
    await page.locator('[data-action="b"]').textContent(),
    "Button 3",
  );
  record(
    "Standard Xbox mapping still reassigns correctly and Reset preset restores defaults",
  );
  assert.deepEqual(errors, []);
  report.passed = true;
} catch (error) {
  report.failure = error.stack;
  console.error(error);
  process.exitCode = 1;
} finally {
  await writeFile(
    "artifacts/controller-check.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  await browser.close();
}
