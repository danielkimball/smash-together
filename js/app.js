import { Engine, ROM_SHA1, normalizeROM, sha1 } from "./engine.js";
import {
  Controls,
  ACTIONS,
  BITS,
  bindingLabel,
  defaultProfile,
  evaluate,
  controllerKey,
  profileKind,
} from "./controls.js";
import { Netplay, compress, decompress } from "./netplay.js";
import { TouchControls } from "./touch.js";
import { Attract } from "./attract.js";
import { RoomUI } from "./room-ui.js";
import { menuRows, isGameplay, characterScenes } from "./native-menus.js";
import * as storage from "./storage.js";
import { serviceFetch, appBase } from "./service.js";

const $ = (id) => document.getElementById(id);
const neutral = { buttons: 0, x: 0, y: 0 };
const engine = new Engine($("canvas")),
  controls = new Controls(),
  net = new Netplay(engine, controls);
let rom = null,
  bootState,
  versusState,
  menuState,
  homeBooting = false,
  startRequest = null,
  selectionButtons = 0,
  enteredStage = false,
  roomSetup = null,
  menuInput = [],
  pointerQueue = [],
  waitForMenuRelease = false,
  view = "home",
  paused = true,
  next = 0;
let pendingAction = null,
  cartridgeLoadPromise = null,
  cartridgeDownloadPromise = null,
  engineBootPromise = null,
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
  lastPointer = performance.now(),
  menuEdges = {},
  lastMenuMove = 0;
let shareUrl = null,
  publicUrl = null,
  polling = false;
let lastPerformanceSample = 0,
  longTasks = 0;
if (
  typeof PerformanceObserver !== "undefined" &&
  PerformanceObserver.supportedEntryTypes?.includes("longtask")
) {
  new PerformanceObserver((list) => {
    longTasks += list.getEntries().length;
  }).observe({ type: "longtask", buffered: false });
}
const attract = new Attract({
  start: () => attempt(() => withCartridge(showMainMenu))(),
  hasDialog: () => !!document.querySelector("dialog[open]"),
});
document.body.dataset.view = "home";
document.body.dataset.attract = "opening";
controls.blocked = true;
controls.touch = new TouchControls($("touch-controls"), controls, {
  menu: () => {
    dialog("menu-dialog");
    renderGame();
  },
  wake: () => engine.audioStart().catch(() => {}),
});
$("touch-mode").value = controls.touch.mode || "auto";
$("touch-mode").onchange = (event) =>
  controls.touch.setMode(event.target.value);
document.querySelectorAll("[data-touch-toggle]").forEach((button) => {
  button.onclick = () => {
    controls.touch.setMode(controls.touch.enabled ? "off" : "on");
    $("touch-mode").value = controls.touch.mode;
  };
});
window.smash = {
  engine,
  controls,
  net,
  attract,
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
    relayRTT: net.relayRTT || 0,
    inputBuffer: net.personalDelay ?? net.delay,
    lateInputs: net.lateInputs || 0,
    fps: lastFPS,
    performance: net.performanceSamples.at(-1) || null,
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
const roomUI = new RoomUI(net, (id) => dialog(id, { pauseGame: false }), toast);
window.smash.voice = roomUI.voice;
function blockInput() {
  controls.blocked =
    !["game", "native"].includes(view) ||
    !!document.querySelector("dialog[open]") ||
    (paused && net.state === "offline") ||
    !["offline", "playing"].includes(net.state) ||
    (net.room && net.player < 0);
  if (controls.blocked) {
    controls.keys.clear();
    controls.touch.reset();
  }
}
function setView(name) {
  const changed = view !== name;
  view = name;
  for (const screen of ["home", "browse"])
    $(screen + "-screen").hidden = screen !== name;
  $("shell").hidden = ["game", "native"].includes(name);
  $("game-view").hidden = !["game", "native"].includes(name);
  $("native-menu").hidden = name !== "native";
  $("game-hud").hidden = name === "native";
  $("game-notice").hidden = name === "native";
  $("room-setup").hidden = !roomSetup || name !== "game";
  document.body.dataset.view = name;
  attract.setActive(name === "home");
  blockInput();
  if (changed) {
    window.scrollTo(0, 0);
    lastPointer = performance.now();
  }
  if (name === "browse") {
    paused = true;
    if (changed && engine.loaded && net.state === "offline" && !preparing) {
      if (![7, 9].includes(engine.inspect().scene) && menuState)
        engine.restore(menuState);
      engine.audioStart().catch(() => {});
      next = performance.now();
    }
    refreshRooms();
  }
}
function busy(title, detail) {
  $("busy-title").textContent = title;
  $("busy-detail").textContent = detail;
  $("busy").hidden = false;
}
function dialog(id, { pauseGame = true } = {}) {
  const d = $(id);
  if (d.open) return;
  d.resumeOnClose =
    pauseGame &&
    ["game", "native"].includes(view) &&
    (net.running || (net.state === "offline" && !paused));
  if (d.resumeOnClose) pause();
  if (id === "controls-dialog") {
    refreshDevices();
    renderBindings();
  }
  if (id === "diagnostics-dialog") diagnostics();
  d.showModal();
  if (id === "rom-dialog") $(rom ? "rom-continue" : "choose-rom").focus();
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
    if (resume && ["game", "native"].includes(view)) unpause();
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
      else if (
        document.fullscreenEnabled &&
        document.documentElement.requestFullscreen
      ) {
        try {
          await document.documentElement.requestFullscreen();
        } catch {
          dialog("fullscreen-help");
        }
      } else dialog("fullscreen-help");
    })),
);
document
  .querySelectorAll("[data-home]")
  .forEach((b) => (b.onclick = attempt(showMainMenu)));
