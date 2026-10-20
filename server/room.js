// One game room: a whole match running in its own thread. The lobby (entry.js) starts one of these per room and passes
// people's messages in and out, so a busy room can never slow down another one.
//
//   node dist-server/room.js --sim      just simulate a bot match and print statistics (no network)
//
// Lobby -> room messages:  {k:'join', cid, name}  {k:'in', cid, keys}  {k:'leave', cid}  {k:'dev', cid, m} (tests only)
// Room -> lobby messages:  {k:'to', cid, msg}  {k:'all', msg}  {k:'snap', msg}  {k:'full', cid}  {k:'status', tick, gapMax, stepMax}
// (msg is the finished JSON text; 'snap' may be dropped for a slow connection, 'all' goes to everyone in the room)
import './stubs/dom-shim.js';
import { parentPort, isMainThread, workerData } from 'node:worker_threads';
import { G } from '../main.js';

const TICK = 1 / 30; // the game is simulated 30 times a second
const SNAP_EVERY = 2; // ...and sent out every 2nd step
const RESTART_DELAY = 8000; // ms between the end of a match and the next one
const TEST = process.env.TEST === '1'; // enables the {t:'dev'} commands the automated tests use. Never on a public server.

if (isMainThread) {
  // ------------------------------------------------------------------ simulate only (no network)
  if (!process.argv.includes('--sim')) {
    console.log('This file is a game room started by entry.js. To simulate a bot match: node dist-server/room.js --sim');
    process.exit(0);
  }
  const sec = Number(process.env.SECONDS || 120);
  G.play();
  const t0 = performance.now();
  const dist = G.bots.map(() => 0), last = G.bots.map((b) => ({ x: b.pos.x, z: b.pos.z }));
  let inCover = 0;
  for (let i = 0; i < sec / TICK; i++) {
    G.player.hp = 100;
    G.step(TICK);
    G.bots.forEach((b, k) => {
      if (b.alive) {
        dist[k] += Math.hypot(b.pos.x - last[k].x, b.pos.z - last[k].z);
        if (G.pointInBox(b.pos.x, b.pos.z)) inCover++;
      }
      last[k] = { x: b.pos.x, z: b.pos.z };
    });
  }
  const ms = performance.now() - t0;
  console.log(JSON.stringify({
    map: process.env.MAP || 'default', mode: G.mode.id, simulatedSeconds: sec, wallMs: Math.round(ms), msPerStep: +(ms / (sec / TICK)).toFixed(2),
    realtimeFactor: +((sec * 1000) / ms).toFixed(1), tanks: G.tanks.length, botDistance: dist.map(Math.round),
    kills: G.tanks.map((t) => t.kills), deaths: G.tanks.map((t) => t.deaths), botSamplesInCover: inCover, boxes: G.boxes.length, spawns: G.SPAWNS.length,
  }));
  process.exit(0);
}

// ------------------------------------------------------------------ the room
const ROOM = workerData?.id || 'room';
G.setRoster(1); // team modes get an extra blue bot, because the parked player below takes a blue slot
G.play();
G.parkPlayer(); // a room has no player of its own: every tank is a bot or a connected person
G.takeEvents(); // start collecting what happens (shots, hits, kills) so the browsers can show it
const humans = new Map(); // cid -> tank
const lastIn = new Map(); // cid -> when its keys last arrived (a person who goes quiet has their keys released)
const post = (o) => parentPort.postMessage(o);
const toOne = (cid, obj) => post({ k: 'to', cid, msg: JSON.stringify(obj) });
const toAll = (obj) => post({ k: 'all', msg: JSON.stringify(obj) });
let tick = 0, pendingEvents = []; // events: [tick, type, ...] since the last snapshot was sent
let lastSnapAt = 0, gapMax = 0, stepMax = 0; // timing meters (reported to the lobby, then reset)

