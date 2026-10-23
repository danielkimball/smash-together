import { mkdir, readFile, writeFile, chmod, rm } from "node:fs/promises";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { publishLink } from "./publish-link.mjs";
import { TunnelState } from "./tunnel-state.mjs";
export const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const run = promisify(execFile);
export async function writeFriendsShortcut(url) {
  if (process.platform !== "darwin") return;
  if (!/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(url)) return;
  try {
    const config = JSON.parse(
      await readFile(path.join(root, ".local/config.json"), "utf8"),
    );
    if (config.frontendUrl && new URL(config.frontendUrl).protocol === "https:")
      url = new URL(config.frontendUrl).href;
  } catch {}
  const desktop = path.join(os.homedir(), "Desktop/Smash Together");
  await mkdir(desktop, { recursive: true });
  await writeFile(
    path.join(desktop, "Friends Link.webloc"),
    `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>URL</key><string>${url.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</string></dict></plist>\n`,
  );
}
const version = "2026.10.3";
const releases = {
  "darwin-x64": [
    "darwin-amd64",
    "81b7b85f2376815c4f59b1aa323887b62e16ce8b67555c2e1577dc23f2a82000",
  ],
  "darwin-arm64": [
    "darwin-arm64",
    "1165d14b6f6360a3b8c283d7d1100024d6ec7cd9bc9e32519e96150645f3ec55",
  ],
  "win32-x64": [
    "windows-amd64",
    "76b2805253d0d6ffacb092a7acfbee99e7af6917835c0c5410e23f3ef5052da2",
  ],
};
export async function ensureTunnel() {
  const dir = path.join(root, ".local/bin"),
    windows = process.platform === "win32",
    bin = path.join(dir, windows ? "cloudflared.exe" : "cloudflared");
  const release = releases[`${process.platform}-${process.arch}`];
  if (!release)
    throw Error(
      "Automatic tunnel setup supports Intel/Apple Silicon Macs and x64 Windows. Use a supported Node architecture or install cloudflared manually on other platforms.",
    );
  await mkdir(dir, { recursive: true });
  try {
    const { stdout } = await run(bin, ["--version"]);
    if (stdout.includes(version)) return bin;
  } catch {}
  console.log(`Downloading free cloudflared ${version} for ${release[0]}…`);
  const response = await fetch(
    `https://github.com/cloudflare/cloudflared/releases/download/${version}/cloudflared-${release[0]}.${windows ? "exe" : "tgz"}`,
  );
  if (!response.ok) throw Error(`Tunnel download failed: ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(data).digest("hex") !== release[1])
    throw Error("Tunnel download checksum did not match.");
  if (windows) await writeFile(bin, data);
  else {
    const archive = path.join(dir, "cloudflared.tgz");
    await writeFile(archive, data);
    await run("/usr/bin/tar", ["-xzf", archive, "-C", dir, "cloudflared"]);
    await chmod(bin, 0o755);
    await rm(archive);
  }
  return bin;
}
export async function share(port = 8787) {
  const bin = await ensureTunnel();
  let transport = "http2";
  try {
    const config = JSON.parse(
      await readFile(path.join(root, ".local/config.json"), "utf8"),
    );
    if (["auto", "quic", "http2"].includes(config.tunnelProtocol))
      transport = config.tunnelProtocol;
  } catch {}
  await rm(path.join(root, ".local/share.json"), { force: true });
  const child = spawn(
    bin,
    [
      "tunnel",
      "--no-autoupdate",
      "--protocol",
      transport,
      "--url",
      `http://127.0.0.1:${port}`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const state = new TunnelState();
  let published = false,
    publishedProtocol = null,
    publishedAt = null,
    checking = false,
    stopping = false,
    publicationTimer,
    lastCheck = 0;
  const alive = () => !stopping && child.exitCode === null && !child.killed;
  function recycle(reason) {
    if (!alive()) return;
    stopping = true;
    console.error("Recreating sharing tunnel:", reason);
    rm(path.join(root, ".local/share.json"), { force: true }).catch(() => {});
    child.kill("SIGTERM");
    const deadline = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 5000);
    deadline.unref();
    child.once("exit", () => clearTimeout(deadline));
  }
  async function check() {
    if (checking || !alive() || !state.url || !state.registered) return;
    if (Date.now() - lastCheck < 20000) return;
    lastCheck = Date.now();
    checking = true;
    try {
      const response = await fetch(state.url + "/api/status", {
        signal: AbortSignal.timeout(8000),
        cache: "no-store",
      });
      const ok = response.ok && (await response.json()).ok === true;
      if (!alive()) return;
      if (published && state.health(ok))
        return recycle("public health checks failed three times");
      if (!ok || (published && publishedProtocol === state.protocol)) return;
      publishedAt ||= new Date().toISOString();
      await writeFile(
        path.join(root, ".local/share.json"),
        JSON.stringify({
          url: state.url,
          pid: process.pid,
          started: publishedAt,
          protocol: state.protocol,
        }) + "\n",
      );
      if (!alive()) {
        await rm(path.join(root, ".local/share.json"), { force: true });
        return;
      }
      publishedProtocol = state.protocol;
      if (published) return;
      published = true;
      console.log(`SHARE_URL=${state.url}`);
      await writeFriendsShortcut(state.url);
      const publish = async () => {
        if (!alive()) return;
        try {
          await publishLink(state.url);
        } catch (error) {
          console.error("Stable link update:", error.message);
          if (alive()) publicationTimer = setTimeout(publish, 30000);
        }
      };
      publish();
    } catch (error) {
      if (alive() && published && state.health(false))
        recycle("public endpoint is unreachable");
    } finally {
      checking = false;
    }
  }
  const healthTimer = setInterval(check, 20000);
  healthTimer.unref();
  // A stalled launch with no registration must not leave sharing dead forever.
  const startupTimer = setTimeout(() => {
    if (!published) recycle("tunnel did not become publicly reachable");
  }, 180000);
  startupTimer.unref();
  child.once("exit", () => {
    stopping = true;
    clearInterval(healthTimer);
    clearTimeout(startupTimer);
    clearTimeout(publicationTimer);
  });
  child.on("error", (error) => console.error("Tunnel process:", error.message));
  function output(chunk) {
    const line = chunk.toString();
    process.stdout.write(line);
    state.log(line);
    if (state.revoked) recycle("Cloudflare revoked the old Quick Tunnel");
    else if (!published) check();
  }
  child.stdout.on("data", output);
  child.stderr.on("data", output);
  return child;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const child = await share(Number(process.env.PORT || 8787));
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => child.kill("SIGTERM"));
  child.on("exit", async (code) => {
    await rm(path.join(root, ".local/share.json"), { force: true });
    process.exit(code || 0);
  });
}