$("brand-home").onclick = () => {
  if (!net.room) attempt(showMainMenu)();
  else toast("Leave your room to return to the main menu.");
};
$("native-online").onclick = () => chooseNative(1);
$("native-single").onclick = () => chooseNative(0);
$("native-options").onclick = () => chooseNative(2);
$("native-data").onclick = () => chooseNative(3);
for (const [option, id] of [
  "native-single",
  "native-online",
  "native-options",
  "native-data",
].entries()) {
  $(id).onpointerenter = () => highlightNative(option);
  $(id).onfocus = () => highlightNative(option);
}
$("help-open").onclick = () => dialog("help-dialog");
document.querySelectorAll("[data-testing]").forEach(
  (button) =>
    (button.onclick = () => {
      if (rom || engine.loaded)
        return attempt(() => withCartridge(showMainMenu))();
      $("testing-error").hidden = true;
      dialog("testing-dialog");
      $("testing-password").focus();
    }),
);
$("testing-form").onsubmit = async (event) => {
  event.preventDefault();
  $("testing-enter").disabled = true;
  $("testing-enter").textContent = "Loading…";
  $("testing-error").hidden = true;
  try {
    const response = await serviceFetch("/api/testing/cartridge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: $("testing-password").value }),
      // This optional download is 16 MB; allow slower host upload links.
      signal: AbortSignal.timeout(180000),
    });
    if (!response.ok)
      throw Error(
        response.status === 404 || response.status === 405
          ? "Testing access is not enabled on this host."
          : await response.text(),
      );
    const bytes = await response.arrayBuffer();
    $("testing-password").value = "";
    $("testing-dialog").close();
    await loadFile(new File([bytes], "Testing cartridge.z64"));
  } catch (e) {
    $("testing-error").textContent = e.message;
    $("testing-error").hidden = false;
  } finally {
    $("testing-enter").disabled = false;
    $("testing-enter").textContent = "Enter game";
  }
};
$("diagnostics-open").onclick = () => dialog("diagnostics-dialog");
function romReady() {
  clearTimeout(toastTimer);
  $("toast").hidden = true;
  $("rom-status").textContent = "Original US release · Verified and ready";
  $("cartridge-badge").textContent = "Cartridge ready";
  $("cartridge-badge").classList.add("ready");
  $("choose-rom").hidden = true;
  $("rom-continue").hidden = false;
  $("forget-rom").hidden = false;
}
function loadFile(file) {
  if (!file) return Promise.resolve();
  // A file selection can overlap the host's automatic cartridge download.
  // Only one completion may consume the pending Join/Create action. A second
  // completion used to open a local menu inside an already synchronized room.
  if (!cartridgeLoadPromise)
    cartridgeLoadPromise = acceptCartridge(file).finally(() => {
      cartridgeLoadPromise = null;
    });
  return cartridgeLoadPromise;
}
async function acceptCartridge(file) {
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
  else await showMainMenu();
}
async function withCartridge(action) {
  await savedCartridge;
  if (cartridgeLoadPromise) return cartridgeLoadPromise;
  if (rom || engine.loaded) return action();
  pendingAction = action;
  if (view === "home") attract.holdTitle();
  const status = await hostStatus;
  if (status?.testingAutoLoad) {
    if (!cartridgeDownloadPromise)
      cartridgeDownloadPromise = (async () => {
        busy("Loading game…", "Getting the testing game from the host.");
        try {
          const response = await serviceFetch("/api/testing/cartridge", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
            signal: AbortSignal.timeout(180000),
          });
          if (!response.ok)
            throw Error("The testing game could not load. Try again shortly.");
          const bytes = await response.arrayBuffer();
          // A manual file selection may have completed while downloading.
          if (!engine.loaded)
            await loadFile(new File([bytes], "Testing cartridge.z64"));
          else if (cartridgeLoadPromise) await cartridgeLoadPromise;
        } finally {
          $("busy").hidden = true;
        }
      })().finally(() => {
        cartridgeDownloadPromise = null;
      });
    return cartridgeDownloadPromise;
  }
  $("rom-error").hidden = true;
  dialog("rom-dialog");
}
async function powerOn() {
  if (engineBootPromise) return engineBootPromise;
  if (engine.loaded) {
    await engine.audioStart();
    return;
  }
  if (!rom) throw Error("Choose your ROM first.");
  engineBootPromise = (async () => {
    busy("Powering on…", "Loading your cartridge in this browser.");
    try {
      await engine.load(rom);
      engine.romHash = ROM_SHA1;
      engine.frame([neutral]);
      bootState = engine.snapshot();
      await engine.audioStart();
    } finally {
      $("busy").hidden = true;
    }
  })().finally(() => {
    engineBootPromise = null;
  });
  return engineBootPromise;
}
async function runSequence(sequence, valid = () => true) {
  let budget = performance.now();
  for (const [frames, input] of sequence)
    for (let i = 0; i < frames; i++) {
      if (net.running || !valid()) throw Error("Menu preparation cancelled.");
      engine.frame([input]);
      if (performance.now() - budget > 12) {
        await new Promise(requestAnimationFrame);
        budget = performance.now();
      }
    }
}
async function prepareMain() {
  if (menuState) {
    engine.restore(menuState);
    return;
  }
  engine.restore(bootState);
  await runSequence([
    [360, neutral],
    [10, { buttons: BITS.start, x: 0, y: 0 }],
    [210, neutral],
    [10, { buttons: BITS.start, x: 0, y: 0 }],
    [180, neutral],
  ]);
  if (engine.inspect().scene !== 7)
    throw Error("Could not open the Smash menu. Reload to retry.");
  engine.unlockAll();
  menuState = engine.snapshot();
}
async function showMainMenu() {
  roomSetup = null;
  if (!rom && !engine.loaded) {
    setView("home");
    return;
  }
  if (homeBooting) return;
  homeBooting = true;
  preparing = true;
  paused = true;
  busy("SUPER SMASH BROS.", "Opening your game’s main menu…");
  const volume = engine.volume;
  engine.setVolume(0);
  try {
    await powerOn();
    setView("native");
    busy("SUPER SMASH BROS.", "Opening your game’s main menu…");
    await prepareMain();
    menuInput = [];
    engine.frame([neutral]);
    waitForMenuRelease = !!controls
      .pad()
      ?.buttons.some((button) => button.pressed);
    paused = false;
    next = performance.now();
    setView("native");
    $("canvas").focus();
  } finally {
    engine.flushAudio();
    engine.setVolume(volume);
    preparing = false;
    homeBooting = false;
    $("busy").hidden = true;
  }
}
function highlightNative(option) {
  if (!menuState || preparing || view !== "native") return;
  const info = engine.inspect();
  if (info.scene !== 7) return;
  pointerQueue = [];
  // Read the selected row after the native scene has finished initializing.
  menuInput = [...Array(18).fill(neutral), { nativeOption: option }];
}
function nextMenuInput() {
  const input = menuInput.shift();
  if (input.nativeOption === undefined) return input;
  const info = engine.inspect();
  if (info.scene !== 7) {
    menuInput = [];
    return neutral;
  }
  const current = info.menu.row,
    option = input.nativeOption,
    moves = [];
  for (let i = 0; i < Math.abs(option - current); i++) {
    moves.push(
      ...Array.from({ length: 3 }, () => ({
        buttons: 0,
        x: 0,
        y: option > current ? -85 : 85,
      })),
      ...Array(18).fill(neutral),
    );
  }
  menuInput.unshift(...moves);
  return neutral;
}
function chooseNative(option) {
  if (!menuState || preparing) return;
  highlightNative(option);
  menuInput.push(
    ...Array(3).fill({ buttons: BITS.a, x: 0, y: 0 }),
    ...Array(20).fill(neutral),
  );
  paused = false;
  $("canvas").focus();
}
async function setupRoom(options) {
  // Finish cancelled native preparation before starting a new room.
  await preparation.catch(() => {});
  await powerOn();
  net.leave();
  menuInput = [];
  selectionButtons = 0;
  startRequest = null;
  enteredStage = false;
  roomSetup = options;
  versusState = null;
  preparing = true;
  paused = true;
  setView("game");
  busy("Set the rules", "Opening Smash’s multiplayer settings…");
  try {
    await prepareMain();
    engine.unlockAll();
    await runSequence([
      [10, { buttons: 0, x: 0, y: -85 }],
      [60, neutral],
      [10, { buttons: BITS.a, x: 0, y: 0 }],
      [180, neutral],
    ]);
    if (engine.inspect().scene !== 9)
      throw Error("Could not open VS settings.");
    menuInput = [];
    paused = false;
    next = performance.now();
    $("setup-title").textContent = options.roomName || "One more match";
    $("canvas").focus();
  } finally {
    preparing = false;
    $("busy").hidden = true;
    renderGame();
  }
}
$("setup-cancel").onclick = () => {
  roomSetup = null;
  paused = true;
  menuInput = [];
  setView("browse");
};
document.querySelectorAll("[data-native-input]").forEach((button) => {
  button.onclick = () => {
    const input = { ...neutral };
    const action = button.dataset.nativeInput;
    if (action === "up") input.y = 85;
    if (action === "down") input.y = -85;
    if (action === "left") input.x = -85;
    if (action === "right") input.x = 85;
    if (action === "a" || action === "b") input.buttons = BITS[action];
    menuInput.push(...Array(3).fill(input), ...Array(12).fill(neutral));
    $("canvas").focus();
  };
});
async function prepareVersus() {
  preparing = true;
  const match = net.room?.match,
    generation = net.connectionGeneration;
  const volume = engine.volume;
  engine.setVolume(0);
  try {
    if (versusState) {
      engine.restore(versusState);
      engine.frame([neutral]);
      return;
    }
    await prepareMain();
    await runSequence(
      [
        [10, { buttons: 0, x: 0, y: -85 }],
        [60, neutral],
        [10, { buttons: BITS.a, x: 0, y: 0 }],
        [180, neutral],
        [10, { buttons: BITS.a, x: 0, y: 0 }],
        [180, neutral],
      ],
      () =>
        net.connectionGeneration === generation && net.room?.match === match,
    );
    if (engine.inspect().scene !== 16)
      throw Error(
        "Could not open character selection. Return to the room to retry.",
      );
    versusState = engine.snapshot();
  } finally {
    engine.flushAudio();
    engine.setVolume(volume);
    preparing = false;
  }
}
let preparation = Promise.resolve();
net.prepare = () => {
  const match = net.room?.match,
    generation = net.connectionGeneration;
  preparation = preparation
    .catch(() => {})
    .then(() => {
      if (net.connectionGeneration === generation && net.room?.match === match)
        return prepareVersus();
    });
  return preparation;
};
$("rom-file").onchange = attempt((e) => loadFile(e.target.files[0]));
$("choose-rom").onclick = () => $("rom-file").click();
$("cartridge-open").onclick = () => {
  if (view === "home") attract.holdTitle();
  dialog("rom-dialog");
};
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
net.removePlayers = (slots) => {
  if (engine.inspect().scene !== 16) return;
  // Recall only the departing tokens, then park those hands below the
  // portraits so an empty port cannot prevent the remaining players starting.
  for (let f = 0; f < 80; f++)
    engine.frame(
      [0, 1, 2, 3].map((slot) =>
        !slots.includes(slot)
          ? neutral
          : f < 3
            ? { buttons: BITS.b, x: 0, y: 0 }
            : f > 35
              ? { buttons: 0, x: 0, y: -85 }
              : neutral,
      ),
    );
  engine.flushAudio();
};
net.applyTeams = (room) => engine.setTeams(room);
function requestMatch() {
  const r = net.room;
  if (!r || !net.isHost || !r.selecting || !net.running || startRequest) return;
  const info = engine.inspect();
  // Native character selection ignores Start for its first second. In
  // rematches tokens are already selected, so wait for that transition too.
  if (info.scene === 16 && info.selectionTicks <= 60) return;
  if (net.players.length < 2)
    return toast(
      "Invite a friend. You can choose your fighter while you wait.",
    );
  if (
    !net.allConnected ||
    info.scene !== 16 ||
    !net.players.every(
      (p) => info.players[p.slot]?.selected && !info.players[p.slot]?.holding,
    )
  )
    return toast("Everyone needs to place their token on a fighter first.");
  if (
    info.teams &&
    new Set(info.players.filter((p) => p.selected).map((p) => p.team)).size < 2
  )
    return toast("Choose at least two different teams.");
  startRequest = {
    revision: r.revision,
    match: r.match,
    time: performance.now(),
  };
  enteredStage = false;
  net.send({
    type: "seal",
    revision: r.revision,
    match: r.match,
    teams: !!info.teams,
    playerTeams: info.players.map((p) => p.team),
  });
}
net.filterInput = (input) => {
  const r = net.room;
  if (net.player < 0) return neutral;
  if (pointerQueue.length && engine.info?.scene !== 22)
    input = nextPointerInput();
  if (r?.selecting) {
    const bPressed = input.buttons & BITS.b && !(selectionButtons & BITS.b);
    selectionButtons = input.buttons;
    const info = engine.info || engine.inspect();
    if (
      info.scene === 16 &&
      !info.players[net.player]?.selected &&
      input.buttons & BITS.b
    ) {
      if (bPressed) queueMicrotask(leaveRoom);
      return neutral;
    }
    if (input.buttons & BITS.start) requestMatch();
    return { ...input, buttons: input.buttons & ~BITS.start };
  }
  if (r && engine.info?.scene === 16)
    return { ...input, buttons: input.buttons & ~BITS.start };
  return input;
};
$("start-game").onclick = requestMatch;
function playerName() {
  return $("player-name").value.trim() || "Player";
}
function funnyName() {
  const pick = (values) =>
    values[crypto.getRandomValues(new Uint32Array(1))[0] % values.length];
  return `${pick(["Wobbly", "Spicy", "Turbo", "Sleepy", "Sneaky", "Bouncy", "Captain", "Cosmic", "Soggy", "Sir"])} ${pick(["Noodle", "Turnip", "Goose", "Potato", "Pickle", "Bonk", "Waffle", "Goblin", "Nugget", "Banana"])}`;
}
function savePlayerName() {
  if ($("player-name").value.trim())
    localStorage.setItem("smash.name", playerName());
}
function openNameKeyboard() {
  $("name-draft").value = playerName();
  dialog("name-dialog");
  $("name-keys").querySelector("button").focus();
}
function finishName() {
  $("player-name").value = $("name-draft").value.trim() || funnyName();
  savePlayerName();
  $("name-dialog").close();
  $("player-name").focus();
}
const nameKeys = [
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
  "Space",
  "Delete",
  "Clear",
  "Random",
  "Done",
  "Cancel",
];
$("name-keys").replaceChildren(
  ...nameKeys.map((value, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = value === "Random" ? "Rand" : value;
    if (value === "Random") {
      button.title = "Choose a random name";
      button.setAttribute("aria-label", "Choose a random name");
    }
    button.dataset.key = value;
    button.dataset.keyIndex = index;
    button.onclick = () => {
      const input = $("name-draft");
      if (value === "Done") return finishName();
      if (value === "Cancel") return $("name-dialog").close();
      if (value === "Delete") input.value = input.value.slice(0, -1);
      else if (value === "Clear") input.value = "";
      else if (value === "Random") input.value = funnyName();
      else if (input.value.length < 30)
        input.value += value === "Space" ? " " : value;
    };
    return button;
  }),
);
$("name-form").onsubmit = (event) => {
  event.preventDefault();
  finishName();
};
function controllerName() {
  if (controls.touch.enabled && controls.selected === "keyboard")
    return "Touch controller";
  return controls.selected === "keyboard"
    ? "Keyboard"
    : profileKind(controls.id()) === "n64-usb"
      ? "N64 USB Controller"
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
  return withCartridge(() => setupRoom(options));
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
$("player-name").value = localStorage.getItem("smash.name") || funnyName();
savePlayerName();
$("player-name").oninput = savePlayerName;
$("player-name").onchange = savePlayerName;
async function refreshRooms() {
  if (view !== "browse" || polling) return;
  polling = true;
  try {
    const response = await serviceFetch("/api/rooms", { cache: "no-store" });
    if (!response.ok) throw Error("Room server unavailable");
    const { rooms } = await response.json();
    const signature = JSON.stringify(rooms);
    if (signature !== lastRoomList) {
      lastRoomList = signature;
      const focusedRoom = document.activeElement?.dataset.room;
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
          row.disabled = r.count >= r.capacity;
          state.textContent = !r.selecting
            ? "Join & spectate"
            : r.count >= r.capacity
              ? "Full"
              : "Choose a fighter  →";
          row.append(desc, count, state);
          row.onclick = attempt(() =>
            withCartridge(() => joinRoom({ roomId: r.id })),
          );
          return row;
        }),
      );
      if (focusedRoom)
        [...$("room-list").children]
          .find((row) => row.dataset.room === focusedRoom && !row.disabled)
          ?.focus({ preventScroll: true });
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
  let base = appBase.href;
  if (["localhost", "127.0.0.1", "[::1]"].includes(location.hostname)) {
    try {
      const status = await (await serviceFetch("/api/status")).json();
      shareUrl = status.shareUrl;
      publicUrl = status.publicUrl;
    } catch {}
    if (shareUrl) base = shareUrl;
    else
      throw Error(
        "Internet sharing is not running. Open Start Sharing on the host computer, then copy a fresh invite.",
      );
  }
  const link = `${(publicUrl || base).replace(/\/$/, "")}/#room=${net.token}`;
  try {
    await navigator.clipboard.writeText(link);
    toast("Invite copied. Send it to your friends.");
  } catch {
    $("invite-link").value = link;
    dialog("invite-dialog");
    $("invite-link").select();
  }
}
document
  .querySelectorAll("[data-invite]")
  .forEach((b) => (b.onclick = attempt(copyInvite)));