parentPort.on('message', (m) => {
  if (m.k === 'join') {
    const fresh = humans.size === 0;
    const tank = G.addHuman(m.name, m.hull, m.weapon);
    if (!tank) { post({ k: 'full', cid: m.cid }); return; }
    humans.set(m.cid, tank);
    lastIn.set(m.cid, performance.now());
    if (fresh) { G.restartMatch(); G.takeEvents(); pendingEvents = []; } // the first person in starts a fresh match (an empty room sleeps)
    toOne(m.cid, { t: 'welcome', you: G.tanks.indexOf(tank), map: G.currentMap.id, mode: G.mode.id, room: ROOM, tickRate: 30, slots: G.slotInfo(), ...(TEST ? { boxes: G.boxes } : {}) });
    toAll({ t: 'slots', slots: G.slotInfo() });
    post({ k: 'joined', cid: m.cid, name: tank.name, slot: G.tanks.indexOf(tank) });
    report(false);
  } else if (m.k === 'in') {
    const tank = humans.get(m.cid);
    if (tank && m.keys && typeof m.keys === 'object') { G.setHumanInput(tank, m.keys); lastIn.set(m.cid, performance.now()); }
  } else if (m.k === 'leave') {
    const tank = humans.get(m.cid);
    if (!tank) return;
    G.removeHuman(tank);
    humans.delete(m.cid);
    lastIn.delete(m.cid);
    toAll({ t: 'slots', slots: G.slotInfo() });
  } else if (TEST && m.k === 'dev') {
    // commands for the automated tests only
    const t = humans.get(m.cid), d = m.m;
    if (!t) return;
    if (d.cmd === 'tp') { t.pos.set(+d.x, 0, +d.z); t.heading = +d.heading || 0; t.turretYaw = t.heading; t.speed = 0; t.hp = t.maxHp; t.alive = true; t.setVisible(true); t.sync(); }
    else if (d.cmd === 'weapon') { t.setWeapon(String(d.id), {}); toAll({ t: 'slots', slots: G.slotInfo() }); }
    else if (d.cmd === 'goal') { G.mode.goal = +d.n; }
    else if (d.cmd === 'hp') { t.hp = +d.n; }
    else if (d.cmd === 'idleBots') { for (const b of G.bots) if (!b.remote) { b.alive = false; b.respawn = 1e9; b.setVisible(false); } }
    else if (d.cmd === 'tankState') {
      const o = G.tanks[+d.i];
      toOne(m.cid, { t: 'dev', cmd: 'tankState', i: +d.i, hp: o?.hp, alive: o?.alive, kills: o?.kills, deaths: o?.deaths, x: o?.pos.x, z: o?.pos.z, name: o?.name, human: !!o?.remote });
    }
  }
});

// ------------------------------------------------------------------ the game loop
let last = performance.now(), acc = 0, restartTimer = null;
setInterval(() => {
  const now = performance.now();
  const elapsed = Math.min(0.25, (now - last) / 1000);
  last = now;
  if (humans.size === 0) { acc = 0; lastSnapAt = 0; return; } // nobody here: the match sleeps
  acc += elapsed;
  while (acc >= TICK) {
    acc -= TICK;
    const t0 = performance.now();
    G.step(TICK);
    stepMax = Math.max(stepMax, performance.now() - t0);
    G.player.hp = 100; // the parked player takes no part
    tick++;
    for (const e of G.takeEvents()) pendingEvents.push([tick, ...e]);
    if (tick % 30 === 0) { // somebody who stopped sending (a stuck or hidden page) must not keep driving with the last keys
      for (const [cid, tank] of humans) if (performance.now() - lastIn.get(cid) > 2500) G.setHumanInput(tank, {});
    }
    if (tick % SNAP_EVERY === 0) {
      const nowMs = performance.now();
      if (lastSnapAt) gapMax = Math.max(gapMax, nowMs - lastSnapAt);
      lastSnapAt = nowMs;
      post({ k: 'snap', msg: JSON.stringify({ t: 'snap', k: tick, a: G.snapshot(), ...G.worldState(), ...(pendingEvents.length ? { e: pendingEvents } : {}) }) });
      pendingEvents = [];
    }
    if (G.state === 'won' && !restartTimer) {
      const line = G.hud.winTagline.textContent || '';
      toAll({ t: 'end', line });
      post({ k: 'log', text: `match over: ${line}` });
      restartTimer = setTimeout(() => {
        restartTimer = null;
        G.restartMatch();
        G.takeEvents();
        pendingEvents = [];
        toAll({ t: 'start', slots: G.slotInfo() });
      }, RESTART_DELAY);
    }
  }
}, 10);

// tell the lobby how the room is doing (and that it has finished starting up)
const report = (reset = true) => { post({ k: 'status', slots: G.bots.length, tick, gapMax: Math.round(gapMax), stepMax: +stepMax.toFixed(1) }); if (reset) { gapMax = 0; stepMax = 0; } };
report();
setInterval(report, 1000);
