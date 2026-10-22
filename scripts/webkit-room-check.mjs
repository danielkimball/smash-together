// Desktop WebKit compatibility check; this does not emulate physical iPhone hardware.
import { webkit } from "playwright";
import assert from "node:assert/strict";
import { writeFile, mkdir } from "node:fs/promises";
const browser = await webkit.launch({ headless: true });
const checks = [],
  errors = [];
const record = (name) => {
  checks.push(name);
  console.log("PASS", name);
};
let page;
try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "getGamepads", { value: () => [] });
    Object.defineProperty(document, "hidden", { get: () => false });
  });
  page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(process.env.SMASH_URL || "http://127.0.0.1:8790");
  await page.waitForFunction(() => window.smash);
  // Windows WebKit may lack the system codec for the recorded intro.
  await page.locator("#rom-file").setInputFiles(process.env.SMASH_ROM);
  await page.waitForFunction(
    () => smash.engine.loaded && smash.engine.inspect().scene === 7,
    null,
    { timeout: 90000 },
  );
  record("WebKit loads the verified native game in a phone viewport");
  await page.locator("#native-online").tap();
  await page.waitForFunction(() => smash.view === "browse");
  await page.locator("#create-open").tap();
  await page.locator("#create-room").tap();
  await page.waitForFunction(
    () => smash.engine.inspect().scene === 9 && !smash.preparing,
  );
  await page.locator('[data-touch="a"]').tap();
  await page.waitForFunction(
    () => smash.net.running && smash.engine.inspect().scene === 16,
    null,
    { timeout: 90000 },
  );
  record("WebKit touch tap creates a native multiplayer room");
  await page.locator("#game-hud [data-voice]").tap();
  assert.equal(await page.evaluate(() => !!smash.voice.stream), false);
  const audioAvailable = await page.evaluate(
    () =>
      !!window.AudioContext &&
      !!window.AudioWorkletNode &&
      !!navigator.mediaDevices,
  );
  if (!audioAvailable) {
    await page.locator("#voice-join").tap();
    assert.match(
      await page.locator("#voice-status").textContent(),
      /Voice is unavailable/,
    );
    record(
      "Windows WebKit lacks audio APIs: room remains usable and voice explains the limitation",
    );
  } else {
    // Exercise the WebKit worklet using a generated audio track, without the user's microphone.
    await page.evaluate(() => {
      navigator.mediaDevices.getUserMedia = async () => {
        const ctx = new AudioContext();
        await ctx.resume();
        window.qaMicContext = ctx;
        const tone = ctx.createOscillator(),
          gain = ctx.createGain(),
          dest = ctx.createMediaStreamDestination();
        gain.gain.value = 0.05;
        tone.connect(gain);
        gain.connect(dest);
        tone.start();
        return dest.stream;
      };
    });
    await page.locator("#voice-join").tap();
    await page.waitForFunction(
      () => !!smash.voice.node && !smash.voice.joining,
      null,
      { timeout: 20000 },
    );
    assert.equal(await page.evaluate(() => smash.voice.ctx.state), "running");
    record("WebKit starts room voice worklet only after Join Voice");
    await page.locator("#voice-mute").tap();
    assert.equal(
      await page.evaluate(() => smash.voice.stream.getAudioTracks()[0].enabled),
      false,
    );
    await page.locator("#voice-leave").tap();
    assert.equal(await page.evaluate(() => !!smash.voice.stream), false);
    await page.evaluate(() => qaMicContext.close());
    record("WebKit microphone mute and leave release the audio track");
  }
  assert.deepEqual(errors, []);
} catch (e) {
  console.error(e);
  console.log(
    await page?.evaluate(() => ({
      loaded: smash.engine.loaded,
      view: smash.view,
      toast: document.getElementById("toast").textContent,
      logs: smash.engine.logs.slice(-5),
    })),
  );
  errors.push(e.message);
  process.exitCode = 1;
  await mkdir("artifacts", { recursive: true });
  await page
    ?.screenshot({ path: "artifacts/webkit-failure.png" })
    .catch(() => {});
} finally {
  await writeFile(
    "artifacts/webkit-check.json",
    JSON.stringify({ checks, errors }, null, 2),
  );
  await browser.close();
}
