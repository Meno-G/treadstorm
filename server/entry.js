// Treadstorm game server (Node): the lobby. People connect over WebSocket, see the list of rooms, and join one (or make a new
// one). Every room is a whole match running in its own thread (room.js), so rooms cannot slow each other down.
//
//   npm run server                 start on port 8787
//   PORT, MAP, MODE (the first room), MAX_ROOMS, ALLOW_ORIGINS are environment variables
//   node dist-server/room.js --sim just simulate a bot match and print statistics (no network)
//
// Protocol (JSON text messages). Client -> server:
//   { t:'rooms' }                                   ask for the list of rooms
//   { t:'join', name, hull?, weapon?, room? , create?:{map,mode} }  take a free tank: in room `room`, in a new room, or (neither) in the first room with space
//   { t:'in', k:{ W,S,A,D,Z,X,Space,C } }           the keys currently held (booleans)
//   { t:'ping', ts }
// Server -> client:
//   { t:'rooms', rooms:[{id,name,map,mode,players,slots}] }   { t:'err', msg }
//   { t:'welcome', you, map, mode, room, tickRate, slots:[...] }   or { t:'full' }
//   { t:'snap', k:tick, a:[[i,x,z,heading,turretYaw,hp,alive,speed,kills,deaths,buffs], ...], e:[[tick,type,...],...],
//     ts:[blue,red] (team modes), f:[[state,carrier,x,z,timer] x2] (capture the flag), d:[[id,type,x,z,landed,life],...] (crates) }   about 15 times a second
//        events e: ['f',slot] fired | ['c',slot] railgun charging | ['l',slot,on] flamethrower | ['h',attacker,victim,burn] hit | ['x',killer,victim] destroyed
//                  ['p',slot,type,x,z] crate taken | ['F',0|1|2|3,team,slot] flag taken/dropped/returned/captured
//   { t:'slots', slots }  { t:'end', line }  { t:'start', slots }  { t:'pong', ts }
import http from 'node:http';
import { Worker } from 'node:worker_threads';
import { WebSocketServer } from 'ws';

// ------------------------------------------------------------------ settings
const PORT = Number(process.env.PORT || 8787);
const TEST = process.env.TEST === '1'; // enables the {t:'dev'} commands the automated tests use. Never on a public server.
const ORIGINS = (process.env.ALLOW_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean); // empty = any website may connect
const DEFAULT_MAP = process.env.MAP || 'quarry', DEFAULT_MODE = process.env.MODE || 'ffa';
const MAX_ROOMS = Number(process.env.MAX_ROOMS || 4);
const ROOM_IDLE_MS = Number(process.env.ROOM_IDLE_MS || 30000); // an empty room (other than the first) closes after this long
const CREATE_COOLDOWN_MS = Number(process.env.CREATE_COOLDOWN_MS ?? 8000); // one new room per connection address in this time
const JOIN_TIMEOUT = 5000; // a connection that says nothing at all is dropped (asking for the room list keeps it alive)
const IDLE_TIMEOUT = 15000; // a connection that goes completely silent is dropped
const MSG_RATE = 60; // messages per second a client may send (inputs are about 20 a second)
const MAX_PAYLOAD = 1024; // bytes
const MAPS = { quarry: 'Quarry', depot: 'Depot', frost: 'Frostbite', warzone: 'Warzone' };
const MODES = { ffa: { name: 'Free-for-all', slots: 5 }, tdm: { name: 'Team Deathmatch', slots: 8 }, ctf: { name: 'Capture the Flag', slots: 8 } };
if (!MAPS[DEFAULT_MAP] || !MODES[DEFAULT_MODE]) { console.error(`Unknown MAP or MODE (${DEFAULT_MAP} / ${DEFAULT_MODE})`); process.exit(1); }

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const send = (c, obj) => { if (c.ws.readyState === 1) c.ws.send(JSON.stringify(obj)); };

// ------------------------------------------------------------------ rooms
const rooms = new Map(); // id -> { id, name, map, mode, slots, worker, clients:Set, tick, gapMax, stepMax, emptySince, first }
let roomCounter = 0;
const clientsById = new Map(); // cid -> client
let cidCounter = 0;

