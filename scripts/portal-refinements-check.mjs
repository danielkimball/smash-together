import { chromium } from "playwright";
import { WebSocket } from "ws";
import { once } from "node:events";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const url = process.env.SMASH_URL || "http://localhost:8790";
const rom = process.env.SMASH_ROM;
if (!rom) throw Error("Set SMASH_ROM to your original US cartridge.");
const checks = [],
  errors = [],
  hosts = [];
const directory = await mkdtemp(path.join(os.tmpdir(), "smash-portal-cache-"));
let context, page;
const record = (name) => {
  checks.push(name);
  console.log("PASS", name);
};
async function launch() {
  context = await chromium.launchPersistentContext(directory, {
    headless: true,
    executablePath:
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    viewport: { width: 1600, height: 1000 },
    args: [
      "--autoplay-policy=no-user-gesture-required",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
    ],
  });
  await context.addInitScript(() =>
    Object.defineProperty(navigator, "getGamepads", {
      configurable: true,
      value: () => window.testPads || [],
    }),
  );
  page = context.pages()[0];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(url);
  await page.waitForFunction(
    () =>
      window.smash &&
      document.getElementById("attract-opening").currentTime > 0.4,
  );
}
async function pad(index = 0, normalized = false) {
  await page.evaluate(
    ({ index, normalized }) => {
      window.testPads = [
        {
          id: normalized
            ? "Generic USB Joystick (STANDARD GAMEPAD Vendor: 0079 Product: 0006)"
            : "Generic   USB  Joystick   (STANDARD GAMEPAD Vendor: 0079 Product: 0006)",
          index,
          connected: true,
          mapping: "standard",
          axes: [0, 0, 0.09, 0],
          buttons: Array.from({ length: 17 }, () => ({
            pressed: false,
            value: 0,
          })),
        },
      ];
    },
    { index, normalized },
  );
  await page.waitForFunction(
    (index) => smash.controls.selected === String(index),
    index,
  );
}
async function press(button) {
  await page.evaluate(
    (button) => (testPads[0].buttons[button] = { pressed: true, value: 1 }),
    button,
  );
  await page.waitForTimeout(90);
  await page.evaluate(
    (button) => (testPads[0].buttons[button] = { pressed: false, value: 0 }),
    button,
  );
  await page.waitForTimeout(270);
}
async function shot(name) {
  await page.screenshot({
    path: "artifacts/refinements-" + name + ".png",
    fullPage: true,
  });
}
async function room(name) {
  const address = new URL("/room", url);
  address.protocol = address.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(address);
  const messages = [];
  socket.on("message", (bytes) => {
    try {
      messages.push(JSON.parse(bytes));
    } catch {}
  });
  await once(socket, "open");
  const identity = await page.evaluate(() => ({
    rom: smash.engine.romHash,
    build: smash.engine.build + "-smash-native-v4",
  }));
  socket.send(
    JSON.stringify({
      type: "create",
      protocol: 4,
      ...identity,
      name: "Room fixture",
      roomName: name,
      capacity: 4,
      listed: true,
      delay: 4,
    }),
  );
  for (let i = 0; i < 100 && !messages.some((m) => m.type === "joined"); i++)
    await new Promise((resolve) => setTimeout(resolve, 25));
  const joined = messages.find((m) => m.type === "joined");
  assert.ok(joined, "Fixture room created");
  const r = messages.find((m) => m.type === "room")?.room;
  hosts.push(socket);
  return { socket, id: r?.id || joined.room?.id, messages };
}
try {
  await launch();
  assert.equal(
    await page.evaluate(() => document.getElementById("attract-opening").muted),
    false,
  );
  assert.equal(await page.locator("#attract-how-to-play").count(), 0);
  await page.locator("#power-on").click();
  await page.waitForFunction(() => smash.attract.phase === "title");
  await page.waitForTimeout(7000);
  assert.equal(await page.evaluate(() => smash.attract.phase), "title");
  assert.equal(
    await page.evaluate(() => document.getElementById("attract-title").muted),
    true,
  );
  await page.locator("#power-on").click();
  await page.waitForSelector("#rom-dialog[open]");
  const before = await page.evaluate(
    () => document.getElementById("attract-title").currentTime,
  );
  await page.waitForTimeout(500);
  assert.notEqual(
    await page.evaluate(
      () => document.getElementById("attract-title").currentTime,
    ),
    before,
  );
  await shot("silent-fire-rom");
  record(
    "Opening music is enabled; fire loops silently with the ROM overlay and never enters How to Play",
  );
  await page.locator("#rom-file").setInputFiles(rom);
  await page.waitForFunction(
    () => smash.view === "native" && !smash.paused,
    null,
    { timeout: 90000 },
  );
  await page.locator("#native-online").hover();
  await page.waitForFunction(() => smash.engine.inspect().menu?.row === 1);
  assert.equal(await page.locator("#native-online span").isVisible(), false);
  assert.equal(
    await page
      .locator("#native-online")
      .evaluate((e) => getComputedStyle(e).outlineStyle),
    "none",
  );
  await shot("native-hover");
  await page.locator("#native-options").hover();
  await page.waitForFunction(() => smash.engine.inspect().menu?.row === 2);
  await page.locator("#native-online").click();
  await page.waitForFunction(() => smash.view === "browse");
  record("Mouse hover selects the original native icon with no HTML overlay");
  const audio = await page.evaluate(() => {
    const a = smash.engine.audio;
    window.musicContext = a.ctx;
    window.musicSamples = [];
    const process = a.processor.onaudioprocess;
    a.processor.onaudioprocess = (e) => {
      process(e);
      const data = e.outputBuffer.getChannelData(0);
      musicSamples.push(Math.max(...data.map(Math.abs)));
    };
    return smash.engine.frames;
  });
  await page.waitForFunction(
    (frame) => smash.engine.frames > frame + 60,
    audio,
    { timeout: 15000 },
  );
  const sound = await page.evaluate(() => ({
    running: smash.engine.audio.ctx.state,
    same: smash.engine.audio.ctx === musicContext,
    peak: Math.max(...musicSamples),
    frames: smash.engine.frames,
  }));
  assert.equal(sound.running, "running");
  assert.equal(sound.same, true);
  assert.ok(sound.peak > 0.001);
  assert.ok(sound.frames > audio + 30);
  record(
    "The same native audio context keeps playing non-silent menu music in the lobby",
  );
  const firstName = await page.locator("#player-name").inputValue();
  assert.match(firstName, /\S+ \S+/);
  assert.equal(
    await page.evaluate(() => localStorage.getItem("smash.name")),
    firstName,
  );
  await pad();
  assert.deepEqual(
    await page.evaluate(() => [
      smash.controls.profile.map.a.index,
      smash.controls.profile.map.b.index,
      smash.controls.profile.map.cu.index,
      smash.controls.profile.map.cr.index,
    ]),
    [6, 8, 0, 1],
  );
  await page.mouse.move(0, 0);
  await press(13);
  assert.equal(
    await page.evaluate(() => document.activeElement.id),
    "player-name",
  );
  await press(13);
  assert.equal(
    await page.evaluate(() => document.activeElement.id),
    "create-open",
  );
  await press(13);
  assert.equal(
    await page.evaluate(() => document.activeElement.id),
    "join-open",
  );
  await press(12);
  await press(12);
  await press(6);
  await page.waitForSelector("#name-dialog[open]");
  await shot("name-keyboard");
  await page.setViewportSize({ width: 390, height: 844 });
  await shot("name-keyboard-phone");
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.setViewportSize({ width: 1600, height: 1000 });
  await press(13);
  assert.equal(
    await page.evaluate(() => document.activeElement.dataset.key),
    "H",
  );
  await page.locator('[data-key="Clear"]').focus();
  await press(6);
  await page.locator('[data-key="A"]').focus();
  await press(6);
  await press(9);
  assert.equal(await page.locator("#player-name").inputValue(), "A");
  await page.locator("#player-name").fill("Captain Bonk");
  await page.locator(".header-actions [data-controls]").click();
  await page.locator("#deadzone").fill("19");
  await page.locator("#deadzone").dispatchEvent("input");
  await shot("n64-preset");
  await page.locator("#controls-dialog [data-close]").click();
  record(
    "N64 preset, up/down lobby navigation, controller keyboard and saved funny names work",
  );
  const fixtures = [
    await room("Waffle Warriors"),
    await room("Banana Brawl"),
    await room("Goose League"),
  ];
  await page.waitForFunction(
    () => document.querySelectorAll(".room-row").length >= 3,
  );
  const ids = await page
    .locator(".room-row")
    .evaluateAll((rows) => rows.map((r) => r.dataset.room));
  assert.equal(ids.length, 3);
  const target = page.locator(".room-row").nth(1);
  await target.focus();
  await page.waitForTimeout(2700);
  assert.equal(
    await page.evaluate(() => document.activeElement.dataset.room),
    ids[1],
  );
  const boxes = await page.evaluate(() => ({
    list: document
      .querySelector(".room-browser")
      .getBoundingClientRect()
      .toJSON(),
    left: document
      .querySelector(".lobby-logo")
      .getBoundingClientRect()
      .toJSON(),
    right: document
      .querySelector(".lobby-actions")
      .getBoundingClientRect()
      .toJSON(),
  }));
  assert.ok(
    boxes.list.y >= Math.max(boxes.left.bottom, boxes.right.bottom) - 1,
  );
  await shot("rooms-desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  await shot("rooms-phone");
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.setViewportSize({ width: 1600, height: 1000 });
  await target.focus();
  await press(6);
  await page.waitForFunction((id) => smash.net.room?.id === id, ids[1], {
    timeout: 15000,
  });
  record(
    "All open rooms appear below the lobby and controller A joins the highlighted room",
  );
  await context.close();
  context = null;
  for (const socket of hosts) socket.close();
  await launch();
  await page.waitForFunction(() =>
    document.getElementById("cartridge-badge").classList.contains("ready"),
  );
  assert.equal(await page.locator("#player-name").inputValue(), "Captain Bonk");
  await pad(2, true);
  assert.equal(
    await page.evaluate(() => smash.controls.profile.deadzone),
    0.19,
  );
  assert.equal(
    await page.evaluate(() => smash.controls.profile.map.b.index),
    8,
  );
  await press(9);
  await page.waitForTimeout(400);
  await press(6);
  await page.waitForFunction(
    () => smash.view === "native" && !smash.paused,
    null,
    { timeout: 90000 },
  );
  assert.equal(
    await page.locator("#rom-dialog").evaluate((e) => e.open),
    false,
  );
  record(
    "A full browser restart restores ROM, name and mapping, even after the pad index/ID spacing changes",
  );
  assert.deepEqual(errors, []);
} catch (error) {
  errors.push(error.message);
  await shot("failure").catch(() => {});
  throw error;
} finally {
  await writeFile(
    "artifacts/portal-refinements.json",
    JSON.stringify(
      { date: new Date().toISOString(), url, checks, errors },
      null,
      2,
    ),
  );
  for (const socket of hosts) socket.close();
  await context?.close();
  await rm(directory, { recursive: true, force: true });
}
