import { Engine, ROM_SHA1, normalizeROM, sha1 } from "./engine.js";
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
const neutral = { buttons: 0, x: 0, y: 0 };
const engine = new Engine($("canvas")),
  controls = new Controls(),
  net = new Netplay(engine, controls);
let rom = null,
  bootState,
  versusState,
  view = "home",
  paused = true,
  next = 0;
let pendingAction = null,
  loading = false,
  preparing = false,
  lastDeviceList = "",
  wizardIndex = -1;
let lastRoom = "",
  lastRoomList = "",
  lastFPS = 0,
  lastFrames = 0,
  lastUI = 0,
  lastDeviceCheck = 0;
let toastTimer,
  hintTimer,
  lastPointer = performance.now(),
  menuEdges = {},
  lastMenuMove = 0;
let shareUrl = null,
  lastState = "offline",
  polling = false;
controls.blocked = true;
window.smash = {
  engine,
  controls,
  net,
  get bootState() {
    return bootState;
  },
  get paused() {
    return paused;
  },
  get view() {
    return view;
  },
  diagnostics: () => ({
    state: net.state,
    frame: net.frame,
    hash: engine.loaded ? engine.hash() : null,
    matches: net.matches,
    repairs: net.repairs,
    frames: engine.frames,
    rtt: net.rtt,
    fps: lastFPS,
    logs: engine.logs.slice(-15),
  }),
};
function toast(message) {
  clearTimeout(toastTimer);
  $("toast").textContent = message;
  $("toast").hidden = false;
  toastTimer = setTimeout(() => {
    $("toast").hidden = true;
  }, 5500);
}
const attempt =
  (fn) =>
  async (...args) => {
    try {
      await fn(...args);
    } catch (e) {
      $("busy").hidden = true;
      if ($("rom-dialog").open) {
        $("rom-error").textContent = e.message;
        $("rom-error").hidden = false;
      }
      toast(e.message);
      console.error(e);
    }
  };
function blockInput() {
  controls.blocked =
    view !== "game" ||
    !!document.querySelector("dialog[open]") ||
    (paused && net.state === "offline") ||
    !["offline", "playing"].includes(net.state);
  if (controls.blocked) controls.keys.clear();
}
function setView(name) {
  const changed = view !== name;
  view = name;
  for (const screen of ["home", "browse", "lobby"])
    $(screen + "-screen").hidden = screen !== name;
  $("shell").hidden = name === "game";
  $("game-view").hidden = name !== "game";
  blockInput();
  if (changed) {
    window.scrollTo(0, 0);
    lastPointer = performance.now();
  }
  if (name === "browse") refreshRooms();
}
function busy(title, detail) {
  $("busy-title").textContent = title;
  $("busy-detail").textContent = detail;
  $("busy").hidden = false;
}
function dialog(id) {
  const d = $(id);
  if (d.open) return;
  d.resumeOnClose =
    view === "game" && (net.running || (net.state === "offline" && !paused));
  if (d.resumeOnClose) pause();
  if (id === "controls-dialog") {
    refreshDevices();
    renderBindings();
  }
  if (id === "diagnostics-dialog") diagnostics();
  d.showModal();
  blockInput();
}
function closeDialogs() {
  document.querySelectorAll("dialog[open]").forEach((d) => {
    d.resumeOnClose = false;
    d.close();
  });
}
for (const d of document.querySelectorAll("dialog"))
  d.addEventListener("close", () => {
    if (d.id === "controls-dialog") {
      wizardIndex = -1;
      controls.cancelCapture();
    }
    if (d.id === "rom-dialog" && !rom) pendingAction = null;
    const resume = d.resumeOnClose;
    d.resumeOnClose = false;
    if (resume && view === "game") unpause();
    blockInput();
  });
document
  .querySelectorAll("[data-close]")
  .forEach((b) => (b.onclick = () => $(b.dataset.close).close()));
document
  .querySelectorAll("[data-controls]")
  .forEach((b) => (b.onclick = () => dialog("controls-dialog")));
document.querySelectorAll("[data-fullscreen]").forEach(
  (b) =>
    (b.onclick = attempt(async () => {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (document.documentElement.requestFullscreen)
        await document.documentElement.requestFullscreen();
      else
        toast(
          "Use your browser’s fullscreen command. The game already fills this window.",
        );
    })),
);
document
  .querySelectorAll("[data-home]")
  .forEach((b) => (b.onclick = () => setView("home")));
