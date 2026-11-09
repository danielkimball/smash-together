// B with the selection token still in hand asks "Exit game?" instead of
// leaving. Cancel (B, or A on the default Cancel) keeps you in the room, Exit
// leaves, and a button still held from closing any dialog never reaches the
// room as a fresh press (it used to leave the room, or pick a fighter).
import { browserHelpers } from "./browser-helpers.mjs";
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";

const url = process.env.SMASH_URL || "http://127.0.0.1:8790";
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH,
  args: [
    "--autoplay-policy=no-user-gesture-required",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
  ],
});
const pages = [],
  checks = [],
  errors = [];
const record = (name, data = {}) => {
  checks.push({ name, ...data });
  console.log("PASS", name, JSON.stringify(data));
};
const { wait, pad, create, browse, openPage, clickNative } = browserHelpers(
  browser,
  { url, pages, errors },
);
// Menus read held keys once per animation frame, so hold like a person.
async function hold(p, code, ms = 160) {
  await p.keyboard.down(code);
  await wait(ms);
  await p.keyboard.up(code);
  await wait(250);
}
const state = (p) =>
  p.evaluate(() => {
    const info = smash.engine.inspect();
    return {
      inRoom: !!smash.net.room,
      view: smash.view,
      scene: info.scene,
      selected: !!info.players[smash.net.player]?.selected,
      modal: document.getElementById("exit-dialog").open,
      focus: document.activeElement?.id || "",
    };
  });
const modalOpen = (p) =>
  p.waitForFunction(() => document.getElementById("exit-dialog").open, null, {
    timeout: 10000,
  });

try {
  await mkdir("artifacts", { recursive: true });
  const p = await openPage();
  await browse(p);
  await create(p);
  await wait(1500);
  let s = await state(p);
  assert.equal(s.inRoom, true);
  assert.equal(s.selected, false);

  // Keyboard B (K) with the token in hand.
  await p.keyboard.press("KeyK");
  await modalOpen(p);
  s = await state(p);
  assert.equal(s.inRoom, true);
  assert.equal(s.focus, "exit-cancel");
  await p.screenshot({ path: "artifacts/exit-modal-desktop.png" });
  record("B with the token in hand opens Exit game? with Cancel focused", s);

  await hold(p, "KeyK", 400);
  await wait(1000);
  s = await state(p);
  assert.equal(s.modal, false);
  assert.equal(s.inRoom, true);
  record("B again cancels; the held B neither reopens it nor leaves", s);

  // Hover a fighter: place the token, then B recalls it natively (no modal).
  await clickNative(p, 86, 64);
  assert.equal((await state(p)).selected, true);
  await hold(p, "KeyK");
  await wait(600);
  s = await state(p);
  assert.equal(s.selected, false);
  assert.equal(s.modal, false);
  record("B with a fighter chosen still recalls the token, no prompt", s);

  await p.keyboard.press("KeyK");
  await modalOpen(p);
  await hold(p, "KeyJ", 400);
  await wait(1200);
  s = await state(p);
  assert.equal(s.modal, false);
  assert.equal(s.inRoom, true);
  assert.equal(s.selected, false);
  record("A on Cancel keeps you in; the held A does not pick a fighter", s);

  // Any other dialog closed with B must not leak into the room.
  await p.locator("#copy-invite").click();
  await p.waitForFunction(() => document.getElementById("invite-dialog").open);
  await p.mouse.move(0, 0);
  await hold(p, "KeyK", 400);
  await wait(1000);
  s = await state(p);
  assert.equal(
    await p.evaluate(() => document.getElementById("invite-dialog").open),
    false,
  );
  assert.equal(s.modal, false);
  assert.equal(s.inRoom, true);
  record("Closing Invite friends with B keeps you in the room, no prompt", s);

  // Synthetic standard controller: B opens, B cancels, Right + A exits.
  await p.evaluate(() => {
    window.qaPad = {
      id: "QA Xbox controller",
      index: 0,
      connected: true,
      mapping: "standard",
      axes: [0, 0, 0, 0],
      buttons: Array.from({ length: 17 }, () => ({ value: 0, pressed: false })),
    };
    Object.defineProperty(navigator, "getGamepads", { value: () => [qaPad] });
  });
  await p.waitForFunction(() => smash.controls.selected === "0");
  // Player 1 binds its device on first load; pick the pad like Controller setup.
  await p.evaluate(() => smash.localPlayers.assign("primary", "pad:0"));
  await wait(500);
  await pad(p, 2);
  await modalOpen(p);
  assert.equal((await state(p)).focus, "exit-cancel");
  await pad(p, 2, 400);
  await wait(1000);
  s = await state(p);
  assert.equal(s.modal, false);
  assert.equal(s.inRoom, true);
  record("Controller B opens and B cancels without leaving", s);

  await pad(p, 2);
  await modalOpen(p);
  await pad(p, 15);
  assert.equal((await state(p)).focus, "exit-confirm");
  await pad(p, 0);
  await p.waitForFunction(
    () => smash.view === "browse" && !smash.net.room,
    null,
    {
      timeout: 15000,
    },
  );
  record("Controller Right then A on Exit leaves to the room list");
  await p.context().close();

  // Phone: touch B opens the prompt; the layout fits a 390 px screen.
  const m = await openPage(true);
  await browse(m);
  await create(m);
  await wait(1500);
  await m.locator('[data-touch="b"]').tap();
  await modalOpen(m);
  const box = await m.locator("#exit-dialog").boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 390);
  await m.screenshot({ path: "artifacts/exit-modal-phone.png" });
  await m.locator("#exit-cancel").tap();
  await wait(1000);
  s = await state(m);
  assert.equal(s.modal, false);
  assert.equal(s.inRoom, true);
  await m.locator('[data-touch="b"]').tap();
  await modalOpen(m);
  await m.locator("#exit-confirm").tap();
  await m.waitForFunction(
    () => smash.view === "browse" && !smash.net.room,
    null,
    {
      timeout: 15000,
    },
  );
  record("Touch B opens the prompt on a phone; Cancel stays, Exit leaves", {
    width: Math.round(box.width),
  });
  await m.context().close();
  assert.deepEqual(errors, []);
  record("No uncaught browser errors");
} catch (e) {
  console.error(e);
  const open = pages.filter((p) => !p.isClosed());
  await open
    .at(-1)
    ?.screenshot({ path: "artifacts/exit-failure.png" })
    .catch(() => {});
  console.log(
    await open
      .at(-1)
      ?.evaluate(() => ({
        view: smash.view,
        room: !!smash.net.room,
        info: smash.engine.inspect(),
        dialogs: [...document.querySelectorAll("dialog[open]")].map(
          (d) => d.id,
        ),
        focus: document.activeElement?.id,
      }))
      .catch(() => null),
  );
  process.exitCode = 1;
} finally {
  await writeFile(
    "artifacts/exit-check.json",
    JSON.stringify({ checks, errors }, null, 2),
  );
  await browser.close();
}
