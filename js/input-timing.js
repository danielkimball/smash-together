// A short controller interruption is not evidence of a permanently slow link.
// Only packets actually submitted for a missed deadline can grow the margin.
export class InputTiming {
  constructor(now = () => performance.now()) {
    this.now = now;
    this.samples = [];
    this.reset();
  }
  reset() {
    this.extra = 0;
    this.changed = this.now();
    this.recoverUntil = 0;
  }
  interrupt() {
    this.extra = 0;
    this.changed = this.now();
    this.recoverUntil = this.now() + 500;
  }
  recordRTT(ms) {
    if (!Number.isFinite(ms) || ms < 0 || ms > 10000) return;
    this.samples.push(ms);
    if (this.samples.length > 9) this.samples.shift();
  }
  get rtt() {
    const sorted = [...this.samples].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] || 0;
  }
  lead(delay, fallbackRTT = 0) {
    const base = Math.max(
      delay,
      Math.ceil((this.rtt || fallbackRTT) / (1000 / 60)) + 2,
    );
    return Math.min(45, base + this.extra);
  }
  feedback(late, sentAt) {
    const now = this.now();
    if (
      !Number.isFinite(sentAt) ||
      now < this.recoverUntil ||
      now - sentAt > 1000
    )
      return;
    if (late && now - this.changed >= 500) {
      // Rate-limit adaptation: a burst of stale frames must not add a frame
      // of latency for every packet in the burst. Keep jitter separate from RTT.
      this.extra = Math.min(4, this.extra + 1);
      this.changed = now;
    } else if (!late && now - this.changed >= 1000) {
      this.extra = Math.max(0, this.extra - 1);
      this.changed = now;
    }
  }
}
