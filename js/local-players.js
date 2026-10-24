import {
  controllerKey,
  defaultProfile,
  profileKind,
  evaluate,
} from "./controls.js";
const neutral = () => ({ buttons: 0, x: 0, y: 0 });
export class LocalPlayers extends EventTarget {
  constructor(controls) {
    super();
    this.controls = controls;
    this.bound = new Map();
    try {
      const saved = JSON.parse(localStorage.getItem("smash.localPlayers.v1"));
      if (
        Array.isArray(saved) &&
        saved.length &&
        saved.length <= 4 &&
        saved[0].key === "primary" &&
        new Set(saved.map((p) => p.key)).size === saved.length &&
        saved.every(
          (p) =>
            /^[\w-]{1,40}$/.test(p.key) &&
            p.device &&
            (p.device.kind === "keyboard" ||
              (typeof p.device.id === "string" &&
                Number.isInteger(p.device.ordinal))),
        )
      )
        this.entries = saved;
    } catch {}
  }
  ensure() {
    if (!this.entries) {
      this.entries = [
        { key: "primary", name: "You", device: { kind: "keyboard" } },
      ];
      if (this.controls.pad())
        this.assign("primary", `pad:${this.controls.pad().index}`, false);
    }
    return this.entries;
  }
  options() {
    return [
      { value: "keyboard", label: "Keyboard" },
      ...this.controls.devices().map((p) => ({
        value: `pad:${p.index}`,
        label: `Controller ${p.index + 1} · ${p.id}`,
      })),
    ];
  }
  pad(entry) {
    if (entry.device.kind === "keyboard") return null;
    const pads = this.controls.devices();
    if (!this.bound.has(entry.key)) {
      const match = pads.filter((p) => controllerKey(p.id) === entry.device.id)[
        entry.device.ordinal
      ];
      if (
        match &&
        ![...this.bound.values()].some((b) => b.index === match.index)
      )
        this.bound.set(entry.key, {
          index: match.index,
          id: controllerKey(match.id),
        });
    }
    const binding = this.bound.get(entry.key);
    // A disappearing pad becomes neutral. Never silently give its player a
    // different still-connected controller, including identical USB adapters.
    return (
      pads.find(
        (p) => p.index === binding?.index && controllerKey(p.id) === binding.id,
      ) || null
    );
  }
  value(entry) {
    if (entry.device.kind === "keyboard") return "keyboard";
    const pad = this.pad(entry);
    return pad ? `pad:${pad.index}` : `missing:${entry.key}`;
  }
  changed() {
    localStorage.setItem("smash.localPlayers.v1", JSON.stringify(this.entries));
    this.dispatchEvent(new Event("change"));
  }
  assign(key, value, save = true) {
    this.ensure();
    const entry = this.entries.find((p) => p.key === key);
    if (
      !entry ||
      this.entries.some((p) => p !== entry && this.value(p) === value)
    )
      throw Error("Each player needs a different controller or the keyboard.");
    if (value === "keyboard") {
      entry.device = { kind: "keyboard" };
      this.bound.delete(key);
    } else {
      const pad = this.controls
        .devices()
        .find((p) => `pad:${p.index}` === value);
      if (!pad) throw Error("Connect the controller and press a button first.");
      const id = controllerKey(pad.id);
      entry.device = {
        kind: "gamepad",
        id,
        ordinal: this.controls
          .devices()
          .filter((p) => controllerKey(p.id) === id)
          .indexOf(pad),
      };
      this.bound.set(key, { index: pad.index, id });
    }
    if (save) this.changed();
  }
  add() {
    this.ensure();
    if (this.entries.length >= 4)
      throw Error("Up to four people can play on this device.");
    const option = this.options()
      .sort(
        (a, b) =>
          Number(a.value === "keyboard") - Number(b.value === "keyboard"),
      )
      .find((o) => !this.entries.some((p) => this.value(p) === o.value));
    if (!option)
      throw Error(
        "Connect another controller and press a button, then add the player.",
      );
    const entry = {
      key: crypto.randomUUID(),
      name: `Player ${this.entries.length + 1}`,
      device: {},
    };
    this.entries.push(entry);
    this.assign(entry.key, option.value);
    return entry;
  }
  remove(key) {
    if (key === "primary") return;
    this.entries = this.ensure().filter((p) => p.key !== key);
    this.bound.delete(key);
    this.changed();
  }
  rename(key, name) {
    const entry = this.ensure().find((p) => p.key === key);
    if (!entry || key === "primary") return;
    entry.name = String(name).trim().slice(0, 30) || "Player";
    this.changed();
  }
  controller(entry) {
    return entry.device.kind === "keyboard"
      ? "Keyboard"
      : this.pad(entry)?.id || "Controller disconnected";
  }
  roster() {
    return this.ensure()
      .slice(1)
      .map((p) => ({
        key: p.key,
        name: p.name,
        controller: this.controller(p),
      }));
  }
  sample(key = "primary", { menu = false } = {}) {
    const c = this.controls;
    if ((!menu && c.blocked) || c.capture) return neutral();
    const entry = this.ensure().find((p) => p.key === key);
    if (!entry) return neutral();
    const pad = this.pad(entry);
    if (entry.device.kind !== "keyboard" && !pad) return neutral();
    if (
      !menu &&
      key === "primary" &&
      typeof c.sample === "function" &&
      (pad ? String(pad.index) === c.selected : c.selected === "keyboard")
    )
      return c.sample();
    const id = pad?.id || "keyboard";
    const profile =
      c.id() === id
        ? c.profile
        : c.saved[controllerKey(id)] ||
          c.saved[id] ||
          defaultProfile(profileKind(id));
    const input = evaluate(profile, pad, c.keys);
    if (key === "primary") {
      const touch = c.touch?.sample();
      if (touch) {
        input.buttons |= touch.buttons;
        if (touch.analog) {
          input.x = touch.x;
          input.y = touch.y;
        }
      }
    }
    if (!menu && (input.buttons & (8192 | 4096 | 16)) === (8192 | 4096 | 16))
      return neutral();
    return input;
  }
}

