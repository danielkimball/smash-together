import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { root, writeFriendsShortcut } from "./share.mjs";
const run = promisify(execFile),
  label = "io.labetesoftware.smash64",
  domain = `gui/${process.getuid()}`;
const plist = path.join(os.homedir(), "Library/LaunchAgents", label + ".plist");
const xml = (s) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
async function stop() {
  try {
    await run("/bin/launchctl", ["bootout", domain + "/" + label]);
  } catch {}
  // bootout can return while the old job is still being removed. Do not let
  // install/start mistake that retiring job for the newly installed service.
  for (let i = 0; i < 100; i++) {
    try {
      await run("/bin/launchctl", ["print", domain + "/" + label]);
    } catch {
      return;
    }
    await delay(100);
  }
  throw Error("The sharing service is still stopping. Retry in a moment.");
}
async function start() {
  try {
    await run("/bin/launchctl", ["print", domain + "/" + label]);
  } catch {
    await run("/bin/launchctl", ["bootstrap", domain, plist]);
  }
}
const command = process.argv[2] || "status";
if (process.platform !== "darwin")
  throw Error("Use npm start / npm run share on other systems.");
if (command === "install") {
  await mkdir(path.dirname(plist), { recursive: true });
  await mkdir(path.join(root, ".local"), { recursive: true });
  await writeFile(
    plist,
    `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${label}</string>\n<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(path.join(root, "scripts/host.mjs"))}</string></array>\n<key>WorkingDirectory</key><string>${xml(root)}</string>\n<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>\n<key>StandardOutPath</key><string>${xml(path.join(root, ".local/host.log"))}</string>\n<key>StandardErrorPath</key><string>${xml(path.join(root, ".local/host-error.log"))}</string>\n</dict></plist>\n`,
  );
  await stop();
  await start();
  await writeShortcuts();
  console.log(
    "Installed. The game runs at login. Desktop shortcuts are ready.",
  );
} else if (command === "shortcuts") {
  await writeShortcuts();
  console.log("Desktop shortcuts refreshed without restarting the service.");
} else if (command === "start") {
  await start();
  console.log("Smash Portal is running: http://localhost:8787");
} else if (command === "restart") {
  await run("/bin/launchctl", ["kill", "SIGUSR2", domain + "/" + label]);
  console.log(
    "Restarting the game server while retaining the sharing connection.",
  );
} else if (command === "stop") {
  await stop();
  console.log("Stopped Smash Portal and internet sharing.");
} else if (command === "uninstall") {
  await stop();
  await rm(plist, { force: true });
  console.log("Login service removed. Project and saves retained.");
} else if (command === "status") {
  try {
    const r = await fetch("http://127.0.0.1:8787/api/status");
    console.log(await r.text());
  } catch {
    console.log("Smash Portal is stopped.");
  }
} else
  throw Error(
    "Use install, shortcuts, start, restart, stop, status or uninstall.",
  );

async function writeShortcuts() {
  const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
  let playURL = "http://localhost:8787";
  try {
    const config = JSON.parse(
      await readFile(path.join(root, ".local/config.json"), "utf8"),
    );
    if (config.frontendUrl && new URL(config.frontendUrl).protocol === "https:")
      playURL = new URL(config.frontendUrl).href;
  } catch {}
  const desktop = path.join(os.homedir(), "Desktop/Smash Together");
  await mkdir(desktop, { recursive: true });
  for (const [name, cmd] of [
    [
      "Play Smash",
      `${quote(process.execPath)} ${quote(path.join(root, "scripts/service.mjs"))} start\n/usr/bin/open -a 'Google Chrome' ${quote(playURL)}`,
    ],
    [
      "Start Sharing",
      `${quote(process.execPath)} ${quote(path.join(root, "scripts/service.mjs"))} start`,
    ],
    [
      "Stop Sharing",
      `${quote(process.execPath)} ${quote(path.join(root, "scripts/service.mjs"))} stop`,
    ],
  ])
    await writeFile(
      path.join(desktop, name + ".command"),
      `#!/bin/zsh\n${cmd}\n`,
      { mode: 0o755 },
    );
  await writeFile(
    path.join(desktop, "READ ME.txt"),
    `Smash Portal\n\nDouble-click Play Smash.command to open your game.\nPair your Xbox or N64 controller, then press a button. Mappings save automatically.\nPress Start to open the original Smash menu. Choose VS Mode, then create a room or select one below.\nYour friends open the link in Chrome/Edge, load their own ROMs and join.\nSet Time/Stock, lives or minutes, and VS Options / Item Switch first. Choose VS START.\nThen choose your fighter while friends join. Invite friends copies your permanent-site room link.\nEach friend joins the next controller port. When everyone has chosen, the host presses Start.\nRename beside the room title changes its name for everyone.\nShare Friends Link.webloc or use Invite friends.\nUse the same address each time to retain your ROM, name and controller settings.\nChange your name accepts typing; controller A opens the on-screen keyboard.\nAll 12 fighters and all 9 VS stages are unlocked. The winner picks the next stage.\nPhone touch controls appear automatically; rotate for landscape.\nThe small diamond in the bottom-right corner opens password testing access.\nUse Esc or L + R + Start for the overlay menu; Fullscreen hides browser chrome.\n\nKeep this laptop plugged in, its lid open, and both game tabs visible.\nThe service prevents idle sleep while running. Stop Sharing.command stops\nthe website, relay and sleep prevention. Start Sharing.command starts them.\nThe permanent site stays the same when the underlying Cloudflare connection changes.\nRooms reset after a restart, so copy a fresh room invite.\n\nFull instructions and Mac mini migration: ${path.join(root, "README.md")}\nSource code: ${root}\n`,
  );
  try {
    const shared = JSON.parse(
      await readFile(path.join(root, ".local/share.json"), "utf8"),
    );
    await writeFriendsShortcut(shared.url);
  } catch {} // The sharing process writes the shortcut as soon as its URL arrives.
}
