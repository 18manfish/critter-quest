#!/usr/bin/env node
/*
  Critter Quest multiplayer server. No dependencies: needs only Node.js 18 or newer.

    node server.js                 serves the game on http://localhost:8080
    PORT=9000 node server.js       another port
    GAME=path/to/game.html node server.js

  Open the printed address in two browsers (or send it to friends on your network) and play together.
  The game connects back to ws://<host>/ws by itself. To keep separate worlds, add ?world=name
  to the page address; players only see others in the same world.

  What the server does: every player sends one small "presence" object (name, look, area, position,
  lead critter, challenges and battle choices). The server keeps each player's object, checks its size
  and shape, and sends everyone in the same world the list of all players whenever something changes.
  Battles between players run in lockstep in the two games: both get both teams and a shared random
  seed, publish their choice for each turn here, and resolve the turn identically.
*/
'use strict';
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || Number(process.argv[2]) || 8080;
const GAME = process.env.GAME || path.join(__dirname, 'critter-quest-3d.html');
const MAX_PLAYERS = 64;                 // per world
const MAX_PRESENCE = 4096;              // bytes of JSON per player
const MAX_FRAME = 16384;                // bytes per WebSocket message
const MAX_MSGS_PER_SEC = 40;
const BROADCAST_MS = 50;                // at most 20 player lists a second per world

