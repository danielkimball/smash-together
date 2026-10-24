import test from "node:test";
import assert from "node:assert/strict";
import { LocalPlayers } from "../public/js/local-players.js";
import { defaultProfile, BITS } from "../public/js/controls.js";
function setup(t) {
  const old = globalThis.localStorage;
  const data = new Map();
  globalThis.localStorage = {
    getItem: (key) => data.get(key),
    setItem: (key, value) => data.set(key, value),
  };
  t.after(() => {
    if (old) globalThis.localStorage = old;
    else delete globalThis.localStorage;
  });
  const pads = [0, 1].map((index) => ({
    index,
    id: "Xbox STANDARD GAMEPAD",
    connected: true,
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 18 }, () => ({ value: 0 })),
  }));
  const controls = {
    devices: () => pads.filter((p) => p.connected),
    pad: () => pads[0],
    id: () => pads[0].id,
    saved: {},
    keys: new Set(),
    profile: defaultProfile(),
    blocked: false,
  };
  return { pads, controls, party: new LocalPlayers(controls), data };
}
test("two identical controllers drive independent local players and cannot be assigned twice", (t) => {
  const { party, pads } = setup(t);
  party.ensure();
  const second = party.add();
  assert.equal(party.value(party.entries[0]), "pad:0");
  assert.equal(party.value(second), "pad:1");
  assert.throws(
    () => party.assign(second.key, "pad:0"),
    /different controller/,
  );
  pads[0].buttons[0].value = 1;
  pads[1].buttons[2].value = 1;
  assert.equal(party.sample().buttons, BITS.a);
  assert.equal(party.sample(second.key).buttons, BITS.b);
});
test("unplugging one identical pad never hands its controls to the remaining player", (t) => {
  const { party, pads } = setup(t);
  party.ensure();
  const second = party.add();
  pads[0].connected = false;
  pads[1].buttons[0].value = 1;
  assert.equal(party.sample().buttons, 0);
  assert.equal(party.sample(second.key).buttons, BITS.a);
  pads[0].connected = true;
  pads[1].connected = false;
  pads[0].buttons[2].value = 1;
  assert.equal(party.sample(second.key).buttons, 0);
  assert.equal(party.sample().buttons, BITS.b);
});
test("saved people and controller identity order survive changed browser indices", (t) => {
  const { party, pads, controls } = setup(t);
  party.ensure();
  const second = party.add();
  party.rename(second.key, "Partner");
  pads[0].index = 3;
  pads[1].index = 5;
  const restored = new LocalPlayers(controls);
  assert.equal(restored.value(restored.entries[0]), "pad:3");
  assert.equal(restored.value(restored.entries[1]), "pad:5");
  assert.equal(restored.roster()[0].name, "Partner");
  assert.equal(restored.roster()[0].key, second.key);
});
test("setup blocks every local controller and a removed person releases their input", (t) => {
  const { party, pads, controls } = setup(t);
  party.ensure();
  const second = party.add();
  pads[1].buttons[0].value = 1;
  controls.capture = { action: "a" };
  assert.equal(party.sample(second.key).buttons, 0);
  controls.capture = null;
  assert.equal(party.sample(second.key).buttons, BITS.a);
  party.remove(second.key);
  assert.equal(party.sample(second.key).buttons, 0);
  assert.equal(party.roster().length, 0);
});

test("mapping another controller does not give it the primary player's menu actions", (t) => {
  const { party, pads, controls } = setup(t);
  party.ensure();
  const second = party.add();
  controls.selected = "1";
  controls.blocked = true;
  pads[1].buttons[2].value = 1;
  assert.equal(party.sample("primary", { menu: true }).buttons, 0);
  assert.equal(party.sample(second.key, { menu: true }).buttons, BITS.b);
  assert.equal(party.sample(second.key).buttons, 0);
});
