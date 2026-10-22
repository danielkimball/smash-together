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
    ? (await (await fetch(local + "/api/status")).json()).shareUrl
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
        let active = count,
          quiet = settle;
        const timeout = setTimeout(() => {
          c.sample = original;
          reject(Error("Input timed out"));
        }, 90000);
        c.sample = () => {
          if (active-- > 0) {
            c.keys = new Set(keys);
            const input = original();
            c.keys.clear();
            return input;
          }
          if (quiet-- > 0) return { buttons: 0, x: 0, y: 0 };
          c.sample = original;
          clearTimeout(timeout);
          resolve();
          return original();
        };
      }),
    { keys, count, settle },
  );
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
  await p.screenshot({ path: path.join(dir, name + ".png"), fullPage: true });
}
try {
  for (let i = 0; i < count; i++) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    contexts.push(context);
    // Isolated test pages represent separate foreground computers.
    await context.addInitScript(() =>
      Object.defineProperty(document, "hidden", { get: () => false }),
    );
    const page = await context.newPage();
    pages.push(page);
    page.on("pageerror", (e) => report.errors.push(e.message));
    await page.goto(i === 0 ? local : remote);
    await page.waitForFunction(() => window.smash);
  }
  const [a, b] = pages;
  await a.locator(".header-actions [data-fullscreen]").click();
  await a.waitForFunction(
    () => document.fullscreenElement === document.documentElement,
  );
  await a.locator(".header-actions [data-fullscreen]").click();
  await a.waitForFunction(() => !document.fullscreenElement);
  record("Native fullscreen toggle keeps the whole application in fullscreen");
  await shot(a, "home-desktop");
  await a.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  );
  await shot(a, "home-mobile");
  await a.setViewportSize({ width: 1440, height: 900 });
  record("Responsive fullscreen menu at desktop and phone widths");
  await a.locator("#rom-file").setInputFiles({
    name: "invalid.z64",
    mimeType: "application/octet-stream",
    buffer: Buffer.alloc(32),
  });
  await a.waitForFunction(() =>
    document.getElementById("toast").textContent.includes("16 MB"),
  );
  assert.equal(await a.evaluate(() => smash.engine.loaded), false);
  record("Invalid ROM rejected");
  for (const [i, p] of pages.entries()) {
    await p.locator("#multiplayer").click();
    await p
      .locator("#player-name")
      .fill(["Dan", "Brother", "Player Three", "Player Four"][i]);
    await p.locator("#rom-file").setInputFiles(rom);
    await p.waitForFunction(() =>
      document.getElementById("cartridge-badge").classList.contains("ready"),
    );
  }
  await a.locator("#create-open").click();
  await a.locator("#room-name").fill("One more match");
  await a.locator("#create-dialog summary").click();
  await a.locator("#delay").selectOption("9");
  await a.locator("#create-room").click();
  await waitState(a, "lobby");
  const token = await a.evaluate(() => smash.net.token);
  for (const p of pages.slice(1)) {
    await p.locator("#refresh-rooms").click();
    await p.locator(".room-row").first().click();
    await waitState(p, "lobby");
  }
  await a.waitForFunction((n) => smash.net.room.members.length === n, count);
  assert.equal(await a.locator("#start-game").isDisabled(), true);
  record(
    "Room browser joins live waiting lobby; host start is gated by readiness",
    { players: count },
  );
  if (count === 4) {
    await pages[3].locator("#leave-room").click();
    await a.waitForFunction(() => smash.net.room.members.length === 3);
    await a.locator('[data-slot="3"]').click();
    await a.waitForFunction(() => smash.net.player === 3);
    assert.equal(await a.evaluate(() => smash.net.isHost), true);
    await a.locator('[data-slot="0"]').click();
    await a.waitForFunction(() => smash.net.player === 0);
    await pages[3].locator("#refresh-rooms").click();
    await pages[3].locator(".room-row").first().click();
    await waitState(pages[3], "lobby");
    record(
      "Player port selection keeps host authority and frees abandoned lobby ports",
    );
  }
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
  await a.locator("#lobby-screen [data-controls]").click();
  await a.locator("#device").selectOption("0");
  await a.evaluate(() => (qaPad.buttons[0] = { value: 1, pressed: true }));
  await a.waitForFunction(() =>
    document.getElementById("control-test").textContent.includes("Attack"),
  );
  await a.evaluate(() => (qaPad.buttons[0] = { value: 0, pressed: false }));
  await a.locator('[data-action="a"]').click();
  await sleep(550);
  await a.evaluate(() => (qaPad.buttons[7] = { value: 1, pressed: true }));
  await a.waitForFunction(() => smash.controls.profile.map.a.index === 7);
  await a.evaluate(() => (qaPad.buttons[7] = { value: 0, pressed: false }));
  await a.locator('[data-action="up"]').click();
  await sleep(550);
  await a.evaluate(() => (qaPad.axes[3] = 1));
  await a.waitForFunction(() => smash.controls.profile.map.up.index === 3);
  await a.evaluate(() => (qaPad.axes[3] = 0));
  await shot(a, "controller-setup");
  await a.locator("#device").selectOption("keyboard");
  await a.locator('[data-close="controls-dialog"]').click();
  record("Controller preview and N64 button/axis mapping persist");
  await shot(a, "lobby-desktop");
  await a.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  );
  await shot(a, "lobby-mobile");
  await a.setViewportSize({ width: 1440, height: 900 });
  for (const p of pages) await p.locator("#ready-button").click();
  await a.waitForFunction(
    () => !document.getElementById("start-game").disabled,
  );
  await shot(a, "lobby-ready");
  await a.locator("#start-game").click();
  await waitState(a, "preparing");
  await b.evaluate(() => smash.net.socket.close());
  await waitState(a, "waiting");
  await waitState(b, "error");
  await b.locator("#game-rejoin").click();
  for (const p of pages) await waitState(p, "playing");
  record(
    "Guest reconnect during startup waits for the completed character screen",
  );
  await a.waitForFunction((n) => smash.net.matches >= n, (count - 1) * 3, {
    timeout: 60000,
  });
  assert.equal(await a.evaluate(() => smash.net.repairs), 0);
  assert.deepEqual(
    await a.locator("#canvas").evaluate((e) => {
      const r = e.getBoundingClientRect();
      return [r.width, r.height];
    }),
    [1440, 900],
  );
  assert.equal(
    (await gameState(a)).scene,
    16,
    "Startup must reach VS character selection",
  );
  await shot(a, "character-select");
  record(
    "Host starts everyone directly in fullscreen game with matching states",
    { players: count },
  );
  if (count === 4) {
    await Promise.all(pages.map((p) => act(p, ["KeyW"], 28, 12)));
    await Promise.all([
      act(a, ["KeyD"], 8, 12),
      act(b, ["KeyD"], 3, 12),
      act(pages[3], ["KeyA"], 8, 12),
    ]);
    await Promise.all(pages.map((p) => act(p, ["KeyJ"], 6, 20)));
    await shot(a, "four-fighters-selected");
    await act(a, ["Enter"], 6, 110);
    await act(a, ["KeyJ"], 6, 240);
    await frames(a, 240);
    assert.deepEqual(
      await gameState(a),
      { scene: 22, humans: 4 },
      "Four human fighters must enter an actual VS battle",
    );
    await Promise.all(
      pages.map((p, i) => act(p, [i % 2 ? "KeyD" : "KeyA"], 10, 20)),
    );
    await shot(a, "four-player-fight");
    await frames(a, 180);
    assert.equal(await a.evaluate(() => smash.net.repairs), 0);
    record(
      "All four network controller ports advance in deterministic lockstep",
    );
    await menu(a);
    await a.locator("#back-lobby").click();
    for (const p of pages) await waitState(p, "lobby");
    for (const p of pages.slice(2)) await p.locator("#leave-room").click();
    await a.waitForFunction(() => smash.net.room.members.length === 2);
    for (const p of [a, b]) await p.locator("#ready-button").click();
    await a.locator("#start-game").click();
    for (const p of [a, b]) await waitState(p, "playing");
    await frames(a, 60);
    record("Return to waiting lobby and rematch with a changed player roster");
  }
  await act(a, ["KeyW"], 28, 12);
  await act(a, ["KeyD"], 8, 12);
  await act(a, ["KeyJ"], 6, 20);
  await act(b, ["KeyW"], 28, 12);
  await act(b, ["KeyD"], 3, 12);
  await act(b, ["KeyJ"], 6, 20);
  await shot(a, "fighters-selected");
  await act(a, ["Enter"], 6, 110);
  await act(a, ["KeyJ"], 6, 240);
  await frames(a, 300);
  assert.deepEqual(
    await gameState(a),
    { scene: 22, humans: 2 },
    "Two human fighters must enter an actual VS battle",
  );
  const before = await a.evaluate(() => ({
    frames: smash.engine.frames,
    time: performance.now(),
    checks: smash.net.matches,
  }));
  await Promise.all([act(a, ["KeyD"], 20, 1), act(b, ["KeyA"], 20, 1)]);
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
    audio: smash.engine.audio.ctx.state,
  }));
  assert.ok(after.checks > before.checks + 3);
  assert.equal(after.repairs, 0);
  assert.equal(after.audio, "running");
  await shot(a, "fight-player-1");
  await shot(b, "fight-player-2");
  record(
    "Fighter selection and two-player gameplay; screenshots for visual verification",
    {
      fps: Math.round(
        ((after.frames - before.frames) * 1000) / (after.time - before.time),
      ),
      matches: after.checks,
      repairs: after.repairs,
    },
  );
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
  record("Direct-to-relay fallback recovers a dropped input");
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
  await waitState(a, "waiting");
  await waitState(b, "error");
  await b.locator("#game-rejoin").click();
  await a.waitForFunction(
    () => smash.net.running && smash.net.frame > 120,
    null,
    { timeout: 60000 },
  );
  assert.equal(await b.evaluate(() => smash.net.player), 1);
  record("Disconnected guest rejoins the reserved controller port and match");
  report.finalMultiplayer = await Promise.all(
    [a, b].map((p) => p.evaluate(() => smash.diagnostics())),
  );
  await menu(a);
  await a.locator("#quit-game").click();
  await waitState(b, "error");
  await b.locator("#game-leave").click();
  record("Host exit closes the room and returns guests to room browsing");
  await a.locator("[data-home]").click();
  await a.locator("#local-play").click();
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
    path.join(dir, "e2e-report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  await browser.close();
}
