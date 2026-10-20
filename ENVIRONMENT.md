# Treadstorm environment systems (maintainer notes)

Everything lives in `main.js`. Search for the names in `code font` below.

## Maps are data
- `THEMES[...]` — how a map looks: sky/fog/sun colours, `clouds`, falling `precip` (snow/ash/dust),
  `horizon` smoke columns, `sunFlicker`, `lightning: [minSecs, maxSecs]`, `embers`, `props: true`,
  and a `ground: {...}` palette (craters, tracks, patches, puddles). Missing keys fall back to `GROUND_DEFAULT`.
- `MAPS[...]` — layout: `spawns`, `playerStart`, and an `obstacles` list built with `ob(type, x, z, w, d, h)`.
  Helpers: `withRot(o, angle)`, `withSnow(o)`, `withSolid(o)`, `withY(o)` (stand on the bridge deck).
- `BUILDERS.<type>` — turns one obstacle entry into geometry. Props go through the shared `Batch`
  (`warBatch`): pieces are merged per material, so a whole map costs only a few draw calls.

## Add a new prop
1. Write `BUILDERS.myprop = (o) => { const B = warBatch, rng = rngFor(o); B.setFrame(o.x, o.z, o.rot || 0, o.y); ... }`
   using `B.box / B.cyl / B.geo / B.decal / B.fire`.
2. Call `B.collide(cx, cz, w, d)` **only** if tanks and shells must be blocked (this registers the same
   footprint list that collisions, bot pathfinding, the minimap and ricochets all read). Decoration gets no footprint.
3. Add `ob('myprop', x, z, w, d, h)` to a map's `obstacles`. Keep spawn points and the centre lanes clear.
   Everything is rebuilt and disposed with the `arena` group when the map changes.

## Add a new map
Add a theme in `THEMES`, a map in `MAPS`, nothing else: the menu card, minimap and bots pick it up.
Check spawns stay free (the game drops spawn points that land in cover).

## The Warzone overpass
`BUILDERS.bridge` with constants in `BR` (deck height, pier clearance, which span `collapse`s, length `end`).
Only the piers inside the arena are solid. The deck, trusses and everything standing on it are visual; tanks and
shells pass underneath. `updateBridgeFade` makes the deck-side materials see-through when the camera looks down through them.

## Graphics quality
`QUALITY` (Low / Balanced / High) sets render scale, FXAA, glow resolution, shadow size, particle and ash caps.
`applyQuality()` applies it live. Auto (`AUTO_MIN_FPS`) starts at Balanced and only steps down.
Measured on Intel HD: edge smoothing (MSAA) and the glow pass were the dominant costs, not scenery.

## Rules that keep it fast
- No extra scene lights: the warm fire light reuses the last slot of `lightPool` (a 5th light cost ~1.5 fps).
- One ground texture per map, only the current map's kept in memory.
- Bounded effects: fixed-size point buffers for smoke/fire/ash, `MAX_PARTICLES` cap.
