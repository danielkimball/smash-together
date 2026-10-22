import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { root } from "./share.mjs";
const rom = process.env.SMASH_ROM;
if (!rom) throw Error("Set SMASH_ROM to your own original US ROM path.");
await access(rom);
const local = process.env.SMASH_URL || "http://127.0.0.1:8787";
const remote =
  process.env.SMASH_GUEST_URL === "public"
    ? (await (await fetch(local + "/api/status")).json()).publicUrl
    : process.env.SMASH_GUEST_URL || local;
if (!remote) throw Error("Public sharing is not ready.");
const dir = path.join(root, "artifacts");
await mkdir(dir, { recursive: true });
const report = {
  started: new Date().toISOString(),
  host: local,
  guest: remote,
  checks: [],
  errors: [],
};
const record = (name, data) => {
  report.checks.push({ name, ...data });
  console.log("PASS", name, data ? JSON.stringify(data) : "");
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.CHROME_PATH ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  args: [
    ...(process.env.SMASH_SOFTWARE_GL
      ? [
          "--use-gl=angle",
          "--use-angle=swiftshader",
          "--enable-unsafe-swiftshader",
        ]
      : []),
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--autoplay-policy=no-user-gesture-required",
  ],
});
const contexts = [],
  pages = [];
const count = Number(process.env.SMASH_PLAYERS || 4);
async function waitState(p, state) {
  await p.waitForFunction((s) => smash.net.state === s, state, {
    timeout: 90000,
  });
}
async function frames(p, n) {
  const f = await p.evaluate(() => smash.net.frame);
  await p.waitForFunction(
    (t) => smash.net.running && smash.net.frame >= t,
    f + n,
    { timeout: 90000 },
  );
}
async function act(p, keys, count = 6, settle = 30) {
  await p.evaluate(
    ({ keys, count, settle }) =>
      new Promise((resolve, reject) => {
        const c = smash.controls,
          original = c.sample.bind(c);
        let first = null,
          localFrame = 0;
        const duration =
          count + Math.max(settle, (smash.net.personalDelay || 0) + 8);
        const timeout = setTimeout(() => {
          c.sample = original;
          reject(Error("Input timed out"));
        }, 90000);
        c.sample = () => {
          const target = smash.net.running
            ? Math.max(0, smash.net.serverFrame + 1) + smash.net.personalDelay
            : localFrame++;
          first ??= target;
          const elapsed = target - first;
          if (elapsed < count) {
            c.keys = new Set(keys);
            const input = original();
            c.keys.clear();
            return input;
          }
          if (elapsed < duration) return { buttons: 0, x: 0, y: 0 };
          c.sample = original;
          clearTimeout(timeout);
          resolve();
          return original();
        };
      }),
    { keys, count, settle },
  );
  const scheduled = await p.evaluate(() =>
    smash.net.running ? smash.net.lastSample : null,
  );
  if (scheduled !== null)
    await p.waitForFunction((f) => smash.net.frame > f, scheduled, {
      timeout: 30000,
    });
}
// Read-only scene assertions for the verified US ROM and pinned Mupen state format.
// RDRAM begins at byte 448 in savestates_save_m64p; words are little-endian.
// Symbols/types: https://github.com/VetriTheRetri/ssb-decomp-re (symbols_us.txt,
// scdef.h, sctypes.h). gSCManagerSceneData=0x800A4AD0, BattleState*=0x800A50E8.
// Scene 16 = VS character selection; scene 22 = an actual VS battle.
async function gameState(p) {
  return p.evaluate(() => {
    const state = smash.engine.snapshot();
    const word = (address) =>
      new DataView(state.buffer).getUint32(448 + (address & 0x7fffff), true);
    const byte = (address) => state[448 + ((address & 0x7fffff) ^ 3)];
    const battle = word(0x800a50e8);
    return { scene: byte(0x800a4ad0), humans: battle ? byte(battle + 4) : 0 };
  });
}
async function menu(p) {
  await p.evaluate(() => document.getElementById("game-menu").click());
}
async function shot(p, name) {
  if (await p.evaluate(() => smash.engine.loaded))
    assert.equal(
      await p.evaluate(() => GL.currentContext.GLctx.isContextLost()),
      false,
      "WebGL must be rendering",
    );
  await p.screenshot({ path: path.join(dir, name + ".png"), fullPage: true });
}
try {
  for (let i = 0; i < count; i++) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    contexts.push(context);
    await context.addInitScript(
      () => (
        Object.defineProperty(document, "hidden", { get: () => false }),
        Object.defineProperty(navigator, "getGamepads", {
          configurable: true,
          value: () => [],
        })
      ),
    );
    const p = await context.newPage();
    pages.push(p);
    p.on("pageerror", (e) => report.errors.push(e.message));
    await p.goto(i === 0 ? local : remote);
    await p.waitForFunction(() => window.smash);
  }
  const [a, b] = pages;
  report.backend = await a.evaluate(async () => {
    const { serviceFetch } = await import(
      new URL("js/service.js", document.baseURI)
    );
    return (await serviceFetch("/api/status")).json();
  });
  await a.locator(".header-actions [data-fullscreen]").click();
  await a.waitForFunction(
    () => document.fullscreenElement === document.documentElement,
  );
  await a.locator(".header-actions [data-fullscreen]").click();
  await shot(a, "console-home");
  await a.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  );
  await shot(a, "console-mobile");
  await a.setViewportSize({ width: 1440, height: 900 });
  record("Fullscreen console entry and responsive cartridge screen");
  await a.locator("#rom-file").setInputFiles({
    name: "invalid.z64",
    mimeType: "application/octet-stream",
    buffer: Buffer.alloc(32),
  });
  await a.waitForFunction(() =>
    document.getElementById("toast").textContent.includes("16 MB"),
  );
  assert.equal(await a.evaluate(() => smash.engine.loaded), false);
  await a.locator("#power-on").click();
  // A pointer parked over a native choice now selects it as the menu appears.
  await a.mouse.move(0, 0);
  await a.locator("#rom-file").setInputFiles(rom);
  await a.waitForFunction(
    () => smash.view === "native" && !smash.paused,
    null,
    { timeout: 90000 },
  );
  assert.equal((await gameState(a)).scene, 7);
  await a.mouse.move(0, 0);
  await shot(a, "native-main-menu");
  await act(a, ["KeyS"], 3, 22);
  await a.keyboard.down("KeyJ");
  await a.waitForFunction(() => smash.view === "browse");
  await a.keyboard.up("KeyJ");
  record(
    "Actual Smash main menu: native stick and A select VS Mode and open the room browser",
  );
  await a.locator("#player-name").fill("Dan");
  await a.locator("#create-open").click();
  await a.locator("#room-name").fill("Brothers Smash");
  await a.locator("#create-room").click();
  await a.waitForFunction(
    () =>
      !document.getElementById("room-setup").hidden &&
      document.getElementById("busy").hidden &&
      smash.engine.inspect().scene === 9,
    null,
    { timeout: 90000 },
  );
  await a.locator('[data-native-input="a"]').click();
  await waitState(a, "playing");
  assert.equal((await gameState(a)).scene, 16);
  assert.equal(await a.evaluate(() => smash.net.room.members.length), 1);
  await act(a, ["KeyW"], 28, 12);
  await act(a, ["KeyD"], 8, 12);
  await act(a, ["KeyJ"], 6, 20);
  assert.equal(
    await a.evaluate(() => smash.engine.inspect().players[0].selected),
    true,
  );
  assert.equal(await a.locator("#start-game").isDisabled(), true);
  await shot(a, "solo-fighter-selected");
  const fighter = await a.evaluate(
    () => smash.engine.inspect().players[0].fighter,
  );
  const token = await a.evaluate(() => smash.net.token);
  record("Host selects an actual fighter alone while the room remains open");
  for (const [i, p] of pages.entries()) {
    if (!i) continue;
    if (i === 1) {
      await p.goto(`${remote}/#room=${token}`);
      await p.locator("#join-name").fill("Brother");
      await p.locator("#join-room").click();
      await p.locator("#rom-file").setInputFiles(rom);
    } else {
      await p.keyboard.press("Enter");
      await p.waitForFunction(() => smash.attract.phase === "title");
      await p.locator("#rom-file").setInputFiles(rom);
      await p.waitForFunction(
        () => smash.view === "native" && !smash.paused,
        null,
        { timeout: 90000 },
      );
      await p.locator("#native-online").click();
      await p.locator("#player-name").fill(`Player ${i + 1}`);
      await p.locator("#refresh-rooms").click();
      await p.locator(".room-row").first().click();
    }
    await p.waitForFunction(
      (n) => smash.net.running && smash.net.connected.length === n,
      i + 1,
      { timeout: 90000 },
    );
    await a.waitForFunction(
      (n) => smash.net.running && smash.net.connected.length === n,
      i + 1,
      { timeout: 90000 },
    );
    const choice = await p.evaluate(() => smash.engine.inspect().players[0]);
    assert.equal(choice.selected, true);
    assert.equal(choice.fighter, fighter);
    assert.equal(await p.evaluate(() => smash.net.player), i);
  }
  await frames(a, 120);
  assert.equal(await a.evaluate(() => smash.net.repairs), 0);
  await shot(a, "friends-join-selected-fighter");
  record(
    "Fresh invitation and public-room arrivals inherit the existing selected fighter and distinct controller ports",
    { players: count },
  );
  // Input configuration is still available over the native room.
  await a.evaluate(() => {
    window.qaPad = {
      id: "QA N64 USB adapter",
      index: 0,
      mapping: "",
      connected: true,
      buttons: Array.from({ length: 17 }, () => ({ value: 0, pressed: false })),
      axes: [0, 0, 0, 0],
    };
    Object.defineProperty(navigator, "getGamepads", {
      configurable: true,
      value: () => [qaPad],
    });
  });
  await menu(a);
  await a.locator("#menu-dialog [data-controls]").click();
  await a.locator("#device").selectOption("0");
  await a.evaluate(() => (qaPad.buttons[0] = { value: 1, pressed: true }));
  await a.waitForFunction(() =>
    document.getElementById("control-test").textContent.includes("Attack"),
  );
  await a.evaluate(() => (qaPad.buttons[0] = { value: 0, pressed: false }));
  await a.locator('[data-action="a"]').click();
  await a.waitForFunction(() => smash.controls.capture?.armed);
  await a.evaluate(() => (qaPad.buttons[7] = { value: 1, pressed: true }));
  await a.waitForFunction(() => smash.controls.profile.map.a.index === 7);
  await a.evaluate(() => (qaPad.buttons[7] = { value: 0, pressed: false }));
  await a.locator('[data-action="up"]').click();
  await a.waitForFunction(() => smash.controls.capture?.armed);
  await a.evaluate(() => (qaPad.axes[3] = 1));
  await a.waitForFunction(() => smash.controls.profile.map.up.index === 3);
  await a.evaluate(() => (qaPad.axes[3] = 0));
  await shot(a, "controller-setup");
  await a.locator("#device").selectOption("keyboard");
  await a.locator('[data-close="controls-dialog"]').click();
  await a.locator("#resume-menu").click();
  await frames(a, 60);
  record(
    "N64 adapter button and axis mapping, live preview, and shared pause still work",
  );
  for (const [i, p] of pages.entries())
    if (i) {
      await act(p, ["KeyW"], 28, 12);
      if (i === 1) await act(p, ["KeyA"], 8, 12);
      if (i === 3) await act(p, ["KeyA"], 8, 12);
      await act(p, ["KeyJ"], 6, 20);
    }
  for (const p of pages)
    assert.ok(
      (await p.evaluate(() => smash.engine.inspect().players))
        .slice(0, count)
        .every((p) => p.selected),
    );
  await b.evaluate(() => smash.net.socket.close());
  await a.waitForFunction(
    (n) => smash.net.running && smash.net.connected.length === n,
    count - 1,
    { timeout: 90000 },
  );
  await waitState(b, "error");
  await b.locator("#game-rejoin").click();
  await b.waitForFunction(
    () => smash.net.running && smash.net.player === 1,
    null,
    { timeout: 90000 },
  );
  await b.evaluate(() =>
    smash.net.send({ type: "pointer", scene: 16, x: 128, y: 64 }),
  );
  await frames(a, 120);
  assert.ok(
    (await b.evaluate(() => smash.engine.inspect().players))
      .slice(0, count)
      .every((p) => p.selected),
  );
  record(
    "Selection continues after a guest disconnect; reconnect reclaims the open port and can select again",
  );
  await shot(a, "native-fighters-selected");
  await a.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  );
  await shot(a, "native-room-mobile");
  await a.setViewportSize({ width: 1440, height: 900 });
  await act(b, ["Enter"], 6, 30);
  assert.equal(await b.evaluate(() => smash.net.room.selecting), true);
  await a.locator("#start-game").click();
  await a.waitForFunction(() => !smash.net.room.selecting);
  await frames(a, 110);
  assert.equal(
    await a.evaluate(async () => {
      const { serviceFetch } = await import(
        new URL("js/service.js", document.baseURI)
      );
      return (await (await serviceFetch("/api/rooms")).json()).rooms[0]
        .selecting;
    }),
    false,
  );
  await act(a, ["KeyJ"], 6, 240);
  await frames(a, 300);
  assert.deepEqual(await gameState(a), { scene: 22, humans: count });
  assert.deepEqual(
    await a.locator("#canvas").evaluate((e) => {
      const r = e.getBoundingClientRect();
      return [r.width, r.height];
    }),
    [1440, 900],
  );
  await shot(a, "native-four-player-battle");
  record(
    "Host starts the selected fighters, room locks during the battle, game fills viewport",
    { humans: count },
  );
  if (count === 4) {
    await menu(a);
    await a.locator("#back-lobby").click();
    await a.waitForFunction(
      () => smash.net.running && smash.net.room.match === 2,
      null,
      { timeout: 90000 },
    );
    for (const p of pages.slice(2)) {
      await menu(p);
      await p.locator("#quit-game").click();
    }
    await a.waitForFunction(
      () => smash.net.running && smash.net.room.members.length === 2,
      null,
      { timeout: 90000 },
    );
    await act(a, ["KeyW"], 28, 12);
    await act(a, ["KeyD"], 8, 12);
    await act(a, ["KeyJ"], 6, 20);
    await act(b, ["KeyW"], 28, 12);
    await act(b, ["KeyD"], 3, 12);
    await act(b, ["KeyJ"], 6, 20);
    await act(a, ["Enter"], 6, 110);
    await act(a, ["KeyJ"], 6, 240);
    await frames(a, 300);
    assert.deepEqual(await gameState(a), { scene: 22, humans: 2 });
    record(
      "Returning to character selection reopens the room and supports a two-player rematch",
    );
  }
  const before = await a.evaluate(() => ({
    frames: smash.engine.frames,
    time: performance.now(),
    checks: smash.net.matches,
  }));
  for (let i = 0; i < 6; i++)
    await Promise.all([
      act(a, ["KeyJ"], 9, 14),
      act(b, [i % 2 ? "KeyJ" : "KeyK"], 9, 14),
    ]);
  await frames(a, 120);
  const after = await a.evaluate(() => ({
    frames: smash.engine.frames,
    time: performance.now(),
    checks: smash.net.matches,
    repairs: smash.net.repairs,
  }));
  assert.ok(after.checks > before.checks + 3);
  assert.equal(after.repairs, 0);
  await shot(a, "native-two-player-battle");
  record("Real two-player battle stays synchronized", {
    fps: Math.round(
      ((after.frames - before.frames) * 1000) / (after.time - before.time),
    ),
    matches: after.checks,
    repairs: after.repairs,
  });
  await a.evaluate(() => {
    const n = smash.net,
      send = n.sendGame.bind(n);
    let dropped = false;
    n.sendGame = (m, ...rest) => {
      if (m.type === "input" && !dropped) {
        dropped = true;
        return;
      }
      return send(m, ...rest);
    };
    n.closeRTC();
  });
  await frames(a, 240);
  assert.equal(await a.evaluate(() => smash.net.repairs), 0);
  record(
    "A dropped input and closed peer channels do not stall or desynchronize the match",
  );
  const epoch = await a.evaluate(() => smash.net.epoch);
  await b.evaluate(() => smash.engine.module._netplay_corrupt_rdram());
  await a.waitForFunction(
    (e) =>
      smash.net.repairs === 1 &&
      smash.net.epoch > e &&
      smash.net.running &&
      smash.net.frame > 180,
    epoch,
    { timeout: 60000 },
  );
  record("Deliberate desynchronization detected and repaired");
  await menu(b);
  await b.locator("#menu-dialog [data-controls]").click();
  for (const p of [a, b]) await waitState(p, "paused");
  const frame = await a.evaluate(() => smash.net.frame);
  await sleep(400);
  assert.equal(await a.evaluate(() => smash.net.frame), frame);
  await b.locator('[data-close="controls-dialog"]').click();
  await b.locator("#resume-menu").click();
  await frames(a, 120);
  record("Controller overlay pauses everyone and resumes together");
  await b.evaluate(() => smash.net.socket.close());
  await frames(a, 60);
  assert.equal(await a.evaluate(() => smash.net.running), true);
  await waitState(b, "error");
  await b.locator("#game-rejoin").click();
  await a.waitForFunction(
    () => smash.net.running && smash.net.frame > 120,
    null,
    { timeout: 60000 },
  );
  assert.equal(await b.evaluate(() => smash.net.player), 1);
  record(
    "Guest disconnect leaves battle running; rejoin restores the reserved port",
  );
  report.finalMultiplayer = await Promise.all(
    [a, b].map((p) => p.evaluate(() => smash.diagnostics())),
  );
  await menu(a);
  await a.locator("#quit-game").click();
  await b.waitForFunction(() => smash.net.isHost && smash.net.running, null, {
    timeout: 60000,
  });
  await frames(b, 60);
  await menu(b);
  await b.locator("#quit-game").click();
  record("Host exit transfers authority and keeps the match running");
  await a.locator("[data-home]").click();
  await a.waitForFunction(() => smash.view === "native");
  await a.locator("#native-single").click();
  await a.waitForFunction(() => smash.view === "game");
  await menu(a);
  const hash = await a.evaluate(() => smash.engine.hash());
  await a.locator("#save").click();
  await a.waitForFunction(() =>
    document.getElementById("toast").textContent.includes("Progress saved"),
  );
  const downloadEvent = a.waitForEvent("download");
  await a.locator("#export-save").click();
  const download = await downloadEvent;
  const savePath = path.join(dir, "qa-progress.smash64");
  await download.saveAs(savePath);
  await a.evaluate(() => {
    const restore = smash.engine.restore.bind(smash.engine);
    smash.engine.restore = (bytes) => {
      restore(bytes);
      window.qaRestoredHash = smash.engine.hash();
    };
  });
  await a.locator("#load-save").click();
  await a.waitForFunction(() => window.qaRestoredHash);
  assert.equal(await a.evaluate(() => qaRestoredHash), hash);
  await menu(a);
  await a.evaluate(() => (window.qaRestoredHash = null));
  await a.locator("#save-file").setInputFiles(savePath);
  await a.waitForFunction(() => window.qaRestoredHash);
  assert.equal(await a.evaluate(() => qaRestoredHash), hash);
  record("Local save, load, export and import retain progress");
  await a.reload();
  await a.waitForFunction(() =>
    document.getElementById("cartridge-badge").classList.contains("ready"),
  );
  assert.equal(await a.evaluate(() => smash.engine.loaded), false);
  assert.equal(
    await a.evaluate(
      () => smash.controls.saved["QA N64 USB adapter"].map.a.index,
    ),
    7,
  );
  record("ROM and controller profiles survive reload");
  assert.deepEqual(report.errors, []);
  record("No uncaught browser errors");
  report.passed = true;
} catch (e) {
  report.passed = false;
  report.failure = e.stack;
  console.error(e);
  for (const [i, p] of pages.entries())
    try {
      await shot(p, `failure-${i}`);
    } catch {}
  process.exitCode = 1;
} finally {
  report.finished = new Date().toISOString();
  await writeFile(
    process.env.SMASH_REPORT || path.join(dir, "e2e-report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  await Promise.race([browser.close(), sleep(3000)]);
  process.exit(process.exitCode || 0);
}
