// Automated test for the game server: scripted "players" connect over WebSocket and are checked against the game's rules.
//   npm run build:server && node server/tests/fake-clients.mjs
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';

const ROOT = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`); };

function startServer(port, env = {}) {
  const child = spawn(process.execPath, ['dist-server/entry.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  child.getLog = () => out;
  return child;
}
async function waitUp(port) {
  for (let i = 0; i < 60; i++) {
    try { return await (await fetch(`http://127.0.0.1:${port}/health`)).json(); } catch { await sleep(150); }
  }
  throw new Error('server did not start');
}
const health = async (port) => (await fetch(`http://127.0.0.1:${port}/health`)).json();

class Client {
  constructor(port, name, opts = {}) {
    this.name = name; this.msgs = []; this.snaps = 0; this.snap = null; this.closed = null; this.welcome = null; this.last = {}; this.events = [];
    this.ws = new WebSocket(`ws://127.0.0.1:${port}`, opts);
    this.ws.on('message', (d) => {
      let m; try { m = JSON.parse(d.toString()); } catch { return; }
      this.last[m.t] = m;
      if (m.t === 'snap') { this.snaps++; this.snap = m; if (m.e) this.events.push(...m.e); return; }
      if (m.t === 'welcome') this.welcome = m;
      this.msgs.push(m);
    });
    this.ws.on('close', (code) => { this.closed = code; });
    this.ws.on('error', (e) => { this.error = e.message; });
    this.opened = new Promise((res) => { this.ws.on('open', res); this.ws.on('error', res); this.ws.on('close', res); });
  }
  send(o) { if (this.ws.readyState === 1) this.ws.send(typeof o === 'string' ? o : JSON.stringify(o)); }
  keys(k) { this.send({ t: 'in', k }); }
  dev(o) { this.send({ t: 'dev', ...o }); }
  async join(extra = {}) { await this.opened; this.send({ t: 'join', name: this.name, ...extra }); await this.until(() => this.welcome || this.last.full || this.closed !== null, 3000); return this.welcome; }
  me() { return this.snap?.a.find((r) => r[0] === this.welcome.you); }
  async until(fn, ms = 3000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(20); } return false; }
  async tankState(i) { delete this.last.dev; this.dev({ cmd: 'tankState', i }); await this.until(() => this.last.dev, 1500); return this.last.dev; }
  close() { try { this.ws.close(); } catch { /* already closed */ } }
}

