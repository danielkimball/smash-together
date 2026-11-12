import test from "node:test";
import assert from "node:assert/strict";
import { discoverHost, parseHostRecord } from "../public/js/host-record.js";
import { assertPublisher } from "../scripts/host-ownership.mjs";
const primary = {
  version: 1,
  hostId: "ryker-windows",
  publisher: "widdlewyter",
  url: "https://primary-test.trycloudflare.com",
};
test("legacy backup publication cannot change the frontend's chosen backend", async () => {
  const requested = [];
  const url = await discoverHost(
    "https://danielkimball.github.io/smash-together/",
    async (target) => {
      requested.push(new URL(target).pathname);
      return {
        ok: true,
        json: async () =>
          target.includes("active-host.json")
            ? primary
            : { url: "https://old-dan.trycloudflare.com" },
      };
    },
  );
  assert.equal(url, primary.url);
  assert.deepEqual(requested, [
    "/danielkimball/smash-together/gh-pages/active-host.json",
  ]);
  await assert.rejects(
    discoverHost("https://example.github.io/", async () => ({ ok: false })),
    /unavailable/,
  );
});
test("tunnel rotation is discoverable before the Pages build publishes", async () => {
  const requests = [];
  const rotated = { ...primary, url: "https://rotated-test.trycloudflare.com" };
  const url = await discoverHost(
    "https://danielkimball.github.io/smash-together/",
    async (target, options) => {
      requests.push(target);
      assert.equal(options.cache, "no-store");
      assert.ok(new URL(target).searchParams.has("t"));
      return {
        ok: true,
        json: async () =>
          new URL(target).hostname === "raw.githubusercontent.com"
            ? rotated
            : primary,
      };
    },
  );
  assert.equal(url, rotated.url);
  assert.equal(requests.length, 1);
});
test("unavailable or invalid committed registry falls back to the Pages record", async () => {
  for (const failure of ["network", "http", "json", "invalid"]) {
    const requests = [];
    const url = await discoverHost(
      "https://danielkimball.github.io/smash-together/",
      async (target) => {
        const u = new URL(target);
        requests.push(u.origin + u.pathname);
        if (u.hostname === "raw.githubusercontent.com") {
          if (failure === "network") throw Error("Network unavailable");
          return {
            ok: failure !== "http",
            json: async () => {
              if (failure === "json") throw SyntaxError("Invalid JSON");
              return { ...primary, url: "https://untrusted.example" };
            },
          };
        }
        return { ok: true, json: async () => primary };
      },
    );
    assert.equal(url, primary.url);
    assert.deepEqual(requests, [
      "https://raw.githubusercontent.com/danielkimball/smash-together/gh-pages/active-host.json",
      "https://danielkimball.github.io/smash-together/active-host.json",
    ]);
  }
});
test("non-project origins keep their own registry and fail closed if unavailable", async () => {
  for (const base of [
    "https://example.com/game/",
    "https://example.github.io/",
  ]) {
    const requested = [];
    await assert.rejects(
      discoverHost(base, async (target) => {
        requested.push(new URL(target).origin);
        return { ok: false };
      }),
      /unavailable/,
    );
    assert.deepEqual(requested, [new URL(base).origin]);
  }
});
test("host records reject credentials, unsafe origins and malformed ownership", () => {
  for (const url of [
    "http://primary-test.trycloudflare.com",
    "https://example.com",
    "https://user:password@primary-test.trycloudflare.com",
    primary.url + "/bad",
    primary.url + "?redirect=x",
  ])
    assert.throws(() => parseHostRecord({ ...primary, url }));
  assert.throws(() => parseHostRecord({ url: primary.url }));
});
test("only the selected host/account can rotate; backup needs explicit promotion", () => {
  assert.doesNotThrow(() =>
    assertPublisher(primary, { hostId: primary.hostId }, primary.publisher),
  );
  assert.throws(
    () => assertPublisher(primary, { hostId: "dan-mac" }, "danielkimball"),
    /backup/,
  );
  assert.throws(
    () => assertPublisher(primary, { hostId: primary.hostId }, "danielkimball"),
    /backup/,
  );
  assert.throws(
    () => assertPublisher(null, { hostId: primary.hostId }, primary.publisher),
    /promote/,
  );
  assert.doesNotThrow(() =>
    assertPublisher(primary, { hostId: "dan-mac" }, "danielkimball", true),
  );
});
