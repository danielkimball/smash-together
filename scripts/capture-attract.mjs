// Render the original cartridge's noninteractive attract sequence. The ROM
// and all temporary emulator state stay local; only audiovisual recordings
// are written to public/media. Requires the user's own US cartridge.
import { chromium } from "playwright";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { root } from "./share.mjs";

const romPath = process.env.SMASH_ROM;
if (!romPath) throw Error("Set SMASH_ROM to your original US cartridge.");
const out = path.join(root, "artifacts/attract-capture");
await mkdir(out, { recursive: true });
await mkdir(path.join(root, "public/media"), { recursive: true });
const browser = await chromium.launch({
  headless: true,
  executablePath:
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  args: [
    "--autoplay-policy=no-user-gesture-required",
    "--disable-background-timer-throttling",
  ],
});
const context = await browser.newContext({
  viewport: { width: 640, height: 480 },
});
await context.addInitScript(() =>
  Object.defineProperty(navigator, "getGamepads", { value: () => [] }),
);
const page = await context.newPage();
await page.route("**/__capture", (route) =>
  route.fulfill({
    contentType: "text/html",
    body: '<html><body style="margin:0;background:black"><canvas id="canvas" width="640" height="480"></canvas></body></html>',
  }),
);
const outputs = new Map();
const scenes = [];
async function writer(name) {
  if (outputs.has(name)) return outputs.get(name);
  const process = spawn(
    "/usr/local/bin/ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "image2pipe",
      "-framerate",
      "60",
      "-vcodec",
      "mjpeg",
      "-i",
      "pipe:0",
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "fast",
      "-crf",
      "21",
      "-pix_fmt",
      "yuv420p",
      path.join(out, name + ".mp4"),
    ],
    { stdio: ["pipe", "ignore", "inherit"] },
  );
  const value = { process, done: once(process, "exit"), audio: [], frames: 0 };
  outputs.set(name, value);
  return value;
}
try {
  await page.goto(
    (process.env.SMASH_URL || "http://localhost:8787") + "/__capture",
  );
  await page.evaluate(
    async (base64) => {
      const { Engine } = await import("/js/engine.js");
      window.captureEngine = new Engine(document.getElementById("canvas"));
      await captureEngine.load(
        Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)),
      );
      window.captureAudioRead =
        captureEngine.module._neilGetAudioWritePosition();
      window.capturePhase = "opening";
      window.captureSeenTutorial = false;
      window.captureDone = false;
      window.captureScene = -1;
    },
    (await readFile(romPath)).toString("base64"),
  );
  for (let batch = 0; batch < 800; batch++) {
    const frames = await page.evaluate(() => {
      const out = [],
        e = captureEngine,
        m = e.module;
      function base64(bytes) {
        let str = "";
        for (let i = 0; i < bytes.length; i += 8192)
          str += String.fromCharCode(...bytes.subarray(i, i + 8192));
        return btoa(str);
      }
      for (let n = 0; n < 30 && !captureDone; n++) {
        e.frame([{ buttons: 0, x: 0, y: 0 }]);
        const scene = e.inspect().scene;
        const changed = scene !== captureScene;
        captureScene = scene;
        if (scene === 1 && captureSeenTutorial) {
          captureDone = true;
          break;
        }
        if (scene === 1) capturePhase = "title";
        else if (capturePhase === "title") {
          capturePhase = "how-to-play";
          captureSeenTutorial = true;
        }
        const write = m._neilGetAudioWritePosition();
        const ring = new Int16Array(
          m.HEAP16.buffer,
          m._neilGetSoundBufferResampledAddress(),
          64000,
        );
        const samples = new Int16Array(
          (write - captureAudioRead + 64000) % 64000,
        );
        for (let i = 0; i < samples.length; i++)
          samples[i] = ring[(captureAudioRead + i) % 64000];
        captureAudioRead = write;
        m._neil_set_buffer_remaining(0);
        out.push({
          phase: capturePhase,
          scene,
          changed,
          frame: e.frames,
          image: e.canvas.toDataURL("image/jpeg", 0.93).split(",")[1],
          audio: base64(new Uint8Array(samples.buffer)),
        });
      }
      return { frames: out, done: captureDone };
    });
    for (const f of frames.frames) {
      if (f.changed) {
        scenes.push({ frame: f.frame, scene: f.scene, phase: f.phase });
        console.log("Scene", f.frame, f.scene, f.phase);
      }
      const w = await writer(f.phase);
      if (!w.process.stdin.write(Buffer.from(f.image, "base64")))
        await once(w.process.stdin, "drain");
      w.audio.push(Buffer.from(f.audio, "base64"));
      w.frames++;
    }
    if (batch % 60 === 0) console.log("Captured", (batch + 1) * 30, "frames");
    if (frames.done) break;
  }
  for (const [name, w] of outputs) {
    w.process.stdin.end();
    const [code] = await w.done;
    if (code) throw Error("Video encoding failed: " + name);
    await writeFile(path.join(out, name + ".pcm"), Buffer.concat(w.audio));
    const mux = spawn(
      "/usr/local/bin/ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        path.join(out, name + ".mp4"),
        "-f",
        "s16le",
        "-ar",
        "44100",
        "-ac",
        "2",
        "-i",
        path.join(out, name + ".pcm"),
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-shortest",
        "-movflags",
        "+faststart",
        path.join(root, "public/media", name + ".mp4"),
      ],
      { stdio: "inherit" },
    );
    const [result] = await once(mux, "exit");
    if (result) throw Error("Audio encoding failed: " + name);
    console.log("Wrote", name, w.frames, "frames", w.frames / 60, "seconds");
  }
  await writeFile(
    path.join(out, "scenes.json"),
    JSON.stringify(scenes, null, 2),
  );
  if (!outputs.has("how-to-play")) throw Error("The tutorial was not reached.");
} finally {
  await browser.close();
  for (const w of outputs.values())
    if (w.process.exitCode === null) w.process.kill();
}
