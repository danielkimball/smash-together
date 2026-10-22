import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
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
  ".jpeg": "image/jpeg",
  ".mp4": "video/mp4",
  ".ttf": "font/ttf",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".gz": "application/gzip",
};
const TOKEN = /^[a-f0-9]{36}$/;
const send = (s, m) => {
  if (s?.readyState === 1) s.send(JSON.stringify(m));
};

export function createApp({
  host = "127.0.0.1",
  port = 8787,
  config = {},
} = {}) {
  const rooms = new Map();
  const attempts = new Map();
  let testingBytes;
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
      if (
        req.url === "/api/testing/cartridge" &&
        req.method === "POST" &&
        config.testing?.romPath &&
        config.testing?.passwordHash
      ) {
        res.setHeader("Cache-Control", "no-store");
        const ip = req.headers["cf-connecting-ip"] || req.socket.remoteAddress;
        const now = Date.now();
        for (const [key, value] of attempts)
          if (now - value.at > 60000) attempts.delete(key);
        const attempt = attempts.get(ip) || { at: now, count: 0 };
        if (attempt.count >= 8) {
          res.writeHead(429);
          return res.end("Wait a minute before trying again.");
        }
        let body = "";
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 512) {
            res.writeHead(413);
            return res.end("Request too large.");
          }
        }
        let password;
        try {
          password = JSON.parse(body).password;
        } catch {}
        const actual = createHash("sha256")
          .update(typeof password === "string" ? password : "")
          .digest();
        const expected = Buffer.from(config.testing.passwordHash, "hex");
        if (
          expected.length !== actual.length ||
          !timingSafeEqual(actual, expected)
        ) {
          attempt.count++;
          attempts.set(ip, attempt);
          res.writeHead(403);
          return res.end("That testing password is not correct.");
        }
        if (!testingBytes) {
          const bytes = await readFile(config.testing.romPath);
          if (
            createHash("sha1").update(bytes).digest("hex") !==
            "e2929e10fccc0aa84e5776227e798abc07cedabf"
          ) {
            res.writeHead(503);
            return res.end("The host’s testing cartridge is unavailable.");
          }
          testingBytes = bytes;
        }
        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader("Content-Length", testingBytes.length);
        res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
        return res.end(testingBytes);
      }
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
          JSON.stringify({
            ok: true,
            version: "3.3.0",
            shareUrl,
            publicUrl: shareUrl,
            testingAvailable: !!config.testing?.romPath,
          }),
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
                selecting: r.selecting,
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
        /\/(engine|media|fonts|brand)\//.test(file)
          ? "public, max-age=86400"
          : "no-cache",
      );
      // Stream seekable video without loading whole recordings into memory or
      // monopolizing the relay's event loop. Safari requests byte ranges too.
      if (ext === ".mp4") {
        res.setHeader("Accept-Ranges", "bytes");
        let start = 0,
          end = info.size - 1;
        if (req.headers.range) {
          const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
          if (!range || (!range[1] && !range[2])) {
            res.writeHead(416, { "Content-Range": `bytes */${info.size}` });
            return res.end();
          }
          if (range[1]) {
            start = Number(range[1]);
            if (range[2]) end = Math.min(Number(range[2]), end);
          } else start = Math.max(0, info.size - Number(range[2]));
          if (
            !Number.isSafeInteger(start) ||
            !Number.isSafeInteger(end) ||
            start > end ||
            start >= info.size
          ) {
            res.writeHead(416, { "Content-Range": `bytes */${info.size}` });
            return res.end();
          }
          res.statusCode = 206;
          res.setHeader("Content-Range", `bytes ${start}-${end}/${info.size}`);
        }
        res.setHeader("Content-Length", end - start + 1);
        if (req.method === "HEAD") return res.end();
        const stream = createReadStream(file, { start, end });
        stream.on("error", () => res.destroy());
        res.on("close", () => stream.destroy());
        return stream.pipe(res);
      }
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
    revision: r.revision,
    selecting: r.selecting,
    hostId: r.hostId,
    members: [...r.members.values()].map((p) => ({
      id: p.id,
      slot: p.slot,
      name: p.name,
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
        if (data.length < 8) return;
        // A roster can change while a snapshot is compressing. Never forward
        // an old snapshot to a newly connected controller.
        try {
          const length = data.readUInt32BE(0);
          if (length > 2048 || data.length < 4 + length) return;
          const header = JSON.parse(data.subarray(4, 4 + length).toString());
          if (header.match !== room.match || header.revision !== room.revision)
            return;
        } catch {
          return;
        }
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
        if (m.protocol !== 4)
          return fail(
            "This page has been updated. Reload to use the new Smash rooms.",
          );
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
            phase: "starting",
            selecting: true,
            match: 1,
            revision: 0,
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
          if (!r.selecting && !p)
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
            controller: clean(m.controller, "Keyboard", 80),
          };
          r.members.set(p.id, p);
        }
        if (!r.hostId) r.hostId = p.id;
        p.socket = socket;
        r.revision++;
        socket.meta = { token: r.token, id: p.id };
        send(socket, {
          type: "joined",
          token: r.token,
          id: p.id,
          ticket: p.ticket,
        });
        clearTimeout(joinTimeout);
        update(r);
        if (m.type === "create")
          broadcast(r, { type: "launch", match: r.match });
        return;
      }
      if (!room || !member) return fail("Join a room first.");
      if (m.type === "leave") {
        socket.voluntary = true;
        socket.close(1000);
        return;
      }
      if (m.type === "rename") {
        if (!isHost) return fail("Only the host can rename this room.");
        if (typeof m.name !== "string" || !m.name.trim())
          return fail("Enter a room name.");
        room.name = clean(m.name, room.name);
        update(room);
        return;
      }
      if (m.type === "profile") {
        const controller = clean(m.controller, "Keyboard", 80);
        member.controller = controller;
        update(room);
        return;
      }
      if (m.type === "seal" || m.type === "open") {
        if (!isHost) return fail("Only the host can start or reopen a match.");
        if (m.match !== room.match || m.revision !== room.revision) return;
        if (
          m.type === "seal" &&
          (room.members.size < 2 ||
            ![...room.members.values()].every((p) => p.socket))
        )
          return fail("Wait for at least two connected players.");
        room.selecting = m.type === "open";
        room.phase = room.selecting ? "selecting" : "playing";
        update(room);
        return;
      }
      if (m.type === "lobby") {
        if (!isHost)
          return fail(
            "Only the host can return everyone to character selection.",
          );
        room.phase = "starting";
        room.selecting = true;
        room.match++;
        room.revision++;
        for (const p of room.members.values())
          if (!p.socket) room.members.delete(p.id);
        update(room);
        broadcast(room, { type: "launch", match: room.match });
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
        if (g.match !== room.match || g.revision !== room.revision) return;
        if (g.type === "start") {
          if (![...room.members.values()].every((p) => p.socket)) return;
          room.phase = room.selecting ? "selecting" : "playing";
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
        // Reserve the port on network loss. An explicit leave in character
        // selection frees it; the host clears its token using native input.
        if (socket.voluntary && room.selecting) room.members.delete(meta.id);
        else {
          member.socket = null;
          room.phase = "paused";
        }
        room.revision++;
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
  let config = {};
  try {
    config = JSON.parse(
      await readFile(path.join(ROOT, ".local/config.json"), "utf8"),
    );
  } catch {}
  const app = createApp({
    host: process.env.HOST || "127.0.0.1",
    port: Number(process.env.PORT || 8787),
    config,
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