function createRoom(map, mode, first = false) {
  const id = `r${++roomCounter}`;
  const room = { id, name: `${MAPS[map]} - ${MODES[mode].name}`, map, mode, slots: MODES[mode].slots, clients: new Set(), tick: 0, gapMax: 0, stepMax: 0, emptySince: Date.now(), first, ready: false };
  room.worker = new Worker(new URL('./room.js', import.meta.url), { workerData: { id }, env: { ...process.env, MAP: map, MODE: mode, TEST: TEST ? '1' : '' } });
  room.worker.on('message', (m) => onRoomMessage(room, m));
  room.worker.on('error', (e) => log(`room ${id} crashed:`, e && e.stack || e));
  room.worker.on('exit', () => closeRoom(room, 'This room closed.'));
  rooms.set(id, room);
  log(`room ${id} opened: ${room.name}`);
  return room;
}

function closeRoom(room, why) {
  if (!rooms.delete(room.id)) return;
  for (const c of room.clients) { c.room = null; c.ws.close(1011, why); }
  room.clients.clear();
  room.worker.terminate();
  log(`room ${room.id} closed`);
}

function onRoomMessage(room, m) {
  if (m.k === 'to') { const c = clientsById.get(m.cid); if (c) { if (c.ws.readyState === 1) c.ws.send(m.msg); } }
  else if (m.k === 'all') { for (const c of room.clients) if (c.ws.readyState === 1) c.ws.send(m.msg); }
  else if (m.k === 'snap') { for (const c of room.clients) if (c.ws.readyState === 1 && c.ws.bufferedAmount < 65536) c.ws.send(m.msg); } // a slow connection just misses some
  else if (m.k === 'status') { room.ready = true; room.slots = m.slots; room.tick = m.tick; room.gapMax = Math.max(room.gapMax, m.gapMax); room.stepMax = Math.max(room.stepMax, m.stepMax); }
  else if (m.k === 'full') { // the room's own count said no (it was full after all)
    const c = clientsById.get(m.cid);
    if (c) { room.clients.delete(c); c.room = null; send(c, { t: 'full' }); c.ws.close(4001, 'full'); }
  } else if (m.k === 'joined') { const c = clientsById.get(m.cid); if (c) { c.name = m.name; log(`join  ${m.name} (${c.ip}) -> ${room.id} slot ${m.slot}; ${room.clients.size} in room`); } }
  else if (m.k === 'log') log(`${room.id} ${m.text}`);
}

const roomList = () => [...rooms.values()].map((r) => ({ id: r.id, name: r.name, map: r.map, mode: r.mode, players: r.clients.size, slots: r.slots }));

// the first room is always there, so "join" with no choice works
const startRoom = () => createRoom(DEFAULT_MAP, DEFAULT_MODE, true);
startRoom();

setInterval(() => { // empty rooms (other than the first) are closed after a while
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.clients.size > 0) room.emptySince = now;
    else if (!room.first && now - room.emptySince > ROOM_IDLE_MS) closeRoom(room, 'This room closed.');
  }
}, 2000);

// ------------------------------------------------------------------ network
const httpServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    const list = [...rooms.values()];
    const first = list.find((r) => r.first) || list[0];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true, players: list.reduce((n, r) => n + r.clients.size, 0), slots: first?.slots, tick: first?.tick, map: first?.map, mode: first?.mode,
      rooms: list.map((r) => ({ id: r.id, name: r.name, map: r.map, mode: r.mode, players: r.clients.size, slots: r.slots, tick: r.tick })),
      snapGapMaxMs: Math.max(0, ...list.map((r) => r.gapMax)), stepMsMax: Math.max(0, ...list.map((r) => r.stepMax)),
    }));
    for (const r of list) { r.gapMax = 0; r.stepMax = 0; }
    return;
  }
  res.writeHead(404);
  res.end('Treadstorm game server');
});
const wss = new WebSocketServer({
  server: httpServer,
  maxPayload: MAX_PAYLOAD,
  verifyClient: ({ origin }) => ORIGINS.length === 0 || ORIGINS.includes(origin) || ORIGINS.some((o) => o.startsWith('*.') && origin && origin.endsWith(o.slice(1))),
});

function cleanName(raw) {
  const s = String(raw ?? '').normalize('NFKC').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 14);
  return s || 'Player';
}

const lastCreate = new Map(); // address -> time of the last room it opened