/* ---------------- HTTP: the game page ---------------- */
const INJECT = `<script>window.CQ_SERVER = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws' +
  (new URLSearchParams(location.search).get('world') ? '?world=' + encodeURIComponent(new URLSearchParams(location.search).get('world')) : '');</script>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/' || url.pathname === '/index.html') {
    fs.readFile(GAME, 'utf8', (err, html) => {
      if (err) { res.writeHead(500, { 'content-type': 'text/plain' }); res.end(`Cannot read the game file ${GAME}\n`); return; }
      const page = html.includes('<head>') ? html.replace('<head>', '<head>\n' + INJECT) : INJECT + html;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(page);
    });
  } else if (url.pathname === '/status') {
    const out = {};
    for (const [name, w] of worlds) out[name] = w.size;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ players: out }));
  } else {
    res.writeHead(404, { 'content-type': 'text/plain' }); res.end('Not found\n');
  }
});

/* ---------------- worlds and players ---------------- */
const worlds = new Map();               // world name -> Map(id -> player)
const pending = new Set();              // worlds with a player list waiting to go out

function scheduleBroadcast(world) {
  if (pending.has(world)) return;
  pending.add(world);
  setTimeout(() => {
    pending.delete(world);
    const players = worlds.get(world);
    if (!players) return;
    const msg = JSON.stringify({ t: 'peers', peers: [...players.values()].filter(p => p.ready).map(p => ({ id: p.id, p: p.presence })) });
    for (const p of players.values()) if (p.ready) sendText(p.socket, msg);
  }, BROADCAST_MS);
}

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;
// merge a presence patch: top-level null removes a field; refuse anything too big or oddly shaped
function mergePresence(player, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return 'presence must be an object';
  const next = { ...player.presence };
  for (const [k, v] of Object.entries(patch)) {
    if (!KEY_RE.test(k)) return 'bad field name';
    if (v === null) delete next[k]; else next[k] = v;
  }
  if (Object.keys(next).length > 32) return 'too many fields';
  if (Buffer.byteLength(JSON.stringify(next)) > MAX_PRESENCE) return 'presence too large';
  player.presence = next;
  return null;
}

function onMessage(player, text) {
  const now = Date.now();
  if (now - player.windowStart > 1000) { player.windowStart = now; player.count = 0; }
  if (++player.count > MAX_MSGS_PER_SEC) return;                      // too fast: drop
  let m;
  try { m = JSON.parse(text); } catch (e) { return; }
  if (!m || typeof m !== 'object') return;
  if (m.t === 'hello' || m.t === 'p') {
    const err = mergePresence(player, m.p || {});
    if (err) { sendText(player.socket, JSON.stringify({ t: 'error', message: err })); return; }
    if (m.t === 'hello' && !player.ready) { player.ready = true; sendText(player.socket, JSON.stringify({ t: 'welcome', id: player.id })); }
    scheduleBroadcast(player.world);
  }
}

/* ---------------- WebSocket (RFC 6455), just what the game needs ---------------- */
server.on('upgrade', (req, socket) => {
  const url = new URL(req.url, 'http://x');
  const key = req.headers['sec-websocket-key'];
  if (url.pathname !== '/ws' || !key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') { socket.destroy(); return; }
  const world = (url.searchParams.get('world') || 'main').replace(/[^a-z0-9_-]/gi, '').slice(0, 32) || 'main';
  if (!worlds.has(world)) worlds.set(world, new Map());
  const players = worlds.get(world);
  if (players.size >= MAX_PLAYERS) { socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n'); return; }

  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.setNoDelay(true);

  const player = { id: crypto.randomBytes(6).toString('hex'), world, socket, presence: {}, ready: false, count: 0, windowStart: 0, alive: true };
  players.set(player.id, player);
  let buffer = Buffer.alloc(0);

  const leave = () => {
    if (!players.has(player.id)) return;
    players.delete(player.id);
    if (!players.size) worlds.delete(world); else scheduleBroadcast(world);
  };
  socket.on('close', leave);
  socket.on('error', leave);
  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 2) return;
      const fin = buffer[0] & 0x80, op = buffer[0] & 0x0f, masked = buffer[1] & 0x80;
      let len = buffer[1] & 0x7f, off = 2;
      if (len === 126) { if (buffer.length < 4) return; len = buffer.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buffer.length < 10) return; const big = buffer.readBigUInt64BE(2); if (big > BigInt(MAX_FRAME)) return close(1009); len = Number(big); off = 10; }
      if (len > MAX_FRAME || !masked || !fin) return close(1009);           // clients must mask; no fragments needed
      if (buffer.length < off + 4 + len) return;
      const mask = buffer.subarray(off, off + 4), data = Buffer.from(buffer.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      buffer = buffer.subarray(off + 4 + len);
      if (op === 0x1) onMessage(player, data.toString('utf8'));
      else if (op === 0x8) return close(1000);
      else if (op === 0x9) sendFrame(socket, 0xA, data);                    // ping -> pong
      else if (op === 0xA) player.alive = true;                             // pong
    }
  });
  function close(code) {
    const b = Buffer.alloc(2); b.writeUInt16BE(code);
    try { sendFrame(socket, 0x8, b); } catch (e) {}
    socket.end(); leave();
  }
});

function sendFrame(socket, op, payload) {
  if (socket.destroyed) return;
  const len = payload.length;
  const head = len < 126 ? Buffer.from([0x80 | op, len])
    : len < 65536 ? Buffer.from([0x80 | op, 126, len >> 8, len & 255])
    : (() => { const h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(len), 2); return h; })();
  socket.write(Buffer.concat([head, payload]));
}
const sendText = (socket, text) => sendFrame(socket, 0x1, Buffer.from(text, 'utf8'));

// drop players whose connection died without closing
setInterval(() => {
  for (const players of worlds.values()) for (const p of players.values()) {
    if (!p.alive) { p.socket.destroy(); continue; }
    p.alive = false;
    sendFrame(p.socket, 0x9, Buffer.alloc(0));
  }
}, 25000);

server.listen(PORT, () => {
  console.log(`Critter Quest server on http://localhost:${PORT}`);
  console.log(`Game file: ${GAME}${fs.existsSync(GAME) ? '' : '  (missing! put critter-quest-3d.html next to server.js)'}`);
  console.log('Open that address in two browser windows, or share your computer\'s address with friends on your network.');
});
