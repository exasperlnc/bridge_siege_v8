// Authoritative game server: serves the built client and runs rooms over WebSocket.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { randomBytes } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import { applyActions, newGame, type GameState, type Player } from '../src/engine/index.ts';
import type { ClientMsg, ServerMsg } from '../src/engine/protocol.ts';

const PORT = Number(process.env.PORT ?? 8787);
const DIST = join(import.meta.dirname, '..', 'dist');
const ROOM_TTL_MS = 24 * 60 * 60 * 1000;

interface Seat { name: string; token: string; sockets: Set<WebSocket> }
interface Room { code: string; seats: (Seat | null)[]; state: GameState | null; rev: number; touched: number; games: number }

const rooms = new Map<string, Room>();
const socketSeat = new WeakMap<WebSocket, { room: Room; seat: Player }>();

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode() {
  for (;;) {
    const b = randomBytes(5);
    const c = Array.from(b, (x) => CODE_CHARS[x % CODE_CHARS.length]).join('');
    if (!rooms.has(c)) return c;
  }
}
const cleanName = (n: unknown, fb: string) => (typeof n === 'string' && n.trim() ? n.trim().slice(0, 20) : fb);

function send(ws: WebSocket, m: ServerMsg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
}

function broadcast(room: Room) {
  // Undo snapshots stay on the server; clients only need to know an active use exists.
  const state = room.state && { ...room.state, undo: [] };
  const msg: ServerMsg = {
    t: 'room',
    room: room.code,
    rev: room.rev,
    seats: room.seats.map((s) => s && { name: s.name, connected: s.sockets.size > 0 }),
    state,
  };
  const data = JSON.stringify(msg);
  for (const s of room.seats) if (s) for (const ws of s.sockets) if (ws.readyState === ws.OPEN) ws.send(data);
}

function attach(ws: WebSocket, room: Room, seat: Player) {
  const prev = socketSeat.get(ws);
  if (prev) prev.room.seats[prev.seat]?.sockets.delete(ws);
  room.seats[seat]!.sockets.add(ws);
  socketSeat.set(ws, { room, seat });
  send(ws, { t: 'joined', room: room.code, seat, token: room.seats[seat]!.token });
}

function startGame(room: Room) {
  const first = (room.games % 2) as Player;
  room.state = newGame([room.seats[0]!.name, room.seats[1]!.name], first);
  room.games++;
  room.rev++;
}

function handle(ws: WebSocket, m: ClientMsg) {
  switch (m.t) {
    case 'ping':
      return send(ws, { t: 'pong' });
    case 'create': {
      const room: Room = { code: newCode(), seats: [null, null], state: null, rev: 0, touched: Date.now(), games: 0 };
      room.seats[0] = { name: cleanName(m.name, 'Player 1'), token: randomBytes(16).toString('hex'), sockets: new Set() };
      rooms.set(room.code, room);
      attach(ws, room, 0);
      return broadcast(room);
    }
    case 'join': {
      const room = rooms.get(String(m.room ?? '').toUpperCase());
      if (!room) return send(ws, { t: 'error', msg: 'Room not found. Check the code.' });
      room.touched = Date.now();
      const existing = room.seats.findIndex((s) => s && m.token && s.token === m.token);
      if (existing >= 0) {
        attach(ws, room, existing as Player);
        return broadcast(room);
      }
      const free = room.seats.findIndex((s) => s === null);
      if (free < 0) return send(ws, { t: 'error', msg: 'That room is full.' });
      room.seats[free] = { name: cleanName(m.name, `Player ${free + 1}`), token: randomBytes(16).toString('hex'), sockets: new Set() };
      attach(ws, room, free as Player);
      if (!room.state && room.seats.every(Boolean)) startGame(room);
      return broadcast(room);
    }
    case 'act': {
      const ctx = socketSeat.get(ws);
      if (!ctx) return send(ws, { t: 'error', msg: 'Join a room first.' });
      const { room, seat } = ctx;
      if (!room.state) return send(ws, { t: 'error', msg: 'Waiting for an opponent.' });
      if (!Array.isArray(m.actions) || m.actions.length === 0 || m.actions.length > 8) return send(ws, { t: 'error', msg: 'Bad request.' });
      const r = applyActions(room.state, seat, m.actions);
      if (!r.ok) { send(ws, { t: 'error', msg: r.error }); return broadcast(room); }
      room.state = r.state;
      room.rev++;
      room.touched = Date.now();
      return broadcast(room);
    }
    case 'rematch': {
      const ctx = socketSeat.get(ws);
      if (!ctx?.room.state || ctx.room.state.winner === null) return;
      startGame(ctx.room);
      return broadcast(ctx.room);
    }
  }
}

// ---------- static file serving ----------

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
};

const http = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/healthz') { res.end('ok'); return; }
  let p = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
  let file = join(DIST, p);
  try {
    if (!file.startsWith(DIST) || !(await stat(file)).isFile()) file = join(DIST, 'index.html');
    const body = await readFile(file);
    const ext = extname(file);
    res.writeHead(200, {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'cache-control': p.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    res.end(body);
  } catch {
    res.writeHead(404).end('Not found. Run `npm run build` first, or use `npm run dev`.');
  }
});

const wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: 64 * 1024 });
wss.on('connection', (ws) => {
  ws.on('message', (data) => {
    let m: ClientMsg;
    try { m = JSON.parse(String(data)); } catch { return; }
    try { handle(ws, m); } catch (e) { console.error(e); send(ws, { t: 'error', msg: 'Server error.' }); }
  });
  ws.on('close', () => {
    const ctx = socketSeat.get(ws);
    if (!ctx) return;
    ctx.room.seats[ctx.seat]?.sockets.delete(ws);
    broadcast(ctx.room);
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [code, r] of rooms) {
    const live = r.seats.some((s) => s && s.sockets.size > 0);
    if (!live && now - r.touched > ROOM_TTL_MS) rooms.delete(code);
  }
}, 10 * 60 * 1000).unref();

http.listen(PORT, () => console.log(`Bridge Siege server on http://localhost:${PORT}`));
