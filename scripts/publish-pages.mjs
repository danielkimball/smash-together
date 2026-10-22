import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ghJSON, ensurePagesBuild } from "./publish-link.mjs";
import { assertPublisher } from "./host-ownership.mjs";
const run = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export async function publishPages({
  source = path.join(root, "public"),
  commit,
} = {}) {
  const config = JSON.parse(
    await readFile(path.join(root, ".local/config.json"), "utf8"),
  );
  if (config.publishLink !== true)
    throw Error("Publication is disabled on this host.");
  const git = config.gitPath || "git",
    gh = config.ghPath || "gh";
  const user = await ghJSON(gh, ["api", "user"]);
  const recordFile = await ghJSON(gh, [
    "api",
    `repos/${config.pagesRepo}/contents/active-host.json?ref=gh-pages`,
  ]);
  assertPublisher(
    JSON.parse(Buffer.from(recordFile.content, "base64").toString()),
    config,
    user.login,
  );
  const local = path.join(root, ".local");
  const checkout = path.join(local, "pages-publish");
  const gitRun = async (args, cwd = checkout) =>
    (
      await run(git, args, {
        cwd,
        windowsHide: true,
        timeout: 180000,
        maxBuffer: 8e6,
      })
    ).stdout.trim();
  await mkdir(local, { recursive: true });
  try {
    await readFile(path.join(checkout, ".git/HEAD"));
  } catch {
    await gitRun(
      [
        "clone",
        "--branch",
        "gh-pages",
        "--single-branch",
        `https://github.com/${config.pagesRepo}.git`,
        checkout,
      ],
      root,
    );
  }
  await gitRun(["config", "user.name", user.login]);
  await gitRun([
    "config",
    "user.email",
    `${user.id}+${user.login}@users.noreply.github.com`,
  ]);
  await gitRun(["config", "core.autocrlf", "false"]);
  if (!commit) commit = await gitRun(["rev-parse", "HEAD"], root);
  async function safeRemove(target) {
    const relative = path.relative(checkout, path.resolve(target));
    if (
      !relative ||
      relative.startsWith("..") ||
      path.isAbsolute(relative) ||
      relative.split(path.sep)[0] === ".git"
    )
      throw Error(
        "Refusing to remove a path outside the dedicated Pages checkout.",
      );
    await rm(target, { recursive: true, force: true });
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    await gitRun(["fetch", "origin", "gh-pages"]);
    // This checkout is disposable and is used only by this publisher.
    await gitRun(["reset", "--hard", "origin/gh-pages"]);
    assertPublisher(
      JSON.parse(
        await readFile(path.join(checkout, "active-host.json"), "utf8"),
      ),
      config,
      user.login,
    );
    for (const entry of await readdir(checkout)) {
      if (
        [
          ".git",
          "active-host.json",
          "server.json",
          ".nojekyll",
          "README.md",
        ].includes(entry)
      )
        continue;
      await safeRemove(path.join(checkout, entry));
    }
    for (const entry of await readdir(source, { withFileTypes: true })) {
      if (
        entry.isSymbolicLink() ||
        entry.name.startsWith(".") ||
        ["active-host.json", "server.json"].includes(entry.name)
      )
        throw Error("Unexpected private or registry file in public assets.");
      await cp(path.join(source, entry.name), path.join(checkout, entry.name), {
        recursive: true,
      });
    }
    await writeFile(path.join(checkout, ".nojekyll"), "");
    await writeFile(
      path.join(checkout, "deployment.json"),
      JSON.stringify({ commit, hostId: config.hostId }) + "\n",
    );
    await writeFile(
      path.join(checkout, "README.md"),
      "# Smash Portal\n\nPermanent game: https://danielkimball.github.io/smash-together/\n\nThe frontend uses active-host.json. Legacy server.json updates cannot change the primary host. No ROMs, saves or private host settings are published.\n",
    );
    await gitRun(["add", "--all"]);
    if (!(await gitRun(["diff", "--cached", "--name-only"]))) break;
    await gitRun([
      "commit",
      "-m",
      `Deploy Smash Portal ${commit.slice(0, 12)}`,
    ]);
    try {
      await gitRun(["push", "origin", "HEAD:gh-pages"]);
      break;
    } catch (error) {
      if (attempt === 2) throw error;
    }
    // On a concurrent tunnel update, rebuild on its latest commit, preserving it.
  }
  const deadline = Date.now() + 600000;
  let lastBuildCheck = 0;
  while (Date.now() < deadline) {
    if (Date.now() - lastBuildCheck > 60000) {
      await ensurePagesBuild(config);
      lastBuildCheck = Date.now();
    }
    try {
      const response = await fetch(
        new URL(`deployment.json?t=${Date.now()}`, config.frontendUrl),
        { cache: "no-store", signal: AbortSignal.timeout(15000) },
      );
      const deployed = response.ok && (await response.json());
      if (deployed.commit === commit && deployed.hostId === config.hostId) {
        console.log(
          `Verified permanent site deployment ${commit.slice(0, 12)}`,
        );
        return;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 10000));
  }
  throw Error(
    "GitHub accepted the deployment, but the permanent site has not updated yet. The next update check will retry.",
  );
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await publishPages();
