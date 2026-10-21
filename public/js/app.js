import { Engine, normalizeROM, sha1, ROM_SHA1 } from "./engine.js";
import {
  Controls,
  ACTIONS,
  BITS,
  bindingLabel,
  defaultProfile,
  evaluate,
} from "./controls.js";
import { Netplay, compress, decompress } from "./netplay.js";
import * as storage from "./storage.js";

const $ = (id) => document.getElementById(id);
const engine = new Engine($("canvas")),
  controls = new Controls(),
  net = new Netplay(engine, controls);
let rom = null,
  bootState = null,
  loading = false,
  paused = false,
  muted = false,
  next = 0,
  lastUI = 0,
  lastFrames = 0,
  lastFPS = 0,
  wizardIndex = -1,
  dialogPaused = false;
let shareUrl = null,
  cachedName = "",
  lastDeviceList = "",
  toastTimer;
const toast = (message) => {
  clearTimeout(toastTimer);
  $("toast").textContent = message;
  $("toast").hidden = false;
  toastTimer = setTimeout(() => ($("toast").hidden = true), 7000);
};
const attempt =
  (fn) =>
  (...args) =>
    Promise.resolve()
      .then(() => fn(...args))
      .catch((e) => {
        console.error(e);
        toast(e.message || "Something went wrong.");
      });
