// Serveur multijoueur du Secret Santa — relais WebSocket sans aucune dépendance.
// - GET /            -> sert index.html (pratique pour tester) ou "ok"
// - GET /health      -> "ok"
// - WebSocket /ws    -> salons, positions des joueurs, événements
"use strict";
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 10000;
const MAX_ROOM = 30;
const MAX_MSG = 4096;
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/* ---------- HTTP ---------- */
const server = http.createServer((req, res) => {
  const url = (req.url || "/").split("?")[0];
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (url === "/health") { res.writeHead(200, { "Content-Type": "text/plain" }); return res.end("ok"); }
  if (url === "/" || url === "/index.html") {
    const f = path.join(__dirname, "index.html");
    if (fs.existsSync(f)) { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" }); return fs.createReadStream(f).pipe(res); }
  }
  res.writeHead(url === "/" ? 200 : 404, { "Content-Type": "text/plain" });
  res.end(url === "/" ? "ok" : "not found");
});

/* ---------- WebSocket (RFC 6455, minimal) ---------- */
function frame(op, payload) {
  const len = payload.length;
  let head;
  if (len < 126) { head = Buffer.alloc(2); head[1] = len; }
  else if (len < 65536) { head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  head[0] = 0x80 | op;
  return Buffer.concat([head, payload]);
}
function send(c, obj) {
  if (c.closed) return;
  try { c.sock.write(frame(1, Buffer.from(JSON.stringify(obj)))); } catch (e) { drop(c); }
}

let nextId = 1;
const rooms = new Map(); // room -> Map(id -> client)

server.on("upgrade", (req, sock) => {
  const url = (req.url || "").split("?")[0];
  const key = req.headers["sec-websocket-key"];
  if (url !== "/ws" || !key || (req.headers.upgrade || "").toLowerCase() !== "websocket") { sock.destroy(); return; }
  const accept = crypto.createHash("sha1").update(key + GUID).digest("base64");
  sock.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");
  sock.setNoDelay(true);
  const c = { id: String(nextId++), sock, buf: Buffer.alloc(0), frag: [], room: null, name: "", g: "", state: null, closed: false, win: Date.now(), count: 0, alive: true };
  sock.on("data", d => { c.buf = Buffer.concat([c.buf, d]); parse(c); });
  sock.on("close", () => drop(c));
  sock.on("error", () => drop(c));
});

function parse(c) {
  let buf = c.buf;
  while (buf.length >= 2) {
    const b0 = buf[0], b1 = buf[1], fin = (b0 & 0x80) !== 0, op = b0 & 0x0f, masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f, off = 2;
    if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
    if (len > MAX_MSG * 4) { drop(c); return; }
    const maskOff = off; if (masked) off += 4;
    if (buf.length < off + len) break;
    let p = Buffer.from(buf.subarray(off, off + len));
    if (masked) { const m = buf.subarray(maskOff, maskOff + 4); for (let i = 0; i < p.length; i++) p[i] ^= m[i & 3]; }
    buf = buf.subarray(off + len);
    if (op === 8) { try { c.sock.write(frame(8, Buffer.alloc(0))); } catch (e) {} drop(c); return; }
    if (op === 9) { try { c.sock.write(frame(10, p)); } catch (e) {} continue; }
    if (op === 10) { c.alive = true; continue; }
    if (op === 1 || op === 0) {
      c.frag.push(p);
      if (fin) { const msg = Buffer.concat(c.frag).toString("utf8"); c.frag = []; onMessage(c, msg); }
    }
  }
  c.buf = buf;
}

/* ---------- Salons ---------- */
const clean = (s, n) => String(s || "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, n);
const num = v => (typeof v === "number" && isFinite(v) ? Math.round(v * 100) / 100 : 0);
const ANIMS = new Set(["Idle", "Walking", "Running", "Jump", "ThumbsUp", "No", "Wave", "Dance", "Yes"]);

function others(c) { const r = rooms.get(c.room); return r ? [...r.values()].filter(o => o !== c) : []; }
function broadcast(c, obj) { for (const o of others(c)) send(o, obj); }
function pub(c) { return { id: c.id, name: c.name, g: c.g, s: c.state }; }

function onMessage(c, raw) {
  if (raw.length > MAX_MSG) return;
  const now = Date.now();
  if (now - c.win > 1000) { c.win = now; c.count = 0; }
  if (++c.count > 40) return; // anti-spam
  let m; try { m = JSON.parse(raw); } catch (e) { return; }
  if (!m || typeof m !== "object") return;

  if (m.t === "hi") {
    c.name = clean(m.name, 22) || "Agent";
    c.g = m.g === "f" ? "f" : "m";
    if (!c.room) {
      const room = clean(m.room, 24).toLowerCase().replace(/[^a-z0-9-]/g, "") || "noel";
      if (!rooms.has(room)) rooms.set(room, new Map());
      const r = rooms.get(room);
      if (r.size >= MAX_ROOM) { send(c, { t: "full" }); return; }
      c.room = room; r.set(c.id, c);
      send(c, { t: "welcome", id: c.id, room, players: others(c).map(pub) });
    }
    broadcast(c, { t: "join", id: c.id, name: c.name, g: c.g });
    return;
  }
  if (!c.room) return;
  if (m.t === "s") {
    c.state = { x: num(m.x), y: num(m.y), z: num(m.z), r: num(m.r), a: ANIMS.has(m.a) ? m.a : "Idle",
      m: m.m === "m" ? "m" : "k", mo: ["play", "end", "menu"].includes(m.mo) ? m.mo : "menu",
      sc: Math.max(0, Math.min(12, m.sc | 0)), cp: Math.max(0, Math.min(12, m.cp | 0)) };
    broadcast(c, Object.assign({ t: "s", id: c.id }, c.state));
  } else if (m.t === "emote") {
    if (ANIMS.has(m.e)) broadcast(c, { t: "emote", id: c.id, e: m.e });
  } else if (m.t === "ev") {
    if (m.kind === "finish") broadcast(c, { t: "ev", id: c.id, kind: "finish", sc: Math.max(0, Math.min(12, m.sc | 0)) });
  }
}

function drop(c) {
  if (c.closed) return;
  c.closed = true;
  try { c.sock.destroy(); } catch (e) {}
  if (c.room && rooms.has(c.room)) {
    const r = rooms.get(c.room);
    r.delete(c.id);
    for (const o of r.values()) send(o, { t: "bye", id: c.id });
    if (r.size === 0) rooms.delete(c.room);
  }
}

// ping régulier pour garder les connexions ouvertes et virer les fantômes
setInterval(() => {
  for (const r of rooms.values()) for (const c of r.values()) {
    if (!c.alive) { drop(c); continue; }
    c.alive = false;
    try { c.sock.write(frame(9, Buffer.alloc(0))); } catch (e) { drop(c); }
  }
}, 25000);

server.listen(PORT, () => console.log("Serveur multijoueur prêt sur le port " + PORT));
