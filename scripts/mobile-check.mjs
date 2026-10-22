import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
const url = process.env.SMASH_URL || "http://localhost:8790";
const browser = await chromium.launch({
  headless: true,
  executablePath:
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  args: [
    "--autoplay-policy=no-user-gesture-required",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
  ],
});
const pages = [],
  checks = [],
  errors = [];
const record = (name, data) => {
  checks.push({ name, ...data });
  console.log("PASS", name, data ? JSON.stringify(data) : "");
};
async function scene(p, n) {
  await p.waitForFunction(
    (n) =>
      smash.engine.loaded &&
      document.getElementById("busy").hidden &&
      smash.engine.inspect().scene === n,
    n,
    { timeout: 90000 },
  );
}
async function frames(p, n) {
  const f = await p.evaluate(() => smash.engine.frames);
  await p.waitForFunction((f) => smash.engine.frames >= f, f + n, {
    timeout: 90000,
  });
}
async function native(p, action) {
  await p.locator(`[data-native-input="${action}"]`).click();
  await frames(p, 24);
}
async function act(p, keys, count = 6, settle = 30) {
  await p.evaluate(
    ({ keys, count, settle }) =>
      new Promise((resolve, reject) => {
        const c = smash.controls,
          original = c.sample.bind(c);
        let active = count,
          quiet = settle;
        const timer = setTimeout(() => {
          c.sample = original;
          reject(Error("Input timeout"));
        }, 90000);
        c.sample = () => {
          if (active-- > 0) {
            c.keys = new Set(keys);
            const i = original();
            c.keys.clear();
            return i;
          }
          if (quiet-- > 0) return { buttons: 0, x: 0, y: 0 };
          c.sample = original;
          clearTimeout(timer);
          resolve();
          return original();
        };
      }),
    { keys, count, settle },
  );
}
const point = async (p, sel, id = 1) => {
  const b = await p.locator(sel).boundingBox();
  assert.ok(b, sel);
  return {
    x: b.x + b.width / 2,
    y: b.y + b.height / 2,
    id,
    radiusX: 3,
    radiusY: 3,
    force: 1,
  };
};
let cdp;
const touches = async (type, points) =>
  cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points });