const neutral = { buttons: 0, x: 0, y: 0 };
window.smash = {
  engine,
  controls,
  net,
  get paused() {
    return paused;
  },
  get bootState() {
    return bootState;
  },
  diagnostics: () => ({
    mode: net.state,
    frame: net.frame,
    hash: engine.loaded ? engine.hash() : null,
    matches: net.matches,
    repairs: net.repairs,
    frames: engine.frames,
    rtt: net.rtt,
    logs: engine.logs.slice(-15),
  }),
};
function readyROM(name) {
  cachedName = name;
  $("rom-status").textContent = "Super Smash Bros. · US original · verified";
  $("rom-check").hidden = false;
  $("choose-rom").hidden = true;
  $("rom-loaded").hidden = false;
  $("empty-screen").querySelector("p").textContent =
    "Your cartridge is ready. Power on to play.";
  $("choose-main").textContent = "Power on →";
}
async function loadFile(file) {
  if (engine.loaded)
    throw Error("Restart this page to choose a different ROM.");
  if (!file) return;
  if (!window.isSecureContext)
    throw Error(
      "Open the HTTPS invitation or localhost address so controllers and ROM verification can work.",
    );
  const bytes = normalizeROM(await file.arrayBuffer());
  if ((await sha1(bytes)) !== ROM_SHA1)
    throw Error(
      "This file is not the supported original US Smash 64 ROM. Choose an unmodified US copy.",
    );
  rom = bytes;
  readyROM(file.name);
  try {
    await storage.put("rom", { bytes, name: file.name });
    toast("Cartridge verified. Saved in this browser only.");
  } catch {
    toast(
      "Cartridge verified. This browser could not remember the file; you can still play.",
    );
  }
  await powerOn();
}
async function powerOn() {
  if (engine.loaded) {
    await engine.audioStart();
    return;
  }
  if (loading) return;
  if (!rom) {
    $("rom-file").click();
    return;
  }
  loading = true;
  $("loading").hidden = false;
  $("loading-text").textContent = "Powering on…";
  try {
    await engine.load(rom);
    engine.romHash = ROM_SHA1;
    engine.frame([neutral, neutral]);
    bootState = engine.snapshot();
    await engine.audioStart();
    $("canvas").classList.add("powered");
    $("empty-screen").hidden = true;
    $("power-on").textContent = "Cartridge running ✓";
    $("power-on").disabled = true;
    for (const id of [
      "create-room",
      "join-room",
      "pause",
      "save",
      "load-save",
      "export-save",
      "import-save",
      "reset",
    ])
      $(id).disabled = false;
    next = performance.now();
    $("canvas").focus();
    updateStatus();
    if (inviteToken()) {
      toast(
        "Invitation found. Click “Join your friend” when your controller is ready.",
      );
      $("join-room").textContent = "Join invited room →";
    }
  } catch (e) {
    $("loading-text").textContent = "The game could not start.";
    throw e;
  } finally {
    loading = false;
    $("loading").hidden = true;
  }
}
function inviteToken(value) {
  const text = value ?? location.hash;
  const match = text.match(/(?:room=)?([a-f0-9]{36})/);
  return match?.[1] || "";
}
async function createRoom() {
  await engine.audioStart();
  paused = false;
  await net.connect({
    name: $("player-name").value || "Player 1",
    delay: Number($("delay").value),
  });
}
async function joinRoom() {
  const token = inviteToken($("invite-input").value) || inviteToken();
  if (!token) throw Error("Paste the invitation link your friend sent you.");
  await engine.audioStart();
  paused = false;
  await net.connect({ token, name: $("player-name").value || "Player 2" });
}
async function copyInvite() {
  let base = location.origin;
  if (["localhost", "127.0.0.1", "[::1]"].includes(location.hostname)) {
    try {
      shareUrl = (await (await fetch("/api/status")).json()).shareUrl;
    } catch {}
    if (shareUrl) base = shareUrl;
    else {
      toast(
        "Internet sharing is not running. Start “Share Smash” on the host laptop first.",
      );
      return;
    }
  }
  const url = `${base}/#room=${net.token}`;
  try {
    await navigator.clipboard.writeText(url);
    toast("Private invitation copied. Send it to your friend.");
  } catch {
    window.prompt("Copy this invitation:", url);
  }
}
function updateStatus() {
  const online = net.state !== "offline";
  $("room-setup").hidden = online;
  $("room-active").hidden = !online;
  $("room-state").textContent =
    {
      connecting: "Connecting…",
      waiting: "Waiting for your rival",
      syncing: "Syncing your games…",
      playing: `You’re Player ${net.player + 1}`,
      paused: "Match paused",
      error: "Connection needs attention",
    }[net.state] || "Private room";
  $("room-detail").textContent =
    net.message ||
    (net.state === "playing"
      ? `Playing with ${net.peerName}. Choose VS Mode to start a match.`
      : net.state === "waiting"
        ? "Send the private invitation. Your friend loads their own ROM."
        : net.state === "syncing"
          ? "Matching both game states. This can take a few seconds."
          : "Keep both game tabs visible.");
  $("copy-invite").hidden = net.player !== 0;
  $("resync").hidden = net.state === "waiting" || net.state === "connecting";
  $("connection-label").textContent =
    net.channel?.readyState === "open" ? "Direct connection" : "Laptop relay";
  $("ping").textContent = net.rtt ? `${net.rtt} ms` : "— ms";
  $("game-state").textContent = !engine.loaded
    ? "NO CARTRIDGE LOADED"
    : online
      ? `${net.state.toUpperCase()} · PLAYER ${net.player + 1}`
      : paused
        ? "PAUSED"
        : "LOCAL PLAY · PRESS START";
  $("stage-label").textContent = online
    ? net.state === "playing"
      ? "● TWO COUCHES, ONE MATCH"
      : "● PRIVATE ROOM"
    : engine.loaded
      ? "● CARTRIDGE CONNECTED"
      : "● READY WHEN YOU ARE";
  $("pause").textContent =
    paused || net.state === "paused" ? "Resume" : "Pause";
  for (const id of ["save", "load-save", "export-save", "import-save"])
    $(id).disabled = !engine.loaded || online;
  $("reset").disabled = !engine.loaded || (online && net.player !== 0);
  $("pause").disabled =
    !engine.loaded || (online && !["playing", "paused"].includes(net.state));
  $("diagnostics").textContent =
    `Game: ${engine.loaded ? "Loaded · verified US ROM" : "Waiting for ROM"}\nMode: ${net.state}\nTransport: ${net.channel?.readyState === "open" ? "WebRTC direct" : "WebSocket laptop relay"}\nRound-trip latency: ${net.rtt || "—"} ms\nInput buffer: ${net.delay} frames\nNetwork frame: ${net.frame}\nEmulated frames: ${engine.frames}\nMatching state checks: ${net.matches}\nAutomatic resyncs: ${net.repairs}\nWaited refreshes: ${net.stalls}\nController: ${controls.selected === "keyboard" ? "Keyboard" : controls.pad()?.id || "Disconnected"}\nRendering: ${lastFPS} fps\nVersion: 1.0.0`;
}
net.addEventListener("change", () => {
  updateStatus();
  if (net.state === "error") toast(net.message);
});
function pauseToggle() {
  if (net.state !== "offline") {
    if (net.state === "paused") net.resume();
    else net.pause();
  } else {
    paused = !paused;
    next = performance.now();
    engine.flushAudio();
    updateStatus();
  }
}
function showDialog(id) {
  if (id === "controls-dialog") {
    controls.blocked = true;
    controls.keys.clear();
    refreshDevices();
    renderBindings();
    dialogPaused =
      engine.loaded && (net.running || (!paused && net.state === "offline"));
    if (dialogPaused) pauseToggle();
  }
  $(id).showModal();
}
function closeDialog(id) {
  $(id).close();
}
$("controls-dialog").addEventListener("close", () => {
  controls.blocked = false;
  controls.cancelCapture();
  wizardIndex = -1;
  if (dialogPaused) {
    dialogPaused = false;
    pauseToggle();
  }
});
function refreshDevices() {
  const devices = controls.devices();
  const key = devices.map((d) => `${d.index}:${d.id}`).join("|");
  if (
    key === lastDeviceList &&
    $("device").options.length === devices.length + 1
  )
    return;
  lastDeviceList = key;
  const previous = controls.selected;
  $("device").replaceChildren(
    new Option("Keyboard", "keyboard"),
    ...devices.map((p) => new Option(p.id, String(p.index))),
  );
  if (
    previous !== "keyboard" &&
    !devices.find((p) => String(p.index) === previous)
  ) {
    controls.select("keyboard");
    toast("Controller disconnected. Keyboard is available.");
  }
  $("device").value = controls.selected;
  $("controller-count").textContent = devices.length
    ? `${devices.length} CONNECTED`
    : "KEYBOARD";
  $("device-summary").textContent = devices.length
    ? `${devices.length} controller${devices.length > 1 ? "s" : ""} detected. Open setup to select and test your device.`
    : "Keyboard is ready. Pair a controller to your computer, then press any button.";
}
function renderBindings() {
  $("bindings").replaceChildren(
    ...ACTIONS.map(([action, label]) => {
      const row = document.createElement("div");
      row.className = "binding";
      const text = document.createElement("span");
      text.textContent = label;
      const button = document.createElement("button");
      button.textContent = bindingLabel(controls.profile.map[action]);
      button.dataset.action = action;
      button.setAttribute("aria-label", `Map ${label}`);
      button.onclick = () => {
        wizardIndex = -1;
        beginMapping(action, label);
      };
      row.append(text, button);
      return row;
    }),
  );
  $("deadzone").value = Math.round(controls.profile.deadzone * 100);
  $("deadzone-value").value = $("deadzone").value + "%";
  $("range").value = Math.round(controls.profile.range * 100);
  $("range-value").value = $("range").value + "%";
  $("invert-y").checked = controls.profile.invertY;
}
function beginMapping(action, label) {
  controls.beginCapture(action);
  $("mapping-prompt").hidden = false;
  $("mapping-prompt").textContent =
    `${wizardIndex >= 0 ? `${wizardIndex + 1}/${ACTIONS.length} · ` : ""}${label}: release all controls, then press a button, move the stick, or press a key. Escape cancels.`;
  document
    .querySelectorAll("[data-action]")
    .forEach((b) => b.classList.toggle("active", b.dataset.action === action));
}
controls.addEventListener("mapped", () => {
  renderBindings();
  if (wizardIndex >= 0 && ++wizardIndex < ACTIONS.length) {
    beginMapping(...ACTIONS[wizardIndex]);
  } else {
    wizardIndex = -1;
    $("mapping-prompt").hidden = true;
  }
});
controls.addEventListener("devices", refreshDevices);
$("device").onchange = () => {
  controls.select($("device").value);
  wizardIndex = -1;
  controls.cancelCapture();
  renderBindings();
};
$("wizard").onclick = () => {
  wizardIndex = 0;
  beginMapping(...ACTIONS[0]);
};
$("preset").onclick = () => {
  controls.profile = defaultProfile(
    controls.selected === "keyboard" ? "keyboard" : "xbox",
  );
  controls.persist();
  renderBindings();
  toast("Default mapping restored.");
};
$("calibrate").onclick = attempt(async () => {
  toast("Let go of both sticks…");
  await controls.calibrate();
  toast("Stick center calibrated.");
});
for (const id of ["deadzone", "range"])
  $(id).oninput = () => {
    controls.profile[id] = Number($(id).value) / 100;
    $(id + "-value").value = $(id).value + "%";
    controls.persist();
  };