function leaveRoom() {
  startRequest = null;
  selectionButtons = 0;
  enteredStage = false;
  menuInput = [];
  roomSetup = null;
  controls.keys.clear();
  controls.touch.reset();
  pointerQueue = [];
  closeDialogs();
  net.leave();
  engine.info = null;
  if (menuState && !preparing) engine.restore(menuState);
  paused = true;
  history.replaceState(null, "", location.pathname);
  setView("browse");
  lastRoom = "";
  lastRoomList = "";
  refreshRooms();
}
$("game-leave").onclick = leaveRoom;
$("selection-back").onclick = leaveRoom;
function renameRoom() {
  if (!net.isHost) return;
  $("rename-name").value = net.room.name;
  dialog("rename-dialog", { pauseGame: false });
  $("rename-name").select();
}
$("rename-open").onclick = renameRoom;
$("rename-menu").onclick = renameRoom;
$("rename-form").onsubmit = (event) => {
  event.preventDefault();
  const name = $("rename-name").value.trim();
  if (!name) {
    $("rename-name").focus();
    return;
  }
  net.send({ type: "rename", name });
  $("rename-dialog").close();
};
function returnLobby() {
  enteredStage = false;
  startRequest = null;
  closeDialogs();
  net.send({ type: "lobby" });
}
$("game-back-lobby").onclick = returnLobby;
$("back-lobby").onclick = returnLobby;
$("game-rejoin").onclick = attempt(() => joinRoom(net.lastOptions));
function renderCharacterRoom() {
  const r = net.room;
  const chooser = net.rounds.chooser(r);
  const stage = r && net.rounds.scene === 21 && view === "game";
  const winner = r?.members.find((p) => p.id === net.rounds.winnerId);
  const results =
    r &&
    net.rounds.scene === 24 &&
    net.rounds.resultsSeen &&
    engine.info?.results?.kind !== 4 &&
    winner;
  $("stage-choice").hidden = !stage && !results;
  if (stage || results) {
    const yours = chooser?.id === net.id;
    $("stage-choice").textContent = results
      ? `${chooser?.name || "Host"} won · picks next stage · Start to continue`
      : yours
        ? `${winner ? "Winner’s pick" : "Host’s pick"} · Choose a stage · A to start`
        : `${chooser?.name || "Host"} is choosing the stage…`;
  }
  const showing =
    r && r.selecting && engine.info?.scene === 16 && view === "game";
  $("character-room").hidden = !showing;
  if (!showing) return;
  $("room-title").textContent = r.name;
  $("rename-open").hidden = !net.isHost;
  const info = engine.info || { players: [] };
  $("room-waiting").textContent =
    net.player < 0
      ? "Spectating · Open Players to see the queue"
      : net.players.length < 2
        ? "Choose your fighter while you wait for friends"
        : `${net.connected.length} / ${r.capacity} players · ${net.isHost ? "Start when everyone has chosen" : "The host starts the match"}`;
  const signature = JSON.stringify([
    r,
    info.players.map((p) => [p.selected, p.fighter]),
    net.id,
  ]);
  if (signature !== lastRoom) {
    lastRoom = signature;
    $("player-slots").replaceChildren(
      ...[0, 1, 2, 3].map((slot) => {
        const p = r.members.find((p) => p.slot === slot),
          choice = info.players[slot];
        const card = document.createElement("div");
        card.className = `native-port p${slot + 1}${p ? " connected" : " empty"}`;
        card.dataset.slot = slot;
        const name = document.createElement("strong");
        name.textContent = p
          ? `${p.name}${p.id === net.id ? " · YOU" : ""}`
          : slot < r.capacity
            ? "Waiting for player"
            : "Closed port";
        const state = document.createElement("span");
        state.textContent = p
          ? !p.connected
            ? "Disconnected"
            : choice?.selected
              ? "✓ Fighter selected"
              : `P${slot + 1} · Choose a fighter`
          : `P${slot + 1} · ${slot < r.capacity ? "Open" : "—"}`;
        card.append(name, state);
        return card;
      }),
    );
  }
  $("start-game").hidden = !net.isHost;
  $("start-game").disabled =
    !net.running ||
    info.scene !== 16 ||
    info.selectionTicks <= 60 ||
    net.players.length < 2 ||
    !net.allConnected ||
    !net.players.every((p) => info.players[p.slot]?.selected) ||
    info.players.some((p) => p.holding);
}
function renderGame() {
  const online = net.state !== "offline",
    state = online ? net.state : paused ? "paused" : "playing";
  const notice = view !== "native" && state !== "playing";
  $("game-notice").hidden =
    !!roomSetup || !notice || !!document.querySelector("dialog[open]");
  $("room-setup").hidden = !roomSetup || view !== "game";
  $("game-hud").hidden = !!roomSetup || view === "native";
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
      ? "Your room is open. Pick your fighter while friends join."
      : state === "syncing"
        ? "Making sure everyone starts at the same moment."
        : state === "paused"
          ? "Open the menu for controls, or resume when everyone is ready."
          : net.message || "Keep this tab visible while you play.";
  $("game-resume").hidden = state !== "paused";
  $("game-rejoin").hidden = state !== "error" || !net.token;
  $("game-back-lobby").hidden = !online || !net.isHost;
  $("back-lobby").hidden = !online || !net.isHost;
  $("rename-menu").hidden = !online || !net.isHost;
  $("reset").hidden = online;
  $("local-save-actions").hidden = online;
  $("game-players").replaceChildren(
    ...(online
      ? net.connected
      : [{ slot: 0, name: "Local play", connected: true }]
    ).map((p) => {
      const badge = document.createElement("span");
      badge.className = `hud-player p${p.slot + 1}${!p.connected ? " offline" : ""}`;
      badge.textContent = `${p.slot < 0 ? "Watching" : "P" + (p.slot + 1)} · ${p.name}${p.id === net.id ? " (you)" : ""}`;
      return badge;
    }),
  );
  renderCharacterRoom();
  blockInput();
}
net.addEventListener("change", () => {
  if (window.parent !== window && publicUrl)
    window.parent.postMessage(
      { type: "smash-room", token: net.token || "" },
      new URL(publicUrl).origin,
    );
  $("busy").hidden = net.state !== "connecting";
  if (net.state === "connecting")
    busy("Joining the lobby…", "Connecting your controller port.");
  else if (
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
  if (startRequest && net.room) {
    if (
      net.room.match !== startRequest.match ||
      net.room.revision !== startRequest.revision
    )
      startRequest = null;
    else if (!net.room.selecting) {
      startRequest = null;
    }
  }
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
  else attempt(showMainMenu)();
};
function nextPointerInput() {
  const input = pointerQueue.shift();
  if (input?.pointer) {
    engine.menuPointer(input.pointer);
    return neutral;
  }
  return input || neutral;
}
function pointerPress(action) {
  if (isGameplay(engine.info?.scene)) return;
  const info = engine.inspect();
  if (info.scene === 24 && action === "start") {
    const wait = Math.max(0, info.results.exitTicks - info.results.ticks + 4);
    if (net.room) {
      net.send({ type: "pointer", scene: 24, x: 160, y: 215, wait });
      return;
    }
    pointerQueue.push(...Array(Math.min(wait, 450)).fill(neutral));
  }
  if (!pointerQueue.length) pointerQueue.push(...Array(12).fill(neutral));
  const input = { ...neutral };
  if (action === "up") input.y = 85;
  if (action === "down") input.y = -85;
  if (action === "left") input.x = -85;
  if (action === "right") input.x = 85;
  if (BITS[action]) input.buttons = BITS[action];
  pointerQueue.push(...Array(3).fill(input), ...Array(18).fill(neutral));
}
let pointerMenuKey = "";
function renderPointerMenu(info) {
  const panel = $("pointer-menu");
  panel.hidden =
    isGameplay(info.scene) ||
    view === "home" ||
    view === "browse" ||
    info.scene === 7 ||
    !!roomSetup ||
    !!net.room?.selecting;
  if (panel.hidden) return;
  const key = String(info.scene);
  if (key === pointerMenuKey) return;
  pointerMenuKey = key;
  panel.replaceChildren(
    ...[
      ["up", "↑"],
      ["down", "↓"],
      ["left", "←"],
      ["right", "→"],
      ["a", "A · Select"],
      ["b", "B · Back"],
      ["start", "Start"],
    ].map(([action, label]) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.onclick = () => pointerPress(action);
      return b;
    }),
  );
  if ([8, 57, 58].includes(info.scene))
    for (const [row, label] of menuRows[info.scene].labels.entries()) {
      const b = document.createElement("button");
      b.textContent = label;
      b.onclick = () => chooseMenuRow(engine.inspect(), row);
      panel.prepend(b);
    }
}
function chooseMenuRow(info, row, action) {
  if (!info.menu || pointerQueue.length) return;
  for (let i = 0; i < Math.abs(row - info.menu.row); i++)
    pointerPress(row > info.menu.row ? "down" : "up");
  const definition = menuRows[info.scene];
  pointerPress(
    action ||
      (definition?.adjust === "all" || definition?.adjust?.includes(row)
        ? "right"
        : "a"),
  );
}
$("canvas").onclick = attempt((event) => {
  const info = engine.inspect();
  if (isGameplay(info.scene) || controls.blocked) return;
  const canvas = $("canvas"),
    rect = canvas.getBoundingClientRect(),
    ratio = canvas.width / canvas.height,
    width = Math.min(rect.width, rect.height * ratio),
    height = width / ratio;
  const x =
    ((event.clientX - rect.left - (rect.width - width) / 2) * 320) / width;
  const y =
    ((event.clientY - rect.top - (rect.height - height) / 2) * 240) / height;
  if (x < 0 || x > 320 || y < 0 || y > 240) return;
  if ([...characterScenes, 21, 24].includes(info.scene)) {
    if (characterScenes.includes(info.scene) && x >= 244 && y <= 35) {
      if (net.room) leaveRoom();
      else pointerPress("b");
      return;
    }
    if (net.room && net.player < 0 && !(net.isHost && info.scene === 24))
      return;
    if (info.scene === 21 && (x < 30 || x > 280 || y < 30 || y > 106)) return;
    const command = {
      scene: info.scene,
      slot: net.room ? net.player : 0,
      x,
      y,
    };
    if (net.room)
      net.send({
        type: "pointer",
        ...command,
        wait:
          info.scene === 24
            ? Math.max(0, info.results.exitTicks - info.results.ticks + 4)
            : 0,
        recall:
          info.scene === 16 && y < 124 && info.players[net.player]?.selected,
      });
    else {
      if (info.scene === 16 && y < 124 && info.players[0]?.selected) {
        pointerPress("b");
        pointerQueue.push(...Array(30).fill(neutral));
      }
      pointerQueue.push({ pointer: command });
      pointerPress(info.scene === 24 ? "start" : "a");
    }
    return engine.audioStart();
  }
  if (menuRows[info.scene] && info.menu) {
    if (info.scene === 47 && info.menu.confirmation) {
      pointerPress(x < 160 ? "left" : "right");
      pointerPress("a");
      return;
    }
    const rows = menuRows[info.scene].y;
    const row = rows.reduce(
      (best, value, i) =>
        Math.abs(value - y) < Math.abs(rows[best] - y) ? i : best,
      0,
    );
    const adjusts =
      menuRows[info.scene].adjust === "all" ||
      menuRows[info.scene].adjust?.includes(row);
    chooseMenuRow(info, row, adjusts ? (x < 205 ? "left" : "right") : "a");
    return;
  }
  return engine.audioStart();
});
$("volume").oninput = () => engine.setVolume(Number($("volume").value) / 100);
function refreshDevices() {
  controls.touch.refresh();
  const devices = controls.devices(),
    key = devices.map((p) => `${p.index}:${p.id}`).join("|");
  if (
    key === lastDeviceList &&
    $("device").options.length === devices.length + 1
  )
    return;
  document.querySelectorAll(".controller-status").forEach((b) => {
    b.textContent = devices.length ? "Controller ✓" : "Connect pad";
    b.title = devices.length
      ? "Open controller settings"
      : "Pair a controller in iPhone Settings, then press a button";
  });
  const changed = key !== lastDeviceList;
  lastDeviceList = key;
  const preferred = localStorage.getItem("smash.inputChoice");
  if (
    controls.selected !== "keyboard" &&
    !devices.some((p) => String(p.index) === controls.selected)
  ) {
    controls.select("keyboard");
    toast(
      controls.touch.media.matches
        ? "Controller disconnected. Touch controls are available."
        : "Controller disconnected. Keyboard is available.",
    );
  } else if (
    changed &&
    controls.selected === "keyboard" &&
    (preferred !== "keyboard" || controls.touch.media.matches) &&
    !controls.manualKeyboard
  ) {
    const pad =
      devices.find((p) => controllerKey(p.id) === controllerKey(preferred)) ||
      devices[0];
    if (pad) {
      controls.select(String(pad.index));
      toast("Controller connected. Open Controller setup to test it.");
    }
  }
  $("device").replaceChildren(
    new Option("Keyboard", "keyboard"),
    ...devices.map(
      (p) =>
        new Option(
          profileKind(p.id) === "n64-usb"
            ? "N64 USB Controller · DragonRise 0079:0006"
            : p.id,
          String(p.index),
        ),
    ),
  );
  $("device").value = controls.selected;
  $("footer-input").textContent =
    controls.selected === "keyboard"
      ? "Keyboard ready · Or pair a controller and press a button"
      : controllerName();
  if (net.room) net.send({ type: "profile", controller: controllerName() });
  if ($("controls-dialog").open) renderBindings();
}
function renderBindings() {
  const kind = profileKind(controls.id());
  $("controller-saved").textContent =
    `${kind === "n64-usb" ? "N64 USB preset" : kind === "keyboard" ? "Keyboard" : "Xbox / standard preset"} · Changes saved automatically in this browser`;
  $("mac-controller-help").hidden = !(
    kind === "n64-usb" && /Mac/.test(navigator.platform)
  );
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
        wizardIndex = ACTIONS.findIndex(([name]) => name === action);
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
  document
    .querySelector(`[data-action="${action}"]`)
    ?.scrollIntoView({ block: "nearest" });
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
  controls.manualKeyboard = $("device").value === "keyboard";
  controls.select($("device").value);
  localStorage.setItem("smash.inputChoice", controllerKey(controls.id()));
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
  wizardIndex = -1;
  controls.cancelCapture();
  controls.profile = defaultProfile(profileKind(controls.id()));
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
  const sample = net.performanceSamples.at(-1);
  $("diagnostics").textContent =
    `Game: ${engine.loaded ? "Verified US ROM" : "Not loaded"}\nMode: ${net.state}\nPlayers: ${net.connected.length || 1}\nGame inputs: ${net.room?.inputMode === "latest" ? "next available server tick" : "buffered server deadlines"}\nServer round trip: ${net.relayRTT || "—"} ms (typical ${Math.round(net.inputTiming.rtt)} ms)\nYour input buffer: ${net.personalDelay ?? net.delay} frames (${Math.round(((net.personalDelay ?? net.delay) * 1000) / 60)} ms)\nInput sample → emulator: ${sample?.inputAckSamples ? `${sample.inputAckAvgMs} ms average / ${sample.inputAckP95Ms} ms p95` : "measuring"}\nFrames waiting to render: ${Math.max(0, net.serverFrame - net.frame + 1) || 0}\nEmulator frame time: ${sample?.stepAvgMs || 0} ms average / ${sample?.stepMaxMs || 0} ms peak\nLongest frame delivery gap: ${sample?.frameGapMs || 0} ms\nYour missed deadlines: ${net.ownLateInputs || 0}\nGame send queue: ${net.socket?.bufferedAmount || 0} bytes\nVoice/snapshots: ${net.mediaReady ? "separate connection" : "connecting"}\nMatching state checks: ${net.matches}\nAutomatic resyncs: ${net.repairs}\nRendering: ${lastFPS} fps\nVersion: 3.6.2`;
}
$("performance-export").onclick = () => {
  const report = {
    version: "3.6.2",
    exported: new Date().toISOString(),
    samples: net.performanceSamples,
    events: net.performanceEvents,
    room: net.roomPerformance || null,
  };
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = "smash-performance.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
function menuController(time) {
  const pad = controls.pad();
  const homeInput = view === "home" && !document.querySelector("dialog[open]");
  attract.tick(
    pad ||
      (homeInput
        ? controls
            .devices()
            .find((device) => device.buttons.some((button) => button.pressed))
        : null),
  );
  if (homeInput) {
    const buttons = pad ? evaluate(controls.profile, pad).buttons : 0;
    menuEdges = { a: !!(buttons & BITS.a), b: !!(buttons & BITS.b) };
    return;
  }
  if (controls.capture || $("busy").hidden === false) return;
  const input = evaluate(controls.profile, pad, controls.keys);
  const touchInput = controls.touch.sample();
  input.buttons |= touchInput.buttons;
  const buttons = input.buttons;
  const active = {
    down: input.y < -45 || !!(buttons & BITS.dd),
    up: input.y > 45 || !!(buttons & BITS.du),
    left: input.x < -45 || !!(buttons & BITS.dl),
    right: input.x > 45 || !!(buttons & BITS.dr),
    a: !!(buttons & BITS.a),
    b: !!(buttons & BITS.b),
    start: !!(buttons & BITS.start),
  };
  if (Object.values(active).some(Boolean))
    document.body.dataset.navigation = "controller";
  if ($("name-dialog").open) {
    const keys = [...$("name-keys").children];
    let index = keys.indexOf(document.activeElement);
    const delta = active.down
      ? 7
      : active.up
        ? -7
        : active.right
          ? 1
          : active.left
            ? -1
            : 0;
    if (delta && time - lastMenuMove > 240) {
      index = index < 0 ? 0 : (index + delta + keys.length) % keys.length;
      keys[index].focus();
      lastMenuMove = time;
    }
    if (active.a && !menuEdges.a && index >= 0) keys[index].click();
    if (active.b && !menuEdges.b)
      $("name-draft").value = $("name-draft").value.slice(0, -1);
    if (active.start && !menuEdges.start) finishName();
    menuEdges = active;
    return;
  }
  const chord =
    (buttons & (BITS.l | BITS.r | BITS.start)) ===
    (BITS.l | BITS.r | BITS.start);
  if (
    ["game", "native"].includes(view) &&
    chord &&
    !menuEdges.chord &&
    !document.querySelector("dialog[open]")
  ) {
    dialog("menu-dialog");
    renderGame();
  }
  active.chord = chord;
  if (
    view === "game" &&
    net.room?.selecting &&
    !chord &&
    !document.querySelector("dialog[open]") &&
    active.b &&
    !menuEdges.b
  ) {
    const info = engine.info || engine.inspect();
    if (info.scene === 16 && !info.players[net.player]?.selected) {
      menuEdges = active;
      leaveRoom();
      return;
    }
  }
  if (
    view === "game" &&
    net.room?.selecting &&
    !chord &&
    !document.querySelector("dialog[open]") &&
    active.start &&
    !menuEdges.start
  )
    requestMatch();
  if (
    !["game", "native"].includes(view) ||
    document.querySelector("dialog[open]")
  ) {
    if (!$("controls-dialog").open) {
      const scope =
        [...document.querySelectorAll("dialog[open]")].at(-1) ||
        $(view + "-screen");
      const focusable = [
        ...scope.querySelectorAll(
          "button:not(:disabled),input:not([type=hidden]),select,summary",
        ),
      ].filter(
        (e) =>
          e.getClientRects().length && !e.hasAttribute("data-controller-skip"),
      );
      const delta =
        active.down || active.right ? 1 : active.up || active.left ? -1 : 0;
      if (delta && time - lastMenuMove > 240 && focusable.length) {
        let at = focusable.indexOf(document.activeElement);
        at = at < 0 ? 0 : (at + delta + focusable.length) % focusable.length;
        focusable[at].focus();
        lastMenuMove = time;
      }
      if (active.a && !menuEdges.a) {
        if (document.activeElement === $("player-name")) openNameKeyboard();
        else if (document.activeElement?.tagName === "BUTTON")
          document.activeElement.click();
      }
      if (active.b && !menuEdges.b) {
        const top = [...document.querySelectorAll("dialog[open]")].at(-1);
        if (top) top.close();
        else if (view === "browse") attempt(showMainMenu)();
      }
    }
  }
  menuEdges = active;
}
window.addEventListener("keydown", (e) => {
  if (
    view === "game" &&
    net.room?.selecting &&
    !e.repeat &&
    !controls.capture &&
    controls.selected === "keyboard" &&
    !e.target.closest("input,select,textarea") &&
    !document.querySelector("dialog[open]")
  ) {
    const pressed = evaluate(controls.profile, null, new Set([e.code])).buttons;
    const info = engine.info || engine.inspect();
    if (
      pressed & BITS.b &&
      info.scene === 16 &&
      !info.players[net.player]?.selected
    ) {
      e.preventDefault();
      leaveRoom();
      return;
    }
    if (pressed & BITS.start) {
      e.preventDefault();
      requestMatch();
      return;
    }
  }
  if (
    view === "browse" &&
    e.code === "KeyK" &&
    !e.repeat &&
    !e.target.closest("input,select,textarea") &&
    !document.querySelector("dialog[open]")
  ) {
    e.preventDefault();
    attempt(showMainMenu)();
    return;
  }
  if (
    e.code !== "Escape" ||
    e.defaultPrevented ||
    controls.capture ||
    document.querySelector("dialog[open]")
  )
    return;
  if (["game", "native"].includes(view)) {
    e.preventDefault();
    dialog("menu-dialog");
    renderGame();
  } else if (view === "browse") attempt(showMainMenu)();
});
document.addEventListener("pointerdown", () => {
  document.body.dataset.navigation = "pointer";
});
document.addEventListener("pointermove", () => {
  lastPointer = performance.now();
  $("game-view").classList.remove("idle");
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden && view === "game" && net.state === "offline") pause();
});
window.addEventListener("pagehide", () => {
  // Refresh/navigation releases the transport promptly. Keep the session
  // ticket so this tab can reclaim its short-lived reconnect reservation.
  net.socket?.close(1000, "Page left");
  net.mediaSocket?.close(1000, "Page left");
});
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => {
  e.preventDefault();
  if (e.dataTransfer.files.length) attempt(loadFile)(e.dataTransfer.files[0]);
});
function tick(time) {
  requestAnimationFrame(tick);
  try {
    // Keep the original menu soundtrack continuous through the room browser.
    // A harmless R pulse every four minutes prevents its idle title transition.
    if (
      engine.loaded &&
      !preparing &&
      view === "browse" &&
      net.state === "offline" &&
      !document.hidden &&
      time + 1 >= next
    ) {
      engine.frame([
        { ...neutral, buttons: engine.frames % 14400 === 0 ? BITS.r : 0 },
      ]);
      next = Math.max(next + 1000 / engine.fps, time - 1000 / engine.fps);
    }
    if (engine.loaded && !preparing && ["game", "native"].includes(view)) {
      if (net.state !== "offline") {
        const budget = performance.now();
        const catchupBudget = net.serverFrame - net.frame > 3 ? 20 : 12;
        for (let n = 0; n < 6; n++) {
          if (
            !net.tick(time) ||
            net.serverFrame < net.frame ||
            performance.now() - budget > catchupBudget
          )
            break;
        }
      } else if (!paused && time + 1 >= next) {
        const inputs = [
          menuInput.length
            ? nextMenuInput()
            : pointerQueue.length
              ? nextPointerInput()
              : controls.sample(),
        ];
        if (waitForMenuRelease) {
          waitForMenuRelease = !!controls
            .pad()
            ?.buttons.some((button) => button.pressed);
          inputs[0] = neutral;
        }
        for (const pad of controls
          .devices()
          .filter((p) => String(p.index) !== controls.selected)
          .slice(0, 3))
          inputs.push(controls.sampleOther(pad));
        engine.frame(inputs);
        next = Math.max(next + 1000 / engine.fps, time - 1000 / engine.fps);
      }
    }
    if (engine.loaded && !preparing && time - (engine.lastInspect || 0) > 200) {
      engine.lastInspect = time;
      if (["native", "game"].includes(view)) {
        const info =
          net.running && engine.info ? engine.info : engine.inspect();
        if (roomSetup) {
          $("setup-help").textContent =
            info.scene === 11
              ? "Set item frequency and turn individual items on or off. B returns to VS Options."
              : info.scene === 10
                ? "Set handicap, team attack and damage. Open ITEM SWITCH for items. Stage Select stays on so the winner chooses. B goes back."
                : "Choose Time or Stock, then minutes or lives (∞ is available). VS OPTIONS includes items. VS START continues. Winner picks the next stage.";
          if (info.scene === 16) {
            const options = roomSetup;
            roomSetup = null;
            paused = true;
            // Finish the native scene transition before preserving the chosen rules.
            preparing = true;
            attempt(async () => {
              try {
                await runSequence([[90, neutral]]);
                engine.enableStageSelect();
                versusState = engine.snapshot();
              } finally {
                preparing = false;
              }
              await joinRoom(options);
            })();
          } else if ([7, 1].includes(info.scene)) {
            roomSetup = null;
            paused = true;
            setView("browse");
          }
        }
        if (net.state === "offline" && view === "native" && info.scene !== 7) {
          if (info.scene === 9) {
            paused = true;
            setView("browse");
          } else if (info.scene === 1 && menuState) {
            engine.restore(menuState);
          } else if (![1, 28].includes(info.scene)) {
            setView("game");
            renderGame();
          }
        } else if (
          net.state === "offline" &&
          view === "game" &&
          info.scene === 7 &&
          !paused
        )
          setView("native");
        if (net.isHost && net.running) {
          if ([21, 22, 24].includes(info.scene)) enteredStage = true;
          if ([7, 9].includes(info.scene)) leaveRoom();
          else if (info.scene === 16 && !net.room.selecting && enteredStage) {
            enteredStage = false;
            net.send({
              type: "open",
              match: net.room.match,
              revision: net.room.revision,
            });
          }
          if (info.scene === 16 && !net.room.selecting) {
            if (!engine.sealedAt) engine.sealedAt = engine.frames;
            if (engine.frames - engine.sealedAt > 180) {
              net.send({
                type: "open",
                match: net.room.match,
                revision: net.room.revision,
              });
              engine.sealedAt = 0;
            }
          } else engine.sealedAt = 0;
          if (startRequest && time - startRequest.time > 3000)
            startRequest = null;
        }
        document.body.dataset.battle = String(isGameplay(info.scene));
        renderPointerMenu(info);
        renderCharacterRoom();
      }
    }
    if ($("controls-dialog").open) liveControls();
    menuController(time);
    if (time - lastDeviceCheck > 250) {
      refreshDevices();
      lastDeviceCheck = time;
    }
    if (time - lastUI > 1000) {
      lastFPS = Math.round(
        ((engine.frames - lastFrames) * 1000) / (time - lastUI),
      );
      lastFrames = engine.frames;
      lastUI = time;
      if (net.room && time - lastPerformanceSample >= 5000) {
        lastPerformanceSample = time;
        net.samplePerformance(lastFPS, !!roomUI.voice.stream, longTasks);
        longTasks = 0;
      }
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
const hostStatus = serviceFetch("/api/status")
  .then((r) => r.json())
  .then((s) => {
    shareUrl = s.shareUrl;
    publicUrl = s.publicUrl;
    if (s.testingAutoLoad) {
      document.body.dataset.testingMode = "auto";
      $("cartridge-badge").textContent = "Testing build";
      for (const button of document.querySelectorAll("[data-testing]"))
        button.onclick = attempt(() => withCartridge(showMainMenu));
    }
    if (window.parent !== window && publicUrl)
      window.parent.postMessage(
        { type: "smash-ready" },
        new URL(publicUrl).origin,
      );
    return s;
  })
  .catch(() => {});
function followInvitation() {
  const token = inviteToken();
  if (!token || token === net.token) return;
  if (net.room)
    return toast("Leave your current room before opening another invitation.");
  setView("browse");
  $("invite-input").value = location.href;
  savedCartridge.then(openJoin);
}
window.addEventListener("hashchange", followInvitation);
followInvitation();
