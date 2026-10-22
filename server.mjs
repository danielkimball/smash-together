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
          JSON.stringify({ ok: true, version: "2.0.0", shareUrl }),
        );
      }
      if (url.pathname === "/api/rooms") {
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Content-Type", "application/json");
        return res.end(
          JSON.stringify({
            rooms: [...rooms.values()]
              .filter((r) => r.listed)
              .map((r) => ({
                id: r.id,
                name: r.name,
                count: r.members.size,
                capacity: r.capacity,
                phase: r.phase,
                host: r.members.get(r.hostId)?.name || "Host",
              })),
          }),
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
  const publicRoom = (r) => ({
    id: r.id,
    name: r.name,
    listed: r.listed,
    capacity: r.capacity,
    delay: r.delay,
    phase: r.phase,
    match: r.match,
    hostId: r.hostId,
    members: [...r.members.values()].map((p) => ({
      id: p.id,
      slot: p.slot,
      name: p.name,
      ready: p.ready,
      connected: !!p.socket,
      controller: p.controller,
    })),
  });
  const broadcast = (r, message, except) => {
    for (const p of r.members.values())
      if (p.id !== except) send(p.socket, message);
  };
  const update = (r) => broadcast(r, { type: "room", room: publicRoom(r) });
  const clean = (value, fallback, max = 40) =>
    String(value || "")
      .replace(/[\x00-\x1f\x7f]/g, "")
      .trim()
      .slice(0, max) || fallback;
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
      if (++messages > 1200) return socket.close(1008, "Rate limit");
      const fail = (message) => send(socket, { type: "error", message });
      const meta = socket.meta,
        room = meta && rooms.get(meta.token);
      const member = room?.members.get(meta.id);
      const isHost = room?.hostId === meta?.id;
      if (binary) {
        if (!room || !isHost) return fail("Only the host can synchronize.");
        if (room.phase === "lobby" || data.length < 8) return;
        for (const p of room.members.values()) {
          if (p.id === meta.id || !p.socket) continue;
          if (p.socket.bufferedAmount > 24 * 1024 * 1024)
            p.socket.close(1008, "Connection too slow");
          else p.socket.send(data, { binary: true });
        }
        return;
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
          !m.build ||
          m.build.length > 120
        )
          return fail("Load a supported ROM first.");
        const name = clean(m.name, "Player", 30);
        let r, p;
        if (m.type === "create") {
          if (rooms.size >= 32) return fail("Server is full. Try again later.");
          const token = randomBytes(18).toString("hex");
          r = {
            token,
            id: randomBytes(5).toString("hex"),
            name: clean(m.roomName, `${name}’s room`),
            listed: m.listed !== false,
            capacity: [2, 3, 4].includes(m.capacity) ? m.capacity : 4,
            delay: Math.max(
              2,
              Math.min(15, Number.isInteger(m.delay) ? m.delay : 6),
            ),
            rom: m.rom,
            build: m.build,
            phase: "lobby",
            match: 0,
            members: new Map(),
          };
          rooms.set(token, r);
        } else {
          r = TOKEN.test(m.token || "")
            ? rooms.get(m.token)
            : [...rooms.values()].find((r) => r.listed && r.id === m.roomId);
          if (!r)
            return fail("This room has closed or the invitation is invalid.");
          if (r.rom !== m.rom || r.build !== m.build)
            return fail(
              "Everyone needs the same ROM and game build. Reload the pages and try again.",
            );
          p = [...r.members.values()].find(
            (p) => m.ticket && p.ticket === m.ticket && !p.socket,
          );
          if (r.phase !== "lobby" && !p)
            return fail(
              "This game has started. Join when the host returns to the lobby.",
            );
          if (!p && r.members.size >= r.capacity)
            return fail("This room is full. Choose another room.");
        }
        if (!p) {
          const used = new Set([...r.members.values()].map((p) => p.slot));
          p = {
            id: randomBytes(8).toString("hex"),
            ticket: randomBytes(18).toString("hex"),
            slot: [0, 1, 2, 3].find((i) => !used.has(i)),
            name,
            ready: false,
            controller: clean(m.controller, "Keyboard", 80),
          };
          r.members.set(p.id, p);
        }
        if (!r.hostId) r.hostId = p.id;
        p.socket = socket;
        socket.meta = { token: r.token, id: p.id };
        send(socket, {
          type: "joined",
          token: r.token,
          id: p.id,
          ticket: p.ticket,
        });
        clearTimeout(joinTimeout);
        update(r);
        if (
          r.phase === "paused" &&
          [...r.members.values()].every((p) => p.socket)
        )
          broadcast(r, { type: "reconnected" });
        return;
      }
      if (!room || !member) return fail("Join a room first.");
      if (m.type === "profile") {
        const controller = clean(m.controller, "Keyboard", 80);
        if (room.phase === "lobby" && controller !== member.controller)
          member.ready = false;
        member.controller = controller;
        update(room);
        return;
      }
      if (m.type === "seat" || m.type === "ready") {
        if (room.phase !== "lobby")
          return fail("Return to the lobby to change players.");
        if (m.type === "seat") {
          if (
            !Number.isInteger(m.slot) ||
            m.slot < 0 ||
            m.slot >= room.capacity
          )
            return fail("Choose an available player slot.");
          if (
            [...room.members.values()].some(
              (p) => p.id !== meta.id && p.slot === m.slot,
            )
          )
            return fail("That controller port is taken.");
          member.slot = m.slot;
          member.ready = false;
        } else member.ready = m.ready === true;
        update(room);
        return;
      }
      if (m.type === "launch") {
        if (!isHost) return fail("Only the host can start the game.");
        if (room.phase !== "lobby") return;
        if (
          room.members.size < 2 ||
          ![...room.members.values()].every((p) => p.ready && p.socket)
        )
          return fail(
            "At least two players must join, and everyone must be ready.",
          );
        room.phase = "starting";
        room.match++;
        update(room);
        broadcast(room, { type: "launch", match: room.match });
        return;
      }
      if (m.type === "lobby") {
        if (!isHost)
          return fail("Only the host can return everyone to the lobby.");
        room.phase = "lobby";
        room.match++;
        for (const p of room.members.values()) {
          if (!p.socket) room.members.delete(p.id);
          else p.ready = false;
        }
        update(room);
        return;
      }
      const recipients = [...room.members.values()].filter(
        (p) => p.id !== meta.id && p.socket && (!m.to || p.id === m.to),
      );
      if (m.type === "signal") {
        if (!m.to || !m.signal || JSON.stringify(m.signal).length > 12000)
          return;
        for (const p of recipients)
          send(p.socket, { type: "signal", from: meta.id, signal: m.signal });
        return;
      }
      if (m.type === "game") {
        const g = m.payload;
        if (!g || typeof g !== "object") return fail("Invalid game packet");
        if (
          ![
            "input",
            "hash",
            "start",
            "ready",
            "sync",
            "pause",
            "resync",
            "echo",
            "echo-reply",
          ].includes(g.type)
        )
          return;
        if (["start", "sync"].includes(g.type) && !isHost)
          return fail("Only the host can start or synchronize.");
        if (room.phase === "lobby" || g.match !== room.match) return;
        if (g.type === "start") {
          if (![...room.members.values()].every((p) => p.socket)) return;
          room.phase = "playing";
          update(room);
        }
        for (const p of recipients) {
          if (p.socket.bufferedAmount > 24 * 1024 * 1024)
            p.socket.close(1008, "Connection too slow");
          else send(p.socket, { type: "game", from: meta.id, payload: g });
        }
      }
    });
    socket.on("close", () => {
      clearTimeout(joinTimeout);
      const meta = socket.meta;
      if (!meta) return;
      const room = rooms.get(meta.token),
        member = room?.members.get(meta.id);
      if (!room || !member || member.socket !== socket) return;
      if (meta.id === room.hostId) {
        rooms.delete(meta.token);
        broadcast(
          room,
          {
            type: "closed",
            message:
              "The host closed this room. Join another room or create your own.",
          },
          meta.id,
        );
        for (const p of room.members.values())
          if (p.id !== meta.id && p.socket) {
            p.socket.meta = null;
            p.socket.close(1000);
          }
      } else {
        if (room.phase === "lobby") room.members.delete(meta.id);
        else {
          member.socket = null;
          room.phase = "paused";
        }
        update(room);
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