$("brand-home").onclick = () => {
  if (!net.room) setView("home");
  else toast("Leave your room to return to the main menu.");
};
$("multiplayer").onclick = () => setView("browse");
$("help-open").onclick = () => dialog("help-dialog");
$("diagnostics-open").onclick = () => dialog("diagnostics-dialog");
function romReady() {
  $("rom-status").textContent = "Original US release · Verified and ready";
  $("cartridge-badge").textContent = "Cartridge ready";
  $("cartridge-badge").classList.add("ready");
  $("choose-rom").hidden = true;
  $("rom-continue").hidden = false;
  $("forget-rom").hidden = false;
}
async function loadFile(file) {
  if (!file) return;
  if (!isSecureContext)
    throw Error(
      "Open the HTTPS invitation or localhost address to load your ROM and use controllers.",
    );
  if (engine.loaded)
    throw Error("Reload this page before changing the cartridge.");
  if (file.size !== 16777216)
    throw Error(
      "Choose the original 16 MB US Smash Bros. ROM (.z64, .v64 or .n64).",
    );
  const bytes = normalizeROM(await file.arrayBuffer());
  if ((await sha1(bytes)) !== ROM_SHA1)
    throw Error(
      "That is not the supported original US Smash 64 ROM. Choose an unmodified US copy.",
    );
  rom = bytes;
  romReady();
  $("rom-error").hidden = true;
  try {
    await storage.put("rom", { bytes, name: file.name });
  } catch {
    toast("Ready to play. This browser could not remember the cartridge.");
  }
  $("rom-dialog").close();
  const action = pendingAction;
  pendingAction = null;
  if (action) await action();
  else toast("Cartridge ready. Choose Multiplayer or Local play.");
}
function withCartridge(action) {
  if (rom || engine.loaded) return action();
  pendingAction = action;
  $("rom-error").hidden = true;
  dialog("rom-dialog");
}
async function powerOn() {
  if (engine.loaded) {
    await engine.audioStart();
    return;
  }
  if (loading) return;
  if (!rom) throw Error("Choose your ROM first.");
  loading = true;
  busy("Powering on…", "Loading your cartridge in this browser.");
  try {
    await engine.load(rom);
    engine.romHash = ROM_SHA1;
    engine.frame([neutral]);
    bootState = engine.snapshot();
    await engine.audioStart();
  } finally {
    loading = false;
    $("busy").hidden = true;
  }
}
async function prepareVersus() {
  preparing = true;
  const match = net.room?.match;
  const volume = engine.volume;
  engine.setVolume(0);
  try {
    if (versusState) {
      engine.restore(versusState);
      return;
    }
    engine.restore(bootState);
    // Deterministic menu navigation from the verified US boot state. Only the
    // host runs this; peers receive the resulting state from their own game.
    const sequence = [
      [360, neutral],
      [10, { buttons: BITS.start, x: 0, y: 0 }],
      [210, neutral],
      [10, { buttons: BITS.start, x: 0, y: 0 }],
      [180, neutral],
      [10, { buttons: 0, x: 0, y: -85 }],
      [60, neutral],
      [10, { buttons: BITS.a, x: 0, y: 0 }],
      [180, neutral],
      [10, { buttons: BITS.a, x: 0, y: 0 }],
      [180, neutral],
    ];
    let budget = performance.now();
    for (const [frames, input] of sequence)
      for (let i = 0; i < frames; i++) {
        engine.frame([input]);
        if (performance.now() - budget > 12) {
          await new Promise(requestAnimationFrame);
          if (
            !net.room ||
            net.room.match !== match ||
            net.room.phase === "lobby"
          )
            throw Error("Game preparation cancelled.");
          budget = performance.now();
        }
      }
    versusState = engine.snapshot();
  } finally {
    engine.flushAudio();
    engine.setVolume(volume);
    preparing = false;
  }
}
let preparation = Promise.resolve();
net.prepare = () => {
  const match = net.room?.match;
  preparation = preparation
    .catch(() => {})
    .then(() => {
      if (net.room?.match === match && net.room.phase !== "lobby")
        return prepareVersus();
    });
  return preparation;
};
$("rom-file").onchange = attempt((e) => loadFile(e.target.files[0]));
$("choose-rom").onclick = () => $("rom-file").click();
$("cartridge-open").onclick = () => dialog("rom-dialog");
$("rom-continue").onclick = attempt(async () => {
  $("rom-dialog").close();
  const action = pendingAction;
  pendingAction = null;
  if (action) await action();
});
$("forget-rom").onclick = attempt(async () => {
  await storage.put("rom", undefined);
  toast("Saved cartridge removed. Reload the page to choose a different file.");
  $("forget-rom").hidden = true;
});
$("local-play").onclick = attempt(() =>
  withCartridge(async () => {
    await powerOn();
    net.leave();
    engine.restore(bootState);
    paused = false;
    next = performance.now();
    setView("game");
    renderGame();
    $("canvas").focus();
  }),
);
function playerName() {
  return $("player-name").value.trim() || "Player";
}
function controllerName() {
  return controls.selected === "keyboard"
    ? "Keyboard"
    : controls.pad()?.id || "Controller disconnected";
}
function inviteToken(value = location.hash) {
  return String(value).match(/(?:room=)?([a-f0-9]{36})/)?.[1] || "";
}
async function joinRoom(options) {
  await powerOn();
  closeDialogs();
  paused = true;
  net.connect({ ...options, name: playerName(), controller: controllerName() });
}
function openCreate() {
  $("room-name").value =
    playerName() === "Player" ? "One more match" : `${playerName()}’s room`;
  dialog("create-dialog");
}
$("create-open").onclick = openCreate;
$("create-empty").onclick = openCreate;
$("create-form").onsubmit = attempt((e) => {
  e.preventDefault();
  const options = {
    roomName: $("room-name").value,
    capacity: Number($("capacity").value),
    listed: $("visibility").value === "public",
    delay: Number($("delay").value),
  };
  $("create-dialog").close();
  return withCartridge(() => joinRoom(options));
});
function openJoin() {
  $("join-name").value = playerName() === "Player" ? "" : playerName();
  dialog("join-dialog");
}
$("join-open").onclick = openJoin;
$("join-form").onsubmit = attempt((e) => {
  e.preventDefault();
  $("player-name").value = $("join-name").value.trim() || playerName();
  localStorage.setItem("smash.name", playerName());
  const token = inviteToken($("invite-input").value);
  if (!token) throw Error("Paste the invitation link your friend sent you.");
  $("join-dialog").close();
  return withCartridge(() => joinRoom({ token }));
});
$("player-name").value = localStorage.getItem("smash.name") || "";
$("player-name").onchange = () =>
  localStorage.setItem("smash.name", playerName());