$("invert-y").onchange = () => {
  controls.profile.invertY = $("invert-y").checked;
  controls.persist();
};
window.addEventListener(
  "keydown",
  (e) => {
    if (e.code === "Escape" && controls.capture) {
      wizardIndex = -1;
      controls.cancelCapture();
      e.preventDefault();
    }
  },
  true,
);
function liveControls() {
  controls.pollCapture();
  const pad = controls.pad(),
    value = evaluate(controls.profile, pad, controls.keys);
  $("stick-dot").style.transform =
    `translate(${(value.x / 85) * 26}px,${(-value.y / 85) * 26}px)`;
  $("control-test").textContent =
    Object.entries(BITS)
      .filter(([, bit]) => value.buttons & bit)
      .map(([name]) => ACTIONS.find((a) => a[0] === name)[1])
      .join(" · ") || "Press buttons or move the stick";
  $("raw-input").textContent = pad
    ? `Buttons: ${
        pad.buttons
          .map((b, i) => (b.value > 0.5 ? i + 1 : null))
          .filter(Boolean)
          .join(", ") || "—"
      } · Axes: ${pad.axes.map((x) => x.toFixed(2)).join(", ")}`
    : "WASD · J attack · K special · Space jump · L grab · O shield";
}
async function saveProgress() {
  await storage.put("save", {
    state: engine.snapshot(),
    build: engine.build,
    rom: ROM_SHA1,
  });
  toast("Progress saved in this browser.");
}
async function loadProgress() {
  const s = await storage.get("save");
  if (!s) throw Error("No saved progress yet.");
  if (s.rom !== ROM_SHA1 || s.build !== engine.build)
    throw Error("That save belongs to a different game build.");
  engine.restore(s.state);
  paused = false;
  next = performance.now();
  updateStatus();
  toast("Saved progress loaded.");
}
function download(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes]));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function exportSave() {
  const meta = new TextEncoder().encode(
    JSON.stringify({
      format: "smash64-v1",
      rom: ROM_SHA1,
      build: engine.build,
    }),
  );
  const data = await compress(engine.snapshot());
  const out = new Uint8Array(4 + meta.length + data.length);
  new DataView(out.buffer).setUint32(0, meta.length);
  out.set(meta, 4);
  out.set(data, 4 + meta.length);
  download(out, "smash-progress.smash64");
}
async function importSave(file) {
  if (!file) return;
  if (file.size > 18 * 1024 * 1024) throw Error("Save file is too large.");
  const buf = await file.arrayBuffer();
  if (buf.byteLength < 4) throw Error("Invalid save.");
  const size = new DataView(buf).getUint32(0);
  if (size > 2048 || size + 4 >= buf.byteLength) throw Error("Invalid save.");
  const meta = JSON.parse(new TextDecoder().decode(buf.slice(4, 4 + size)));
  if (
    meta.format !== "smash64-v1" ||
    meta.rom !== ROM_SHA1 ||
    meta.build !== engine.build
  )
    throw Error("This save is for a different game or build.");
  engine.restore(await decompress(new Uint8Array(buf, 4 + size)));
  paused = false;
  next = performance.now();
  updateStatus();
  toast("Progress imported.");
}
$("rom-file").onchange = attempt((e) => loadFile(e.target.files[0]));
$("choose-main").onclick = attempt(() =>
  rom ? powerOn() : $("rom-file").click(),
);
$("choose-rom").onclick = () => $("rom-file").click();
$("power-on").onclick = attempt(powerOn);
$("forget-rom").onclick = attempt(async () => {
  await storage.put("rom", undefined);
  toast(
    "Saved ROM removed. The current game can finish; it will not be remembered next time.",
  );
  rom = null;
});
$("create-room").onclick = attempt(createRoom);
$("join-room").onclick = attempt(joinRoom);
$("copy-invite").onclick = attempt(copyInvite);
$("leave-room").onclick = () => {
  net.leave();
  paused = true;
  history.replaceState(null, "", location.pathname);
  updateStatus();
};
$("resync").onclick = () => net.resume();
$("controls-open").onclick = () => showDialog("controls-dialog");
$("help-open").onclick = () => showDialog("help-dialog");
$("diagnostics-open").onclick = () => {
  updateStatus();
  showDialog("diagnostics-dialog");
};
document
  .querySelectorAll("[data-close]")
  .forEach((b) => (b.onclick = () => closeDialog(b.dataset.close)));
