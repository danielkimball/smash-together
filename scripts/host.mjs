import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import { root, share } from "./share.mjs";
const port = Number(process.env.PORT || 8787);
await mkdir(path.join(root, ".local"), { recursive: true });
await writeFile(path.join(root, ".local/host.pid"), String(process.pid), {
  mode: 0o600,
});
await rm(path.join(root, ".local/share.json"), { force: true });
let server,
  restarting = false;
function startServer() {
  server = spawn(process.execPath, [path.join(root, "server.mjs")], {
    stdio: "inherit",
    env: { ...process.env, PORT: String(port) },
  });
  server.on("exit", () => {
    if (!stopping && !restarting) setTimeout(startServer, 1000);
  });
}

console.log(`Smash Portal is running at http://localhost:${port}`);
let tunnel = null,
  timer = null,
  stopping = false;
startServer();
const awake =
  process.platform === "darwin"
    ? spawn("/usr/bin/caffeinate", ["-i", "-w", String(process.pid)], {
        stdio: "ignore",
      })
    : null;
async function connect() {
  try {
    tunnel = await share(port);
    tunnel.on("exit", () => {
      rm(path.join(root, ".local/share.json"), { force: true });
      if (!stopping) {
        console.log("Tunnel stopped; retrying in 10 seconds.");
        timer = setTimeout(connect, 10000);
      }
    });
  } catch (e) {
    console.error("Sharing:", e.message);
    if (!stopping) timer = setTimeout(connect, 30000);
  }
}
if (process.env.NO_SHARE !== "1") connect();
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    clearTimeout(timer);
    tunnel?.kill("SIGTERM");
    awake?.kill("SIGTERM");
    await rm(path.join(root, ".local/share.json"), { force: true });
    await rm(path.join(root, ".local/host.pid"), { force: true });
    if (server?.exitCode === null) {
      const exited = once(server, "exit");
      server.kill("SIGTERM");
      await exited;
    }
    process.exit(0);
  });

if (process.platform !== "win32")
  process.on("SIGUSR2", async () => {
    if (stopping || restarting) return;
    restarting = true;
    try {
      if (server?.exitCode === null) {
        const exited = once(server, "exit");
        server.kill("SIGTERM");
        const deadline = setTimeout(() => server.kill("SIGKILL"), 5000);
        await exited;
        clearTimeout(deadline);
      }
      startServer();
      console.log("Game server restarted; sharing address retained.");
    } finally {
      restarting = false;
    }
  });