async function refreshRooms() {
  if (view !== "browse" || polling) return;
  polling = true;
  try {
    const response = await fetch("/api/rooms", { cache: "no-store" });
    if (!response.ok) throw Error("Room server unavailable");
    const { rooms } = await response.json();
    const signature = JSON.stringify(rooms);
    if (signature !== lastRoomList) {
      lastRoomList = signature;
      $("room-list").replaceChildren(
        ...rooms.map((r) => {
          const row = document.createElement("button");
          row.className = "room-row";
          row.dataset.room = r.id;
          const desc = document.createElement("span"),
            name = document.createElement("strong"),
            host = document.createElement("small");
          name.textContent = r.name;
          host.textContent = `Hosted by ${r.host}`;
          desc.append(name, host);
          const count = document.createElement("span");
          count.className = "room-count";
          count.textContent = `${r.count} / ${r.capacity}`;
          const state = document.createElement("span");
          state.className = "room-state";
          row.disabled = r.phase !== "lobby" || r.count >= r.capacity;
          state.textContent =
            r.phase !== "lobby"
              ? "In game"
              : r.count >= r.capacity
                ? "Full"
                : "Join room  →";
          row.append(desc, count, state);
          row.onclick = attempt(() =>
            withCartridge(() => joinRoom({ roomId: r.id })),
          );
          return row;
        }),
      );
    }
    $("rooms-empty").hidden = rooms.length > 0;
    $("browser-status").textContent =
      `${rooms.length} room${rooms.length === 1 ? "" : "s"} on this server · Updated just now · No account needed`;
  } catch {
    $("rooms-empty").hidden = true;
    $("browser-status").textContent =
      "Cannot reach the room server. Keep the host computer awake, then refresh.";
  } finally {
    polling = false;
  }
}
setInterval(refreshRooms, 2500);
$("refresh-rooms").onclick = refreshRooms;
async function copyInvite() {
  let base = location.origin;
  if (["localhost", "127.0.0.1", "[::1]"].includes(location.hostname)) {
    try {
      shareUrl = (await (await fetch("/api/status")).json()).shareUrl;
    } catch {}
    if (shareUrl) base = shareUrl;
    else
      throw Error(
        "Internet sharing is not running. Open Start Sharing on the host computer, then copy a fresh invite.",
      );
  }
  const link = `${base}/#room=${net.token}`;
  try {
    await navigator.clipboard.writeText(link);
    toast("Invite copied. Send it to your friends.");
  } catch {
    $("invite-link").value = link;
    dialog("invite-dialog");
    $("invite-link").select();
  }
}
$("copy-invite").onclick = attempt(copyInvite);
function leaveRoom() {
  closeDialogs();
  net.leave();
  paused = true;
  history.replaceState(null, "", location.pathname);
  setView("browse");
  lastRoom = "";
  lastRoomList = "";
  refreshRooms();
}
$("leave-room").onclick = leaveRoom;
$("game-leave").onclick = leaveRoom;
$("ready-button").onclick = () => {
  controls.keys.clear();
  net.send({ type: "ready", ready: !net.me?.ready });
};
$("start-game").onclick = () => net.send({ type: "launch" });
function returnLobby() {
  closeDialogs();
  net.send({ type: "lobby" });
}
$("game-back-lobby").onclick = returnLobby;
$("back-lobby").onclick = returnLobby;
$("game-rejoin").onclick = attempt(() => joinRoom(net.lastOptions));
function renderLobby() {
  const r = net.room;
  if (!r) return;
  const signature = JSON.stringify(r) + net.id;
  if (signature === lastRoom) return;
  lastRoom = signature;
  $("lobby-title").textContent = r.name;
  $("lobby-eyebrow").textContent =
    `${r.listed ? "OPEN" : "INVITE-ONLY"} LOBBY · ${r.members.length} / ${r.capacity} PLAYERS`;
  $("lobby-subtitle").textContent =
    `You’re Player ${net.player + 1}. Pick a port below, then ready up.`;
  $("player-slots").replaceChildren(
    ...[0, 1, 2, 3].map((slot) => {
      const p = r.members.find((p) => p.slot === slot),
        available = slot < r.capacity;
      const card = document.createElement(p ? "div" : "button");
      card.className = `player-slot p${slot + 1}${!p ? " empty" : ""}${!available ? " unavailable" : ""}`;
      card.dataset.slot = slot;
      const port = document.createElement("span");
      port.className = "port";
      port.textContent = `PLAYER ${slot + 1}`;
      const icon = document.createElement("span");
      icon.className = "port-icon";
      icon.setAttribute("aria-hidden", "true");
      for (let n = 0; n < 3; n++) icon.append(document.createElement("i"));
      const title = document.createElement("h3");
      title.textContent = p?.name || (available ? "Open port" : "Closed port");
      const device = document.createElement("p");
      device.className = "slot-device";
      device.textContent = p
        ? p.controller
        : available
          ? "Waiting for a player"
          : `${r.capacity}-player room`;
      const status = document.createElement("span");
      status.className = `slot-status${p?.ready ? " ready" : ""}`;
      status.textContent = p
        ? !p.connected
          ? "○ Disconnected"
          : p.ready
            ? "● Ready to play"
            : "● Connected · Not ready"
        : available
          ? "Take this port →"
          : "Unavailable";
      const tags = document.createElement("span");
      tags.className = "seat-tags";
      if (p?.id === net.id) {
        const tag = document.createElement("span");
        tag.className = "seat-tag you";
        tag.textContent = "YOU";
        tags.append(tag);
      }
      if (p?.id === r.hostId) {
        const tag = document.createElement("span");
        tag.className = "seat-tag";
        tag.textContent = "HOST";
        tags.append(tag);
      }
      card.append(port, icon, title, device, status, tags);
      if (!p) {
        card.disabled = !available;
        card.onclick = () => net.send({ type: "seat", slot });
      }
      return card;
    }),
  );
  const ready = r.members.filter((p) => p.ready && p.connected).length;
  $("lobby-status").textContent =
    r.members.length < 2
      ? "Invite a friend to get started."
      : ready === r.members.length
        ? net.isHost
          ? "Everyone’s ready. Let’s choose fighters."
          : "Everyone’s ready. Waiting for the host."
        : `${ready} of ${r.members.length} players ready`;
  $("ready-button").textContent = net.me?.ready
    ? "✓ Ready · Cancel"
    : "I’m ready";
  $("ready-button").classList.toggle("primary", !net.me?.ready);
  $("start-game").hidden = !net.isHost;
  $("start-game").disabled = r.members.length < 2 || ready !== r.members.length;
  $("lobby-controller").textContent = controllerName();
}
function renderGame() {
  const online = net.state !== "offline",
    state = online ? net.state : paused ? "paused" : "playing";
  const notice = state !== "playing";
  $("game-notice").hidden = !notice || !!document.querySelector("dialog[open]");
  $("game-notice-label").textContent =
    state === "error"
      ? "CONNECTION NEEDS ATTENTION"
      : state === "paused"
        ? "TAKE A BREATHER"
        : "GETTING EVERYONE TOGETHER";
  $("game-notice-title").textContent =
    {
      preparing: "Opening character selection…",
      syncing: "Connecting your controllers…",
      paused: "Game paused.",
      waiting: "Waiting for a player…",
      error: "Let’s get you back in.",
    }[state] || "Getting ready…";
  $("game-notice-detail").textContent =
    state === "preparing"
      ? "Skipping the title menus. You’ll choose your fighters together."
      : state === "syncing"
        ? "Making sure everyone starts at the same moment."
        : state === "paused"
          ? "Open the menu for controls, or resume when everyone is ready."
          : net.message || "Keep this tab visible while you play.";
  $("game-resume").hidden = state !== "paused";
  $("game-rejoin").hidden = state !== "error" || net.isHost || !net.token;
  $("game-back-lobby").hidden = !online || !net.isHost;
  $("back-lobby").hidden = !online || !net.isHost;
  $("reset").hidden = online;
  $("local-save-actions").hidden = online;
  $("game-players").replaceChildren(
    ...(online
      ? net.room?.members || []
      : [{ slot: 0, name: "Local play", connected: true }]
    ).map((p) => {
      const badge = document.createElement("span");
      badge.className = `hud-player p${p.slot + 1}${!p.connected ? " offline" : ""}`;
      badge.textContent = `P${p.slot + 1} · ${p.name}${p.id === net.id ? " (you)" : ""}`;
      return badge;
    }),
  );
  blockInput();
}
net.addEventListener("change", () => {
  $("busy").hidden = net.state !== "connecting";
  if (net.state === "connecting")
    busy("Joining the lobby…", "Connecting your controller port.");
  else if (net.state === "lobby") {
    if (view !== "lobby") closeDialogs();
    setView("lobby");
    renderLobby();
  } else if (
    ["preparing", "syncing", "playing", "paused", "waiting"].includes(
      net.state,
    ) ||
    (net.state === "error" && net.room)
  ) {
    setView("game");
    renderGame();
  } else if (net.state === "error") {
    toast(net.message);
    setView("browse");
  }
  if (
    net.state === "playing" &&
    ["preparing", "syncing"].includes(lastState) &&
    net.frame < 2
  ) {
    if (!hintTimer) {
      $("fighter-hint").hidden = false;
      hintTimer = setTimeout(() => {
        $("fighter-hint").hidden = true;
      }, 12000);
    }
  }
  if (net.state === "lobby") {
    clearTimeout(hintTimer);
    hintTimer = null;
    $("fighter-hint").hidden = true;
  }
  lastState = net.state;
});
net.addEventListener("notice", (e) => toast(e.detail));
function pause() {
  if (net.state !== "offline") net.pause();
  else {
    paused = true;
    engine.flushAudio();
  }
  renderGame();
}
function unpause() {
  if (net.state !== "offline") net.resume();
  else {
    paused = false;
    next = performance.now();
    engine.flushAudio();
  }
  engine.audioStart().catch(() => {});
  renderGame();
}
$("game-resume").onclick = unpause;
$("game-menu").onclick = () => {
  dialog("menu-dialog");
  renderGame();
};
$("resume-menu").onclick = () => {
  $("menu-dialog").resumeOnClose = false;
  $("menu-dialog").close();
  unpause();
};
$("quit-game").onclick = () => {
  const online = net.state !== "offline";
  closeDialogs();
  paused = true;
  if (online) leaveRoom();
  else setView("home");
};
$("canvas").onclick = attempt(() => engine.audioStart());
$("volume").oninput = () => engine.setVolume(Number($("volume").value) / 100);
function refreshDevices() {
  const devices = controls.devices(),
    key = devices.map((p) => `${p.index}:${p.id}`).join("|");
  if (
    key === lastDeviceList &&
    $("device").options.length === devices.length + 1
  )
    return;
  const changed = key !== lastDeviceList;
  lastDeviceList = key;
  const preferred = localStorage.getItem("smash.inputChoice");
  if (
    controls.selected !== "keyboard" &&
    !devices.some((p) => String(p.index) === controls.selected)
  ) {
    controls.select("keyboard");
    if (view === "game") pause();
    toast("Controller disconnected. Keyboard is available.");
  } else if (
    changed &&
    controls.selected === "keyboard" &&
    preferred !== "keyboard"
  ) {
    const pad =
      devices.find((p) => p.id === preferred) ||
      (!preferred ? devices[0] : null);
    if (pad) {
      controls.select(String(pad.index));
      toast("Controller connected. Open Controller setup to test it.");
    }
  }
  $("device").replaceChildren(
    new Option("Keyboard", "keyboard"),
    ...devices.map((p) => new Option(p.id, String(p.index))),
  );
  $("device").value = controls.selected;
  $("lobby-controller").textContent = controllerName();
  $("footer-input").textContent =
    controls.selected === "keyboard"
      ? "Keyboard ready · Or pair a controller and press a button"
      : controllerName();
  if (net.room) net.send({ type: "profile", controller: controllerName() });
  if ($("controls-dialog").open) renderBindings();
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
  localStorage.setItem("smash.inputChoice", controls.id());
  $("lobby-controller").textContent = controllerName();
  $("footer-input").textContent = controllerName();
  if (net.room) net.send({ type: "profile", controller: controllerName() });
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
      e.stopImmediatePropagation();
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
  renderGame();
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
  renderGame();
  toast("Progress imported.");
}
$("save").onclick = attempt(saveProgress);
$("load-save").onclick = attempt(async () => {
  await loadProgress();
  $("menu-dialog").resumeOnClose = false;
  $("menu-dialog").close();
  unpause();
});
$("export-save").onclick = attempt(exportSave);
$("import-save").onclick = () => $("save-file").click();
$("save-file").onchange = attempt(async (e) => {
  await importSave(e.target.files[0]);
  $("menu-dialog").resumeOnClose = false;
  $("menu-dialog").close();
  unpause();
});
$("reset").onclick = () => {
  engine.restore(bootState);
  $("menu-dialog").resumeOnClose = false;
  $("menu-dialog").close();
  unpause();
};
function diagnostics() {
  $("diagnostics").textContent =
    `Game: ${engine.loaded ? "Verified US ROM" : "Not loaded"}\nMode: ${net.state}\nPlayers: ${net.connected.length || 1}\nDirect connections: ${net.directCount}\nRelay: available for every player\nLatency: ${net.rtt || "—"} ms\nInput buffer: ${net.delay} frames\nNetwork frame: ${net.frame}\nMatching state checks: ${net.matches}\nAutomatic resyncs: ${net.repairs}\nController: ${controllerName()}\nRendering: ${lastFPS} fps\nVersion: 2.0.0`;
}
function menuController(time) {
  const pad = controls.pad();
  if (!pad || controls.capture || $("busy").hidden === false) return;
  const input = evaluate(controls.profile, pad),
    buttons = input.buttons;
  const active = {
    down: input.y < -45 || !!(buttons & BITS.dd),
    up: input.y > 45 || !!(buttons & BITS.du),
    left: input.x < -45 || !!(buttons & BITS.dl),
    right: input.x > 45 || !!(buttons & BITS.dr),
    a: !!(buttons & BITS.a),
    b: !!(buttons & BITS.b),
  };
  const chord =
    (buttons & (BITS.l | BITS.r | BITS.start)) ===
    (BITS.l | BITS.r | BITS.start);
  if (
    view === "game" &&
    chord &&
    !menuEdges.chord &&
    !document.querySelector("dialog[open]")
  ) {
    dialog("menu-dialog");
    renderGame();
  }
  active.chord = chord;
  if (view !== "game" || document.querySelector("dialog[open]")) {
    if (!$("controls-dialog").open) {
      const scope =
        [...document.querySelectorAll("dialog[open]")].at(-1) ||
        $(view + "-screen");
      const focusable = [
        ...scope.querySelectorAll(
          "button:not(:disabled),input:not([type=hidden]),select,summary",
        ),
      ].filter((e) => e.getClientRects().length);
      const delta =
        active.down || active.right ? 1 : active.up || active.left ? -1 : 0;
      if (delta && time - lastMenuMove > 240 && focusable.length) {
        let at = focusable.indexOf(document.activeElement);
        at = at < 0 ? 0 : (at + delta + focusable.length) % focusable.length;
        focusable[at].focus();
        lastMenuMove = time;
      }
      if (
        active.a &&
        !menuEdges.a &&
        document.activeElement?.tagName === "BUTTON"
      )
        document.activeElement.click();
      if (active.b && !menuEdges.b) {
        const top = [...document.querySelectorAll("dialog[open]")].at(-1);
        if (top) top.close();
        else if (view === "browse") setView("home");
      }
    }
  }
  menuEdges = active;
}
window.addEventListener("keydown", (e) => {
  if (
    e.code !== "Escape" ||
    e.defaultPrevented ||
    controls.capture ||
    document.querySelector("dialog[open]")
  )
    return;
  if (view === "game") {
    e.preventDefault();
    dialog("menu-dialog");
    renderGame();
  } else if (view === "browse") setView("home");
});
document.addEventListener("pointermove", () => {
  lastPointer = performance.now();
  $("game-view").classList.remove("idle");
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden && view === "game") pause();
});
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => {
  e.preventDefault();
  if (e.dataTransfer.files.length) attempt(loadFile)(e.dataTransfer.files[0]);
});
function tick(time) {
  requestAnimationFrame(tick);
  try {
    if (engine.loaded && !preparing && view === "game") {
      if (net.state !== "offline") net.tick(time);
      else if (!paused && time + 1 >= next) {
        const inputs = [controls.sample()];
        for (const pad of controls
          .devices()
          .filter((p) => String(p.index) !== controls.selected)
          .slice(0, 3))
          inputs.push(controls.sampleOther(pad));
        engine.frame(inputs);
        next = Math.max(next + 1000 / engine.fps, time - 1000 / engine.fps);
      }
    }
    if ($("controls-dialog").open) liveControls();
    menuController(time);
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
      if ($("diagnostics-dialog").open) diagnostics();
      if (view === "game") {
        const isPlaying = net.running || (net.state === "offline" && !paused);
        $("game-view").classList.toggle(
          "idle",
          isPlaying &&
            time - lastPointer > 3500 &&
            !document.querySelector("dialog[open]"),
        );
        renderGame();
      }
    }
  } catch (e) {
    paused = true;
    net.running = false;
    toast(e.message);
    console.error(e);
  }
}
requestAnimationFrame(tick);
const savedCartridge = storage
  .get("rom")
  .then(async (saved) => {
    if (saved?.bytes && (await sha1(saved.bytes)) === ROM_SHA1) {
      rom = saved.bytes;
      romReady();
    }
  })
  .catch(() => {});
fetch("/api/status")
  .then((r) => r.json())
  .then((s) => {
    shareUrl = s.shareUrl;
  })
  .catch(() => {});
const token = inviteToken();
if (token) {
  setView("browse");
  $("invite-input").value = location.href;
  savedCartridge.then(() => {
    openJoin();
  });
}
