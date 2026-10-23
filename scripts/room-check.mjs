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
  const a = await openPage(),
    b = await openPage(true);
  await browse(a);
  await create(a);
  await clickNative(a, 86, 64);
  assert.equal(
    await a.evaluate(() => smash.engine.inspect().players[0].selected),
    true,
  );
  const token = await a.evaluate(() => smash.net.token);
  await join(b, token);
  await a.waitForFunction(() => smash.net.running);
  await b.evaluate(() => smash.controls.touch.setMode("off"));
  await clickNative(b, 128, 64);
  assert.equal(
    await b.evaluate(() => smash.engine.inspect().players[1].selected),
    true,
  );
  record("Point and click selects native fighters for both players");
  await a.locator("#start-game").click();
  await scene(a, 21);
  await wait(1000);
  await clickNative(a, 105, 45);
  console.log(
    "STAGE",
    await a.evaluate(() => ({
      info: smash.engine.inspect(),
      frame: smash.net.frame,
      epoch: smash.net.epoch,
    })),
  );
  await scene(a, 22);
  await scene(b, 22);
  record("Clickable stage selection starts a real battle");
  const c = await openPage();
  const before = await a.evaluate(() => ({
    frame: smash.net.frame,
    epoch: smash.net.epoch,
    repairs: smash.net.repairs,
  }));
  await join(c, token);
  await scene(c, 22);
  await wait(5000);
  const states = await Promise.all(
    [a, b, c].map((p) =>
      p.evaluate(() => ({
        slot: smash.net.player,
        frame: smash.net.frame,
        epoch: smash.net.epoch,
        repairs: smash.net.repairs,
        matches: smash.net.matches,
        state: smash.net.state,
        message: smash.net.message,
      })),
    ),
  );
  console.log("OBSERVERS", JSON.stringify(states));
  assert.equal(states[2].slot, -1);
  assert.equal(states[0].epoch, before.epoch);
  assert.equal(states[0].repairs, before.repairs);
  assert.ok(states[0].frame > before.frame + 120);
  assert.ok(Math.abs(states[0].frame - states[2].frame) < 120);
  assert.ok(states[2].matches > 0);
  assert.ok(
    await a.evaluate(() =>
      smash.net.performanceEvents.some(
        (e) =>
          e.type === "snapshot-sent" &&
          e.observation &&
          e.transport === "media",
      ),
    ),
  );
  record("Midmatch spectator catches up while fighters continue", { states });
  for (const p of [a, b, c]) {
    await p.locator("#game-hud [data-voice]").click();
    await p.locator("#voice-join").click();
    await p.waitForFunction(() => smash.voice.node && !smash.voice.joining);
    await p.waitForFunction(() => smash.net.mediaReady);
    await p.locator('[data-close="voice-dialog"]').click();
  }
  await wait(2000);
  assert.ok(await b.evaluate(() => smash.voice.speaking.size > 1));
  await a.evaluate(() =>
    smash.net.send({ type: "voice-moderate", spectators: true }),
  );
  await c.waitForFunction(() => smash.voice.blocked);
  assert.equal(
    await c.evaluate(() => smash.voice.stream.getAudioTracks()[0].enabled),
    false,
  );
  await a.evaluate(() =>
    smash.net.send({ type: "voice-moderate", spectators: false }),
  );
  await c.waitForFunction(() => !smash.net.room.muteSpectators);
  assert.equal(
    await c.evaluate(() => smash.voice.stream.getAudioTracks()[0].enabled),
    false,
  );
  const voiceGuest = await b.evaluate(() => smash.net.id);
  await a.evaluate(
    (id) => smash.net.send({ type: "voice-moderate", id, muted: true }),
    voiceGuest,
  );
  await b.waitForFunction(() => smash.voice.blocked);
  assert.equal(
    await b.evaluate(() => smash.voice.stream.getAudioTracks()[0].enabled),
    false,
  );
  await b.locator("#game-hud [data-voice]").click();
  await b.screenshot({ path: "artifacts/voice-phone.png" });
  await b.locator('[data-close="voice-dialog"]').click();
  record("Room microphone opt-in and host spectator mute work");
  const oldHost = await a.evaluate(() => smash.net.id);
  const next = await b.evaluate(() => smash.net.id);
  const frame = await b.evaluate(() => smash.net.frame);
  await a.evaluate(() => document.getElementById("quit-game").click());
  await b.waitForFunction((id) => smash.net.room.hostId === id, next);
  await wait(1500);
  assert.ok(
    await b.evaluate(
      (f) => smash.net.running && smash.net.frame > f + 50,
      frame,
    ),
  );
  assert.equal(await a.evaluate(() => !!smash.voice.stream), false);
  record(
    "Host leaves midbattle: player two takes over, match continues, microphone stops",
  );
  await b.evaluate(() => smash.net.socket.close());
  await c.waitForFunction(() => smash.net.isHost && smash.net.running);
  await wait(1200);
  record(
    "Disconnect promotes longest-present spectator when fighters are gone",
  );
  await c.evaluate(() => smash.net.send({ type: "lobby" }));
  await scene(c, 16);
  await c.waitForFunction(() => smash.net.running);
  await c.evaluate(() =>
    smash.net.send({ type: "availability", ready: false }),
  );
  await c.waitForFunction(() => smash.net.player === -1 && smash.net.running);
  assert.equal(await c.evaluate(() => smash.net.isHost), true);
  record("Host can sit out and retain room control");
  await a.waitForFunction(() => smash.view === "browse");
  await create(a);
  record("Create another room after leaving a battle without reloading");
  await a.evaluate(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      throw new DOMException("Denied", "NotAllowedError");
    };
  });
  await a.locator("#game-hud [data-voice]").click();
  await a.locator("#voice-join").click();
  await a.waitForFunction(() => smash.voice.error?.includes("denied"));
  assert.equal(await a.evaluate(() => !!smash.voice.stream), false);
  assert.equal(await a.evaluate(() => smash.net.running), true);
  record(
    "Denied microphone permission leaves the room playable and shows a helpful message",
  );
  assert.deepEqual(errors, []);
  await writeFile(
    "artifacts/room-features.json",
    JSON.stringify({ checks, errors }, null, 2),
  );
} catch (e) {
  console.error(e);
  for (let i = 0; i < pages.length; i++) {
    console.log(
      "STATE",
      i,
      await pages[i]
        .evaluate(() => ({
          view: smash.view,
          state: smash.net.state,
          message: smash.net.message,
          room: smash.net.room,
          info: smash.engine.info,
        }))
        .catch(() => null),
    );
    await pages[i]
      .screenshot({ path: `artifacts/room-failure-${i}.png` })
      .catch(() => {});
  }
  await writeFile(
    "artifacts/room-features.json",
    JSON.stringify({ checks, errors, error: e.stack }, null, 2),
  );
  process.exitCode = 1;
} finally {
  await browser.close();
}
