export function browserHelpers(browser, { url, pages, errors }) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  async function scene(p, n) {
    await p.waitForFunction(
      (n) =>
        smash.engine.loaded &&
        document.getElementById("busy").hidden &&
        smash.engine.inspect().scene === n,
      n,
      { timeout: 90000 },
    );
  }
  async function pad(p, index, ms = 130) {
    await p.evaluate((index) => {
      qaPad.buttons[index] = { value: 1, pressed: true };
    }, index);
    await wait(ms);
    await p.evaluate((index) => {
      qaPad.buttons[index] = { value: 0, pressed: false };
    }, index);
    await wait(220);
  }
  async function act(p, keys, count = 6, settle = 30) {
    await p.evaluate(
      ({ keys, count, settle }) =>
        new Promise((resolve, reject) => {
          const c = smash.controls,
            original = c.sample.bind(c);
          const timer = setTimeout(() => {
            c.sample = original;
            reject(Error("Controller input timed out"));
          }, 60000);
          let first = null,
            localFrame = 0;
          const duration =
            count + Math.max(settle, (smash.net.personalDelay || 0) + 8);
          c.sample = () => {
            const target = smash.net.running
              ? Math.max(0, smash.net.serverFrame + 1) + smash.net.personalDelay
              : localFrame++;
            first ??= target;
            const elapsed = target - first;
            if (elapsed < count) {
              c.keys = new Set(keys);
              const input = original();
              c.keys.clear();
              return input;
            }
            if (elapsed < duration) return { buttons: 0, x: 0, y: 0 };
            c.sample = original;
            clearTimeout(timer);
            resolve();
            return original();
          };
        }),
      { keys, count, settle },
    );
    const scheduled = await p.evaluate(() =>
      smash.net.running ? smash.net.lastSample : null,
    );
    if (scheduled !== null)
      await p.waitForFunction((f) => smash.net.frame > f, scheduled, {
        timeout: 30000,
      });
  }
  async function create(p) {
    await p.locator("#create-open").click();
    await p.locator("#create-room").click();
    await scene(p, 9);
    if (await p.locator('[data-native-input="a"]').isVisible())
      await p.locator('[data-native-input="a"]').click();
    else await p.locator('[data-touch="a"]').tap();
    await p.waitForFunction(() => smash.net.running, null, { timeout: 90000 });
    await scene(p, 16);
  }
  async function browse(p) {
    await p.locator("#native-online").click();
    await p.mouse.move(0, 0);
    await p.waitForFunction(() => smash.view === "browse");
  }
  async function boot(p) {
    await p.waitForFunction(() => window.smash);
    await p.waitForFunction(
      () => smash.engine.loaded && document.getElementById("busy").hidden,
      null,
      { timeout: 90000 },
    );
    // Ordinary Start presses skip the ROM's opening/title, without replaying
    // or accelerating native frames. Tests need not watch the complete movie.
    for (let i = 0; i < 8; i++) {
      if (
        (await p.locator("#native-menu").isVisible()) ||
        (await p.evaluate(() => !!smash.net.room))
      )
        break;
      await p.locator("#power-on").click();
      await p.mouse.move(0, 0);
      await wait(1400);
    }
    await p.waitForFunction(
      () => !document.getElementById("native-menu").hidden || !!smash.net.room,
    );
    if (!(await p.evaluate(() => !!smash.net.room))) await scene(p, 7);
  }
  async function openPage(mobile = false) {
    const c = await browser.newContext({
      viewport: mobile
        ? { width: 390, height: 844 }
        : { width: 1280, height: 900 },
      isMobile: mobile,
      hasTouch: mobile,
      permissions: ["microphone"],
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
    await p.goto(url);
    await boot(p);
    return p;
  }
  async function clickNative(p, x, y) {
    await wait(300);
    const b = await p.locator("#canvas").boundingBox();
    const ratio = await p
      .locator("#canvas")
      .evaluate((c) => c.width / c.height);
    const w = Math.min(b.width, b.height * ratio),
      h = w / ratio;
    const px = b.x + (b.width - w) / 2 + (w * x) / 320,
      py = b.y + (b.height - h) / 2 + (h * y) / 240;
    await p.mouse.click(px, py);
    await p.mouse.move(0, 0);
    await wait(900);
  }
  async function join(p, token) {
    await browse(p);
    await p.evaluate(
      (token) =>
        smash.net.connect({ token, name: "QA Guest", controller: "Keyboard" }),
      token,
    );
    await p.waitForFunction(() => smash.net.running, null, { timeout: 90000 });
  }
  return {
    wait,
    scene,
    pad,
    act,
    create,
    browse,
    boot,
    openPage,
    clickNative,
    join,
  };
}
