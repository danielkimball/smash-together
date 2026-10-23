import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";

// Strict allowlist: never persist microphone data, inputs, ROM/state bytes,
// addresses, invitation/reconnect tokens, player names or free-form text.
export const metricLimits = {
  fps: 240,
  relayRTT: 10000,
  typicalRTT: 10000,
  inputBuffer: 45,
  inputAckSamples: 256,
  inputAckAvgMs: 60000,
  inputAckP95Ms: 60000,
  backlog: 1000,
  frameGapMs: 60000,
  stepAvgMs: 10000,
  stepMaxMs: 10000,
  ownLateInputs: 1e9,
  repairs: 1e9,
  gameQueuedBytes: 24e6,
  mediaQueuedBytes: 24e6,
  voiceSent: 1e9,
  voiceDropped: 1e9,
  frame: 1e12,
  mediaConnected: 1,
  voiceActive: 1,
  longTasks: 1e9,
};
export function cleanMetrics(value) {
  const result = {};
  for (const [key, max] of Object.entries(metricLimits)) {
    const n = value?.[key];
    if (typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= max)
      result[key] = Math.round(n * 10) / 10;
  }
  return result;
}
export function performanceLogger(file, limit = 5 * 1024 * 1024) {
  let pending = Promise.resolve();
  return (sample) => {
    pending = pending
      .then(async () => {
        await mkdir(path.dirname(file), { recursive: true });
        if ((await stat(file).catch(() => null))?.size >= limit)
          await rename(file, file + ".1");
        await appendFile(file, JSON.stringify(sample) + "\n");
      })
      .catch((error) =>
        console.warn(
          "Performance log unavailable:",
          error.code || "write failed",
        ),
      );
    return pending;
  };
}
