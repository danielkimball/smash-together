// Two isolated emulators: two controllers on one device plus one remote player.
// Fake Gamepad API and fake microphone only. Never joins an existing room.
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { browserHelpers } from "./browser-helpers.mjs";
const url = process.env.SMASH_URL || "http://127.0.0.1:8790";
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH,
  args: [
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
  ],
});
const pages = [],
  errors = [],
  checks = [];
const report = { url, checks, errors, passed: false };
const { openPage, browse, create, join, boot, clickNative, scene, wait } =
  browserHelpers(browser, { url, pages, errors });
const record = (name, detail = {}) => {
  checks.push({ name, ...detail });
  console.log("PASS", name, JSON.stringify(detail));
};
const installPads = () => {
  window.qaPads = [0, 1].map((index) => ({
    index,
    id: "Xbox Controller (STANDARD GAMEPAD Vendor: 045e Product: 02ea)",
    connected: true,
    mapping: "standard",
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 18 }, () => ({ value: 0, pressed: false })),
  }));
  Object.defineProperty(navigator, "getGamepads", {
    configurable: true,
    value: () => qaPads.filter((p) => p.connected),
  });
  const event = new Event("gamepadconnected");
  Object.defineProperty(event, "gamepad", {
    value: { ...qaPads[0], timestamp: performance.now() },
  });
  dispatchEvent(event);
};
const stats = (p) =>
  p.evaluate(() => ({
    epoch: smash.net.epoch,
    frame: smash.net.frame,
    state: smash.net.state,
    repairs: smash.net.repairs,
    matches: smash.net.matches,
    fps: smash.diagnostics().fps,
    backlog: Math.max(0, smash.net.serverFrame - smash.net.frame + 1),
  }));