$("pause").onclick = pauseToggle;
$("save").onclick = attempt(saveProgress);
$("load-save").onclick = attempt(loadProgress);
$("export-save").onclick = attempt(exportSave);
$("import-save").onclick = () => $("save-file").click();
$("save-file").onchange = attempt((e) => importSave(e.target.files[0]));
$("reset").onclick = attempt(async () => {
  if (!confirm("Restart the game from its title sequence?")) return;
  if (net.state !== "offline") net.running = false;
  engine.restore(bootState);
  if (net.state !== "offline") await net.synchronize();
  else paused = false;
  next = performance.now();
  updateStatus();
});
$("fullscreen").onclick = attempt(async () => {
  if (document.fullscreenElement) await document.exitFullscreen();
  else await $("canvas").requestFullscreen();
});
$("audio-toggle").onclick = attempt(async () => {
  muted = !muted;
  engine.setVolume(muted ? 0 : Number($("volume").value) / 100);
  $("audio-toggle").textContent = muted ? "♩" : "♫";
  $("audio-toggle").setAttribute(
    "aria-label",
    muted ? "Unmute sound" : "Mute sound",
  );
  await engine.audioStart();
});
$("volume").oninput = () => {
  muted = false;
  engine.setVolume(Number($("volume").value) / 100);
};
$("canvas").onclick = attempt(() => engine.audioStart());
$("player-name").value = localStorage.getItem("smash.name") || "";
$("player-name").onchange = () =>
  localStorage.setItem("smash.name", $("player-name").value);
