# Treadstorm game server

The game's own rules (`main.js`) run in Node with no screen. Instead of splitting the rules out of the graphics code,
`server/stubs/` supplies do-nothing stand-ins for the things only a browser has:

- `dom-shim.js`: fake `document`, `window`, `localStorage`, canvas 2D contexts (settings come from env vars `MAP`, `MODE`)
- `three.js`: the real three.js, but `WebGLRenderer` is a dummy
- `composer.js`: dummy post-processing passes, model loaders and shaders

`vite.server.config.js` swaps these in when building for Node. `main.js` ends with `export const G = {...}`: the hooks
the server and tests use (unused in the browser). A person on the network drives a bot's tank through
`G.addHuman / setHumanInput / removeHuman`, using the same `driveTank()` code as your own tank.

## Run
```
npm run server                     # build + start on port 8787 (the lobby; the first room is Quarry free-for-all)
PORT=9000 MAP=warzone MODE=tdm npm run server
npm run sim                        # build + simulate a bot match, print stats (no network)
node server/tests/fake-clients.mjs # 52 automated checks with scripted players (after npm run build:server)
```
Environment: `PORT` (8787), `MAP` (quarry|depot|frost|warzone) and `MODE` (ffa|tdm|ctf) for the first room,
`MAX_ROOMS` (4), `ROOM_IDLE_MS` (30000: an empty room other than the first closes after this), `CREATE_COOLDOWN_MS` (8000: one new room per address),
`ALLOW_ORIGINS` (comma list such as `https://you.itch.io,*.itch.zone`; empty = any website may connect),
`TEST=1` (turns on `dev` commands for the tests only: NEVER on a public server).
`GET /health` returns `{ok, players, slots, tick, map, mode, rooms:[...]}` for hosting health checks.

## Rooms
`entry.js` is the lobby: it owns the connections (rate limits, names, origins) and starts one `room.js` thread per room, so
a busy room cannot slow another down. Messages are passed in and out as finished text, so the lobby does almost no work.
A room is a whole match (map + mode, its bots, its humans). It sleeps while empty; the first room stays, others close
30 s after the last person leaves. A connection that has not joined yet may ask `{t:'rooms'}` (the game's room list does
this every 3 s) which also keeps it from being dropped as a stranger.

Client to server: `{t:'rooms'}`; `{t:'join', name}` (first room with space, opening a copy if all are full);
`{t:'join', name, room:'r2'}`; `{t:'join', name, create:{map, mode}}`. Server to client: `{t:'rooms', rooms:[{id,name,map,mode,players,slots}]}`,
`{t:'err', msg}` (room closed/full/unknown map/limit reached; the connection stays open), then the usual `welcome` (now with `room`).

## Protocol (JSON text, one message per WebSocket frame)
Client to server: `{t:'join', name}` first; then `{t:'in', k:{W,S,A,D,Z,X,Space,C}}` (booleans, send on change and about
20 times a second); `{t:'ping', ts}`.
Server to client: `{t:'welcome', you, map, mode, tickRate, slots}` or `{t:'full'}`; `{t:'snap', k, a:[[i,x,z,heading,turretYaw,hp,alive,speed,kills,deaths],...]}`
about 15 times a second; `{t:'slots', slots}` when someone joins or leaves; `{t:'end', line}` and `{t:'start', slots}` around matches; `{t:'pong', ts}`.

## Safety built in
Messages over 1 KB close the connection; 60 messages a second per client (flooders are dropped, then cut off);
names are cleaned to letters, digits and `_ . -` (14 characters); silent connections are dropped after 15 s; only
booleans are accepted as keys; the server is authoritative (clients can only press keys); origins can be restricted.
The server sleeps (no CPU) while nobody is connected.

## Events in snapshots
A snapshot may carry `e: [[tick, type, ...], ...]`: `['f', slot]` fired, `['c', slot]` railgun charging,
`['l', slot, on]` flamethrower on/off, `['h', attacker, victim, burn]` damage dealt, `['x', killer, victim]` destroyed.
The browser replays them with its own effects and sounds, delayed to match the (slightly past) moment it draws.
Health, kills and deaths always come from the snapshot rows, never from the browser's own simulation.

## Your own tank (prediction)
The browser drives your own tank itself, at once, from your keys (`driveBody`, the same movement code the server runs).
Each snapshot says where the server had it: the browser compares that with where its own history had the tank at the
matching moment (server time + clock offset - round trip), and moves the tank 30% of the way there (or jumps if it is more
than 4 units off, e.g. after a respawn). Differences under 0.3 units are ignored. Your own shots, hits and death show as soon as
the browser hears of them; everything about other players is shown a short, adaptive moment in the past.

## Capture the flag, crates, team balance, loadout
Snapshots also carry `ts` (team scores), `f` (both flags: state 0 home / 1 carried / 2 dropped, carrier slot, x, z, return timer) and
`d` (bonus crates: id, type, x, z, landed, life); each tank row ends with its buff timers (armor, damage, nitro) or 0. Events `p` (crate taken)
and `F` (flag taken / dropped / returned / captured) tell the browser what to show. The browser draws all of it and decides nothing.
Team modes get one extra blue bot so the server's parked player slot does not leave blue a tank short (8 people fit, 4 against 4).
`join` may carry `hull` and `weapon`: the tank and turret you chose in the garage (base strength; unknown names are ignored).
When you leave, the tank goes back to the bot it was. If a person's keys stop arriving for 2.5 s (a stuck or hidden page) their keys are released.

## Status
All seven steps are done: headless game, people over the network, browser client, lobby and rooms, own-tank prediction,
deployment files (waiting for a host account), capture the flag / crates / team balance / loadout / stuck-key release.
Tests: `node server/tests/fake-clients.mjs` (64 checks), `node server/tests/load-meter.mjs [players] [seconds] [map] [mode]`.
