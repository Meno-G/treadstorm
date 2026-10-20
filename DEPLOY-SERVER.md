# Putting the Treadstorm game server online

The game page (itch.io) only shows the game. Online matches need the **game server** running somewhere that is always on.
Everything below is ready in this folder; what is left is creating an account on a host, which only you can do.

## What you need from a host
- it can run **Node 20+** (or Docker, the `Dockerfile` is included)
- it gives you a **secure address** (`https://...`, which means players connect with `wss://...`). itch.io is https, so a
  plain `ws://` server will be blocked by the browser. Render, Fly.io, Railway and Koyeb all give https automatically.
- WebSocket support (all of the above have it)

## Easiest: Render.com (free plan)
1. Put this folder on GitHub (a private repo is fine; `.gitignore` already skips the big folders).
2. On render.com: New > Blueprint > pick the repo. It reads `render.yaml` (edit `ALLOW_ORIGINS` first: your itch page is
   `https://YOUR-NAME.itch.io`, and the game itself runs from `*.itch.zone`).
3. When it is live you get `https://treadstorm-server-xxxx.onrender.com`. Check `https://.../health` shows `"ok":true`.
4. Your server address for the game is `wss://treadstorm-server-xxxx.onrender.com` (same name, `wss://`).

Free plans sleep when nobody visits (the first person waits ~30-60 s) and have little CPU: keep `MAX_ROOMS` at 1-2.
Paid plans or a VPS (about 5 USD a month) are much smoother: `docker build -t treadstorm . && docker run -p 8787:8787 -e ALLOW_ORIGINS="*.itch.zone,https://YOU.itch.io" treadstorm`,
then put Caddy or nginx in front for https.

## Make the itch.io build know the address
```
set VITE_SERVER_URL=wss://treadstorm-server-xxxx.onrender.com      (PowerShell: $env:VITE_SERVER_URL="wss://...")
npx vite build
```
then rebuild the zip (the same `makezip.py` step as before) and upload it to itch.io. The menu's Online box will already
contain that address, so players only type a name and press Join online (or Rooms).
Anyone can also try another server with `?server=wss://host` at the end of the page address.

## Settings (environment variables on the host)
`PORT` (hosts set this themselves), `MAP`/`MODE` (the first room), `MAX_ROOMS` (4), `ALLOW_ORIGINS`, `ROOM_IDLE_MS`, `CREATE_COOLDOWN_MS`.
Never set `TEST=1` on a public server.

## Checking it works
Open the game page, Rooms: the list should show "Quarry - Free-for-all". Join from two browsers and shoot each other.
`/health` shows players per room and the worst recent snapshot gap (steady is about 70 ms) and slowest game step (should stay under 30 ms).
