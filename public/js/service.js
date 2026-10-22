// The public UI keeps one origin for browser-local ROMs/profiles. Only the
// signaling/relay address changes when the free Cloudflare tunnel rotates.
import { discoverHost } from "./host-record.js";
export const appBase = new URL("../", import.meta.url);
const hosted = appBase.hostname.endsWith(".github.io");
let server = hosted ? null : appBase.origin;
let checked = 0,
  pending;
export function assetURL(path) {
  return new URL(path.replace(/^\//, ""), appBase).href;
}
export async function serverOrigin(force = false) {
  if (!hosted) return server;
  if (!force && server && Date.now() - checked < 15000) return server;
  if (!pending)
    pending = (async () => {
      server = await discoverHost(appBase);
      checked = Date.now();
      return server;
    })().finally(() => {
      pending = null;
    });
  return pending;
}
export async function serviceFetch(path, options = {}) {
  const origin = await serverOrigin();
  try {
    return await fetch(new URL(path, origin), {
      ...options,
      signal: options.signal || AbortSignal.timeout(30000),
    });
  } catch (error) {
    if (!hosted) throw error;
    const next = await serverOrigin(true);
    if (next === origin) throw error;
    return fetch(new URL(path, next), {
      ...options,
      signal: options.signal || AbortSignal.timeout(30000),
    });
  }
}
export async function socketURL() {
  const url = new URL("/room", await serverOrigin());
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}