try {
  await mkdir("artifacts", { recursive: true });
  const a = await openPage(),
    b = await openPage();
  for (const page of [a, b])
    await page.evaluate(() => {
      window.qaMicCalls = 0;
      const original = navigator.mediaDevices.getUserMedia.bind(
        navigator.mediaDevices,
      );
      navigator.mediaDevices.getUserMedia = (...args) => {
        qaMicCalls++;
        return original(...args);
      };
      window.qaStates = [];
      smash.net.addEventListener("change", () =>
        qaStates.push(smash.net.state),
      );
    });
  await a.evaluate(installPads);
  await a.waitForFunction(() => smash.controls.selected === "0");
  await browse(a);
  await a.locator("#browse-screen [data-local-players]").click();
  await a.locator("#local-player-add").click();
  assert.equal(await a.locator(".local-player-row").count(), 2);
  assert.deepEqual(
    await a
      .locator(".local-player-row select")
      .evaluateAll((elements) => elements.map((e) => e.value)),
    ["pad:0", "pad:1"],
  );
  await a.getByLabel("Local player 2 name", { exact: true }).fill("QA Partner");
  await a.getByLabel("Local player 2 name", { exact: true }).press("Tab");
  await a.screenshot({ path: "artifacts/party-players.png" });
  await a
    .locator("#local-players-dialog")
    .getByRole("button", { name: "Done", exact: true })
    .click();
  await a.locator(".header-actions [data-controls]").click();
  await a.locator("#device").selectOption("1");
  await a.locator('[data-close="controls-dialog"]').click();
  await create(a);
  await a.evaluate(() => {
    qaPads[1].buttons[2] = { value: 1, pressed: true };
  });
  await wait(350);
  assert.equal(
    await a.evaluate(
      () => smash.net.running && smash.net.connected.length === 2,
    ),
    true,
  );
  await a.evaluate(() => {
    qaPads[1].buttons[2] = { value: 0, pressed: false };
  });
  record(
    "The second controller cannot accidentally use the first player's Back-to-lobby shortcut",
  );
  const original = await a.evaluate(() => ({
    token: smash.net.token,
    id: smash.net.id,
    ids: smash.net.localMembers.map((p) => p.id),
    partner: smash.net.localMembers.find((p) => p.localIndex === 1).id,
  }));
  assert.equal(await a.evaluate(() => smash.net.connected.length), 2);
  assert.equal(await a.evaluate(() => smash.net.participants.length), 1);
  record(
    "Two controllers and names join from one tab with one emulator and one network participant",
  );

  await clickNative(a, 86, 64);
  await a.evaluate(
    (playerId) =>
      smash.net.send({ type: "pointer", playerId, scene: 16, x: 128, y: 64 }),
    original.partner,
  );
  await wait(1000);
  assert.equal(
    await a.evaluate(() =>
      smash.engine
        .inspect()
        .players.slice(0, 2)
        .every((p) => p.selected),
    ),
    true,
  );
  const beforeJoin = await stats(a);
  await a.evaluate(() => {
    qaStates.length = 0;
  });
  await join(b, original.token);
  await clickNative(b, 172, 64);
  await wait(2200);
  const afterJoin = await stats(a);
  assert.equal(afterJoin.epoch, beforeJoin.epoch);
  assert.ok(afterJoin.frame > beforeJoin.frame + 120);
  assert.equal(
    await a.evaluate(() => qaStates.every((s) => s === "playing")),
    true,
  );
  assert.ok((await stats(b)).matches > 0);
  record(
    "A remote fighter joins character selection without stopping or resynchronizing the existing device",
    { beforeJoin, afterJoin },
  );

  await a.evaluate(() => {
    window.qaFrames = [];
    const receive = smash.net.receiveFrame.bind(smash.net);
    smash.net.receiveFrame = (m) => {
      qaFrames.push(m);
      if (qaFrames.length > 120) qaFrames.shift();
      receive(m);
    };
    qaPads[0].buttons[0] = { value: 1, pressed: true };
    qaPads[1].buttons[5] = { value: 1, pressed: true };
  });
  await a.waitForFunction(() =>
    qaFrames.some(
      (m) => m.inputs[0].buttons & 128 && m.inputs[1].buttons & 4096,
    ),
  );
  await a.evaluate(() => {
    qaPads[0].buttons[0] = { value: 0, pressed: false };
    qaPads[1].buttons[5] = { value: 0, pressed: false };
  });
  record(
    "Both physical-controller streams independently reach their assigned server ports",
  );

  const beforeMenu = await stats(b);
  await a.locator("#game-hud [data-controls]").click();
  await wait(1200);
  assert.equal(await a.evaluate(() => smash.net.running), true);
  assert.ok((await stats(b)).frame > beforeMenu.frame + 50);
  assert.equal((await stats(b)).epoch, beforeMenu.epoch);
  await a.locator('[data-close="controls-dialog"]').click();
  await wait(400);
  assert.equal((await stats(b)).epoch, beforeMenu.epoch);
  record(
    "Controller setup and closing it leave the lobby running for other devices",
  );

  for (const page of [a, b]) {
    await page.waitForFunction(() => smash.voice.isListening);
    assert.equal(await page.evaluate(() => qaMicCalls), 0);
    assert.equal(await page.evaluate(() => !!smash.voice.stream), false);
  }
  await a.locator("#game-hud [data-voice]").click();
  await a.locator("#voice-join").click();
  await a.waitForFunction(() => smash.voice.stream && !smash.voice.joining);
  await a.locator('[data-close="voice-dialog"]').click();
  await b.waitForFunction((id) => smash.voice.speaking.has(id), original.id);
  assert.equal(await b.evaluate(() => qaMicCalls), 0);
  const audibleRms = await b.evaluate(async () => {
    const analyzer = smash.voice.ctx.createAnalyser();
    analyzer.fftSize = 512;
    smash.voice.node.connect(analyzer);
    const samples = new Float32Array(512);
    let rms = 0;
    for (let i = 0; i < 40; i++) {
      analyzer.getFloatTimeDomainData(samples);
      rms = Math.max(
        rms,
        Math.sqrt(samples.reduce((sum, v) => sum + v * v, 0) / samples.length),
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    smash.voice.node.disconnect(analyzer);
    return rms;
  });
  assert.ok(audibleRms > 0.001, `No audible worklet output: ${audibleRms}`);
  report.audibleRms = audibleRms;
  await b.waitForFunction(
    () => smash.audio.lowered && smash.engine.voiceGain === 0.28,
  );
  await b.locator("#game-hud [data-voice]").click();
  await b.locator("#volume").fill("40");
  assert.equal(await b.evaluate(() => smash.engine.volume), 0.4);
  await b.screenshot({ path: "artifacts/party-audio.png" });
  record(
    "Listen-only player hears voice without microphone permission; game audio automatically lowers and both sliders share one panel",
  );

  await b.locator(`[data-voice-mute="${original.id}"]`).click();
  await wait(900);
  assert.equal(await b.evaluate(() => smash.engine.voiceGain), 1);
  assert.equal(
    await a.evaluate(() => smash.voice.stream.getAudioTracks()[0].enabled),
    true,
  );
  await b.locator(`[data-voice-mute="${original.id}"]`).click();
  await b.waitForFunction(() => smash.engine.voiceGain === 0.28);
  await b.locator("#voice-listen").click();
  await b.waitForFunction(
    () => !smash.voice.isListening && smash.engine.voiceGain === 1,
  );
  assert.equal(await b.evaluate(() => smash.engine.volume), 0.4);
  await b.locator("#voice-listen").click();
  await b.waitForFunction(() => smash.voice.isListening);
  record(
    "Individual mute and mute-all affect only this listener and restore their chosen game volume",
  );
  await b.evaluate(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      qaMicCalls++;
      throw new DOMException("Denied", "NotAllowedError");
    };
  });
  await b.locator("#voice-join").click();
  await b.waitForFunction(() => smash.voice.error.includes("denied"));
  assert.equal(
    await b.evaluate(() => smash.voice.isListening && !smash.voice.stream),
    true,
  );
  record("Denied microphone permission still leaves voice playback working");
  await b.setViewportSize({ width: 390, height: 844 });
  await b.screenshot({ path: "artifacts/party-audio-phone.png" });
  assert.equal(
    await b
      .locator("#voice-dialog")
      .evaluate((el) => el.scrollWidth <= el.clientWidth + 2),
    true,
  );
  await b.setViewportSize({ width: 1280, height: 900 });
  await b.locator('[data-close="voice-dialog"]').click();
  await a.evaluate(() => smash.voice.stopMicrophone());

  const beforeRefresh = await stats(b);
  await a.reload();
  await b.waitForFunction(
    () => smash.net.isHost && smash.net.connected.length === 1,
  );
  assert.equal((await stats(b)).epoch, beforeRefresh.epoch);
  await boot(a);
  await a.evaluate(installPads);
  await browse(a);
  await a.evaluate(
    (token) =>
      smash.net.connect({
        token,
        name: "QA Returned",
        controller: "Controller",
        locals: smash.localPlayers.roster(),
      }),
    original.token,
  );
  await a.waitForFunction(() => smash.net.running, null, { timeout: 90000 });
  await b.waitForFunction(() => smash.net.connected.length === 3);
  assert.deepEqual(
    await a.evaluate(() => smash.net.localMembers.map((p) => p.id)),
    original.ids,
  );
  assert.equal(await a.evaluate(() => smash.net.isHost), false);
  assert.equal((await stats(b)).epoch, beforeRefresh.epoch);
  await wait(1800);
  assert.equal(
    await b.evaluate(() => smash.engine.inspect().players[2].selected),
    true,
  );
  assert.equal(
    await a.evaluate(() =>
      smash.engine
        .inspect()
        .players.slice(0, 2)
        .some((p) => p.selected),
    ),
    false,
  );
  record(
    "Refreshing a two-person device removes both live counts, passes hosting, clears only their tokens, and reconnects both identities without pausing the remaining player",
  );

  await clickNative(a, 86, 64);
  await a.evaluate(
    (playerId) =>
      smash.net.send({ type: "pointer", playerId, scene: 16, x: 128, y: 64 }),
    original.partner,
  );
  await wait(1000);
  await b.locator("#start-game").click();
  await scene(b, 21);
  await wait(500);
  await clickNative(b, 105, 45);
  await scene(a, 22);
  await scene(b, 22);
  await wait(7000);
  const battle = await Promise.all([stats(a), stats(b)]);
  assert.ok(
    battle.every(
      (s) => s.state === "playing" && s.matches > 0 && s.repairs === 0,
    ),
  );
  record("Three-player battle across two devices stays synchronized", {
    battle,
  });

  await a.locator("#game-hud [data-controls]").click();
  await b.waitForFunction(() => smash.net.state === "paused");
  await a.locator('[data-close="controls-dialog"]').click();
  await b.waitForFunction(() => smash.net.running, null, { timeout: 90000 });
  await a.waitForFunction(() => smash.net.running, null, { timeout: 90000 });
  record(
    "Opening controller setup during an actual match still pauses everyone and resumes together",
  );
  await a.locator("#game-menu").click();
  await a.locator("#menu-dialog [data-local-players]").click();
  await b.waitForFunction(() => smash.net.state === "paused");
  await a
    .locator("#local-players-list button")
    .filter({ hasText: "Map buttons" })
    .first()
    .click();
  await wait(600);
  assert.equal(await b.evaluate(() => smash.net.state), "paused");
  await a.locator('[data-close="controls-dialog"]').click();
  await a.locator('[data-close="menu-dialog"]').click();
  await b.waitForFunction(() => smash.net.running, null, { timeout: 90000 });
  await a.waitForFunction(() => smash.net.running, null, { timeout: 90000 });
  record(
    "Switching from local players to button mapping keeps a match paused until mapping closes",
  );
  assert.deepEqual(errors, []);
  report.passed = true;
} catch (error) {
  report.failure = error.stack;
  console.error(error);
  report.states = await Promise.all(
    pages.map((p) =>
      p
        .evaluate(() => ({
          ...smash.diagnostics(),
          room: smash.net.room,
          info: smash.engine.info,
        }))
        .catch(() => null),
    ),
  );
  for (const [i, page] of pages.entries())
    await page
      .screenshot({ path: `artifacts/party-failure-${i}.png` })
      .catch(() => {});
  process.exitCode = 1;
} finally {
  await writeFile(
    "artifacts/party-check.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  await browser.close();
}
