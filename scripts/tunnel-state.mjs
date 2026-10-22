// cloudflared can keep retrying a revoked Quick Tunnel forever without exiting.
// Detect that condition even when its log message arrives in separate chunks.
export class TunnelState {
  buffer = "";
  url = null;
  registered = false;
  revoked = false;
  failures = 0;
  log(chunk) {
    this.buffer = (this.buffer + chunk).slice(-16000);
    this.url ||=
      this.buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0] ||
      null;
    this.registered ||= /Registered tunnel connection/.test(this.buffer);
    this.revoked ||= /Unauthorized:\s*Tunnel not found/i.test(this.buffer);
  }
  health(ok) {
    this.failures = ok ? 0 : this.failures + 1;
    return this.failures >= 3;
  }
}
