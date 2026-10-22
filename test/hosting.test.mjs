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
  assert.deepEqual(requested, ["/smash-together/active-host.json"]);
  await assert.rejects(
    discoverHost("https://example.github.io/", async () => ({ ok: false })),
    /unavailable/,
  );
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
