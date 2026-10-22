import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import { root } from "./share.mjs";
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
  const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
  const desktop = path.join(os.homedir(), "Desktop/Smash Together");
  await mkdir(desktop, { recursive: true });
  for (const [name, cmd] of [
    [
      "Play Smash",
      `${quote(process.execPath)} ${quote(path.join(root, "scripts/service.mjs"))} start\n/usr/bin/open -a 'Google Chrome' 'http://localhost:8787'`,
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
    `Smash Together\n\nDouble-click Play Smash.command to open your game.\nPair your Xbox or N64 controller, press a button, then choose Controller setup.\nChoose Multiplayer, enter your name, then create a room and copy its invite.\nYour friends open the link in Chrome/Edge, load their own ROMs and join.\nPick a player port and click I’m ready. The host clicks Choose fighters.\nThe full-window game opens directly at character selection.\nUse Esc or L + R + Start for the overlay menu; Fullscreen hides browser chrome.\n\nKeep this laptop plugged in, its lid open, and both game tabs visible.\nThe service prevents idle sleep while running. Stop Sharing.command stops\nthe website, relay and sleep prevention. Start Sharing.command starts them.\nThe free sharing URL can change after a restart. Create/copy a fresh invite.\n\nFull instructions and Mac mini migration: ${path.join(root, "README.md")}\nSource code: ${root}\n`,
  );
  console.log(
    "Installed. The game runs at login. Desktop shortcuts: " + desktop,
  );
} else if (command === "start") {
  await start();
  console.log("Smash Together is running: http://localhost:8787");
} else if (command === "stop") {
  await stop();
  console.log("Stopped Smash Together and internet sharing.");
} else if (command === "uninstall") {
  await stop();
  await rm(plist, { force: true });
  console.log("Login service removed. Project and saves retained.");
} else if (command === "status") {
  try {
    const r = await fetch("http://127.0.0.1:8787/api/status");
    console.log(await r.text());
  } catch {
    console.log("Smash Together is stopped.");
  }
} else throw Error("Use install, start, stop, status or uninstall.");