async function touchAct(p, action, count = 6, settle = 30) {
  let q;
  if (["up", "down", "left", "right"].includes(action)) {
    q = await point(p, ".touch-stick");
    const b = await p.locator(".touch-stick").boundingBox();
    q.x +=
      action === "left"
        ? -b.width * 0.4
        : action === "right"
          ? b.width * 0.4
          : 0;
    q.y +=
      action === "up"
        ? -b.height * 0.4
        : action === "down"
          ? b.height * 0.4
          : 0;
  } else q = await point(p, `#touch-controls [data-touch="${action}"]`);
  await touches("touchStart", [q]);
  await frames(p, count);
  await touches("touchEnd", []);
  await frames(p, settle);
}
try {
  await mkdir("artifacts", { recursive: true });
  for (let i = 0; i < 2; i++) {
    const context = await browser.newContext(
      i
        ? {
            viewport: { width: 390, height: 844 },
            isMobile: true,
            hasTouch: true,
            deviceScaleFactor: 1,
          }
        : { viewport: { width: 1440, height: 900 } },
    );
    await context.addInitScript(() => {
      Object.defineProperty(document, "hidden", { get: () => false });
      Object.defineProperty(navigator, "getGamepads", {
        configurable: true,
        value: () => [],
      });
    });
    const p = await context.newPage();
    pages.push(p);
    p.on("pageerror", (e) => errors.push(e.message));
    await p.goto(url);
    await p.locator("#testing-access").click();
    await p.locator("#testing-password").fill(process.env.SMASH_TEST_PASSWORD);
    await p.locator("#testing-password").press("Enter");
    await scene(p, 7);
    if (i) {
      await p.screenshot({ path: "artifacts/mobile-portrait-menu.png" });
      await p.locator(".touch-menu").tap();
      await p.locator("#menu-dialog").waitFor({ state: "visible" });
      await p.locator("#resume-menu").tap();
      await p.waitForFunction(() => !smash.paused);
      record("Phone Menu opens and resumes local play with real taps");
    }
    await p.locator("#native-online").click();
    await p.locator("#player-name").fill(i ? "Phone Brother" : "Dan");
  }
  const [a, b] = pages;
  cdp = await b.context().newCDPSession(b);
  assert.equal(await b.evaluate(() => smash.controls.touch.enabled), true);
  assert.deepEqual(await a.evaluate(() => smash.engine.inspect().unlocks), {
    features: 127,
    fighters: 4095,
  });
  record(
    "All twelve fighters, Mushroom Kingdom and native bonus options unlocked at boot",
  );
  // Verify real simultaneous touch events without advancing the paused browser view.
  await b.evaluate(() => {
    document.getElementById("game-view").hidden = false;
    document.getElementById("game-notice").hidden = true;
    smash.controls.blocked = false;
  });
  const stick = await point(b, ".touch-stick");
  const moved = { ...stick, x: stick.x + 45 };
  const ab = await point(b, ".touch-a", 2),
    bb = await point(b, ".touch-b", 3);
  await touches("touchStart", [moved]);
  await touches("touchStart", [moved, ab]);
  await touches("touchStart", [moved, ab, bb]);
  let sample = await b.evaluate(() => smash.controls.sample());
  assert.ok(sample.x > 60);
  assert.equal(sample.buttons & 192, 192);
  await touches("touchEnd", []);
  assert.deepEqual(await b.evaluate(() => smash.controls.sample()), {
    buttons: 0,
    x: 0,
    y: 0,
  });
  record("Real three-finger joystick + A + B input works and releases cleanly");
  const expected = {
    l: 8192,
    r: 4096,
    z: 32,
    a: 128,
    b: 64,
    cu: 2048,
    cl: 512,
    cr: 256,
    cd: 1024,
    du: 8,
    dl: 2,
    dr: 1,
    dd: 4,
    start: 16,
  };
  for (const [key, bit] of Object.entries(expected)) {
    const q = await point(b, `#touch-controls [data-touch="${key}"]`);
    await touches("touchStart", [q]);
    assert.equal(
      (await b.evaluate(() => smash.controls.sample())).buttons,
      bit,
      key,
    );
    await touches("touchEnd", []);
  }
  record("All fourteen touch buttons send the correct N64 input");
  await touches("touchStart", [moved]);
  await touches("touchCancel", []);
  assert.deepEqual(await b.evaluate(() => smash.controls.sample()), {
    buttons: 0,
    x: 0,
    y: 0,
  });
  await touches("touchStart", [moved]);
  await b.setViewportSize({ width: 844, height: 390 });
  await b.waitForTimeout(300);
  assert.deepEqual(await b.evaluate(() => smash.controls.sample()), {
    buttons: 0,
    x: 0,
    y: 0,
  });
  await touches("touchEnd", []);
  await b.screenshot({ path: "artifacts/mobile-landscape-menu.png" });
  record("Touch cancellation and rotation release held inputs");
  await b.setViewportSize({ width: 390, height: 844 });
  await b.evaluate(() => {
    document.getElementById("game-view").hidden = true;
    smash.controls.blocked = true;
  });
  await a.locator("#create-open").click();
  await a.locator("#room-name").fill("Phone arena");
  await a.locator("#create-room").click();
  await scene(a, 9);
  await native(a, "down");
  await native(a, "right");
  await native(a, "down");
  await native(a, "left");
  await native(a, "left");
  await native(a, "up");
  await native(a, "up");
  await native(a, "a");
  await a.waitForFunction(() => smash.net.running, null, { timeout: 90000 });
  await b.locator("#refresh-rooms").click();
  await b.locator(".room-row").filter({ hasText: "Phone arena" }).click();
  await b.waitForFunction(() => smash.net.running, null, { timeout: 90000 });
  assert.equal(
    await b.evaluate(() => smash.engine.inspect().unlocks.fighters),
    4095,
  );
  await frames(b, 40);
  await b.screenshot({ path: "artifacts/mobile-portrait-lobby.png" });
  await act(a, ["KeyW"], 28, 12);
  await act(a, ["KeyA"], 10, 12);
  await act(a, ["KeyJ"], 6, 20);
  await touchAct(b, "up", 28, 12);
  await touchAct(b, "right", 3, 12);
  await touchAct(b, "a", 6, 20);
  let selection = await a.evaluate(() => smash.engine.inspect().players);
  console.log("SELECTION", JSON.stringify(selection));
  assert.ok(selection[0].selected && selection[1].selected);
  assert.ok(
    [4, 7, 10, 11].includes(selection[0].fighter),
    "Host selected an unlocked fighter",
  );
  record(
    "Phone touch stick and A choose a fighter in the shared lobby; hidden fighter is playable",
    { selection: selection.slice(0, 2) },
  );
  await b.setViewportSize({ width: 844, height: 390 });
  await b.waitForTimeout(300);
  await b.screenshot({ path: "artifacts/mobile-landscape-lobby.png" });
  await a.locator("#start-game").click();
  await scene(a, 21);
  await act(a, [], 0, 110);
  assert.equal(
    (await a.evaluate(() => smash.engine.inspect().stage.unlocked)) & 16,
    16,
  );
  const first = await a.evaluate(() => smash.engine.inspect().stage.slot);
  await touchAct(b, "right", 8, 20);
  await touchAct(b, "a", 6, 20);
  assert.equal(await a.evaluate(() => smash.engine.inspect().scene), 21);
  assert.equal(
    await a.evaluate(() => smash.engine.inspect().stage.slot),
    first,
  );
  record(
    "First stage is host-controlled; guest cannot move or confirm it; Mushroom Kingdom is unlocked",
  );
  // Peach’s Castle is slot 0. Navigate there through native controls for a quick stock match.
  for (
    let i = 0;
    i < 10 && (await a.evaluate(() => smash.engine.inspect().stage.slot)) !== 0;
    i++
  )
    await act(a, ["ArrowRight"], 3, 15);
  assert.equal(await a.evaluate(() => smash.engine.inspect().stage.slot), 0);
  await act(a, ["KeyJ"], 6, 240);
  await scene(a, 22);
  await b.screenshot({ path: "artifacts/mobile-landscape-battle.png" });
  await b.setViewportSize({ width: 390, height: 844 });
  await b.waitForTimeout(250);
  await b.screenshot({ path: "artifacts/mobile-portrait-battle.png" });
  // Walk host Luigi off the left edge; this produces a real native stock result.
  await act(a, ["KeyA"], 340, 180);
  await scene(a, 24);
  await frames(a, 160);
  const outcome = await a.evaluate(() => ({
    results: smash.engine.inspect().results,
    winner: smash.net.rounds.winnerId,
    bro: smash.net.room.members.find((p) => p.slot === 1).id,
  }));
  assert.equal(outcome.winner, outcome.bro);
  assert.equal(await b.evaluate(() => smash.net.rounds.winnerId), outcome.bro);
  record(
    "A real stock battle awards the next-stage choice to the guest winner on both peers",
    outcome,
  );
  await a.waitForFunction(
    () => (smash.engine.inspect().results?.ticks || 0) >= 430,
    null,
    { timeout: 60000 },
  );
  await act(a, ["Enter"], 6, 70);
  await scene(a, 16);
  await a.waitForFunction(() => smash.net.room.selecting, null, {
    timeout: 30000,
  });
  await b.screenshot({ path: "artifacts/mobile-rematch-lobby.png" });
  const players = await a.evaluate(() => smash.engine.inspect().players);
  assert.ok(players[0].selected && players[1].selected);
  await a.locator("#start-game").click();
  await scene(a, 21);
  await frames(a, 100);
  const next = await a.evaluate(() => smash.engine.inspect().stage.slot);
  await act(a, ["ArrowRight"], 8, 20);
  await act(a, ["KeyJ"], 6, 20);
  assert.equal(await a.evaluate(() => smash.engine.inspect().scene), 21);
  assert.equal(await a.evaluate(() => smash.engine.inspect().stage.slot), next);
  await touchAct(b, "right", 3, 20);
  assert.notEqual(
    await a.evaluate(() => smash.engine.inspect().stage.slot),
    next,
  );
  record(
    "After rematch the losing host cannot change or confirm the stage; the winner can move it with touch",
  );
  // Pause/resume forces snapshot synchronization and must preserve the winner.
  await b.locator(".touch-menu").tap();
  await b.locator("#resume-menu").tap();
  await b.waitForFunction(() => smash.net.running, null, { timeout: 90000 });
  assert.equal(await b.evaluate(() => smash.net.rounds.winnerId), outcome.bro);
  // The winner can choose the formerly locked Mushroom Kingdom (slot 4).
  for (
    let i = 0;
    i < 5 && (await b.evaluate(() => smash.engine.inspect().stage.slot)) !== 4;
    i++
  )
    await touchAct(b, "right", 3, 20);
  assert.equal(await b.evaluate(() => smash.engine.inspect().stage.slot), 4);
  await b.screenshot({ path: "artifacts/mobile-mushroom-kingdom.png" });
  await touchAct(b, "a", 6, 220);
  await scene(a, 22);
  await scene(b, 22);
  const ground = await a.evaluate(() => {
    const s = smash.engine.snapshot(),
      d = new DataView(s.buffer);
    const battle = d.getUint32(448 + (0x800a50e8 & 0x7fffff), true);
    return s[448 + (((battle + 1) & 0x7fffff) ^ 3)];
  });
  assert.equal(ground, 8, "Actual battle runs on Mushroom Kingdom");
  record(
    "Winner survives pause/resume state synchronization and starts the next match on Mushroom Kingdom with phone A",
  );
  const diagnostics = await a.evaluate(() => smash.diagnostics());
  assert.equal(diagnostics.repairs, 0);
  record(
    "No unexpected netplay repairs with desktop + phone controls",
    diagnostics,
  );
  assert.deepEqual(errors, []);
} catch (error) {
  console.error(error);
  errors.push(error.stack);
  for (let i = 0; i < pages.length; i++) {
    await pages[i]
      .screenshot({ path: `artifacts/mobile-failure-${i}.png` })
      .catch(() => {});
    console.error(
      "STATE",
      i,
      await pages[i]
        .evaluate(() => ({
          view: smash.view,
          paused: smash.paused,
          diagnostics: smash.diagnostics(),
          info: smash.engine.loaded ? smash.engine.inspect() : null,
        }))
        .catch(() => null),
    );
  }
  process.exitCode = 1;
} finally {
  await writeFile(
    "artifacts/mobile-check.json",
    JSON.stringify(
      { finished: new Date().toISOString(), url, checks, errors },
      null,
      2,
    ),
  );
  await Promise.race([
    browser.close(),
    new Promise((r) => setTimeout(r, 3000)),
  ]);
  process.exit(process.exitCode || 0);
}
