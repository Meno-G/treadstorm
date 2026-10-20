// How steady is the server's game loop? Starts a server, connects scripted players that drive and shoot, and
// reports the /health stall meters over time. (Used to tell "slow code" from "computer too busy".)
//   node server/tests/load-meter.mjs [players] [seconds] [map] [mode]
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';

const PLAYERS = Number(process.argv[2] || 2), SECONDS = Number(process.argv[3] || 20), MAP = process.argv[4] || 'quarry', MODE = process.argv[5] || 'ffa';
const ROOT = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 8821;
const server = spawn(process.execPath, ['dist-server/entry.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), MAP, MODE }, stdio: 'ignore' });
for (let i = 0; i < 60; i++) { try { await fetch(`http://127.0.0.1:${PORT}/health`); break; } catch { await sleep(150); } }
const clients = [];
for (let i = 0; i < PLAYERS; i++) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ t: 'join', name: 'Bot' + i }));
  clients.push(ws);
  setInterval(() => { // wander and shoot
    if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'in', k: { W: Math.random() < 0.85, A: Math.random() < 0.3, D: Math.random() < 0.3, Z: Math.random() < 0.3, Space: Math.random() < 0.5 } }));
  }, 300);
}
const rows = [];
for (let s = 0; s < SECONDS; s += 5) {
  await sleep(5000);
  const h = await (await fetch(`http://127.0.0.1:${PORT}/health`)).json();
  rows.push(h);
  console.log(`t=${s + 5}s  players=${h.players}  longest gap between snapshot sends ${h.snapGapMaxMs} ms   slowest game step ${h.stepMsMax} ms`);
}
const worst = Math.max(...rows.map((r) => r.snapGapMaxMs)), slowest = Math.max(...rows.map((r) => r.stepMsMax));
console.log(`\nworst gap ${worst} ms (steady is about 67), slowest step ${slowest} ms (a step has 33 ms of budget)`);
clients.forEach((c) => c.close()); server.kill(); process.exit(0);
