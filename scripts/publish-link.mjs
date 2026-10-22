import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertPublisher } from "./host-ownership.mjs";
import { parseHostRecord } from "../public/js/host-record.js";
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export async function ensurePagesBuild(config) {
  const gh = config.ghPath || "gh";
  const base = `repos/${config.pagesRepo}`;
  const latest = await ghJSON(gh, ["api", base + "/pages/builds/latest"]);
  if (["queued", "building"].includes(latest.status)) return;
  const head = await ghJSON(gh, ["api", base + "/git/ref/heads/gh-pages"]);
  if (latest.status === "built" && latest.commit === head.object.sha) return;
  await ghJSON(gh, ["api", "--method", "POST", base + "/pages/builds"]);
}
async function verifyPublishedHost(record, config) {
  await ensurePagesBuild(config);
  const endpoint = new URL(
    `active-host.json?t=${Date.now()}`,
    config.frontendUrl,
  );
  const response = await fetch(endpoint, {
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });
  const live = response.ok && (await response.json());
  if (
    live.hostId !== record.hostId ||
    live.publisher !== record.publisher ||
    live.url !== record.url
  )
    throw Error(
      "Host address saved; waiting for GitHub Pages to publish it. Retrying shortly.",
    );
}
export function ghJSON(gh, args, body) {
  return new Promise((resolve, reject) => {
    const child = spawn(gh, args, {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "",
      error = "";
    const timer = setTimeout(() => child.kill(), 60000);
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (error += chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code) reject(Error(error.trim() || `GitHub command exited ${code}`));
      else {
        try {
          resolve(output.trim() ? JSON.parse(output) : null);
        } catch (e) {
          reject(e);
        }
      }
    });
    child.stdin.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
export async function publishLink(
  url,
  { promote = false, configPath = path.join(root, ".local/config.json") } = {},
) {
  let config;
  try {
    config = JSON.parse(await readFile(configPath, "utf8"));
  } catch {
    return;
  }
  if (!config.pagesRepo || config.publishLink !== true) return;
  if (!/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(url))
    throw Error("Invalid tunnel address");
  const health = await fetch(url + "/api/status", {
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });
  const status = health.ok ? await health.json() : null;
  if (!status?.ok || status.hostId !== config.hostId)
    throw Error("The public endpoint did not verify as this host.");
  const gh = config.ghPath || "gh";
  const login = (await ghJSON(gh, ["api", "user"])).login;
  const endpoint = `repos/${config.pagesRepo}/contents/active-host.json`;
  for (let attempt = 0; attempt < 3; attempt++) {
    let file = null;
    try {
      file = await ghJSON(gh, ["api", endpoint + "?ref=gh-pages"]);
    } catch (error) {
      if (!/HTTP 404/.test(error.message)) throw error;
    }
    const current = file
      ? JSON.parse(Buffer.from(file.content, "base64").toString())
      : null;
    assertPublisher(current, config, login, promote);
    if (
      current?.url === url &&
      current.hostId === config.hostId &&
      current.publisher === login
    ) {
      await verifyPublishedHost(current, config);
      return;
    }
    let backup = current?.backup;
    if (promote && current && current.hostId !== config.hostId)
      backup = {
        hostId: current.hostId,
        url: current.url,
        publisher: current.publisher,
      };
    if (promote && !current) {
      try {
        const legacy = await ghJSON(gh, [
          "api",
          `repos/${config.pagesRepo}/contents/server.json?ref=gh-pages`,
        ]);
        const old = JSON.parse(
          Buffer.from(legacy.content, "base64").toString(),
        );
        if (/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(old.url))
          backup = {
            hostId: "dan-mac",
            url: old.url,
            publisher: "danielkimball",
          };
      } catch {
        /* Explicit promotion may proceed without a legacy registry. */
      }
    }
    const record = parseHostRecord({
      version: 1,
      hostId: config.hostId,
      publisher: login,
      url,
      updated: new Date().toISOString(),
      ...(backup ? { backup } : {}),
    });
    try {
      await ghJSON(gh, ["api", "--method", "PUT", endpoint, "--input", "-"], {
        message: promote
          ? `Promote ${config.hostId} to primary host`
          : `Update ${config.hostId} tunnel`,
        branch: "gh-pages",
        ...(file ? { sha: file.sha } : {}),
        content: Buffer.from(JSON.stringify(record, null, 2) + "\n").toString(
          "base64",
        ),
      });
      await verifyPublishedHost(record, config);
      console.log(`Primary host address verified and published: ${url}`);
      return;
    } catch (error) {
      if (!/HTTP (409|422)/.test(error.message) || attempt === 2) throw error;
      // Recheck ownership on conflicts: a stale backup must not win a retry.
    }
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await publishLink(process.argv[2], {
    promote: process.argv.includes("--promote"),
  });