// which room does this join request mean? returns a room, or null (after telling the client why)
function pickRoom(c, m) {
  if (typeof m.room === 'string') {
    const room = rooms.get(m.room);
    if (!room) { send(c, { t: 'err', msg: 'That room has closed. Pick another.' }); return null; }
    if (room.clients.size >= room.slots) { send(c, { t: 'err', msg: 'That room is full. Pick another.' }); return null; }
    return room;
  }
  if (m.create && typeof m.create === 'object') {
    const { map, mode } = m.create;
    if (!Object.hasOwn(MAPS, map) || !Object.hasOwn(MODES, mode)) { send(c, { t: 'err', msg: 'Unknown map or mode.' }); return null; }
    if (rooms.size >= MAX_ROOMS) { send(c, { t: 'err', msg: 'All rooms are in use. Join one of them.' }); return null; }
    const last = lastCreate.get(c.ip) || 0;
    if (Date.now() - last < CREATE_COOLDOWN_MS) { send(c, { t: 'err', msg: 'Wait a few seconds before opening another room.' }); return null; }
    lastCreate.set(c.ip, Date.now());
    return createRoom(map, mode);
  }
  // no choice: the first room with space
  const room = [...rooms.values()].find((r) => r.clients.size < r.slots);
  if (room) return room;
  if (rooms.size < MAX_ROOMS) return createRoom(DEFAULT_MAP, DEFAULT_MODE);
  send(c, { t: 'full' });
  c.ws.close(4001, 'full');
  return null;
}

wss.on('connection', (ws, req) => {
  const c = { id: ++cidCounter, ws, room: null, name: '', lastSeen: Date.now(), tokens: MSG_RATE, tokenAt: Date.now(), flood: 0, ip: req.socket.remoteAddress };
  clientsById.set(c.id, c);
  let joinTimer;
  const armJoinTimer = (ms) => { clearTimeout(joinTimer); joinTimer = setTimeout(() => { if (!c.room) ws.close(4000, 'no hello'); }, ms); };
  armJoinTimer(JOIN_TIMEOUT);

  ws.on('message', (data, isBinary) => {
    // rate limit: a bucket of MSG_RATE messages that refills over a second
    const now = Date.now();
    c.tokens = Math.min(MSG_RATE, c.tokens + ((now - c.tokenAt) / 1000) * MSG_RATE);
    c.tokenAt = now;
    c.lastSeen = now;
    if (c.tokens < 1) {
      if (++c.flood > 200) ws.close(1008, 'too many messages');
      return;
    }
    c.tokens -= 1;
    if (isBinary) return;
    let m;
    try { m = JSON.parse(data.toString()); } catch { return; }
    if (!m || typeof m !== 'object' || typeof m.t !== 'string') return;

    if (m.t === 'in') {
      if (c.room && m.k && typeof m.k === 'object') c.room.worker.postMessage({ k: 'in', cid: c.id, keys: m.k });
    } else if (m.t === 'ping') {
      send(c, { t: 'pong', ts: typeof m.ts === 'number' ? m.ts : 0 });
    } else if (m.t === 'rooms') {
      if (!c.room) armJoinTimer(JOIN_TIMEOUT * 2); // somebody looking at the list is not a stranger who forgot to say hello
      send(c, { t: 'rooms', rooms: roomList() });
    } else if (m.t === 'join') {
      if (c.room) return;
      const room = pickRoom(c, m);
      if (!room) return;
      clearTimeout(joinTimer);
      c.room = room;
      room.clients.add(c);
      room.worker.postMessage({ k: 'join', cid: c.id, name: cleanName(m.name), hull: String(m.hull ?? '').slice(0, 16), weapon: String(m.weapon ?? '').slice(0, 16) });
    } else if (TEST && m.t === 'dev' && c.room) {
      c.room.worker.postMessage({ k: 'dev', cid: c.id, m });
    }
  });

  ws.on('close', () => {
    clearTimeout(joinTimer);
    clientsById.delete(c.id);
    const room = c.room;
    if (room) {
      room.clients.delete(c);
      room.worker.postMessage({ k: 'leave', cid: c.id });
      log(`leave ${c.name}; ${room.clients.size} in ${room.id}`);
    }
  });
  ws.on('error', () => {});
});

// drop connections that went silent (clients send inputs / pings all the time while connected)
setInterval(() => {
  const now = Date.now();
  for (const c of clientsById.values()) if (now - c.lastSeen > IDLE_TIMEOUT) c.ws.terminate();
}, 3000);

httpServer.listen(PORT, () => log(`Treadstorm server on :${PORT}  first room: ${DEFAULT_MAP} / ${DEFAULT_MODE}  max rooms: ${MAX_ROOMS}${TEST ? '  TEST MODE' : ''}`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { log('shutting down'); wss.close(); httpServer.close(); for (const r of rooms.values()) r.worker.terminate(); process.exit(0); });
