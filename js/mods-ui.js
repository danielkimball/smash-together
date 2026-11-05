// Mods panel, install/invitation links and the cartridge-per-room rule.
// A tab runs one cartridge until reload: the host's enabled packs when
// hosting, or the room's packs when joining. Switching reloads the page.
import {
  ModLibrary,
  patchCartridge,
  modsSignature,
  parseRefs,
  formatRefs,
  sessionCartridge,
  setSessionCartridge,
} from "./mods.js";
import { assetURL, appBase } from "./service.js";

async function fetchSealed(id) {
  const response = await fetch(assetURL(`mods/${id}.json`), {
    cache: "no-cache",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw Error("That mod pack is not available.");
  return response.json();
}
const names = (packs) => packs.map((p) => p.name).join(", ");

export class ModsUI {
  constructor({ engine, romSha1, toast, busy, open, $ }) {
    Object.assign(this, { engine, toast, busy, $ });
    this.openDialog = open;
    this.library = new ModLibrary({ romSha1, fetchSealed });
    engine.modPacks = [];
    engine.modsTag = "";
    this.installing = this.readLink();
    window.addEventListener("hashchange", () => {
      this.installing = this.readLink();
    });
    $("mods-install-form").onsubmit = (event) => {
      event.preventDefault();
      this.installFrom($("mods-link").value);
    };
    $("mods-restart").onclick = () =>
      this.restart("Starting the game with your mods…");
    document
      .querySelectorAll("[data-mods]")
      .forEach((button) => (button.onclick = () => this.open()));
  }
  get running() {
    return this.engine.modPacks;
  }
  // #mods=… installs. #room=…&mods=… or #join=…&mods=… is an invitation:
  // that room's cartridge for this tab only, never installed or enabled.
  readLink() {
    const params = new URLSearchParams(location.hash.slice(1));
    if (!params.has("mods")) return Promise.resolve();
    const value = params.get("mods");
    if (params.has("room") || params.has("join")) {
      try {
        setSessionCartridge(value === "none" ? [] : parseRefs(value));
      } catch (error) {
        this.toast(error.message);
      }
      return Promise.resolve();
    }
    history.replaceState(null, "", location.pathname + location.search);
    return this.installFrom(value, { quiet: true });
  }
  async installFrom(value, { quiet = false } = {}) {
    try {
      const link = String(value).trim();
      const refs = parseRefs(
        link.includes("mods=")
          ? new URLSearchParams(link.split("#")[1] || link).get("mods")
          : link,
      );
      if (!refs.length) throw Error("Paste a mod install link.");
      const packs = [];
      for (const ref of refs) packs.push(await this.library.install(ref));
      this.$("mods-link").value = "";
      this.toast(
        `${names(packs)} installed.` +
          (this.engine.loaded ? " Restart the game to use it." : ""),
      );
      if (this.engine.loaded || !quiet) this.open();
    } catch (error) {
      this.toast(error.message);
    }
  }
  async bootPacks() {
    await this.installing;
    const refs =
      sessionCartridge() ??
      this.library.enabled().map(({ id, key }) => ({ id, key }));
    const packs = [];
    for (const ref of refs)
      try {
        packs.push(await this.library.open(ref));
      } catch (error) {
        this.toast(`A mod pack could not load: ${error.message}`);
      }
    return packs;
  }
  // Called once, before the emulator starts. The verified original stays in
  // browser storage; only this in-memory copy is modified.
  async prepare(rom) {
    const packs = await this.bootPacks();
    if (packs.length)
      try {
        const bytes = await patchCartridge(rom, packs);
        this.engine.modPacks = packs;
        this.engine.modsTag = await modsSignature(packs);
        return bytes;
      } catch (error) {
        this.toast(`Mods are off for this game: ${error.message}`);
      }
    this.engine.modPacks = [];
    this.engine.modsTag = "";
    return rom;
  }
  restart(detail) {
    setSessionCartridge(null);
    this.busy("Restarting your game", detail);
    history.replaceState(null, "", location.pathname + location.search);
    location.reload();
  }
  // Rooms you create always run your own enabled packs.
  async ensureHosting() {
    const enabled = this.library.enabled();
    if (!this.engine.loaded) {
      setSessionCartridge(null);
      return true;
    }
    if ((await modsSignature(enabled)) === this.engine.modsTag) {
      setSessionCartridge(null);
      return true;
    }
    this.restart(
      enabled.length
        ? `Turning on ${names(enabled)} for your room…`
        : "Turning mods off for your room…",
    );
    return false;
  }
  // mods: [{id, name, hash}] from the server; refs: [{id, key}] from a link.
  async ensureRoom({ mods = null, refs = null, intent }) {
    if (!mods && !refs) return true;
    if (
      mods &&
      this.engine.loaded &&
      (await modsSignature(mods)) === this.engine.modsTag
    )
      return true;
    let keys = refs;
    if (!keys) {
      const session = sessionCartridge() || [];
      keys = mods.map((m) => ({
        id: m.id,
        key:
          session.find((r) => r.id === m.id)?.key ||
          this.library.find(m.id)?.key,
      }));
      const missing = mods.filter((m, i) => !keys[i].key);
      if (missing.length)
        throw Error(
          `This room uses ${names(missing)} mods. Ask the host for their invitation link.`,
        );
    }
    const packs = [];
    for (const ref of keys) packs.push(await this.library.open(ref));
    for (const [i, m] of (mods || []).entries())
      if (packs[i].hash !== m.hash)
        throw Error(
          `${m.name} changed since this room opened. Ask everyone to reload the page.`,
        );
    if (
      this.engine.loaded &&
      (await modsSignature(packs)) === this.engine.modsTag
    )
      return true;
    setSessionCartridge(keys);
    if (!this.engine.loaded) return true;
    this.busy(
      "Restarting your game",
      packs.length
        ? `Loading ${names(packs)} for this room…`
        : "This room plays the original game…",
    );
    // Replace the address without a hashchange, then restart this tab.
    history.replaceState(
      null,
      "",
      `${location.pathname}${location.search}#${intent}&mods=${keys.length ? formatRefs(keys) : "none"}`,
    );
    location.reload();
    return false;
  }
  inviteSuffix() {
    return `&mods=${this.running.length ? formatRefs(this.running) : "none"}`;
  }
  roomInfo() {
    return this.running.map(({ id, name, hash }) => ({ id, name, hash }));
  }
  installLink(pack) {
    return `${appBase.href}#mods=${pack.id}.${pack.key}`;
  }
  open() {
    this.render();
    this.openDialog("mods-dialog");
  }
  render() {
    const $ = this.$,
      packs = this.library.list();
    $("mods-running").textContent = !this.engine.loaded
      ? "Mods load when your game starts."
      : this.running.length
        ? `This game is running ${names(this.running)}.`
        : "This game is running the original cartridge.";
    $("mods-empty").hidden = packs.length > 0;
    $("mods-list").replaceChildren(
      ...packs.map((pack) => {
        const item = document.createElement("li");
        item.className = "mod-pack";
        const toggle = document.createElement("label");
        toggle.className = "checkbox-label mod-toggle";
        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = pack.enabled;
        box.onchange = () => {
          this.library.setEnabled(pack.id, box.checked);
          this.render();
        };
        const title = document.createElement("strong");
        title.textContent = pack.name;
        toggle.append(box, title);
        const list = document.createElement("small");
        list.textContent = pack.mods.map((m) => m.name).join(" · ");
        const actions = document.createElement("div");
        actions.className = "mod-actions";
        const copy = document.createElement("button");
        copy.type = "button";
        copy.textContent = "Copy install link";
        copy.onclick = async () => {
          try {
            await navigator.clipboard.writeText(this.installLink(pack));
            copy.textContent = "✓ Copied";
          } catch {
            $("mods-link").value = this.installLink(pack);
            $("mods-link").select();
            copy.textContent = "Select and copy below";
          }
        };
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "quiet";
        remove.textContent = "Remove";
        remove.onclick = () => {
          this.library.remove(pack.id);
          this.render();
        };
        actions.append(copy, remove);
        item.append(toggle, list, actions);
        return item;
      }),
    );
    this.updateRestart();
  }
  async updateRestart() {
    const wanted = await modsSignature(this.library.enabled());
    const stale = this.engine.loaded && wanted !== this.engine.modsTag;
    this.$("mods-restart").hidden = !stale || !!this.inRoom?.();
    this.$("mods-room-note").hidden = !stale || !this.inRoom?.();
  }
}
