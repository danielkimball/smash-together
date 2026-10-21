import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { createApp } from "../server.mjs";
import { root, share } from "./share.mjs";
const port = Number(process.env.PORT || 8787);
await mkdir(path.join(root, ".local"), { recursive: true });
await rm(path.join(root, ".local/share.json"), { force: true });
const app = createApp({ port });
await app.ready;
console.log(`Smash Together is running at http://localhost:${port}`);
let tunnel = null,
  timer = null,
  stopping = false;
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
    await app.close();
    process.exit(0);
  });
