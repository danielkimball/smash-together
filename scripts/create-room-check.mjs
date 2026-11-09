// Create room must reach VS Mode however the saved main menu was left. The
// native cursor keeps a quick stick tap made during the opening, before the
// portal saves the main menu. A fixed "Down, A" then opened Option (or Data),
// stranded the host on a paused screen and never opened the room.
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
const { wait, scene, browse, create, openPage } = browserHelpers(browser, {
  url,
  pages,
  errors,
});

// Reach the main menu like a quick player: Start through the opening, then tap
// the stick on the first menu frames, before the portal saves that menu.
async function openRemembering(key) {
  const c = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    permissions: ["microphone"],
  });
  await c.addInitScript(() => {
    Object.defineProperty(document, "hidden", { get: () => false });
    Object.defineProperty(navigator, "getGamepads", {
      configurable: true,
      value: () => [],
    });
  });
  const p = await c.newPage();
  pages.push(p);
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(url);
  await p.waitForFunction(() => window.smash);
  await p.waitForFunction(
    () => smash.engine.loaded && document.getElementById("busy").hidden,
    null,
    { timeout: 90000 },
  );
  await p.evaluate((key) => {
    const c = smash.controls,
      original = c.sample.bind(c);
    let menuFrames = 0;
    c.sample = () => {
      if (smash.engine.info?.scene !== 7) return original();
      menuFrames++;
      if (menuFrames < 4) return original();
      c.keys = new Set([key]);
      const input = original();
      c.keys.clear();
      if (menuFrames >= 8) c.sample = original;
      return input;
    };
  }, key);
  for (let i = 0; i < 12; i++) {
    if (await p.evaluate(() => smash.engine.inspect().scene === 7)) break;
    await p.locator("#power-on").click();
    await p.mouse.move(0, 0);
    await wait(1400);
  }
  await p.waitForFunction(
    () => !document.getElementById("native-menu").hidden,
    null,
    { timeout: 30000 },
  );
  // Main menu rows: 0 1P Game, 1 VS Mode, 2 Option, 3 Data.
  const row = await p.evaluate(() => smash.engine.inspect().menu.row);
  return { p, row };
}

async function createFrom(p, roomName) {
  await p.locator("#create-open").click();
  await p.locator("#room-name").fill(roomName);
  await p.locator("#create-room").click();
  await p.waitForFunction(
    () =>
      document.getElementById("busy").hidden &&
      !document.getElementById("create-dialog").open &&
      smash.engine.inspect().scene !== 7,
    null,
    { timeout: 90000 },
  );
  await wait(500);
  return p.evaluate(() => ({
    scene: smash.engine.inspect().scene,
    view: smash.view,
    paused: smash.paused,
    title: document.getElementById("setup-title").textContent,
    setupVisible: !document.getElementById("room-setup").hidden,
    toast: document.getElementById("toast").hidden
      ? ""
      : document.getElementById("toast").textContent,
  }));
}

async function openRoom(p) {
  await p.locator('[data-native-input="a"]').click();
  await p.waitForFunction(() => smash.net.running, null, { timeout: 90000 });
  await scene(p, 16);
  await p.locator("#copy-invite").click();
  await p.waitForFunction(() =>
    document.getElementById("invite-link").value.includes("#room="),
  );
  const link = await p.locator("#invite-link").inputValue();
  await p.locator("#invite-dialog [data-close]").first().click();
  return link;
}

try {
  await mkdir("artifacts", { recursive: true });

  // 1. The reported case: Down tapped during the opening left VS Mode selected.
  {
    const { p, row } = await openRemembering("KeyS");
    assert.equal(row, 1, "precondition: saved main menu remembers VS Mode");
    await browse(p);
    const setup = await createFrom(p, "QA remembered VS Mode");
    await p.screenshot({ path: "artifacts/create-room-remembered.png" });
    assert.equal(setup.scene, 9, `Create room opened scene ${setup.scene}`);
    assert.equal(setup.title, "QA remembered VS Mode");
    assert.equal(setup.paused, false);
    const link = await openRoom(p);
    assert.match(link, /#room=[a-f0-9]{36}/);
    record("Create room opens VS Mode when the saved menu remembers VS Mode", {
      savedRow: row,
      ...setup,
      invite: true,
    });
    await p.context().close();
  }

  // 2. Up tapped during the opening: the cursor wraps to Data (or stays put).
  {
    const { p, row } = await openRemembering("KeyW");
    await browse(p);
    const setup = await createFrom(p, "QA remembered row");
    assert.equal(setup.scene, 9, `Create room opened scene ${setup.scene}`);
    assert.equal(setup.paused, false);
    record("Create room opens VS Mode from any remembered main-menu row", {
      savedRow: row,
      scene: setup.scene,
    });
    await p.context().close();
  }

  // 3. The new host after a handoff prepares character selection the same way.
  {
    const { p, row } = await openRemembering("KeyS");
    assert.equal(row, 1);
    await browse(p);
    await p.evaluate(() => smash.net.prepare());
    assert.equal(await p.evaluate(() => smash.engine.inspect().scene), 16);
    record("Host preparation reaches character selection from VS Mode row", {
      savedRow: row,
    });
    await p.context().close();
  }

  // 4. A failed setup returns to the room list with its message instead of a
  // paused native screen; the ordinary path (1P Game saved) then opens a room.
  {
    const p = await openPage();
    assert.equal(await p.evaluate(() => smash.engine.inspect().menu.row), 0);
    await browse(p);
    // Simulate a lost main menu: VS settings stay on screen, restore is skipped.
    await p.evaluate(() => {
      smash.engine.originalRestore = smash.engine.restore;
      smash.engine.restore = () => {};
    });
    await p.locator("#create-open").click();
    await p.locator("#create-room").click();
    await p.waitForFunction(
      () =>
        smash.view === "browse" &&
        !document.getElementById("toast").hidden &&
        document.getElementById("busy").hidden,
      null,
      { timeout: 60000 },
    );
    const failed = await p.evaluate(() => ({
      view: smash.view,
      setupHidden: document.getElementById("room-setup").hidden,
      toast: document.getElementById("toast").textContent,
    }));
    assert.equal(failed.setupHidden, true);
    assert.match(failed.toast, /Could not/);
    await p.evaluate(() => {
      smash.engine.restore = smash.engine.originalRestore;
    });
    record("A failed room setup returns to the room list with its message", {
      ...failed,
    });
    await create(p);
    record("Create room still works from the default main-menu row");
    await p.context().close();
  }
  assert.deepEqual(errors, []);
} catch (e) {
  console.error(e);
  const open = pages.filter((p) => !p.isClosed());
  await open
    .at(-1)
    ?.screenshot({ path: "artifacts/create-room-failure.png" })
    .catch(() => {});
  console.log(
    await open
      .at(-1)
      ?.evaluate(() => ({
        info: smash.engine.inspect(),
        view: smash.view,
        paused: smash.paused,
        title: document.getElementById("setup-title").textContent,
        toast: document.getElementById("toast").textContent,
      }))
      .catch(() => null),
  );
  process.exitCode = 1;
} finally {
  await writeFile(
    "artifacts/create-room-check.json",
    JSON.stringify({ checks, errors }, null, 2),
  );
  await browser.close();
}
