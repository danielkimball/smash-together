import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { createReadStream, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { WebSocketServer } from "ws";
import { FrameClock } from "./scripts/frame-clock.mjs";
import { PROTOCOL } from "./public/js/protocol.js";
import {
  ownerOf,
  party,
  connections,
  validateLocals,
  reconcileParty,
} from "./scripts/room-party.mjs";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { cleanMetrics, performanceLogger } from "./scripts/performance-log.mjs";
import {
  active,
  waiting,
  nextHost,
  enqueue,
  lineup,
  applyLineup,
} from "./scripts/room-roster.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(
  readFileSync(path.join(ROOT, "package.json"), "utf8"),
).version;
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
  maintenancePath = null,
  logPerformance = () => {},
  metricsInterval = 30000,
  reconnectGraceMs = 30000,
  heartbeatInterval = 5000,
} = {}) {
  const rooms = new Map();
  const loopDelay = monitorEventLoopDelay({ resolution: 20 });
  loopDelay.enable();
  let loopBaseline = performance.eventLoopUtilization();
  let tunnelProtocol = null;
  let serverMetrics = {
    eventLoopP99Ms: 0,
    eventLoopMaxMs: 0,
    eventLoopUtilization: 0,
  };
  const roomMetrics = (room) => ({
    room: room.id,
    frame: room.clock?.frame || 0,
    clockMaxLatenessMs: Math.round(room.clock?.maxLatenessMs || 0),
    clockHiccups: room.clock?.hiccups || 0,
    missingInputs: room.clock?.lateCounts || [0, 0, 0, 0],
    members: [...room.members.values()].map((p) => ({
      slot: p.slot,
      connected: !!p.socket,
      reportAgeMs: p.performanceAt ? Date.now() - p.performanceAt : null,
      metrics: p.performance || null,
    })),
  });
  const metricsTimer = setInterval(() => {
    const utilization = performance.eventLoopUtilization(loopBaseline);
    loopBaseline = performance.eventLoopUtilization();
    serverMetrics = {
      eventLoopP99Ms: Math.round(loopDelay.percentile(99) / 1e6),
      eventLoopMaxMs: Math.round(loopDelay.max / 1e6),
      eventLoopUtilization: Math.round(utilization.utilization * 1000) / 1000,
      rssMB: Math.round(process.memoryUsage().rss / 1048576),
      tunnelTransport: { quic: 1, http2: 2 }[tunnelProtocol] || 0,
    };
    loopDelay.reset();
    if (rooms.size)
      logPerformance({
        type: "smash-performance",
        at: new Date().toISOString(),
        version: VERSION,
        server: serverMetrics,
        rooms: [...rooms.values()].map(roomMetrics),
      });
  }, metricsInterval);
  metricsTimer.unref();
  const stopClock = (room) => {
    clearInterval(room.clockTimer);
    room.clock = null;
    room.slotReady = {};
  };
  const updating = () => {
    try {
      return (
        maintenancePath &&
        JSON.parse(readFileSync(maintenancePath, "utf8")).expires > Date.now()
      );
    } catch {
      return false;
    }
  };
  const attempts = new Map();
  let testingBytes;
  const frontend = config.frontendUrl ? new URL(config.frontendUrl) : null;
  const trustedOrigin = (req) => {
    if (!req.headers.origin) return true;
    try {
      const origin = new URL(req.headers.origin);
      return (
        origin.host === req.headers.host || origin.origin === frontend?.origin
      );
    } catch {
      return false;
    }
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Permissions-Policy",
      "gamepad=(self), microphone=(self), camera=()",
    );
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'; style-src 'self'; img-src 'self' data:; connect-src 'self' ws: wss:; worker-src 'self' blob:; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    try {
      if (req.url.startsWith("/api/") && req.headers.origin) {
        if (!trustedOrigin(req)) {
          res.writeHead(403);
          return res.end("Origin not allowed");
        }
        res.setHeader("Access-Control-Allow-Origin", req.headers.origin);
        res.setHeader("Vary", "Origin");
        if (req.method === "OPTIONS") {
          res.writeHead(204, {
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
            "Access-Control-Max-Age": "600",
          });
          return res.end();
        }
      }
      if (
        req.url === "/api/testing/cartridge" &&
        req.method === "POST" &&
        config.testing?.romPath &&
        (config.testing?.passwordHash || config.testing?.autoLoad === true)
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
        const expected = Buffer.from(config.testing.passwordHash || "", "hex");
        if (
          config.testing.autoLoad !== true &&
          (expected.length !== actual.length ||
            !timingSafeEqual(actual, expected))
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
        tunnelProtocol = null;
        try {
          const sharing = JSON.parse(
            await readFile(path.join(ROOT, ".local/share.json"), "utf8"),
          );
          shareUrl = sharing.url;
          tunnelProtocol = ["quic", "http2"].includes(sharing.protocol)
            ? sharing.protocol
            : null;
        } catch {}
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Content-Type", "application/json");
        return res.end(
          JSON.stringify({
            ok: true,
            version: VERSION,
            hostId: config.hostId || null,
            activeRooms: rooms.size,
            performance: serverMetrics,
            updating: !!updating(),
            shareUrl,
            tunnelProtocol,
            publicUrl: frontend?.href || shareUrl,
            testingAvailable: !!config.testing?.romPath,
            testingAutoLoad:
              !!config.testing?.romPath && config.testing.autoLoad === true,
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
                count: [...r.members.values()].filter((p) => p.socket).length,
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
    let valid = ["/room", "/media"].includes(req.url);
    valid &&= trustedOrigin(req);
    if (!valid || wss.clients.size >= 128) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.mediaTransport = req.url === "/media";
      wss.emit("connection", ws);
    });
  });
  const publicRoom = (r) => ({
    id: r.id,
    name: r.name,
    listed: r.listed,
    capacity: r.capacity,
    delay: r.delay,
    timing: "deadline",
    inputMode: "latest",
    mediaTransport: true,
    localPlayers: true,
    liveLobby: true,
    phase: r.phase,
    match: r.match,
    revision: r.revision,
    selecting: r.selecting,
    hostId: r.hostId,
    epoch: r.clockEpoch || 0,
    frame: r.clock?.frame || 0,
    rotation: r.rotation,
    nextLineup: lineup(r).map((p) => p.id),
    results: r.results,
    round: r.round,
    teams: !!r.teams,
    teamsConfigured: !!r.teamsConfigured,
    muteSpectators: !!r.muteSpectators,
    members: [...r.members.values()].map((p) => ({
      id: p.id,
      ownerId: ownerOf(p),
      localKey: p.localKey || "primary",
      localIndex: p.localIndex || 0,
      slot: p.slot,
      name: p.name,
      connected: !!p.socket,
      controller: p.controller,
      ready: p.ready,
      queue: p.queue,
      team: p.team,
      voice: !!p.voice,
      listening: !!p.listening,
      muted: !!p.muted,
    })),
  });
  const broadcast = (r, message, except) => {
    for (const p of connections(r))
      if (p.id !== except) send(p.socket, message);
  };
  const update = (r) => broadcast(r, { type: "room", room: publicRoom(r) });
  const removeMember = (room, member) => {
    for (const p of party(room, ownerOf(member))) {
      clearTimeout(p.reconnectTimer);
      room.members.delete(p.id);
      room.override = room.override?.filter((id) => id !== p.id);
    }
  };
  const clockSlots = (room) => {
    if (room.clock)
      room.clock.slots = active(room)
        .filter((p) => p.socket && (p.ready || !room.selecting))
        .map((p) => p.slot);
  };
  const clearSelectionSlot = (room, slot) => {
    if (slot < 0 || !room.selecting || !room.clock) return;
    room.clock.release(slot);
    // Recall and park only this token on the shared timeline. Other players
    // keep choosing; no local-only emulator frames or group snapshot needed.
    const at = room.clock.frame + 2;
    room.slotReady ||= {};
    room.slotReady[slot] = at + 40;
    room.clock.commands.push(
      { at, command: { scene: 16, slot, releaseSlot: true } },
      { at: at + 36, command: { scene: 16, slot, x: 36 + slot * 69, y: 205 } },
    );
  };
  const changeLineup = (room) => {
    const before = active(room).map((p) => ({ id: p.id, slot: p.slot }));
    const teamRotation = !!room.results?.teams;
    applyLineup(room);
    // Native team colors/costumes need the existing configured-screen
    // rebuild for explicit team lineup edits and between-round team rotation.
    // Ordinary joins, reconnects and setup dialogs never take this path.
    if (teamRotation || room.teams) stopClock(room);
    if (room.clock) {
      for (const p of before)
        if (
          !active(room).some((next) => next.id === p.id && next.slot === p.slot)
        )
          clearSelectionSlot(room, p.slot);
      clockSlots(room);
    } else room.revision++;
  };
  const disconnect = (room, member, socket, voluntary = false) => {
    if (member.socket !== socket) return;
    member.mediaSocket?.close(1000, "Room connection closed");
    member.mediaSocket = null;
    const family = party(room, member.id);
    for (const p of family) {
      p.socket = null;
      p.voice = p.listening = false;
      p.disconnectedAt = Date.now();
      if (p.slot >= 0) room.clock?.release(p.slot);
      if (room.selecting) {
        clearSelectionSlot(room, p.slot);
        if (!voluntary) enqueue(room, p);
      }
    }
    if (voluntary) removeMember(room, member);
    const successor = nextHost(room);
    if (!successor) {
      stopClock(room);
      for (const p of room.members.values()) clearTimeout(p.reconnectTimer);
      rooms.delete(room.token);
      return;
    }
    if (room.hostId === member.id) room.hostId = successor.id;
    clockSlots(room);
    if (room.selecting && !room.clock) room.revision++;
    if (!voluntary) {
      member.reconnectTimer = setTimeout(() => {
        if (member.socket || rooms.get(room.token) !== room) return;
        removeMember(room, member);
        // A disconnected fighter already has neutral inputs. Expiring its
        // reservation must not pause or resynchronize the remaining players.
        update(room);
      }, reconnectGraceMs);
      member.reconnectTimer.unref();
    }
    update(room);
  };
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
      if (meta && !socket.mediaTransport && member?.socket !== socket)
        return socket.close(1008, "Session replaced or closed");
      if (binary) {
        if (
          socket.mediaTransport &&
          (!member?.socket || member.mediaSocket !== socket)
        )
          return socket.close(1008, "Invalid media session");
        if (!room || !isHost) return fail("Only the host can synchronize.");
        if (data.length < 8) return;
        // A roster can change while a snapshot is compressing. Never forward
        // an old snapshot to a newly connected controller.
        let header;
        try {
          const length = data.readUInt32BE(0);
          if (length > 2048 || data.length < 4 + length) return;
          header = JSON.parse(data.subarray(4, 4 + length).toString());
          if (header.match !== room.match || header.revision !== room.revision)
            return;
        } catch {
          return;
        }
        if (header.to) {
          const target = room.members.get(header.to);
          if (
            !target?.socket ||
            header.epoch !== room.clockEpoch ||
            !Number.isSafeInteger(header.frame)
          )
            return;
          const history = room.history || [];
          if (header.frame < (history[0]?.frame ?? 0)) {
            send(member.socket, { type: "snapshot-request", to: header.to });
            return;
          }
          const transfer =
            target.mediaSocket?.readyState === 1
              ? target.mediaSocket
              : target.socket;
          if (transfer.bufferedAmount > 1024 * 1024) return;
          transfer.send(data, { binary: true });
          for (const frame of history)
            if (frame.frame >= header.frame) send(transfer, frame);
          return;
        }
        for (const p of connections(room)) {
          if (p.id === meta.id || !p.socket) continue;
          const transfer = p.socket;
          if (transfer.bufferedAmount > 24 * 1024 * 1024)
            transfer.close(1008, "Connection too slow");
          else transfer.send(data, { binary: true });
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
      if (socket.mediaTransport) {
        if (!meta && m.type === "attach-media") {
          const r = TOKEN.test(m.token || "") && rooms.get(m.token);
          const p = r?.members.get(m.id);
          if (!p?.socket || !m.ticket || p.ticket !== m.ticket)
            return socket.close(1008, "Invalid media session");
          p.mediaSocket?.close(1000, "Replaced");
          p.mediaSocket = socket;
          socket.meta = { token: r.token, id: p.id };
          clearTimeout(joinTimeout);
          return send(socket, { type: "media-ready" });
        }
        if (!member || member.mediaSocket !== socket || !member.socket)
          return socket.close(1008, "Invalid media session");
        if (m.type !== "voice" && m.type !== "ping") return;
      }
      if (m.type === "ping") return send(socket, { type: "pong", id: m.id });
      if (m.type === "create" || m.type === "join") {
        if (meta) return fail("Already in a room");
        if (m.protocol !== PROTOCOL)
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
        try {
          if (m.locals !== undefined) validateLocals(m.locals);
        } catch (e) {
          return fail(e.message);
        }
        let r, p;
        if (m.type === "create") {
          if (updating())
            return fail(
              "The host is installing an update. Please try again shortly.",
            );
          if (rooms.size >= 32) return fail("Server is full. Try again later.");
          const token = randomBytes(18).toString("hex");
          r = {
            token,
            id: randomBytes(5).toString("hex"),
            name: clean(m.roomName, `${name}’s room`),
            listed: m.listed !== false,
            capacity: 8,
            rotation: "automatic",
            queueCounter: 0,
            round: 0,
            history: [],
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
            (p) => !p.ownerId && m.ticket && p.ticket === m.ticket,
          );
          const required = p
            ? (m.locals?.length ?? party(r, p.id).length - 1) -
              (party(r, p.id).length - 1)
            : 1 + (m.locals?.length || 0);
          while (r.members.size + required > r.capacity) {
            const reserved = connections(r)
              .filter((member) => !member.socket && member !== p)
              .sort((a, b) => a.disconnectedAt - b.disconnectedAt)[0];
            if (!reserved)
              return fail(
                "This room is too full for everyone on this device. It holds eight people.",
              );
            removeMember(r, reserved);
          }
        }
        if (!p) {
          const used = new Set([...r.members.values()].map((p) => p.slot));
          p = {
            id: randomBytes(8).toString("hex"),
            ticket: randomBytes(18).toString("hex"),
            slot: r.selecting
              ? ([0, 1, 2, 3].find((i) => !used.has(i)) ?? -1)
              : -1,
            ready: true,
            joined: ++r.queueCounter,
            queue: r.queueCounter,
            team: 0,
            name,
            controller: clean(m.controller, "Keyboard", 80),
          };
          r.members.set(p.id, p);
        }
        if (!r.hostId) r.hostId = p.id;
        clearTimeout(p.reconnectTimer);
        if (p.socket) {
          // A reload can rejoin before the old transport's close arrives.
          // Only the saved secret ticket can replace that session.
          const previous = p.socket;
          for (const local of party(r, p.id)) {
            local.socket = null;
            if (local.slot >= 0) r.clock?.release(local.slot);
          }
          if (r.hostId === p.id) r.hostId = nextHost(r)?.id || p.id;
          p.mediaSocket?.close(1000, "Session replaced");
          p.mediaSocket = null;
          if (p.slot >= 0) r.clock?.release(p.slot);
          send(previous, {
            type: "closed",
            message: "This player rejoined in another page.",
          });
          previous.close(1000, "Session replaced");
        }
        const liveJoin = !!r.clock;
        p.socket = socket;
        p.voice = p.listening = false;
        if (m.locals !== undefined) {
          const changes = reconcileParty(r, p, m.locals, clean);
          for (const removed of changes.removed)
            clearSelectionSlot(r, removed.slot);
        }
        for (const local of party(r, p.id)) {
          local.socket = socket;
          if (r.selecting && local.slot < 0 && local.ready) {
            const occupied = new Set(active(r).map((member) => member.slot));
            local.slot = [0, 1, 2, 3].find((slot) => !occupied.has(slot)) ?? -1;
          }
        }
        clockSlots(r);
        if (!liveJoin) {
          stopClock(r);
          r.revision++;
        }
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
        else if (liveJoin)
          send(r.members.get(r.hostId)?.socket, {
            type: "snapshot-request",
            to: p.id,
          });
        return;
      }
      if (!room || !member) return fail("Join a room first.");
      if (m.type === "local-players") {
        try {
          const changes = reconcileParty(room, member, m.locals, clean);
          for (const removed of changes.removed) {
            if (removed.slot >= 0) room.clock?.release(removed.slot);
            clearSelectionSlot(room, removed.slot);
          }
          clockSlots(room);
          if (!room.clock) room.revision++;
          update(room);
        } catch (e) {
          fail(e.message);
        }
        return;
      }
      if (m.type === "pointer") {
        const actor = m.playerId ? room.members.get(m.playerId) : member;
        if (!actor || ownerOf(actor) !== member.id) return;
        const slot =
          actor.slot < 0 && isHost && m.scene === 24
            ? (active(room).find((p) => p.socket)?.slot ?? 0)
            : actor.slot;
        if (
          !room.clock ||
          slot < 0 ||
          ![16, 21, 24].includes(m.scene) ||
          !Number.isFinite(m.x) ||
          !Number.isFinite(m.y) ||
          m.x < 0 ||
          m.x > 320 ||
          m.y < 0 ||
          m.y > 240
        )
          return;
        if (m.scene === 16 && !room.selecting) return;
        if (Date.now() - (actor.lastPointer || 0) < 250) return;
        actor.lastPointer = Date.now();
        const offset =
          m.scene === 16 && m.recall
            ? 45
            : m.scene === 21
              ? 12
              : m.scene === 24 && Number.isInteger(m.wait)
                ? Math.max(2, Math.min(450, m.wait))
                : 2;
        const buttons = (button, delay) => {
          for (let f = 0; f < 3; f++)
            room.clock.commands.push({
              at: room.clock.frame + delay + f,
              command: { id: actor.id, slot, scene: m.scene, button },
            });
        };
        if (m.scene === 16 && m.recall) buttons(64, 2);
        room.clock.commands.push({
          at: room.clock.frame + offset,
          command: {
            id: actor.id,
            slot,
            scene: m.scene,
            x: m.x,
            y: m.y,
          },
        });
        buttons(m.scene === 24 ? 16 : 128, offset + 2);
        return;
      }
      if (m.type === "leave") {
        disconnect(room, member, socket, true);
        socket.close(1000);
        return;
      }
      if (m.type === "observe") {
        if (room.clock && Date.now() - (member.lastObserve || 0) > 1500) {
          member.lastObserve = Date.now();
          send(room.members.get(room.hostId)?.socket, {
            type: "snapshot-request",
            to: member.id,
          });
        }
        return;
      }
      if (m.type === "availability") {
        const target = m.id ? room.members.get(m.id) : member;
        if (!target || ownerOf(target) !== member.id) return;
        target.ready = m.ready === true;
        if (target.ready && target.slot < 0) target.queue = ++room.queueCounter;
        if (room.selecting) {
          changeLineup(room);
        }
        update(room);
        return;
      }
      if (m.type === "manage") {
        if (!isHost) return fail("Only the host can manage the lineup.");
        if (m.rotation === "automatic" || m.rotation === "manual")
          room.rotation = m.rotation;
        if (Array.isArray(m.lineup)) {
          const ids = [...new Set(m.lineup)];
          if (
            ids.length > 4 ||
            ids.some(
              (id) =>
                !room.members.get(id)?.socket || !room.members.get(id)?.ready,
            )
          )
            return fail("Choose up to four ready players.");
          room.override = ids;
          if (room.selecting) {
            changeLineup(room);
          }
        }
        if (Array.isArray(m.queue)) {
          const queue = waiting(room);
          if (
            m.queue.length !== queue.length ||
            new Set(m.queue).size !== queue.length ||
            m.queue.some((id) => !queue.some((p) => p.id === id))
          )
            return fail("Queue changed; try again.");
          for (const id of m.queue)
            room.members.get(id).queue = ++room.queueCounter;
        }
        if (m.teams && typeof m.teams === "object" && room.selecting) {
          for (const p of active(room))
            if ([0, 1, 2].includes(m.teams[p.id])) p.team = m.teams[p.id];
          room.teams = m.teamsEnabled !== false;
          room.teamsConfigured = true;
          stopClock(room);
          room.revision++;
        }
        update(room);
        return;
      }
      if (m.type === "results") {
        if (!isHost || room.selecting || m.round !== room.round || room.results)
          return;
        if (
          !Array.isArray(m.players) ||
          m.players.length > 4 ||
          m.players.some(
            (p) =>
              !Number.isInteger(p.slot) ||
              p.slot < 0 ||
              p.slot > 3 ||
              !Number.isInteger(p.place) ||
              p.place < 0 ||
              p.place > 3 ||
              !Number.isInteger(p.kos) ||
              !Number.isInteger(p.points),
          )
        )
          return;
        room.results = {
          teams: !!m.teams,
          players: m.players.map((score) => ({
            ...score,
            id: room.roundPlayers?.find((p) => p.slot === score.slot)?.id,
            team:
              room.roundPlayers?.find((p) => p.slot === score.slot)?.team ?? 0,
          })),
        };
        update(room);
        return;
      }
      if (m.type === "voice-state") {
        member.voice = m.enabled === true;
        member.listening =
          typeof m.listening === "boolean" ? m.listening : member.voice;
        update(room);
        return;
      }
      if (m.type === "performance") {
        if (Date.now() - (member.performanceAt || 0) < 4000) return;
        member.performance = cleanMetrics(m.metrics);
        member.performanceAt = Date.now();
        return;
      }
      if (m.type === "performance-report") {
        if (!isHost) return;
        return send(socket, {
          type: "performance-report",
          server: serverMetrics,
          room: roomMetrics(room),
        });
      }
      if (m.type === "voice-moderate") {
        if (!isHost) return fail("Only the host can mute the room.");
        if (typeof m.spectators === "boolean")
          room.muteSpectators = m.spectators;
        if (typeof m.muted === "boolean" && room.members.has(m.id))
          room.members.get(ownerOf(room.members.get(m.id))).muted = m.muted;
        update(room);
        return;
      }
      if (m.type === "voice") {
        if (
          !member.voice ||
          member.muted ||
          (room.muteSpectators &&
            !party(room, member.id).some((p) => p.slot >= 0)) ||
          typeof m.audio !== "string" ||
          !/^[A-Za-z0-9+/]{854}==$/.test(m.audio)
        )
          return;
        const time = Date.now();
        if (time - (member.voiceWindow || 0) >= 1000) {
          member.voiceWindow = time;
          member.voicePackets = 0;
        }
        if (++member.voicePackets > 35) return;
        for (const p of connections(room))
          if (p.id !== member.id && p.listening && p.socket) {
            const transport =
              p.mediaSocket?.readyState === 1 ? p.mediaSocket : p.socket;
            // Voice is disposable. Never build a queue of stale audio.
            if (transport.bufferedAmount < 8192)
              send(transport, {
                type: "voice",
                from: member.id,
                audio: m.audio,
              });
          }
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
          Object.values(room.slotReady || {}).some(
            (f) => f > (room.clock?.frame || 0),
          )
        )
          return;
        if (
          m.type === "seal" &&
          active(room).filter((p) => p.socket && p.ready).length < 2
        )
          return fail("Wait for at least two connected players.");
        room.selecting = m.type === "open";
        if (m.type === "seal") {
          room.teams = m.teams === true;
          room.teamsConfigured = true;
          for (const p of active(room))
            if ([0, 1, 2].includes(m.playerTeams?.[p.slot]))
              p.team = m.playerTeams[p.slot];
          room.round++;
          room.results = null;
          room.roundPlayers = active(room).map((p) => ({
            id: p.id,
            slot: p.slot,
            team: p.team,
          }));
          room.clock?.pulse(active(room).find((p) => p.socket)?.slot, 16);
        } else if (
          room.results ||
          room.override ||
          active(room).some((p) => !p.ready || !p.socket)
        ) {
          changeLineup(room);
          for (const p of room.members.values())
            if (!p.socket) room.members.delete(p.id);
        }
        room.phase = room.selecting ? "selecting" : "playing";
        update(room);
        return;
      }
      if (m.type === "lobby") {
        if (!isHost)
          return fail(
            "Only the host can return everyone to character selection.",
          );
        stopClock(room);
        room.phase = "starting";
        room.selecting = true;
        applyLineup(room);
        room.match++;
        room.revision++;
        for (const p of room.members.values())
          if (!p.socket) room.members.delete(p.id);
        update(room);
        broadcast(room, { type: "launch", match: room.match });
        return;
      }
      const recipients = connections(room).filter(
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
            "input-state",
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
        if (g.type === "input" || g.type === "input-state") {
          const player = g.playerId ? room.members.get(g.playerId) : member;
          if (
            !player ||
            ownerOf(player) !== member.id ||
            player.slot < 0 ||
            (room.selecting && !player.ready)
          )
            return;
          if (
            room.selecting &&
            (room.slotReady?.[player.slot] || 0) > (room.clock?.frame || 0)
          )
            return;
          if (g.epoch === room.clockEpoch) {
            if (g.type === "input-state")
              room.clock?.inputState(player.slot, g.sequence, g.input);
            else room.clock?.input(player.slot, g.frame, g.input);
          }
          return;
        }
        if (
          ["pause", "resync"].includes(g.type) &&
          !party(room, member.id).some((p) => p.slot >= 0) &&
          !isHost
        )
          return;
        if (g.type === "pause" && room.selecting) return;
        if (["sync", "pause"].includes(g.type)) stopClock(room);
        if (g.type === "start") {
          if (room.selecting && !active(room).every((p) => p.socket)) return;
          if (!Number.isSafeInteger(g.epoch)) return;
          stopClock(room);
          room.clockEpoch = g.epoch;
          room.history = [];
          room.clock = new FrameClock({
            slots: active(room)
              .filter((p) => p.socket && (p.ready || !room.selecting))
              .map((p) => p.slot),
            delay: room.delay,
            emit: (frame) => {
              const packet = {
                type: "frame",
                ...frame,
                epoch: g.epoch,
                match: room.match,
                revision: room.revision,
              };
              room.history.push(packet);
              if (room.history.length > 900) room.history.shift();
              const wire = JSON.stringify(packet);
              for (const p of connections(room)) {
                if (p.socket?.bufferedAmount > 1024 * 1024) {
                  p.socket.close(1008, "Connection too slow");
                } else if (p.socket?.readyState === 1) p.socket.send(wire);
              }
            },
          });
          room.clockTimer = setInterval(() => room.clock?.tick(), 4);
          room.clockTimer.unref();
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
      if (socket.mediaTransport) {
        if (member?.mediaSocket === socket) member.mediaSocket = null;
        return;
      }
      if (!room || !member || member.socket !== socket) return;
      disconnect(room, member, socket);
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
  }, heartbeatInterval);
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
      clearInterval(metricsTimer);
      loopDelay.disable();
      for (const r of rooms.values()) {
        stopClock(r);
        for (const p of r.members.values()) clearTimeout(p.reconnectTimer);
      }
      rooms.clear();
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
    maintenancePath: path.join(ROOT, ".local/deploy-drain.json"),
    logPerformance: performanceLogger(
      path.join(ROOT, ".local/performance.jsonl"),
    ),
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
