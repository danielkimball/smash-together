import { readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
const run = promisify(execFile),
  root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export async function publishLink(url) {
  let config;
  try {
    config = JSON.parse(
      await readFile(path.join(root, ".local/config.json"), "utf8"),
    );
  } catch {
    return;
  }
  if (!config.pagesRepo) return;
  if (!/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(url))
    throw Error("Invalid tunnel address");
  const gh = config.ghPath || "gh",
    endpoint = `repos/${config.pagesRepo}/contents/server.json`;
  const { stdout } = await run(gh, ["api", endpoint + "?ref=gh-pages"], {
    timeout: 20000,
  });
  const current = JSON.parse(stdout),
    old = JSON.parse(Buffer.from(current.content, "base64").toString());
  if (old.url === url) return;
  const body = {
    message: "Update live Smash host",
    branch: "gh-pages",
    sha: current.sha,
    content: Buffer.from(
      JSON.stringify({ url, updated: new Date().toISOString() }) + "\n",
    ).toString("base64"),
  };
  const temp = path.join(root, ".local/publish-link.json");
  await mkdir(path.dirname(temp), { recursive: true });
  await writeFile(temp, JSON.stringify(body), { mode: 0o600 });
  try {
    await run(gh, ["api", "--method", "PUT", endpoint, "--input", temp], {
      timeout: 30000,
    });
    console.log("Legacy bookmark redirect updated: " + url);
  } finally {
    await rm(temp, { force: true });
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await publishLink(process.argv[2]);
