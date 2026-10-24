// Isolated native opening, idle lobby and revised room UI regression.
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { browserHelpers } from "./browser-helpers.mjs";
const url = process.env.SMASH_URL || "http://127.0.0.1:8790";
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH,
  args: [
    "--autoplay-policy=no-user-gesture-required",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
  ],
});
const pages = [],
  errors = [],
  checks = [],
  report = { checks, errors };
const { boot, openPage, browse, create, join, wait, scene } = browserHelpers(
  browser,
  { url, pages, errors },
);
const pass = (name) => {
  checks.push(name);
  console.log("PASS", name);
};
try {
  await mkdir("artifacts", { recursive: true });
  const c = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  await c.addInitScript(() =>
    Object.defineProperty(navigator, "getGamepads", { value: () => [] }),
  );
  const a = await c.newPage();
  pages.push(a);
  a.on("pageerror", (e) => errors.push(e.message));
  const requests = [];
  a.on("request", (r) => requests.push(r.url()));
  await a.goto(url);
  await a.waitForFunction(
    () =>
      window.smash?.engine.loaded &&
      !document.getElementById("native-opening").hidden,
    null,
    { timeout: 90000 },
  );
  const before = await a.evaluate(() => ({
    frames: smash.engine.frames,
    time: performance.now(),
  }));
  await wait(4000);
  const after = await a.evaluate(() => ({
    frames: smash.engine.frames,
    time: performance.now(),
    scene: smash.engine.inspect().scene,
  }));
  report.opening = {
    before,
    after,
    fps: ((after.frames - before.frames) * 1000) / (after.time - before.time),
  };
  assert.ok(
    report.opening.fps < 66 && report.opening.fps > 45,
    JSON.stringify(report.opening),
  );
  assert.equal(
    requests.some((u) => /opening\.mp4|fire\.mp4|attract\.js/.test(u)),
    false,
  );
  assert.equal(await a.locator("#rom-dialog").isVisible(), false);
  await a.screenshot({ path: "artifacts/native-opening-v38.png" });
  pass(
    "Automatic testing cartridge plays the original opening once at normal speed, with no intro videos or ROM prompt",
  );
  await boot(a);
  await browse(a);
  await a.screenshot({ path: "artifacts/lobby-v38.png" });
  await create(a);
  await scene(a, 16);
  const b = await openPage(true);
  await join(b, await a.evaluate(() => smash.net.token));
  await a.locator("#game-hud [data-room-panel]").click();
  await a.screenshot({ path: "artifacts/server-v38.png" });
  assert.equal(
    await a
      .locator("#battle-mode,#teams-apply,#lineup-apply,#pointer-player")
      .count(),
    0,
  );
  const epoch = await a.evaluate(() => smash.net.epoch);
  const idleSeconds = Number(process.env.SMASH_IDLE_SECONDS || 315);
  for (let i = 0; i < idleSeconds; i += 15) {
    await wait(Math.min(15, idleSeconds - i) * 1000);
    const states = await Promise.all(
      pages.map((p) =>
        p.evaluate(() => ({
          scene: smash.engine.inspect().scene,
          epoch: smash.net.epoch,
          repairs: smash.net.repairs,
          frame: smash.net.frame,
        })),
      ),
    );
    assert.ok(
      states.every(
        (s) => s.scene === 16 && s.epoch === epoch && s.repairs === 0,
      ),
      JSON.stringify(states),
    );
    console.log("IDLE", i + 15, JSON.stringify(states));
  }
  report.idleSeconds = idleSeconds;
  assert.equal(await a.locator("#players-dialog").isVisible(), true);
  pass(
    idleSeconds >= 300
      ? "Character select stays synchronized with Server settings open beyond the original five-minute timeout"
      : "Character select remains synchronized during room UI checks",
  );
  const guest = await b.evaluate(() => smash.net.id);
  await a.locator(`[data-member="${guest}"] .member-availability`).click();
  await b.waitForFunction(() => smash.net.me.ready === false);
  await a.locator(`[data-member="${guest}"] .member-availability`).click();
  await b.waitForFunction(() => smash.net.me.ready === true);
  await a.locator('[data-close="players-dialog"]').click();
  await a.locator("#copy-invite").click();
  await a.locator("#invite-dialog").waitFor({ state: "visible" });
  assert.ok((await a.locator("#invite-link").inputValue()).includes("#room="));
  await a.locator("#invite-copy").click();
  await a.waitForFunction(() =>
    document
      .getElementById("invite-copy-status")
      .textContent.includes("Copied!"),
  );
  await a.screenshot({ path: "artifacts/invite-v38.png" });
  await a.locator('[data-close="invite-dialog"]').click();
  pass(
    "Host availability changes save immediately; invitation always shows its link and inline copy confirmation",
  );
  await a.locator("#player-slots .player-edit").first().click();
  await a.locator("#player-rename-input").fill("Renamed host");
  await a.locator('#player-rename-form button[type="submit"]').click();
  await b.waitForFunction(() =>
    smash.net.room.members.some((p) => p.name === "Renamed host"),
  );
  const remoteMic = a.locator(`#player-slots [data-player-mic="${guest}"]`);
  await remoteMic.click();
  assert.equal(await remoteMic.getAttribute("aria-pressed"), "true");
  await a.evaluate(
    (id) => smash.voice.speaking.set(id, performance.now() + 1000),
    guest,
  );
  await wait(200);
  assert.match(await remoteMic.getAttribute("class"), /speaking/);
  pass(
    "Player pencils update names in every client; microphone buttons mute locally and show speech activity",
  );
  await b.screenshot({ path: "artifacts/selection-phone-v38.png" });
  assert.equal(
    await b.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
  );
  await a.locator("#game-hud [data-room-panel]").click();
  await a.locator(`[data-member="${guest}"] .member-kick`).click();
  await b.waitForFunction(() => document.getElementById("kicked-dialog").open);
  assert.match(
    await b.locator("#kicked-message").textContent(),
    /kicked from the server/,
  );
  assert.equal(await b.evaluate(() => smash.net.room), null);
  pass(
    "Host kick leaves a persistent removal message and removes the guest from the server",
  );
  assert.deepEqual(errors, []);
  report.passed = true;
} finally {
  await writeFile(
    "artifacts/native-startup-check.json",
    JSON.stringify(report, null, 2),
  );
  for (const p of pages)
    if (!p.isClosed())
      await p.evaluate(() => window.smash?.net.leave()).catch(() => {});
  await browser.close();
}
