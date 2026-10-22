import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  access,
  copyFile,
  mkdir,
  open,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ghJSON } from "./publish-link.mjs";
import { assertPublisher } from "./host-ownership.mjs";
import { publishPages } from "./publish-pages.mjs";
const run = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const local = path.join(root, ".local");
const generated = [
  "public/source/smash-together-source.tar.gz",
  "public/source/manifest.json",
  "public/engine/assets.zip",
];
const config = JSON.parse(
  await readFile(path.join(local, "config.json"), "utf8"),
);
const git = config.gitPath || "git",
  node = config.nodePath || process.execPath;
const npm = path.join(path.dirname(node), "node_modules/npm/bin/npm-cli.js");
process.env.PATH = [
  path.dirname(git),
  path.dirname(node),
  process.env.PATH,
].join(path.delimiter);
const gitRun = async (args, cwd = root) =>
  (
    await run(git, args, {
      cwd,
      windowsHide: true,
      timeout: 180000,
      maxBuffer: 8e6,
    })
  ).stdout.trim();
const execute = async (file, args, cwd = root) => {
  const result = await run(file, args, {
    cwd,
    windowsHide: true,
    timeout: 240000,
    maxBuffer: 8e6,
  });
  if (result.stdout.trim()) console.log(result.stdout.trim());
};
const service = (command) =>
  execute("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    path.join(root, "scripts/windows-service.ps1"),
    command,
  ]);
const status = async () => {
  const response = await fetch("http://127.0.0.1:8787/api/status", {
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw Error("Host is not healthy");
  return response.json();
};
async function owner() {
  const gh = config.ghPath || "gh";
  const user = await ghJSON(gh, ["api", "user"]);
  const file = await ghJSON(gh, [
    "api",
    `repos/${config.pagesRepo}/contents/active-host.json?ref=gh-pages`,
  ]);
  assertPublisher(
    JSON.parse(Buffer.from(file.content, "base64").toString()),
    config,
    user.login,
  );
}
async function assertClean() {
  const raw = (
    await run(git, ["status", "--porcelain", "--untracked-files=normal"], {
      cwd: root,
      windowsHide: true,
    })
  ).stdout;
  const dirty = raw
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((line) => !generated.includes(line.slice(3).replaceAll("\\", "/")));
  if (dirty.length)
    throw Error("Local source edits are present; refusing to overwrite them.");
}
async function waitHealthy() {
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    try {
      const state = await status();
      if (state.ok && state.hostId === config.hostId && state.shareUrl) {
        const response = await fetch(state.shareUrl + "/api/status", {
          signal: AbortSignal.timeout(10000),
        });
        if (response.ok && (await response.json()).hostId === config.hostId)
          return;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw Error(
    "Updated host did not become publicly healthy within four minutes",
  );
}
async function update() {
  if (config.autoUpdate !== true || config.publishLink !== true) return;
  let before;
  try {
    before = await status();
  } catch {
    console.log("Host is stopped; leaving it stopped.");
    return;
  }
  if (before.hostId !== config.hostId)
    throw Error("A different host is using the local port.");
  if ((await gitRun(["branch", "--show-current"])) !== "main")
    throw Error("Automatic hosting updates require the main branch.");
  await assertClean();
  await owner();
  await gitRun(["fetch", "origin", "main"]);
  const current = await gitRun(["rev-parse", "HEAD"]);
  const target = await gitRun(["rev-parse", "origin/main"]);
  if (current === target) {
    let deployed;
    try {
      deployed = JSON.parse(
        await readFile(path.join(local, "deployment.json"), "utf8"),
      ).commit;
    } catch {}
    if (deployed !== current) {
      await publishPages({ commit: current });
      await writeFile(
        path.join(local, "deployment.json"),
        JSON.stringify({ commit: current, at: new Date().toISOString() }),
      );
    }
    return;
  }
  await gitRun(["merge-base", "--is-ancestor", current, target]);
  await assertClean();
  const candidate = path.join(local, "releases", target);
  let validated = false;
  try {
    validated =
      JSON.parse(
        await readFile(path.join(candidate, ".validated.json"), "utf8"),
      ).commit === target;
  } catch {}
  if (!validated) {
    await mkdir(path.dirname(candidate), { recursive: true });
    try {
      await access(path.join(candidate, ".git"));
    } catch {
      await gitRun([
        "clone",
        "--local",
        "--no-hardlinks",
        "--no-checkout",
        root,
        candidate,
      ]);
    }
    await gitRun(["config", "core.autocrlf", "false"], candidate);
    await gitRun(["checkout", "--detach", target], candidate);
    await execute(node, [npm, "ci"], candidate);
    await execute(node, [npm, "test"], candidate);
    await execute(node, [npm, "run", "check"], candidate);
    await gitRun(
      ["-c", "core.autocrlf=false", "submodule", "update", "--init"],
      candidate,
    );
    // Global Windows Git defaults must not transform pinned upstream bytes.
    await gitRun(
      ["-C", "upstream/m64wasm", "config", "core.autocrlf", "false"],
      candidate,
    );
    await gitRun(
      ["-C", "upstream/m64wasm", "checkout-index", "--all", "--force"],
      candidate,
    );
    if (!config.pythonPath)
      throw Error(
        "Configure pythonPath to package corresponding source before deployment.",
      );
    await execute(config.pythonPath, ["scripts/package-source.py"], candidate);
    await execute(node, [npm, "run", "check"], candidate);
    await writeFile(
      path.join(candidate, ".validated.json"),
      JSON.stringify({ commit: target }),
    );
  }
  await owner();
  await assertClean();
  const drain = path.join(local, "deploy-drain.json");
  await writeFile(drain, JSON.stringify({ expires: Date.now() + 120000 }));
  try {
    const live = await status();
    if (live.activeRooms !== 0 || live.updating !== true) {
      console.log(
        "Update is tested and waiting for all rooms, including private rooms, to close.",
      );
      return;
    }
    await service("stop");
    try {
      // Only these generated build products are replaced; source edits are protected above.
      await gitRun(["restore", "--worktree", "--", ...generated]);
      await gitRun(["merge", "--ff-only", target]);
      await execute(node, [npm, "ci"]);
      for (const file of generated)
        await copyFile(path.join(candidate, file), path.join(root, file));
      await service("start");
      await waitHealthy();
    } catch (error) {
      console.error("Update failed; restoring the previous tested version.");
      await service("stop");
      // Source was clean before switching; generated outputs are disposable.
      await gitRun(["reset", "--hard", current]);
      await execute(node, [npm, "ci"]);
      await service("start");
      throw error;
    }
    await publishPages({ commit: target });
    await writeFile(
      path.join(local, "deployment.json"),
      JSON.stringify({ commit: target, at: new Date().toISOString() }),
    );
    console.log(`Deployed main ${target}`);
  } finally {
    await rm(drain, { force: true });
  }
}
await mkdir(local, { recursive: true });
const lockPath = path.join(local, "update.lock");
let lock;
try {
  try {
    lock = await open(lockPath, "wx");
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const previous = JSON.parse(await readFile(lockPath, "utf8"));
    try {
      process.kill(previous.pid, 0);
      process.exit(0);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
    await rm(lockPath);
    lock = await open(lockPath, "wx");
  }
  await lock.writeFile(JSON.stringify({ pid: process.pid }));
  await update();
} catch (error) {
  console.error(new Date().toISOString(), error.message);
  process.exitCode = 1;
} finally {
  if (lock) {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}