if (inviteToken()) {
  $("invite-input").value = location.href;
  $("join-room").textContent = "Join invited room →";
}
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => {
  e.preventDefault();
  if (e.dataTransfer.files.length) attempt(loadFile)(e.dataTransfer.files[0]);
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden && engine.loaded) {
    if (net.running) net.pause();
    else if (net.state === "offline") paused = true;
    updateStatus();
  }
});
let lastDeviceCheck = 0;
function tick(time) {
  requestAnimationFrame(tick);
  try {
    if (engine.loaded) {
      if (net.state !== "offline") net.tick(time);
      else if (!paused && time + 1 >= next) {
        const inputs = [controls.sample()];
        const rest = controls
          .devices()
          .filter((p) => String(p.index) !== controls.selected);
        for (const pad of rest.slice(0, 3))
          inputs.push(controls.sampleOther(pad));
        engine.frame(inputs);
        next = Math.max(next + 1000 / engine.fps, time - 1000 / engine.fps);
      }
    }
    if ($("controls-dialog").open) liveControls();
    if (time - lastDeviceCheck > 1000) {
      refreshDevices();
      lastDeviceCheck = time;
    }
    if (time - lastUI > 1000) {
      lastFPS = Math.round(
        ((engine.frames - lastFrames) * 1000) / (time - lastUI),
      );
      lastFrames = engine.frames;
      lastUI = time;
      if (engine.loaded)
        $("fps-label").textContent =
          `${lastFPS} FPS · ${net.state === "offline" ? "LOCAL" : net.channel?.readyState === "open" ? "DIRECT" : "RELAY"}`;
      if ($("diagnostics-dialog").open) updateStatus();
    }
  } catch (e) {
    paused = true;
    net.running = false;
    toast(e.message);
    console.error(e);
  }
}
requestAnimationFrame(tick);
storage
  .get("rom")
  .then(async (saved) => {
    if (saved?.bytes && (await sha1(saved.bytes)) === ROM_SHA1) {
      rom = saved.bytes;
      readyROM(saved.name);
    }
  })
  .catch(() => {});
fetch("/api/status")
  .then((r) => r.json())
  .then((s) => (shareUrl = s.shareUrl))
  .catch(() => {});