export function localPlayersPanel(party, net, open, toast, name) {
  const $ = (id) => document.getElementById(id);
  let nameKeys;
  const renderLobbyNames = () => {
    // Showing the lobby must not choose a controller before the player has
    // connected one. Only render people already configured on this device.
    const entries = party.entries?.slice(1) || [];
    const list = $("lobby-local-names");
    const keys = entries.map((p) => p.key).join("|");
    if (keys !== nameKeys) {
      nameKeys = keys;
      list.replaceChildren(
        ...entries.map((entry, index) => {
          const label = document.createElement("label");
          label.className = "lobby-local-name";
          const caption = document.createElement("span");
          caption.textContent = `P${index + 2} · Change name`;
          const input = document.createElement("input");
          input.type = "text";
          input.maxLength = 30;
          input.autocomplete = "off";
          input.dataset.localName = entry.key;
          input.setAttribute("aria-label", `Player ${index + 2} name`);
          input.oninput = () => party.rename(entry.key, input.value);
          input.onchange = () => {
            input.value = entry.name;
          };
          label.append(caption, input);
          return label;
        }),
      );
    }
    for (const input of list.querySelectorAll("input")) {
      const entry = entries.find((p) => p.key === input.dataset.localName);
      if (input !== document.activeElement) input.value = entry.name;
      input.title = entry.name;
    }
    list.hidden = !entries.length;
    $("add-screen-player-copy").textContent =
      entries.length === 3
        ? "Manage players on this screen"
        : "Add additional players on this screen";
  };
  const render = () => {
    const entries = party.ensure();
    $("local-players-list").replaceChildren(
      ...entries.map((entry, index) => {
        const row = document.createElement("div");
        row.className = "local-player-row";
        row.dataset.localPlayer = entry.key;
        const label = document.createElement("label");
        label.textContent = `Player ${index + 1} on this device`;
        const input = document.createElement("input");
        input.value = index ? entry.name : name();
        input.maxLength = 30;
        input.readOnly = !index;
        input.setAttribute("aria-label", `Local player ${index + 1} name`);
        input.onchange = () => party.rename(entry.key, input.value);
        label.append(input);
        const device = document.createElement("select");
        device.setAttribute(
          "aria-label",
          `Local player ${index + 1} controller`,
        );
        const value = party.value(entry);
        for (const option of party.options()) {
          const item = new Option(option.label, option.value);
          item.disabled = entries.some(
            (p) => p !== entry && party.value(p) === option.value,
          );
          device.append(item);
        }
        if (value.startsWith("missing:"))
          device.append(
            new Option(
              "Disconnected · reconnect or choose a controller",
              value,
            ),
          );
        device.value = value;
        device.onchange = () => {
          try {
            party.assign(entry.key, device.value);
          } catch (e) {
            toast(e.message);
            render();
          }
        };
        const map = document.createElement("button");
        map.textContent = "Map buttons";
        map.disabled = value.startsWith("missing:");
        map.onclick = () => {
          party.controls.select(value === "keyboard" ? value : value.slice(4));
          const resume = $("local-players-dialog").resumeOnClose;
          $("local-players-dialog").resumeOnClose = false;
          $("local-players-dialog").close();
          open("controls-dialog");
          $("controls-dialog").resumeOnClose ||= resume;
        };
        row.append(label, device, map);
        if (index) {
          const remove = document.createElement("button");
          remove.textContent = "Remove player";
          remove.className = "quiet";
          remove.onclick = () => party.remove(entry.key);
          row.append(remove);
        }
        const status = document.createElement("small");
        status.dataset.localStatus = entry.key;
        const member = net.localMembers.find(
          (p) => (p.localKey || "primary") === entry.key,
        );
        status.textContent = net.room
          ? member
            ? member.slot >= 0
              ? `Room Player ${member.slot + 1}`
              : "Waiting to play next round"
            : "Not yet in this room"
          : "Joins with you when you create or enter a room";
        row.append(status);
        return row;
      }),
    );
    $("local-player-add").disabled =
      entries.length >= 4 ||
      (net.room && net.connected.length >= net.room.capacity);
  };
  document.querySelectorAll("[data-local-players]").forEach((button) => {
    button.onclick = () => {
      render();
      open("local-players-dialog");
    };
  });
  $("local-player-add").onclick = () => {
    try {
      party.add();
    } catch (e) {
      toast(e.message);
    }
  };
  let timer;
  party.addEventListener("change", () => {
    if ($("local-players-dialog").open) render();
    renderLobbyNames();
    clearTimeout(timer);
    if (net.room)
      timer = setTimeout(() => {
        net.send({ type: "local-players", locals: party.roster() });
        net.send({
          type: "profile",
          controller: party.controller(party.ensure()[0]),
        });
      }, 150);
  });
  party.controls.addEventListener("devices", () => {
    if ($("local-players-dialog").open) render();
  });
  net.addEventListener("change", () => {
    if (!$("local-players-dialog").open) return;
    for (const status of $("local-players-list").querySelectorAll(
      "[data-local-status]",
    )) {
      const member = net.localMembers.find(
        (p) => (p.localKey || "primary") === status.dataset.localStatus,
      );
      status.textContent = !net.room
        ? "Joins with you when you create or enter a room"
        : !member
          ? "Not yet in this room"
          : member.slot >= 0
            ? `Room Player ${member.slot + 1}`
            : "Waiting to play next round";
    }
    $("local-player-add").disabled =
      party.entries.length >= 4 ||
      (net.room && net.connected.length >= net.room.capacity);
  });
  renderLobbyNames();
  return render;
}
