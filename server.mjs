import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { WebSocketServer } from "ws";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, "public");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".wasm": "application/wasm",
  ".zip": "application/zip",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".gz": "application/gzip",
};
const TOKEN = /^[a-f0-9]{36}$/;
const send = (s, m) => {
  if (s?.readyState === 1) s.send(JSON.stringify(m));
};

export function createApp({ host = "127.0.0.1", port = 8787 } = {}) {
  const rooms = new Map();
  const server = http.createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Permissions-Policy",
      "gamepad=(self), microphone=(), camera=()",
    );
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'; style-src 'self'; img-src 'self' data:; connect-src 'self' ws: wss:; worker-src 'self' blob:; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    try {
      if (!["GET", "HEAD"].includes(req.method)) {
        res.writeHead(405);
        return res.end();
      }
      const url = new URL(req.url, "http://local");
      if (url.pathname === "/health" || url.pathname === "/api/status") {
        let shareUrl = null;
        try {
          shareUrl = JSON.parse(
            await readFile(path.join(ROOT, ".local/share.json"), "utf8"),
          ).url;
        } catch {}
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Content-Type", "application/json");
        return res.end(
          JSON.stringify({ ok: true, version: "1.0.0", shareUrl }),
        );
      }
      const decoded = decodeURIComponent(url.pathname);
      const file = path.resolve(
        PUBLIC,
        "." + (decoded === "/" ? "/index.html" : decoded),
      );
      const ext = path.extname(file);
      if (!file.startsWith(PUBLIC + path.sep) || !MIME[ext]) {
        res.writeHead(404);
        return res.end("Not found");
      }
      const info = await stat(file);
      if (!info.isFile()) {
        res.writeHead(404);
        return res.end("Not found");
      }
      res.setHeader("Content-Type", MIME[ext]);
      res.setHeader(
        "Cache-Control",
        file.includes("/engine/") ? "public, max-age=86400" : "no-cache",
      );
      res.setHeader("Content-Length", info.size);
      res.end(req.method === "HEAD" ? undefined : await readFile(file));
    } catch {
      res.writeHead(404);
      res.end("Not found");
    }
  });
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 20 * 1024 * 1024,
    perMessageDeflate: false,
  });
  server.on("upgrade", (req, socket, head) => {
    let valid = req.url === "/room";
    if (req.headers.origin) {
      try {
        valid &&= new URL(req.headers.origin).host === req.headers.host;
      } catch {
        valid = false;
      }
    }
    if (!valid || wss.clients.size >= 64) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
  });
  wss.on("connection", (socket) => {
    socket.alive = true;
    socket.meta = null;
    let windowStart = Date.now(),
      messages = 0;
    const joinTimeout = setTimeout(() => {
      if (!socket.meta) socket.close(1008, "Join timeout");
    }, 20000);
    socket.on("pong", () => (socket.alive = true));
    socket.on("error", () => {});
    socket.on("message", (data, binary) => {
      if (Date.now() - windowStart > 1000) {
        windowStart = Date.now();
        messages = 0;
      }
      if (++messages > 600) return socket.close(1008, "Rate limit");
      const fail = (message) => send(socket, { type: "error", message });
      const meta = socket.meta,
        room = meta && rooms.get(meta.token);
      const other = room && (meta.player === 0 ? room.guest : room.host);
      if (binary) {
        if (room && meta.player === 0 && !other) return; // Snapshot already in flight when a guest left.
        if (!room || meta.player !== 0 || !other || data.length < 8)
          return fail("A host and guest are required to sync.");
        if (other.bufferedAmount > 24 * 1024 * 1024)
          return socket.close(1008, "Connection too slow");
        return other.send(data, { binary: true });
      }
      if (data.length > 16384) return socket.close(1009, "Message too large");
      let m;
      try {
        m = JSON.parse(data.toString());
      } catch {
        return fail("Invalid message");
      }
      if (!m || typeof m !== "object") return fail("Invalid message");
      if (m.type === "ping") return send(socket, { type: "pong", id: m.id });
      if (m.type === "create" || m.type === "join") {
        if (meta) return fail("Already in a room");
        if (
          typeof m.rom !== "string" ||
          !/^[a-f0-9]{40}$/.test(m.rom) ||
          typeof m.build !== "string" ||
          m.build.length > 120
        )
          return fail("Load a supported ROM first.");
        const name =
          String(m.name || "Player")
            .trim()
            .slice(0, 30) || "Player";
        if (m.type === "create") {
          if (rooms.size >= 32) return fail("Server is full. Try again later.");
          const token = randomBytes(18).toString("hex");
          const delay = Math.max(
            2,
            Math.min(15, Number.isInteger(m.delay) ? m.delay : 6),
          );
          rooms.set(token, {
            host: socket,
            guest: null,
            rom: m.rom,
            build: m.build,
            delay,
            name,
          });
          socket.meta = { token, player: 0, name };
          send(socket, { type: "joined", token, player: 0, delay });
        } else {
          if (!TOKEN.test(m.token || ""))
            return fail("That invitation is invalid.");
          const r = rooms.get(m.token);
          if (!r || r.host.readyState !== 1)
            return fail(
              "This room has closed. Ask the host for a new invitation.",
            );
          if (r.guest) return fail("This room already has two players.");
          if (r.rom !== m.rom || r.build !== m.build)
            return fail(
              "Both players need the same ROM and game build. Reload both pages and try again.",
            );
          socket.meta = { token: m.token, player: 1, name };
          r.guest = socket;
          send(socket, {
            type: "joined",
            token: m.token,
            player: 1,
            delay: r.delay,
            peer: r.name,
          });
          send(r.host, { type: "peer", name });
          send(socket, { type: "peer", name: r.name });
        }
        clearTimeout(joinTimeout);
        return;
      }
      if (!room) return fail("Join a room first.");
      if (!other) return; // Late input/ICE/heartbeat packets after disconnect are harmless.
      if (m.type === "signal") {
        if (!m.signal || JSON.stringify(m.signal).length > 12000)
          return fail("Invalid connection signal");
        return send(other, { type: "signal", signal: m.signal });
      }
      if (m.type === "game") {
        if (!m.payload || typeof m.payload !== "object")
          return fail("Invalid game packet");
        const allowed = [
          "input",
          "hash",
          "start",
          "ready",
          "sync",
          "pause",
          "resume",
          "resync",
          "echo",
          "echo-reply",
        ];
        if (!allowed.includes(m.payload.type))
          return fail("Unknown game packet");
        if (
          ["start", "sync", "resume"].includes(m.payload.type) &&
          meta.player !== 0
        )
          return fail("Only the host can start or synchronize.");
        if (other.bufferedAmount > 24 * 1024 * 1024)
          return socket.close(1008, "Connection too slow");
        send(other, { type: "game", payload: m.payload });
      }
    });
    socket.on("close", () => {
      clearTimeout(joinTimeout);
      const meta = socket.meta;
      if (!meta) return;
      const room = rooms.get(meta.token);
      if (!room) return;
      if (meta.player === 0) {
        send(room.guest, {
          type: "closed",
          message: "The host left. Ask for a new invitation.",
        });
        if (room.guest) {
          room.guest.meta = null;
          room.guest.close(1000);
        }
        rooms.delete(meta.token);
      } else {
        room.guest = null;
        send(room.host, {
          type: "left",
          message:
            "Your opponent disconnected. The game is paused; they can rejoin this link.",
        });
      }
    });
  });
  const heartbeat = setInterval(() => {
    for (const s of wss.clients) {
      if (!s.alive) s.terminate();
      else {
        s.alive = false;
        s.ping();
      }
    }
  }, 15000);
  heartbeat.unref();
  const ready = new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server.address()));
  });
  return {
    server,
    rooms,
    wss,
    ready,
    close: async () => {
      clearInterval(heartbeat);
      for (const s of wss.clients) s.terminate();
      await new Promise((r) => server.close(r));
      wss.close();
    },
  };
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const app = createApp({
    host: process.env.HOST || "127.0.0.1",
    port: Number(process.env.PORT || 8787),
  });
  app.ready
    .then((a) =>
      console.log(`Smash 64 Online is ready at http://${a.address}:${a.port}`),
    )
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, async () => {
      await app.close();
      process.exit(0);
    });
}
