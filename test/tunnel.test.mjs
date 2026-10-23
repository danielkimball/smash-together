import test from "node:test";
import assert from "node:assert/strict";
import { TunnelState } from "../scripts/tunnel-state.mjs";

test("revoked Quick Tunnel is recognized across log chunks even if process stays alive", () => {
  const state = new TunnelState();
  state.log("Visit https://example-game.trycloudflare.com\n");
  assert.equal(state.url, "https://example-game.trycloudflare.com");
  assert.equal(state.registered, false);
  state.log("INF Registered tunnel connection connIndex=0\n");
  assert.equal(state.registered, true);
  state.log('ERR Register tunnel error error="Unauthorized: Tunnel');
  assert.equal(state.revoked, false);
  state.log(' not found"\n');
  assert.equal(state.revoked, true);
});
test("health recovery tolerates transient outages and recycles only after consecutive failures", () => {
  const state = new TunnelState();
  assert.equal(state.health(false), false);
  assert.equal(state.health(false), false);
  assert.equal(state.health(true), false);
  assert.equal(state.failures, 0);
  assert.equal(state.health(false), false);
  assert.equal(state.health(false), false);
  assert.equal(state.health(false), true);
});

test("tunnel telemetry reports actual negotiation and automatic fallback across log chunks", () => {
  const state = new TunnelState();
  state.log("INF Initial protocol quic\n");
  assert.equal(state.protocol, null);
  state.log("INF Registered tunnel connection connIndex=0 protocol=qui");
  assert.equal(state.protocol, null);
  state.log("c\n");
  assert.equal(state.protocol, "quic");
  state.log("INF Switching to fallback protocol http2\n");
  assert.equal(
    state.protocol,
    "quic",
    "selection alone is not a successful connection",
  );
  state.log("INF Registered tunnel connection connIndex=0 protocol=http2\n");
  assert.equal(state.protocol, "http2");
});