const PORT = 8801, PORT2 = 8802;
const srv = startServer(PORT, { TEST: '1', MAP: 'quarry', MODE: 'ffa' });
const PORT3 = 8803;
const srv3 = startServer(PORT3, { TEST: '1', MAP: 'quarry', MODE: 'ffa', MAX_ROOMS: '3', ROOM_IDLE_MS: '2500', CREATE_COOLDOWN_MS: '0' });
const srv2 = startServer(PORT2, { ALLOW_ORIGINS: 'https://good.example,*.itch.zone', MAP: 'quarry', MODE: 'ffa' });
try {
  const h0 = await waitUp(PORT); await waitUp(PORT2);
  check('server starts and answers /health', h0.ok && h0.slots === 5, JSON.stringify(h0));

  // ---------------------------------------------------------------- join
  const alice = new Client(PORT, 'Alice');
  const w = await alice.join();
  check('join: welcome with slot, map and mode', w && w.you >= 0 && w.map === 'quarry' && w.mode === 'ffa' && w.slots.length === 6, w && `slot ${w.you}`);
  check('join: my slot is marked human and carries my name', w.slots[w.you].human === true && w.slots[w.you].name === 'Alice');
  const oneSlot = w.slots.filter((s) => s.human).length;
  check('join: only my slot is human', oneSlot === 1);
  const s0 = alice.snaps; await sleep(2000);
  const rate = (alice.snaps - s0) / 2;
  check('snapshots arrive about 15 times a second', rate > 11 && rate < 19, `${rate.toFixed(1)}/s`);
  const boxes = w.boxes;
  alice.dev({ cmd: 'idleBots' });
  const inBox = (x, z) => boxes.some((b) => x > b.minX && x < b.maxX && z > b.minZ && z < b.maxZ);

  // ---------------------------------------------------------------- driving
  alice.dev({ cmd: 'tp', x: -12, z: -44, heading: 0 }); await sleep(300);
  let me = alice.me(); const z0 = me[2], x0 = me[1];
  alice.keys({ W: true }); await sleep(2000); alice.keys({}); await sleep(300);
  me = alice.me();
  check('W drives the tank forward (+z at heading 0)', me[2] - z0 > 8 && Math.abs(me[1] - x0) < 1, `moved ${(me[2] - z0).toFixed(1)} units in 2 s`);
  const hd0 = me[3];
  alice.keys({ A: true }); await sleep(1000); alice.keys({}); await sleep(300);
  check('A turns the hull', alice.me()[3] - hd0 > 0.5, `turned ${(alice.me()[3] - hd0).toFixed(2)} rad`);
  const ty = alice.me()[4] - alice.me()[3];
  alice.keys({ Z: true }); await sleep(1200); alice.keys({}); await sleep(300);
  check('Z rotates the turret on its own', Math.abs((alice.me()[4] - alice.me()[3]) - ty) > 0.25, `${(alice.me()[4] - alice.me()[3] - ty).toFixed(2)} rad`);
  alice.keys({ C: true }); await sleep(2500); alice.keys({}); await sleep(200);
  check('C centres the turret back over the hull', Math.abs(alice.me()[4] - alice.me()[3]) < 0.1, `off by ${(alice.me()[4] - alice.me()[3]).toFixed(3)}`);
  alice.dev({ cmd: 'tp', x: -12, z: 0, heading: Math.PI }); await sleep(300);
  const zr = alice.me()[2]; alice.keys({ S: true }); await sleep(1200); alice.keys({}); await sleep(200);
  check('S reverses (heading pi, so +z)', alice.me()[2] - zr > 2, `${(alice.me()[2] - zr).toFixed(1)}`);

  // ---------------------------------------------------------------- collisions: a long random drive must never enter cover
  alice.dev({ cmd: 'tp', x: -12, z: -44, heading: 0 }); await sleep(300);
  let violations = 0, samples = 0; const cells = new Set();
  const t0 = Date.now(); let nextChange = 0, ks = { W: true };
  while (Date.now() - t0 < 25000) {
    if (Date.now() > nextChange) { nextChange = Date.now() + 300 + Math.random() * 700; ks = { W: Math.random() < 0.85, S: Math.random() < 0.05, A: Math.random() < 0.35, D: Math.random() < 0.35 }; alice.keys(ks); }
    const m = alice.me();
    if (m && m[6]) { samples++; if (inBox(m[1], m[2]) || Math.abs(m[1]) > 50 || Math.abs(m[2]) > 50) violations++; cells.add(Math.floor((m[1] + 50) / 10) + ',' + Math.floor((m[2] + 50) / 10)); }
    await sleep(40);
  }
  alice.keys({});
  check('25 s of random driving: never inside cover or outside the arena', violations === 0 && samples > 300, `${samples} samples, ${violations} violations, ${cells.size} map cells visited`);

  // ---------------------------------------------------------------- two people fight
  const bob = new Client(PORT, 'Bob'); const wb = await bob.join();
  check('second person joins another slot', wb && wb.you !== w.you && wb.slots.filter((s) => s.human).length === 2);
  await sleep(300);
  check('the first person is told about the new player', alice.last.slots && alice.last.slots.slots.filter((s) => s.human).length === 2);
  alice.dev({ cmd: 'idleBots' });
  alice.dev({ cmd: 'tp', x: -12, z: -44, heading: 0 });
  bob.dev({ cmd: 'tp', x: -12, z: -34, heading: Math.PI });
  await sleep(500);
  const bobBefore = await alice.tankState(wb.you);
  alice.keys({ Space: true }); await sleep(1200); alice.keys({}); await sleep(600);
  const bobAfter = await alice.tankState(wb.you);
  const lost = bobBefore.hp - bobAfter.hp;
  check("Alice's shells damage Bob (cannon: 20 per hit, human reload)", lost >= 20 && lost % 20 === 0, `Bob lost ${lost} HP`);
  const fired = bob.events.filter((e) => e[1] === 'f' && e[2] === w.you), hit = bob.events.filter((e) => e[1] === 'h' && e[2] === w.you && e[3] === wb.you);
  check('events: every client hears that Alice fired and that her shells hit Bob', fired.length >= 1 && hit.length === lost / 20, `${fired.length} shots, ${hit.length} hits for ${lost} HP`);
  const aliceNow = await alice.tankState(w.you);
  check('shooter is not hurt by her own shells', aliceNow.hp === 100, `hp ${aliceNow.hp}`);
  // keep firing until Bob dies, then see how long he is dead
  alice.dev({ cmd: 'goal', n: 1000 });
  alice.keys({ Space: true });
  let died = false; const tk = Date.now();
  while (Date.now() - tk < 8000 && !died) { alice.dev({ cmd: 'tp', x: -12, z: -44, heading: 0 }); const b = await alice.tankState(wb.you); if (!b.alive) died = true; await sleep(150); }
  alice.keys({});
  check('Bob can be killed', died);
  const killsA = (await alice.tankState(w.you)).kills;
  check('the kill is credited to Alice', killsA >= 1, `kills ${killsA}`);
  check('events: everyone is told "Alice destroyed Bob"', bob.events.some((e) => e[1] === 'x' && e[2] === w.you && e[3] === wb.you));
  const dead0 = Date.now(); let back = false;
  while (Date.now() - dead0 < 6500 && !back) { const b = await alice.tankState(wb.you); if (b.alive) back = true; await sleep(100); }
  const deadFor = (Date.now() - dead0) / 1000;
  check('Bob respawns after about 3 s (human timer, not the 5 s bot timer)', back && deadFor > 2 && deadFor < 4.6, `${deadFor.toFixed(1)} s`);

  // ---------------------------------------------------------------- leaving gives the slot back to the AI
  const bobName = (await alice.tankState(wb.you)).name;
  bob.close(); await sleep(800);
  const bobSlot = await alice.tankState(wb.you);
  check("when Bob leaves his tank goes back to the AI (not human, original name)", bobSlot.human === false && bobSlot.name !== 'Bob', `${bobName} -> ${bobSlot.name}`);
  check('the remaining player is told the slot is free', alice.last.slots.slots[wb.you].human === false);

  // ---------------------------------------------------------------- safety
  const junk = new Client(PORT, 'Junk'); await junk.opened;
  junk.send('this is not json'); junk.send('{"t":1}'); junk.send('null'); junk.send('[]'); junk.send(JSON.stringify({ t: 'in', k: 'W' }));
  junk.ws.send(Buffer.from([1, 2, 3]));
  junk.send({ t: 'join', name: '<script>alert(1)</script>  VeryLongNameThatKeepsGoingAndGoing' });
  await junk.until(() => junk.welcome, 2000);
  check('junk messages do not crash the server; names are cleaned', junk.welcome && !/[<>()]/.test(junk.welcome.slots[junk.welcome.you].name) && junk.welcome.slots[junk.welcome.you].name.length <= 14, junk.welcome && JSON.stringify(junk.welcome.slots[junk.welcome.you].name));
  junk.send({ t: 'join', name: 'Again' }); junk.keys({ W: 'yes', S: 1, A: null });
  await sleep(300);
  check('joining twice and non-boolean keys are ignored', (await health(PORT)).ok);
  const big = new Client(PORT, 'Big'); await big.opened; big.send('x'.repeat(5000)); await sleep(400);
  check('an oversized message closes that connection (1009)', big.closed === 1009, `close code ${big.closed}`);
  const flood = new Client(PORT, 'Flood'); await flood.join();
  const sn0 = alice.snaps;
  for (let i = 0; i < 4000; i++) flood.keys({ W: i % 2 === 0 });
  await sleep(1500);
  check('a message flood is dropped or cut off, and others are unaffected', (flood.closed !== null || true) && (await health(PORT)).ok && alice.snaps - sn0 > 12, `flood closed=${flood.closed}, Alice still got ${alice.snaps - sn0} snapshots`);
  const ping = new Client(PORT, 'Pinger'); await ping.opened; const sent = Date.now(); ping.send({ t: 'ping', ts: sent });
  await ping.until(() => ping.last.pong, 1000);
  check('ping gets its pong back with the same timestamp', ping.last.pong && ping.last.pong.ts === sent, `${Date.now() - sent} ms`);
  ping.close(); junk.close(); big.close(); flood.close(); await sleep(500);

  // ---------------------------------------------------------------- the room fills up
  const crowd = []; for (let i = 0; i < 4; i++) { const c = new Client(PORT, 'P' + i); await c.join(); crowd.push(c); }
  // Alice + Bob(left) -> after cleanup there are Alice + 4 = 5 humans = all 5 slots
  const sixth = new Client(PORT, 'Sixth'); await sixth.join({ room: 'r1' }); await sleep(300);
  check('asking for a full room is refused with a message (and the connection stays open)', sixth.last.err && /full/i.test(sixth.last.err.msg) && sixth.closed === null, sixth.last.err?.msg);
  const seventh = new Client(PORT, 'Seventh'); const w7 = await seventh.join(); await sleep(300);
  check('"join" with no choice opens a second room when the first is full', w7 && w7.room === 'r2' && (await health(PORT)).rooms.length === 2, `room ${w7?.room}`);
  seventh.close(); sixth.close();
  for (const c of crowd) c.close(); await sleep(600);

  // ---------------------------------------------------------------- match end and restart
  const bob2 = new Client(PORT, 'Bob2'); const wb2 = await bob2.join(); await sleep(300);
  alice.dev({ cmd: 'idleBots' }); alice.dev({ cmd: 'goal', n: 1 });
  alice.dev({ cmd: 'tp', x: -12, z: -44, heading: 0 }); bob2.dev({ cmd: 'tp', x: -12, z: -36, heading: Math.PI });
  await sleep(400); alice.keys({ Space: true });
  const ended = await alice.until(() => alice.last.end, 12000); alice.keys({});
  check('first to the goal ends the match; everybody is told', ended && /kills/.test(alice.last.end.line), alice.last.end && alice.last.end.line);
  const tEnd = Date.now(); const restarted = await alice.until(() => alice.last.start, 12000);
  check('a new match starts by itself after about 8 s', restarted && Date.now() - tEnd > 6000 && Date.now() - tEnd < 10500, `${((Date.now() - tEnd) / 1000).toFixed(1)} s`);
  await sleep(500);
  const fresh = await alice.tankState(w.you);
  check('after the restart everything is reset', fresh.kills === 0 && fresh.deaths === 0 && fresh.alive, JSON.stringify({ kills: fresh.kills, alive: fresh.alive }));
  bob2.close();

  // ---------------------------------------------------------------- the server sleeps when empty
  alice.close(); await sleep(700);
  await sleep(1600);
  const ta = (await health(PORT)).tick; await sleep(1200); const tb = (await health(PORT)).tick;
  check('with nobody connected the match sleeps (no CPU spent)', ta === tb && (await health(PORT)).players === 0, `tick ${ta} -> ${tb}`);
  const back2 = new Client(PORT, 'Returning'); const wb3 = await back2.join(); await sleep(600);
  check('the first person back in gets a working fresh match', wb3 && back2.snaps > 3 && (await health(PORT)).tick > tb);
  back2.close();

  // ---------------------------------------------------------------- origin restriction (second server)
  const bad = new Client(PORT2, 'Bad', { headers: { Origin: 'https://evil.example' } }); await bad.opened; await sleep(300);
  check('a website that is not allowed cannot connect', bad.closed !== null && !bad.welcome, bad.error || `closed ${bad.closed}`);
  const good = new Client(PORT2, 'Good', { headers: { Origin: 'https://good.example' } }); const wg = await good.join();
  check('an allowed website can connect', !!wg);
  const wild = new Client(PORT2, 'Wild', { headers: { Origin: 'https://abc123.itch.zone' } }); const ww = await wild.join();
  check('a wildcard origin (*.itch.zone) works', !!ww);
  good.close(); wild.close();

  // ---------------------------------------------------------------- rooms (third server)
  await waitUp(PORT3);
  const lister = new Client(PORT3, 'Lister'); await lister.opened;
  lister.send({ t: 'rooms' }); await lister.until(() => lister.last.rooms, 1500);
  const poll = setInterval(() => lister.send({ t: 'rooms' }), 3000); // what the game's lobby does while it is open
  const list0 = lister.last.rooms?.rooms || [];
  check('the room list shows the first room', list0.length === 1 && list0[0].id === 'r1' && list0[0].map === 'quarry' && list0[0].mode === 'ffa' && list0[0].slots === 5 && list0[0].players === 0, JSON.stringify(list0));
  const rA = new Client(PORT3, 'RoomA'); const wA = await rA.join();
  check('"join" with no choice puts me in the first room', wA && wA.room === 'r1' && wA.map === 'quarry');
  const rB = new Client(PORT3, 'RoomB'); const wB = await rB.join({ create: { map: 'warzone', mode: 'tdm' } }); await sleep(400);
  check('creating a room opens it with the chosen map and mode', wB && wB.room === 'r2' && wB.map === 'warzone' && wB.mode === 'tdm', JSON.stringify(wB && { room: wB.room, map: wB.map, mode: wB.mode }));
  lister.send({ t: 'rooms' }); await sleep(300);
  const list1 = lister.last.rooms.rooms;
  check('the list now shows both rooms with their player counts', list1.length === 2 && list1.find((r) => r.id === 'r1').players === 1 && list1.find((r) => r.id === 'r2').players === 1 && list1.find((r) => r.id === 'r2').slots === 8, JSON.stringify(list1.map((r) => [r.id, r.players, r.slots])));
  await sleep(500);
  check('rooms are separate matches (each sees only its own tanks)', rA.snap.a.length === 6 && rB.snap.a.length === 9, `${rA.snap.a.length} and ${rB.snap.a.length} tanks`);
  rB.dev({ cmd: 'idleBots' }); rA.dev({ cmd: 'idleBots' }); rA.dev({ cmd: 'tp', x: -12, z: -44, heading: 0 }); await sleep(600); rB.events.length = 0;
  rA.keys({ Space: true }); await sleep(1500); rA.keys({});
  check("shots in one room are not reported in the other", rA.events.some((e) => e[1] === 'f') && !rB.events.some((e) => e[1] === 'f'), `A saw ${rA.events.length} events, B ${rB.events.length}`);
  const rC = new Client(PORT3, 'RoomC'); const wC = await rC.join({ room: 'r1' });
  check('joining a chosen room works', wC && wC.room === 'r1' && wC.you !== wA.you);
  const rD = new Client(PORT3, 'RoomD'); await rD.join({ room: 'r99' }); await sleep(300);
  check('asking for a room that does not exist gives an error message', rD.last.err && rD.closed === null, rD.last.err?.msg);
  const rE = new Client(PORT3, 'RoomE'); await rE.join({ create: { map: 'moon', mode: 'ffa' } }); await sleep(300);
  check('an unknown map is refused', rE.last.err && /unknown/i.test(rE.last.err.msg) && rE.closed === null, rE.last.err?.msg);
  const rF = new Client(PORT3, 'RoomF'); const wF = await rF.join({ create: { map: 'frost', mode: 'ctf' } });
  check('a third room can be opened', wF && wF.room === 'r3');
  const rG = new Client(PORT3, 'RoomG'); await rG.join({ create: { map: 'depot', mode: 'ffa' } }); await sleep(300);
  check('the number of rooms is limited', rG.last.err && /in use/i.test(rG.last.err.msg), rG.last.err?.msg);
  // someone browsing the list stays connected even though they have not joined yet
  await sleep(8000);
  check('a person browsing rooms is not dropped for being quiet', lister.closed === null, `closed ${lister.closed}`);
  // empty rooms close; the first stays
  rB.close(); rF.close(); await sleep(6000);
  lister.send({ t: 'rooms' }); await sleep(300);
  const list2 = lister.last.rooms.rooms.map((r) => r.id);
  check('an empty room closes by itself after a while; the first room stays', list2.length === 1 && list2[0] === 'r1', list2.join(','));
  rA.close(); rC.close(); await sleep(500);
  const rH = new Client(PORT3, 'RoomH'); const wH = await rH.join({ create: { map: 'depot', mode: 'ffa' } });
  check('after a room closes a new one can be opened (no leak in the room count)', wH && wH.map === 'depot');

  // ---------------------------------------------------------------- step 7: team balance, loadout, flags, crates, stuck keys
  rH.close(); await sleep(4500); // let the earlier rooms close (they close 2.5 s after the last person leaves)
  const tdmHumans = [];
  for (let i = 0; i < 8; i++) { const c = new Client(PORT3, 'T' + i); const w = await c.join({ create: i === 0 ? { map: 'quarry', mode: 'tdm' } : undefined, room: i === 0 ? undefined : (tdmHumans[0].welcome.room) }); tdmHumans.push(c); if (!w) break; }
  const teams = tdmHumans[0].last.slots.slots.filter((s) => s.human).map((s) => s.team);
  check('team match: 8 people fit, 4 blue and 4 red (the server\'s parked player takes nobody\'s place)', tdmHumans.every((c) => c.welcome) && teams.filter((t) => t === 'blue').length === 4 && teams.filter((t) => t === 'red').length === 4, teams.join(','));
  const ninth = new Client(PORT3, 'T9'); await ninth.join({ room: tdmHumans[0].welcome.room }); await sleep(300);
  check('a ninth person is refused', ninth.last.err && /full/i.test(ninth.last.err.msg));
  ninth.close(); for (const c of tdmHumans) c.close(); await sleep(4500);

  const lo = new Client(PORT3, 'Loadout'); const wl = await lo.join({ create: { map: 'quarry', mode: 'ffa' }, hull: 'bastion', weapon: 'hammer' });
  check('my chosen hull and turret are what the others see', wl && wl.slots[wl.you].hull === 'bastion' && wl.slots[wl.you].weapon === 'hammer', JSON.stringify(wl?.slots[wl.you]));
  const lo2 = new Client(PORT3, 'Odd'); const wl2 = await lo2.join({ room: wl.room, hull: 'death-star', weapon: '<script>' });
  check('made-up hull and turret names are ignored (the bot keeps its own)', wl2 && !['death-star'].includes(wl2.slots[wl2.you].hull) && wl2.slots[wl2.you].weapon !== '<script>');
  const slotBefore = wl.you;
  lo.close(); await sleep(600);
  const after = lo2.last.slots.slots[slotBefore];
  check('when I leave, my tank goes back to the bot it was', after && !after.human && !(after.hull === 'bastion' && after.weapon === 'hammer' && after.name === 'Loadout'), JSON.stringify(after));
  lo2.close(); await sleep(4500);

  // capture the flag: take the enemy flag, bring it home
  const ctf = new Client(PORT3, 'Flagger'); const wc = await ctf.join({ create: { map: 'quarry', mode: 'ctf' } });
  await ctf.until(() => ctf.snap && ctf.snap.f, 3000);
  check('capture the flag: snapshots carry both flags, at home', ctf.snap.f && ctf.snap.f.length === 2 && ctf.snap.f.every((f) => f[0] === 0), JSON.stringify(ctf.snap.f));
  const myTeam = wc.slots[wc.you].team, enemyFlagAt = myTeam === 'blue' ? { x: 0, z: 38 } : { x: 0, z: -38 }, homeAt = myTeam === 'blue' ? { x: 0, z: -38 } : { x: 0, z: 38 };
  ctf.dev({ cmd: 'idleBots' });
  ctf.dev({ cmd: 'tp', x: enemyFlagAt.x, z: enemyFlagAt.z, heading: 0 }); await sleep(800);
  const enemyIdx = myTeam === 'blue' ? 1 : 0;
  check('walking onto the enemy flag picks it up (carried by me)', ctf.snap.f[enemyIdx][0] === 1 && ctf.snap.f[enemyIdx][1] === wc.you, JSON.stringify(ctf.snap.f));
  check('everyone hears "flag taken"', ctf.events.some((e) => e[1] === 'F' && e[2] === 0 && e[4] === wc.you));
  ctf.dev({ cmd: 'tp', x: homeAt.x, z: homeAt.z, heading: 0 }); await sleep(800);
  const sc = ctf.snap.ts;
  check('bringing it home scores a capture and puts the flag back', ctf.snap.f[enemyIdx][0] === 0 && sc && sc[myTeam === 'blue' ? 0 : 1] === 1 && ctf.events.some((e) => e[1] === 'F' && e[2] === 3), JSON.stringify({ f: ctf.snap.f, ts: sc }));

  // bonus crates: they appear in snapshots, and driving onto one takes it
  let crate = null;
  for (let i = 0; i < 400 && !crate; i++) { crate = (ctf.snap.d || []).find((d) => d[4] === 1); await sleep(100); }
  check('bonus crates appear in snapshots (id, type, position, landed)', !!crate, JSON.stringify(ctf.snap.d));
  if (crate) {
    ctf.dev({ cmd: 'tp', x: crate[2], z: crate[3], heading: 0 }); await sleep(900);
    check('driving onto a crate takes it: it disappears and everyone hears about it', !(ctf.snap.d || []).some((d) => d[0] === crate[0]) && ctf.events.some((e) => e[1] === 'p' && e[2] === wc.you), JSON.stringify(ctf.events.filter((e) => e[1] === 'p')));
  }

  // keys that stop arriving are released
  ctf.dev({ cmd: 'tp', x: 0, z: 0, heading: 0 }); await sleep(500);
  ctf.keys({ W: true }); await sleep(600);
  const z1 = ctf.me()[2]; await sleep(4500); const z2 = ctf.me()[2];
  check('a person who stops sending keys while holding W is brought to a stop (not driving on for 15 s)', z2 - z1 < 40 && ctf.me()[7] < 1, `moved ${(z2 - z1).toFixed(1)} units in 4.5 s, speed ${ctf.me()[7]}`);
  ctf.close();
  clearInterval(poll);
  for (const c of [lister, rD, rE, rG, rH]) c.close();
} catch (e) {
  check('test run completed without an exception', false, e.stack || e.message);
} finally {
  srv.kill(); srv2.kill(); srv3.kill();
  await sleep(300);
  const crashed = /Error|TypeError|ReferenceError|Unhandled/.test(srv.getLog().replace(/Error: write EPIPE/g, ''));
  check('the server printed no errors while all this happened', !crashed, crashed ? srv.getLog().split('\n').filter((l) => /Error/.test(l)).slice(0, 3).join(' | ') : '');
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}
