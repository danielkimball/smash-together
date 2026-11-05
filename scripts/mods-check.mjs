// Two isolated browsers: a host with a crew pack installed invites a guest
// with no mods. The guest must boot the room's cartridge for that room only,
// stay hash-matched, never install the pack, and host its own rooms original.
// Needs a staging server with testing autoload and .local/mods/<pack>.key.
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { root } from "./share.mjs";
import { browserHelpers } from "./browser-helpers.mjs";
const url = process.env.SMASH_URL || "http://127.0.0.1:8790";
const id = process.env.SMASH_MOD_PACK || "dans-crew";
const key = (
  await readFile(path.join(root, ".local/mods", `${id}.key`), "utf8")
).trim();
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.CHROME_PATH ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  args: [
    "--autoplay-policy=no-user-gesture-required",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
  ],
});
const pages = [],
  errors = [],
  report = { checks: [], errors };
const h = browserHelpers(browser, { url, pages, errors });
const pass = (name, data) => {
  report.checks.push({ name, ...data });
  console.log("PASS", name, JSON.stringify(data || {}));
};
async function page(hash) {
  const c = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  await c.addInitScript(() => {
    Object.defineProperty(document, "hidden", { get: () => false });
    Object.defineProperty(navigator, "getGamepads", {
      configurable: true,
      value: () => [],
    });
  });
  const p = await c.newPage();
  pages.push(p);
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(url + "/" + hash);
  return p;
}
const cartridge = (p) =>
  p.evaluate(() => ({
    tag: smash.engine.modsTag,
    packs: smash.engine.modPacks.map((m) => m.id),
    installed: (
      JSON.parse(localStorage.getItem("smash.mods.v1") || "{}").packs || []
    ).map((m) => [m.id, m.enabled]),
  }));
try {
  await mkdir(path.join(root, "artifacts"), { recursive: true });
  const host = await page(`#mods=${id}.${key}`);
  await h.boot(host);
  const hosted = await cartridge(host);
  assert.deepEqual(hosted.packs, [id]);
  assert.deepEqual(hosted.installed, [[id, true]]);
  assert.equal(
    await host.evaluate(() => location.hash),
    "",
    "install key removed from the address bar",
  );
  pass("install link installs, enables and boots the pack", hosted);
  await h.browse(host);
  await host.locator("#create-open").click();
  await host.locator("#visibility").selectOption("private");
  await host.locator("#create-room").click();
  await h.scene(host, 9);
  await host.locator('[data-native-input="a"]').click();
  await h.scene(host, 16);
  await host.waitForFunction(() => smash.net.running);
  await h.clickNative(host, 182, 100);
  assert.deepEqual(
    await host.evaluate(() => smash.net.room.mods.map((m) => m.id)),
    [id],
  );
  await host.locator("[data-invite]").first().click();
  const invite = await host.locator("#invite-link").inputValue();
  await host.keyboard.press("Escape");
  assert.match(invite, new RegExp(`&mods=${id}\\.`));
  pass("modded room lists its pack and invitation carries it");

  const guest = await page("#" + invite.split("#")[1]);
  await guest.waitForFunction(
    () => document.getElementById("join-dialog").open,
  );
  await guest.locator("#join-room").click();
  await h.boot(guest);
  await guest.waitForFunction(() => smash.net.running, null, {
    timeout: 90000,
  });
  await h.scene(guest, 16);
  const joined = await cartridge(guest);
  assert.equal(joined.tag, hosted.tag);
  assert.deepEqual(joined.installed, [], "invitation never installs mods");
  await h.wait(8000);
  const sync = await Promise.all(
    [host, guest].map((p) =>
      p.evaluate(() => ({
        matches: smash.net.matches,
        repairs: smash.net.repairs,
      })),
    ),
  );
  assert.ok(
    sync.every((s) => s.matches > 0 && s.repairs === 0),
    JSON.stringify(sync),
  );
  pass("guest boots the room's mods for this room only, hashes match", {
    joined,
    sync,
  });

  // Leaving and hosting must switch the guest back to the original game.
  await guest.locator("#selection-back").click();
  await guest.waitForFunction(() => smash.view === "browse");
  await guest.locator("#create-open").click();
  await guest.locator("#create-room").click();
  await guest.waitForEvent("load", { timeout: 30000 });
  await h.boot(guest);
  const own = await cartridge(guest);
  assert.equal(own.tag, "");
  assert.deepEqual(own.packs, []);
  pass("guest's own rooms run the original cartridge after a reload", own);

  // A modded player joining an original public room switches for that room.
  await h.browse(guest);
  await guest.locator("#create-open").click();
  await guest.locator("#visibility").selectOption("public");
  await guest.locator("#create-room").click();
  await h.scene(guest, 9);
  await guest.locator('[data-native-input="a"]').click();
  await h.scene(guest, 16);
  await host.locator("#selection-back").click();
  await host.waitForFunction(() => smash.view === "browse");
  const row = host.locator(".room-row:not([disabled])").first();
  await row.waitFor({ timeout: 30000 });
  await row.click();
  await host.waitForEvent("load", { timeout: 30000 });
  await h.boot(host);
  await host.waitForFunction(() => smash.net.running, null, {
    timeout: 90000,
  });
  const switched = await cartridge(host);
  assert.equal(switched.tag, "");
  assert.deepEqual(switched.installed, [[id, true]], "pack stays installed");
  pass(
    "modded player joins an original room after an automatic reload",
    switched,
  );
  assert.deepEqual(errors, []);
} catch (error) {
  report.failure = error.stack;
  console.error(error);
  process.exitCode = 1;
} finally {
  await writeFile(
    path.join(root, "artifacts/mods-check.json"),
    JSON.stringify(report, null, 2),
  );
  await browser.close();
}
