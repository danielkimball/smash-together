import { mkdir, readFile, writeFile, chmod, rm } from "node:fs/promises";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
export const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const run = promisify(execFile);
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
};
export async function ensureTunnel() {
  const dir = path.join(root, ".local/bin"),
    bin = path.join(dir, "cloudflared");
  const release = releases[`${process.platform}-${process.arch}`];
  if (!release)
    throw Error(
      "Automatic tunnel setup supports Intel and Apple Silicon Macs. Install cloudflared manually on other platforms.",
    );
  await mkdir(dir, { recursive: true });
  try {
    const { stdout } = await run(bin, ["--version"]);
    if (stdout.includes(version)) return bin;
  } catch {}
  console.log(`Downloading free cloudflared ${version} for ${release[0]}…`);
  const response = await fetch(
    `https://github.com/cloudflare/cloudflared/releases/download/${version}/cloudflared-${release[0]}.tgz`,
  );
  if (!response.ok) throw Error(`Tunnel download failed: ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(data).digest("hex") !== release[1])
    throw Error("Tunnel download checksum did not match.");
  const archive = path.join(dir, "cloudflared.tgz");
  await writeFile(archive, data);
  await run("/usr/bin/tar", ["-xzf", archive, "-C", dir, "cloudflared"]);
  await chmod(bin, 0o755);
  await rm(archive);
  return bin;
}
export async function share(port = 8787) {
  const bin = await ensureTunnel();
  await rm(path.join(root, ".local/share.json"), { force: true });
  const child = spawn(
    bin,
    [
      "tunnel",
      "--no-autoupdate",
      "--protocol",
      "http2",
      "--url",
      `http://127.0.0.1:${port}`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let published = false,
    buffer = "";
  function output(chunk) {
    const line = chunk.toString();
    process.stdout.write(line);
    buffer = (buffer + line).slice(-12000);
    const match = buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (match && !published) {
      published = true;
      writeFile(
        path.join(root, ".local/share.json"),
        JSON.stringify({
          url: match[0],
          pid: process.pid,
          started: new Date().toISOString(),
        }) + "\n",
      ).then(() => console.log(`SHARE_URL=${match[0]}`));
    }
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
