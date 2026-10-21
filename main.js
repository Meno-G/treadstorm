import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

// ---------- Tuning ----------
const ARENA = 50; // playable area is -ARENA..ARENA on x and z
const MAX_TANK_R = 2.0; // biggest hull's collision radius (used for spawn checks)
const TURRET_MIN_SPEED = 0.45; // rad/s on a short tap, for fine aiming
const TURRET_MAX_SPEED = 1.25; // rad/s once the key has been held
const TURRET_RAMP = 1.5; // seconds of holding to reach max speed (smooth S-curve)
const BOT_SPEED_FACTOR = 0.67; // bots drive at 2/3 of their hull's top speed
const BOT_TURN_FACTOR = 0.9;
const BOT_TURRET_TURN = 2.2;
const PLAYER_RESPAWN = 3;
const BOT_RESPAWN = 5;
// Game modes. `bots` = how many bots take part.
const MODES = {
  ffa: { id: 'ffa', name: 'Free-for-all', desc: 'Every tank for itself. First to 15 kills.', teams: false, goal: 15, bots: 5 },
  tdm: { id: 'tdm', name: 'Team Deathmatch', desc: 'Blue vs red, 4 on 4. First team to 25 kills.', teams: true, goal: 25, bots: 7 },
  ctf: { id: 'ctf', name: 'Capture the Flag', desc: 'Steal the red flag, bring it home. First to 3.', teams: true, goal: 3, bots: 7 },
};
const TEAMS = {
  blue: { name: 'Blue', css: '#5aa8ff', colors: [0x3a78c9, 0x4f8fd6, 0x2f6fb0, 0x5aa0e0] },
  red: { name: 'Red', css: '#ff5a4d', colors: [0xc0463a, 0xa83a30, 0xd2584a, 0xb94b3d] },
};
const otherTeam = (team) => (team === 'blue' ? 'red' : 'blue');
const FLAG_BASES = { blue: { x: 0, z: -38 }, red: { x: 0, z: 38 } };
const FLAG_RETURN_TIME = 15; // seconds a dropped flag waits before going home
const CAPTURE_REWARD = 30;
const RETURN_REWARD = 5;
let MAX_PARTICLES = 500; // the quality setting lowers this

// Crystals: earned in battle, spent on upgrades in the garage
const START_CRYSTALS = 300;
const KILL_REWARD = 10;
const WIN_REWARD = 100;
const CRYSTAL_DROP_REWARD = 25;
const UPGRADE_COSTS = [40, 80, 140, 220, 320]; // price of levels 1..5
const MAX_LEVEL = UPGRADE_COSTS.length;

// Hulls. dims scale the base tank model; mass decides who pushes whom.
// stats = [armor, speed, weight] on a 1-5 scale for the menu.
const HULLS = {
  scout: {
    id: 'scout', name: 'Scout', desc: 'Fast and nimble, thin armor',
    hp: 70, speed: 15, reverse: 10, turn: 2.8, radius: 1.5, mass: 0.7,
    dims: { L: 0.88, W: 0.82, H: 0.82, wheels: 4 }, stats: [2, 5, 1],
  },
  warden: {
    id: 'warden', name: 'Warden', desc: 'Balanced all-round hull',
    hp: 100, speed: 12, reverse: 8, turn: 2.2, radius: 1.7, mass: 1,
    dims: { L: 1, W: 1, H: 1, wheels: 5 }, stats: [3, 3, 3],
  },
  bastion: {
    id: 'bastion', name: 'Bastion', desc: 'Slow fortress, shoves others aside',
    hp: 150, speed: 8.5, reverse: 6, turn: 1.6, radius: 2.0, mass: 1.7,
    dims: { L: 1.15, W: 1.2, H: 1.22, wheels: 6 }, stats: [5, 1, 5],
  },
};
const HULL_UPGRADES = [
  { key: 'armor', name: 'Armor', effect: '+8% hull points' },
  { key: 'engine', name: 'Engine', effect: '+5% speed and turning' },
];
const TURRET_UPGRADES = [
  { key: 'damage', name: 'Damage', effect: '+8% damage' },
  { key: 'rate', name: 'Fire rate', effect: '-6% reload time' },
];
const NITRO_BOOST = 1.5;
const BUFF_TIME = 15;
const REPAIR_AMOUNT = 60;
const MAX_DROPS = 4;
const DROP_INTERVAL = [6, 11]; // seconds between crate drops
const DROP_LIFETIME = 35;

// Turrets. Bots fire some weapons slower so five of them stay fair.
// stats = [damage, fire rate, range] on a 1-5 scale for the menu.
// turretTurn = how fast this turret rotates with Z / X, as a multiplier of
// TURRET_MIN_SPEED / TURRET_MAX_SPEED at the top of the file (1 = base speed).
const WEAPONS = {
  cannon: {
    id: 'cannon', name: 'Cannon', desc: 'Balanced shells, steady fire', kind: 'shell',
    damage: 20, reload: 0.8, botReload: 2.4, speed: 70, life: 1.6, spread: 0, botSpread: 0.12,
    range: 45, keep: [8, 14], muzzle: 3.7, recoil: 0.45, stats: [3, 2, 4], turretTurn: 1.7,
  },
  blaster: {
    id: 'blaster', name: 'Blaster', desc: 'Rapid twin-barrel bolts', kind: 'shell', small: true,
    damage: 6, reload: 0.18, botReload: 0.5, speed: 85, life: 0.75, spread: 0.035, botSpread: 0.09,
    range: 34, keep: [8, 16], muzzle: 3.2, recoil: 0.12, stats: [1, 5, 2], turretTurn: 1.7,
  },
  // dps = damage of the stream itself. Every tank it touches also catches fire:
  // it takes burnDps for burnTime seconds after the last touch (the timer restarts
  // while you keep spraying). bot* values are for bot flamers.
  flamer: {
    id: 'flamer', name: 'Flamer', desc: 'Fire stream, sets tanks burning', kind: 'flame',
    dps: 30, botDps: 16, burnDps: 8, botBurnDps: 5, burnTime: 3, range: 12, cone: 0.34, fuelUse: 28, fuelRegen: 22,
    keep: [4, 8], muzzle: 2.75, recoil: 0, stats: [4, 5, 1], turretTurn: 1.7,
  },
  railgun: {
    id: 'railgun', name: 'Railgun', desc: 'Charged beam, pierces tanks', kind: 'rail',
    damage: 45, charge: 0.7, reload: 2.4, botReload: 3.6, range: 120, spread: 0, botSpread: 0.05,
    keep: [18, 30], muzzle: 4.25, recoil: 0.6, stats: [5, 1, 5], turretTurn: 1.4,
  },
  // Works like the Flamer (a short stream on a coolant gauge) but also freezes:
  // each second of spray adds freezeRate to the target's freeze (0..1), and a frozen
  // tank drives, turns and rotates its turret slower (see FREEZE_SLOW).
  freezer: {
    id: 'freezer', name: 'Freezer', desc: 'Icy stream, slows enemies down', kind: 'flame', ice: true,
    dps: 18, botDps: 10, range: 13, cone: 0.36, fuelUse: 24, fuelRegen: 22, freezeRate: 1.1,
    keep: [4, 9], muzzle: 2.75, muzzleHeight: 1.09, recoil: 0, stats: [2, 5, 1], turretTurn: 1.7,
    // the imported model is a whole turret (ring, body and barrel), so it replaces
    // the standard turret body; pivot = centre of its ring base in model units
    model: { url: `${import.meta.env.BASE_URL}models/freezer.glb`, scale: 2.1, pivotZ: -0.348 },
  },
  // Plasma balls that bounce off walls and cover (up to `bounces` times) but
  // never off tanks: a tank stops the ball and takes the damage.
  ricochet: {
    id: 'ricochet', name: 'Ricochet', desc: 'Plasma balls that bounce off walls', kind: 'shell', plasma: true,
    damage: 11, reload: 0.42, botReload: 1.1, speed: 38, life: 1.9, bounces: 4, spread: 0.02, botSpread: 0.1,
    range: 32, keep: [8, 16], muzzle: 2.62, muzzleHeight: 0.42, recoil: 0.18, stats: [2, 4, 3], turretTurn: 1.7,
    model: { url: `${import.meta.env.BASE_URL}models/ricochet.glb`, scale: 2.1, pivotZ: -0.3 },
  },
};
// Hammer: a shotgun. One shot is `pellets` small bullets fanned out over `cone` radians (each pellet is its own
// bullet, so each can hit something different). `damage` is per pellet at point blank; it stays full out to
// falloff.full units, then fades linearly to falloff.min of itself at falloff.end. So: devastating up close,
// weak at range. keepTexture: keep the model's own texture, multiplied by the team colour (boost brightens it).
WEAPONS.hammer = {
  id: 'hammer', name: 'Hammer', desc: 'Shotgun: huge damage up close', kind: 'shell', pellets: 10, cone: 0.17,
  damage: 8, reload: 1.5, botReload: 2.8, speed: 62, life: 0.5, spread: 0.01, botSpread: 0.06,
  falloff: { full: 8, end: 27, min: 0.12 },
  range: 20, keep: [4, 10], muzzle: 2.55, muzzleHeight: 1.0, recoil: 0.55, stats: [5, 2, 1], turretTurn: 1.3,
  model: { url: `${import.meta.env.BASE_URL}models/hammer.glb`, scale: 2.1, pivotZ: -0.233, keepTexture: true, boost: 4 },
};
const FREEZE_SLOW = 0.6; // a fully frozen tank moves and turns at 40% speed
const FREEZE_THAW = 0.5; // freeze lost per second once the spray stops

const DROP_TYPES = {
  repair: { name: 'Repair kit', color: 0x45d16a, css: '#45d16a', weight: 1 },
  armor: { name: 'Double armor', color: 0x3fa9f5, css: '#3fa9f5', weight: 1 },
  damage: { name: 'Double damage', color: 0xff4d3d, css: '#ff4d3d', weight: 1 },
  nitro: { name: 'Nitro', color: 0xffc23d, css: '#ffc23d', weight: 1 },
  crystal: { name: 'Crystals', color: 0x7fe3ff, css: '#7fe3ff', weight: 1.2 },
};
const BUFFS = ['armor', 'damage', 'nitro'];

// stats after garage upgrades (bots always use level 0)
function hullStats(id, lv = {}) {
  const h = HULLS[id];
  const a = lv.armor || 0, e = lv.engine || 0;
  return {
    ...h,
    hp: Math.round(h.hp * (1 + 0.08 * a)),
    speed: h.speed * (1 + 0.05 * e),
    reverse: h.reverse * (1 + 0.05 * e),
    turn: h.turn * (1 + 0.05 * e),
  };
}
function weaponStats(id, lv = {}) {
  const w = { ...WEAPONS[id] };
  const dm = 1 + 0.08 * (lv.damage || 0);
  const r = lv.rate || 0;
  if (w.damage) w.damage *= dm;
  if (w.dps) w.dps *= dm;
  if (w.burnDps) w.burnDps *= dm;
  if (w.reload) w.reload *= 1 - 0.06 * r;
  if (w.charge) w.charge *= 1 - 0.06 * r;
  if (w.fuelUse) {
    // for the flamer, "fire rate" means fuel efficiency
    w.fuelUse *= 1 - 0.07 * r;
    w.fuelRegen *= 1 + 0.07 * r;
  }
  return w;
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const angleDiff = (a, b) => {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
};
const rnd = (a, b) => a + Math.random() * (b - a);

// seeded random so textures and scenery look the same every load
function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let srand = mulberry32(1);
const srnd = (a, b) => a + srand() * (b - a);

function load(key, fallback) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, value); } catch { /* storage unavailable */ }
}

// crystals, upgrade levels and the equipped loadout, kept in this browser
const SAVE_KEY = 'treadstorm-save';
function loadProgress() {
  let data = null;
  try { data = JSON.parse(load(SAVE_KEY, 'null')); } catch { /* corrupt save: start fresh */ }
  const p = {
    crystals: START_CRYSTALS,
    hull: 'warden',
    weapon: WEAPONS[load('treadstorm-weapon', '')] ? load('treadstorm-weapon', '') : 'cannon',
    levels: {},
    ...(data && typeof data === 'object' ? data : {}),
  };
  if (!HULLS[p.hull]) p.hull = 'warden';
  if (!WEAPONS[p.weapon]) p.weapon = 'cannon';
  for (const id of [...Object.keys(HULLS), ...Object.keys(WEAPONS)]) p.levels[id] = { ...(p.levels[id] || {}) };
  return p;
}
const progress = loadProgress();
function saveProgress() {
  save(SAVE_KEY, JSON.stringify(progress));
}

// ---------- HUD element refs ----------
const $ = (id) => document.getElementById(id);
const hud = {
  kills: $('kill-count'),
  killProgress: $('kill-progress'),
  hpFill: $('hp-fill'),
  hpText: $('hp-text'),
  reloadFill: $('reload-fill'),
  reloadText: $('reload-text'),
  reloadRing: $('reload-ring'),
  weaponLabel: $('weapon-label'),
  weaponName: $('weapon-name'),
  crosshair: $('crosshair'),
  killMsg: $('kill-msg'),
  toast: $('toast'),
  killfeed: $('killfeed'),
  buffs: $('buffs'),
  damage: $('damage'),
  frost: $('frost'),
  burn: $('burn'),
  respawn: $('respawn'),
  respawnBy: $('respawn-by'),
  respawnTime: $('respawn-time'),
  minimap: $('minimap'),
  mapLabel: $('map-label'),
  start: $('start'),
  win: $('win'),
  winStats: $('win-stats'),
  scoreboard: $('scoreboard'),
  scoreRows: $('score-rows'),
  soundState: $('sound-state'),
  mapCards: $('map-cards'),
  weaponCards: $('weapon-cards'),
  hullCards: $('hull-cards'),
  garageDetail: $('garage-detail'),
  loadout: $('loadout'),
  legend: $('legend'),
  mapNote: $('map-note'),
  killGoal: $('kill-goal'),
  teamBar: $('team-bar'),
  scoreBlue: $('score-blue'),
  scoreRed: $('score-red'),
  teamGoal: $('team-goal'),
  teamMode: $('team-mode'),
  flagBlue: $('flag-blue'),
  flagRed: $('flag-red'),
  modeCards: $('mode-cards'),
  winTitle: $('win-title'),
  winTagline: $('win-tagline'),
  crystals: $('crystal-count'),
  crystalGain: $('crystal-gain'),
  menuCrystals: $('menu-crystals'),
};

// ---------- Renderer / post-processing ----------
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.getElementById('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 800);

const composer = new EffectComposer(
  renderer,
  new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 })
);
composer.setPixelRatio(renderer.getPixelRatio());
composer.setSize(window.innerWidth, window.innerHeight);
composer.addPass(new RenderPass(scene, camera));
// threshold 1.0: only HDR colours (tracers, sparks, fire, beams, the sun) glow
const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.4, 0.3, 1.0);
composer.addPass(bloom);
composer.addPass(new OutputPass());
// cheap edge smoothing after tone mapping (used on High instead of 4x multisampling, which is very slow on integrated graphics)
// (sampled with an explicit mip level: the stock shader samples inside a loop, which makes some graphics drivers print a warning)
// and ApplyFXAA is rewritten with a single return, for the same reason (an "uninitialized variable" warning)
const fxaaSource = FXAAShader.fragmentShader.replace('return texture( tex2D, uv );', 'return textureLod( tex2D, uv, 0.0 );');
const fxaaStart = fxaaSource.indexOf('vec4 ApplyFXAA(');
const fxaaEnd = fxaaSource.indexOf('void main()');
const fxaa = new ShaderPass({
  ...FXAAShader,
  fragmentShader: fxaaSource.slice(0, fxaaStart) + `vec4 ApplyFXAA( sampler2D tex2D, vec2 texSize, vec2 uv ) {
			vec4 result = Sample( tex2D, uv );
			LuminanceData luminance = SampleLuminanceNeighborhood( tex2D, texSize, uv );
			if ( !ShouldSkipPixel( luminance ) ) {
				float pixelBlend = DeterminePixelBlendFactor( luminance );
				EdgeData edge = DetermineEdge( texSize, luminance );
				float edgeBlend = DetermineEdgeBlendFactor( tex2D, texSize, luminance, edge, uv );
				float finalBlend = max( pixelBlend, edgeBlend );
				if ( edge.isHorizontal ) uv.y += edge.pixelStep * finalBlend;
				else uv.x += edge.pixelStep * finalBlend;
				result = Sample( tex2D, uv );
			}
			return result;
		}

		` + fxaaSource.slice(fxaaEnd),
});
fxaa.enabled = false;
composer.addPass(fxaa);

// ---------- Lights & sky (colours come from the map theme) ----------
scene.background = new THREE.Color();
scene.fog = new THREE.Fog(0xffffff, 90, 340);
const hemi = new THREE.HemisphereLight();
scene.add(hemi);
const sun = new THREE.DirectionalLight();
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -64, right: 64, top: 64, bottom: -64, near: 1, far: 200 });
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.02;
scene.add(sun);

const skyUniforms = {
  top: { value: new THREE.Color() },
  horizon: { value: new THREE.Color() },
  bottom: { value: new THREE.Color() },
  sunDir: { value: new THREE.Vector3(0, 1, 0) },
  // cloud cover (amount 0 = clear sky, used by the older maps)
  cloudMap: { value: null },
  cloudAmount: { value: 0 },
  cloudDark: { value: new THREE.Color() },
  cloudLight: { value: new THREE.Color() },
  skyTime: { value: 0 },
  flash: { value: 0 }, // lightning: lights the cloud layer up for a moment
};
const sky = new THREE.Mesh(
  new THREE.SphereGeometry(600, 32, 16),
  new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: skyUniforms,
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 top;
      uniform vec3 horizon;
      uniform vec3 bottom;
      uniform vec3 sunDir;
      uniform sampler2D cloudMap;
      uniform float cloudAmount;
      uniform vec3 cloudDark;
      uniform vec3 cloudLight;
      uniform float skyTime;
      uniform float flash;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float h = d.y;
        vec3 c = h > 0.0 ? mix(horizon, top, pow(min(h * 1.4, 1.0), 0.7)) : mix(horizon, bottom, min(1.0, -h * 6.0));
        float s = max(dot(d, sunDir), 0.0);
        c += vec3(1.0, 0.86, 0.62) * (pow(s, 900.0) * 4.0 + pow(s, 14.0) * 0.2);
        if (cloudAmount > 0.0 && h > 0.0) {
          // two layers of the cloud texture, projected flat onto the sky and drifting slowly
          vec2 uv = d.xz / (h + 0.15) * 0.22 + vec2(skyTime * 0.004, skyTime * 0.0015);
          float n = texture2D(cloudMap, uv).r * 0.72 + texture2D(cloudMap, uv * 2.2 + vec2(0.37 + skyTime * 0.006, 0.11)).r * 0.28;
          float lo = 1.0 - cloudAmount;
          float cover = smoothstep(lo, lo + 0.25, n);
          cover *= 1.0 - 0.85 * pow(s, 24.0);      // a break in the clouds around the sun
          cover *= smoothstep(0.0, 0.14, h);       // thin out into the haze at the horizon
          float thick = smoothstep(lo, lo + 0.5, n);
          vec3 cc = mix(cloudLight, cloudDark, thick);
          cc += vec3(1.0, 0.72, 0.42) * pow(s, 6.0) * (1.0 - thick) * 1.4; // lit edges near the sun
          c = mix(c, cc, cover);
          c += vec3(0.5, 0.6, 0.85) * flash * (0.25 + 0.9 * cover) * smoothstep(0.0, 0.3, h); // the storm lit from inside
        }
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  })
);
sky.renderOrder = 9999; // drawn after everything opaque, so hidden pixels fail the depth test and cost nothing
scene.add(sky);

// ---------- Procedural textures (drawn in code, no image files) ----------
function canvasTexture(size, seed, draw) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  srand = mulberry32(seed);
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return t;
}

// soft blobs drawn with wrap-around so the texture tiles seamlessly
function blob(g, s, x, y, r, color) {
  for (const ox of [-s, 0, s]) {
    for (const oy of [-s, 0, s]) {
      const grd = g.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
      grd.addColorStop(0, color);
      grd.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grd;
      g.fillRect(x + ox - r, y + oy - r, r * 2, r * 2);
    }
  }
}
function blobs(g, s, count, rMin, rMax, colors) {
  for (let i = 0; i < count; i++) blob(g, s, srand() * s, srand() * s, srnd(rMin, rMax), colors[(srand() * colors.length) | 0]);
}
function speckle(g, s, count, hue, sat, light, alpha) {
  for (let i = 0; i < count; i++) {
    g.fillStyle = `hsla(${srnd(...hue)},${srnd(...sat)}%,${srnd(...light)}%,${alpha})`;
    const w = srnd(1, 3);
    g.fillRect(srand() * s, srand() * s, w, w);
  }
}
function pebbles(g, s, count, base, tint) {
  for (let i = 0; i < count; i++) {
    const v = srnd(base[0], base[1]);
    g.fillStyle = `rgba(${v},${v * tint[0]},${v * tint[1]},0.7)`;
    g.beginPath();
    g.ellipse(srand() * s, srand() * s, srnd(1.5, 4), srnd(1, 3), srand() * 3, 0, Math.PI * 2);
    g.fill();
  }
}

const TEXTURES = {
  grass: () => canvasTexture(512, 11, (g, s) => {
    g.fillStyle = '#5d6c40';
    g.fillRect(0, 0, s, s);
    blobs(g, s, 40, 30, 90, ['rgba(122,128,70,0.35)', 'rgba(60,82,40,0.35)']);
    speckle(g, s, 9000, [70, 100], [20, 40], [18, 42], 0.5);
  }),
  dirt: () => canvasTexture(512, 12, (g, s) => {
    g.fillStyle = '#7d7056';
    g.fillRect(0, 0, s, s);
    blobs(g, s, 45, 25, 80, ['rgba(96,86,62,0.45)', 'rgba(140,126,96,0.35)']);
    speckle(g, s, 12000, [30, 45], [10, 25], [25, 55], 0.45);
    pebbles(g, s, 260, [70, 150], [0.9, 0.75]);
  }),
  gravel: () => canvasTexture(512, 13, (g, s) => {
    g.fillStyle = '#6a685e';
    g.fillRect(0, 0, s, s);
    blobs(g, s, 40, 30, 90, ['rgba(90,88,78,0.4)', 'rgba(130,126,112,0.3)']);
    speckle(g, s, 14000, [30, 60], [5, 15], [25, 65], 0.5);
    pebbles(g, s, 500, [80, 170], [0.97, 0.9]);
  }),
  // churned, wet battlefield mud (muted grey-brown, darker than the quarry dirt)
  mud: () => canvasTexture(512, 41, (g, s) => {
    g.fillStyle = '#54483a';
    g.fillRect(0, 0, s, s);
    blobs(g, s, 50, 25, 90, ['rgba(38,31,24,0.45)', 'rgba(118,102,78,0.3)', 'rgba(70,62,50,0.35)']);
    speckle(g, s, 12000, [25, 40], [8, 22], [18, 48], 0.45);
    pebbles(g, s, 300, [60, 130], [0.92, 0.8]);
    // wet ruts and cracks
    g.strokeStyle = 'rgba(22,17,12,0.5)';
    g.lineWidth = 1.2;
    for (let i = 0; i < 14; i++) {
      let x = srand() * s, y = srand() * s, a = srand() * Math.PI * 2;
      g.beginPath();
      g.moveTo(x, y);
      for (let k = 0; k < 7; k++) {
        a += srnd(-0.8, 0.8);
        x += Math.cos(a) * srnd(5, 14);
        y += Math.sin(a) * srnd(5, 14);
        g.lineTo(x, y);
      }
      g.stroke();
    }
  }),
  // the ground outside the walls: dead olive grass over bare earth
  wasteland: () => canvasTexture(512, 42, (g, s) => {
    g.fillStyle = '#5a5638';
    g.fillRect(0, 0, s, s);
    blobs(g, s, 55, 30, 95, ['rgba(74,70,44,0.45)', 'rgba(112,102,66,0.35)', 'rgba(70,56,40,0.45)']);
    speckle(g, s, 9000, [40, 65], [18, 34], [18, 42], 0.5);
    pebbles(g, s, 160, [70, 130], [0.95, 0.85]);
  }),
  // concrete that has been through a war: stains, cracks and clusters of bullet holes
  concretewar: () => canvasTexture(512, 51, (g, s) => {
    g.fillStyle = '#8f8a80';
    g.fillRect(0, 0, s, s);
    blobs(g, s, 26, 25, 80, ['rgba(60,56,50,0.25)', 'rgba(220,214,200,0.18)']);
    speckle(g, s, 7000, [30, 50], [0, 10], [45, 80], 0.5);
    for (let i = 0; i < 12; i++) { // rain and soot running down the wall
      const x = srand() * s, w = srnd(6, 18), y = srand() * s * 0.6, len = srnd(120, 380);
      const gr = g.createLinearGradient(0, y, 0, y + len);
      gr.addColorStop(0, 'rgba(40,36,30,0.3)');
      gr.addColorStop(1, 'rgba(40,36,30,0)');
      g.fillStyle = gr;
      g.fillRect(x, y, w, len);
    }
    g.strokeStyle = 'rgba(30,28,24,0.7)';
    g.lineWidth = 1.3;
    for (let i = 0; i < 9; i++) { // cracks
      let x = srand() * s, y = srand() * s, a = srand() * Math.PI * 2;
      g.beginPath();
      g.moveTo(x, y);
      for (let k = 0; k < 9; k++) {
        a += srnd(-0.6, 0.6);
        x += Math.cos(a) * srnd(8, 22);
        y += Math.sin(a) * srnd(8, 22);
        g.lineTo(x, y);
      }
      g.stroke();
    }
    for (let i = 0; i < 16; i++) { // bullet holes, in little bursts
      const cx = srand() * s, cy = srand() * s;
      for (let n = 0, count = 1 + Math.floor(srand() * 4); n < count; n++) {
        const x = cx + srnd(-26, 26), y = cy + srnd(-26, 26);
        const halo = srnd(9, 14);
        const gr = g.createRadialGradient(x, y, 0, x, y, halo);
        gr.addColorStop(0, 'rgba(228,223,210,0.7)');
        gr.addColorStop(1, 'rgba(228,223,210,0)');
        g.fillStyle = gr;
        g.fillRect(x - halo, y - halo, halo * 2, halo * 2);
        g.strokeStyle = 'rgba(25,22,18,0.6)';
        g.lineWidth = 1;
        g.beginPath();
        for (let k = 0; k < 4; k++) {
          const a = srand() * Math.PI * 2, l = srnd(7, 17);
          g.moveTo(x, y);
          g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
        }
        g.stroke();
        g.fillStyle = 'rgba(18,16,14,0.95)';
        g.beginPath();
        g.arc(x, y, srnd(2.4, 4.6), 0, Math.PI * 2);
        g.fill();
      }
    }
  }),
  // brick wall with missing bricks, soot and plaster patches (64 x 16 px bricks, so it tiles)
  brick: () => canvasTexture(256, 52, (g, s) => {
    g.fillStyle = '#8f897e';
    g.fillRect(0, 0, s, s);
    for (let row = 0; row < s / 16; row++) {
      for (let x = row % 2 ? -32 : 0; x < s; x += 64) {
        g.fillStyle = `hsl(${srnd(8, 18)},${srnd(24, 38)}%,${srnd(20, 32)}%)`;
        g.fillRect(x + 1, row * 16 + 1, 62, 14);
      }
    }
    for (let i = 0; i < 7; i++) { // bricks knocked out, showing the dark gap behind
      g.fillStyle = '#2e2924';
      g.fillRect(Math.floor(srand() * 4) * 64 + (srand() < 0.5 ? 0 : 32) + 1, Math.floor(srand() * 16) * 16 + 1, 62, 14);
    }
    blobs(g, s, 8, 20, 60, ['rgba(20,16,12,0.3)']);
    for (let i = 0; i < 3; i++) { // remains of plaster
      blob(g, s, srand() * s, srand() * s, srnd(18, 34), 'rgba(176,170,152,0.75)');
    }
    speckle(g, s, 3000, [10, 30], [10, 30], [20, 50], 0.5);
  }),
  // chain-link fence: transparent holes between rusty diagonal wires
  chainlink: () => canvasTexture(64, 53, (g, s) => {
    g.strokeStyle = 'rgba(128,116,100,1)';
    g.lineWidth = 1.6;
    g.beginPath();
    for (let i = -s; i <= s; i += 16) {
      g.moveTo(i, 0);
      g.lineTo(i + s, s);
      g.moveTo(i, s);
      g.lineTo(i + s, 0);
    }
    g.stroke();
  }),
  // sandbags: burlap weave with dark seams
  sandbag: () => canvasTexture(128, 54, (g, s) => {
    g.fillStyle = '#a39b86';
    g.fillRect(0, 0, s, s);
    g.fillStyle = 'rgba(80,70,54,0.22)';
    for (let i = 0; i < s; i += 4) {
      g.fillRect(i, 0, 1, s);
      g.fillRect(0, i, s, 1);
    }
    blobs(g, s, 14, 12, 40, ['rgba(70,56,36,0.28)', 'rgba(220,205,160,0.2)']);
    g.fillStyle = 'rgba(60,48,30,0.7)';
    g.fillRect(0, 0, s, 3);
    g.fillRect(0, 0, 3, s);
    speckle(g, s, 1800, [30, 45], [20, 40], [30, 65], 0.5);
  }),
  stripshade: () => canvasTexture(128, 62, (g, s) => {
    const gr = g.createLinearGradient(0, 0, 0, s);
    gr.addColorStop(0, 'rgba(0,0,0,0)');
    gr.addColorStop(0.22, 'rgba(0,0,0,0.42)');
    gr.addColorStop(0.78, 'rgba(0,0,0,0.42)');
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, s, s);
  }),
  // the front of a ruined building: rows of dark windows, some blown out, some with their wall gone
  facade: () => canvasTexture(256, 71, (g, s) => {
    g.fillStyle = '#8a857b';
    g.fillRect(0, 0, s, s);
    blobs(g, s, 14, 20, 60, ['rgba(30,26,22,0.3)', 'rgba(170,164,150,0.2)']);
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 4; col++) {
        const roll = srand();
        if (roll < 0.12) continue; // solid wall
        g.fillStyle = roll < 0.5 ? '#25231f' : roll < 0.8 ? '#171512' : '#4a5058'; // dark, burnt out, or a pane left
        g.fillRect(col * 64 + 12, row * 32 + 7, 40, 18);
      }
    }
    speckle(g, s, 4000, [30, 50], [5, 12], [30, 60], 0.5);
  }),
  // corrugated sheet metal: vertical ribs, rust streaks and a few holes
  corrugated: () => canvasTexture(256, 81, (g, s) => {
    g.fillStyle = '#7b8389';
    g.fillRect(0, 0, s, s);
    for (let x = 0; x < s; x += 16) {
      g.fillStyle = 'rgba(255,255,255,0.14)';
      g.fillRect(x, 0, 5, s);
      g.fillStyle = 'rgba(0,0,0,0.22)';
      g.fillRect(x + 9, 0, 5, s);
    }
    for (let i = 0; i < 16; i++) { // rust running down from the top
      const x = srand() * s, w = srnd(4, 14), y = srand() * s * 0.5, len = srnd(60, 200);
      const gr = g.createLinearGradient(0, y, 0, y + len);
      gr.addColorStop(0, 'rgba(120,64,30,0.5)');
      gr.addColorStop(1, 'rgba(120,64,30,0)');
      g.fillStyle = gr;
      g.fillRect(x, y, w, len);
    }
    blobs(g, s, 8, 20, 50, ['rgba(40,30,22,0.25)']);
    speckle(g, s, 2500, [20, 40], [20, 40], [25, 60], 0.5);
    g.fillStyle = 'rgba(12,12,14,0.9)';
    for (let i = 0; i < 6; i++) { // bullet holes
      g.beginPath();
      g.arc(srand() * s, srand() * s, srnd(1.5, 3.2), 0, Math.PI * 2);
      g.fill();
    }
  }),
  asphalt: () => canvasTexture(512, 14, (g, s) => {
    g.fillStyle = '#4b4d50';
    g.fillRect(0, 0, s, s);
    blobs(g, s, 40, 30, 90, ['rgba(30,30,32,0.35)', 'rgba(110,110,105,0.2)']);
    speckle(g, s, 14000, [200, 220], [0, 8], [20, 55], 0.5);
    g.strokeStyle = 'rgba(22,22,24,0.7)';
    g.lineWidth = 1.5;
    for (let i = 0; i < 18; i++) {
      let x = srand() * s, y = srand() * s, a = srand() * Math.PI * 2;
      g.beginPath();
      g.moveTo(x, y);
      for (let k = 0; k < 9; k++) {
        a += srnd(-0.7, 0.7);
        x += Math.cos(a) * srnd(6, 16);
        y += Math.sin(a) * srnd(6, 16);
        g.lineTo(x, y);
      }
      g.stroke();
    }
    blobs(g, s, 6, 15, 35, ['rgba(15,15,18,0.45)']);
  }),
  snow: () => canvasTexture(512, 15, (g, s) => {
    g.fillStyle = '#e9eef3';
    g.fillRect(0, 0, s, s);
    blobs(g, s, 40, 30, 90, ['rgba(170,190,215,0.35)', 'rgba(255,255,255,0.5)']);
    speckle(g, s, 8000, [200, 215], [10, 30], [80, 98], 0.5);
  }),
  snowpack: () => canvasTexture(512, 16, (g, s) => {
    g.fillStyle = '#d8dfe6';
    g.fillRect(0, 0, s, s);
    blobs(g, s, 45, 25, 80, ['rgba(150,165,185,0.35)', 'rgba(255,255,255,0.45)']);
    speckle(g, s, 10000, [200, 215], [8, 25], [70, 95], 0.5);
    pebbles(g, s, 120, [120, 170], [1.02, 1.08]);
  }),
  concrete: () => canvasTexture(256, 21, (g, s) => {
    g.fillStyle = '#bcbcb8';
    g.fillRect(0, 0, s, s);
    blobs(g, s, 14, 20, 60, ['rgba(90,90,85,0.18)']);
    speckle(g, s, 5000, [40, 60], [0, 8], [55, 85], 0.5);
    g.fillStyle = 'rgba(60,60,58,0.55)';
    g.fillRect(0, 0, s, 3);
    g.fillRect(0, 0, 3, s);
    g.fillStyle = 'rgba(255,255,255,0.18)';
    g.fillRect(0, 3, s, 2);
  }),
  container: () => canvasTexture(256, 22, (g, s) => {
    g.fillStyle = '#c4c4c4';
    g.fillRect(0, 0, s, s);
    for (let x = 0; x < s; x += 16) {
      g.fillStyle = '#9a9a9a';
      g.fillRect(x, 0, 6, s);
      g.fillStyle = '#e2e2e2';
      g.fillRect(x + 6, 0, 2, s);
    }
    blobs(g, s, 30, 4, 18, ['rgba(110,70,40,0.35)']);
    g.strokeStyle = '#7e7e7e';
    g.lineWidth = 10;
    g.strokeRect(0, 0, s, s);
  }),
  crate: () => canvasTexture(256, 23, (g, s) => {
    for (let y = 0; y < s; y += 32) {
      g.fillStyle = `hsl(30, ${srnd(32, 42)}%, ${srnd(30, 38)}%)`;
      g.fillRect(0, y, s, 32);
      g.fillStyle = 'rgba(30,20,10,0.6)';
      g.fillRect(0, y, s, 2);
    }
    speckle(g, s, 2500, [25, 35], [30, 45], [20, 45], 0.35);
    g.strokeStyle = '#5a4127';
    g.lineWidth = 20;
    g.strokeRect(10, 10, s - 20, s - 20);
    g.lineWidth = 16;
    g.beginPath();
    g.moveTo(20, 20);
    g.lineTo(s - 20, s - 20);
    g.stroke();
  }),
  ice: () => canvasTexture(256, 24, (g, s) => {
    g.fillStyle = '#cbe6f1';
    g.fillRect(0, 0, s, s);
    blobs(g, s, 18, 20, 60, ['rgba(255,255,255,0.5)', 'rgba(110,165,200,0.3)']);
    for (let i = 0; i < 40; i++) {
      g.strokeStyle = srand() < 0.6 ? 'rgba(255,255,255,0.45)' : 'rgba(80,135,170,0.45)';
      g.lineWidth = srnd(0.6, 2.5);
      const x = srand() * s, y = srand() * s;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + srnd(-60, 60), y + srnd(-60, 60));
      g.stroke();
    }
  }),
  // armour paint: faint grime, a dark seam around every face (reads as a bevel) and a few scratches
  panel: () => canvasTexture(128, 31, (g, s) => {
    g.fillStyle = '#f2f2f2';
    g.fillRect(0, 0, s, s);
    blobs(g, s, 10, 10, 40, ['rgba(80,80,80,0.12)', 'rgba(255,255,255,0.25)']);
    speckle(g, s, 1500, [0, 0], [0, 0], [60, 95], 0.25);
    g.strokeStyle = 'rgba(255,255,255,0.35)';
    g.lineWidth = 1;
    for (let i = 0; i < 6; i++) {
      const x = srnd(10, s - 10), y = srnd(10, s - 10);
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + srnd(-14, 14), y + srnd(-6, 6));
      g.stroke();
    }
    g.strokeStyle = 'rgba(0,0,0,0.38)';
    g.lineWidth = 6;
    g.strokeRect(0, 0, s, s);
    g.strokeStyle = 'rgba(255,255,255,0.22)';
    g.lineWidth = 2;
    g.strokeRect(5, 5, s - 10, s - 10);
  }),
  // rubber track pads with steel grousers, tiles along the belt
  tread: () => canvasTexture(64, 32, (g, s) => {
    g.fillStyle = '#26272a';
    g.fillRect(0, 0, s, s);
    for (let y = 0; y < s; y += 16) {
      g.fillStyle = '#4a4c50';
      g.fillRect(0, y, s, 6);
      g.fillStyle = '#5c5f64';
      g.fillRect(0, y, s, 2);
      g.fillStyle = '#1a1b1d';
      g.fillRect(s / 2 - 3, y + 8, 6, 6);
    }
  }),
  hazard: () => canvasTexture(128, 25, (g, s) => {
    g.fillStyle = '#f0bd2c';
    g.fillRect(0, 0, s, s);
    g.fillStyle = '#1c1c1c';
    for (let i = -2; i < 4; i++) {
      g.beginPath();
      g.moveTo(i * 64, s);
      g.lineTo(i * 64 + 32, s);
      g.lineTo(i * 64 + 32 + s, 0);
      g.lineTo(i * 64 + s, 0);
      g.fill();
    }
  }),
  // grey-scale cloud cover for the sky dome (only the red channel is read)
  clouds: () => {
    const t = canvasTexture(512, 31, (g, s) => {
      g.fillStyle = '#000';
      g.fillRect(0, 0, s, s);
      for (const [n, r0, r1, a] of [[34, 70, 120, 0.6], [90, 30, 60, 0.5], [110, 14, 30, 0.3]]) {
        for (let i = 0; i < n; i++) {
          blob(g, s, srand() * s, srand() * s, r0 + srand() * (r1 - r0), `rgba(255,255,255,${(a * (0.5 + srand() * 0.5)).toFixed(2)})`);
        }
      }
    });
    t.colorSpace = THREE.NoColorSpace;
    return t;
  },
  scorch: () => canvasTexture(128, 26, (g, s) => {
    const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grd.addColorStop(0, 'rgba(10,8,6,0.9)');
    grd.addColorStop(0.55, 'rgba(20,16,12,0.55)');
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, s, s);
  }),
};
const texCache = {};
const tex = (name) => texCache[name] || (texCache[name] = TEXTURES[name]());
// a repeating copy of a texture, for big surfaces like the ground
function texRepeat(name, rep) {
  const key = `${name}@${rep}`;
  if (!texCache[key]) {
    const t = tex(name).clone();
    t.repeat.set(rep, rep);
    t.needsUpdate = true;
    texCache[key] = t;
  }
  return texCache[key];
}

// re-map box UVs to world units so textures keep the same scale on every face
function worldUV(geo, tile) {
  const pos = geo.attributes.position;
  const nor = geo.attributes.normal;
  const uv = geo.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    if (Math.abs(nor.getY(i)) > 0.5) uv.setXY(i, x / tile, z / tile);
    else if (Math.abs(nor.getX(i)) > 0.5) uv.setXY(i, z / tile, y / tile);
    else uv.setXY(i, x / tile, y / tile);
  }
  uv.needsUpdate = true;
  return geo;
}

// ---------- Maps ----------
const THEMES = {
  quarry: {
    sky: [0x3f4b57, 0xb7a68a, 0x7d7058], fog: [55, 290], exposure: 1.05,
    sun: [0xffd8a0, 2.8, 40, 55, 25], hemi: [0xc9d3dc, 0x6b5f48, 1.6],
    clouds: { amount: 0.78, dark: 0x3f444a, light: 0xa39a88 },
    precip: 'dust', horizon: { columns: 4, flash: false }, sunFlicker: 0.5, props: true,
    outer: 'wasteland', outerTint: 0xb9ab88, floor: 'dirt', floorTint: 0xd9cdb6, floorRepeat: 8, paint: [0xf2efe6, 0.32], dust: 0x9c8a6a,
    wall: 0x9a9c9f, cap: 0x6f7174, concrete: 0xbab4a6, roof: 0x8a857a, snowCaps: false,
    trees: { count: 150, h: [0.17, 0.24], s: [0.15, 0.28], l: [0.14, 0.22] },
    rocks: 0x8a8780, mountains: { h: [0.07, 0.1], s: [0.14, 0.22], l: [0.28, 0.38] }, snowfall: true,
    ground: {
      res: 1024,
      count: { craters: 9, shells: 14, scorch: 4, grass: 9, gravel: 12, puddles: 4, tracks: 8 },
      crater: [2, 4.8],
      pit: ['rgba(40,28,18,0.93)', 'rgba(70,52,34,0.85)', 'rgba(105,82,56,0.3)'],
      rimLit: 'rgba(190,160,115,0.6)', rimShade: 'rgba(150,122,88,0.4)',
      arcShadow: 'rgba(22,14,8,0.45)', arcLit: 'rgba(205,175,130,0.4)', arcRim: 'rgba(215,185,140,0.4)',
      clodRGB: [1, 0.82, 0.62], clodRange: [70, 140],
      scorch: ['rgba(30,22,14,0.45)', 'rgba(36,27,18,0.28)'],
      track: { rgb: '58,42,26', a: 0.55, tickRGB: '40,28,18', tickA: 0.6 },
      grass: { base: ['rgba(130,114,70,0.45)', 'rgba(120,104,64,0.3)'], blades: ['hsla(46,34%,44%,0.8)', 'hsla(40,30%,34%,0.8)', 'hsla(52,26%,54%,0.7)'], density: 12 },
      gravel: { base: ['rgba(120,112,98,0.55)', 'rgba(108,100,88,0.4)'], pebble: [95, 165] },
      puddle: { dark: ['rgba(58,46,30,0.85)', 'rgba(66,52,34,0.8)', 'rgba(70,56,38,0)'], sheen: 'rgba(170,160,140,0.3)' },
      wall: 'rgba(60,44,28,0.35)',
      macro: { dark: 'rgba(70,52,34,0.2)', light: 'rgba(200,170,120,0.14)' },
      stones: { range: [70, 160], tint: [0.9, 0.78], n: 1400 },
      rim: 0x6b5a42,
    },
    preview: { ground: '#7d7056', block: '#bab4a6' },
  },
  depot: {
    sky: [0x38443f, 0x8c9288, 0x66695f], fog: [48, 270], exposure: 1.0,
    sun: [0xffe2b8, 2.3, -35, 50, 30], hemi: [0xc7d0cc, 0x5a5a50, 1.7],
    clouds: { amount: 0.8, dark: 0x2c3331, light: 0x848b82 },
    precip: 'ash', horizon: { columns: 6, flash: true }, sunFlicker: 0.7, lightning: [60, 130], props: true,
    outer: 'gravel', outerTint: 0xc9ccc4, floor: 'asphalt', floorRepeat: 9, paint: [0xf3c53a, 0.55], dust: 0x77756e,
    wall: 0x8c8f93, cap: 0x5f6266, concrete: 0xa9a8a2, roof: 0x7a7a74, snowCaps: false,
    trees: { count: 80, h: [0.2, 0.28], s: [0.1, 0.2], l: [0.12, 0.2] },
    rocks: 0x7d7b74, mountains: { h: [0.1, 0.14], s: [0.04, 0.08], l: [0.3, 0.4], flat: 0.4, dome: true }, snowfall: true,
    ground: {
      res: 1024,
      count: { craters: 6, shells: 12, scorch: 7, grass: 3, gravel: 10, puddles: 6, tracks: 6 },
      crater: [1.6, 3.8],
      pit: ['rgba(8,8,9,0.95)', 'rgba(22,22,24,0.88)', 'rgba(46,46,48,0.35)'],
      rimLit: 'rgba(130,128,120,0.65)', rimShade: 'rgba(98,96,90,0.4)',
      arcShadow: 'rgba(4,4,5,0.55)', arcLit: 'rgba(160,158,150,0.4)', arcRim: 'rgba(170,168,160,0.4)',
      clodRGB: [1, 1, 0.96], clodRange: [55, 130],
      scorch: ['rgba(6,6,7,0.6)', 'rgba(10,10,11,0.4)'],
      track: { rgb: '10,10,11', a: 0.5, tickRGB: '6,6,7', tickA: 0.5 },
      grass: { base: ['rgba(72,82,52,0.35)', 'rgba(64,74,46,0.25)'], blades: ['hsla(90,22%,30%,0.8)', 'hsla(80,20%,22%,0.8)', 'hsla(70,18%,38%,0.7)'], density: 8 },
      gravel: { base: ['rgba(118,116,108,0.6)', 'rgba(104,102,96,0.45)'], pebble: [85, 150] },
      puddle: { dark: ['rgba(12,13,16,0.92)', 'rgba(20,22,26,0.88)', 'rgba(28,30,34,0)'], sheen: 'rgba(130,140,150,0.28)' },
      wall: 'rgba(8,8,9,0.45)',
      macro: { dark: 'rgba(10,10,12,0.2)', light: 'rgba(150,150,144,0.1)' },
      stones: { range: [60, 140], tint: [1, 0.98], n: 1400 },
      rim: 0x5a5a56,
    },
    preview: { ground: '#4b4d50', block: '#a9a8a2' },
  },
  frost: {
    sky: [0x44566b, 0xaab8c6, 0xc2cdd6], fog: [45, 240], exposure: 0.92,
    sun: [0xe6efff, 2.2, -30, 36, -45], hemi: [0xdbe6f2, 0x8794a3, 1.8],
    clouds: { amount: 0.7, dark: 0x4b5867, light: 0xb7c3cf },
    precip: 'snow', horizon: { columns: 4, flash: false }, sunFlicker: 0.4, props: true,
    outer: 'snow', floor: 'snowpack', floorRepeat: 8, paint: [0x6d8aa3, 0.25], dust: 0xe8eef3,
    wall: 0xa8b0b8, cap: 0xeef3f7, concrete: 0xb8bcc0, roof: 0xf2f6f9, snowCaps: true,
    trees: { count: 170, h: [0.36, 0.44], s: [0.2, 0.35], l: [0.13, 0.2] },
    rocks: 0xa9b4bd, mountains: { h: [0.58, 0.62], s: [0.08, 0.14], l: [0.7, 0.82] }, snowfall: true,
    ground: {
      res: 1024,
      count: { craters: 8, shells: 14, scorch: 5, grass: 8, gravel: 6, puddles: 4, tracks: 7 },
      crater: [2, 4.6],
      pit: ['rgba(46,54,66,0.92)', 'rgba(78,92,108,0.8)', 'rgba(150,168,186,0.3)'],
      rimLit: 'rgba(250,252,255,0.75)', rimShade: 'rgba(170,190,210,0.5)',
      arcShadow: 'rgba(30,42,58,0.45)', arcLit: 'rgba(255,255,255,0.5)', arcRim: 'rgba(255,255,255,0.5)',
      clodRGB: [0.8, 0.88, 1], clodRange: [40, 90],
      scorch: ['rgba(16,18,22,0.55)', 'rgba(24,28,34,0.35)'],
      track: { rgb: '58,66,80', a: 0.5, tickRGB: '40,48,60', tickA: 0.55 },
      grass: { base: ['rgba(255,255,255,0.55)', 'rgba(235,243,250,0.4)'], blades: ['hsla(210,40%,96%,0.8)', 'hsla(205,35%,88%,0.8)', 'hsla(215,30%,80%,0.6)'], density: 10 },
      gravel: { base: ['rgba(70,74,80,0.6)', 'rgba(62,66,72,0.45)'], pebble: [60, 120] },
      puddle: { dark: ['rgba(130,170,200,0.75)', 'rgba(150,185,210,0.65)', 'rgba(170,200,220,0)'], sheen: 'rgba(255,255,255,0.5)' },
      wall: 'rgba(80,95,115,0.3)',
      macro: { dark: 'rgba(120,140,165,0.14)', light: 'rgba(255,255,255,0.2)' },
      stones: { range: [120, 210], tint: [0.96, 1], n: 1000 },
      rim: 0xdfe7ee,
    },
    preview: { ground: '#d8dfe6', block: '#b8bcc0' },
  },
  // battlefield under heavy cloud: muted greys and browns, ash in the air, smoke on the horizon.
  // clouds.amount = how much of the sky is covered (0..1)
  war: {
    sky: [0x2a2f35, 0x8a8378, 0x4a4640], fog: [38, 230], exposure: 1.0,
    sun: [0xffd2a0, 2.6, 58, 34, -28], hemi: [0xc2c9d0, 0x80725f, 2.4],
    clouds: { amount: 0.85, dark: 0x23262a, light: 0x7d7b76 },
    outer: 'wasteland', floor: 'mud', floorRepeat: 10, paint: [0xf2efe6, 0], dust: 0x6a6054,
    wall: 0x9a968e, cap: 0x6a6762, concrete: 0xaaa497, roof: 0x7a766d, snowCaps: false,
    trees: { count: 45, h: [0.17, 0.22], s: [0.12, 0.22], l: [0.1, 0.16] },
    rocks: 0x6f6c66, mountains: { h: [0.08, 0.1], s: [0.06, 0.1], l: [0.16, 0.22], flat: 0.28, dome: true }, snowfall: true, ash: true, war: true,
    horizon: { columns: 9, flash: true }, sunFlicker: 1, lightning: [28, 70], embers: true,
    props: true, ground: {},
    preview: { ground: '#4d443a', block: '#7c786f' },
  },
};

const ob = (type, x, z, w, d, h, color) => ({ type, x, z, w, d, h, color });
const withRot = (o, rot) => ({ ...o, rot });
const withSolid = (o) => ({ ...o, solid: true });
const withSnow = (o) => ({ ...o, snow: true });
const boomDown = (o) => ({ ...o, broken: true });
const withY = (o, y = 9.02) => ({ ...o, y }); // standing on the bridge deck
const MAPS = [
  {
    id: 'quarry', name: 'Quarry', desc: 'Open dirt pit with bunkers and containers', theme: 'quarry', seed: 1337,
    markings: 'quarry', playerStart: { x: 0, z: -42 },
    spawns: [[-40, -40], [40, -40], [-40, 40], [40, 40], [0, 42], [-42, 20], [42, 20], [-42, -20], [42, -20], [20, 0], [-20, 0]],
    obstacles: [
      ob('bunker', -20, -20, 6, 6, 3), ob('bunker', 20, -20, 6, 6, 3), ob('bunker', -20, 20, 6, 6, 3), ob('bunker', 20, 20, 6, 6, 3),
      ob('barrier', 0, 0, 10, 4, 3.5),
      ob('container', -35, 0, 4, 12, 3, 0x9c4a32), ob('container', 35, 0, 4, 12, 3, 0x3f6688),
      ob('container', 0, -30, 12, 3, 3, 0x3d7d74), ob('container', 0, 30, 12, 3, 3, 0x8a6a3a),
      // mining machinery and rock banks (the same turned half a circle)
      ob('embankment', -47.5, 26, 3, 16, 2.6), ob('embankment', 47.5, -26, 3, 16, 2.6),
      withRot(ob('excavator', -31, -35, 4, 6, 3), 0.3), withRot(boomDown(ob('excavator', 31, 35, 4, 6, 3)), 0.3 + Math.PI),
      withRot(ob('haultruck', 31, -33, 5, 9, 4), -0.5), withRot(ob('haultruck', -31, 33, 5, 9, 4), -0.5 + Math.PI),
      withRot(ob('conveyor', -45.5, 0, 20, 4, 7), -Math.PI / 2), withRot(ob('conveyor', 45.5, 0, 20, 4, 7), Math.PI / 2),
      ob('drums', -26, -14, 2, 2, 1), ob('drums', 26, 14, 2, 2, 1),
      ob('floodlight', -47, -22, 1, 1, 7), ob('floodlight', 47, 22, 1, 1, 7),
    ],
  },
  {
    id: 'depot', name: 'Depot', desc: 'Tight container yard, lots of corners', theme: 'depot', seed: 2024,
    markings: 'depot', playerStart: { x: 0, z: -42 },
    spawns: [[-42, -42], [42, -42], [-42, 42], [42, 42], [0, 42], [-42, 0], [42, 0], [-26, -20], [26, 20], [26, -20], [-26, 20], [0, -25], [0, 25]],
    obstacles: [
      ob('container', -30, -32, 12, 3, 3, 0x9c4a32), ob('container', 30, -32, 12, 3, 3, 0x3f6688),
      ob('container', -30, 32, 12, 3, 3, 0x3d7d74), ob('container', 30, 32, 12, 3, 3, 0x8a6a3a),
      ob('container', 0, -14, 14, 3, 6, 0x8fa352), ob('container', 0, 14, 14, 3, 6, 0xb05248),
      ob('container', -16, 0, 3, 12, 3, 0x3f6688), ob('container', 16, 0, 3, 12, 3, 0x9c4a32),
      ob('crates', -36, -14, 4, 4, 2.6), ob('crates', 36, 14, 4, 4, 2.6),
      ob('crates', -36, 14, 4, 4, 2.6), ob('crates', 36, -14, 4, 4, 2.6),
      ob('barrier', 0, 0, 5, 2, 2.2),
      // a ruined logistics yard: warehouses, loading docks, pallets, wrecks, gantries (the same turned half a circle)
      withRot(ob('warehouse', -44.5, 27, 20, 11, 6), Math.PI / 2), withRot(ob('warehouse', 44.5, -27, 20, 11, 6), -Math.PI / 2),
      withRot(ob('dock', -45, -22, 14, 4, 1.3), Math.PI / 2), withRot(ob('dock', 45, 22, 14, 4, 1.3), -Math.PI / 2),
      ob('pallets', -22, -8, 3, 2, 1.5), ob('pallets', 22, 8, 3, 2, 1.5),
      withRot(ob('wreckTruck', -14, -45, 3, 7, 3), 0.3), withRot(ob('wreckTruck', 14, 45, 3, 7, 3), 0.3 + Math.PI),
      ob('gantry', 0, 36, 20, 2, 9.6), withRot(ob('gantry', 0, -36, 20, 2, 9.6), Math.PI),
      ob('drumfire', -8, -20, 1, 1, 1), ob('drumfire', 8, 20, 1, 1, 1),
    ],
  },
  {
    id: 'frost', name: 'Frostbite', desc: 'Snowy outpost with ice blocks', theme: 'frost', seed: 777,
    markings: 'none', playerStart: { x: 0, z: -42 },
    spawns: [[-40, -40], [40, -40], [-40, 40], [40, 40], [0, 42], [-42, 0], [42, 0], [28, 28], [-28, -28], [28, -28], [-28, 28], [0, 14], [0, -14]],
    obstacles: [
      ob('bunker', 0, 0, 6, 6, 3),
      ob('ice', -15, -15, 5, 5, 3), ob('ice', 15, 15, 5, 5, 3), ob('ice', 15, -15, 5, 5, 3), ob('ice', -15, 15, 5, 5, 3),
      ob('block', 0, -27, 10, 2, 2.6), ob('block', 0, 27, 10, 2, 2.6), ob('block', -27, 0, 2, 10, 2.6), ob('block', 27, 0, 2, 10, 2.6),
      ob('crates', -38, -24, 4, 4, 2.6), ob('crates', 38, 24, 4, 4, 2.6),
      // frosted ruins, wrecks, drifts and ice (the same turned half a circle)
      withSnow(ob('ruinWall', -20, -38, 10, 1.2, 3)), withSnow(ob('ruinWall', 20, 38, 10, 1.2, 3)),
      withSnow(withRot(ob('ruin', -45, -12, 10, 8, 4), Math.PI / 2)), withSnow(withRot(ob('ruin', 45, 12, 10, 8, 4), -Math.PI / 2)),
      withSnow(withRot(ob('wreckTank', -34, 18, 3, 5, 2.4), 0.6)), withSnow(withRot(ob('wreckTank', 34, -18, 3, 5, 2.4), 0.6 + Math.PI)),
      withSnow(withRot(ob('wreckTruck', 24, -38, 3, 7, 3), Math.PI / 2)), withSnow(withRot(ob('wreckTruck', -24, 38, 3, 7, 3), -Math.PI / 2)),
      withSnow(ob('sandbags', -34, -8, 5, 1.2, 1)), withSnow(ob('sandbags', 34, 8, 5, 1.2, 1)),
      ob('snowdrift', -34, 30, 9, 3, 1), ob('snowdrift', 34, -30, 9, 3, 1), ob('snowdrift', -12, 40, 9, 3, 1), ob('snowdrift', 12, -40, 9, 3, 1),
      ob('iceshard', -10, -8, 2, 2, 2), ob('iceshard', 10, 8, 2, 2, 2),
      ob('drumfire', -12, -34, 1, 1, 1), ob('drumfire', 12, 34, 1, 1, 1),
    ],
  },
  {
    id: 'warzone', name: 'Warzone', desc: 'Shell-torn battlefield under a smoky sky', theme: 'war', seed: 4242,
    markings: 'none', playerStart: { x: 0, z: -42 },
    spawns: [[-40, -40], [40, -40], [-40, 40], [40, 40], [0, 42], [-42, 18], [42, -18], [-42, -18], [42, 18], [-14, -26], [14, 26]],
    // the middle is left open on purpose: a landmark goes there in a later step.
    // The layout is the same turned half a circle, so both sides get the same cover.
    obstacles: [
      ob('bridge', 0, 0, 264, 18, 9),
      ob('ruinbunker', -22, -16, 6, 6, 3.4), ob('ruinbunker', 22, 16, 6, 6, 3.4),
      ob('bunker', -30, 18, 6, 6, 3), ob('bunker', 30, -18, 6, 6, 3),
      withRot(ob('ruin', -36, 31, 14, 10, 4.6), Math.PI), ob('ruin', 36, -31, 14, 10, 4.6),
      ob('ruinWall', -14, 6, 10, 1.2, 3.2), ob('ruinWall', 14, -6, 10, 1.2, 3.2),
      ob('container', -38, -4, 4, 12, 3, 0x7a4a30), ob('container', 38, 4, 4, 12, 3, 0x4f5a3a),
      ob('container', -12, -32, 12, 3, 3, 0x55603f), ob('container', 12, 32, 12, 3, 3, 0x6b4a38),
      ob('sandbags', -34, -30, 6, 1.2, 1), ob('sandbags', 34, 30, 6, 1.2, 1),
      ob('sandbags', -6, 22, 5, 1.2, 1), ob('sandbags', 6, -22, 5, 1.2, 1),
      ob('hedgehog', -17, -3, 1.6, 1.6, 1.6), ob('hedgehog', 17, 3, 1.6, 1.6, 1.6),
      withSolid(ob('rubble', -18, 26, 3.2, 3.2, 1.4)), withSolid(ob('rubble', 18, -26, 3.2, 3.2, 1.4)),
      ob('checkpoint', 22, -40, 8, 4, 3), withRot(ob('checkpoint', -22, 40, 8, 4, 3), Math.PI),
      // battlefield props: also the same turned half a circle
      withRot(ob('wreckTank', -31, -9, 3, 5, 2.4), 0.7), withRot(ob('wreckTank', 31, 9, 3, 5, 2.4), 0.7 + Math.PI),
      withRot(ob('wreckTruck', -40, -24, 3, 7, 3), Math.PI / 2), withRot(ob('wreckTruck', 40, 24, 3, 7, 3), -Math.PI / 2),
      ob('ammo', -8, -18, 3, 1.4, 1.5), ob('ammo', 8, 18, 3, 1.4, 1.5),
      ob('wire', -26, -35, 8, 0.6, 1), ob('wire', 26, 35, 8, 0.6, 1),
      ob('streetlight', -10, -46, 1, 1, 5), ob('streetlight', 10, 46, 1, 1, 5),
      ob('sign', -18, -44, 1, 1, 2.5), ob('sign', 18, 44, 1, 1, 2.5),
      ob('drumfire', -20, 30, 1, 1, 1), ob('drumfire', 20, -30, 1, 1, 1),
      // up on the road: a burnt-out tank and truck
      withY(withRot(ob('wreckTank', -30, 2.5, 3, 5, 2.4), 0.15)), withY(withRot(ob('wreckTruck', 12, -3, 3, 7, 3), -Math.PI / 2 + 0.1)),
    ],
  },
];

const arena = new THREE.Group(); // everything that belongs to the current map
scene.add(arena);
const boxes = []; // AABBs on the xz plane, used for tank and bullet collisions
let currentMap = null;
let theme = THEMES.quarry;
let SPAWNS = [];
let PLAYER_START = { x: 0, z: -42 };

function addCollider(x, z, w, d) {
  boxes.push({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2 });
}
function addMesh(geo, mat, x, y, z, parent = arena) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  parent.add(m);
  return m;
}
const concreteMat = (color) => new THREE.MeshStandardMaterial({ map: tex('concrete'), color, roughness: 0.92 });
const snowCapMat = () => new THREE.MeshStandardMaterial({ map: tex('snow'), roughness: 0.9 });
const darkMetal = new THREE.MeshStandardMaterial({ color: 0x2c2e31, roughness: 0.5, metalness: 0.6 });

// a slab on top of a block: snow in the snow theme, darker concrete elsewhere
function addCap(x, z, w, d, y, color) {
  addMesh(worldUV(new THREE.BoxGeometry(w, 0.4, d), 4), theme.snowCaps ? snowCapMat() : concreteMat(color), x, y + 0.2, z);
}

const BUILDERS = {
  bunker({ x, z, w, d, h }) {
    addMesh(worldUV(new THREE.BoxGeometry(w, h, d), 4), concreteMat(theme.concrete), x, h / 2, z);
    addCap(x, z, w + 0.5, d + 0.5, h, theme.roof);
    for (const s of [-1, 1]) {
      addMesh(new THREE.BoxGeometry(w * 0.6, 0.28, 0.1), darkMetal, x, h * 0.66, z + s * (d / 2 + 0.03));
      addMesh(new THREE.BoxGeometry(0.1, 0.28, d * 0.6), darkMetal, x + s * (w / 2 + 0.03), h * 0.66, z);
    }
    addCollider(x, z, w, d);
  },
  container({ x, z, w, d, h, color }) {
    // tall ones are drawn as two stacked containers
    const layers = h >= 5.5 ? 2 : 1;
    const lh = h / layers;
    for (let i = 0; i < layers; i++) {
      const c = new THREE.Color(color).multiplyScalar(i ? 0.82 : 1);
      const mat = new THREE.MeshStandardMaterial({ map: tex('container'), color: c, roughness: 0.55, metalness: 0.35 });
      addMesh(worldUV(new THREE.BoxGeometry(w, lh - 0.04, d), 3), mat, x, lh * i + lh / 2, z);
    }
    const post = new THREE.BoxGeometry(0.3, h + 0.04, 0.3);
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) addMesh(post, darkMetal, x + sx * (w / 2 - 0.12), h / 2, z + sz * (d / 2 - 0.12));
    }
    if (theme.snowCaps) addMesh(worldUV(new THREE.BoxGeometry(w, 0.2, d), 4), snowCapMat(), x, h + 0.1, z);
    addCollider(x, z, w, d);
  },
  barrier({ x, z, w, d, h }) {
    addMesh(worldUV(new THREE.BoxGeometry(w, h, d), 4), concreteMat(0xa9a9a4), x, h / 2, z);
    const band = new THREE.MeshStandardMaterial({ map: tex('hazard'), roughness: 0.7 });
    addMesh(worldUV(new THREE.BoxGeometry(w + 0.04, 0.6, d + 0.04), 1.2), band, x, 0.55, z);
    addCap(x, z, w + 0.3, d + 0.3, h, 0x7c7c78);
    addCollider(x, z, w, d);
  },
  block({ x, z, w, d, h }) {
    addMesh(worldUV(new THREE.BoxGeometry(w, h, d), 4), concreteMat(theme.concrete), x, h / 2, z);
    addCap(x, z, w + 0.3, d + 0.3, h, theme.roof);
    addCollider(x, z, w, d);
  },
  crates({ x, z, w, d, h }) {
    const mat = new THREE.MeshStandardMaterial({ map: tex('crate'), roughness: 0.85 });
    addMesh(worldUV(new THREE.BoxGeometry(w, h, d), 2), mat, x, h / 2, z);
    if (theme.snowCaps) addMesh(worldUV(new THREE.BoxGeometry(w, 0.2, d), 4), snowCapMat(), x, h + 0.1, z);
    addCollider(x, z, w, d);
  },
  ice({ x, z, w, d, h }) {
    const mat = new THREE.MeshStandardMaterial({ map: tex('ice'), roughness: 0.2, metalness: 0.05 });
    addMesh(worldUV(new THREE.BoxGeometry(w, h, d), 3), mat, x, h / 2, z);
    addMesh(worldUV(new THREE.BoxGeometry(w + 0.2, 0.25, d + 0.2), 4), snowCapMat(), x, h + 0.12, z);
    addCollider(x, z, w, d);
  },
};

function buildMarkings(kind) {
  if (kind === 'none') return;
  const [color, opacity] = theme.paint;
  const mat = new THREE.MeshStandardMaterial({
    color, transparent: true, opacity, roughness: 1, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8,
  });
  const mark = (geo, x, z) => {
    const m = new THREE.Mesh(geo, mat);
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, 0.02, z);
    m.receiveShadow = true;
    arena.add(m);
  };
  for (const s of [-1, 1]) {
    mark(new THREE.PlaneGeometry(ARENA * 2 - 6, 0.4), 0, s * (ARENA - 3));
    mark(new THREE.PlaneGeometry(0.4, ARENA * 2 - 6), s * (ARENA - 3), 0);
  }
  if (kind === 'quarry') mark(new THREE.RingGeometry(9, 9.5, 64), 0, 0);
  if (kind === 'depot') {
    // dashed driving lanes
    const dash = new THREE.PlaneGeometry(0.35, 2.4);
    for (const x of [-23, 23]) for (let z = -24; z <= 24; z += 5) mark(dash, x, z);
  }
}

const dummy = new THREE.Object3D();
function scatter(mesh, count, rMin, rMax, place) {
  for (let i = 0; i < count; i++) {
    const a = srand() * Math.PI * 2;
    const r = srnd(rMin, rMax);
    dummy.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
    dummy.rotation.set(0, srand() * Math.PI * 2, 0);
    dummy.scale.set(1, 1, 1);
    place(dummy, i);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  arena.add(mesh);
}

function buildScenery() {
  const tmp = new THREE.Color();
  const tc = theme.trees;
  const treeCount = theme.war ? 0 : tc.count; // the war map has dead trees instead (below)
  const foliage = new THREE.InstancedMesh(
    new THREE.ConeGeometry(1, 1, 7).translate(0, 0.5, 0),
    new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.9 }),
    treeCount
  );
  const trunks = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.25, 0.35, 1, 6).translate(0, 0.5, 0),
    new THREE.MeshStandardMaterial({ color: 0x5a4030, flatShading: true, roughness: 1 }),
    treeCount
  );
  const caps = theme.snowCaps
    ? new THREE.InstancedMesh(
      new THREE.ConeGeometry(1, 1, 7).translate(0, 0.5, 0),
      new THREE.MeshStandardMaterial({ color: 0xf4f8fb, flatShading: true, roughness: 0.9 }),
      treeCount
    )
    : null;
  foliage.castShadow = trunks.castShadow = true;
  const spots = [];
  scatter(foliage, treeCount, 60, 160, (d, i) => {
    let r = srnd(1.8, 3.2);
    let h = srnd(5, 9);
    if (theme.war && Math.abs(d.position.z) < 13) { r = 0.001; h = 0.001; } // none growing through the bridge
    d.position.y = 1.4;
    d.scale.set(r, h, r);
    spots.push({ x: d.position.x, z: d.position.z, r, h });
    foliage.setColorAt(i, tmp.setHSL(srnd(...tc.h), srnd(...tc.s), srnd(...tc.l)));
  });
  spots.forEach((t, i) => {
    dummy.rotation.set(0, 0, 0);
    dummy.position.set(t.x, 0, t.z);
    dummy.scale.set(t.r / 2.5, 1.6, t.r / 2.5);
    dummy.updateMatrix();
    trunks.setMatrixAt(i, dummy.matrix);
    if (caps) {
      dummy.position.set(t.x, 1.4 + t.h * 0.52, t.z);
      dummy.scale.set(t.r * 0.52, t.h * 0.49, t.r * 0.52);
      dummy.updateMatrix();
      caps.setMatrixAt(i, dummy.matrix);
    }
  });
  trunks.instanceMatrix.needsUpdate = true;
  arena.add(trunks);
  if (caps) {
    caps.instanceMatrix.needsUpdate = true;
    arena.add(caps);
  }

  const rocks = new THREE.InstancedMesh(
    new THREE.DodecahedronGeometry(1, 0),
    new THREE.MeshStandardMaterial({ color: theme.rocks, flatShading: true, roughness: 0.95 }),
    60
  );
  rocks.castShadow = rocks.receiveShadow = true;
  scatter(rocks, 60, theme.war ? 75 : 55, 150, (d) => {
    const s = srnd(0.6, 2.4);
    d.scale.set(s * srnd(0.8, 1.4), s * srnd(0.5, 0.9), s);
    d.rotation.set(srand(), srand() * 6, srand());
  });

  const mc = theme.mountains;
  const mountains = new THREE.InstancedMesh(
    mc.dome ? new THREE.SphereGeometry(1, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2) : new THREE.ConeGeometry(1, 1, 6).translate(0, 0.5, 0),
    new THREE.MeshStandardMaterial({ flatShading: true, roughness: 1 }),
    22
  );
  scatter(mountains, 22, 230, 320, (d, i) => {
    const r = srnd(45, 85);
    d.scale.set(r, srnd(40, 85) * (mc.flat ?? 1), r); // flat < 1 squashes them into low hills
    d.position.y = -2;
    mountains.setColorAt(i, tmp.setHSL(srnd(...mc.h), srnd(...mc.s), srnd(...mc.l)));
  });

  if (theme.war) { // bare dead trees outside the walls, none under the bridge
    const dead = new THREE.InstancedMesh(deadTree(), new THREE.MeshStandardMaterial({ color: 0x4a4036, flatShading: true, roughness: 1 }), tc.count);
    dead.castShadow = true;
    scatter(dead, tc.count, 75, 170, (d) => {
      const k = Math.abs(d.position.z) < 14 ? 0.001 : srnd(0.8, 1.7);
      d.scale.set(k, k * srnd(0.9, 1.3), k);
      d.rotation.set(srnd(-0.08, 0.08), srand() * 6, srnd(-0.08, 0.08));
    });
  }
}

let sunBase = 2.8; // sun strength from the theme; clouds passing make it flicker around this
let sunFlicker = 0; // how much (0 = steady, 1 = the full war-sky swing)
let horizonCols = 0; // how many distant smoke columns this map shows
let horizonFlash = false; // distant explosion flashes
function applyTheme() {
  skyUniforms.top.value.set(theme.sky[0]);
  skyUniforms.horizon.value.set(theme.sky[1]);
  skyUniforms.bottom.value.set(theme.sky[2]);
  scene.background.set(theme.sky[1]);
  scene.fog.color.set(theme.sky[1]);
  [scene.fog.near, scene.fog.far] = theme.fog;
  const [sunColor, sunIntensity, sx, sy, sz] = theme.sun;
  sun.color.set(sunColor);
  sun.intensity = sunIntensity;
  sun.position.set(sx, sy, sz);
  skyUniforms.sunDir.value.copy(sun.position).normalize();
  hemi.color.set(theme.hemi[0]);
  hemi.groundColor.set(theme.hemi[1]);
  hemi.intensity = theme.hemi[2];
  renderer.toneMappingExposure = theme.exposure;
  const cl = theme.clouds;
  skyUniforms.cloudAmount.value = cl ? cl.amount : 0;
  if (cl) {
    skyUniforms.cloudMap.value = tex('clouds');
    skyUniforms.cloudDark.value.set(cl.dark);
    skyUniforms.cloudLight.value.set(cl.light);
  }
  sunBase = sunIntensity;
  snow.visible = theme.snowfall;
  precip = PRECIP[theme.precip || (theme.ash ? 'ash' : 'snow')];
  snow.material.color.set(precip.color);
  snow.material.size = precip.size;
  snow.material.opacity = precip.opacity;
  snow.material.map = precip.round ? smokeTex : null; // soft round flakes instead of squares
  snow.material.needsUpdate = true;
  war.visible = !!theme.horizon;
  horizonCols = theme.horizon ? theme.horizon.columns : 0;
  horizonFlash = !!(theme.horizon && theme.horizon.flash);
  sunFlicker = theme.sunFlicker || 0;
  smokeMat.uniforms.fogColor.value.copy(scene.fog.color);
  smokeMat.uniforms.fogRange.value.set(theme.fog[0], theme.fog[1]);
}

function disposeArena() {
  arena.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) for (const m of [].concat(o.material)) m.dispose();
  });
  arena.clear();
}

// ---------- War structures: ruined walls, collapsed buildings, sandbags, fences, a checkpoint ----------
// Every piece is a transformed copy of a box or cylinder. All pieces sharing a material are merged,
// so the whole set of ruins costs only a handful of draw calls.
const warFadeMats = []; // deck materials that turn see-through when the camera looks down through them
const fading = (m) => {
  warFadeMats.push(m);
  return m;
};
const WAR_MATS = {
  rock: () => new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 1 }),
  snow: () => new THREE.MeshStandardMaterial({ map: tex('snow'), vertexColors: true, roughness: 0.95 }),
  ice: () => new THREE.MeshStandardMaterial({ map: tex('ice'), vertexColors: true, roughness: 0.25, metalness: 0.05 }),
  wood: () => new THREE.MeshStandardMaterial({ map: tex('crate'), vertexColors: true, roughness: 0.9 }),
  corr: () => new THREE.MeshStandardMaterial({ map: tex('corrugated'), vertexColors: true, roughness: 0.7, metalness: 0.3 }),
  skyl: () => new THREE.MeshStandardMaterial({ map: tex('facade'), vertexColors: true, roughness: 1 }),
  deck: () => fading(new THREE.MeshStandardMaterial({ map: tex('concretewar'), vertexColors: true, roughness: 0.93, transparent: true })),
  road: () => fading(new THREE.MeshStandardMaterial({
    map: roadTexture(), vertexColors: true, roughness: 0.9, transparent: true,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4,
  })),
  // the steelwork under the deck fades with it, so a tank underneath is never hidden by a girder
  gird: () => fading(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0.45, transparent: true })),
  // a soft dark band on the ground under the bridge, standing in for ambient occlusion
  shade: () => new THREE.MeshBasicMaterial({
    map: tex('stripshade'), vertexColors: true, transparent: true, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8,
  }),
  conc: () => new THREE.MeshStandardMaterial({ map: tex('concretewar'), vertexColors: true, roughness: 0.93 }),
  brick: () => new THREE.MeshStandardMaterial({ map: tex('brick'), vertexColors: true, roughness: 0.95 }),
  steel: () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0.45 }),
  bag: () => new THREE.MeshStandardMaterial({ map: tex('sandbag'), vertexColors: true, roughness: 1 }),
  hazard: () => new THREE.MeshStandardMaterial({ map: tex('hazard'), vertexColors: true, roughness: 0.7 }),
  // dark scorched ground under wrecks
  burn: () => new THREE.MeshStandardMaterial({
    map: tex('scorch'), vertexColors: true, transparent: true, depthWrite: false, roughness: 1,
    polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -12,
  }),
  chain: () => new THREE.MeshStandardMaterial({
    map: tex('chainlink'), vertexColors: true, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.6, metalness: 0.4,
  }),
};

class Batch {
  constructor(rng) {
    this.rng = rng;
    this.parts = {};
    this.frame = new THREE.Matrix4();
    this.angle = 0;
    this.fx = 0;
    this.fz = 0;
  }

  // everything added afterwards is placed relative to a structure standing at (x, z), turned by `angle`
  setFrame(x, z, angle = 0, y = 0) {
    this.fx = x;
    this.fz = z;
    this.angle = angle;
    this.solid = y < 0.5; // things standing up on the bridge deck must not block the ground below
    this.frame.makeRotationY(angle).setPosition(x, y, z);
  }

  add(key, geo, x, y, z, rot, tint) {
    const m = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rot?.[0] || 0, rot?.[1] || 0, rot?.[2] || 0));
    m.setPosition(x, y, z);
    m.premultiply(this.frame);
    geo.applyMatrix4(m);
    const col = new THREE.Color(tint ?? 0xffffff);
    const n = geo.attributes.position.count;
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      arr[i * 3] = col.r;
      arr[i * 3 + 1] = col.g;
      arr[i * 3 + 2] = col.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    (this.parts[key] ||= []).push(geo);
  }

  // a box centred at (x, y, z); `tile` = world units per texture repeat
  box(key, w, h, d, x, y, z, rot, tint, tile = 4) {
    const g = worldUV(new THREE.BoxGeometry(w, h, d), tile);
    const uv = g.attributes.uv;
    const ou = this.rng(), ov = this.rng(); // a different bit of texture on every box
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) + ou, uv.getY(i) + ov);
    this.add(key, g, x, y, z, rot, tint);
  }

  cyl(key, rTop, rBot, len, x, y, z, rot, tint, seg = 5) {
    this.add(key, new THREE.CylinderGeometry(rTop, rBot, len, seg), x, y, z, rot, tint);
  }

  panel(key, w, h, x, y, z, rot, tint, tile = 1) {
    this.add(key, worldUV(new THREE.PlaneGeometry(w, h), tile), x, y, z, rot, tint);
  }

  // a flat decal lying on the ground (uses the whole 0..1 texture)
  decal(key, size, x, z, tint, y = 0.035) {
    this.add(key, new THREE.PlaneGeometry(size, size), x, y, z, [-Math.PI / 2, 0, 0], tint);
  }

  // a ring of wire and the like: any ready-made geometry
  geo(key, geometry, x, y, z, rot, tint) {
    this.add(key, geometry, x, y, z, rot, tint);
  }

  // a fire burning at a point in the structure's frame (drawn by updateWar)
  fire(lx, ly, lz, size) {
    const v = new THREE.Vector3(lx, ly, lz).applyMatrix4(this.frame);
    warFires.push({ x: v.x, y: v.y, z: v.z, size, phase: Math.random(), period: 6 + Math.random() * 3 });
  }

  // a solid footprint for something turned by any angle: the box around the rotated rectangle, a little shrunk
  collideBounds(cx, cz, sx, sz) {
    if (!this.solid) return;
    const c = Math.cos(this.angle), s = Math.sin(this.angle);
    const ex = Math.abs(c) * sx + Math.abs(s) * sz, ez = Math.abs(s) * sx + Math.abs(c) * sz;
    addCollider(this.fx + cx * c + cz * s, this.fz - cx * s + cz * c, ex * 0.88, ez * 0.88);
  }

  // a solid footprint: centre (cx, cz) and size (sx, sz) in the structure's own frame
  collide(cx, cz, sx, sz) {
    if (!this.solid) return;
    const c = Math.cos(this.angle), s = Math.sin(this.angle);
    const quarter = Math.abs(Math.round(this.angle / (Math.PI / 2))) % 2 === 1;
    addCollider(this.fx + cx * c + cz * s, this.fz - cx * s + cz * c, quarter ? sz : sx, quarter ? sx : sz);
  }

  flush(shadows = true) {
    for (const [key, geos] of Object.entries(this.parts)) {
      const mesh = new THREE.Mesh(mergeGeometries(geos, false), WAR_MATS[key]());
      geos.forEach((g) => g.dispose());
      mesh.castShadow = shadows && key !== 'chain' && key !== 'burn' && key !== 'shade' && key !== 'road';
      mesh.receiveShadow = true;
      if (key === 'shade') mesh.renderOrder = -0.4;
      if (key === 'burn') mesh.renderOrder = -0.5; // above the ground overlay, below combat scorch marks
      arena.add(mesh);
    }
    this.parts = {};
  }
}
let warBatch = null;
const warFires = []; // burning spots: { x, y, z, size, phase, period }
const rngFor = (o) => mulberry32((Math.round(o.x * 100) * 7919 + Math.round(o.z * 100) * 104729 + 13) | 0);
const grey = (v) => new THREE.Color().setScalar(Math.min(1, v));

// a steel I-beam along local z, tilted by `rot`
function ibeam(B, len, x, y, z, rot, tint = 0x5e4030) {
  const off = new THREE.Vector3(0, 0.15, 0).applyEuler(new THREE.Euler(...rot));
  B.box('steel', 0.07, 0.3, len, x, y, z, rot, tint, 2);
  B.box('steel', 0.22, 0.05, len, x + off.x, y + off.y, z + off.z, rot, tint, 2);
  B.box('steel', 0.22, 0.05, len, x - off.x, y - off.y, z - off.z, rot, tint, 2);
}

// a heap of broken concrete and brick; `solid` also makes it block tanks and shells
function rubblePile(B, rng, x, z, r, { solid = false, y0 = 0, brick = 0.3 } = {}) {
  const n = Math.floor(7 + r * 6);
  for (let i = 0; i < n; i++) {
    const a = rng() * Math.PI * 2, d = r * Math.sqrt(rng());
    const sz = 0.22 + rng() * 0.5 * (1.15 - (0.6 * d) / r);
    const isBrick = rng() < brick;
    B.box(isBrick ? 'brick' : 'conc', sz * (0.8 + rng() * 0.7), sz * (0.5 + rng() * 0.5), sz * (0.8 + rng() * 0.7),
      x + Math.cos(a) * d, y0 + (1 - d / r) * r * 0.45 + sz * 0.25, z + Math.sin(a) * d,
      [rng() * 0.9, rng() * 3, rng() * 0.9], grey(0.33 + rng() * 0.3), isBrick ? 2 : 3);
  }
  for (let i = 0; i < 2; i++) { // a couple of bent steel bars sticking out
    const a = rng() * Math.PI * 2, d = r * 0.5 * rng(), l = 0.6 + rng() * 0.7;
    B.cyl('steel', 0.025, 0.025, l, x + Math.cos(a) * d, y0 + r * 0.3 + l * 0.35, z + Math.sin(a) * d, [rng() * 0.8 - 0.4, 0, rng() * 0.8 - 0.4], 0x54402f, 4);
  }
  if (solid) B.collide(x, z, r * 1.5, r * 1.5);
}

// A wall of ragged segments, centred at (x, z) in the structure's frame and running along x or z.
// Some segments are chopped down, some have window holes, one stretch can be blown right out
// (a breach wide enough to drive through). Runs of standing segments become solid colliders.
function ruinedWall(B, rng, o) {
  const { key = 'conc', len, h, t, alongX = true, x = 0, z = 0, windows = false, breach = true, tall = false, taper = false, snow = false } = o;
  const tile = o.tile ?? (key === 'brick' ? 3 : 5);
  const base = new THREE.Color(o.tint ?? 0xffffff);
  const segs = [];
  for (let pos = 0; pos < len - 0.3;) {
    const w = Math.min(len - pos, 1.5 + rng() * 1.0);
    segs.push({ a: pos + w / 2, w });
    pos += w;
  }
  const bc = breach && len >= 9 ? len * (0.3 + rng() * 0.4) : -99;
  for (const sg of segs) {
    sg.breached = sg.a + sg.w / 2 > bc - 2.6 && sg.a - sg.w / 2 < bc + 2.6;
    let f;
    if (sg.breached) f = 0.1 + rng() * 0.12;
    else if (tall) f = 0.85 + rng() * 0.15;
    else f = rng() < 0.4 ? 0.45 + rng() * 0.4 : 0.9 + rng() * 0.1;
    if (taper) f *= 1 - 0.6 * (sg.a / len);
    sg.h = h * f;
    sg.solid = sg.h >= 0.9;
  }
  let run = null;
  const endRun = () => {
    if (!run) return;
    const ca = (run.a0 + run.a1) / 2 - len / 2, l = run.a1 - run.a0;
    B.collide(alongX ? x + ca : x, alongX ? z : z + ca, alongX ? l : t, alongX ? t : l);
    run = null;
  };
  for (const sg of segs) {
    if (!sg.solid) endRun();
    else if (run) run.a1 = sg.a + sg.w / 2;
    else run = { a0: sg.a - sg.w / 2, a1: sg.a + sg.w / 2 };
  }
  endRun();

  for (const sg of segs) {
    const along = sg.a - len / 2;
    const cx = alongX ? x + along : x, cz = alongX ? z : z + along;
    const tint = base.clone().multiplyScalar(rng() < 0.15 ? 0.55 : 0.78 + rng() * 0.22);
    // a box w long (along the wall), hh tall and tt thick, centred a metres along from the segment centre
    const put = (w, hh, tt, a, y) => B.box(key, alongX ? w : tt, hh, alongX ? tt : w, alongX ? cx + a : cx, y + hh / 2, alongX ? cz : cz + a, null, tint, tile);
    if (windows && sg.solid && sg.h > 2.4 && sg.w >= 1.8 && rng() < 0.65) {
      const ww = 1.0, pw = (sg.w - ww) / 2;
      put(pw, sg.h, t, -(ww + pw) / 2, 0);
      put(pw, sg.h, t, (ww + pw) / 2, 0);
      put(ww, 0.9, t, 0, 0);
      if (sg.h > 2.9) put(ww, sg.h - 2.2, t, 0, 2.2);
    } else {
      put(sg.w, sg.h, t, 0, 0);
    }
    if (snow && sg.solid) { // a cap of snow on top of the standing part
      B.box('snow', alongX ? sg.w * 0.96 : t * 1.2, 0.22, alongX ? t * 1.2 : sg.w * 0.96, cx, sg.h + 0.1, cz, [rng() * 0.06, 0, rng() * 0.06], grey(0.95), 4);
    }
    if (sg.solid && sg.h < h * 0.95) {
      for (let i = 0, n = 1 + (rng() < 0.5 ? 1 : 0); i < n; i++) { // broken shards on the top edge
        const sw = sg.w * (0.25 + rng() * 0.35), sh = 0.2 + rng() * 0.35, a = (rng() - 0.5) * (sg.w - sw), tt = t * (0.5 + rng() * 0.5);
        B.box(key, alongX ? sw : tt, sh, alongX ? tt : sw, alongX ? cx + a : cx, sg.h + sh * 0.4, alongX ? cz : cz + a,
          [rng() * 0.5 - 0.25, rng() * 0.6 - 0.3, rng() * 0.6 - 0.3], tint, tile);
      }
      for (let i = 0, n = 2 + Math.floor(rng() * 3); i < n; i++) { // exposed rebar
        const a = (rng() - 0.5) * sg.w * 0.9, l = 0.5 + rng() * 0.8, side = (rng() - 0.5) * t * 0.6;
        B.cyl('steel', 0.025, 0.025, l, alongX ? cx + a : cx + side, sg.h + l * 0.4, alongX ? cz + side : cz + a,
          [rng() * 0.7 - 0.35, 0, rng() * 0.7 - 0.35], 0x54402f, 4);
      }
    }
    if (sg.breached) {
      rubblePile(B, rng, cx, cz, 0.9 + rng() * 0.4);
    } else if (sg.solid && rng() < 0.35) {
      const sd = rng() < 0.5 ? -1 : 1, off = t / 2 + 0.5;
      rubblePile(B, rng, alongX ? cx : cx + sd * off, alongX ? cz + sd * off : cz, 0.7 + rng() * 0.5);
    }
  }
}

const BULLET_TINT = 0xb2aea6;

// a long damaged concrete wall (size w x d: the longer side is the length)
BUILDERS.ruinWall = (o) => {
  const B = warBatch, rng = rngFor(o);
  B.setFrame(o.x, o.z, 0, o.y);
  const alongX = o.w >= o.d;
  ruinedWall(B, rng, { key: 'conc', len: alongX ? o.w : o.d, h: o.h, t: alongX ? o.d : o.w, alongX, tint: BULLET_TINT, snow: !!o.snow });
};

// a bunker with one corner of its upper storey blown away
BUILDERS.ruinbunker = (o) => {
  const B = warBatch, rng = rngFor(o);
  B.setFrame(o.x, o.z, o.rot || 0, o.y);
  const { w, d, h } = o;
  const lowH = 2.0, uh = h - lowH;
  const cx = rng() < 0.5 ? -1 : 1, cz = rng() < 0.5 ? -1 : 1; // the broken corner
  B.box('conc', w, lowH, d, 0, lowH / 2, 0, null, grey(0.66), 4);
  B.box('conc', w, uh * 0.85, d / 2, 0, lowH + (uh * 0.85) / 2, -cz * d * 0.25, null, grey(0.6), 4);
  B.box('conc', w / 2, uh * 0.7, d / 2, -cx * w * 0.25, lowH + (uh * 0.7) / 2, cz * d * 0.25, null, grey(0.56), 4);
  B.box('conc', w * 0.96, 0.35, d * 0.56, 0, lowH + uh * 0.85 + 0.18, -cz * d * 0.25, [0.02, 0.03, rng() * 0.1 - 0.05], grey(0.5), 4); // roof slab, askew
  B.box('conc', w * 0.48, 0.3, d * 0.46, -cx * w * 0.25, lowH + uh * 0.7 + 0.3, cz * d * 0.25, [0.16 * cz, 0, 0.2 * cx], grey(0.46), 4); // slab slipped off
  for (const s of [-1, 1]) { // firing slits
    B.box('steel', w * 0.55, 0.26, 0.08, 0, 1.3, s * (d / 2 + 0.02), null, 0x161616, 2);
    B.box('steel', 0.08, 0.26, d * 0.55, s * (w / 2 + 0.02), 1.3, 0, null, 0x161616, 2);
  }
  rubblePile(B, rng, cx * w * 0.25, cz * d * 0.25, 1.4, { y0: lowH });
  rubblePile(B, rng, cx * (w / 2 + 0.9), cz * (d / 2 + 0.9), 1.1);
  B.collide(0, 0, w, d);
};

// a collapsed building: a tall back wall with window holes, a side wall that steps down, a stump of the other,
// a snapped floor slab hanging out from the back wall, steel beams and rubble. It opens towards local +z.
BUILDERS.ruin = (o) => {
  const B = warBatch, rng = rngFor(o);
  B.setFrame(o.x, o.z, o.rot || 0, o.y);
  const { w, d, h } = o;
  const t = 0.7;
  const brickTint = 0xe8e0d8;
  ruinedWall(B, rng, { key: 'brick', x: 0, z: -d / 2 + t / 2, len: w, h, t, alongX: true, windows: true, breach: false, tall: true, tint: brickTint, snow: !!o.snow });
  const l1 = d * 0.62 - t;
  ruinedWall(B, rng, { key: 'brick', x: -w / 2 + t / 2, z: -d / 2 + t + l1 / 2, len: l1, h: h * 0.9, t, alongX: false, windows: true, breach: false, taper: true, tint: brickTint, snow: !!o.snow });
  const l2 = d * 0.26;
  ruinedWall(B, rng, { key: 'brick', x: w / 2 - t / 2, z: -d / 2 + t + l2 / 2, len: l2, h: h * 0.55, t, alongX: false, breach: false, taper: true, tint: brickTint, snow: !!o.snow });
  // concrete columns at the open front, one standing, one snapped off
  B.box('conc', 0.9, h * 0.8, 0.9, -w / 2 + 0.55, (h * 0.8) / 2, d / 2 - 0.55, null, grey(0.62), 4);
  B.collide(-w / 2 + 0.55, d / 2 - 0.55, 0.9, 0.9);
  B.box('conc', 0.9, 0.9, 0.9, w / 2 - 0.55, 0.45, d / 2 - 0.55, [0.05, 0.3, 0.1], grey(0.5), 4);
  rubblePile(B, rng, w / 2 - 1.6, d / 2 - 1.6, 1.5, { solid: true });
  // a snapped floor slab, drooping from the back wall (tanks drive underneath)
  const slabZ = -d / 2 + t + d * 0.24;
  B.box('conc', w * 0.6, 0.32, d * 0.46, -w * 0.08, 3.1, slabZ, [0.1, 0, 0.02], grey(0.55), 4);
  for (const bx of [-w * 0.3, -w * 0.08, w * 0.14]) ibeam(B, d * 0.5, bx, 2.9, slabZ, [0.1, 0, 0], 0x5e4030);
  // beams jutting out of the top of the back wall and a sheet of roofing hanging off the side wall
  for (const bx of [-w * 0.25, w * 0.2]) ibeam(B, 3.6, bx, h + 0.1, -d / 2 + 1.6, [0.45, rng() * 0.2 - 0.1, 0.05], 0x553b2c);
  B.box('steel', 2.4, 0.04, 1.7, -w / 2 + 0.9, h * 0.62, -d / 2 + t + 2.2, [0.55, 0.2, 0.3], 0x7d6a58, 2);
  rubblePile(B, rng, -w * 0.12, -d / 2 + 2.2, 1.3);
  rubblePile(B, rng, w * 0.3, -d / 2 + 1.5, 1.0);
  rubblePile(B, rng, -w / 2 - 1.0, -d / 2 + t + l1 + 0.8, 1.2);
};

// a short line of sandbags, three high, with a few bags knocked loose
BUILDERS.sandbags = (o) => {
  const B = warBatch, rng = rngFor(o);
  B.setFrame(o.x, o.z, 0, o.y);
  const alongX = o.w >= o.d, len = alongX ? o.w : o.d;
  const tan = new THREE.Color(0x9d9272);
  for (let row = 0; row < 3; row++) {
    for (let a = -len / 2 + 0.5 + (row % 2 ? 0.46 : 0); a < len / 2 - 0.35; a += 0.92) {
      for (const lane of [-0.28, 0.28]) {
        if (row === 2 && rng() < 0.25) continue; // missing from the top row
        const jitter = rng() * 0.1 - 0.05, bl = 0.95 * (0.92 + rng() * 0.12);
        B.box('bag', alongX ? bl : 0.55, 0.3 + rng() * 0.04, alongX ? 0.55 : bl,
          alongX ? a : lane, 0.15 + row * 0.28, alongX ? lane : a, [0, jitter, 0], tan.clone().multiplyScalar(0.75 + rng() * 0.3), 1);
      }
    }
  }
  for (let i = 0; i < 3; i++) { // bags spilled on the ground
    const a = (rng() - 0.5) * len, sd = rng() < 0.5 ? -1 : 1;
    B.box('bag', 0.9, 0.28, 0.5, alongX ? a : sd * 0.9, 0.14, alongX ? sd * 0.9 : a, [0, rng() * 3, 0], tan.clone().multiplyScalar(0.7), 1);
  }
  if (o.snow) B.box('snow', alongX ? len * 0.97 : 0.95, 0.14, alongX ? 0.95 : len * 0.97, 0, 0.88, 0, null, grey(0.95), 4);
  B.collide(0, 0, alongX ? len : 1.15, alongX ? 1.15 : len);
};

// a rusty chain-link fence with barbed wire; sagging panels, leaning posts. Not solid: tanks flatten it.
BUILDERS.fence = (o) => {
  const B = warBatch, rng = rngFor(o);
  B.setFrame(o.x, o.z, 0, o.y);
  const alongX = o.w >= o.d, len = alongX ? o.w : o.d;
  const n = Math.max(1, Math.round(len / 3)), step = len / n;
  const rust = new THREE.Color(0x6e5a48);
  for (let i = 0; i <= n; i++) {
    const a = -len / 2 + i * step, lean = rng() < 0.25 ? rng() * 0.5 - 0.25 : 0;
    B.cyl('steel', 0.07, 0.08, 2.3, alongX ? a : 0, 1.15, alongX ? 0 : a, alongX ? [lean, 0, 0] : [0, 0, lean], rust, 5);
    if (i < n && rng() > 0.18) { // a panel, sometimes hanging low
      const mid = a + step / 2, sag = rng() < 0.3 ? 0.35 : 0;
      B.panel('chain', step - 0.1, 2.0 - sag, alongX ? mid : 0, 1.1 - sag / 2 + 0.05, alongX ? 0 : mid, [0, alongX ? 0 : Math.PI / 2, 0], rust, 1);
    }
  }
  for (const y of [2.25, 2.4]) { // top rail and barbed wire
    B.box('steel', alongX ? len : 0.04, 0.04, alongX ? 0.04 : len, 0, y, 0, null, y > 2.3 ? 0x2a2622 : rust, 1);
  }
};

// a czech hedgehog: three crossed steel beams (solid, but small)
BUILDERS.hedgehog = (o) => {
  const B = warBatch, rng = rngFor(o);
  B.setFrame(o.x, o.z, rng() * 3, o.y);
  const rust = 0x54402f;
  B.box('steel', 2.3, 0.17, 0.17, 0, 0.8, 0, [0, 0, 0.75], rust, 2);
  B.box('steel', 2.3, 0.17, 0.17, 0, 0.8, 0, [0, 0, -0.75], rust, 2);
  B.box('steel', 0.17, 0.17, 2.3, 0, 0.8, 0, [0.75, 0, 0], rust, 2);
  B.collide(0, 0, 1.5, 1.5);
};

// a loose heap of rubble (w = d = its width). `solid` makes it a small block of cover.
BUILDERS.rubble = (o) => {
  const B = warBatch, rng = rngFor(o);
  B.setFrame(o.x, o.z, 0, o.y);
  rubblePile(B, rng, 0, 0, o.w / 2, { solid: !!o.solid });
};

// a ruined checkpoint: guard booth, a boom gate snapped down, hedgehogs and jersey barriers. Opens towards local +z.
BUILDERS.checkpoint = (o) => {
  const B = warBatch, rng = rngFor(o);
  B.setFrame(o.x, o.z, o.rot || 0, o.y);
  B.box('brick', 2.6, 2.7, 2.6, -3.6, 1.35, 0, null, 0xe0d8d0, 3);
  B.box('conc', 3.3, 0.25, 3.3, -3.6, 2.84, 0, [0.02, 0, 0.05], grey(0.5), 4);
  B.box('steel', 1.4, 0.7, 0.08, -3.6, 1.8, 1.32, null, 0x141414, 2); // the window
  B.box('steel', 0.08, 0.7, 1.2, -2.28, 1.8, 0, null, 0x141414, 2);
  B.collide(-3.6, 0, 2.6, 2.6);
  B.cyl('steel', 0.13, 0.13, 1.4, -1.6, 0.7, 0, null, 0x5e4030, 6); // gate post
  B.box('hazard', 5, 0.16, 0.16, 0.9, 0.55, 0.9, [0, 0.3, -0.2], grey(0.9), 1.2); // boom arm, fallen
  for (const [x, z] of [[2.8, -1.4], [3.6, 1.6]]) {
    B.box('steel', 2.3, 0.17, 0.17, x, 0.8, z, [0, 0, 0.75], 0x54402f, 2);
    B.box('steel', 2.3, 0.17, 0.17, x, 0.8, z, [0, 0, -0.75], 0x54402f, 2);
    B.box('steel', 0.17, 0.17, 2.3, x, 0.8, z, [0.75, 0, 0], 0x54402f, 2);
    B.collide(x, z, 1.5, 1.5);
  }
  for (const [x, z, ry] of [[-0.6, -2.4, 0.1], [1.4, -3.2, -0.2]]) { // jersey barriers
    B.box('conc', 2.2, 0.45, 0.7, x, 0.22, z, [0, ry, 0], grey(0.6), 4);
    B.box('conc', 2.2, 0.55, 0.36, x, 0.72, z, [0, ry, 0], grey(0.6), 4);
    B.collide(x, z, 2.4, 0.9);
  }
  rubblePile(B, rng, -3.6, -2.4, 0.8);
};

// ---------- Battlefield props: wrecks, ammo, wire, lamps, signs, burning drums ----------
const charred = (rng, k = 1) => new THREE.Color(0x4a443e).multiplyScalar(k * (0.8 + rng() * 0.45));
const rusted = (rng, k = 1) => new THREE.Color(0x7a4c30).multiplyScalar(k * (0.8 + rng() * 0.4));

// a burnt-out tank. variant: the turret is still on (default) or has been blown off and lies beside it
BUILDERS.wreckTank = (o) => {
  const B = warBatch, rng = rngFor(o);
  B.setFrame(o.x, o.z, o.rot || 0, o.y);
  const turret = o.turret !== false;
  B.decal('burn', 8.5, 0, 0.3, 0x111111);
  const brokenSide = rng() < 0.5 ? -1 : 1;
  for (const s of [-1, 1]) {
    if (s === brokenSide) { // a torn track: short on the hull, the rest lying in the dirt
      B.box('steel', 0.72, 0.9, 3.4, s * 1.38, 0.45, -0.7, null, charred(rng, 0.7), 2);
      B.box('steel', 0.7, 0.1, 1.7, s * 2.3, 0.07, 2.4, [0, 0.4 * s, 0.12], rusted(rng, 0.7), 2);
      B.box('steel', 0.7, 0.1, 1.2, s * 1.7, 0.07, 3.6, [0, -0.3 * s, 0.05], rusted(rng, 0.6), 2);
    } else {
      B.box('steel', 0.72, 0.9, 4.9, s * 1.38, 0.45, 0, null, charred(rng, 0.7), 2);
    }
    for (let i = 0; i < 5; i++) { // road wheels
      const z = -1.8 + i * 0.9;
      if (s === brokenSide && z > 1) continue;
      B.cyl('steel', 0.34, 0.34, 0.1, s * 1.78, 0.5, z, [0, 0, Math.PI / 2], rusted(rng, 0.55), 7);
    }
  }
  B.box('steel', 2.2, 0.62, 4.5, 0, 0.88, 0, null, charred(rng), 2);
  B.box('steel', 2.4, 0.28, 3.2, 0, 1.3, -0.5, null, charred(rng, 0.9), 2);
  B.box('steel', 2.2, 0.2, 1.5, 0, 1.15, 2.1, [0.5, 0, 0], charred(rng, 1.05), 2); // sloped front plate
  B.box('steel', 1.8, 0.08, 1.1, 0, 1.47, -1.9, null, rusted(rng, 0.8), 2); // engine deck, rusting
  if (turret) {
    B.box('steel', 2.0, 0.75, 2.2, 0, 1.95, -0.2, [0, rng() * 0.3 - 0.15, 0], charred(rng), 2);
    B.box('steel', 0.9, 0.5, 0.5, 0, 1.9, 1.0, null, charred(rng, 0.9), 2); // gun mantlet
    B.cyl('steel', 0.1, 0.12, 3.2, 0, 1.9, 2.5, [Math.PI / 2 + 0.12, 0, 0], charred(rng, 0.8), 7); // barrel, drooping
    B.box('steel', 0.7, 0.06, 0.7, 0.5, 2.5, -0.5, [0, 0, 0.9], rusted(rng, 0.8), 2); // hatch thrown open
    B.fire(0, 1.55, -1.9, 1.0);
    if (o.snow) B.box('snow', 1.9, 0.14, 2.1, 0, 2.38, -0.2, null, grey(0.95), 4);
  } else {
    B.cyl('steel', 0.85, 0.85, 0.06, 0, 1.46, -0.2, null, 0x0a0a0a, 12); // the empty turret ring
    B.box('steel', 2.0, 0.75, 2.2, 3.5, 0.5, 1.3, [0.25, 0.7, 2.9], charred(rng), 2); // turret, flipped
    B.cyl('steel', 0.1, 0.12, 3.2, 4.6, 0.2, 3.3, [1.4, 0.5, 0], charred(rng, 0.8), 7);
    B.decal('burn', 3.2, 3.5, 1.5, 0x111111);
    B.fire(0, 1.5, -0.2, 1.25);
  }
  if (o.snow) B.box('snow', 2.3, 0.14, 4.2, 0, 1.64, 0, null, grey(0.95), 4);
  B.collideBounds(0, 0, 2.9, 4.9);
};

// a burnt-out army truck
BUILDERS.wreckTruck = (o) => {
  const B = warBatch, rng = rngFor(o);
  B.setFrame(o.x, o.z, o.rot || 0, o.y);
  B.decal('burn', 9, 0, 0, 0x111111);
  B.box('steel', 2.4, 0.3, 6.4, 0, 0.62, 0, null, charred(rng, 0.7), 2); // chassis
  B.box('steel', 2.3, 1.5, 1.9, 0, 1.55, 2.3, null, charred(rng), 2); // cab
  B.box('steel', 2.0, 0.7, 0.08, 0, 1.9, 3.28, null, 0x0c0c0c, 2); // windscreen, glass gone
  B.box('steel', 2.2, 0.7, 1.3, 0, 1.15, 3.7, null, charred(rng, 0.9), 2); // bonnet
  B.box('steel', 0.1, 0.55, 3.8, -1.15, 1.0, -1.4, [0, 0, 0.05], rusted(rng, 0.8), 2); // bed sides
  B.box('steel', 0.1, 0.4, 2.0, 1.2, 0.85, -0.6, [0, 0, -0.5], rusted(rng, 0.7), 2); // one side fallen outward
  B.box('steel', 2.3, 0.1, 3.8, 0, 0.84, -1.4, null, charred(rng, 0.8), 2); // bed floor
  for (const z of [-0.2, -1.5, -2.8]) { // burnt canopy ribs
    for (const s of [-1, 1]) B.cyl('steel', 0.035, 0.035, 1.6, s * 1.05, 1.7, z, [0, 0, s * 0.12], rusted(rng, 0.6), 4);
    B.box('steel', 2.1, 0.06, 0.06, 0, 2.5, z, [0, 0, rng() * 0.2 - 0.1], rusted(rng, 0.6), 2);
  }
  for (const [x, z] of [[-1.25, 2.4], [1.25, 2.4], [-1.25, -1.6], [1.25, -1.6], [-1.25, -2.8], [1.25, -2.8]]) {
    if (x > 0 && z === 2.4) continue; // this wheel is missing
    B.cyl('steel', 0.55, 0.55, 0.4, x, 0.55, z, [0, 0, Math.PI / 2], 0x161412, 10);
  }
  B.cyl('steel', 0.55, 0.55, 0.4, 2.6, 0.2, 3.1, null, 0x161412, 10); // the missing wheel, lying flat
  B.fire(0, 1.55, 3.7, 1.2);
  B.fire(0, 1.0, -2.0, 0.8);
  if (o.snow) {
    B.box('snow', 2.3, 0.14, 1.8, 0, 2.38, 2.3, null, grey(0.95), 4);
    B.box('snow', 2.2, 0.12, 3.6, 0, 0.8, -1.5, null, grey(0.95), 4);
  }
  B.collideBounds(0, 0.4, 2.7, 7.0);
};

// a burnt-out jeep
BUILDERS.wreckJeep = (o) => {
  const B = warBatch, rng = rngFor(o);
  B.setFrame(o.x, o.z, o.rot || 0, o.y);
  B.decal('burn', 6.5, 0, 0, 0x111111);
  B.box('steel', 1.8, 0.5, 3.2, 0, 0.8, 0, null, charred(rng, 0.9), 2);
  B.box('steel', 1.7, 0.3, 1.1, 0, 1.05, 1.6, [0.15, 0, 0], charred(rng), 2); // bonnet
  B.box('steel', 1.7, 0.7, 0.06, 0, 1.45, 0.9, [-0.3, 0, 0], rusted(rng, 0.7), 2); // windscreen frame
  for (const s of [-1, 1]) B.cyl('steel', 0.04, 0.04, 1.0, s * 0.85, 1.6, -1.3, [0, 0, s * 0.1], rusted(rng, 0.6), 4); // roll bar
  B.box('steel', 1.7, 0.05, 0.05, 0, 2.1, -1.3, null, rusted(rng, 0.6), 2);
  B.box('steel', 0.5, 0.35, 0.5, -0.4, 1.1, -0.4, null, charred(rng, 0.7), 2); // burnt seats
  B.box('steel', 0.5, 0.35, 0.5, 0.4, 1.1, -0.4, null, charred(rng, 0.7), 2);
  for (const [x, z] of [[-0.95, 1.1], [0.95, 1.1], [-0.95, -1.1], [0.95, -1.1]]) {
    if (x > 0 && z < 0) continue;
    B.cyl('steel', 0.42, 0.42, 0.3, x, 0.42, z, [0, 0, Math.PI / 2], 0x161412, 9);
  }
  B.fire(0, 1.3, 1.5, 0.9);
  B.collideBounds(0, 0, 2.2, 3.6);
};

// a stack of military ammo crates, with a few shells in the dirt
BUILDERS.ammo = (o) => {
  const B = warBatch, rng = rngFor(o);
  B.setFrame(o.x, o.z, o.rot || 0, o.y);
  const crate = (x, y, z, yaw, tilt = 0) => {
    const tint = new THREE.Color(0x434a30).multiplyScalar(0.8 + rng() * 0.35);
    B.box('steel', 0.95, 0.5, 0.55, x, y, z, [0, yaw, tilt], tint, 2);
    B.box('steel', 0.97, 0.05, 0.57, x, y + 0.24, z, [0, yaw, tilt], tint.clone().multiplyScalar(0.7), 2); // lid
    B.box('steel', 0.3, 0.06, 0.06, x, y + 0.2, z + 0.3, [0, yaw, tilt], 0x2a2a28, 2); // handle
  };
  for (let i = 0; i < 3; i++) crate(-1 + i * 1.0, 0.25, 0, rng() * 0.12 - 0.06);
  for (let i = 0; i < 2; i++) crate(-0.5 + i * 1.0, 0.75, rng() * 0.1, rng() * 0.2 - 0.1);
  crate(0.1, 1.25, 0, rng() * 0.4 - 0.2);
  crate(0.4, 0.2, 1.1, 0.8, 0.1); // one knocked off
  for (let i = 0; i < 3; i++) B.cyl('steel', 0.06, 0.06, 0.5, -1.3 + i * 0.2, 0.06, 0.9 + rng() * 0.3, [0, 0, Math.PI / 2], 0x8a6a2a, 6); // spent shells
  B.collide(0, 0, 3.0, 1.4);
};

// a coil of concertina barbed wire along x (or z when d > w)
BUILDERS.wire = (o) => {
  const B = warBatch, rng = rngFor(o);
  B.setFrame(o.x, o.z, 0, o.y);
  const alongX = o.w >= o.d, len = alongX ? o.w : o.d;
  const wire = new THREE.Color(0x77736b);
  for (let a = -len / 2 + 0.3; a < len / 2 - 0.2; a += 0.42) {
    const r = 0.45 + rng() * 0.08;
    B.geo('steel', new THREE.TorusGeometry(r, 0.014, 4, 11), alongX ? a : (rng() - 0.5) * 0.1, 0.5 + r * 0.1, alongX ? (rng() - 0.5) * 0.1 : a,
      [alongX ? 0.15 * (rng() - 0.5) : 0, alongX ? Math.PI / 2 : 0, 0.15 * (rng() - 0.5)], wire);
  }
  for (const a of [-len / 2, len / 2]) B.cyl('steel', 0.03, 0.03, 1.3, alongX ? a : 0, 0.65, alongX ? 0 : a, [0.1, 0, 0.1], 0x3a352f, 4); // pickets
};

// a streetlight, snapped and bent over (or lying flat when `fallen`)
BUILDERS.streetlight = (o) => {
  const B = warBatch, rng = rngFor(o);
  B.setFrame(o.x, o.z, o.rot ?? rng() * 6, o.y);
  const metal = new THREE.Color(0x3b3631);
  if (o.fallen) {
    B.cyl('steel', 0.08, 0.12, 5.2, 0, 0.12, 0, [0, 0, Math.PI / 2], metal, 6);
    B.box('steel', 0.9, 0.16, 0.38, 2.9, 0.18, 0, [0, 0.3, 0.1], metal, 2);
    B.box('steel', 0.4, 0.08, 0.4, -2.7, 0.08, 0, null, metal, 2);
    return;
  }
  B.box('steel', 0.45, 0.12, 0.45, 0, 0.06, 0, null, metal, 2);
  B.cyl('steel', 0.1, 0.13, 3.4, 0, 1.7, 0, null, metal, 6);
  B.collide(0, 0, 0.5, 0.5);
  const a = 1.15, up = 1.1; // the upper half has folded over at the break
  B.cyl('steel', 0.07, 0.09, 2.2, Math.sin(a) * up, 3.4 + Math.cos(a) * up, 0, [0, 0, -a], metal, 6);
  B.box('steel', 0.9, 0.16, 0.38, Math.sin(a) * 2.25, 3.4 + Math.cos(a) * 2.25 - 0.1, 0, [0, 0, -a + 0.7], metal, 2); // lamp head
};

// a road sign on a post, bent and shot up
BUILDERS.sign = (o) => {
  const B = warBatch, rng = rngFor(o);
  B.setFrame(o.x, o.z, o.rot ?? rng() * 6, o.y);
  const lean = rng() * 0.3 - 0.15;
  B.cyl('steel', 0.04, 0.05, 2.5, 0, 1.25, 0, [0, 0, lean], 0x4d4944, 5);
  B.collide(0, 0, 0.4, 0.4);
  const kind = Math.floor(rng() * 3), y = 2.45, x = Math.sin(-lean) * 1.2;
  if (kind === 0) { // a stop sign
    B.cyl('steel', 0.45, 0.45, 0.04, x, y, 0.05, [Math.PI / 2, 0, lean], 0x7a2a22, 8);
    B.cyl('steel', 0.36, 0.36, 0.045, x, y, 0.06, [Math.PI / 2, 0, lean], 0x9a9488, 8);
    B.cyl('steel', 0.3, 0.3, 0.05, x, y, 0.065, [Math.PI / 2, 0, lean], 0x7a2a22, 8);
  } else if (kind === 1) { // a blue direction plate, tilted
    B.box('steel', 0.95, 0.6, 0.04, x, y - 0.1, 0.05, [0, 0.2, lean + 0.3], 0x2a4666, 2);
  } else { // a yellow warning diamond
    B.box('steel', 0.7, 0.7, 0.04, x, y, 0.05, [0, 0, lean + Math.PI / 4], 0x9a8328, 2);
  }
};

// an oil drum on fire, with a second one knocked over beside it
BUILDERS.drumfire = (o) => {
  const B = warBatch, rng = rngFor(o);
  B.setFrame(o.x, o.z, 0, o.y);
  B.decal('burn', 4, 0, 0, 0x111111);
  B.cyl('steel', 0.42, 0.42, 0.95, 0, 0.48, 0, null, rusted(rng, 0.9), 10);
  for (const y of [0.15, 0.8]) B.cyl('steel', 0.44, 0.44, 0.05, 0, y, 0, null, rusted(rng, 0.6), 10);
  B.cyl('steel', 0.42, 0.42, 0.95, 1.1, 0.42, 0.9, [0, 0, Math.PI / 2 - 0.1], charred(rng, 0.8), 10);
  B.fire(0, 1.0, 0, 0.75);
  B.collide(0, 0, 1.0, 1.0);
};

// ---------- The bridge: a giant overpass across the middle of the war map ----------
// A viaduct runs the whole way across the battlefield (and on into the fog) high above the ground.
// Tanks fight underneath it, between the huge concrete piers. Nothing up there is solid, so tanks and
// shells are unaffected; only the piers block, like any other cover.
const BR = { half: 9, under: 5.2, cap: 1.3, girder: 1.6, slab: 0.9, truss: 4.2, collapse: [24, 48], end: 132 };
BR.capTop = BR.under + BR.cap;
BR.slabBottom = BR.capTop + BR.girder;
BR.deckTop = BR.slabBottom + BR.slab;
BR.roadY = BR.deckTop + 0.02;

// the road surface: worn asphalt with lane markings, patched cracks and potholes (28 units long, 14 wide)
function roadTexture() {
  if (texCache.road) return texCache.road;
  const W = 1024, H = 512;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  srand = mulberry32(61);
  g.fillStyle = '#3a3c3f';
  g.fillRect(0, 0, W, H);
  for (let i = 0; i < 60; i++) { // worn and stained patches (wrapped sideways so the road tiles)
    const x = srand() * W, y = srand() * H, r = srnd(30, 110);
    for (const ox of [-W, 0, W]) {
      const gr = g.createRadialGradient(x + ox, y, 0, x + ox, y, r);
      gr.addColorStop(0, i % 3 ? 'rgba(14,14,16,0.4)' : 'rgba(120,118,110,0.22)');
      gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr;
      g.fillRect(x + ox - r, y - r, r * 2, r * 2);
    }
  }
  for (let i = 0; i < 16000; i++) {
    const v = srnd(20, 95);
    g.fillStyle = `rgba(${v},${v},${v * 0.95},0.55)`;
    g.fillRect(srand() * W, srand() * H, srnd(1, 3), srnd(1, 3));
  }
  g.lineCap = 'round';
  for (const y of [26, H - 26]) { // edge lines, worn away in places
    for (let x = 0; x < W; x += 48) {
      if (srand() < 0.22) continue;
      g.strokeStyle = `rgba(206,202,188,${srnd(0.45, 0.85)})`;
      g.lineWidth = 7;
      g.beginPath();
      g.moveTo(x, y + srnd(-1, 1));
      g.lineTo(x + 48, y + srnd(-1, 1));
      g.stroke();
    }
  }
  for (let x = 40; x < W; x += 256) { // dashed centre line
    for (let k = 0; k < 4; k++) {
      if (srand() < 0.15) continue;
      g.strokeStyle = `rgba(214,206,170,${srnd(0.5, 0.85)})`;
      g.lineWidth = 9;
      g.beginPath();
      g.moveTo(x + k * 3, H / 2);
      g.lineTo(x + 140 - k * 3, H / 2);
      g.stroke();
      break;
    }
  }
  g.strokeStyle = 'rgba(8,8,10,0.75)';
  g.lineWidth = 1.5;
  for (let i = 0; i < 14; i++) { // cracks
    let x = srand() * W, y = srand() * H, a = srand() * Math.PI * 2;
    g.beginPath();
    g.moveTo(x, y);
    for (let k = 0; k < 10; k++) {
      a += srnd(-0.7, 0.7);
      x += Math.cos(a) * srnd(8, 24);
      y += Math.sin(a) * srnd(8, 24);
      g.lineTo(x, y);
    }
    g.stroke();
  }
  for (let i = 0; i < 4; i++) { // potholes and shell scars
    const x = srnd(80, W - 80), y = srnd(80, H - 80), r = srnd(18, 46);
    const gr = g.createRadialGradient(x, y, 0, x, y, r * 1.5);
    gr.addColorStop(0, 'rgba(6,6,7,0.95)');
    gr.addColorStop(0.6, 'rgba(18,17,16,0.8)');
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr;
    g.fillRect(x - r * 1.5, y - r * 1.5, r * 3, r * 3);
  }
  for (let i = 0; i < 6; i++) { // tyre marks
    g.strokeStyle = 'rgba(8,8,8,0.35)';
    g.lineWidth = 6;
    const y = srnd(60, H - 60), x = srand() * W;
    g.beginPath();
    g.moveTo(x, y);
    g.bezierCurveTo(x + 100, y + srnd(-30, 30), x + 200, y + srnd(-30, 30), x + srnd(280, 400), y + srnd(-60, 60));
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  texCache.road = t;
  return t;
}

// road surface over x0..x1, z0..z1, with its UVs tied to the world so the markings line up across spans
function roadGeo(x0, x1, z0, z1) {
  const g = new THREE.PlaneGeometry(x1 - x0, z1 - z0);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) {
    const wx = x0 + uv.getX(i) * (x1 - x0), wz = z1 - uv.getY(i) * (z1 - z0);
    uv.setXY(i, wx / 28, (7 - wz) / 14);
  }
  return g;
}

const paintSteel = (rng, k = 1) => new THREE.Color(0x6b7168).multiplyScalar(k * (0.7 + rng() * 0.5));
const rustSteel = (rng, k = 1) => new THREE.Color(0x5d5046).multiplyScalar(k * (0.75 + rng() * 0.5));

BUILDERS.bridge = (o) => {
  const B = warBatch, rng = rngFor(o);
  B.setFrame(0, 0, 0);
  const { half, under, cap, girder, slab, truss, capTop, slabBottom, deckTop } = BR;
  const bents = [];
  for (let x = -120; x <= 120; x += 24) bents.push(x);
  const spans = [[-BR.end, -120], ...bents.slice(0, -1).map((x, i) => [x, bents[i + 1]]), [120, BR.end]];
  const [cx0, cx1] = BR.collapse;

  // under the bridge it is dark
  B.add('shade', new THREE.PlaneGeometry(BR.end * 2, 24), 0, 0.04, 0, [-Math.PI / 2, 0, 0], 0x000000);

  // piers: two fat columns and a cross beam at each bent
  for (const bx of bents) {
    const inArena = Math.abs(bx) <= 48;
    for (const zs of [-6, 6]) {
      B.box('conc', 4.6, 0.7, 4.6, bx, 0.35, zs, null, grey(0.55), 5); // footing
      B.box('conc', 3.4, under, 3.4, bx, under / 2 + 0.2, zs, null, grey(0.62 + rng() * 0.14), 5);
      B.box('conc', 3.9, 0.45, 3.9, bx, under - 0.1, zs, null, grey(0.7), 5); // collar under the cross beam
      if (rng() < 0.5) { // a column with a bite out of it, bent bars and rubble at its foot
        const sd = rng() < 0.5 ? -1 : 1;
        for (let i = 0; i < 4; i++) {
          B.cyl('steel', 0.04, 0.04, 1.3, bx + sd * 1.75, 2.4 + i * 0.5, zs + (i - 1.5) * 0.5, [rng() * 0.6 - 0.3, 0, sd * (0.5 + rng() * 0.4)], 0x54402f, 4);
        }
        if (!inArena) rubblePile(B, rng, bx + sd * 2.6, zs, 1.2);
      }
      if (inArena) B.collide(bx, zs, 3.4, 3.4);
    }
    B.box('deck', 4.6, cap, 2 * half - 0.6, bx, under + cap / 2, 0, null, grey(0.62), 5);
    B.box('steel', 0.7, 0.7, 2 * (half + 0.3) + 0.6, bx, deckTop + truss, 0, null, paintSteel(rng), 2); // portal beam overhead
  }

  for (const [x0, x1] of spans) {
    const mid = (x0 + x1) / 2, L = x1 - x0 - 0.3;
    const collapsed = x0 === cx0 && x1 === cx1;

    // girders under the deck (I-beams): three per span; the collapsed span loses most of them
    for (const z of [-6, 0, 6]) {
      const girderAt = (gx0, gx1, tilt) => {
        const len = gx1 - gx0, gm = (gx0 + gx1) / 2;
        const dy = Math.sin(Math.abs(tilt)) * len / 2;
        const gy = capTop + girder / 2 - dy;
        B.box('gird', len, girder - 0.24, 0.5, gm, gy, z, [0, 0, tilt], rustSteel(rng, 0.85), 2);
        B.box('gird', len, 0.14, 1.5, gm, gy - girder / 2 + 0.07, z, [0, 0, tilt], rustSteel(rng, 0.8), 2);
        B.box('gird', len, 0.14, 1.5, gm, gy + girder / 2 - 0.07, z, [0, 0, tilt], rustSteel(rng, 0.8), 2);
      };
      if (!collapsed) girderAt(x0 + 0.15, x1 - 0.15, 0);
      else if (z === 6) girderAt(x0 + 0.15, x1 - 0.15, 0);
      else if (z === 0) { // the middle girder snapped and sagging at both ends
        girderAt(x0 + 0.15, x0 + 10.5, -0.2);
        girderAt(x1 - 0.15, x1 - 10.5, 0.2);
      } else { // the south girder: just stumps hanging off the piers
        girderAt(x0 + 0.15, x0 + 5, -0.3);
        girderAt(x1 - 0.15, x1 - 4, 0.35);
      }
    }
    for (let x = x0 + 4; x < x1 - 2; x += 8) { // cross bracing between the girders
      B.box('gird', 0.25, 0.9, 5.6, x, capTop + 0.85, 3, null, rustSteel(rng, 0.8), 2);
      if (!collapsed) B.box('gird', 0.25, 0.9, 5.6, x, capTop + 0.85, -3, null, rustSteel(rng, 0.8), 2);
    }

    // deck slab and road
    if (!collapsed) {
      B.box('deck', L, slab, 2 * half, mid, slabBottom + slab / 2, 0, null, grey(0.62 + rng() * 0.1), 6);
      B.geo('road', roadGeo(x0 + 0.15, x1 - 0.15, -7, 7), mid, BR.roadY, 0, [-Math.PI / 2, 0, 0], 0xffffff);
    } else {
      B.box('deck', L, slab, half, mid, slabBottom + slab / 2, half / 2, null, grey(0.64), 6);
      B.geo('road', roadGeo(x0 + 0.15, x1 - 0.15, 0, 7), mid, BR.roadY, 3.5, [-Math.PI / 2, 0, 0], 0xffffff);
      for (let i = 0; i < 9; i++) { // torn slab edge: chunks hanging off, bars sticking out
        const x = x0 + 2.5 + i * 2.4 + rng();
        B.box('deck', 2.2, 0.6, 1.7, x, slabBottom + 0.3 - rng() * 1.6, -0.5 - rng() * 0.8, [rng() * 0.5, rng() * 1.2, rng() * 0.4 - 0.2], grey(0.55), 4);
        B.cyl('steel', 0.04, 0.04, 1.6, x + 0.4, slabBottom + 0.45, -0.8, [Math.PI / 2 + rng() * 0.5 - 0.25, 0, rng() * 0.4 - 0.2], 0x54402f, 4);
      }
      // slabs that came down, a heap of rubble under the break, and fires
      B.box('deck', 7, 0.9, 5, 31, 0.7, -7.5, [0.14, 0.3, -0.22], grey(0.5), 6);
      B.collide(31, -7.5, 6.2, 4.6); // the fallen slab is solid
      rubblePile(B, rng, 38, -4.5, 3.2, { solid: true });
      B.decal('burn', 12, 36, -5.5, 0x111111);
      B.fire(37, 1.0, -3.5, 1.5);
      B.fire(33, deckTop + 0.3, 1.2, 1.1); // on the broken deck edge
      for (let i = 0; i < 5; i++) { // dangling bars and cables
        B.cyl('steel', 0.03, 0.03, 3.5 + rng() * 2, x0 + 4 + i * 4.2, slabBottom - 2.0, -1.2 - rng(), [rng() * 0.3, 0, rng() * 0.3 - 0.15], 0x45392e, 4);
      }
    }

    // parapets and railings along both edges; some knocked down, none on the collapsed side
    for (const sd of [-1, 1]) {
      if (collapsed && sd === -1) continue;
      for (let px = x0 + 2; px < x1 - 1; px += 4) {
        if (rng() < 0.1) continue;
        const hgt = rng() < 0.22 ? 0.45 : 1.0;
        B.box('deck', 3.9, hgt, 0.5, px, deckTop + hgt / 2, sd * 8.6, null, grey(0.62 + rng() * 0.12), 4);
        if (hgt > 0.9) {
          B.cyl('steel', 0.045, 0.045, 1.0, px, deckTop + 1.5, sd * 8.6, [0, 0, rng() < 0.2 ? rng() * 0.4 - 0.2 : 0], rustSteel(rng, 0.9), 4);
          B.box('steel', 3.9, 0.07, 0.07, px, deckTop + 1.95, sd * 8.6, null, rustSteel(rng, 0.9), 2);
          B.box('steel', 3.9, 0.07, 0.07, px, deckTop + 1.55, sd * 8.6, null, rustSteel(rng, 0.9), 2);
        } else {
          B.cyl('steel', 0.025, 0.025, 0.9, px + 1, deckTop + 0.8, sd * 8.6, [0.3, 0, 0.4], 0x54402f, 4); // rebar from the broken parapet
        }
      }
    }

    // steel trusses along the sides: the big structural beams you see from the ground
    for (const sd of [-1, 1]) {
      const z = sd * (half + 0.3);
      if (collapsed && sd === -1) { // the south truss has come away: a chord and a diagonal hanging off each end
        B.box('steel', 5, 0.55, 0.55, x0 + 2.2, deckTop + truss - 1.2, z, [0, 0, -0.5], paintSteel(rng, 0.8), 2);
        B.box('steel', 4.5, 0.5, 0.5, x1 - 2.0, deckTop + truss - 1.1, z, [0, 0, 0.55], paintSteel(rng, 0.8), 2);
        B.box('steel', 5.5, 0.34, 0.34, x0 + 1.5, deckTop + 1.4, z - 0.4, [0.2, 0, -1.1], rustSteel(rng, 0.9), 2);
        continue;
      }
      B.box('steel', L, 0.55, 0.55, mid, deckTop + truss, z, null, paintSteel(rng), 2); // top chord
      B.box('steel', L, 0.5, 0.6, mid, deckTop + 0.3, z, null, paintSteel(rng, 0.9), 2); // bottom chord
      const panels = Math.max(1, Math.round(L / 6)), pw = L / panels;
      for (let i = 0; i <= panels; i++) {
        B.box('steel', 0.45, truss, 0.45, x0 + 0.15 + i * pw, deckTop + truss / 2, z, null, paintSteel(rng, 0.95), 2);
      }
      const ang = Math.atan2(truss, pw), dl = Math.hypot(truss, pw);
      for (let i = 0; i < panels; i++) {
        if (rng() < 0.1) continue; // a missing diagonal
        const bent = rng() < 0.12 ? rng() * 0.25 : 0;
        B.box('steel', dl, 0.34, 0.34, x0 + 0.15 + (i + 0.5) * pw, deckTop + truss / 2, z, [0, 0, (i % 2 ? -1 : 1) * ang + bent], rng() < 0.3 ? rustSteel(rng) : paintSteel(rng), 2);
      }
    }
  }
};

// the bridge deck turns see-through when the camera looks down at the player through it
function updateBridgeFade(dt) {
  if (!warFadeMats.length) return;
  const cy = camera.position.y, cz = camera.position.z;
  let target = 1;
  const over = Math.abs(cz) < BR.half + 1;
  if (over && cy > BR.slabBottom - 0.4 && cy < BR.deckTop + 0.6) {
    target = 0.15; // the camera is inside the deck
  } else if (cy > BR.slabBottom + 0.3) {
    const mid = (BR.slabBottom + BR.deckTop) / 2;
    const t = (cy - mid) / (cy - 1);
    const zc = cz + t * (player.pos.z - cz);
    if (Math.abs(zc) < BR.half + 1) target = 0.15;
  }
  bridgeFade += (target - bridgeFade) * (1 - Math.exp(-9 * dt));
  for (const m of warFadeMats) {
    m.opacity = bridgeFade;
    m.depthWrite = bridgeFade > 0.98;
  }
}
let bridgeFade = 1;

// ---------- Distant skyline: ruined blocks, factories, tank farms, masts, and dead trees ----------
const skylineAnchors = []; // chimneys and burning ruins: the far smoke columns rise from these
function warSkyline(map) {
  skylineAnchors.length = 0;
  const rng = mulberry32(map.seed + 7);
  const r = (a, b) => a + rng() * (b - a);
  const B = new Batch(mulberry32(map.seed + 8));
  const wall = () => new THREE.Color(0x6e6962).multiplyScalar(0.65 + rng() * 0.5);
  const dark = () => new THREE.Color(0x3a3733).multiplyScalar(0.7 + rng() * 0.6);
  const clear = (x, z) => Math.abs(z) > 17 || Math.abs(x) > 150; // keep the middle free: the bridge runs there
  const anchor = (lx, ly, lz) => {
    const v = new THREE.Vector3(lx, ly, lz).applyMatrix4(B.frame);
    skylineAnchors.push({ x: v.x, y: v.y, z: v.z });
  };

  const block = () => { // a tower block with a ragged, stepped top
    const w = r(10, 18), d = r(10, 16), h = r(14, 36);
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 2; j++) {
        const hh = i === 1 && j === 0 ? h : h * r(0.4, 1);
        B.box('skyl', w / 3, hh, d / 2, (i - 1) * (w / 3), hh / 2, (j - 0.5) * (d / 2), null, wall(), 16);
      }
    }
    B.box('skyl', w * 0.4, 0.7, d * 0.5, 0, h + 0.2, -d * 0.25, [r(-0.3, 0.3), r(-0.4, 0.4), r(-0.3, 0.3)], wall(), 16);
    for (let k = 0; k < 4; k++) B.cyl('steel', 0.08, 0.08, r(1.5, 3.5), r(-w / 3, w / 3), h + 0.9, -d * 0.25, [r(-0.4, 0.4), 0, r(-0.4, 0.4)], dark(), 4);
    if (rng() < 0.3) anchor(0, h * 0.8, 0);
  };
  const factory = () => { // a long low works with a sawtooth roof and smokestacks
    const w = r(30, 48), d = r(12, 18), h = r(8, 12);
    B.box('skyl', w, h, d, 0, h / 2, 0, null, wall(), 14);
    for (let k = 0; k < Math.floor(w / 8); k++) B.box('skyl', 7, 2.5, d * 0.98, -w / 2 + 5 + k * 8, h + 1.0, 0, [0, 0, r(-0.1, 0.1)], dark(), 14);
    for (let k = 0, n = 1 + Math.floor(rng() * 3); k < n; k++) {
      const ch = r(26, 44), cx = -w / 2 + 4 + k * 6;
      B.cyl('steel', 1.0, 1.5, ch, cx, ch / 2, d / 2 + 2, null, dark(), 7);
      if (rng() < 0.6) anchor(cx, ch, d / 2 + 2);
    }
  };
  const tanks = () => { // fuel tanks in a row, one of them burning
    const n = 3 + Math.floor(rng() * 3);
    for (let k = 0; k < n; k++) {
      const rad = r(5, 8), h = r(8, 12);
      B.cyl('steel', rad, rad, h, k * 16, h / 2, r(-3, 3), null, wall(), 12);
      if (k === 0 && rng() < 0.6) anchor(0, h, 0);
    }
    B.box('steel', n * 16, 0.8, 0.8, (n - 1) * 8, 1.6, 6, null, dark(), 2);
  };
  const mast = () => { // a radio mast with dish and cross arms
    B.cyl('steel', 0.3, 0.6, 50, 0, 25, 0, null, dark(), 5);
    for (const y of [20, 32, 42]) B.box('steel', 6, 0.3, 0.3, 0, y, 0, [0, 0, r(-0.1, 0.1)], dark(), 2);
    B.cyl('steel', 4, 3.5, 0.5, 1.5, 36, 0, [Math.PI / 2 - 0.3, 0, 0.3], wall(), 10);
  };
  const tower = () => { // a water tower on four legs
    for (const [x, z] of [[-2, -2], [2, -2], [-2, 2], [2, 2]]) B.cyl('steel', 0.3, 0.4, 14, x, 7, z, [z * 0.02, 0, -x * 0.02], dark(), 5);
    B.cyl('steel', 4.5, 4.5, 6, 0, 17, 0, null, wall(), 10);
    B.cyl('steel', 0.2, 4.8, 3, 0, 21.5, 0, null, dark(), 10);
  };
  const crane = () => { // a harbour crane: tall frame, long jib
    B.box('steel', 1.6, 40, 1.6, 0, 20, 0, null, dark(), 2);
    B.box('steel', 32, 1.0, 1.6, 8, 40, 0, [0, 0, r(-0.12, 0.05)], dark(), 2);
    B.box('steel', 0.2, 12, 0.2, 20, 34, 0, null, dark(), 2);
  };

  const makers = [block, block, block, block, factory, tanks, mast, tower, crane];
  for (let c = 0; c < 9; c++) {
    const ang = r(0, Math.PI * 2), dist = r(105, 190);
    for (let k = 0, n = 3 + Math.floor(rng() * 4); k < n; k++) {
      const x = Math.cos(ang) * dist + r(-28, 28), z = Math.sin(ang) * dist + r(-28, 28);
      if (!clear(x, z) || Math.hypot(x, z) < 85) continue;
      B.setFrame(x, z, r(0, Math.PI * 2));
      makers[Math.floor(rng() * makers.length)]();
    }
  }
  B.flush(false); // far outside the shadow map: no need to cast shadows

  smokeCols.forEach((col, i) => { // the horizon smoke columns now rise from the ruins
    const a = skylineAnchors[i % Math.max(1, skylineAnchors.length)];
    if (!a) return;
    col.x = a.x;
    col.z = a.z;
    col.y0 = a.y;
  });
}

let deadTreeGeo = null;
function deadTree() {
  if (deadTreeGeo) return deadTreeGeo;
  const parts = [];
  const trunk = new THREE.CylinderGeometry(0.14, 0.34, 6.5, 5).translate(0, 3.25, 0).rotateZ(0.07);
  parts.push(trunk);
  for (let i = 0; i < 6; i++) { // bare branches
    const len = 1.6 + (i % 3) * 0.6;
    const b = new THREE.CylinderGeometry(0.03, 0.1, len, 4).translate(0, len / 2, 0)
      .rotateZ((i % 2 ? 1 : -1) * (0.7 + (i % 3) * 0.2)).rotateY(i * 1.05).translate(0, 2.6 + i * 0.55, 0);
    parts.push(b);
  }
  deadTreeGeo = mergeGeometries(parts, false);
  parts.forEach((g) => g.dispose());
  return deadTreeGeo;
}

// ---------- Map identity props: quarry machinery, depot logistics, frozen ruins ----------
const equipYellow = (rng, k = 1) => new THREE.Color(0x8f7230).multiplyScalar(k * (0.7 + rng() * 0.4));
const darkMetal2 = (rng, k = 1) => new THREE.Color(0x2b2824).multiplyScalar(k * (0.8 + rng() * 0.5));

// loose gravel: a heap of small rocks (decoration; the caller adds a footprint if it should be solid)
function gravelChunks(B, rng, x, z, r, tint = 0x8a7c66, y0 = 0) {
  const base = new THREE.Color(tint);
  for (let i = 0, n = Math.floor(10 + r * 6); i < n; i++) {
    const a = rng() * Math.PI * 2, d = r * Math.sqrt(rng()), sz = 0.3 + rng() * 0.4;
    B.geo('rock', new THREE.DodecahedronGeometry(sz, 0), x + Math.cos(a) * d, y0 + (1 - d / r) * r * 0.5 + sz * 0.3, z + Math.sin(a) * d,
      [rng() * 3, rng() * 3, rng() * 3], base.clone().multiplyScalar(0.65 + rng() * 0.5));
  }
}

// a rocky earth bank along the foot of a wall (the longer side is its length)
BUILDERS.embankment = (o) => {
  const B = warBatch, rng = rngFor(o);
  B.setFrame(o.x, o.z, 0, o.y);
  const alongX = o.w >= o.d, len = alongX ? o.w : o.d, wid = alongX ? o.d : o.w;
  const earth = new THREE.Color(o.tint ?? 0x7a6a52);
  for (let a = -len / 2; a <= len / 2; a += 1.5) {
    for (let row = 0; row < 3; row++) {
      const h = o.h * (row === 1 ? 1 : 0.65) * (0.7 + rng() * 0.5), sz = 1.1 + rng() * 0.9;
      const across = (row - 1) * (wid / 3) + (rng() - 0.5) * 0.6, along = a + rng() - 0.5;
      const g = new THREE.IcosahedronGeometry(1, 0).scale(sz * 1.2, h * 0.5, sz);
      B.geo('rock', g, alongX ? along : across, h * 0.4, alongX ? across : along, [rng() * 0.5, rng() * 6, rng() * 0.4], earth.clone().multiplyScalar(0.7 + rng() * 0.5));
    }
  }
  B.collide(0, 0, alongX ? len : wid * 0.85, alongX ? wid * 0.85 : len);
};

// a mound of crushed rock (w = its width)
BUILDERS.gravelpile = (o) => {
  const B = warBatch, rng = rngFor(o);
  B.setFrame(o.x, o.z, 0, o.y);
  gravelChunks(B, rng, 0, 0, o.w / 2, o.tint ?? 0x8a7c66);
  B.collide(0, 0, o.w * 0.65, o.w * 0.65);
};

// a mining excavator, faded yellow and rusting (broken: its boom has dropped to the ground)
BUILDERS.excavator = (o) => {
  const B = warBatch, rng = rngFor(o);
  B.setFrame(o.x, o.z, o.rot || 0, o.y);
  B.decal('burn', 8, 0, 0.5, 0x2a2118);
  for (const sd of [-1, 1]) {
    B.box('steel', 1.2, 1.0, 5.4, sd * 1.8, 0.5, 0, null, darkMetal2(rng), 2); // tracks
    for (let i = 0; i < 5; i++) B.cyl('steel', 0.4, 0.4, 0.14, sd * 2.45, 0.5, -2.0 + i, [0, 0, Math.PI / 2], rusted(rng, 0.6), 7);
  }
  B.box('steel', 3.6, 0.6, 4.4, 0, 1.25, 0, null, equipYellow(rng), 2);
  B.box('steel', 3.0, 1.5, 1.8, 0, 2.3, -1.6, null, equipYellow(rng), 2); // engine house
  B.box('steel', 2.2, 1.9, 2.4, -0.4, 2.55, 0.9, null, equipYellow(rng), 2); // cab
  B.box('steel', 0.08, 1.1, 1.8, -1.52, 2.9, 0.9, null, 0x161616, 2);
  B.box('steel', 1.9, 1.1, 0.08, -0.4, 2.9, 2.12, null, 0x161616, 2);
  const a1 = o.broken ? 0.2 : 0.65, a2 = o.broken ? 1.3 : 0.9, L1 = 4.6, L2 = 3.4, px = 0.9, py = 2.4, pz = 1.6;
  B.box('steel', 0.6, 0.7, L1, px, py + Math.sin(a1) * L1 / 2, pz + Math.cos(a1) * L1 / 2, [-a1, 0, 0], equipYellow(rng), 2); // boom
  const endY = py + Math.sin(a1) * L1, endZ = pz + Math.cos(a1) * L1;
  B.box('steel', 0.45, 0.5, L2, px, endY - Math.sin(a2) * L2 / 2, endZ + Math.cos(a2) * L2 / 2, [a2, 0, 0], equipYellow(rng), 2); // stick
  const bY = endY - Math.sin(a2) * L2, bZ = endZ + Math.cos(a2) * L2;
  B.box('steel', 1.5, 0.9, 1.2, px, Math.max(0.5, bY - 0.2), bZ + 0.3, [a2 + 0.3, 0, 0], darkMetal2(rng), 2); // bucket
  gravelChunks(B, rng, px, bZ + 0.5, 1.4, 0x7a6c58);
  B.collideBounds(0, 0, 3.9, 5.6);
};

// a giant quarry dump truck with its bed raised, spilling gravel
BUILDERS.haultruck = (o) => {
  const B = warBatch, rng = rngFor(o);
  B.setFrame(o.x, o.z, o.rot || 0, o.y);
  B.decal('burn', 10, 0, 0, 0x2a2118);
  B.box('steel', 4.2, 0.9, 9.2, 0, 1.7, 0, null, darkMetal2(rng, 1.1), 2);
  B.box('steel', 3.2, 2.6, 2.8, -0.5, 3.2, 3.4, null, equipYellow(rng), 2); // cab
  B.box('steel', 2.6, 1.1, 0.08, -0.5, 3.6, 4.82, null, 0x141414, 2);
  B.box('steel', 4.8, 0.4, 6.6, 0, 3.0, -1.6, [-0.32, 0, 0], equipYellow(rng, 0.9), 2); // dump bed, front raised
  for (const sd of [-1, 1]) B.box('steel', 0.3, 1.4, 6.6, sd * 2.3, 3.5, -1.6, [-0.32, 0, 0], equipYellow(rng, 0.85), 2);
  for (const [x, z] of [[-2.35, 3.2], [2.35, 3.2], [-2.35, -2.8], [2.35, -2.8]]) {
    if (x > 0 && z > 0) { // a flat tyre
      B.cyl('steel', 1.2, 1.2, 1.3, x, 1.2, z, [0, 0, Math.PI / 2], 0x141210, 10);
    } else {
      B.cyl('steel', 1.45, 1.45, 1.3, x, 1.45, z, [0, 0, Math.PI / 2], 0x141210, 10);
    }
  }
  gravelChunks(B, rng, 0, -6.4, 2.2, 0x7a6c58);
  B.collideBounds(0, 0, 4.9, 9.4);
};

// a belt conveyor climbing out of a hopper, snapped in the middle (the belt is overhead; only the hopper is solid)
BUILDERS.conveyor = (o) => {
  const B = warBatch, rng = rngFor(o);
  B.setFrame(o.x, o.z, o.rot || 0, o.y);
  const L = Math.max(o.w, o.d), y0 = 2.8, y1 = 7.2, ang = Math.atan2(y1 - y0, L), full = Math.hypot(L, y1 - y0);
  const at = (f) => [-L / 2 + f * L, y0 + f * (y1 - y0)];
  const piece = (f0, f1, extraTilt = 0) => {
    const [mx, my] = at((f0 + f1) / 2), len = (f1 - f0) * full;
    B.box('steel', len, 0.3, 1.5, mx, my, 0, [0, 0, ang - extraTilt], darkMetal2(rng), 2);
    for (const sd of [-1, 1]) B.box('steel', len, 0.5, 0.1, mx, my + 0.2, sd * 0.8, [0, 0, ang - extraTilt], rusted(rng, 0.8), 2);
  };
  piece(0.02, 0.5, 0.2); // the lower half has sagged where it broke
  piece(0.62, 1.0);
  for (const f of [0.1, 0.3, 0.5, 0.7, 0.88, 0.98]) { // support legs
    const [lx, ly] = at(f);
    B.box('steel', 0.35, ly - 0.2, 0.35, lx, (ly - 0.2) / 2, 0.6, null, rusted(rng, 0.9), 2);
    B.box('steel', 0.35, ly - 0.2, 0.35, lx, (ly - 0.2) / 2, -0.6, null, rusted(rng, 0.9), 2);
  }
  B.box('steel', 3.4, 2.2, 3.4, -L / 2 - 1.4, 1.1, 0, null, rusted(rng, 0.9), 2); // hopper
  B.box('steel', 3.8, 0.8, 3.8, -L / 2 - 1.4, 2.5, 0, null, darkMetal2(rng), 2);
  B.collide(-L / 2 - 1.4, 0, 3.4, 3.4);
  gravelChunks(B, rng, L / 2 + 1.5, 0, 2.6, 0x7a6c58); // the stockpile at the top end
  gravelChunks(B, rng, at(0.56)[0], 0, 1.4, 0x7a6c58); // what fell through the gap
};

// a floodlight mast, sometimes with its lamp head hanging
BUILDERS.floodlight = (o) => {
  const B = warBatch, rng = rngFor(o);
  B.setFrame(o.x, o.z, o.rot ?? rng() * 6, o.y);
  const metal = new THREE.Color(0x4d4944);
  B.box('steel', 0.5, 0.2, 0.5, 0, 0.1, 0, null, metal, 2);
  B.cyl('steel', 0.1, 0.17, 7.4, 0, 3.7, 0, null, metal, 6);
  B.collide(0, 0, 0.5, 0.5);
  const bent = rng() < 0.4;
  B.box('steel', 1.9, 0.75, 0.35, bent ? 0.7 : 0, bent ? 6.7 : 7.6, 0.2, bent ? [0, 0, 0.9] : [0.3, 0, 0], metal, 2);
  for (let i = 0; i < 3; i++) B.box('steel', 0.4, 0.4, 0.1, bent ? 0.4 : -0.6 + i * 0.6, bent ? 6.5 - i * 0.1 : 7.55, 0.42, bent ? [0, 0, 0.9] : [0.3, 0, 0], 0x1b1b1a, 2);
};

// a cluster of oil drums, some knocked over
BUILDERS.drums = (o) => {
  const B = warBatch, rng = rngFor(o);
  B.setFrame(o.x, o.z, o.rot ?? rng() * 6, o.y);
  const tints = [0x7a3b2a, 0x2f4a66, 0x6a6a2a, 0x4d4944];
  for (const [x, z] of [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]]) {
    if (rng() < 0.2) continue;
    const t = new THREE.Color(tints[Math.floor(rng() * tints.length)]).multiplyScalar(0.6 + rng() * 0.3);
    B.cyl('steel', 0.42, 0.42, 0.95, x, 0.48, z, null, t, 9);
    B.cyl('steel', 0.44, 0.44, 0.05, x, 0.8, z, null, t.clone().multiplyScalar(0.6), 9);
  }
  B.cyl('steel', 0.42, 0.42, 0.95, 1.3, 0.42, 0.7, [0, 0.5, Math.PI / 2 - 0.1], new THREE.Color(tints[2]).multiplyScalar(0.5), 9);
  B.collide(0, 0, 1.9, 1.9);
};

// a ruined warehouse of corrugated sheet metal. Opens towards local +z.
BUILDERS.warehouse = (o) => {
  const B = warBatch, rng = rngFor(o);
  B.setFrame(o.x, o.z, o.rot || 0, o.y);
  const { w, d, h } = o, t = 0.4, sheet = 0xdce2e6;
  ruinedWall(B, rng, { key: 'corr', x: 0, z: -d / 2 + t / 2, len: w, h, t, alongX: true, breach: false, tall: true, tint: sheet, tile: 4 });
  const l1 = d * 0.7 - t;
  ruinedWall(B, rng, { key: 'corr', x: -w / 2 + t / 2, z: -d / 2 + t + l1 / 2, len: l1, h: h * 0.95, t, alongX: false, breach: false, taper: true, tint: sheet, tile: 4 });
  const l2 = d - t - 0.6;
  ruinedWall(B, rng, { key: 'corr', x: w / 2 - t / 2, z: -d / 2 + t + l2 / 2, len: l2, h: h * 0.9, t, alongX: false, breach: true, tint: sheet, tile: 4 });
  for (let i = 0; i < 4; i++) { // steel columns along the open front, one snapped
    const cx = -w / 2 + 0.6 + (i * (w - 1.2)) / 3, hh = i === 1 ? h * 0.5 : h;
    B.box('steel', 0.45, hh, 0.45, cx, hh / 2, d / 2 - 0.5, [0, 0, i === 1 ? 0.08 : 0], rusted(rng, 0.9), 2);
    B.collide(cx, d / 2 - 0.5, 0.5, 0.5);
  }
  // the roof: sheets still on the left half, trusses jutting out, the right half down on the floor
  B.box('corr', w * 0.5, 0.12, d * 0.95, -w * 0.24, h + 0.25, 0, [0.07, 0, 0.04], grey(0.9), 5);
  for (const bx of [-w * 0.4, -w * 0.24, -w * 0.08]) ibeam(B, d * 0.95, bx, h + 0.05, 0, [0.07, 0, 0], 0x5e4030);
  B.box('corr', w * 0.34, 0.12, d * 0.55, w * 0.22, h * 0.5, -d * 0.12, [0.5, 0.1, -0.3], grey(0.8), 5);
  B.box('corr', w * 0.3, 0.12, d * 0.4, w * 0.18, 0.5, d * 0.18, [0.15, -0.3, 0.2], grey(0.75), 5);
  ibeam(B, d * 0.8, w * 0.3, h * 0.6, 0, [0.7, 0.1, 0.25], 0x553b2c);
  rubblePile(B, rng, w * 0.2, -d * 0.1, 1.7);
  rubblePile(B, rng, -w * 0.3, -d * 0.2, 1.1);
};

// a concrete loading dock with a ramp, bollards and a torn canopy (the longer side is its length)
BUILDERS.dock = (o) => {
  const B = warBatch, rng = rngFor(o);
  B.setFrame(o.x, o.z, o.rot || 0, o.y);
  const len = o.w, wid = o.d;
  B.box('conc', len, 1.3, wid, 0, 0.65, 0, null, grey(0.62), 5);
  B.box('conc', 4.5, 0.4, wid * 0.8, len / 2 + 2.0, 0.45, 0, [0, 0, -0.28], grey(0.58), 5); // ramp
  for (let i = 0; i < 6; i++) B.cyl('steel', 0.13, 0.13, 0.9, -len / 2 + 1.2 + i * ((len - 2.4) / 5), 1.75, wid / 2 - 0.4, null, new THREE.Color(0x8a7a2a).multiplyScalar(0.8), 6);
  for (const x of [-len * 0.3, len * 0.25]) B.cyl('steel', 0.14, 0.14, 4.2, x, 3.4, -wid / 2 + 0.3, [0, 0, rng() * 0.1 - 0.05], rusted(rng, 0.9), 6); // canopy posts
  B.box('corr', len * 0.6, 0.12, wid + 1.4, -len * 0.05, 5.4, 0, [0.28, 0, 0.05], grey(0.85), 5); // canopy, torn and drooping
  B.box('corr', len * 0.2, 0.12, wid * 0.6, len * 0.32, 3.4, wid * 0.1, [0.55, 0.2, 0.3], grey(0.8), 5);
  rubblePile(B, rng, -len / 2 - 1.2, wid * 0.2, 1.0);
  B.collide(0, 0, len, wid);
};

// stacked wooden pallets and a crate
BUILDERS.pallets = (o) => {
  const B = warBatch, rng = rngFor(o);
  B.setFrame(o.x, o.z, o.rot ?? rng() * 6, o.y);
  for (const [x, z] of [[-0.8, 0], [0.8, 0.2]]) {
    for (let i = 0, n = 3 + Math.floor(rng() * 4); i < n; i++) {
      B.box('wood', 1.2, 0.14, 1.0, x + (rng() - 0.5) * 0.12, 0.07 + i * 0.15, z + (rng() - 0.5) * 0.12, [0, (rng() - 0.5) * 0.2, 0], grey(0.55 + rng() * 0.3), 1.2);
    }
  }
  B.box('wood', 1.1, 0.9, 0.9, 0.8, 1.0, 0.2, [0, 0.3, 0], grey(0.8), 1.2);
  B.box('wood', 1.2, 0.14, 1.0, -0.2, 0.07, 1.3, [0, 0.6, 0.05], grey(0.5), 1.2); // one fallen off
  B.collide(0, 0.3, 2.9, 2.2);
};

// a container gantry crane: two tall legs, a beam across, a container hanging crooked. Only the legs are solid.
BUILDERS.gantry = (o) => {
  const B = warBatch, rng = rngFor(o);
  B.setFrame(o.x, o.z, o.rot || 0, o.y);
  const span = o.w, paint = () => equipYellow(rng, 0.9);
  for (const sd of [-1, 1]) {
    B.box('steel', 1.4, 0.4, 1.8, sd * span / 2, 0.2, 0, null, rusted(rng, 0.7), 2);
    B.box('steel', 1.1, 9.4, 1.1, sd * span / 2, 4.7, 0, null, paint(), 2);
    B.box('steel', 0.4, 3.4, 0.4, sd * (span / 2 - 1.3), 8.0, 0, [0, 0, sd * 0.7], paint(), 2); // braces up to the beam
    B.collide(sd * span / 2, 0, 1.4, 1.8);
  }
  B.box('steel', span + 3, 1.3, 1.6, 0, 9.6, 0, [0, 0, 0.012], paint(), 2);
  B.box('steel', 2.2, 1.0, 2.2, -span * 0.15, 8.6, 0, null, darkMetal2(rng), 2); // trolley
  for (const x of [-span * 0.15 - 0.8, -span * 0.15 + 0.8]) B.cyl('steel', 0.04, 0.04, 3.2, x, 6.9, 0, null, 0x2a2a28, 4);
  B.box('steel', 2.6, 0.3, 1.5, -span * 0.15, 5.2, 0, [0, 0, 0.06], darkMetal2(rng), 2);
  B.box('steel', 6, 2.4, 2.4, -span * 0.15, 3.9, 0, [0, 0, 0.12], new THREE.Color(0x3b6a68).multiplyScalar(0.55 + rng() * 0.25), 3); // the hanging container
};

// a drift of snow against a wall or block (decoration; the longer side is its length)
BUILDERS.snowdrift = (o) => {
  const B = warBatch, rng = rngFor(o);
  B.setFrame(o.x, o.z, 0, o.y);
  const alongX = o.w >= o.d, len = alongX ? o.w : o.d, wid = alongX ? o.d : o.w;
  for (let a = -len / 2 + 1; a <= len / 2 - 1; a += 1.8) {
    const h = 0.45 + rng() * 0.4, g = new THREE.SphereGeometry(1, 10, 5, 0, Math.PI * 2, 0, Math.PI / 2).scale(1.7 + rng() * 0.6, h, wid * 0.55 + rng() * 0.4);
    g.computeVertexNormals();
    B.geo('snow', g, alongX ? a : (rng() - 0.5) * 0.4, 0, alongX ? (rng() - 0.5) * 0.4 : a, [0, alongX ? 0 : Math.PI / 2, 0], grey(0.9 + rng() * 0.1));
  }
};

// frozen debris: a cluster of crooked ice shards
BUILDERS.iceshard = (o) => {
  const B = warBatch, rng = rngFor(o);
  B.setFrame(o.x, o.z, 0, o.y);
  for (let i = 0, n = 5 + Math.floor(rng() * 3); i < n; i++) {
    const hh = 0.8 + rng() * 1.6, a = rng() * 6.28, d = rng() * 1.1;
    B.box('ice', 0.3 + rng() * 0.4, hh, 0.3 + rng() * 0.4, Math.cos(a) * d, hh * 0.45, Math.sin(a) * d, [rng() * 0.5 - 0.25, rng() * 3, rng() * 0.5 - 0.25], grey(0.85 + rng() * 0.15), 3);
  }
};

// ---------- Battlefield ground: craters, tracks, patches and puddles (every map) ----------
// One painted texture lies over the arena floor. groundLayout decides WHERE things go (the same list
// feeds the painting and the raised crater rims); groundCfg says what they LOOK like on this map.
// The default values are the war map's; the other maps override them in THEMES[...].ground.
const GROUND_DEFAULT = {
  res: 2048, // texture size in pixels (the arena is 100 units wide)
  count: { craters: 16, shells: 30, scorch: 7, grass: 22, gravel: 10, puddles: 9, tracks: 7 },
  crater: [2, 5.6], // radius range in world units
  pit: ['rgba(22,17,13,0.95)', 'rgba(40,32,24,0.85)', 'rgba(60,48,36,0.35)'],
  rimLit: 'rgba(150,130,100,0.65)', rimShade: 'rgba(120,102,78,0.4)',
  arcShadow: 'rgba(8,6,4,0.5)', arcLit: 'rgba(170,148,116,0.4)', arcRim: 'rgba(185,160,125,0.4)',
  clodRGB: [1, 0.8, 0.6], clodRange: [30, 90],
  scorch: ['rgba(10,8,6,0.55)', 'rgba(14,11,8,0.35)'],
  track: { rgb: '24,18,12', a: 0.5, tickRGB: '16,12,8', tickA: 0.55 },
  grass: { base: ['rgba(88,84,52,0.55)', 'rgba(80,76,48,0.4)'], blades: ['hsla(48,18%,30%,0.8)', 'hsla(40,20%,21%,0.8)', 'hsla(58,14%,36%,0.7)'], density: 16 },
  gravel: { base: ['rgba(80,76,68,0.6)', 'rgba(72,68,60,0.45)'], pebble: [55, 120] },
  puddle: { dark: ['rgba(14,13,12,0.92)', 'rgba(22,19,16,0.88)', 'rgba(30,26,22,0)'], sheen: 'rgba(110,118,126,0.22)' },
  wall: 'rgba(20,15,10,0.5)',
  macro: { dark: 'rgba(18,14,10,0.2)', light: 'rgba(130,108,80,0.14)' },
  stones: { range: [35, 150], tint: [0.92, 0.8], n: 1400 },
  rim: 0x3e3429,
};

function groundCfg() {
  const o = theme.ground || {};
  const cfg = {};
  for (const [k, d] of Object.entries(GROUND_DEFAULT)) {
    cfg[k] = d && typeof d === 'object' && !Array.isArray(d) ? { ...d, ...(o[k] || {}) } : (o[k] ?? d);
  }
  return cfg;
}

function groundLayout(map) {
  const key = `ground:${map.id}`;
  if (texCache[key]) return texCache[key];
  const C = groundCfg();
  const rng = mulberry32(map.seed + 99);
  const r = (a, b) => a + rng() * (b - a);
  const L = { craters: [], shells: [], scorch: [], tracks: [], grass: [], gravel: [], puddles: [] };
  const lim = ARENA - 3;
  const apart = (x, z, rad, list, gap) => list.every((c) => Math.hypot(c.x - x, c.z - z) > c.r + rad + gap);
  // fills `list` with up to `count` free spots of radius r0..r1 (clear of cover)
  const place = (list, count, r0, r1, clear, gap = 0.5) => {
    for (let tries = 0; tries < count * 12 && list.length < count; tries++) {
      const rad = r0 + rng() * rng() * (r1 - r0);
      const x = r(-lim, lim), z = r(-lim, lim);
      if (pointBlocked(x, z, rad * clear) || !apart(x, z, rad, list, gap)) continue;
      list.push({ x, z, r: rad });
    }
  };
  place(L.craters, C.count.craters, C.crater[0], C.crater[1], 0.8, 1.5);
  L.craters = L.craters.filter((c) => Math.hypot(c.x - map.playerStart.x, c.z - map.playerStart.z) > c.r + 5);
  place(L.shells, C.count.shells, 0.6, 1.4, 0.5, 0.3);
  place(L.scorch, C.count.scorch, 2.5, 5, 0, 0);
  place(L.grass, C.count.grass, 2.5, 8.5, 0.3, 0);
  place(L.gravel, C.count.gravel, 2, 5.5, 0.3, 0);
  place(L.puddles, C.count.puddles, 1.2, 3.2, 0.8, 1);
  // tracks: start at a spawn point, curve gently towards the middle until something is in the way
  for (let t = 0; t < C.count.tracks; t++) {
    const sp = map.spawns[Math.floor(rng() * map.spawns.length)];
    let x = sp[0] + r(-3, 3), z = sp[1] + r(-3, 3);
    let a = Math.atan2(-z + r(-25, 25), -x + r(-25, 25));
    const curve = r(-0.035, 0.035);
    const pts = [];
    for (let i = 0; i < 150; i++) {
      a += curve + r(-0.025, 0.025);
      x += Math.cos(a) * 0.5;
      z += Math.sin(a) * 0.5;
      if (pointBlocked(x, z, 1.4)) break;
      pts.push([x, z, a]);
    }
    if (pts.length > 20) L.tracks.push(pts);
  }
  texCache[key] = L;
  return L;
}

function groundTexture(map) {
  const key = `ground-tex:${map.id}`;
  if (texCache[key]) return texCache[key];
  // only the current map keeps its big ground texture in memory
  for (const k of Object.keys(texCache)) {
    if (k.startsWith('ground-tex:') && k !== key) {
      texCache[k].dispose();
      delete texCache[k];
    }
  }
  const L = groundLayout(map);
  const C = groundCfg();
  const PX = C.res;
  const u = PX / 2048; // pixel-sized details shrink on a smaller texture
  const k = PX / (ARENA * 2); // canvas pixels per world unit (canvas y runs along world z)
  const X = (x) => (x + ARENA) * k;
  const Y = (z) => (z + ARENA) * k;
  const sunA = Math.atan2(theme.sun[4], theme.sun[2]); // direction of the sun on the ground, for crater shading
  const tex2 = canvasTexture(PX, map.seed + 5, (g) => {
    const rg = (x, y, rad, stops) => {
      const gr = g.createRadialGradient(x, y, 0, x, y, rad);
      for (const [at, c] of stops) gr.addColorStop(at, c);
      g.fillStyle = gr;
      g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
    };
    const inDisc = (c, rad) => {
      const a = srand() * Math.PI * 2, d = rad * Math.sqrt(srand());
      return [X(c.x) + Math.cos(a) * d * k, Y(c.z) + Math.sin(a) * d * k];
    };
    const ell = (x, y, rx, ry) => {
      g.beginPath();
      g.ellipse(x, y, rx * u, ry * u, srand() * 3, 0, Math.PI * 2);
      g.fill();
    };
    // big soft patches break up the repeating ground texture underneath
    for (let i = 0; i < 46; i++) {
      rg(srnd(0, PX), srnd(0, PX), srnd(120, 320) * u, [[0, i % 3 === 0 ? C.macro.light : C.macro.dark], [1, 'rgba(0,0,0,0)']]);
    }
    // churned, darker ground along the foot of the outer walls
    const wallW = 3.6 * k;
    for (const [ax, ay, w, h, gx0, gy0, gx1, gy1] of [
      [0, 0, PX, wallW, 0, 0, 0, wallW], [0, PX - wallW, PX, wallW, 0, PX, 0, PX - wallW],
      [0, 0, wallW, PX, 0, 0, wallW, 0], [PX - wallW, 0, wallW, PX, PX, 0, PX - wallW, 0],
    ]) {
      const gr = g.createLinearGradient(gx0, gy0, gx1, gy1);
      gr.addColorStop(0, C.wall);
      gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr;
      g.fillRect(ax, ay, w, h);
    }
    // gravel / rubble / bare stony patches
    for (const c of L.gravel) {
      rg(X(c.x), Y(c.z), c.r * k * 1.1, [[0, C.gravel.base[0]], [0.7, C.gravel.base[1]], [1, 'rgba(0,0,0,0)']]);
      for (let i = 0; i < c.r * c.r * 9 * u * u; i++) {
        const [px, py] = inDisc(c, c.r);
        const v = srnd(...C.gravel.pebble);
        g.fillStyle = `rgba(${v},${v * 0.97},${v * 0.9},0.8)`;
        ell(px, py, srnd(1.5, 4), srnd(1, 3));
      }
    }
    // grass, weeds or snow drifts: a faded base and lots of short strokes
    for (const c of L.grass) {
      rg(X(c.x), Y(c.z), c.r * k * 1.15, [[0, C.grass.base[0]], [0.75, C.grass.base[1]], [1, 'rgba(0,0,0,0)']]);
      const n = Math.min(1400, Math.floor(c.r * c.r * C.grass.density)) * u * u;
      for (const col of C.grass.blades) {
        g.strokeStyle = col;
        g.lineWidth = Math.max(0.7, 1.0 * u);
        g.beginPath();
        for (let i = 0; i < n / 3; i++) {
          const [px, py] = inDisc(c, c.r);
          const a = srnd(-2.2, -0.9), len = srnd(5, 11) * u; // blades lean mostly "up" the texture
          g.moveTo(px, py);
          g.lineTo(px + Math.cos(a) * len, py + Math.sin(a) * len);
        }
        g.stroke();
      }
    }
    // scorched ground, around craters and a few places of its own
    for (const c of [...L.scorch, ...L.craters]) {
      const big = L.craters.includes(c) ? 1.9 : 1;
      rg(X(c.x), Y(c.z), c.r * k * big, [[0, C.scorch[0]], [0.6, C.scorch[1]], [1, 'rgba(0,0,0,0)']]);
    }
    // puddles: dark water (or ice) with a pale sky reflection
    for (const c of L.puddles) {
      const x = X(c.x), y = Y(c.z), R = c.r * k;
      rg(x, y, R, [[0, C.puddle.dark[0]], [0.75, C.puddle.dark[1]], [1, C.puddle.dark[2]]]);
      rg(x - R * 0.25, y - R * 0.25, R * 0.4, [[0, C.puddle.sheen], [1, 'rgba(255,255,255,0)']]);
    }
    // tracks: a soft pressed lane with tread marks across it, fading in and out
    for (const pts of L.tracks) {
      for (const side of [-1, 1]) {
        const lane = pts.map(([x, z, a]) => [x - Math.sin(a) * side * 0.95, z + Math.cos(a) * side * 0.95, a]);
        g.lineCap = 'round';
        for (let i = 1; i < lane.length; i++) {
          const env = Math.min(1, i / 12, (lane.length - i) / 12);
          g.strokeStyle = `rgba(${C.track.rgb},${C.track.a * env})`;
          g.lineWidth = 0.8 * k;
          g.beginPath();
          g.moveTo(X(lane[i - 1][0]), Y(lane[i - 1][1]));
          g.lineTo(X(lane[i][0]), Y(lane[i][1]));
          g.stroke();
          const [x, z, a] = lane[i];
          g.strokeStyle = `rgba(${C.track.tickRGB},${C.track.tickA * env})`;
          g.lineWidth = 0.13 * k;
          g.lineCap = 'butt';
          g.beginPath();
          g.moveTo(X(x + Math.sin(a) * 0.3), Y(z - Math.cos(a) * 0.3));
          g.lineTo(X(x - Math.sin(a) * 0.3), Y(z + Math.cos(a) * 0.3));
          g.stroke();
          g.lineCap = 'round';
        }
      }
    }
    // craters: dark pit, raised rim, with the sun-facing walls shaded to read as a dent
    for (const c of [...L.craters, ...L.shells]) {
      const x = X(c.x), y = Y(c.z), R = c.r * k;
      rg(x, y, R * 1.3, [[0, 'rgba(0,0,0,0)'], [0.55, 'rgba(0,0,0,0)'], [0.72, C.rimLit], [0.85, C.rimShade], [1, 'rgba(0,0,0,0)']]);
      rg(x, y, R, [[0, C.pit[0]], [0.6, C.pit[1]], [0.92, C.pit[2]], [1, 'rgba(0,0,0,0)']]);
      g.lineCap = 'butt';
      for (const [rad, from, to, col, wd] of [
        [0.78, sunA - 1.0, sunA + 1.0, C.arcShadow, 0.16],
        [0.78, sunA + Math.PI - 0.9, sunA + Math.PI + 0.9, C.arcLit, 0.14],
        [1.02, sunA - 0.9, sunA + 0.9, C.arcRim, 0.12],
      ]) {
        g.strokeStyle = col;
        g.lineWidth = wd * R;
        g.beginPath();
        g.arc(x, y, R * rad, from, to);
        g.stroke();
      }
      for (let i = 0; i < 6 + c.r * 2; i++) { // clods thrown out around the rim
        const a = srand() * Math.PI * 2, d = R * srnd(0.95, 1.5);
        const v = srnd(...C.clodRange);
        g.fillStyle = `rgba(${v * C.clodRGB[0]},${v * C.clodRGB[1]},${v * C.clodRGB[2]},0.85)`;
        ell(x + Math.cos(a) * d, y + Math.sin(a) * d, srnd(1.5, 4.5), srnd(1.2, 3.2));
      }
    }
    // loose stones and clods everywhere
    for (let i = 0; i < C.stones.n * u * u; i++) {
      const v = srnd(...C.stones.range);
      g.fillStyle = `rgba(${v},${v * C.stones.tint[0]},${v * C.stones.tint[1]},${srnd(0.35, 0.8)})`;
      ell(srnd(0, PX), srnd(0, PX), srnd(1, 3.2), srnd(0.8, 2.4));
    }
  });
  tex2.wrapS = tex2.wrapT = THREE.ClampToEdgeWrapping;
  texCache[key] = tex2;
  return tex2;
}

function buildGround(map) {
  const L = groundLayout(map);
  const C = groundCfg();
  const overlay = new THREE.Mesh(
    new THREE.PlaneGeometry(ARENA * 2, ARENA * 2),
    new THREE.MeshLambertMaterial({ // flat dirt needs no shiny highlights: the cheaper material is enough
      map: groundTexture(map), transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8,
    })
  );
  overlay.rotation.x = -Math.PI / 2;
  overlay.position.y = 0.02;
  overlay.renderOrder = -1; // under scorch marks and other floor decals
  overlay.receiveShadow = true;
  arena.add(overlay);

  // low raised rims around the craters (about knee high on a tank, so they never get in the way)
  const rims = new THREE.InstancedMesh(
    new THREE.TorusGeometry(1, 0.13, 6, 30).rotateX(Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: C.rim, roughness: 1 }),
    L.craters.length
  );
  rims.receiveShadow = true;
  L.craters.forEach((c, i) => {
    dummy.position.set(c.x, 0.02, c.z);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.set(c.r * 1.0, 0.6 + c.r * 0.1, c.r * 1.0);
    dummy.updateMatrix();
    rims.setMatrixAt(i, dummy.matrix);
  });
  rims.instanceMatrix.needsUpdate = true;
  arena.add(rims);
}

function buildMap(map) {
  disposeArena();
  boxes.length = 0;
  currentMap = map;
  theme = THEMES[map.theme];
  applyTheme();
  placeSmokeCols(map);

  const outer = new THREE.Mesh(
    new THREE.PlaneGeometry(900, 900),
    new THREE.MeshStandardMaterial({ map: texRepeat(theme.outer, 90), color: theme.outerTint ?? 0xffffff, roughness: 1 })
  );
  outer.rotation.x = -Math.PI / 2;
  outer.receiveShadow = true;
  arena.add(outer);
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(ARENA * 2, ARENA * 2),
    new THREE.MeshStandardMaterial({
      map: texRepeat(theme.floor, theme.floorRepeat), color: theme.floorTint ?? 0xffffff, roughness: 0.95,
      // always draw over the outer ground, even with a low-precision depth buffer
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4,
    })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = 0.02;
  floor.receiveShadow = true;
  arena.add(floor);
  buildMarkings(map.markings);

  // outer walls sit just outside the playable area
  const WALL_T = 2;
  const WALL_H = 3;
  const wallMat = concreteMat(theme.wall);
  const WALL_LEN = ARENA * 2 + WALL_T * 2;
  for (const [x, z, w, d] of [
    [0, -ARENA - WALL_T / 2, WALL_LEN, WALL_T],
    [0, ARENA + WALL_T / 2, WALL_LEN, WALL_T],
    [-ARENA - WALL_T / 2, 0, WALL_T, WALL_LEN],
    [ARENA + WALL_T / 2, 0, WALL_T, WALL_LEN],
  ]) {
    addMesh(worldUV(new THREE.BoxGeometry(w, WALL_H, d), 4), wallMat, x, WALL_H / 2, z);
    addCap(x, z, w + 0.4, d + 0.4, WALL_H, theme.cap);
    addCollider(x, z, w, d);
  }

  warFires.length = 0;
  warFadeMats.length = 0;
  bridgeFade = 1;
  warBatch = theme.props ? new Batch(mulberry32(map.seed + 3)) : null;
  for (const o of map.obstacles) BUILDERS[o.type](o);
  if (theme.props) {
    warBatch.flush();
    warBatch = null;
  }
  if (theme.ground) buildGround(map);

  // keep only spawn points that are actually clear of cover
  SPAWNS = map.spawns.map(([x, z]) => ({ x, z })).filter((s) => !pointBlocked(s.x, s.z, MAX_TANK_R + 0.3));
  PLAYER_START = map.playerStart;

  srand = mulberry32(map.seed);
  buildScenery();
  if (theme.war) warSkyline(map);
  hud.mapLabel.textContent = map.name;
  buildNav();
}

// falling snow that follows the camera (only on snowy maps)
const SNOW_COUNT = 1600;
let snowActive = SNOW_COUNT; // how many of them are drawn (the quality setting lowers this)
const snowPos = new Float32Array(SNOW_COUNT * 3);
for (let i = 0; i < SNOW_COUNT; i++) {
  snowPos[i * 3] = rnd(-55, 55);
  snowPos[i * 3 + 1] = rnd(0, 35);
  snowPos[i * 3 + 2] = rnd(-55, 55);
}
const snowGeo = new THREE.BufferGeometry();
snowGeo.setAttribute('position', new THREE.BufferAttribute(snowPos, 3));
const snow = new THREE.Points(snowGeo, new THREE.PointsMaterial({
  color: 0xffffff, size: 0.22, transparent: true, opacity: 0.85, depthWrite: false,
}));
snow.frustumCulled = false;
scene.add(snow);

// what falls on the map: snow, or grey ash blowing sideways on the war theme
const PRECIP = {
  snow: { color: 0xffffff, size: 0.22, opacity: 0.85, fall: 1, drift: 0.5, wind: 0 },
  ash: { color: 0x8f8a82, size: 0.3, opacity: 0.7, fall: 0.35, drift: 1.8, wind: 1.6, round: true },
  // pale dust blowing across the ground (Quarry)
  dust: { color: 0xb8a07a, size: 0.34, opacity: 0.32, fall: 0.12, drift: 1.2, wind: 2.2, round: true },
};
let precip = PRECIP.snow;

function updateSnow(dt, time) {
  if (!snow.visible) return;
  for (let i = 0; i < snowActive; i++) {
    const k = i * 3;
    snowPos[k] += (Math.sin(time * 0.7 + i) * precip.drift + precip.wind) * dt;
    if (snowPos[k] > 55) snowPos[k] -= 110;
    snowPos[k + 1] -= (2 + (i % 7) * 0.3) * precip.fall * dt;
    if (snowPos[k + 1] < 0) snowPos[k + 1] += 35;
  }
  snowGeo.attributes.position.needsUpdate = true;
  snow.position.set(camera.position.x, 0, camera.position.z);
}

// ---------- War atmosphere: distant smoke columns and explosion flashes (war theme only) ----------
const war = new THREE.Group();
war.visible = false;
scene.add(war);

const soft = (size, stops) => {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [at, color] of stops) grd.addColorStop(at, color);
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
};
const smokeTex = soft(128, [[0, 'rgba(255,255,255,1)'], [0.45, 'rgba(255,255,255,0.7)'], [1, 'rgba(255,255,255,0)']]);

const SMOKE_COLUMNS = 9;
const SMOKE_PER = 22; // puffs in each column
const SMOKE_N = SMOKE_COLUMNS * SMOKE_PER;
const smokeGeo = new THREE.BufferGeometry();
const smokePos = new Float32Array(SMOKE_N * 3);
const smokeSize = new Float32Array(SMOKE_N);
const smokeAlpha = new Float32Array(SMOKE_N);
const smokeTint = new Float32Array(SMOKE_N * 3);
smokeGeo.setAttribute('position', new THREE.BufferAttribute(smokePos, 3));
smokeGeo.setAttribute('aSize', new THREE.BufferAttribute(smokeSize, 1));
smokeGeo.setAttribute('aAlpha', new THREE.BufferAttribute(smokeAlpha, 1));
smokeGeo.setAttribute('aTint', new THREE.BufferAttribute(smokeTint, 3));
const smokeMat = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false,
  uniforms: {
    map: { value: smokeTex }, scale: { value: 800 },
    fogColor: { value: new THREE.Color() }, fogRange: { value: new THREE.Vector2(40, 230) },
  },
  vertexShader: /* glsl */ `
    attribute float aSize;
    attribute float aAlpha;
    attribute vec3 aTint;
    uniform float scale;
    uniform vec2 fogRange;
    varying float vA;
    varying vec3 vTint;
    varying float vFog;
    void main() {
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_Position = projectionMatrix * mv;
      gl_PointSize = min(aSize * scale / -mv.z, 600.0);
      vA = aAlpha;
      vTint = aTint;
      vFog = smoothstep(fogRange.x, fogRange.y, -mv.z);
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D map;
    uniform vec3 fogColor;
    varying float vA;
    varying vec3 vTint;
    varying float vFog;
    void main() {
      float a = texture2D(map, gl_PointCoord).a * vA;
      if (a < 0.003) discard;
      gl_FragColor = vec4(mix(vTint, fogColor, vFog * 0.8), a);
    }`,
});
const smokePoints = new THREE.Points(smokeGeo, smokeMat);
smokePoints.frustumCulled = false;
war.add(smokePoints);

// each column stands on the horizon, outside the arena, and leans downwind
const smokeCols = Array.from({ length: SMOKE_COLUMNS }, (_, i) => {
  const a = ((i + Math.random() * 0.6) / SMOKE_COLUMNS) * Math.PI * 2;
  const r = rnd(95, 150);
  return {
    x: Math.cos(a) * r, z: Math.sin(a) * r, height: rnd(40, 75), period: rnd(16, 26),
    spread: rnd(16, 26), phase: Math.random(),
  };
});
// where the horizon columns stand on this map (the war map moves them onto its ruined skyline afterwards)
function placeSmokeCols(map) {
  const rng = mulberry32(map.seed + 11);
  const r = (a, b) => a + rng() * (b - a);
  const active = Math.max(1, theme.horizon ? theme.horizon.columns : SMOKE_COLUMNS);
  smokeCols.forEach((col, i) => {
    const a = ((i + rng() * 0.6) / active) * Math.PI * 2, d = r(95, 150);
    col.x = Math.cos(a) * d;
    col.z = Math.sin(a) * d;
    col.y0 = 0;
    col.height = r(40, 75);
    col.period = r(16, 26);
    col.spread = r(16, 26);
    col.phase = rng();
  });
}
const smokeLow = new THREE.Color(0x6a3a1c); // fire-lit at the base
const smokeHigh = new THREE.Color(0x2a2724);
const smokeTmp = new THREE.Color();
const WIND = new THREE.Vector2(0.35, 0.12); // sideways drift per unit of height

// a distant explosion: a flash on the horizon that lights the scene up for a moment
const glowTex = soft(128, [[0, 'rgba(255,255,255,1)'], [0.25, 'rgba(255,255,255,0.55)'], [1, 'rgba(255,255,255,0)']]);
const flash = new THREE.Sprite(new THREE.SpriteMaterial({
  map: glowTex, color: new THREE.Color(3.4, 1.8, 0.7), transparent: true, depthWrite: false,
  blending: THREE.AdditiveBlending, fog: false, opacity: 0,
}));
flash.visible = false;
war.add(flash);
// fires on the ground: flickering flames (glowing, additive) and a thin column of dark smoke each
const MAX_FIRES = 24;
const FLAME_PER = 12; // 11 licking flames and one big faint glow on the ground
const FIRE_SMOKE_PER = 10;
const mkPoints = (count) => {
  const geo = new THREE.BufferGeometry();
  const a = { pos: new Float32Array(count * 3), size: new Float32Array(count), alpha: new Float32Array(count), tint: new Float32Array(count * 3) };
  geo.setAttribute('position', new THREE.BufferAttribute(a.pos, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(a.size, 1));
  geo.setAttribute('aAlpha', new THREE.BufferAttribute(a.alpha, 1));
  geo.setAttribute('aTint', new THREE.BufferAttribute(a.tint, 3));
  return { geo, a };
};
const fireSmoke = mkPoints(MAX_FIRES * FIRE_SMOKE_PER);
const fireFlame = mkPoints(MAX_FIRES * FLAME_PER);
const smokePts = new THREE.Points(fireSmoke.geo, smokeMat);
const flameMat = smokeMat.clone();
flameMat.uniforms = THREE.UniformsUtils.clone(smokeMat.uniforms);
flameMat.uniforms.map.value = glowTex;
flameMat.blending = THREE.AdditiveBlending;
flameMat.fragmentShader = flameMat.fragmentShader.replace('gl_FragColor = vec4(mix(vTint, fogColor, vFog * 0.8), a);', 'gl_FragColor = vec4(vTint, a);');
flameMat.needsUpdate = true;
const flamePts = new THREE.Points(fireFlame.geo, flameMat);
smokePts.frustumCulled = flamePts.frustumCulled = false;
war.add(smokePts, flamePts);
const flameHot = new THREE.Color(3.0, 1.7, 0.45);
const flameCool = new THREE.Color(1.8, 0.5, 0.1);
const flameTmp = new THREE.Color();

function updateFires(time) {
  const S = fireSmoke.a, F = fireFlame.a;
  for (let f = 0; f < MAX_FIRES; f++) {
    const fire = warFires[f];
    for (let j = 0; j < FLAME_PER; j++) {
      const i = f * FLAME_PER + j;
      if (!fire) { F.size[i] = 0; F.alpha[i] = 0; continue; }
      const sz = fire.size;
      if (j === FLAME_PER - 1) { // the glow on the ground
        F.pos[i * 3] = fire.x; F.pos[i * 3 + 1] = fire.y * 0.4; F.pos[i * 3 + 2] = fire.z;
        F.size[i] = sz * 4.5;
        F.alpha[i] = 0.16 + 0.05 * Math.sin(time * 9 + fire.phase * 20);
        F.tint[i * 3] = 1.4; F.tint[i * 3 + 1] = 0.55; F.tint[i * 3 + 2] = 0.15;
        continue;
      }
      const a = (time * 1.9 + j / (FLAME_PER - 1) + fire.phase) % 1; // 0 at the base of the flame, 1 at its tip
      // narrow tongues that rise, sway more the higher they go and thin out to a point
      const wob = Math.sin(time * 8 + j * 2.3 + fire.phase * 30) * 0.3 * sz * a * a;
      F.pos[i * 3] = fire.x + wob;
      F.pos[i * 3 + 1] = fire.y + a * 1.9 * sz;
      F.pos[i * 3 + 2] = fire.z + Math.cos(time * 6 + j * 1.7) * 0.22 * sz * a * a;
      F.size[i] = sz * (0.75 - a * 0.58) * (0.85 + 0.25 * Math.sin(time * 11 + j));
      F.alpha[i] = Math.min(a / 0.08, 1) * Math.pow(1 - a, 1.3) * 0.95;
      flameTmp.copy(flameHot).lerp(flameCool, a);
      F.tint[i * 3] = flameTmp.r; F.tint[i * 3 + 1] = flameTmp.g; F.tint[i * 3 + 2] = flameTmp.b;
    }
    for (let k = 0; k < FIRE_SMOKE_PER; k++) {
      const i = f * FIRE_SMOKE_PER + k;
      if (!fire) { S.size[i] = 0; S.alpha[i] = 0; continue; }
      const a = (time / fire.period + k / FIRE_SMOKE_PER + fire.phase) % 1;
      const rise = a * 11 * fire.size;
      S.pos[i * 3] = fire.x + WIND.x * rise + Math.sin(k * 5.1 + f) * a * 0.9;
      S.pos[i * 3 + 1] = fire.y + 0.4 + rise;
      S.pos[i * 3 + 2] = fire.z + WIND.y * rise + Math.cos(k * 3.7 + f) * a * 0.9;
      S.size[i] = fire.size * (0.9 + Math.sqrt(a) * 3.4);
      S.alpha[i] = Math.min(a / 0.08, 1) * (1 - THREE.MathUtils.smoothstep(a, 0.45, 1)) * 0.5;
      smokeTmp.set(0x211e1b).lerp(smokeHigh, a);
      S.tint[i * 3] = smokeTmp.r; S.tint[i * 3 + 1] = smokeTmp.g; S.tint[i * 3 + 2] = smokeTmp.b;
    }
  }
  for (const g of [fireSmoke.geo, fireFlame.geo]) for (const n of ['position', 'aSize', 'aAlpha', 'aTint']) g.attributes[n].needsUpdate = true;
}

// One warm light for the fire nearest the player. It borrows the last light of the combat-flash pool
// (so no light is added to the scene: more lights make every pixel on every map slower), and it is off
// on Low quality. While it is active, muzzle flashes and explosions share the other three pool lights.
let emberOn = true; // the quality setting can turn it off
let emberActive = false;
let emberPos = new THREE.Vector3();
let emberK = 0;
function updateEmber(dt, time) {
  let best = null, bd = 22 * 22;
  for (const f of warFires) {
    const d = (f.x - player.pos.x) ** 2 + (f.z - player.pos.z) ** 2;
    if (d < bd) { bd = d; best = f; }
  }
  emberActive = !!(theme.embers && emberOn);
  const want = emberActive && best ? 1 : 0;
  if (best && want) emberPos.set(best.x, best.y + 1.2, best.z);
  emberK += (want - emberK) * (1 - Math.exp(-4 * dt));
  if (!emberActive && emberK < 0.01) return; // the pool light is free again
  const slot = lightPool[lightPool.length - 1];
  slot.life = 0; // keep the pool from using it for a flash
  slot.light.color.setHex(0xff7a2a);
  slot.light.position.copy(emberPos);
  slot.light.intensity = emberK * (13 + 4 * Math.sin(time * 9.3) + 2.5 * Math.sin(time * 15.7 + 1.1)); // flickers
}

// lightning: now and then the whole sky flashes twice in quick succession, then thunder follows
let lightningLeft = 25;
let lightningT = 99;
function updateLightning(dt, time) {
  const spec = theme.lightning;
  if (!spec) {
    skyUniforms.flash.value = 0;
    return;
  }
  lightningLeft -= dt;
  if (lightningLeft <= 0) {
    lightningLeft = rnd(spec[0], spec[1]);
    lightningT = 0;
    Sound.thunder(rnd(0.7, 2.2));
  }
  lightningT += dt;
  // two strikes: a bright one and a weaker echo 0.22 s later
  const f = (t0, k) => (lightningT > t0 ? Math.exp(-(lightningT - t0) * 14) * k * Math.min((lightningT - t0) / 0.03, 1) : 0);
  const k = Math.max(f(0, 1), f(0.22, 0.6));
  skyUniforms.flash.value = k;
  hemi.intensity = theme.hemi[2] + k * 0.9;
}

let flashAge = 99;
let nextFlash = 4;
const FLASH_TIME = 0.8;

function updateWar(dt, time) {
  if (!war.visible) return;
  smokeMat.uniforms.scale.value = flameMat.uniforms.scale.value = renderer.domElement.height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
  updateFires(time);
  updateEmber(dt, time);
  for (let c = 0; c < SMOKE_COLUMNS; c++) {
    const col = smokeCols[c];
    for (let k = 0; k < SMOKE_PER; k++) {
      const i = c * SMOKE_PER + k;
      if (c >= horizonCols) { // unused on this map
        smokeAlpha[i] = 0;
        continue;
      }
      const a = (time / col.period + k / SMOKE_PER + col.phase) % 1; // 0 = just born at the base, 1 = gone
      const y = a * col.height;
      // each puff wobbles sideways a different amount, so the column billows instead of standing straight
      smokePos[i * 3] = col.x + WIND.x * y + Math.sin(k * 7.1 + c) * (1.5 + a * 6);
      smokePos[i * 3 + 1] = (col.y0 || 0) + y;
      smokePos[i * 3 + 2] = col.z + WIND.y * y + Math.cos(k * 5.3 + c) * (1.5 + a * 6);
      smokeSize[i] = 6 + Math.sqrt(a) * col.spread * (0.75 + 0.5 * Math.abs(Math.sin(k * 3.7 + c)));
      smokeAlpha[i] = Math.min(a / 0.06, 1) * (1 - THREE.MathUtils.smoothstep(a, 0.5, 1)) * 0.5;
      smokeTmp.copy(smokeLow).lerp(smokeHigh, THREE.MathUtils.smoothstep(a, 0, 0.22));
      smokeTint[i * 3] = smokeTmp.r;
      smokeTint[i * 3 + 1] = smokeTmp.g;
      smokeTint[i * 3 + 2] = smokeTmp.b;
    }
  }
  for (const name of ['position', 'aSize', 'aAlpha', 'aTint']) smokeGeo.attributes[name].needsUpdate = true;

  nextFlash -= dt;
  if (nextFlash <= 0 && horizonFlash) {
    nextFlash = rnd(5, 11);
    const col = smokeCols[Math.floor(Math.random() * horizonCols)];
    flash.position.set(col.x, 4, col.z);
    flashAge = 0;
  }
  flashAge += dt;
  const k = flashAge < FLASH_TIME ? Math.exp(-flashAge * 5) * Math.min(flashAge / 0.04, 1) : 0;
  flash.visible = k > 0.01;
  flash.material.opacity = k;
  flash.scale.setScalar(50 + flashAge * 60);
  hemi.intensity = Math.max(hemi.intensity, theme.hemi[2] + k * 0.3);
  // the sun comes and goes as clouds pass over it
  sun.intensity = sunBase * (1 - 0.22 * sunFlicker * (1 - Math.sin(time * 0.31) * Math.sin(time * 0.17 + 1.3)));
}

// ---------- Collision helpers ----------
function pointBlocked(x, z, margin) {
  if (Math.abs(x) > ARENA - margin || Math.abs(z) > ARENA - margin) return true;
  for (const b of boxes) {
    if (x > b.minX - margin && x < b.maxX + margin && z > b.minZ - margin && z < b.maxZ + margin) return true;
  }
  return false;
}

function pointInBox(x, z) {
  return boxes.some((b) => x > b.minX && x < b.maxX && z > b.minZ && z < b.maxZ);
}

// 2D segment vs AABB (slab test)
function segmentHitsBox(x0, z0, x1, z1, b) {
  let tmin = 0, tmax = 1;
  const dx = x1 - x0, dz = z1 - z0;
  for (const [o, d, lo, hi] of [[x0, dx, b.minX, b.maxX], [z0, dz, b.minZ, b.maxZ]]) {
    if (Math.abs(d) < 1e-9) {
      if (o < lo || o > hi) return false;
    } else {
      let t1 = (lo - o) / d, t2 = (hi - o) / d;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return false;
    }
  }
  return true;
}

// distance along a ray to where it enters a box, or null if it misses
function rayBox(sx, sz, dx, dz, b) {
  let tmin = 0, tmax = Infinity;
  for (const [o, d, lo, hi] of [[sx, dx, b.minX, b.maxX], [sz, dz, b.minZ, b.maxZ]]) {
    if (Math.abs(d) < 1e-9) {
      if (o < lo || o > hi) return null;
    } else {
      let t1 = (lo - o) / d, t2 = (hi - o) / d;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return null;
    }
  }
  return tmin;
}

function hasLineOfSight(a, b) {
  return !boxes.some((box) => segmentHitsBox(a.x, a.z, b.x, b.z, box));
}

// ---------- Bot navigation (A* on a coarse grid) ----------
const NAV_CELL = 2;
const NAV_N = (ARENA * 2) / NAV_CELL; // cells per side
const navBlocked = new Uint8Array(NAV_N * NAV_N);

// a cell is blocked if a big tank parked at its centre would touch cover
function buildNav() {
  for (let j = 0; j < NAV_N; j++) {
    for (let i = 0; i < NAV_N; i++) {
      navBlocked[j * NAV_N + i] = pointBlocked(-ARENA + (i + 0.5) * NAV_CELL, -ARENA + (j + 0.5) * NAV_CELL, 1.8) ? 1 : 0;
    }
  }
}
const navCell = (x, z) => {
  const i = clamp(Math.floor((x + ARENA) / NAV_CELL), 0, NAV_N - 1);
  const j = clamp(Math.floor((z + ARENA) / NAV_CELL), 0, NAV_N - 1);
  return j * NAV_N + i;
};
const cellX = (c) => -ARENA + ((c % NAV_N) + 0.5) * NAV_CELL;
const cellZ = (c) => -ARENA + (Math.floor(c / NAV_N) + 0.5) * NAV_CELL;

function nearestOpen(c) {
  if (!navBlocked[c]) return c;
  const ci = c % NAV_N, cj = Math.floor(c / NAV_N);
  for (let r = 1; r < 8; r++) {
    for (let dj = -r; dj <= r; dj++) {
      for (let di = -r; di <= r; di++) {
        if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
        const i = ci + di, j = cj + dj;
        if (i >= 0 && j >= 0 && i < NAV_N && j < NAV_N && !navBlocked[j * NAV_N + i]) return j * NAV_N + i;
      }
    }
  }
  return -1;
}

// true if a straight drive between two points stays on open cells
function navClear(x0, z0, x1, z1) {
  const n = Math.ceil(Math.hypot(x1 - x0, z1 - z0) / (NAV_CELL * 0.5));
  for (let k = 1; k <= n; k++) {
    if (navBlocked[navCell(x0 + ((x1 - x0) * k) / n, z0 + ((z1 - z0) * k) / n)]) return false;
  }
  return true;
}

const navG = new Float32Array(NAV_N * NAV_N);
const navFrom = new Int32Array(NAV_N * NAV_N);
const navClosed = new Uint8Array(NAV_N * NAV_N);
const NAV_DIRS = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];

// returns a short list of waypoints from (sx, sz) to (gx, gz), or null
function findPath(sx, sz, gx, gz) {
  const start = nearestOpen(navCell(sx, sz));
  const goal = nearestOpen(navCell(gx, gz));
  if (start < 0 || goal < 0) return null;
  navG.fill(Infinity);
  navClosed.fill(0);
  const gi = goal % NAV_N, gj = Math.floor(goal / NAV_N);
  const h = (c) => {
    const di = Math.abs((c % NAV_N) - gi), dj = Math.abs(Math.floor(c / NAV_N) - gj);
    return Math.max(di, dj) + (Math.SQRT2 - 1) * Math.min(di, dj);
  };
  // binary heap of [f, cell]
  const heap = [[h(start), start]];
  const push = (item) => {
    heap.push(item);
    let k = heap.length - 1;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (heap[p][0] <= heap[k][0]) break;
      [heap[p], heap[k]] = [heap[k], heap[p]];
      k = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let k = 0;
      for (;;) {
        const l = 2 * k + 1, r = l + 1;
        let m = k;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === k) break;
        [heap[m], heap[k]] = [heap[k], heap[m]];
        k = m;
      }
    }
    return top;
  };
  navG[start] = 0;
  navFrom[start] = -1;
  let found = false;
  while (heap.length) {
    const [, c] = pop();
    if (navClosed[c]) continue;
    if (c === goal) { found = true; break; }
    navClosed[c] = 1;
    const ci = c % NAV_N, cj = Math.floor(c / NAV_N);
    for (const [di, dj, cost] of NAV_DIRS) {
      const i = ci + di, j = cj + dj;
      if (i < 0 || j < 0 || i >= NAV_N || j >= NAV_N) continue;
      const n = j * NAV_N + i;
      if (navBlocked[n] || navClosed[n]) continue;
      // no cutting corners diagonally
      if (di && dj && (navBlocked[cj * NAV_N + i] || navBlocked[j * NAV_N + ci])) continue;
      const g = navG[c] + cost;
      if (g < navG[n]) {
        navG[n] = g;
        navFrom[n] = c;
        push([g + h(n), n]);
      }
    }
  }
  if (!found) return null;
  const cells = [];
  for (let c = goal; c !== -1; c = navFrom[c]) cells.push(c);
  cells.reverse();
  const pts = cells.map((c) => ({ x: cellX(c), z: cellZ(c) }));
  if (!navBlocked[navCell(gx, gz)]) pts[pts.length - 1] = { x: gx, z: gz };
  // string-pull: keep only the corners you can't drive straight past
  const out = [];
  let cx = sx, cz = sz, k = 0;
  while (k < pts.length) {
    let far = k;
    for (let m = pts.length - 1; m > k; m--) {
      if (navClear(cx, cz, pts[m].x, pts[m].z)) { far = m; break; }
    }
    out.push(pts[far]);
    cx = pts[far].x;
    cz = pts[far].z;
    k = far + 1;
  }
  return out;
}

// heading that follows a (periodically re-planned) path towards a goal
function navHeading(bot, gx, gz, dt) {
  bot.pathTimer -= dt;
  if (!bot.path || bot.pathTimer <= 0 || Math.hypot(gx - bot.pathGX, gz - bot.pathGZ) > 4) {
    bot.path = findPath(bot.pos.x, bot.pos.z, gx, gz) || [];
    bot.pathGX = gx;
    bot.pathGZ = gz;
    bot.pathTimer = 0.7 + Math.random() * 0.2;
  }
  while (bot.path.length > 1 && Math.hypot(bot.path[0].x - bot.pos.x, bot.path[0].z - bot.pos.z) < 2.5) bot.path.shift();
  const wp = bot.path[0] || { x: gx, z: gz };
  return Math.atan2(wp.x - bot.pos.x, wp.z - bot.pos.z);
}

// ---------- Sound (all generated with Web Audio, no files) ----------
const Sound = (() => {
  let ctx = null;
  let master, sfx, musicBus, noiseBuf, engineGain, engineFilter;
  const engineOsc = [];
  const flames = new Map();
  const listener = { x: 0, z: 0, rx: -1, rz: 0 };
  let muted = load('treadstorm-muted', '0') === '1';
  let nextNote = 0;
  let step = 0;
  let engineAlive = false, engineStamp = 0;

  function init() {
    if (ctx) {
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    // Made light for slow computers: a larger audio buffer (a stalled frame can't starve the sound card)
    // and a 24 kHz mix (half the audio processing; all the game's sounds are below 12 kHz anyway).
    try { ctx = new AC({ latencyHint: 0.08, sampleRate: 24000 }); } catch { try { ctx = new AC({ latencyHint: 'playback' }); } catch { ctx = new AC(); } }
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.8;
    master.connect(ctx.destination);
    // light compression keeps stacked explosions from clipping
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 10;
    comp.ratio.value = 4;
    comp.connect(master);
    sfx = ctx.createGain();
    sfx.gain.value = 0.9;
    sfx.connect(comp);
    musicBus = ctx.createGain();
    musicBus.gain.value = 0.2;
    musicBus.connect(comp);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    // engine: two detuned low oscillators through a lowpass
    engineFilter = ctx.createBiquadFilter();
    engineFilter.type = 'lowpass';
    engineFilter.frequency.value = 260;
    engineGain = ctx.createGain();
    engineGain.gain.value = 0;
    engineFilter.connect(engineGain).connect(sfx);
    for (const [type, mult] of [['sawtooth', 1], ['square', 0.5]]) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = 40 * mult;
      o.connect(engineFilter);
      o.start();
      engineOsc.push([o, mult]);
    }
    nextNote = ctx.currentTime + 0.1;
    setInterval(scheduleMusic, 25);
  }

  const live = () => ctx && ctx.state === 'running' && !muted;

  function env(param, t, dur, vol, attack) {
    param.setValueAtTime(0.0001, t);
    param.exponentialRampToValueAtTime(vol, t + attack);
    param.exponentialRampToValueAtTime(0.0001, t + dur);
  }
  // at most this many one-shot sounds at once: a crowded fight used to build hundreds of audio nodes
  let voices = 0;
  const MAX_VOICES = 24;
  const voiceDone = () => { voices--; };
  function noise(dest, t, dur, vol, type, f0, f1 = f0, q = 1, attack = 0.004) {
    const counted = dest !== musicBus; // the music is never dropped
    if (counted && voices >= MAX_VOICES) return;
    if (counted) voices++;
    const src = ctx.createBufferSource();
    if (counted) src.onended = voiceDone;
    src.buffer = noiseBuf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = ctx.createGain();
    env(g.gain, t, dur, vol, attack);
    src.connect(f).connect(g).connect(dest);
    src.start(t, Math.random() * 1.5);
    src.stop(t + dur + 0.05);
  }
  function tone(dest, t, dur, vol, type, f0, f1 = f0, attack = 0.004) {
    const counted = dest !== musicBus;
    if (counted && voices >= MAX_VOICES) return;
    if (counted) voices++;
    const o = ctx.createOscillator();
    if (counted) o.onended = voiceDone;
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = ctx.createGain();
    env(g.gain, t, dur, vol, attack);
    o.connect(g).connect(dest);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  // volume falls off with distance from the player; pan follows the camera's left/right
  function spatial(x, z) {
    const dx = x - listener.x, dz = z - listener.z;
    const d = Math.hypot(dx, dz);
    const v = Math.pow(clamp(1 - d / 85, 0, 1), 1.6);
    const p = d > 0.5 ? clamp((dx * listener.rx + dz * listener.rz) / d, -1, 1) * 0.75 : 0;
    return { v, p };
  }
  function out(x, z, vol = 1) {
    const g = ctx.createGain();
    if (x === undefined) {
      g.gain.value = vol;
      g.connect(sfx);
      return g;
    }
    const { v, p } = spatial(x, z);
    if (v * vol < 0.01) return null;
    g.gain.value = v * vol;
    const pan = ctx.createStereoPanner();
    pan.pan.value = p;
    g.connect(pan).connect(sfx);
    return g;
  }

  // a short loop: Am - F - C - G with drums and a soft pad
  const ROOTS = [55, 43.65, 65.41, 49];
  const CHORDS = [[110, 130.81, 164.81], [87.31, 110, 130.81], [130.81, 164.81, 196], [98, 123.47, 146.83]];
  const BASS_STEPS = [0, 3, 6, 8, 11, 14];
  function scheduleMusic() {
    if (!ctx || ctx.state !== 'running') return;
    const sd = 60 / 112 / 4;
    if (nextNote < ctx.currentTime) nextNote = ctx.currentTime + 0.05;
    while (nextNote < ctx.currentTime + 0.5) { // schedule half a second ahead, so a stalled frame never leaves a gap
      playStep(step, nextNote, sd);
      nextNote += sd;
      step = (step + 1) % 64;
    }
  }
  function playStep(s, t, sd) {
    const bar = Math.floor(s / 16), i = s % 16, m = musicBus;
    if (i === 0 || i === 8 || i === 10) tone(m, t, 0.28, 0.55, 'sine', 140, 42);
    if (i === 4 || i === 12) {
      noise(m, t, 0.14, 0.18, 'bandpass', 1900, 1500, 0.8);
      tone(m, t, 0.08, 0.1, 'triangle', 200, 140);
    }
    if (i % 2 === 1) noise(m, t, 0.04, i % 4 === 3 ? 0.06 : 0.035, 'highpass', 7500);
    if (BASS_STEPS.includes(i)) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = ROOTS[bar] * (i === 14 ? 2 : 1);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 420;
      const g = ctx.createGain();
      env(g.gain, t, sd * 1.7, 0.22, 0.01);
      o.connect(lp).connect(g).connect(m);
      o.start(t);
      o.stop(t + sd * 1.7 + 0.05);
    }
    if (i === 0) {
      const dur = sd * 16;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 900;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.035, t + 0.6);
      g.gain.setValueAtTime(0.035, t + dur - 0.4);
      g.gain.linearRampToValueAtTime(0.0001, t + dur);
      lp.connect(g).connect(m);
      for (const f of CHORDS[bar]) {
        for (const detune of [-6, 6]) {
          const o = ctx.createOscillator();
          o.type = 'sawtooth';
          o.frequency.value = f * 2;
          o.detune.value = detune;
          o.connect(lp);
          o.start(t);
          o.stop(t + dur + 0.05);
        }
      }
    }
  }

  return {
    init,
    get muted() { return muted; },
    toggleMute() {
      muted = !muted;
      save('treadstorm-muted', muted ? '1' : '0');
      if (ctx) master.gain.setTargetAtTime(muted ? 0 : 0.8, ctx.currentTime, 0.02);
      return muted;
    },
    pause() { if (ctx && ctx.state === 'running') ctx.suspend().catch(() => {}); },
    resume() { if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {}); },
    setListener(x, z, yaw) {
      listener.x = x;
      listener.z = z;
      listener.rx = -Math.cos(yaw);
      listener.rz = Math.sin(yaw);
    },
    engine(speed, alive, nitro) {
      if (!ctx) return;
      const t = ctx.currentTime;
      if (alive === engineAlive && t - engineStamp < 0.08) return;
      engineAlive = alive;
      engineStamp = t;
      const s = Math.abs(speed);
      const f = 34 + s * 3.2;
      for (const [o, mult] of engineOsc) o.frequency.setTargetAtTime(f * mult, t, 0.08);
      engineGain.gain.setTargetAtTime(alive ? 0.05 + Math.min(1, s / 12) * 0.06 : 0, t, 0.1);
      engineFilter.frequency.setTargetAtTime((nitro ? 420 : 260) + s * 10, t, 0.1);
    },
    shot(kind, x, z) {
      if (!live()) return;
      const d = out(x, z);
      if (!d) return;
      const t = ctx.currentTime;
      if (kind === 'cannon') {
        noise(d, t, 0.4, 0.8, 'lowpass', 3200, 260);
        tone(d, t, 0.32, 0.8, 'sine', 150, 42);
        noise(d, t, 0.07, 0.35, 'bandpass', 2200, 900, 1.2);
      } else if (kind === 'blaster') {
        tone(d, t, 0.09, 0.2, 'square', 880, 260);
        noise(d, t, 0.06, 0.16, 'bandpass', 3200, 1600, 1.5);
      } else if (kind === 'railgun') {
        noise(d, t, 0.45, 0.5, 'bandpass', 7000, 500, 0.9);
        tone(d, t, 0.38, 0.22, 'sawtooth', 2200, 70);
        tone(d, t, 0.4, 0.7, 'sine', 95, 38);
      } else if (kind === 'hammer') {
        // a heavy thump, a crack and a rattle of pellets
        noise(d, t, 0.5, 1.0, 'lowpass', 2400, 140, 0.8);
        tone(d, t, 0.36, 0.9, 'sine', 130, 34);
        noise(d, t, 0.09, 0.45, 'bandpass', 3000, 1100, 1.2);
        noise(d, t + 0.05, 0.22, 0.2, 'highpass', 4200, 1800);
      } else if (kind === 'ricochet') {
        // soft plasma "thoomp" with a rising zing
        tone(d, t, 0.16, 0.3, 'triangle', 320, 1300);
        tone(d, t, 0.12, 0.18, 'sine', 180, 70);
        noise(d, t, 0.08, 0.12, 'bandpass', 4200, 2000, 2);
      }
    },
    bounce(x, z) {
      if (!live()) return;
      const d = out(x, z, 0.6);
      if (!d) return;
      const t = ctx.currentTime;
      tone(d, t, 0.1, 0.16, 'sine', 1500, 2600);
      noise(d, t, 0.05, 0.1, 'highpass', 5000, 3000, 1);
    },
    railCharge(x, z, dur) {
      if (!live()) return;
      const d = out(x, z);
      if (!d) return;
      const t = ctx.currentTime;
      tone(d, t, dur, 0.12, 'sine', 220, 1500, 0.05);
      tone(d, t, dur, 0.06, 'triangle', 330, 2250, 0.05);
    },
    impact(x, z, metal, vol = 1) {
      if (!live()) return;
      const d = out(x, z, vol);
      if (!d) return;
      const t = ctx.currentTime;
      noise(d, t, 0.2, 0.45, 'bandpass', 2600, 600, 1);
      if (metal) tone(d, t, 0.14, 0.12, 'square', 760, 520);
    },
    explosion(x, z) {
      if (!live()) return;
      const d = out(x, z);
      if (!d) return;
      const t = ctx.currentTime;
      noise(d, t, 1.4, 1.0, 'lowpass', 1800, 70, 0.7, 0.01);
      tone(d, t, 0.9, 0.9, 'sine', 95, 28, 0.01);
      noise(d, t + 0.05, 2.0, 0.35, 'lowpass', 500, 60);
    },
    // distant thunder: a low rumble that arrives a moment after the flash
    thunder(delay) {
      if (!live()) return;
      const d = out();
      if (!d) return;
      const t = ctx.currentTime + delay;
      noise(d, t, 2.8, 0.55, 'lowpass', 420, 60, 0.7, 0.25);
      tone(d, t, 2.2, 0.5, 'sine', 62, 30, 0.2);
      noise(d, t + 0.5, 1.6, 0.3, 'lowpass', 260, 50, 0.7, 0.2);
    },
    thud(x, z) {
      if (!live()) return;
      const d = out(x, z, 0.6);
      if (d) tone(d, ctx.currentTime, 0.2, 0.4, 'sine', 120, 55);
    },
    // looping stream noise: a low roar for fire, a high hiss for ice
    flame(key, on, x, z, ice = false) {
      if (!ctx) return;
      let f = flames.get(key);
      if (on && !f) {
        const src = ctx.createBufferSource();
        src.buffer = noiseBuf;
        src.loop = true;
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = ice ? 2800 : 700;
        bp.Q.value = ice ? 0.9 : 0.6;
        const g = ctx.createGain();
        g.gain.value = 0;
        const pan = ctx.createStereoPanner();
        src.connect(bp).connect(g).connect(pan).connect(sfx);
        src.start();
        f = { src, g, pan };
        flames.set(key, f);
      }
      if (!f) return;
      const t = ctx.currentTime;
      if (on) {
        const { v, p } = spatial(x, z);
        f.g.gain.setTargetAtTime(0.4 * v, t, 0.04);
        f.pan.pan.setTargetAtTime(p, t, 0.04);
      } else {
        f.g.gain.setTargetAtTime(0, t, 0.05);
        f.src.stop(t + 0.3);
        flames.delete(key);
      }
    },
    stopFlames() {
      for (const key of [...flames.keys()]) this.flame(key, false);
    },
    hurt() {
      if (!live()) return;
      const t = ctx.currentTime;
      tone(sfx, t, 0.16, 0.22, 'square', 240, 120);
      noise(sfx, t, 0.12, 0.2, 'bandpass', 1200, 600);
    },
    pickup(x, z) {
      if (!live()) return;
      const d = out(x, z);
      if (!d) return;
      const t = ctx.currentTime;
      [660, 880, 1320].forEach((f, i) => tone(d, t + i * 0.07, 0.14, 0.22, 'triangle', f));
    },
    kill() {
      if (!live()) return;
      const t = ctx.currentTime;
      tone(sfx, t, 0.09, 0.16, 'sine', 1250);
      tone(sfx, t + 0.08, 0.14, 0.16, 'sine', 1660);
    },
    click() {
      if (!live()) return;
      tone(sfx, ctx.currentTime, 0.05, 0.12, 'sine', 900, 700);
    },
    upgrade() {
      if (!live()) return;
      const t = ctx.currentTime;
      [523, 784, 1047].forEach((f, i) => tone(sfx, t + i * 0.06, 0.18, 0.18, 'triangle', f));
    },
    victory() {
      if (!live()) return;
      const t = ctx.currentTime;
      [523, 659, 784, 1047].forEach((f, i) => tone(sfx, t + i * 0.12, 0.35, 0.2, 'triangle', f));
    },
    defeat() {
      if (!live()) return;
      const t = ctx.currentTime;
      [392, 330, 262, 196].forEach((f, i) => tone(sfx, t + i * 0.16, 0.4, 0.18, 'triangle', f));
    },
    // flag events: rising notes when it's good for your team, falling when it's bad
    flagEvent(good, big = false) {
      if (!live()) return;
      const t = ctx.currentTime;
      const notes = good ? (big ? [523, 659, 784, 1047] : [587, 880]) : [880, 698, 523];
      notes.forEach((f, i) => tone(sfx, t + i * 0.09, 0.2, 0.2, good ? 'triangle' : 'square', f));
    },
  };
})();

// ---------- Effects ----------
const particles = [];
const sparkGeo = new THREE.BoxGeometry(0.12, 0.12, 0.12);
const debrisGeo = new THREE.BoxGeometry(0.42, 0.26, 0.5);
const puffGeo = new THREE.IcosahedronGeometry(1, 0);
const flashGeo = new THREE.IcosahedronGeometry(1, 1);
const sparkMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.4, 1.2, 0.35) });

function addParticle(p) {
  if (particles.length >= MAX_PARTICLES) {
    if (p.ownMat) p.mat.dispose();
    return;
  }
  const mesh = new THREE.Mesh(p.geo, p.mat);
  mesh.position.set(p.x, p.y, p.z);
  mesh.scale.setScalar(p.s0);
  if (p.spin) mesh.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
  mesh.castShadow = !!p.shadow;
  scene.add(mesh);
  particles.push({
    mesh, mat: p.mat, ownMat: !!p.ownMat, vel: p.vel || new THREE.Vector3(),
    life: p.life, max: p.life, g: p.g || 0, drag: p.drag || 0, s0: p.s0, s1: p.s1 ?? p.s0,
    op0: p.op0 ?? 1, fade: !!p.fade, bounce: !!p.bounce, spin: p.spin || 0, collide: !!p.collide,
  });
}

function updateParticles(dt) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life -= dt;
    const m = p.mesh;
    if (p.life <= 0 || (p.collide && pointInBox(m.position.x, m.position.z))) {
      scene.remove(m);
      if (p.ownMat) p.mat.dispose();
      particles.splice(i, 1);
      continue;
    }
    const t = 1 - p.life / p.max;
    p.vel.y -= p.g * dt;
    if (p.drag) p.vel.multiplyScalar(Math.max(0, 1 - p.drag * dt));
    m.position.addScaledVector(p.vel, dt);
    if (p.bounce && m.position.y < 0.12) {
      m.position.y = 0.12;
      p.vel.y *= -0.35;
      p.vel.x *= 0.65;
      p.vel.z *= 0.65;
    }
    m.scale.setScalar(p.s0 + (p.s1 - p.s0) * t);
    if (p.fade) p.mat.opacity = p.op0 * (1 - t) * (1 - t);
    if (p.spin) {
      m.rotation.x += p.spin * dt;
      m.rotation.z += p.spin * 0.7 * dt;
    }
  }
}

function puff(x, y, z, color, opacity, s0, s1, life, vel) {
  addParticle({
    geo: puffGeo, x, y, z, s0, s1, life, vel, drag: 1.2, fade: true, op0: opacity, ownMat: true,
    mat: new THREE.MeshStandardMaterial({ color, transparent: true, opacity, depthWrite: false, roughness: 1, flatShading: true }),
  });
}

function fireball(x, y, z, s0, s1, life, color) {
  addParticle({
    geo: flashGeo, x, y, z, s0, s1, life, fade: true, op0: 1, ownMat: true,
    mat: new THREE.MeshBasicMaterial({ color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
  });
}

function sparks(x, y, z, count, speed, dir = null) {
  for (let i = 0; i < count; i++) {
    const v = new THREE.Vector3(rnd(-1, 1), rnd(0.2, 1.2), rnd(-1, 1)).normalize().multiplyScalar(speed * rnd(0.4, 1));
    if (dir) v.addScaledVector(dir, speed * 0.8);
    addParticle({ geo: sparkGeo, mat: sparkMat, x, y, z, vel: v, life: rnd(0.25, 0.55), g: 18, s0: 1, s1: 0, bounce: true });
  }
}

// railgun beams: a bright core plus a soft glow that both fade out
const beamGeo = new THREE.CylinderGeometry(1, 1, 1, 8, 1, true).rotateX(Math.PI / 2);
const beams = [];
function addBeam(x0, z0, x1, z1, y) {
  const len = Math.hypot(x1 - x0, z1 - z0);
  const yaw = Math.atan2(x1 - x0, z1 - z0);
  for (const [r, color, op] of [[0.07, new THREE.Color(1.4, 2.6, 3.0), 1], [0.32, new THREE.Color(0.25, 0.7, 1.0), 0.55]]) {
    const mesh = new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: op, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    mesh.position.set((x0 + x1) / 2, y, (z0 + z1) / 2);
    mesh.rotation.y = yaw;
    mesh.scale.set(r, r, len);
    scene.add(mesh);
    beams.push({ mesh, r, op, life: 0.4, max: 0.4 });
  }
}
function updateBeams(dt) {
  for (let i = beams.length - 1; i >= 0; i--) {
    const b = beams[i];
    b.life -= dt;
    if (b.life <= 0) {
      scene.remove(b.mesh);
      b.mesh.material.dispose();
      beams.splice(i, 1);
      continue;
    }
    const k = b.life / b.max;
    b.mesh.material.opacity = b.op * k;
    b.mesh.scale.x = b.mesh.scale.y = b.r * (0.4 + 0.6 * k);
  }
}

// a small fixed pool of point lights (a constant light count avoids shader recompiles)
const lightPool = Array.from({ length: 4 }, () => {
  const light = new THREE.PointLight(0xffaa55, 0, 24, 2);
  scene.add(light);
  return { light, life: 0, max: 1, peak: 0 };
});
let lightIndex = 0;
function flashLight(x, y, z, peak, dur, color = 0xffaa55) {
  const n = emberActive ? lightPool.length - 1 : lightPool.length; // the last one may be lighting a fire
  const e = lightPool[lightIndex++ % n];
  e.light.position.set(x, y, z);
  e.light.color.set(color);
  e.peak = peak;
  e.life = e.max = dur;
}
function updateLights(dt) {
  for (const e of lightPool) {
    e.life = Math.max(0, e.life - dt);
    const k = e.life / e.max;
    e.light.intensity = e.peak * k * k;
  }
}

const scorches = [];
const scorchGeo = new THREE.CircleGeometry(1, 24).rotateX(-Math.PI / 2);
function addScorch(x, z, r) {
  if (scorches.length >= 12) {
    const old = scorches.shift();
    scene.remove(old.mesh);
    old.mesh.material.dispose();
  }
  const mesh = new THREE.Mesh(scorchGeo, new THREE.MeshBasicMaterial({
    map: tex('scorch'), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -12,
  }));
  mesh.position.set(x, 0.03, z);
  mesh.scale.setScalar(r);
  mesh.rotation.y = Math.random() * 6;
  scene.add(mesh);
  scorches.push({ mesh, life: 18 });
}
function updateScorches(dt) {
  for (let i = scorches.length - 1; i >= 0; i--) {
    const s = scorches[i];
    s.life -= dt;
    s.mesh.material.opacity = clamp(s.life / 4, 0, 1);
    if (s.life <= 0) {
      scene.remove(s.mesh);
      s.mesh.material.dispose();
      scorches.splice(i, 1);
    }
  }
}

// ---------- Tanks ----------
const wheelMat = new THREE.MeshStandardMaterial({ color: 0x6a6e75, roughness: 0.45, metalness: 0.6, flatShading: true });
const hubMat = new THREE.MeshStandardMaterial({ color: 0x24262a, roughness: 0.5, metalness: 0.7, flatShading: true });
const tireMat = new THREE.MeshStandardMaterial({ color: 0x1c1d1f, roughness: 0.95, metalness: 0.05, flatShading: true });
const gunMat = new THREE.MeshStandardMaterial({ color: 0x2e3034, roughness: 0.42, metalness: 0.72, flatShading: true });
const fuelMat = new THREE.MeshStandardMaterial({ color: 0x8c2f22, roughness: 0.5, metalness: 0.5, flatShading: true });
const pilotMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(2, 0.9, 0.25) });
const glassMat = new THREE.MeshStandardMaterial({
  color: 0x0f2a33, emissive: 0x2fb6d6, emissiveIntensity: 0.6, roughness: 0.1, metalness: 0.4,
});
const lightMat = new THREE.MeshStandardMaterial({ color: 0xfff4d6, emissive: 0xfff1c4, emissiveIntensity: 1.4 });
const canvasMat = new THREE.MeshStandardMaterial({ color: 0x5f5a42, roughness: 1, flatShading: true });
const frostMat = new THREE.MeshStandardMaterial({
  color: 0xbfefff, emissive: 0x3fbfff, emissiveIntensity: 0.7, roughness: 0.25, metalness: 0.2, flatShading: true,
});

// Collects primitive parts by material role and merges each role into a single
// geometry, so a detailed tank is still only a handful of draw calls.
class PartSet {
  constructor() {
    this.parts = {};
  }

  add(role, geo, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
    if (rx || ry || rz) geo.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx, ry, rz)));
    geo.translate(x, y, z);
    (this.parts[role] ||= []).push(geo);
    return this;
  }

  box(role, w, h, d, x, y, z, rx, ry, rz) {
    return this.add(role, new THREE.BoxGeometry(w, h, d), x, y, z, rx, ry, rz);
  }

  // a cylinder lying along 'x', 'y' or 'z' (the first radius is the +axis end)
  cyl(role, r1, r2, len, seg, axis, x, y, z) {
    const g = new THREE.CylinderGeometry(r1, r2, len, seg);
    if (axis === 'x') g.rotateZ(-Math.PI / 2);
    else if (axis === 'z') g.rotateX(Math.PI / 2);
    return this.add(role, g, x, y, z);
  }

  sphere(role, r, x, y, z) {
    return this.add(role, new THREE.SphereGeometry(r, 10, 6), x, y, z);
  }

  merge() {
    const out = {};
    for (const [role, geos] of Object.entries(this.parts)) {
      out[role] = mergeGeometries(geos, false);
      for (const g of geos) g.dispose();
    }
    return out;
  }
}

function addParts(geos, mats, parent) {
  for (const [role, geo] of Object.entries(geos)) {
    const m = new THREE.Mesh(geo, mats[role]);
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
  }
}

// one geometry with a material group per piece (for parts that spin as a unit)
function groupedGeometry(pieces) {
  return mergeGeometries(pieces, true);
}
// road wheel: rubber tyre, steel rim, dark hub (axis along x)
const roadWheelGeo = groupedGeometry([
  new THREE.CylinderGeometry(0.27, 0.27, 0.44, 14).rotateZ(-Math.PI / 2),
  new THREE.CylinderGeometry(0.19, 0.19, 0.48, 14).rotateZ(-Math.PI / 2),
  new THREE.CylinderGeometry(0.07, 0.07, 0.54, 8).rotateZ(-Math.PI / 2),
]);
const roadWheelMats = [tireMat, wheelMat, hubMat];
// drive sprocket / idler: a disc with a ring of bolts, so its turning is visible
const sprocketGeo = groupedGeometry([
  new THREE.CylinderGeometry(0.25, 0.25, 0.64, 14).rotateZ(-Math.PI / 2),
  mergeGeometries(Array.from({ length: 6 }, (_, i) => {
    const a = (i / 6) * Math.PI * 2;
    return new THREE.CylinderGeometry(0.035, 0.035, 0.7, 6).rotateZ(-Math.PI / 2).translate(0, Math.sin(a) * 0.15, Math.cos(a) * 0.15);
  })),
]);
const sprocketMats = [wheelMat, hubMat];
const barGeoBg = new THREE.PlaneGeometry(2.6, 0.26);
const barGeoFg = new THREE.PlaneGeometry(2.5, 0.16).translate(1.25, 0, 0); // scales from its left edge
const barBgMat = new THREE.MeshBasicMaterial({ color: 0x0d1117, transparent: true, opacity: 0.8, depthWrite: false });
const auraGeo = new THREE.RingGeometry(2.0, 2.45, 40).rotateX(-Math.PI / 2);
const WHITE = new THREE.Color(1, 1, 1);
// Geometry is built once per hull / turret / gun and shared by every tank;
// each tank only brings its own materials (paint colour, track texture...).
const geoCache = {};

// ----- hulls (built at Warden size; the hull group is scaled by its dims) -----
function hullGeometry(hull) {
  const key = `hull:${hull.id}`;
  if (geoCache[key]) return geoCache[key];
  const P = new PartSet();
  const id = hull.id;

  // lower hull between the tracks, with an angled lower front plate
  P.box('dark', 1.9, 0.5, 3.2, 0, 0.55, 0);
  P.box('dark', 1.9, 0.44, 0.14, 0, 0.5, 1.66, -0.55);
  P.box('dark', 2.1, 0.5, 0.12, 0, 0.62, -1.62); // rear plate
  // upper hull that overhangs the tracks as fenders, and the sloped glacis
  P.box('paint', 2.66, 0.28, 2.75, 0, 0.94, -0.18);
  P.box('paint', 2.5, 0.12, 1.08, 0, 0.88, 1.43, 0.46);
  for (const s of [-1, 1]) P.box('accent', 0.08, 0.07, 2.7, s * 1.32, 1.06, -0.18); // edge stripe
  // engine deck: a dark recess with slats over it
  P.box('dark', 1.45, 0.04, 0.95, 0, 1.08, -1.1);
  for (let i = 0; i < 6; i++) P.box('gun', 1.3, 0.05, 0.07, 0, 1.11, -0.75 - i * 0.14);
  // exhausts, headlights with guards, tow hooks
  for (const s of [-1, 1]) {
    P.cyl('gun', 0.1, 0.1, 0.3, 10, 'z', s * 0.62, 0.86, -1.75);
    P.cyl('dark', 0.06, 0.06, 0.32, 8, 'z', s * 0.62, 0.86, -1.76);
    P.box('light', 0.18, 0.1, 0.05, s * 1.12, 0.98, 1.22);
    P.box('gun', 0.24, 0.04, 0.12, s * 1.12, 1.05, 1.2);
    P.box('gun', 0.12, 0.12, 0.14, s * 0.62, 0.38, 1.86);
  }

  // tracks: top and bottom belt runs wrapped around front and rear arcs
  for (const s of [-1, 1]) {
    const x = s * 1.25;
    P.box('track', 0.6, 0.09, 3.0, x, 0.695, 0);
    P.box('track', 0.6, 0.09, 3.0, x, 0.045, 0);
    P.cyl('track', 0.37, 0.37, 0.6, 16, 'x', x, 0.37, 1.5);
    P.cyl('track', 0.37, 0.37, 0.6, 16, 'x', x, 0.37, -1.5);
    for (const z of [-0.6, 0.6]) P.cyl('gun', 0.08, 0.08, 0.5, 8, 'x', x, 0.6, z); // return rollers
    P.box('dark', 0.62, 0.32, 0.05, x, 0.55, -1.93); // mudflap
  }

  if (id === 'scout') {
    // light bar across the glacis, side vents and rear fins
    P.box('light', 1.3, 0.06, 0.05, 0, 1.12, 1.16, 0.46);
    for (const s of [-1, 1]) {
      for (let i = 0; i < 3; i++) P.box('dark', 0.03, 0.12, 0.3, s * 1.34, 0.94, -0.2 - i * 0.4);
      P.box('dark', 0.08, 0.34, 0.6, s * 0.9, 1.25, -1.35);
      P.box('accent', 0.1, 0.06, 0.62, s * 0.9, 1.43, -1.37);
    }
  } else {
    // segmented side skirts over the top of the wheels
    const heavy = id === 'bastion';
    for (const s of [-1, 1]) {
      for (let k = 0; k < 4; k++) {
        const z = -1.2 + k * 0.8;
        P.box(heavy ? 'dark' : 'paint', heavy ? 0.12 : 0.07, heavy ? 0.48 : 0.34, 0.76, s * 1.6, heavy ? 0.52 : 0.6, z);
        if (heavy) {
          for (const dz of [-0.26, 0, 0.26]) P.cyl('gun', 0.035, 0.035, 0.06, 6, 'x', s * 1.67, 0.66, z + dz); // studs
        }
      }
    }
    if (heavy) {
      // reactive armour bricks following the glacis slope, a bumper and tall exhaust stacks
      for (let r = 0; r < 2; r++) {
        for (let c = 0; c < 4; c++) {
          const along = -0.25 + r * 0.42;
          P.box('dark', 0.5, 0.1, 0.36, -0.84 + c * 0.56, 0.979 - along * Math.sin(0.46), 1.479 + along * Math.cos(0.46), 0.46);
        }
      }
      P.box('gun', 2.3, 0.3, 0.22, 0, 0.42, 1.98);
      for (const s of [-1, 1]) {
        P.cyl('gun', 0.1, 0.1, 0.85, 10, 'y', s * 0.75, 1.45, -1.45);
        P.cyl('dark', 0.13, 0.13, 0.08, 10, 'y', s * 0.75, 1.88, -1.45);
      }
    } else {
      // toolboxes on the fenders and spare track links on the glacis
      for (const s of [-1, 1]) P.box('dark', 0.38, 0.16, 0.8, s * 1.05, 1.16, -0.3);
      for (let i = 0; i < 3; i++) P.box('track', 0.6, 0.06, 0.2, -0.65 + i * 0.65, 1.05, 1.29, 0.46);
    }
  }

  const n = hull.dims.wheels;
  const span = 2.5;
  geoCache[key] = {
    parts: P.merge(),
    wheels: Array.from({ length: n }, (_, i) => -span / 2 + (i * span) / (n - 1)),
  };
  return geoCache[key];
}

function buildHullModel(tank, hull) {
  // an imported model, when one has loaded for this hull (it has no spinning wheels)
  if (hullModels[hull.id]) return { group: hullModels[hull.id].root.clone(true), wheels: [] };
  const { L, W, H } = hull.dims;
  const geo = hullGeometry(hull);
  const g = new THREE.Group();
  addParts(geo.parts, tank.mats, g);
  const spinners = [];
  const spinner = (geom, mats, x, y, z) => {
    const m = new THREE.Mesh(geom, mats);
    m.position.set(x, y, z);
    m.receiveShadow = true; // their shadow would be hidden under the tracks anyway
    g.add(m);
    spinners.push(m);
  };
  for (const s of [-1, 1]) {
    for (const z of geo.wheels) spinner(roadWheelGeo, roadWheelMats, s * 1.25, 0.36, z);
    for (const z of [1.5, -1.5]) spinner(sprocketGeo, sprocketMats, s * 1.25, 0.37, z);
  }
  g.scale.set(W, H, L);
  return { group: g, wheels: spinners };
}

// ----- imported hull models (optional .glb files in the models folder) -----
// If a file is missing or fails to load, that hull keeps its built-in model.
// turnY: extra rotation (radians) if the model faces the wrong way (Math.PI = turn around).
// turretY: height to mount the turret at, or null to sit it on top of the model.
// Hull models: to give a hull a model, put the file in public/models/ and add a line here, e.g.
//   bastion: { url: `${import.meta.env.BASE_URL}models/bastion.glb`, turnY: 0, turretY: null },
// (no hull has a file yet, so nothing is requested: a missing file would be a 404 in the browser console)
const HULL_MODEL_FILES = {};
const hullModels = {}; // id -> { root, turretY }

// scale the model to the built-in hull's footprint, centre it and stand it on the ground
function fitHullModel(id, scene) {
  const cfg = HULL_MODEL_FILES[id];
  const { L, W } = HULLS[id].dims;
  const root = new THREE.Group();
  scene.rotation.y = cfg.turnY;
  root.add(scene);
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(scene);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const s = Math.min((3.74 * L) / size.z, (3.3 * W) / size.x); // track length, width over the skirts
  scene.position.set(-center.x, -box.min.y, -center.z);
  root.scale.setScalar(s);
  root.traverse((o) => {
    if (o.isMesh) o.castShadow = o.receiveShadow = true;
  });
  hullModels[id] = { root, turretY: cfg.turretY ?? size.y * s };
}

function loadModels() {
  const draco = new DRACOLoader().setDecoderPath(`${import.meta.env.BASE_URL}draco/`);
  const loader = new GLTFLoader().setDRACOLoader(draco).setMeshoptDecoder(MeshoptDecoder);
  for (const [id, cfg] of Object.entries(HULL_MODEL_FILES)) {
    loader.load(cfg.url, (gltf) => {
      fitHullModel(id, gltf.scene);
      // swap the new model onto every tank already using this hull
      for (const t of [player, ...botPool]) if (t.hullId === id) t.setHull(id, t.hullLevels);
    }, undefined, () => { /* no file yet: keep the built-in hull */ });
  }
  for (const w of Object.values(WEAPONS)) {
    if (!w.model) continue;
    loader.load(w.model.url, (gltf) => {
      fitWeaponModel(w.id, gltf.scene);
      for (const t of [player, ...botPool]) if (t.weaponId === w.id) t.refreshWeaponModel();
    }, undefined, () => { /* no file: keep the built-in gun */ });
  }
}

// ----- turret body (shared by every tank) -----
function turretGeometry() {
  if (geoCache.turret) return geoCache.turret;
  const P = new PartSet();
  P.cyl('gun', 0.95, 1.05, 0.18, 18, 'y', 0, 0.09, 0); // turret ring
  P.box('paint', 1.62, 0.5, 1.55, 0, 0.44, -0.35); // main body
  // angled cheeks give the front an arrow shape
  for (const s of [-1, 1]) P.box('paint', 0.86, 0.48, 0.72, s * 0.42, 0.43, 0.45, 0, -s * 0.5, 0);
  P.box('dark', 1.5, 0.05, 1.45, 0, 0.71, -0.35); // roof plate
  for (const s of [-1, 1]) P.box('dark', 0.06, 0.38, 1.3, s * 0.84, 0.42, -0.4); // add-on side armour
  P.box('dark', 0.7, 0.42, 0.34, 0, 0.44, 0.92); // mantlet
  // commander's cupola with a ring of periscopes
  P.cyl('dark', 0.3, 0.32, 0.18, 14, 'y', -0.42, 0.8, -0.55);
  P.cyl('paint', 0.25, 0.25, 0.05, 14, 'y', -0.42, 0.92, -0.55);
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2;
    P.box('glass', 0.09, 0.07, 0.04, -0.42 + Math.sin(a) * 0.31, 0.84, -0.55 + Math.cos(a) * 0.31, 0, a, 0);
  }
  // gunner's sight
  P.box('gun', 0.26, 0.22, 0.34, 0.45, 0.82, 0.05);
  P.box('glass', 0.2, 0.12, 0.02, 0.45, 0.84, 0.23);
  // smoke grenade launchers on both cheeks
  for (const s of [-1, 1]) {
    for (let k = 0; k < 3; k++) P.cyl('gun', 0.045, 0.045, 0.22, 8, 'z', s * 0.74, 0.5 + k * 0.1, 0.42);
  }
  // stowage rack at the back with a box and a rolled tarp
  for (const y of [0.45, 0.75]) P.box('gun', 1.5, 0.04, 0.04, 0, y, -1.45);
  for (const x of [-0.72, -0.24, 0.24, 0.72]) P.box('gun', 0.04, 0.34, 0.04, x, 0.6, -1.45);
  for (const s of [-1, 1]) P.box('gun', 0.04, 0.04, 0.36, s * 0.72, 0.75, -1.28);
  P.box('dark', 0.6, 0.26, 0.3, -0.35, 0.58, -1.27);
  P.cyl('canvas', 0.13, 0.13, 0.66, 10, 'x', 0.35, 0.6, -1.27);
  // antenna
  P.cyl('gun', 0.015, 0.02, 1.0, 5, 'y', 0.66, 1.2, -1.15);
  P.sphere('gun', 0.045, 0.66, 1.7, -1.15);
  geoCache.turret = P.merge();
  return geoCache.turret;
}

// ----- guns (each weapon has its own look) -----
function weaponGeometry(id) {
  const key = `gun:${id}`;
  if (geoCache[key]) return geoCache[key];
  const P = new PartSet();
  if (id === 'cannon') {
    P.cyl('gun', 0.2, 0.22, 0.55, 14, 'z', 0, 0, 0.28); // collar
    P.cyl('gun', 0.12, 0.14, 2.35, 14, 'z', 0, 0, 1.4); // barrel
    P.cyl('dark', 0.17, 0.17, 0.42, 14, 'z', 0, 0, 1.25); // fume extractor
    for (const z of [0.75, 1.9]) P.cyl('gun', 0.15, 0.15, 0.06, 14, 'z', 0, 0, z); // thermal sleeve bands
    P.box('gun', 0.36, 0.24, 0.42, 0, 0, 2.36); // muzzle brake
    for (const s of [-1, 1]) for (const z of [2.29, 2.43]) P.box('dark', 0.03, 0.16, 0.1, s * 0.185, 0, z);
  } else if (id === 'blaster') {
    P.box('dark', 0.86, 0.4, 0.66, 0, 0, 0.26);
    for (let i = 0; i < 4; i++) P.box('gun', 0.8, 0.04, 0.06, 0, 0.22, 0.05 + i * 0.14); // cooling fins
    for (const s of [-1, 1]) {
      P.cyl('gun', 0.075, 0.09, 1.8, 10, 'z', s * 0.22, 0, 1.15);
      for (let k = 0; k < 3; k++) P.cyl('dark', 0.11, 0.11, 0.07, 10, 'z', s * 0.22, 0, 0.75 + k * 0.35);
      P.cyl('gun', 0.12, 0.1, 0.2, 10, 'z', s * 0.22, 0, 1.97);
    }
    P.cyl('paint', 0.24, 0.24, 0.26, 16, 'x', -0.58, -0.02, 0.2); // ammo drum
    P.box('dark', 0.16, 0.12, 0.3, -0.45, 0.1, 0.35); // feed chute
  } else if (id === 'flamer') {
    P.box('dark', 0.64, 0.46, 0.7, 0, 0, 0.3);
    P.cyl('gun', 0.3, 0.2, 1.0, 14, 'z', 0, 0, 1.1); // flared nozzle
    for (let k = 0; k < 3; k++) {
      const z = 0.75 + k * 0.3;
      const r = 0.2 + ((z - 0.6) / 1.0) * 0.1 + 0.03;
      P.cyl('dark', r, r, 0.06, 14, 'z', 0, 0, z); // ribs
    }
    P.cyl('gun', 0.34, 0.34, 0.12, 14, 'z', 0, 0, 1.58);
    P.box('paint', 0.5, 0.05, 0.7, 0, 0.32, 1.1); // heat shield
    P.sphere('pilot', 0.06, 0, -0.2, 1.66);
    for (const s of [-1, 1]) {
      const x = s * 1.06;
      P.cyl('fuel', 0.19, 0.19, 1.1, 16, 'z', x, 0.05, -1.2); // fuel tanks with domed ends and straps
      P.sphere('fuel', 0.19, x, 0.05, -0.65);
      P.sphere('fuel', 0.19, x, 0.05, -1.75);
      for (const z of [-1.5, -0.9]) P.cyl('gun', 0.205, 0.205, 0.06, 16, 'z', x, 0.05, z);
      P.cyl('dark', 0.04, 0.04, 0.9, 6, 'z', s * 0.78, 0, -0.2); // fuel hose
    }
  } else if (id === 'railgun') {
    P.box('dark', 0.6, 0.4, 0.75, 0, 0, 0.3);
    P.cyl('gun', 0.09, 0.11, 3.0, 10, 'z', 0, 0, 1.6);
    for (const s of [-1, 1]) {
      P.box('paint', 0.07, 0.36, 2.75, s * 0.18, 0, 1.72); // rails
      P.box('dark', 0.22, 0.32, 0.6, s * 0.5, 0, 0.2); // capacitor packs
      P.box('coil', 0.03, 0.22, 0.5, s * 0.615, 0, 0.2); // ...with glowing strips
      P.cyl('gun', 0.03, 0.03, 1.2, 6, 'z', s * 0.3, 0.17, 0.8); // power conduits
    }
    for (const z of [0.8, 1.4, 2.0, 2.6]) P.cyl('coil', 0.22, 0.22, 0.09, 14, 'z', 0, 0, z);
  } else if (id === 'freezer') {
    // built-in stand-in, used only if models/freezer.glb can't be loaded
    P.box('dark', 0.64, 0.46, 0.7, 0, 0, 0.3);
    P.cyl('gun', 0.26, 0.2, 1.1, 14, 'z', 0, 0, 1.15);
    for (let k = 0; k < 3; k++) P.cyl('frost', 0.27, 0.27, 0.07, 14, 'z', 0, 0, 0.8 + k * 0.3);
    P.cyl('frost', 0.3, 0.3, 0.1, 14, 'z', 0, 0, 1.68);
    for (const s of [-1, 1]) {
      P.cyl('frost', 0.18, 0.18, 1.0, 16, 'z', s * 1.06, 0.05, -1.2);
      for (const z of [-1.55, -0.85]) P.cyl('gun', 0.195, 0.195, 0.06, 16, 'z', s * 1.06, 0.05, z);
    }
  } else if (id === 'ricochet') {
    // built-in stand-in, used only if models/ricochet.glb can't be loaded
    P.box('dark', 0.7, 0.42, 0.7, 0, 0, 0.3);
    P.cyl('gun', 0.2, 0.2, 1.5, 14, 'z', 0, 0, 1.2);
    for (const z of [0.7, 1.1, 1.5]) P.cyl('coil', 0.23, 0.23, 0.07, 14, 'z', 0, 0, z);
    P.cyl('gun', 0.26, 0.22, 0.2, 14, 'z', 0, 0, 1.95);
  }
  geoCache[key] = P.merge();
  return geoCache[key];
}

// imported whole-turret models, keyed by weapon id, once their file has loaded
const weaponModels = {};

const weaponPaint = {}; // id -> the model's own material (kept for textured models)

function fitWeaponModel(id, scene) {
  const { scale, pivotZ } = WEAPONS[id].model;
  if (WEAPONS[id].model.keepTexture) {
    scene.traverse((o) => {
      if (o.isMesh && !weaponPaint[id]) weaponPaint[id] = o.material;
    });
  }
  // put the centre of the ring base on the turret's pivot
  scene.scale.setScalar(scale);
  scene.position.set(0, 0, -pivotZ * scale);
  const root = new THREE.Group();
  root.add(scene);
  root.traverse((o) => {
    if (o.isMesh) o.castShadow = o.receiveShadow = true;
  });
  weaponModels[id] = root;
}

function buildWeaponModel(tank, id) {
  const g = new THREE.Group();
  if (weaponModels[id]) {
    const model = weaponModels[id].clone(true);
    let paint = tank.modelMat; // team-coloured, like the other imported turrets
    if (WEAPONS[id].model.keepTexture && weaponPaint[id]) {
      // a model with its own paint: one copy of its material per tank, lightly tinted in the tank's colour
      paint = tank.texMats[id];
      if (!paint) {
        paint = weaponPaint[id].clone();
        paint.emissiveMap = null; // so the hit / ice / fire glow works like on the other turrets
        paint.emissive.setRGB(0, 0, 0);
        paint.userData.boost = WEAPONS[id].model.boost ?? 4; // the model's paint is dark, so the team colour is brightened to show
        paint.color.copy(tank.color).multiplyScalar(paint.userData.boost);
        tank.texMats[id] = paint;
      }
    }
    model.traverse((o) => {
      if (o.isMesh) o.material = paint;
    });
    g.add(model);
    g.userData.wholeTurret = true;
    return g;
  }
  g.position.set(0, 0.45, 1.15);
  addParts(weaponGeometry(id), tank.mats, g);
  return g;
}

class Tank {
  constructor(isPlayer, color, name, hullId, weaponId, levels = null) {
    this.isPlayer = isPlayer;
    this.remote = null; // set on the server while a person on the network drives this tank
    this.name = name;
    this.kills = 0;
    this.deaths = 0;
    this.color = new THREE.Color(color);
    this.colorCss = `#${this.color.getHexString()}`;
    // painted armour uses the panel texture so every plate gets a seam around it
    const panel = tex('panel');
    this.paint = new THREE.MeshStandardMaterial({ map: panel, color, roughness: 0.5, metalness: 0.3, flatShading: true });
    this.paintDark = new THREE.MeshStandardMaterial({
      map: panel, color: this.color.clone().multiplyScalar(0.5), roughness: 0.6, metalness: 0.3, flatShading: true,
    });
    this.accentMat = new THREE.MeshStandardMaterial({
      color: this.color.clone().lerp(WHITE, 0.45), roughness: 0.4, metalness: 0.3, flatShading: true,
    });
    // each tank scrolls its own copy of the tread texture as it drives
    this.trackTex = tex('tread').clone();
    this.trackTex.repeat.set(1, 6);
    this.trackTex.needsUpdate = true;
    this.trackMat = new THREE.MeshStandardMaterial({ map: this.trackTex, roughness: 0.9, metalness: 0.2 });
    this.coilMat = new THREE.MeshStandardMaterial({
      color: 0x18242c, emissive: 0x2fc4ff, emissiveIntensity: 0.3, roughness: 0.4, metalness: 0.6,
    });
    // imported turret models are painted in the tank's (team) colour like the other turrets
    this.modelMat = new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.3 });
    this.texMats = {}; // imported turrets that keep their own paint (see WEAPONS[...].model.keepTexture)
    this.mats = {
      paint: this.paint, dark: this.paintDark, accent: this.accentMat, track: this.trackMat, coil: this.coilMat,
      gun: gunMat, light: lightMat, glass: glassMat, canvas: canvasMat, fuel: fuelMat, pilot: pilotMat, frost: frostMat,
    };
    this.freeze = 0; // 0..1, from enemy Freezers
    this.freezeHold = 0; // seconds since last frozen
    this.burnTime = 0; // seconds of burning left, from enemy Flamers
    this.burnDps = 0;
    this.burnBy = null;
    this.burnFx = 0;
    // HDR colour so the tracer glows through the bloom pass
    this.tracerMat = new THREE.MeshBasicMaterial({ color: this.color.clone().lerp(WHITE, 0.55).multiplyScalar(2.2) });
    // ricochet plasma: a white-hot core inside a soft additive halo, both in team colour
    this.plasmaMat = new THREE.MeshBasicMaterial({ color: this.color.clone().lerp(WHITE, 0.35).multiplyScalar(1.5) });
    this.plasmaGlowMat = new THREE.MeshBasicMaterial({
      color: this.color.clone().multiplyScalar(0.9), transparent: true, opacity: 0.4,
      depthWrite: false, blending: THREE.AdditiveBlending,
    });

    this.group = new THREE.Group();

    // turret (its height is set by the hull)
    this.turret = new THREE.Group();
    this.group.add(this.turret);
    // the standard turret body; hidden when a weapon brings a whole turret of its own
    this.turretBody = new THREE.Group();
    this.turret.add(this.turretBody);
    addParts(turretGeometry(), this.mats, this.turretBody);

    // glowing ring under the tank while a bonus is active
    this.aura = new THREE.Mesh(auraGeo, new THREE.MeshBasicMaterial({
      transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    this.aura.position.y = 0.06;
    this.aura.visible = false;
    this.group.add(this.aura);

    scene.add(this.group);

    if (!isPlayer) {
      this.bar = new THREE.Group();
      // both parts are transparent and drawn in a fixed order, so the
      // background can never be blended over the fill
      this.barFg = new THREE.Mesh(barGeoFg, new THREE.MeshBasicMaterial({ color: 0x4cd964, transparent: true, depthWrite: false }));
      this.barFg.position.set(-1.25, 0, 0.01);
      this.barFg.renderOrder = 2;
      const barBg = new THREE.Mesh(barGeoBg, barBgMat);
      barBg.renderOrder = 1;
      this.bar.add(barBg, this.barFg);
      scene.add(this.bar);
      this.tagCanvas = document.createElement('canvas');
      this.tagCanvas.width = 256;
      this.tagCanvas.height = 64;
      this.tagTex = new THREE.CanvasTexture(this.tagCanvas);
      this.tagTex.colorSpace = THREE.SRGBColorSpace;
      this.tag = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.tagTex, transparent: true, depthWrite: false }));
      this.tag.scale.set(3.2, 0.8, 1);
      scene.add(this.tag);
      this.drawTag();
    }

    this.heading = 0; // hull yaw; forward = (sin, cos)
    this.turretYaw = 0; // world-space turret yaw
    this.turretHold = 0;
    this.speed = 0;
    this.alive = true;
    this.respawn = 0;
    this.flash = 0;
    this.wheelSpin = 0;
    this.dustTimer = 0;
    this.killedBy = null;
    this.buffs = { armor: 0, damage: 0, nitro: 0 };
    // bot AI state
    this.avoidSide = Math.random() < 0.5 ? -1 : 1;
    this.avoidTimer = 0;
    this.avoidHeading = 0;
    this.unstick = 0;
    this.stuckTimer = 1;
    this.lastX = 0;
    this.lastZ = 0;
    this.wanderTimer = 0;
    this.wanderHeading = 0;
    this.target = null;
    this.retargetTimer = 0;

    this.setHull(hullId, levels?.[hullId]);
    this.hp = this.maxHp;
    this.setWeapon(weaponId, levels?.[weaponId]);
  }

  get pos() { return this.group.position; }

  // swap the hull model and stats; `lv` = garage upgrade levels
  setHull(id, lv) {
    // geometry is shared through geoCache, so it is only detached here, never disposed
    if (this.hullGroup) this.group.remove(this.hullGroup);
    this.hullId = id;
    this.hullLevels = lv;
    this.hull = hullStats(id, lv);
    this.maxHp = this.hull.hp;
    this.radius = this.hull.radius;
    this.mass = this.hull.mass;
    const model = buildHullModel(this, this.hull);
    this.hullGroup = model.group;
    this.wheels = model.wheels;
    this.group.add(this.hullGroup);
    this.turretY = hullModels[id] ? hullModels[id].turretY : 1.16 * this.hull.dims.H;
    this.turret.position.y = this.turretY;
    this.updateMuzzle();
    this.aura.scale.setScalar(this.radius / 1.7);
  }

  // any human at the controls (you, or a person connected to a game server) as opposed to the AI
  get human() { return this.isPlayer || !!this.remote; }

  // height the shots / stream leave the barrel at
  updateMuzzle() {
    this.muzzleY = this.turretY + (this.weapon?.muzzleHeight ?? 0.45);
  }

  // swap in the gun model again (e.g. once its file has loaded) without touching reload / fuel
  refreshWeaponModel() {
    this.turret.remove(this.weaponGroup);
    this.weaponGroup = buildWeaponModel(this, this.weaponId);
    this.turret.add(this.weaponGroup);
    this.applyWeaponModel();
  }

  applyWeaponModel() {
    const whole = !!this.weaponGroup.userData.wholeTurret;
    this.turretBody.visible = !whole;
    this.weaponBaseZ = whole ? 0 : 1.15;
    this.weaponGroup.position.z = this.weaponBaseZ;
  }

  setWeapon(id, lv) {
    if (this.weaponGroup) this.turret.remove(this.weaponGroup);
    if (this.flaming) Sound.flame(this, false);
    this.weaponId = id;
    this.weapon = weaponStats(id, lv);
    this.weaponGroup = buildWeaponModel(this, id);
    this.turret.add(this.weaponGroup);
    this.applyWeaponModel();
    this.updateMuzzle();
    this.resetWeapon();
  }

  resetWeapon() {
    const w = this.weapon;
    // bots start with a random delay so their first volleys don't line up
    this.reload = this.human || w.kind === 'flame' ? 0 : rnd(0.5, 1) * (w.botReload || 1);
    this.fuel = 100;
    this.overheat = false;
    this.charge = 0;
    this.flaming = false;
    this.flameTimer = 0;
    this.flameLight = 0;
    this.barrelIndex = 0;
    this.recoil = 0;
  }

  drawTag() {
    const g = this.tagCanvas.getContext('2d');
    const label = this.name.toUpperCase();
    g.clearRect(0, 0, 256, 64);
    g.font = '700 34px "Chakra Petch", system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineWidth = 7;
    g.strokeStyle = 'rgba(8,12,18,0.85)';
    g.strokeText(label, 128, 34);
    g.fillStyle = `#${this.color.clone().lerp(WHITE, 0.35).getHexString()}`;
    g.fillText(label, 128, 34);
    this.tagTex.needsUpdate = true;
  }

  setVisible(v) {
    this.group.visible = v;
    if (this.bar) {
      this.bar.visible = v;
      this.tag.visible = v;
    }
  }

  spawnAt(x, z) {
    this.pos.set(x, 0, z);
    this.heading = Math.atan2(-x, -z); // face the arena centre
    this.turretYaw = this.heading;
    this.turretHold = 0;
    this.speed = 0;
    this.hp = this.maxHp;
    this.alive = true;
    this.flash = 0;
    this.buffs.armor = this.buffs.damage = this.buffs.nitro = 0;
    this.freeze = 0;
    this.burnTime = 0;
    this.unstick = 0;
    this.avoidTimer = 0;
    this.target = null;
    this.retargetTimer = 0;
    this.lastX = x;
    this.lastZ = z;
    this.resetWeapon();
    this.setVisible(true);
    this.sync();
  }

  sync() {
    this.group.rotation.y = this.heading;
    this.turret.rotation.y = this.turretYaw - this.heading;
  }

  updateBuffs(dt) {
    for (const k of BUFFS) if (this.buffs[k] > 0) this.buffs[k] = Math.max(0, this.buffs[k] - dt);
  }

  updateVisuals(dt, time) {
    this.flash = Math.max(0, this.flash - dt);
    const glow = (this.flash / 0.15) * 0.9;
    // white hit flash, an icy blue glow while frozen, a flickering orange glow while burning
    const ice = this.freeze * 0.45;
    const fire = this.burnTime > 0 ? Math.min(1, this.burnTime / 1.5) * (0.16 + 0.08 * Math.sin(time * 23)) : 0;
    for (const m of [this.paint, this.paintDark, this.accentMat, this.modelMat, ...Object.values(this.texMats)]) {
      m.emissive.setRGB(glow + ice * 0.35 + fire, glow + ice * 0.75 + fire * 0.35, glow + ice);
    }
    if (this.burnTime > 0) {
      // flames licking up from the hull, with smoke; they thin out as the fire dies
      const k = Math.min(1, this.burnTime / 1.5);
      this.burnFx -= dt;
      if (this.burnFx <= 0 && particles.length < MAX_PARTICLES - 40) {
        this.burnFx = 0.03 / Math.max(k, 0.3);
        const s = Math.sin(this.heading), c = Math.cos(this.heading);
        const ax = rnd(-1, 1), az = rnd(-1.5, 1.5); // a spot on the hull deck
        const x = this.pos.x + ax * c + az * s, z = this.pos.z - ax * s + az * c;
        const y = this.turretY * rnd(0.75, 1.1);
        addParticle({
          geo: puffGeo, x, y, z,
          vel: new THREE.Vector3(rnd(-0.5, 0.5), rnd(2.5, 4), rnd(-0.5, 0.5)), drag: 0.8, spin: rnd(2, 5),
          life: rnd(0.4, 0.6), s0: rnd(0.4, 0.55), s1: rnd(1.1, 1.6) * (0.6 + 0.4 * k), fade: true, op0: 0.9, ownMat: true,
          mat: new THREE.MeshBasicMaterial({
            color: new THREE.Color().setHSL(rnd(0.02, 0.09), 1, rnd(0.5, 0.58)), transparent: true, depthWrite: false,
          }),
        });
        // a bright yellow core inside the flame
        addParticle({
          geo: flashGeo, x, y: y + 0.2, z,
          vel: new THREE.Vector3(0, rnd(2.5, 3.5), 0), life: rnd(0.25, 0.35), s0: 0.3, s1: 0.7, fade: true, op0: 0.9, ownMat: true,
          mat: new THREE.MeshBasicMaterial({
            color: new THREE.Color(1.3, 0.8, 0.25), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
          }),
        });
        if (Math.random() < 0.35) {
          puff(this.pos.x + rnd(-0.8, 0.8), this.turretY + 0.6, this.pos.z + rnd(-0.8, 0.8), 0x2f2a27, 0.45, 0.4, 1.6,
            rnd(1.0, 1.5), new THREE.Vector3(rnd(-0.3, 0.3), rnd(1.5, 2.5), rnd(-0.3, 0.3)));
        }
      }
    }
    if (this.freeze > 0.25 && Math.random() < this.freeze * dt * 12) {
      // frost crystals drifting off a frozen tank
      addParticle({
        geo: sparkGeo, mat: frostMat, x: this.pos.x + rnd(-1.4, 1.4), y: rnd(0.4, 1.8), z: this.pos.z + rnd(-1.4, 1.4),
        vel: new THREE.Vector3(rnd(-0.3, 0.3), rnd(0.4, 1.0), rnd(-0.3, 0.3)), life: rnd(0.6, 1.1), s0: 1.2, s1: 0,
      });
    }
    this.recoil = Math.max(0, this.recoil - dt * 1.6);
    this.weaponGroup.position.z = this.weaponBaseZ - this.recoil;
    // wheels turn and the tread pattern rolls with the tank's speed
    this.wheelSpin += (this.speed * dt) / 0.3;
    for (const w of this.wheels) w.rotation.x = this.wheelSpin;
    this.trackTex.offset.y -= this.speed * dt * 0.5;

    if (this.weaponId === 'railgun') {
      const w = this.weapon;
      const rl = this.human ? w.reload : w.botReload;
      this.coilMat.emissiveIntensity = this.charge > 0
        ? 0.8 + (1 - this.charge / w.charge) * 3.5
        : 0.15 + 0.65 * (1 - clamp(this.reload / rl, 0, 1));
    }

    const active = BUFFS.filter((k) => this.buffs[k] > 0);
    this.aura.visible = active.length > 0;
    if (active.length) {
      const k = active[Math.floor(time * 2) % active.length];
      this.aura.material.color.set(DROP_TYPES[k].color);
      const ending = Math.min(...active.map((a) => this.buffs[a])) < 3;
      this.aura.material.opacity = ending && Math.sin(time * 18) < 0 ? 0.1 : 0.45 + 0.15 * Math.sin(time * 6);
    }

    // dust kicked up behind the tracks
    if (Math.abs(this.speed) > 3 && particles.length < 300) {
      this.dustTimer -= dt;
      if (this.dustTimer <= 0) {
        this.dustTimer = 0.08;
        const { L, W } = this.hull.dims;
        const back = (this.speed > 0 ? -1.9 : 1.9) * L;
        const sn = Math.sin(this.heading), cs = Math.cos(this.heading);
        for (const s of [-1.25 * W, 1.25 * W]) {
          const x = this.pos.x + cs * s + sn * back;
          const z = this.pos.z - sn * s + cs * back;
          puff(x, 0.25, z, theme.dust, 0.35, rnd(0.3, 0.45), rnd(1.0, 1.5), rnd(0.7, 1.0),
            new THREE.Vector3(rnd(-0.4, 0.4), rnd(0.4, 0.9), rnd(-0.4, 0.4)));
        }
      }
    }
  }

  // repaint for a team (or back to the tank's own colour in free-for-all)
  setColor(hex) {
    this.color.set(hex);
    this.colorCss = `#${this.color.getHexString()}`;
    this.paint.color.set(hex);
    this.paintDark.color.copy(this.color).multiplyScalar(0.5);
    this.accentMat.color.copy(this.color).lerp(WHITE, 0.45);
    this.modelMat.color.copy(this.color);
    for (const m of Object.values(this.texMats)) m.color.copy(this.color).multiplyScalar(m.userData.boost);
    this.tracerMat.color.copy(this.color).lerp(WHITE, 0.55).multiplyScalar(2.2);
    this.plasmaMat.color.copy(this.color).lerp(WHITE, 0.35).multiplyScalar(1.5);
    this.plasmaGlowMat.color.copy(this.color).multiplyScalar(0.9);
    if (this.tag) this.drawTag();
  }
}

// name, free-for-all colour, hull, turret, team in team modes.
// Free-for-all uses the first five.
const BOT_DEFS = [
  ['Rook', 0xb8423a, 'warden', 'cannon', 'red'],
  ['Viper', 0x8e4bc2, 'scout', 'railgun', 'red'],
  ['Bulldog', 0xd08a2c, 'bastion', 'flamer', 'red'],
  ['Breaker', 0xc9b13a, 'warden', 'blaster', 'blue'],
  ['Ghost', 0xd9dde3, 'scout', 'cannon', 'blue'],
  ['Falcon', 0x3fa38a, 'bastion', 'hammer', 'blue'],
  ['Mako', 0x5b6b8c, 'warden', 'ricochet', 'red'],
  ['Ember', 0x4f8fd9, 'scout', 'blaster', 'blue'], // only used online, to give blue the tank its parked server player takes
];
let selectedMap = MAPS.some((m) => m.id === load('treadstorm-map', '')) ? load('treadstorm-map', '') : 'quarry';
let selectedMode = MODES[load('treadstorm-mode', '')] ? load('treadstorm-mode', '') : 'ffa';
const player = new Tank(true, 0x3a78c9, 'You', progress.hull, progress.weapon, progress.levels);
const botPool = BOT_DEFS.map(([name, color, hull, weapon, team]) => {
  const b = new Tank(false, color, name, hull, weapon);
  b.ffaColor = color;
  b.homeTeam = team;
  return b;
});
// the tanks taking part in the current mode
let mode = MODES.ffa;
let botExtra = 0; // online team modes have one more bot: the server's own player slot is parked, so blue would be a tank short
let bots = botPool.slice(0, mode.bots);
let tanks = [player, ...bots];
const teamScore = { blue: 0, red: 0 };

const isEnemy = (a, b) => a !== b && (!mode.teams || a.team !== b.team);

function setMode(id) {
  mode = MODES[id];
  bots = botPool.slice(0, mode.bots + (mode.teams ? botExtra : 0));
  tanks = [player, ...bots];
  for (const b of botPool) {
    if (bots.includes(b)) continue;
    if (b.flaming) Sound.flame(b, false);
    b.alive = false;
    b.setVisible(false);
  }
  player.team = mode.teams ? 'blue' : null;
  const shade = { blue: 1, red: 0 }; // the player wears blue shade 0
  for (const b of bots) {
    b.team = mode.teams ? b.homeTeam : null;
    b.setColor(mode.teams ? TEAMS[b.team].colors[shade[b.team]++ % 4] : b.ffaColor);
  }
  // in Capture the Flag, about half of each team attacks and the rest defend
  for (const team of ['blue', 'red']) {
    bots.filter((b) => b.team === team).forEach((b, i) => { b.role = i % 2 ? 'defend' : 'attack'; });
  }
  for (const f of Object.values(flags)) f.setShown(id === 'ctf');
}

// re-equip the player from the garage, keeping the same share of health
function applyLoadout() {
  const share = player.alive ? player.hp / player.maxHp : 1;
  player.setHull(progress.hull, progress.levels[progress.hull]);
  player.setWeapon(progress.weapon, progress.levels[progress.weapon]);
  player.hp = Math.max(1, Math.round(share * player.maxHp));
  player.sync();
  if (player.alive) resolveCollisions(player);
}

// redraw name tags once the web font has loaded
document.fonts?.load('700 34px "Chakra Petch"').then(() => botPool.forEach((b) => b.drawTag())).catch(() => {});

// ---------- Movement / collision ----------
function resolveCollisions(t) {
  const p = t.pos;
  // tanks first, then boxes, so a tank never gets pushed into a wall.
  // The overlap is split by mass, so a heavy hull shoves a light one aside.
  for (const o of tanks) {
    if (o === t || !o.alive) continue;
    let dx = p.x - o.pos.x;
    let dz = p.z - o.pos.z;
    let d = Math.hypot(dx, dz);
    const min = t.radius + o.radius;
    if (d >= min) continue;
    if (d < 1e-4) { dx = 1; dz = 0; d = 1; }
    const push = min - d;
    // squared so weight differences really show (a Scout barely moves a Bastion)
    const share = (o.mass * o.mass) / (t.mass * t.mass + o.mass * o.mass);
    p.x += (dx / d) * push * share;
    p.z += (dz / d) * push * share;
    o.pos.x -= (dx / d) * push * (1 - share);
    o.pos.z -= (dz / d) * push * (1 - share);
    resolveBoxes(o);
  }
  resolveBoxes(t);
}

function resolveBoxes(t) {
  const p = t.pos;
  const R = t.radius;
  for (const b of boxes) {
    const cx = clamp(p.x, b.minX, b.maxX);
    const cz = clamp(p.z, b.minZ, b.maxZ);
    const dx = p.x - cx;
    const dz = p.z - cz;
    const d2 = dx * dx + dz * dz;
    if (d2 >= R * R) continue;
    if (d2 > 1e-8) {
      const d = Math.sqrt(d2);
      p.x = cx + (dx / d) * R;
      p.z = cz + (dz / d) * R;
    } else {
      // centre is inside the box: push out along the shallowest side
      const l = p.x - b.minX, r = b.maxX - p.x, n = p.z - b.minZ, f = b.maxZ - p.z;
      const m = Math.min(l, r, n, f);
      if (m === l) p.x = b.minX - R;
      else if (m === r) p.x = b.maxX + R;
      else if (m === n) p.z = b.minZ - R;
      else p.z = b.maxZ + R;
    }
  }
}

function moveTank(t, speed, dt) {
  t.pos.x += Math.sin(t.heading) * speed * dt;
  t.pos.z += Math.cos(t.heading) * speed * dt;
  resolveCollisions(t);
}

function pathBlocked(t, heading) {
  const sx = Math.sin(heading), sz = Math.cos(heading);
  return pointBlocked(t.pos.x + sx * 3.5, t.pos.z + sz * 3.5, t.radius) ||
    pointBlocked(t.pos.x + sx * 6.5, t.pos.z + sz * 6.5, t.radius);
}

// ---------- Combat ----------
// A game server collects what happens each step here (a shot, a hit, a kill...) and sends it to the browsers, which
// replay it with their own effects. In a browser and in single player this stays null and emit() does nothing.
let hostEvents = null;
const emit = (...e) => { if (hostEvents) hostEvents.push(e); };
const slotOf = (t) => tanks.indexOf(t);

let shake = 0;
function addShake(amount, x, z) {
  // fade with distance from the player
  const d = x === undefined ? 0 : Math.hypot(x - player.pos.x, z - player.pos.z);
  shake = Math.min(1.2, shake + amount * clamp(1 - d / 45, 0, 1));
}

function muzzleFx(x, y, z, dir, t, small) {
  if (small) {
    fireball(x, y, z, 0.2, 0.55, 0.06, new THREE.Color(1.6, 1.0, 0.35));
    sparks(x, y, z, 2, 5, dir);
    flashLight(x, y + 0.4, z, 8, 0.06);
    if (t.isPlayer) addShake(0.03);
    return;
  }
  fireball(x, y, z, 0.35, 0.9, 0.09, new THREE.Color(1.6, 1.0, 0.35));
  sparks(x, y, z, 4, 6, dir);
  puff(x, y, z, 0x8a8580, 0.45, 0.3, 1.0, 0.6, dir.clone().multiplyScalar(2).add(new THREE.Vector3(0, 0.6, 0)));
  flashLight(x, y + 0.4, z, 18, 0.12);
  if (t.isPlayer) addShake(0.12);
}

function impactFx(p, hitTank, small) {
  if (small) {
    fireball(p.x, p.y, p.z, 0.2, 0.6, 0.1, new THREE.Color(1.5, 0.75, 0.25));
    sparks(p.x, p.y, p.z, 5, 6);
    Sound.impact(p.x, p.z, !!hitTank, 0.5);
    return;
  }
  fireball(p.x, p.y, p.z, 0.3, 1.1, 0.16, new THREE.Color(1.5, 0.75, 0.25));
  sparks(p.x, p.y, p.z, hitTank ? 12 : 9, 7);
  puff(p.x, p.y, p.z, hitTank ? 0x5a5550 : theme.dust, 0.5, 0.4, 1.4, 0.8, new THREE.Vector3(0, 1, 0));
  flashLight(p.x, p.y + 0.5, p.z, 28, 0.18);
  addShake(0.15, p.x, p.z);
  Sound.impact(p.x, p.z, !!hitTank);
}

function deathFx(t) {
  const { x, z } = t.pos;
  fireball(x, 1.2, z, 1.2, 5, 0.5, new THREE.Color(1.8, 0.8, 0.25));
  fireball(x, 1.6, z, 0.8, 3.5, 0.7, new THREE.Color(1.1, 0.35, 0.1));
  sparks(x, 1.2, z, 30, 12);
  for (let i = 0; i < 14; i++) {
    addParticle({
      geo: debrisGeo, mat: i % 2 ? t.paint : gunMat, x, y: 1, z, shadow: true,
      vel: new THREE.Vector3(rnd(-1, 1), rnd(0.8, 1.6), rnd(-1, 1)).multiplyScalar(rnd(5, 10)),
      life: rnd(1.2, 2.0), g: 22, s0: rnd(0.6, 1.2), s1: 0.3, bounce: true, spin: rnd(4, 10),
    });
  }
  for (let i = 0; i < 12; i++) {
    puff(x + rnd(-1, 1), rnd(0.8, 2), z + rnd(-1, 1), i < 4 ? 0x3b3633 : 0x6b6560, 0.7, rnd(0.8, 1.2), rnd(2.5, 4),
      rnd(1.6, 2.8), new THREE.Vector3(rnd(-1, 1), rnd(1.5, 3), rnd(-1, 1)));
  }
  flashLight(x, 2, z, 120, 0.6, 0xff8a3a);
  addScorch(x, z, 3);
  addShake(0.9, x, z);
  Sound.explosion(x, z);
}

// 'hit' = a shell or beam; 'burn' = continuous stream damage (lighter feedback);
// 'dot' = damage over time from burning (no flash, the fire effect shows it)
function applyDamage(target, attacker, amount, kind = 'hit', quiet = false) {
  if (!target.alive || !isEnemy(attacker, target)) return; // no friendly fire
  if (net.on) return; // online: the server decides health; the feedback arrives as a 'hit' event
  if (hostEvents) { // tell the browsers (a shotgun blast is one message, a flame stream a few a second)
    if (kind === 'hit' && !quiet) emit('h', slotOf(attacker), slotOf(target), 0);
    else if (kind === 'burn' && !(target.netHurtAt > elapsed - 0.2)) { target.netHurtAt = elapsed; emit('h', slotOf(attacker), slotOf(target), 1); }
  }
  if (attacker.buffs.damage > 0) amount *= 2;
  if (target.buffs.armor > 0) amount *= 0.5;
  target.hp = Math.max(0, target.hp - amount);
  if (kind === 'hit') {
    target.flash = 0.15;
    if (target.isPlayer) {
      damageFlash = 1;
      if (!quiet) { // a shotgun blast is ten hits at once: shake and groan only for the first
        addShake(0.4);
        Sound.hurt();
      }
    }
    if (attacker.isPlayer) hitMarker = 0.15;
  } else if (kind === 'burn') {
    target.flash = Math.max(target.flash, 0.08);
    if (target.isPlayer) damageFlash = Math.max(damageFlash, 0.45);
    if (attacker.isPlayer) hitMarker = Math.max(hitMarker, 0.1);
  }
  if (target.hp <= 0) killTank(target, attacker);
}

function killTank(target, attacker) {
  target.alive = false;
  target.setVisible(false);
  target.respawn = target.human ? PLAYER_RESPAWN : BOT_RESPAWN;
  target.deaths++;
  target.killedBy = attacker;
  target.charge = 0;
  target.burnTime = 0;
  if (target.flaming) {
    target.flaming = false;
    Sound.flame(target, false);
  }
  if (target.carrying) dropFlag(target.carrying, target.pos.x, target.pos.z);
  attacker.kills++;
  if (mode.id === 'tdm') teamScore[attacker.team]++;
  if (attacker.isPlayer) earnCrystals(KILL_REWARD);
  emit('x', slotOf(attacker), slotOf(target));
  deathFx(target);
  addKillFeed(attacker, target);
  if (attacker.isPlayer) {
    showKillMsg(target);
    Sound.kill();
  }
  checkWin();
}

// ends the match once a player or a team reaches the mode's goal
function checkWin() {
  if (state !== 'playing') return;
  if (!mode.teams) {
    const top = tanks.find((t) => t.kills >= mode.goal);
    if (top) endMatch(top.isPlayer, top.isPlayer ? `You reached ${mode.goal} kills` : `${top.name} reached ${mode.goal} kills first`);
    return;
  }
  for (const team of ['blue', 'red']) {
    if (teamScore[team] >= mode.goal) {
      endMatch(team === player.team, `${TEAMS[team].name} team wins ${teamScore.blue} : ${teamScore.red}`);
      return;
    }
  }
}

const tracerGeo = new THREE.BoxGeometry(0.13, 0.13, 1.6);
const tracerSmallGeo = new THREE.BoxGeometry(0.08, 0.08, 1.0);
const plasmaGeo = new THREE.IcosahedronGeometry(0.16, 1);
const plasmaGlowGeo = new THREE.IcosahedronGeometry(0.34, 1);
const bullets = [];

function plasmaMesh(t) {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(plasmaGeo, t.plasmaMat));
  const halo = new THREE.Mesh(plasmaGlowGeo, t.plasmaGlowMat);
  g.add(halo);
  g.userData.halo = halo;
  return g;
}

// the plasma colour of a tank, for bursts and sparks
const plasmaColor = (t, k = 1) => t.color.clone().lerp(WHITE, 0.3).multiplyScalar(k);

function plasmaImpactFx(p, owner, hitTank) {
  fireball(p.x, p.y, p.z, 0.25, hitTank ? 1.3 : 0.9, 0.18, plasmaColor(owner, 1.2));
  fireball(p.x, p.y, p.z, 0.15, 0.45, 0.08, plasmaColor(owner, 1.6));
  sparks(p.x, p.y, p.z, hitTank ? 9 : 6, 6);
  flashLight(p.x, p.y + 0.3, p.z, 14, 0.12, owner.color.getHex());
  Sound.impact(p.x, p.z, !!hitTank, 0.55);
}

// sends a ricochet ball back off a wall or box: flips the direction component
// across the face it went through
function bounceBullet(b, prevX, prevZ) {
  const p = b.pos;
  let flipX = false, flipZ = false;
  if (Math.abs(p.x) > ARENA) flipX = true;
  if (Math.abs(p.z) > ARENA) flipZ = true;
  const box = boxes.find((bx) => p.x > bx.minX && p.x < bx.maxX && p.z > bx.minZ && p.z < bx.maxZ);
  if (box) {
    // whichever side the ball was outside of before this step is the face it crossed
    const outX = prevX <= box.minX || prevX >= box.maxX;
    const outZ = prevZ <= box.minZ || prevZ >= box.maxZ;
    if (outX) flipX = true;
    if (outZ) flipZ = true;
    if (!outX && !outZ) flipX = flipZ = true; // started inside (spawned in cover): just turn around
  }
  if (flipX) b.dir.x = -b.dir.x;
  if (flipZ) b.dir.z = -b.dir.z;
  p.x = prevX;
  p.z = prevZ;
  b.bounces--;
  // a little life back so a long bank shot can still reach its target
  b.life = Math.max(b.life, 0.35);
  sparks(p.x, p.y, p.z, 4, 5, b.dir);
  fireball(p.x, p.y, p.z, 0.2, 0.6, 0.1, plasmaColor(b.owner));
  Sound.bounce(p.x, p.z);
  if (b.mesh) b.mesh.rotation.y = Math.atan2(b.dir.x, b.dir.z);
}

// moves a shell forward; returns true when it hit something
// Hammer pellets lose strength with distance travelled
function pelletScale(b) {
  const f = b.falloff;
  if (!f) return 1;
  return 1 - (1 - f.min) * clamp((b.travel - f.full) / (f.end - f.full), 0, 1);
}

// a pellet landing: a few sparks and a dust puff, with one sound and one light per blast
function pelletImpactFx(b, p, hitTank) {
  sparks(p.x, p.y, p.z, hitTank ? 4 : 3, 5);
  if (particles.length < MAX_PARTICLES - 60) {
    puff(p.x, p.y, p.z, hitTank ? 0x5a5550 : theme.dust, 0.4, 0.2, 0.7, 0.45, new THREE.Vector3(0, 0.8, 0));
  }
  if (!b.volley.heard) {
    b.volley.heard = true;
    Sound.impact(p.x, p.z, !!hitTank, 0.5);
    flashLight(p.x, p.y + 0.4, p.z, 12, 0.1);
  }
}

function advanceBullet(b, dist) {
  b.travel = (b.travel || 0) + dist;
  const steps = Math.max(1, Math.ceil(dist / 0.4));
  const step = dist / steps;
  const p = b.pos;
  for (let s = 0; s < steps; s++) {
    const px = p.x, pz = p.z;
    p.addScaledVector(b.dir, step);
    if (Math.abs(p.x) > ARENA || Math.abs(p.z) > ARENA || pointInBox(p.x, p.z)) {
      // ricochet balls bounce off everything except tanks
      if (b.bounces > 0) {
        bounceBullet(b, px, pz);
        continue;
      }
      if (b.plasma) plasmaImpactFx(p, b.owner, null);
      else if (b.pellet) pelletImpactFx(b, p, null);
      else impactFx(p, null, b.small);
      return true;
    }
    for (const t of tanks) {
      // shells pass straight through teammates
      if (!t.alive || !isEnemy(b.owner, t)) continue;
      if (Math.hypot(p.x - t.pos.x, p.z - t.pos.z) < t.radius) {
        if (b.plasma) plasmaImpactFx(p, b.owner, t);
        else if (b.pellet) pelletImpactFx(b, p, t);
        else impactFx(p, t, b.small);
        // a pellet is removed the moment it hits, so one pellet can never hurt the same tank twice
        if (b.pellet) {
          applyDamage(t, b.owner, b.damage * pelletScale(b), 'hit', b.volley.hurt.has(t));
          b.volley.hurt.add(t);
        } else {
          applyDamage(t, b.owner, b.damage);
        }
        return true;
      }
    }
  }
  return false;
}

const pelletGeo = new THREE.BoxGeometry(0.07, 0.07, 0.55);

// A shotgun blast: w.pellets bullets fanned over w.cone. The fan is evenly spaced with a little jitter,
// so every blast covers the cone (instead of sometimes clumping), and always includes a centre pellet.
function fireHammer(t) {
  const w = t.weapon;
  const aim = t.turretYaw + rnd(-1, 1) * (t.human ? w.spread : w.botSpread);
  t.reload = t.human ? w.reload : w.botReload;
  t.recoil = w.recoil;
  const dx = Math.sin(t.turretYaw), dz = Math.cos(t.turretYaw);
  const mx = t.pos.x + dx * w.muzzle, mz = t.pos.z + dz * w.muzzle;
  // muzzle flash and smoke at the barrel opening
  const dirV = new THREE.Vector3(dx, 0, dz);
  fireball(mx, t.muzzleY, mz, 0.4, 1.25, 0.1, new THREE.Color(1.8, 1.15, 0.4));
  fireball(mx + dx * 0.4, t.muzzleY, mz + dz * 0.4, 0.2, 0.7, 0.07, new THREE.Color(2.4, 2.0, 1.2));
  sparks(mx, t.muzzleY, mz, 9, 8, dirV);
  for (let i = 0; i < 3; i++) {
    puff(mx + dx * i * 0.5, t.muzzleY + 0.1, mz + dz * i * 0.5, 0x8a8580, 0.5, 0.35, 1.3, 0.9,
      new THREE.Vector3(dx * (1.5 + i), 0.7 + i * 0.2, dz * (1.5 + i)));
  }
  flashLight(mx, t.muzzleY + 0.4, mz, 22, 0.12);
  if (t.isPlayer) addShake(0.22);
  Sound.shot('hammer', mx, mz);
  const volley = { heard: false, hurt: new Set() };
  const n = w.pellets;
  for (let i = 0; i < n; i++) {
    const frac = n === 1 ? 0 : (i / (n - 1)) * 2 - 1; // -1 .. 1 across the fan
    const yaw = aim + frac * w.cone + rnd(-1, 1) * (w.cone / n) * 0.45;
    const dir = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    const b = {
      pos: new THREE.Vector3(t.pos.x + dir.x * 1.2, t.muzzleY, t.pos.z + dir.z * 1.2),
      dir, owner: t, life: w.life, damage: w.damage, speed: w.speed * rnd(0.94, 1.06), small: true,
      plasma: false, bounces: 0, pellet: true, falloff: w.falloff, volley, travel: 1.2,
    };
    if (advanceBullet(b, w.muzzle - 1.2)) continue; // blocked right at the muzzle
    b.mesh = new THREE.Mesh(pelletGeo, t.tracerMat);
    b.mesh.position.copy(b.pos);
    b.mesh.rotation.y = yaw;
    scene.add(b.mesh);
    bullets.push(b);
  }
}

function fireShell(t) {
  emit('f', slotOf(t));
  if (t.weapon.pellets) return fireHammer(t);
  const w = t.weapon;
  const yaw = t.turretYaw + rnd(-1, 1) * (t.human ? w.spread : w.botSpread);
  const dir = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
  // the blaster alternates between its two barrels
  let side = 0;
  if (t.weaponId === 'blaster') {
    side = t.barrelIndex ? 0.22 : -0.22;
    t.barrelIndex ^= 1;
  }
  const ox = Math.cos(t.turretYaw) * side, oz = -Math.sin(t.turretYaw) * side;
  t.reload = t.human ? w.reload : w.botReload;
  t.recoil = w.recoil;
  const mx = t.pos.x + dir.x * w.muzzle + ox, mz = t.pos.z + dir.z * w.muzzle + oz;
  if (w.plasma) {
    fireball(mx, t.muzzleY, mz, 0.2, 0.7, 0.08, plasmaColor(t, 1.2));
    flashLight(mx, t.muzzleY + 0.3, mz, 10, 0.08, t.color.getHex());
    if (t.isPlayer) addShake(0.05);
  } else {
    muzzleFx(mx, t.muzzleY, mz, dir, t, w.small);
  }
  Sound.shot(t.weaponId, mx, mz);
  // sweep from inside the hull to the muzzle first, so point-blank shots can't pass through
  const b = {
    pos: new THREE.Vector3(t.pos.x + dir.x * 1.2 + ox, t.muzzleY, t.pos.z + dir.z * 1.2 + oz),
    dir, owner: t, life: w.life, damage: w.damage, speed: w.speed, small: !!w.small,
    plasma: !!w.plasma, bounces: w.bounces || 0,
  };
  if (advanceBullet(b, w.muzzle - 1.2)) return;
  if (w.plasma) {
    b.mesh = plasmaMesh(t);
  } else {
    b.mesh = new THREE.Mesh(w.small ? tracerSmallGeo : tracerGeo, t.tracerMat);
    b.mesh.rotation.y = yaw;
  }
  b.mesh.position.copy(b.pos);
  scene.add(b.mesh);
  bullets.push(b);
}

function updateBullets(dt) {
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    b.life -= dt;
    const hit = advanceBullet(b, b.speed * dt);
    if (hit || b.life <= 0) {
      // a ball that runs out of energy fizzles out instead of vanishing
      if (!hit && b.plasma) fireball(b.pos.x, b.pos.y, b.pos.z, 0.3, 0.6, 0.15, plasmaColor(b.owner, 0.9));
      scene.remove(b.mesh);
      bullets.splice(i, 1);
    } else {
      b.mesh.position.copy(b.pos);
      if (b.plasma) b.mesh.userData.halo.scale.setScalar(0.85 + Math.sin(b.life * 40) * 0.15); // shimmer
    }
  }
}

function flameTick(t, dt) {
  const w = t.weapon;
  const dx = Math.sin(t.turretYaw), dz = Math.cos(t.turretYaw);
  const mx = t.pos.x + dx * w.muzzle, mz = t.pos.z + dz * w.muzzle;
  t.flameTimer -= dt;
  if (t.flameTimer <= 0 && w.ice) {
    t.flameTimer = 0.03;
    // icy stream: pale blue-white mist around a glowing cyan core, with crystals
    for (let i = 0; i < 3; i++) {
      const core = i === 0;
      const a = t.turretYaw + rnd(-0.12, 0.12);
      const sp = rnd(20, 24);
      addParticle({
        geo: core ? flashGeo : puffGeo, x: mx, y: t.muzzleY - 0.05, z: mz, drag: 1.0, collide: true,
        vel: new THREE.Vector3(Math.sin(a) * sp, rnd(-0.2, 0.9), Math.cos(a) * sp),
        life: rnd(0.45, 0.6), s0: core ? 0.2 : 0.25, s1: core ? rnd(0.7, 1.0) : rnd(1.3, 1.9),
        fade: true, op0: core ? 0.9 : 0.6, ownMat: true, spin: core ? 0 : rnd(1, 3),
        mat: core
          ? new THREE.MeshBasicMaterial({
            color: new THREE.Color(0.55, 1.2, 1.6), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
          })
          : new THREE.MeshBasicMaterial({
            color: new THREE.Color().setHSL(rnd(0.52, 0.56), 0.7, rnd(0.78, 0.9)), transparent: true, depthWrite: false,
          }),
      });
    }
    if (Math.random() < 0.5) {
      const a = t.turretYaw + rnd(-0.2, 0.2);
      addParticle({
        geo: sparkGeo, mat: frostMat, x: mx, y: t.muzzleY, z: mz, g: 4, life: rnd(0.4, 0.6), s0: 1.4, s1: 0.3, collide: true,
        vel: new THREE.Vector3(Math.sin(a) * 18, rnd(0, 2), Math.cos(a) * 18), spin: 8,
      });
    }
  } else if (t.flameTimer <= 0) {
    t.flameTimer = 0.03;
    // solid orange flames (readable on bright snow) around a smaller glowing core
    for (let i = 0; i < 3; i++) {
      const core = i === 0;
      const a = t.turretYaw + rnd(-0.13, 0.13);
      const sp = rnd(20, 24);
      addParticle({
        geo: flashGeo, x: mx, y: t.muzzleY - 0.05, z: mz, drag: 1.0, collide: true,
        vel: new THREE.Vector3(Math.sin(a) * sp, rnd(0.2, 1.4), Math.cos(a) * sp),
        life: rnd(0.45, 0.58), s0: core ? 0.2 : 0.25, s1: core ? rnd(0.8, 1.1) : rnd(1.3, 1.8),
        fade: true, op0: core ? 0.9 : 0.75, ownMat: true,
        mat: core
          ? new THREE.MeshBasicMaterial({
            color: new THREE.Color(1.3, 0.75, 0.2), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
          })
          : new THREE.MeshBasicMaterial({
            color: new THREE.Color().setHSL(rnd(0.02, 0.09), 1, rnd(0.45, 0.55)), transparent: true, depthWrite: false,
          }),
      });
    }
    if (Math.random() < 0.25) {
      puff(mx + dx * 6, t.muzzleY + 0.5, mz + dz * 6, 0x3d3835, 0.35, 0.5, 1.8, 0.9, new THREE.Vector3(dx * 4, 1.5, dz * 4));
    }
  }
  t.flameLight -= dt;
  if (t.flameLight <= 0) {
    t.flameLight = 0.12;
    flashLight(mx + dx * 4, 1.4, mz + dz * 4, 16, 0.14, w.ice ? 0x8fdcff : 0xff7a2a);
  }
  if (net.on) return; // online the damage is the server's job
  const dps = t.human ? w.dps : w.botDps;
  for (const o of tanks) {
    if (!o.alive || !isEnemy(t, o)) continue;
    const ox = o.pos.x - t.pos.x, oz = o.pos.z - t.pos.z;
    const d = Math.hypot(ox, oz);
    if (d > w.range + o.radius) continue;
    const off = Math.abs(angleDiff(Math.atan2(ox, oz), t.turretYaw));
    if (off > w.cone + Math.asin(Math.min(1, o.radius / Math.max(d, o.radius)))) continue;
    if (!hasLineOfSight(t.pos, o.pos)) continue;
    applyDamage(o, t, dps * dt, 'burn');
    if (w.burnDps) {
      // set it on fire (or keep it burning): the timer restarts while the stream touches it
      o.burnTime = w.burnTime;
      o.burnDps = t.human ? w.burnDps : w.botBurnDps;
      o.burnBy = t;
    }
    if (w.ice) {
      o.freeze = Math.min(1, o.freeze + w.freezeRate * dt);
      o.freezeHold = 0;
    }
  }
}

// frozen tanks thaw shortly after the spray stops
function updateFreeze(t, dt) {
  t.freezeHold += dt;
  if (t.freezeHold > 0.35) t.freeze = Math.max(0, t.freeze - FREEZE_THAW * dt);
}
// multiplier for a tank's driving, hull turning and turret turning
const frozenFactor = (t) => 1 - FREEZE_SLOW * t.freeze;

// a tank set on fire by a Flamer keeps taking damage until its burn timer runs out
function updateBurn(t, dt) {
  if (t.burnTime <= 0) return;
  t.burnTime = Math.max(0, t.burnTime - dt);
  applyDamage(t, t.burnBy, t.burnDps * dt, 'dot');
}

function setFlaming(t, on) {
  if (on !== !!t.flaming) emit('l', slotOf(t), on ? 1 : 0);
  if (on) Sound.flame(t, true, t.pos.x, t.pos.z, !!t.weapon.ice);
  else if (t.flaming) Sound.flame(t, false);
  t.flaming = on;
}

function startCharge(t) {
  emit('c', slotOf(t));
  t.charge = t.weapon.charge;
  Sound.railCharge(t.pos.x, t.pos.z, t.weapon.charge);
}

function fireRail(t) {
  emit('f', slotOf(t));
  const w = t.weapon;
  const yaw = t.turretYaw + rnd(-1, 1) * (t.human ? w.spread : w.botSpread);
  const dx = Math.sin(yaw), dz = Math.cos(yaw);
  const sx = t.pos.x + dx * 1.2, sz = t.pos.z + dz * 1.2;
  // the beam stops at the first wall or box, but passes through every tank before it
  let reach = w.range;
  for (const b of boxes) {
    const hit = rayBox(sx, sz, dx, dz, b);
    if (hit !== null && hit < reach) reach = hit;
  }
  const victims = [];
  for (const o of tanks) {
    if (!o.alive || !isEnemy(t, o)) continue; // the beam passes through teammates
    const rx = o.pos.x - sx, rz = o.pos.z - sz;
    const along = rx * dx + rz * dz;
    if (along < -0.5 || along > reach) continue;
    if (Math.abs(rx * dz - rz * dx) < o.radius) victims.push([o, along]);
  }
  t.reload = t.human ? w.reload : w.botReload;
  t.recoil = w.recoil;
  const mx = t.pos.x + dx * w.muzzle, mz = t.pos.z + dz * w.muzzle;
  const ex = sx + dx * reach, ez = sz + dz * reach;
  addBeam(mx, mz, ex, ez, t.muzzleY);
  fireball(mx, t.muzzleY, mz, 0.3, 1.0, 0.12, new THREE.Color(0.6, 1.6, 2.2));
  flashLight(mx, 2, mz, 30, 0.2, 0x7fd8ff);
  impactFx(new THREE.Vector3(ex, t.muzzleY, ez), null, false);
  for (const [o, along] of victims) {
    impactFx(new THREE.Vector3(sx + dx * along, t.muzzleY, sz + dz * along), o, false);
    applyDamage(o, t, w.damage);
  }
  Sound.shot('railgun', mx, mz);
  addShake(t.isPlayer ? 0.35 : 0.2, mx, mz);
}

// reload, fuel and charge bookkeeping for any tank; `trigger` = wants to fire now
function updateWeapon(t, dt, trigger) {
  const w = t.weapon;
  if (t.reload > 0) t.reload -= dt;
  if (w.kind === 'flame') {
    const on = trigger && !t.overheat && t.fuel > 0;
    if (on) {
      t.fuel = Math.max(0, t.fuel - w.fuelUse * dt);
      if (t.fuel === 0) t.overheat = true;
      flameTick(t, dt);
    } else {
      t.fuel = Math.min(100, t.fuel + w.fuelRegen * dt);
      if (t.overheat && t.fuel >= 35) t.overheat = false;
    }
    setFlaming(t, on);
    return;
  }
  if (w.kind === 'rail') {
    // once a charge starts it always fires
    if (t.charge > 0) {
      t.charge -= dt;
      if (t.charge <= 0) {
        t.charge = 0;
        fireRail(t);
      }
    } else if (trigger && t.reload <= 0) {
      startCharge(t);
    }
    return;
  }
  if (trigger && t.reload <= 0) fireShell(t);
}

// ---------- Bonus drops ----------
const drops = [];
let dropTimer = 4;
const crateGeo = new THREE.BoxGeometry(1.3, 1.3, 1.3);
const canopyGeo = new THREE.SphereGeometry(1.8, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2);
const cordGeo = new THREE.CylinderGeometry(0.02, 0.02, 1, 3).translate(0, 0.5, 0);
const dropBeamGeo = new THREE.CylinderGeometry(0.55, 0.55, 14, 12, 1, true).translate(0, 7, 0);
const cordMat = new THREE.MeshBasicMaterial({ color: 0x222222 });
const dropMats = {};

function drawDropIcon(g, type, cx, cy, r, color) {
  g.fillStyle = color;
  g.beginPath();
  if (type === 'repair') {
    const w = r * 0.4;
    g.rect(cx - w / 2, cy - r, w, r * 2);
    g.rect(cx - r, cy - w / 2, r * 2, w);
  } else if (type === 'armor') {
    g.moveTo(cx, cy - r);
    g.lineTo(cx + r * 0.85, cy - r * 0.55);
    g.lineTo(cx + r * 0.7, cy + r * 0.35);
    g.lineTo(cx, cy + r);
    g.lineTo(cx - r * 0.7, cy + r * 0.35);
    g.lineTo(cx - r * 0.85, cy - r * 0.55);
    g.closePath();
  } else if (type === 'damage') {
    for (let i = 0; i < 16; i++) {
      const a = (i * Math.PI) / 8 - Math.PI / 2;
      const rr = i % 2 ? r * 0.45 : r;
      g.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
    }
    g.closePath();
  } else if (type === 'crystal') {
    // a cut gem: outline plus a lighter top facet
    g.moveTo(cx - r * 0.85, cy - r * 0.3);
    g.lineTo(cx - r * 0.45, cy - r * 0.8);
    g.lineTo(cx + r * 0.45, cy - r * 0.8);
    g.lineTo(cx + r * 0.85, cy - r * 0.3);
    g.lineTo(cx, cy + r);
    g.closePath();
    g.fill();
    g.fillStyle = 'rgba(255,255,255,0.45)';
    g.beginPath();
    g.moveTo(cx - r * 0.85, cy - r * 0.3);
    g.lineTo(cx - r * 0.45, cy - r * 0.8);
    g.lineTo(cx + r * 0.45, cy - r * 0.8);
    g.lineTo(cx + r * 0.85, cy - r * 0.3);
    g.closePath();
  } else {
    for (const ox of [-0.45, 0.2]) {
      const x = cx + ox * r;
      g.moveTo(x - 0.35 * r, cy - 0.8 * r);
      g.lineTo(x + 0.15 * r, cy - 0.8 * r);
      g.lineTo(x + 0.6 * r, cy);
      g.lineTo(x + 0.15 * r, cy + 0.8 * r);
      g.lineTo(x - 0.35 * r, cy + 0.8 * r);
      g.lineTo(x + 0.1 * r, cy);
      g.closePath();
    }
  }
  g.fill();
}

// small icon images of the crate symbols for the HUD and menu
const iconCache = {};
function dropIconUrl(type) {
  if (!iconCache[type]) {
    const c = document.createElement('canvas');
    c.width = c.height = 48;
    drawDropIcon(c.getContext('2d'), type, 24, 24, 16, '#0b1016');
    iconCache[type] = c.toDataURL();
  }
  return iconCache[type];
}

function dropMaterials(type) {
  if (dropMats[type]) return dropMats[type];
  const def = DROP_TYPES[type];
  const face = canvasTexture(128, 99, (g, s) => {
    g.fillStyle = '#1e252d';
    g.fillRect(0, 0, s, s);
    g.strokeStyle = def.css;
    g.lineWidth = 10;
    g.strokeRect(5, 5, s - 10, s - 10);
    drawDropIcon(g, type, s / 2, s / 2, s * 0.3, def.css);
  });
  dropMats[type] = {
    crate: new THREE.MeshStandardMaterial({
      map: face, emissiveMap: face, emissive: 0xffffff, emissiveIntensity: 1.3, roughness: 0.5, metalness: 0.3,
    }),
    canopy: new THREE.MeshStandardMaterial({ color: def.color, side: THREE.DoubleSide, roughness: 0.8 }),
    beam: new THREE.MeshBasicMaterial({
      color: def.color, transparent: true, opacity: 0.16, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    }),
  };
  return dropMats[type];
}

const UP = new THREE.Vector3(0, 1, 0);
function spawnDrop() {
  if (drops.length >= MAX_DROPS) return;
  for (let tries = 0; tries < 25; tries++) {
    const x = rnd(-ARENA + 6, ARENA - 6);
    const z = rnd(-ARENA + 6, ARENA - 6);
    if (pointBlocked(x, z, 2.5)) continue;
    if (tanks.some((t) => t.alive && Math.hypot(t.pos.x - x, t.pos.z - z) < 8)) continue;
    if (drops.some((d) => Math.hypot(d.x - x, d.z - z) < 10)) continue;
    drops.push(buildDrop(pickDropType(), x, z));
    return;
  }
}

let dropSeq = 0;
const DROP_KEYS = Object.keys(DROP_TYPES);
// the crate and its parachute, falling from the sky at (x, z)
function buildDrop(type, x, z, id) {
  const mats = dropMaterials(type);
  const group = new THREE.Group();
  const crate = addMesh(crateGeo, mats.crate, 0, 0, 0, group);
  const chute = new THREE.Group();
  const canopy = new THREE.Mesh(canopyGeo, mats.canopy);
  canopy.position.y = 3.2;
  chute.add(canopy);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const a = new THREE.Vector3(sx * 0.6, 0.65, sz * 0.6);
      const b = new THREE.Vector3(sx * 1.25, 3.25, sz * 1.25);
      const cord = new THREE.Mesh(cordGeo, cordMat);
      cord.position.copy(a);
      cord.scale.y = a.distanceTo(b);
      cord.quaternion.setFromUnitVectors(UP, b.clone().sub(a).normalize());
      chute.add(cord);
    }
  }
  group.add(chute);
  const beam = new THREE.Mesh(dropBeamGeo, mats.beam);
  beam.visible = false;
  group.add(beam);
  group.position.set(x, 24, z);
  scene.add(group);
  return { id: id ?? ++dropSeq, type, x, z, group, crate, chute, beam, landed: false, life: DROP_LIFETIME, phase: Math.random() * 6 };
}

function pickDropType() {
  const entries = Object.entries(DROP_TYPES);
  let roll = Math.random() * entries.reduce((s, [, d]) => s + d.weight, 0);
  for (const [type, d] of entries) {
    roll -= d.weight;
    if (roll <= 0) return type;
  }
  return entries[0][0];
}

function removeDrop(d) {
  scene.remove(d.group);
  drops.splice(drops.indexOf(d), 1);
}

function collectDrop(t, d) {
  const def = DROP_TYPES[d.type];
  emit('p', slotOf(t), d.type, +d.x.toFixed(1), +d.z.toFixed(1));
  if (d.type === 'repair') t.hp = Math.min(t.maxHp, t.hp + REPAIR_AMOUNT);
  else if (d.type === 'crystal') {
    // only the player banks crystals; a bot grabbing them just denies you
    if (t.isPlayer) earnCrystals(CRYSTAL_DROP_REWARD);
  } else t.buffs[d.type] = BUFF_TIME;
  fireball(d.x, 1, d.z, 0.6, 3.5, 0.4, new THREE.Color(def.color).multiplyScalar(1.8));
  Sound.pickup(d.x, d.z);
  if (t.isPlayer) showToast(`+ ${d.type === 'crystal' ? `${CRYSTAL_DROP_REWARD} crystals` : def.name}`, def.css);
  removeDrop(d);
}

function updateDrops(dt, time) {
  if (!net.on) { // online, the server decides when crates drop, who takes them and when they expire
    dropTimer -= dt;
    if (dropTimer <= 0) {
      spawnDrop();
      dropTimer = rnd(...DROP_INTERVAL);
    }
  }
  for (let i = drops.length - 1; i >= 0; i--) {
    const d = drops[i];
    const g = d.group;
    if (!d.landed) {
      g.position.y -= 4.5 * dt;
      g.rotation.y += 0.4 * dt;
      d.chute.rotation.z = Math.sin(time * 1.6 + d.phase) * 0.08;
      if (g.position.y <= 0.65) {
        g.position.y = 0.65;
        d.landed = true;
        g.remove(d.chute);
        d.beam.visible = true;
        for (let k = 0; k < 6; k++) {
          const a = (k / 6) * Math.PI * 2;
          puff(d.x, 0.3, d.z, theme.dust, 0.4, 0.4, 1.3, 0.8, new THREE.Vector3(Math.cos(a) * 3, 0.4, Math.sin(a) * 3));
        }
        Sound.thud(d.x, d.z);
      }
    } else {
      d.crate.rotation.y += dt * 0.8;
      d.crate.position.y = Math.sin(time * 2.5 + d.phase) * 0.12;
      d.life -= dt;
      g.visible = d.life > 4 || Math.sin(time * 16) > 0; // blink before expiring
      if (d.life <= 0 && !net.on) {
        removeDrop(d);
        continue;
      }
    }
    if (g.position.y < 3 && !net.on) {
      const taker = tanks.find((t) => t.alive && Math.hypot(t.pos.x - d.x, t.pos.z - d.z) < t.radius + 0.7);
      if (taker) collectDrop(taker, d);
    }
  }
}

function clearDrops() {
  while (drops.length) removeDrop(drops[0]);
  dropTimer = 4;
}

// ---------- Capture the Flag ----------
const flagPoleGeo = new THREE.CylinderGeometry(0.06, 0.07, 4.2, 6).translate(0, 2.1, 0);
const flagBaseGeo = new THREE.CylinderGeometry(3.0, 3.3, 0.25, 32);
const flagRingGeo = new THREE.RingGeometry(2.55, 2.95, 48).rotateX(-Math.PI / 2);

class Flag {
  constructor(team) {
    this.team = team;
    this.home = FLAG_BASES[team];
    const color = TEAMS[team].colors[0];
    // the base stays put; the flag itself can be carried around
    this.base = new THREE.Group();
    addMesh(flagBaseGeo, darkMetal, 0, 0.12, 0, this.base);
    const ring = new THREE.Mesh(flagRingGeo, new THREE.MeshBasicMaterial({
      color: new THREE.Color(color).multiplyScalar(1.6), transparent: true, opacity: 0.85, depthWrite: false,
    }));
    ring.position.y = 0.27;
    this.base.add(ring);
    this.base.position.set(this.home.x, 0, this.home.z);
    scene.add(this.base);

    this.group = new THREE.Group();
    addMesh(flagPoleGeo, gunMat, 0, 0, 0, this.group);
    this.clothGeo = new THREE.PlaneGeometry(1.8, 1.1, 10, 4).translate(0.9, 0, 0);
    this.clothX = Float32Array.from(this.clothGeo.attributes.position.array.filter((_, i) => i % 3 === 0));
    this.cloth = addMesh(this.clothGeo, new THREE.MeshStandardMaterial({
      color, emissive: color, emissiveIntensity: 0.35, side: THREE.DoubleSide, roughness: 0.7,
    }), 0, 3.6, 0, this.group);
    scene.add(this.group);
    this.reset();
  }

  reset() {
    this.state = 'home'; // 'home' | 'carried' | 'dropped'
    this.carrier = null;
    this.dropTimer = 0;
    this.x = this.home.x;
    this.z = this.home.z;
    this.group.position.set(this.x, 0.25, this.z);
    this.group.rotation.set(0, 0, 0);
    this.group.scale.setScalar(1);
  }

  setShown(v) {
    this.base.visible = v;
    this.group.visible = v;
  }

  // a simple travelling wave across the cloth
  animate(time) {
    const pos = this.clothGeo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = this.clothX[i];
      pos.setZ(i, Math.sin(x * 3.2 - time * 7) * 0.12 * x);
    }
    pos.needsUpdate = true;
    this.clothGeo.computeVertexNormals();
  }
}
const flags = { blue: new Flag('blue'), red: new Flag('red') };
const teamLabel = (team) => `<span style="color:${TEAMS[team].css}">${TEAMS[team].name}</span>`;
const tankLabel = (t) => `<span style="color:${t.colorCss}">${t.name}</span>`;

function takeFlag(f, t) {
  emit('F', 0, f.team, slotOf(t));
  f.state = 'carried';
  f.carrier = t;
  t.carrying = f;
  pushFeed(`${tankLabel(t)}<span class="kf-icon">took</span>${teamLabel(f.team)} flag`, t.isPlayer);
  if (t.isPlayer) showToast('You have the flag! Bring it home', TEAMS[f.team].css);
  else if (f.team === player.team) showToast('Your flag was taken!', TEAMS[t.team].css);
  Sound.flagEvent(t.team === player.team);
}

function dropFlag(f, x, z) {
  emit('F', 1, f.team, -1);
  if (f.carrier) f.carrier.carrying = null;
  f.state = 'dropped';
  f.carrier = null;
  f.x = x;
  f.z = z;
  f.dropTimer = FLAG_RETURN_TIME;
  f.group.position.set(x, 0, z);
  f.group.rotation.set(0, 0, 0.3); // leaning where it fell
  f.group.scale.setScalar(1);
  pushFeed(`${teamLabel(f.team)} flag<span class="kf-icon">dropped</span>`, false);
}

function returnFlag(f, by) {
  emit('F', 2, f.team, by ? slotOf(by) : -1);
  if (f.carrier) f.carrier.carrying = null;
  f.reset();
  pushFeed(by
    ? `${tankLabel(by)}<span class="kf-icon">returned</span>${teamLabel(f.team)} flag`
    : `${teamLabel(f.team)} flag<span class="kf-icon">returned</span>`, !!by?.isPlayer);
  if (by?.isPlayer) earnCrystals(RETURN_REWARD);
  if (f.team === player.team) Sound.flagEvent(true);
}

function captureFlag(f, t) {
  emit('F', 3, f.team, slotOf(t));
  t.carrying = null;
  teamScore[t.team]++;
  f.reset();
  const home = flags[t.team].home;
  fireball(home.x, 2, home.z, 1, 6, 0.6, new THREE.Color(TEAMS[t.team].colors[0]).multiplyScalar(1.6));
  pushFeed(`${tankLabel(t)}<span class="kf-icon">captured</span>${teamLabel(f.team)} flag`, t.isPlayer);
  if (t.isPlayer) {
    earnCrystals(CAPTURE_REWARD);
    showToast('Flag captured!', TEAMS[t.team].css);
  } else {
    showToast(`${TEAMS[t.team].name} team scores`, TEAMS[t.team].css);
  }
  Sound.flagEvent(t.team === player.team, true);
  checkWin();
}

// the flags as a browser draws them online: where the server's snapshots say they are
function drawFlagsOnline() {
  for (const f of Object.values(flags)) {
    const c = f.carrier;
    if (f.state === 'carried' && c && c.alive) {
      const back = 1.3 * c.hull.dims.L;
      f.group.position.set(c.pos.x - Math.sin(c.heading) * back, c.turretY - 0.3, c.pos.z - Math.cos(c.heading) * back);
      f.group.rotation.set(0, c.heading + Math.PI / 2, 0);
      f.group.scale.setScalar(0.75);
    } else if (f.state === 'dropped') {
      f.group.position.set(f.x, 0, f.z);
      f.group.rotation.set(0, 0, 0.3);
      f.group.scale.setScalar(1);
    } else {
      f.group.position.set(f.home.x, 0.25, f.home.z);
      f.group.rotation.set(0, 0, 0);
      f.group.scale.setScalar(1);
    }
  }
}

function updateFlags(dt, time) {
  if (mode.id !== 'ctf') return;
  if (net.on) {
    for (const f of Object.values(flags)) f.animate(time);
    drawFlagsOnline();
    return;
  }
  for (const f of Object.values(flags)) {
    f.animate(time);
    if (f.state === 'carried') {
      const c = f.carrier;
      if (!c.alive) {
        dropFlag(f, c.pos.x, c.pos.z);
        continue;
      }
      // ride on the back of the carrier, cloth trailing behind
      const back = 1.3 * c.hull.dims.L;
      f.x = c.pos.x - Math.sin(c.heading) * back;
      f.z = c.pos.z - Math.cos(c.heading) * back;
      f.group.position.set(f.x, c.turretY - 0.3, f.z);
      f.group.rotation.set(0, c.heading + Math.PI / 2, 0);
      f.group.scale.setScalar(0.75);
      const own = flags[c.team];
      if (own.state === 'home' && Math.hypot(c.pos.x - own.home.x, c.pos.z - own.home.z) < 3.5) captureFlag(f, c);
      continue;
    }
    if (f.state === 'dropped') {
      f.dropTimer -= dt;
      if (f.dropTimer <= 0) {
        returnFlag(f, null);
        continue;
      }
    }
    for (const t of tanks) {
      if (!t.alive || Math.hypot(t.pos.x - f.x, t.pos.z - f.z) > t.radius + 1.3) continue;
      if (t.team === f.team) {
        if (f.state === 'dropped') {
          returnFlag(f, t);
          break;
        }
      } else if (!t.carrying) {
        takeFlag(f, t);
        break;
      }
    }
  }
}

function resetFlags() {
  for (const f of Object.values(flags)) f.reset();
  for (const t of botPool) t.carrying = null;
  player.carrying = null;
}

// ---------- Respawn ----------
// blue starts in the south half (negative z), red in the north
function teamSpawns(team) {
  const own = SPAWNS.filter((s) => (team === 'blue' ? s.z < 0 : s.z > 0));
  return own.length ? own : SPAWNS;
}

function spawnFree(s) {
  return tanks.every((t) => !t.alive || Math.hypot(t.pos.x - s.x, t.pos.z - s.z) > MAX_TANK_R * 3);
}

function respawnTank(t) {
  let spot;
  const home = mode.teams ? teamSpawns(t.team) : SPAWNS;
  const enemies = tanks.filter((o) => o.alive && isEnemy(t, o));
  const safety = (s) => Math.min(...enemies.map((o) => Math.hypot(o.pos.x - s.x, o.pos.z - s.z)), 1e9);
  if (t.human || mode.teams) {
    // the spot on your side furthest from any enemy (bots get a little randomness)
    let best = -1;
    for (const s of home.filter(spawnFree)) {
      const v = safety(s) + (t.human ? 0 : Math.random() * 12);
      if (v > best) { best = v; spot = s; }
    }
  } else {
    const options = SPAWNS.filter((s) => spawnFree(s) &&
      tanks.every((o) => o === t || !o.alive || Math.hypot(o.pos.x - s.x, o.pos.z - s.z) > 20));
    const pool = options.length ? options : SPAWNS;
    spot = pool[(Math.random() * pool.length) | 0];
  }
  spot = spot || home[0];
  t.spawnAt(spot.x, spot.z);
  resolveCollisions(t);
}

function updateRespawns(dt) {
  for (const t of tanks) {
    if (t.alive) continue;
    t.respawn -= dt;
    if (t.respawn <= 0) respawnTank(t);
  }
}

// ---------- Player ----------
const keys = {};

// Driving one tank for one frame: hull, turret, speed, collisions, firing. `input` has the same keys as the
// keyboard state (KeyW, KeyS, KeyA, KeyD, KeyZ, KeyX, Space). Used for your own tank and, on a game
// server, for every tank a person is driving over the network. Returns the nitro boost factor.
// Everything that moves the tank: hull, turret, speed, collisions. Returns the speed boost (for the engine sound).
// A browser playing online runs just this for its own tank to answer the keys at once (see "Online play").
function driveBody(t, input, dt) {
  const throttle = (input.KeyW ? 1 : 0) - (input.KeyS ? 1 : 0);
  const turn = (input.KeyA ? 1 : 0) - (input.KeyD ? 1 : 0);
  const turretTurn = (input.KeyZ ? 1 : 0) - (input.KeyX ? 1 : 0);
  // A tap turns the turret slowly for fine aim; holding speeds it up along a
  // smooth S-curve (gentle start, gentle arrival at top speed after TURRET_RAMP).
  // Switching direction starts the ramp again, so corrections stay precise.
  if (!turretTurn || turretTurn !== t.turretDir) t.turretHold = 0;
  t.turretDir = turretTurn;
  if (turretTurn) t.turretHold += dt;
  const r = Math.min(1, t.turretHold / TURRET_RAMP);
  const ramp = r * r * (3 - 2 * r); // smoothstep
  // each turret has its own speed multiplier (turretTurn in WEAPONS)
  const turretSpeed = (TURRET_MIN_SPEED + (TURRET_MAX_SPEED - TURRET_MIN_SPEED) * ramp) * t.weapon.turretTurn * frozenFactor(t);
  const hullDelta = turn * t.hull.turn * frozenFactor(t) * dt;
  t.heading += hullDelta;
  // the turret is mounted on the hull: it turns with the hull, plus Z / X on top
  t.turretYaw += hullDelta + turretTurn * turretSpeed * dt;
  // C: swing the turret back to point straight ahead over the hull.
  // Z / X cancel it; the last few degrees slow down so it settles smoothly.
  if (turretTurn) t.centering = false;
  if (t.centering) {
    const off = angleDiff(t.heading, t.turretYaw);
    const step = TURRET_MAX_SPEED * t.weapon.turretTurn * frozenFactor(t) * dt;
    const move = Math.min(Math.abs(off), step * clamp(Math.abs(off) / 0.25, 0.25, 1));
    t.turretYaw += Math.sign(off) * move;
    if (Math.abs(off) < 0.002) {
      t.turretYaw = t.heading;
      t.centering = false;
    }
  }
  const boost = t.buffs.nitro > 0 ? NITRO_BOOST : 1;
  const target = (throttle > 0 ? t.hull.speed : throttle < 0 ? -t.hull.reverse : 0) * boost * frozenFactor(t);
  t.speed += (target - t.speed) * (1 - Math.exp(-6 * dt));
  moveTank(t, t.speed, dt);
  t.sync();
  return boost;
}

function driveTank(t, input, dt) {
  const boost = driveBody(t, input, dt);
  updateWeapon(t, dt, !!input.Space);
  t.updateBuffs(dt);
  updateFreeze(t, dt);
  t.sync();
  return boost;
}

function updatePlayer(dt) {
  if (!player.alive) {
    Sound.engine(0, false, false);
    return;
  }
  const boost = driveTank(player, keys, dt);
  Sound.engine(player.speed, true, boost > 1);
}

// ---------- Bots ----------
// nearest living tank, preferring ones in line of sight
function pickTarget(bot) {
  // in Capture the Flag, whoever is running off with your flag comes first
  if (mode.id === 'ctf') {
    const c = flags[bot.team].carrier;
    if (c && c.alive && Math.hypot(c.pos.x - bot.pos.x, c.pos.z - bot.pos.z) < 60) return c;
  }
  let best = null;
  let bestScore = Infinity;
  for (const t of tanks) {
    if (!t.alive || !isEnemy(bot, t)) continue;
    const d = Math.hypot(t.pos.x - bot.pos.x, t.pos.z - bot.pos.z);
    const score = d + (hasLineOfSight(bot.pos, t.pos) ? 0 : 25);
    if (score < bestScore) { bestScore = score; best = t; }
  }
  return best;
}

// a nearby landed crate this bot would like to grab
function wantedDrop(bot) {
  let best = null;
  let bestD = 22;
  for (const d of drops) {
    if (!d.landed) continue;
    const dd = Math.hypot(d.x - bot.pos.x, d.z - bot.pos.z);
    if (dd > bestD) continue;
    const want = d.type === 'repair' ? bot.hp < bot.maxHp * 0.7 : d.type !== 'crystal' && !(bot.buffs[d.type] > 0);
    if (want) { best = d; bestD = dd; }
  }
  return best ? { drop: best, dist: bestD } : null;
}

// where a bot wants to drive in Capture the Flag (null = just fight)
function ctfGoal(bot) {
  const own = flags[bot.team];
  const enemy = flags[otherTeam(bot.team)];
  if (bot.carrying) return own.home;
  if (own.state === 'dropped') return { x: own.x, z: own.z }; // go and return it
  if (own.state === 'carried') return { x: own.carrier.pos.x, z: own.carrier.pos.z }; // chase the thief
  if (bot.role === 'attack') {
    if (enemy.state === 'carried') return { x: enemy.carrier.pos.x, z: enemy.carrier.pos.z }; // escort
    return { x: enemy.x, z: enemy.z };
  }
  // defenders hang around their own base
  return Math.hypot(bot.pos.x - own.home.x, bot.pos.z - own.home.z) > 12 ? own.home : null;
}

function updateBot(bot, dt) {
  if (!bot.alive) return;
  const w = bot.weapon;

  bot.retargetTimer -= dt;
  if (bot.retargetTimer <= 0 || !bot.target || !bot.target.alive) {
    bot.target = pickTarget(bot);
    bot.retargetTimer = 1 + Math.random();
  }
  const target = bot.target;

  let desired;
  let throttle;
  let dist = Infinity;
  let aim = bot.heading;
  if (target) {
    const dx = target.pos.x - bot.pos.x;
    const dz = target.pos.z - bot.pos.z;
    dist = Math.hypot(dx, dz);
    aim = Math.atan2(dx, dz);
    desired = aim;
    // each weapon has a preferred fighting distance
    throttle = dist > w.keep[1] ? 1 : dist < w.keep[0] ? -0.6 : 0;
  } else {
    bot.wanderTimer -= dt;
    if (bot.wanderTimer <= 0) {
      bot.wanderTimer = 2 + Math.random() * 2;
      bot.wanderHeading = Math.random() * Math.PI * 2;
    }
    desired = bot.wanderHeading;
    throttle = 0.6;
  }

  // somewhere to drive other than straight at the target: a flag objective,
  // a useful crate, or a target hiding behind cover. These use pathfinding.
  let goal = mode.id === 'ctf' ? ctfGoal(bot) : null;
  if (goal && !bot.carrying && Math.hypot(goal.x - bot.pos.x, goal.z - bot.pos.z) < 2.5) goal = null;
  const want = wantedDrop(bot);
  if (!goal && want && (!target || want.dist < dist * 0.9 || bot.hp < bot.maxHp * 0.4)) goal = { x: want.drop.x, z: want.drop.z };
  const seen = !!target && hasLineOfSight(bot.pos, target.pos);
  if (!goal && target && !seen) goal = { x: target.pos.x, z: target.pos.z };
  if (goal) {
    desired = navHeading(bot, goal.x, goal.z, dt);
    throttle = 1;
  } else {
    bot.path = null;
  }

  // simple obstacle avoidance: if the way ahead is blocked, commit to a side for a moment
  if (goal) {
    bot.avoidTimer = 0; // the path already goes around cover
  } else if (bot.avoidTimer > 0) {
    bot.avoidTimer -= dt;
    desired = bot.avoidHeading;
  } else if (throttle > 0 && pathBlocked(bot, bot.heading)) {
    const leftClear = !pathBlocked(bot, bot.heading + 0.9);
    const rightClear = !pathBlocked(bot, bot.heading - 0.9);
    let side = bot.avoidSide;
    if (leftClear && !rightClear) side = 1;
    else if (rightClear && !leftClear) side = -1;
    bot.avoidHeading = bot.heading + side * 1.3;
    bot.avoidTimer = 0.7;
    desired = bot.avoidHeading;
  }

  // stuck detection: back up and turn if we barely moved
  bot.stuckTimer -= dt;
  if (bot.stuckTimer <= 0) {
    const moved = Math.hypot(bot.pos.x - bot.lastX, bot.pos.z - bot.lastZ);
    if (throttle !== 0 && moved < 1.5 && bot.unstick <= 0) {
      bot.unstick = 0.9;
      bot.avoidSide = -bot.avoidSide;
    }
    bot.lastX = bot.pos.x;
    bot.lastZ = bot.pos.z;
    bot.stuckTimer = 1;
  }
  if (bot.unstick > 0) {
    bot.unstick -= dt;
    throttle = -0.8;
    desired = bot.heading + bot.avoidSide * 1.5;
  }

  const diff = angleDiff(desired, bot.heading);
  const ice = frozenFactor(bot); // an enemy Freezer slows driving and turning
  const botTurn = bot.hull.turn * BOT_TURN_FACTOR * ice;
  bot.heading += clamp(diff, -botTurn * dt, botTurn * dt);
  const slow = throttle > 0 && Math.abs(diff) > 1.2 ? 0.3 : 1;
  const boost = bot.buffs.nitro > 0 ? NITRO_BOOST : 1;
  bot.speed = throttle * bot.hull.speed * BOT_SPEED_FACTOR * slow * boost * ice;
  moveTank(bot, bot.speed, dt);

  // turret tracks the target; fire when roughly on aim with a clear line
  const turretTarget = target ? aim : bot.heading;
  const tdiff = angleDiff(turretTarget, bot.turretYaw);
  bot.turretYaw += clamp(tdiff, -BOT_TURRET_TURN * ice * dt, BOT_TURRET_TURN * ice * dt);
  let trigger = false;
  if (target) {
    const off = Math.abs(tdiff);
    if (w.kind === 'flame') trigger = dist < w.range + 0.5 && off < w.cone;
    else if (w.kind === 'rail') trigger = dist < 80 && off < 0.06;
    else trigger = dist < w.range && off < 0.12;
    trigger = trigger && seen;
  }
  updateWeapon(bot, dt, trigger);
  bot.updateBuffs(dt);
  updateFreeze(bot, dt);
  bot.sync();
}

const BAR_ALLY = 0x3d8bff;
const BAR_ENEMY = 0xff3b30;

function updateBotBars() {
  for (const bot of bots) {
    if (!bot.alive) continue;
    bot.bar.position.set(bot.pos.x, bot.turretY + 2.2, bot.pos.z);
    bot.bar.quaternion.copy(camera.quaternion);
    bot.tag.position.set(bot.pos.x, bot.turretY + 2.8, bot.pos.z);
    bot.barFg.scale.x = Math.max(bot.hp / bot.maxHp, 0.001);
    // blue = on your team, red = enemy (everyone is an enemy in free-for-all)
    bot.barFg.material.color.set(isEnemy(player, bot) ? BAR_ENEMY : BAR_ALLY);
  }
}

// ---------- Camera ----------
let camYaw = 0;
const camTarget = new THREE.Vector3();

// Q / E zoom. 0 = normal chase view, 1 = straight above the tank,
// below 0 = a bit closer than normal. Holding a key moves it slowly.
const ZOOM_MIN = -0.35;
const ZOOM_MAX = 1;
const ZOOM_SPEED = 0.5; // per second of holding
let zoomTarget = 0;
let zoom = 0;
const lerp = (a, b, t) => a + (b - a) * t;

function updateCamera(dt, snap = false) {
  camYaw = snap ? player.turretYaw : camYaw + angleDiff(player.turretYaw, camYaw) * (1 - Math.exp(-8 * dt));
  const fx = Math.sin(camYaw), fz = Math.cos(camYaw);
  const p = player.pos;

  const zoomInput = (keys.KeyQ ? 1 : 0) - (keys.KeyE ? 1 : 0);
  if (state === 'playing') zoomTarget = clamp(zoomTarget + zoomInput * ZOOM_SPEED * dt, ZOOM_MIN, ZOOM_MAX);
  zoom = snap ? zoomTarget : zoom + (zoomTarget - zoom) * (1 - Math.exp(-6 * dt));
  const out = Math.max(zoom, 0); // how far towards the overhead view
  const near = Math.max(-zoom, 0) / -ZOOM_MIN; // how far towards the close view
  // the first steps out are gentle; the camera climbs faster near the top
  let height = lerp(5.2, 62, Math.pow(out, 1.5)) - 1.6 * near;
  let back = lerp(9.5, 2.5, out) - 3 * near;
  const ahead = lerp(20, 3, out);
  const lookY = lerp(1.6, 0, out);
  // bigger hulls get a slightly longer, higher camera
  const size = Math.sqrt(player.hull.dims.H);
  height *= size;
  back *= size;

  // a low camera is pulled in so it never ends up behind an outer wall
  if (height < 8) {
    const bound = ARENA - 0.5;
    for (const [c, u] of [[p.x, -fx], [p.z, -fz]]) {
      if (u > 1e-6) back = Math.min(back, (bound - c) / u);
      else if (u < -1e-6) back = Math.min(back, (-bound - c) / u);
    }
    back = Math.max(back, 2);
  }
  shake = Math.max(0, shake - dt * 2.5);
  const j = shake * shake * 0.6;
  camera.position.set(p.x - fx * back + rnd(-j, j), height + rnd(-j, j), p.z - fz * back + rnd(-j, j));
  camTarget.set(p.x + fx * ahead, lookY, p.z + fz * ahead);
  camera.lookAt(camTarget);
  Sound.setListener(p.x, p.z, camYaw);
}

// ---------- Minimap ----------
const mm = hud.minimap.getContext('2d');
const MM_SIZE = 360; // canvas pixels (shown at 180 CSS px)
const MM_RANGE = 62; // world units from centre to edge

function drawMinimap() {
  const g = mm;
  const c = MM_SIZE / 2;
  const s = c / MM_RANGE;
  const fx = Math.sin(camYaw), fz = Math.cos(camYaw);
  const rx = -fz, rz = fx; // camera right
  const P = player.pos;
  // rotated so the turret direction always points up
  const at = (x, z) => {
    const vx = x - P.x, vz = z - P.z;
    return [c + (vx * rx + vz * rz) * s, c - (vx * fx + vz * fz) * s];
  };
  const poly = (pts) => {
    g.beginPath();
    pts.forEach(([x, z], i) => {
      const [px, py] = at(x, z);
      if (i) g.lineTo(px, py);
      else g.moveTo(px, py);
    });
    g.closePath();
  };
  const arrow = (t, size) => {
    const hx = Math.sin(t.heading), hz = Math.cos(t.heading);
    const x = t.pos.x, z = t.pos.z;
    poly([
      [x + hx * size * 1.6, z + hz * size * 1.6],
      [x - hx * size + hz * size, z - hz * size - hx * size],
      [x - hx * size * 0.4, z - hz * size * 0.4],
      [x - hx * size - hz * size, z - hz * size + hx * size],
    ]);
  };

  g.clearRect(0, 0, MM_SIZE, MM_SIZE);
  g.save();
  g.beginPath();
  g.arc(c, c, c - 2, 0, Math.PI * 2);
  g.clip();
  g.fillStyle = 'rgba(8,12,18,0.6)';
  g.fillRect(0, 0, MM_SIZE, MM_SIZE);
  // range rings
  g.strokeStyle = 'rgba(255,255,255,0.07)';
  g.lineWidth = 2;
  for (const r of [20, 40]) {
    g.beginPath();
    g.arc(c, c, r * s, 0, Math.PI * 2);
    g.stroke();
  }
  // view cone
  g.fillStyle = 'rgba(255,194,61,0.08)';
  g.beginPath();
  g.moveTo(c, c);
  g.lineTo(c - c * 0.75, 0);
  g.lineTo(c + c * 0.75, 0);
  g.closePath();
  g.fill();
  // arena floor and cover
  poly([[-ARENA, -ARENA], [ARENA, -ARENA], [ARENA, ARENA], [-ARENA, ARENA]]);
  g.fillStyle = 'rgba(255,255,255,0.05)';
  g.fill();
  g.strokeStyle = 'rgba(255,255,255,0.3)';
  g.stroke();
  g.fillStyle = 'rgba(200,206,215,0.6)';
  for (const b of boxes) {
    poly([[b.minX, b.minZ], [b.maxX, b.minZ], [b.maxX, b.maxZ], [b.minX, b.maxZ]]);
    g.fill();
  }
  // crates
  for (const d of drops) {
    const [x, y] = at(d.x, d.z);
    g.fillStyle = DROP_TYPES[d.type].css;
    if (d.landed) {
      g.fillRect(x - 7, y - 7, 14, 14);
    } else {
      g.globalAlpha = 0.6;
      g.beginPath();
      g.arc(x, y, 6, 0, Math.PI * 2);
      g.fill();
      g.globalAlpha = 1;
    }
  }
  // flag bases and flags
  if (mode.id === 'ctf') {
    for (const f of Object.values(flags)) {
      const css = TEAMS[f.team].css;
      const [bx, by] = at(f.home.x, f.home.z);
      g.strokeStyle = css;
      g.lineWidth = 3;
      g.beginPath();
      g.arc(bx, by, 3 * s, 0, Math.PI * 2);
      g.stroke();
      if (f.state === 'carried') continue; // drawn on the carrier instead
      const [x, y] = at(f.x, f.z);
      g.fillStyle = css;
      g.fillRect(x - 1.5, y - 16, 3, 18);
      g.beginPath();
      g.moveTo(x + 1.5, y - 16);
      g.lineTo(x + 15, y - 11);
      g.lineTo(x + 1.5, y - 6);
      g.closePath();
      g.fill();
    }
  }
  // tanks (a carrier gets a ring in the colour of the flag it holds)
  for (const t of tanks) {
    if (!t.alive || !t.carrying) continue;
    const [x, y] = at(t.pos.x, t.pos.z);
    g.strokeStyle = TEAMS[t.carrying.team].css;
    g.lineWidth = 4;
    g.beginPath();
    g.arc(x, y, 18, 0, Math.PI * 2);
    g.stroke();
  }
  g.lineWidth = 3;
  g.strokeStyle = 'rgba(8,12,18,0.9)';
  for (const b of bots) {
    if (!b.alive) continue;
    arrow(b, 1.9);
    g.fillStyle = b.colorCss;
    g.fill();
    g.stroke();
  }
  if (player.alive) {
    arrow(player, 2.4);
    g.fillStyle = '#ffffff';
    g.fill();
    g.strokeStyle = player.colorCss;
    g.stroke();
  }
  g.restore();
  g.strokeStyle = 'rgba(255,255,255,0.22)';
  g.lineWidth = 3;
  g.beginPath();
  g.arc(c, c, c - 2, 0, Math.PI * 2);
  g.stroke();
}

// ---------- HUD ----------
$('player-swatch').style.background = player.colorCss;
const RING_LEN = 2 * Math.PI * 22;

let damageFlash = 0;
let hitMarker = 0;
let killMsgTime = 0;
let toastTime = 0;
let gainTime = 0;
let buffKey = '';
let matchCrystals = 0;
const feed = [];

function updateWallets() {
  hud.crystals.textContent = progress.crystals;
  hud.menuCrystals.textContent = progress.crystals;
}

function earnCrystals(n) {
  progress.crystals += n;
  matchCrystals += n;
  saveProgress();
  updateWallets();
  hud.crystalGain.textContent = `+${n}`;
  gainTime = 1.4;
}

function pushFeed(html, mine) {
  const el = document.createElement('div');
  el.className = `kf${mine ? ' mine' : ''}`;
  el.innerHTML = html;
  hud.killfeed.prepend(el);
  feed.push({ el, t: 5 });
  while (hud.killfeed.children.length > 5) hud.killfeed.lastChild.remove();
}

function addKillFeed(killer, victim) {
  pushFeed(`${tankLabel(killer)}<span class="kf-icon">${killer.weapon.name}</span>${tankLabel(victim)}`, killer.isPlayer || victim.isPlayer);
}

// the team score bar at the top (team modes only), with flag status in CTF
const FLAG_STATUS = { home: 'At base', carried: 'Taken', dropped: 'Dropped' };
function updateTeamBar() {
  hud.teamBar.classList.toggle('hidden', !mode.teams);
  if (!mode.teams) return;
  hud.scoreBlue.textContent = teamScore.blue;
  hud.scoreRed.textContent = teamScore.red;
  hud.teamGoal.textContent = mode.goal;
  hud.teamMode.textContent = mode.id === 'ctf' ? 'Captures' : 'Kills';
  for (const team of ['blue', 'red']) {
    const el = team === 'blue' ? hud.flagBlue : hud.flagRed;
    const f = flags[team];
    el.textContent = f.state === 'dropped' ? `Dropped ${Math.ceil(f.dropTimer)}s` : FLAG_STATUS[f.state];
    el.className = `flag-state ${f.state}${mode.id === 'ctf' ? '' : ' hidden'}`;
  }
}

function showKillMsg(victim) {
  hud.killMsg.innerHTML = `Eliminated <b style="color:${victim.colorCss}">${victim.name}</b>`;
  killMsgTime = 1.6;
}

function showToast(text, color) {
  hud.toast.textContent = text;
  hud.toast.style.color = color;
  toastTime = 1.8;
}

function updateWeaponHud() {
  const p = player;
  const w = p.weapon;
  let fill = 0;
  let text = '-';
  let cls = '';
  if (p.alive && w.kind === 'flame') {
    fill = p.fuel / 100;
    text = p.overheat ? 'EMPTY' : `${Math.round(p.fuel)}%`;
    cls = p.overheat ? 'empty' : w.ice ? 'coolant' : 'fuel';
  } else if (p.alive && w.kind === 'rail' && p.charge > 0) {
    fill = 1 - p.charge / w.charge;
    text = 'CHARGING';
    cls = 'charge';
  } else if (p.alive) {
    fill = 1 - clamp(p.reload / w.reload, 0, 1);
    text = fill >= 1 ? 'READY' : `${Math.max(0, p.reload).toFixed(1)}s`;
    cls = fill >= 1 ? 'ready' : '';
  }
  hud.weaponLabel.textContent = w.kind === 'flame' ? (w.ice ? 'Coolant' : 'Fuel') : w.name;
  hud.weaponName.textContent = w.name;
  hud.reloadText.textContent = text;
  hud.reloadFill.style.width = `${fill * 100}%`;
  hud.reloadFill.className = `fill ${cls}`;
  hud.reloadRing.style.strokeDashoffset = `${RING_LEN * (1 - fill)}`;
  hud.reloadRing.setAttribute('class', cls === 'fuel' || cls === 'coolant' ? 'ready' : cls);
}

function updateBuffHud() {
  const active = player.alive ? BUFFS.filter((k) => player.buffs[k] > 0) : [];
  const key = active.join(',');
  if (key !== buffKey) {
    buffKey = key;
    hud.buffs.innerHTML = active.map((k) => {
      const d = DROP_TYPES[k];
      return `<div class="buff" style="border-color:${d.css}"><span class="ico" style="background:${d.css}"><img src="${dropIconUrl(k)}" alt=""></span>${d.name}<span class="time" data-k="${k}"></span></div>`;
    }).join('');
  }
  for (const el of hud.buffs.querySelectorAll('.time')) el.textContent = `${Math.ceil(player.buffs[el.dataset.k])}s`;
}

function updateHud(dt) {
  hud.kills.textContent = player.kills;
  hud.killGoal.textContent = mode.teams ? '' : `/ ${mode.goal}`;
  hud.killProgress.parentElement.classList.toggle('hidden', mode.teams);
  hud.killProgress.style.width = `${(Math.min(player.kills, mode.goal) / mode.goal) * 100}%`;
  updateTeamBar();

  const f = player.hp / player.maxHp;
  hud.hpFill.style.width = `${f * 100}%`;
  hud.hpFill.classList.toggle('low', f <= 0.4);
  hud.hpText.textContent = Math.ceil(player.hp);

  updateWeaponHud();
  updateBuffHud();

  hitMarker = Math.max(0, hitMarker - dt);
  hud.crosshair.classList.toggle('hit', hitMarker > 0);
  damageFlash = Math.max(0, damageFlash - dt * 2.2);
  hud.frost.style.opacity = player.alive ? player.freeze : 0;
  hud.burn.style.opacity = player.alive ? Math.min(1, player.burnTime / 1.5) * 0.8 : 0;
  hud.damage.style.opacity = damageFlash;
  killMsgTime = Math.max(0, killMsgTime - dt);
  hud.killMsg.style.opacity = Math.min(1, killMsgTime * 2);
  toastTime = Math.max(0, toastTime - dt);
  hud.toast.style.opacity = Math.min(1, toastTime * 2);
  gainTime = Math.max(0, gainTime - dt);
  hud.crystalGain.style.opacity = Math.min(1, gainTime * 2);

  for (let i = feed.length - 1; i >= 0; i--) {
    feed[i].t -= dt;
    feed[i].el.style.opacity = Math.min(1, feed[i].t * 2);
    if (feed[i].t <= 0) {
      feed[i].el.remove();
      feed.splice(i, 1);
    }
  }

  if (player.alive) {
    hud.respawn.classList.add('hidden');
  } else {
    hud.respawn.classList.remove('hidden');
    const k = player.killedBy;
    hud.respawnBy.innerHTML = k ? `by <span style="color:${k.colorCss}">${k.name}</span>` : '';
    hud.respawnTime.textContent = `Respawning in ${Math.max(0, player.respawn).toFixed(1)}s`;
  }
}

function updateScoreboard() {
  const row = (t) => `<tr class="${t.isPlayer ? 'me' : ''}"><td><span class="swatch" style="background:${t.colorCss}"></span>${t.name}${t.carrying ? ' &#9873;' : ''}</td><td class="turret">${t.hull.name} / ${t.weapon.name}</td><td>${t.kills}</td><td>${t.deaths}</td></tr>`;
  const byScore = (a, b) => b.kills - a.kills || a.deaths - b.deaths;
  if (!mode.teams) {
    hud.scoreRows.innerHTML = [...tanks].sort(byScore).map(row).join('');
    return;
  }
  // grouped by team, your team first
  hud.scoreRows.innerHTML = [player.team, otherTeam(player.team)].map((team) =>
    `<tr class="team-row"><td colspan="4" style="color:${TEAMS[team].css}">${TEAMS[team].name} team &middot; ${teamScore[team]}</td></tr>` +
    tanks.filter((t) => t.team === team).sort(byScore).map(row).join('')
  ).join('');
}

function updateSoundHint() {
  hud.soundState.textContent = Sound.muted ? 'off' : 'on';
}

// ---------- Menu ----------
function drawMapPreview(canvas, map) {
  const g = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const th = THEMES[map.theme];
  g.fillStyle = '#0d1218';
  g.fillRect(0, 0, W, H);
  const s = (H - 16) / (ARENA * 2);
  const ox = W / 2, oz = H / 2;
  g.fillStyle = th.preview.ground;
  g.fillRect(ox - ARENA * s, oz - ARENA * s, ARENA * 2 * s, ARENA * 2 * s);
  g.strokeStyle = 'rgba(255,255,255,0.4)';
  g.lineWidth = 2;
  g.strokeRect(ox - ARENA * s, oz - ARENA * s, ARENA * 2 * s, ARENA * 2 * s);
  for (const o of map.obstacles) {
    g.fillStyle = o.color ? `#${new THREE.Color(o.color).getHexString()}` : o.type === 'ice' ? '#cbe6f1' : o.type === 'crates' ? '#8c6a43' : th.preview.block;
    const turned = Math.abs(Math.round((o.rot || 0) / (Math.PI / 2))) % 2 === 1; // a quarter turn swaps width and depth
    const ow = turned ? o.d : o.w, od = turned ? o.w : o.d;
    const x0 = Math.max(o.x - ow / 2, -ARENA), x1 = Math.min(o.x + ow / 2, ARENA);
    g.fillRect(ox + x0 * s, oz + (o.z - od / 2) * s, (x1 - x0) * s, od * s);
  }
  g.fillStyle = '#ffc23d';
  g.beginPath();
  g.arc(ox + map.playerStart.x * s, oz + map.playerStart.z * s, 4, 0, Math.PI * 2);
  g.fill();
}

function buildMenu() {
  for (const m of Object.values(MODES)) {
    const card = document.createElement('div');
    card.className = 'card mode-card';
    card.dataset.id = m.id;
    card.innerHTML = `<div class="name">${m.name}</div><div class="desc">${m.desc}</div>`;
    card.addEventListener('click', () => {
      selectedMode = m.id;
      save('treadstorm-mode', m.id);
      Sound.click();
      refreshMenu();
    });
    hud.modeCards.append(card);
  }
  for (const map of MAPS) {
    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.id = map.id;
    const canvas = document.createElement('canvas');
    canvas.width = 240;
    canvas.height = 120;
    drawMapPreview(canvas, map);
    card.append(canvas);
    card.insertAdjacentHTML('beforeend', `<div class="name">${map.name}</div><div class="desc">${map.desc}</div>`);
    card.addEventListener('click', () => {
      selectedMap = map.id;
      save('treadstorm-map', map.id);
      Sound.click();
      refreshMenu();
    });
    hud.mapCards.append(card);
  }
  for (const h of Object.values(HULLS)) hud.hullCards.append(itemCard('hull', h, ['Armor', 'Speed', 'Weight']));
  for (const w of Object.values(WEAPONS)) hud.weaponCards.append(itemCard('weapon', w, ['Damage', 'Fire rate', 'Range']));
  hud.legend.innerHTML = Object.entries(DROP_TYPES)
    .map(([k, d]) => `<div><i style="background:${d.css}"><img src="${dropIconUrl(k)}" alt=""></i>${d.name}</div>`)
    .join('');
  for (const tab of document.querySelectorAll('.tab')) tab.addEventListener('click', () => showTab(tab.dataset.tab));
  $('to-garage').addEventListener('click', () => showTab('garage'));
}

const pips = (n, max = 5) => Array.from({ length: max }, (_, i) => `<i class="${i < n ? 'on' : ''}"></i>`).join('');
const fmt = (v) => (Math.abs(v - Math.round(v)) < 0.05 ? `${Math.round(v)}` : v.toFixed(1));

function itemCard(type, item, labels) {
  const card = document.createElement('div');
  card.className = 'card';
  card.dataset.id = item.id;
  const stats = item.stats.map((v, i) => `<div class="stat">${labels[i]}<span class="pips">${pips(v)}</span></div>`).join('');
  card.innerHTML = `<div class="card-top"><span class="name">${item.name}</span><span class="lv"></span></div><div class="desc">${item.desc}</div>${stats}`;
  card.addEventListener('click', () => equip(type, item.id));
  return card;
}

let activeTab = 'battle';
function showTab(name) {
  activeTab = name;
  for (const el of document.querySelectorAll('.tab')) el.classList.toggle('active', el.dataset.tab === name);
  $('tab-battle').classList.toggle('hidden', name !== 'battle');
  $('tab-garage').classList.toggle('hidden', name !== 'garage');
  Sound.click();
}

// garage: clicking a hull or turret equips it and shows its upgrades
let garageFocus = { type: 'hull', id: progress.hull };
let loadoutDirty = false;

function equip(type, id) {
  if (type === 'hull') progress.hull = id;
  else progress.weapon = id;
  garageFocus = { type, id };
  saveProgress();
  loadoutDirty = true;
  Sound.click();
  refreshMenu();
}

// the number an upgrade changes, as readable text
function describeStat(type, id, lv, key) {
  if (type === 'hull') {
    const h = hullStats(id, lv);
    return key === 'armor' ? `${h.hp} HP` : `${fmt(h.speed)} speed`;
  }
  const w = weaponStats(id, lv);
  if (key === 'damage' && w.burnDps) return `${fmt(w.dps)} dmg/s +${fmt(w.burnDps)} burn`;
  if (key === 'damage' && w.pellets) return `${w.pellets} x ${fmt(w.damage)} dmg`;
  if (key === 'damage') return w.kind === 'flame' ? `${fmt(w.dps)} dmg/s` : `${fmt(w.damage)} dmg`;
  if (w.kind === 'flame') return `${fmt(100 / w.fuelUse)}s ${w.ice ? 'spray' : 'burn'}`;
  if (w.kind === 'rail') return `${(w.charge + w.reload).toFixed(1)}s cycle`;
  return `${w.reload.toFixed(2)}s reload`;
}

function buyUpgrade(id, key) {
  const lv = progress.levels[id];
  const cur = lv[key] || 0;
  if (cur >= MAX_LEVEL || progress.crystals < UPGRADE_COSTS[cur]) return;
  progress.crystals -= UPGRADE_COSTS[cur];
  lv[key] = cur + 1;
  saveProgress();
  loadoutDirty = true;
  Sound.upgrade();
  refreshMenu();
}

function renderGarage() {
  const levelSum = (id) => Object.values(progress.levels[id]).reduce((s, v) => s + v, 0);
  for (const [cards, equipped] of [[hud.hullCards, progress.hull], [hud.weaponCards, progress.weapon]]) {
    for (const el of cards.children) {
      el.classList.toggle('selected', el.dataset.id === equipped);
      const n = levelSum(el.dataset.id);
      el.querySelector('.lv').textContent = n ? `+${n}` : '';
    }
  }
  const { type, id } = garageFocus;
  const item = type === 'hull' ? HULLS[id] : WEAPONS[id];
  const lv = progress.levels[id];
  const rows = (type === 'hull' ? HULL_UPGRADES : TURRET_UPGRADES).map((u) => {
    const cur = lv[u.key] || 0;
    const maxed = cur >= MAX_LEVEL;
    const cost = UPGRADE_COSTS[cur];
    const now = describeStat(type, id, lv, u.key);
    const next = maxed ? '' : ` <i>&rarr;</i> <b>${describeStat(type, id, { ...lv, [u.key]: cur + 1 }, u.key)}</b>`;
    const stream = type === 'weapon' && WEAPONS[id].kind === 'flame';
    const effect = stream && u.key === 'rate' ? (WEAPONS[id].ice ? '-7% coolant use' : '-7% fuel use') : u.effect;
    return `<div class="upg">
      <div class="upg-top"><span class="upg-name">${u.name}</span><span class="upg-lv">Lv ${cur}/${MAX_LEVEL}</span></div>
      <div class="pips big">${pips(cur, MAX_LEVEL)}</div>
      <div class="upg-row"><span class="upg-val">${now}${next}</span>
        <button class="upg-btn" data-key="${u.key}" ${maxed || progress.crystals < cost ? 'disabled' : ''}>${maxed ? 'Max' : `<i class="gem"></i>${cost}`}</button></div>
      <div class="upg-effect">${effect} per level</div>
    </div>`;
  }).join('');
  hud.garageDetail.innerHTML = `<div class="detail-kind">${type === 'hull' ? 'Hull' : 'Turret'} &middot; equipped</div>
    <div class="detail-name">${item.name}</div><div class="desc">${item.desc}</div>${rows}`;
  for (const b of hud.garageDetail.querySelectorAll('.upg-btn')) b.addEventListener('click', () => buyUpgrade(id, b.dataset.key));
  hud.loadout.innerHTML = `<span><small>Hull</small>${HULLS[progress.hull].name}</span><span><small>Turret</small>${WEAPONS[progress.weapon].name}</span>`;
  updateWallets();
}

let matchStarted = false;
function refreshMenu() {
  for (const el of hud.modeCards.children) el.classList.toggle('selected', el.dataset.id === selectedMode);
  for (const el of hud.mapCards.children) el.classList.toggle('selected', el.dataset.id === selectedMap);
  const changed = currentMap && (selectedMap !== currentMap.id || selectedMode !== mode.id);
  hud.mapNote.classList.toggle('hidden', !(matchStarted && changed));
  renderGarage();
}

// ---------- Game state / input ----------
let state = 'paused'; // 'paused' | 'playing' | 'won'

function play() {
  if (state === 'won') return;
  state = 'playing';
  hud.start.classList.add('hidden');
  Sound.resume();
}

function pause() {
  if (state !== 'playing') return;
  state = 'paused';
  refreshMenu();
  refreshQualityUI();
  hud.start.classList.remove('hidden');
  Sound.pause();
}

function clearEffects() {
  for (const b of bullets) scene.remove(b.mesh);
  bullets.length = 0;
  for (const p of particles) {
    scene.remove(p.mesh);
    if (p.ownMat) p.mat.dispose();
  }
  particles.length = 0;
  for (const b of beams) {
    scene.remove(b.mesh);
    b.mesh.material.dispose();
  }
  beams.length = 0;
  for (const s of scorches) {
    scene.remove(s.mesh);
    s.mesh.material.dispose();
  }
  scorches.length = 0;
  for (const e of lightPool) e.life = 0;
  for (const f of feed) f.el.remove();
  feed.length = 0;
  Sound.stopFlames();
  shake = damageFlash = hitMarker = killMsgTime = toastTime = 0;
}

function resetGame() {
  clearEffects();
  clearDrops();
  matchCrystals = 0;
  teamScore.blue = teamScore.red = 0;
  resetFlags();
  for (const t of tanks) {
    t.kills = 0;
    t.deaths = 0;
    t.killedBy = null;
    t.path = null;
    t.alive = false; // so spawn checks ignore old positions
  }
  // in team modes start beside your flag base rather than on top of it
  const start = mode.teams ? { x: PLAYER_START.x - 10, z: PLAYER_START.z - 1 } : PLAYER_START;
  player.spawnAt(start.x, start.z);
  const distFromStart = (s) => Math.hypot(s.x - start.x, s.z - start.z);
  if (mode.teams) {
    // each team starts on its own side; blue bots keep a little room around the player
    for (const team of ['blue', 'red']) {
      const spots = teamSpawns(team).filter((s) => distFromStart(s) > 6);
      bots.filter((b) => b.team === team).forEach((bot, i) => {
        const s = spots[i % spots.length];
        bot.spawnAt(s.x, s.z);
      });
    }
  } else {
    // bots start at the spawn points furthest from the player
    const far = [...SPAWNS].sort((a, b) => distFromStart(b) - distFromStart(a));
    bots.forEach((bot, i) => bot.spawnAt(far[i % far.length].x, far[i % far.length].z));
  }
  updateCamera(0, true);
  updateHud(0);
}

function endMatch(won, line) {
  state = 'won';
  Sound.stopFlames();
  Sound.engine(0, false, false);
  if (won) {
    Sound.victory();
    earnCrystals(WIN_REWARD);
  } else {
    Sound.defeat();
  }
  hud.winTitle.textContent = won ? 'VICTORY' : 'DEFEAT';
  hud.winTitle.classList.toggle('defeat', !won);
  hud.winTagline.textContent = line;
  hud.winStats.innerHTML = `<b>${player.kills}</b> kills &middot; <b>${player.deaths}</b> deaths
    <div class="win-reward"><i class="gem"></i>+${matchCrystals} crystals earned</div>`;
  hud.win.classList.remove('hidden');
}

$('play-btn').addEventListener('click', (e) => {
  e.currentTarget.blur(); // so Space doesn't re-press the button
  Sound.init();
  Sound.click();
  if (net.on) { // online: the match is already running on the server, just come back to it
    play();
    return;
  }
  if (loadoutDirty) {
    applyLoadout();
    loadoutDirty = false;
  }
  const mapChanged = !currentMap || currentMap.id !== selectedMap;
  if (mapChanged) buildMap(MAPS.find((m) => m.id === selectedMap));
  if (mapChanged || mode.id !== selectedMode) {
    setMode(selectedMode);
    resetGame();
  }
  matchStarted = true;
  play();
});
$('restart-btn').addEventListener('click', (e) => {
  e.currentTarget.blur();
  Sound.click();
  resetGame();
  hud.win.classList.add('hidden');
  state = 'paused';
  play();
});
$('menu-btn').addEventListener('click', (e) => {
  e.currentTarget.blur();
  Sound.click();
  if (net.on) { leaveOnline(); return; }
  resetGame();
  hud.win.classList.add('hidden');
  state = 'paused';
  refreshMenu();
  hud.start.classList.remove('hidden');
});

function showScoreboard(show) {
  hud.scoreboard.classList.toggle('hidden', !show);
  if (show) updateScoreboard();
}

document.addEventListener('keydown', (e) => {
  if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return; // typing a name or an address, picking a map
  // keep Space / Tab from scrolling, pressing buttons or moving focus
  if (e.code === 'Space' || e.code === 'Tab') e.preventDefault();
  keys[e.code] = true;
  if (e.code === 'Tab') showScoreboard(true);
  if (e.code === 'KeyC' && state === 'playing') player.centering = true;
  if (e.code === 'KeyF' && !e.repeat) togglePerf();
  if (e.code === 'KeyM' && !e.repeat) {
    Sound.toggleMute();
    updateSoundHint();
  }
  if (e.code === 'Escape') {
    if (state === 'playing') pause();
    else if (state === 'paused' && matchStarted) $('play-btn').click();
  }
});
document.addEventListener('keyup', (e) => {
  if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;
  keys[e.code] = false;
  if (e.code === 'Tab') showScoreboard(false);
});
// a hidden tab draws no frames, so nothing would tell the server to release the keys: say so, and keep saying hello
function netHush() {
  if (net.on && net.ws && net.ws.readyState === 1) { net.ws.send('{"t":"in","k":{}}'); net.lastKeys = ''; }
}
document.addEventListener('visibilitychange', () => { if (document.hidden) netHush(); });
setInterval(() => { if (document.hidden) netHush(); }, 1000);
// ---------- Touch controls ----------
// Two thumb sticks and a few buttons that press the same keys as the keyboard, so everything else (online play too) is unchanged.
// Left stick: up / down = W / S (drive), left / right = A / D (turn the hull). Right stick: left / right = Z / X (turn the turret).
const touchOn = matchMedia('(pointer: coarse)').matches || new URLSearchParams(location.search).has('touch');
if (touchOn) {
  document.body.classList.add('touch');
  const root = $('touch');
  const DEAD = 0.3;
  // a stick: the knob follows the thumb inside the circle; `apply(dx, dy)` gets the push as -1..1 on each side
  const stick = (el, apply) => {
    const knob = el.querySelector('.tc-knob');
    let id = null;
    const move = (e) => {
      const r = el.getBoundingClientRect();
      const R = r.width / 2;
      let dx = (e.clientX - (r.left + R)) / R, dy = (e.clientY - (r.top + R)) / R;
      const len = Math.hypot(dx, dy);
      if (len > 1) { dx /= len; dy /= len; }
      knob.style.transform = `translate(${dx * R * 0.7}px, ${dy * R * 0.7}px)`;
      apply(dx, dy);
    };
    const end = (e) => {
      if (e.pointerId !== id) return;
      id = null;
      el.classList.remove('on');
      knob.style.transform = '';
      apply(0, 0);
    };
    el.addEventListener('pointerdown', (e) => {
      if (id !== null) return;
      id = e.pointerId;
      el.setPointerCapture(id);
      el.classList.add('on');
      Sound.init();
      move(e);
    });
    el.addEventListener('pointermove', (e) => { if (e.pointerId === id) move(e); });
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  };
  stick($('tc-move'), (dx, dy) => {
    keys.KeyW = dy < -DEAD;
    keys.KeyS = dy > DEAD;
    keys.KeyA = dx < -DEAD;
    keys.KeyD = dx > DEAD;
  });
  stick($('tc-aim'), (dx) => {
    keys.KeyZ = dx < -DEAD;
    keys.KeyX = dx > DEAD;
  });
  // a button that holds a key while it is pressed (or runs `down` once)
  const button = (el, down, up) => {
    let id = null;
    el.addEventListener('pointerdown', (e) => {
      if (id !== null) return;
      id = e.pointerId;
      el.setPointerCapture(id);
      el.classList.add('on');
      Sound.init();
      down();
    });
    const end = (e) => {
      if (e.pointerId !== id) return;
      id = null;
      el.classList.remove('on');
      if (up) up();
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  };
  button($('tc-fire'), () => { keys.Space = true; }, () => { keys.Space = false; });
  button($('tc-center'), () => { keys.KeyC = true; if (state === 'playing') player.centering = true; }, () => { keys.KeyC = false; });
  button($('tc-menu'), () => { if (state === 'playing') pause(); });
  // full screen (not offered where the browser has none, e.g. iPhones)
  const full = $('tc-full');
  if (document.documentElement.requestFullscreen) {
    button(full, () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen().then(() => screen.orientation?.lock?.('landscape').catch(() => {})).catch(() => {});
    });
  } else full.style.display = 'none';
  // pinch on the picture: spread the fingers = closer, pinch = further out (the same zoom as Q / E)
  const fingers = new Map();
  let pinch = 0;
  const cv = renderer.domElement;
  cv.addEventListener('pointerdown', (e) => { fingers.set(e.pointerId, [e.clientX, e.clientY]); pinch = 0; });
  cv.addEventListener('pointermove', (e) => {
    if (!fingers.has(e.pointerId)) return;
    fingers.set(e.pointerId, [e.clientX, e.clientY]);
    if (fingers.size !== 2 || state !== 'playing') return;
    const [a, b] = [...fingers.values()];
    const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
    if (pinch) zoomTarget = clamp(zoomTarget - (d - pinch) / 260, ZOOM_MIN, ZOOM_MAX);
    pinch = d;
  });
  const lift = (e) => { fingers.delete(e.pointerId); pinch = 0; };
  cv.addEventListener('pointerup', lift);
  cv.addEventListener('pointercancel', lift);
  document.addEventListener('contextmenu', (e) => e.preventDefault());
  // shown only while a match is running (the menus are for fingers already)
  let shown = false;
  setInterval(() => {
    const want = state === 'playing';
    if (want === shown) return;
    shown = want;
    root.classList.toggle('hidden', !want);
    if (!want) for (const k of ['KeyW', 'KeyS', 'KeyA', 'KeyD', 'KeyZ', 'KeyX', 'Space', 'KeyC']) keys[k] = false;
  }, 100);
}

window.addEventListener('blur', () => {
  for (const k in keys) keys[k] = false;
  showScoreboard(false);
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
  const px = renderer.getPixelRatio();
  fxaa.material.uniforms.resolution.value.set(1 / (window.innerWidth * px), 1 / (window.innerHeight * px));
});

// ---------- Graphics quality ----------
// scale = render resolution (1 = full), msaa = edge smoothing samples, shadow = shadow map size.
// "Auto" starts high and steps down by itself if the game runs slowly (and remembers where it ended up).
// bloomScale = resolution of the glow effect relative to the picture (it is a wide blur, so it can be coarse).
const QUALITY = {
  low: { name: 'Low', scale: 0.5, msaa: 0, bloom: false, shadow: 1024, particles: 150, ash: 300 },
  medium: { name: 'Balanced', scale: 0.62, msaa: 0, bloom: true, bloomScale: 0.35, shadow: 1024, particles: 320, ash: 800 },
  high: { name: 'High', scale: 1, msaa: 0, fxaa: true, bloom: true, bloomScale: 0.5, shadow: 2048, particles: 500, ash: 1600 },
};
let bloomScale = 0.5;
const bloomSetSize = bloom.setSize.bind(bloom);
bloom.setSize = (w, h) => bloomSetSize(Math.max(1, Math.round(w * bloomScale)), Math.max(1, Math.round(h * bloomScale)));
const QUALITY_ORDER = ['low', 'medium', 'high'];
const AUTO_MIN_FPS = 24; // below this for 3 seconds in a row, Auto goes down a level
let qualityPref = load('treadstorm-quality', 'auto');
if (qualityPref !== 'auto' && !QUALITY[qualityPref]) qualityPref = 'auto';
let qualityLevel = qualityPref === 'auto' ? load('treadstorm-quality-auto', 'medium') : qualityPref;
if (!QUALITY[qualityLevel]) qualityLevel = 'high';
let fpsNow = 0, autoGrace = 2, autoSlow = 0;
const qualitySeg = $('quality-seg');
const qualityNote = $('quality-note');

function applyQuality(level) {
  qualityLevel = level;
  const q = QUALITY[level];
  bloomScale = q.bloomScale ?? 0.5;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2) * q.scale);
  composer.setPixelRatio(renderer.getPixelRatio());
  for (const rt of [composer.renderTarget1, composer.renderTarget2]) {
    rt.samples = q.msaa;
    rt.dispose(); // re-created with the new sample count on the next frame
  }
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
  bloom.enabled = q.bloom;
  fxaa.enabled = !!q.fxaa;
  const px = renderer.getPixelRatio();
  fxaa.material.uniforms.resolution.value.set(1 / (window.innerWidth * px), 1 / (window.innerHeight * px));
  emberOn = level !== 'low';
  sun.shadow.mapSize.set(q.shadow, q.shadow);
  if (sun.shadow.map) {
    sun.shadow.map.dispose();
    sun.shadow.map = null;
  }
  MAX_PARTICLES = q.particles;
  snowActive = q.ash;
  snowGeo.setDrawRange(0, snowActive);
  autoGrace = 2;
  autoSlow = 0;
}

function refreshQualityUI() {
  for (const b of qualitySeg.children) b.classList.toggle('on', b.dataset.q === qualityPref);
  const now = QUALITY[qualityLevel].name;
  qualityNote.textContent = `${qualityPref === 'auto' ? `Auto \u00b7 now ${now}` : now} \u00b7 ${Math.round(fpsNow)} fps`;
}

for (const b of qualitySeg.children) {
  b.addEventListener('click', () => {
    qualityPref = b.dataset.q;
    save('treadstorm-quality', qualityPref);
    applyQuality(qualityPref === 'auto' ? qualityLevel : qualityPref);
    Sound.click();
    refreshQualityUI();
  });
}

// live FPS readout (key F shows or hides it). There is no network in this game, so no ping:
// the frame time and the slowest frame of the last second are the real "lag" numbers here.
const perfEl = $('perf');
const perfFps = $('perf-fps');
const perfMs = $('perf-ms');
let perfOn = load('treadstorm-perf', 'on') !== 'off';
perfEl.classList.toggle('hidden', !perfOn);
function togglePerf() {
  perfOn = !perfOn;
  save('treadstorm-perf', perfOn ? 'on' : 'off');
  perfEl.classList.toggle('hidden', !perfOn);
}

let fpsStart = 0, fpsFrames = 0, fpsLast = 0, fpsWorst = 0;
function meterFps(now) {
  if (fpsLast) fpsWorst = Math.max(fpsWorst, now - fpsLast);
  fpsLast = now;
  if (!fpsStart) fpsStart = now;
  fpsFrames++;
  if (now - fpsStart < 1000) return;
  fpsNow = (fpsFrames * 1000) / (now - fpsStart);
  if (perfOn) {
    perfFps.textContent = Math.round(fpsNow);
    perfFps.className = fpsNow >= 50 ? 'good' : fpsNow >= 24 ? 'ok' : 'bad';
    perfMs.textContent = `${(1000 / fpsNow).toFixed(0)} ms · worst ${Math.round(fpsWorst)} ms · ${QUALITY[qualityLevel].name}`;
  }
  fpsWorst = 0;
  fpsFrames = 0;
  fpsStart = now;
  if (qualityPref === 'auto' && state === 'playing') {
    if (autoGrace > 0) {
      autoGrace--;
    } else if (fpsNow < AUTO_MIN_FPS && qualityLevel !== 'low') {
      if (++autoSlow >= 3) {
        applyQuality(QUALITY_ORDER[QUALITY_ORDER.indexOf(qualityLevel) - 1]);
        save('treadstorm-quality-auto', qualityLevel);
      }
    } else {
      autoSlow = 0;
    }
  }
  if (!hud.start.classList.contains('hidden')) refreshQualityUI();
}

// ---------- Online play: this browser as a client of a game server ----------
// The server runs the match (these same rules, with no screen). The browser only sends the keys you hold and draws
// what the server reports. Your tank is `player`; every other tank is a puppet: a local Tank object that is moved
// from the server's snapshots. The world is drawn a little in the past (netDelay) so there are always two snapshots to blend.
const NET_TICK_MS = 1000 / 30; // the server counts its game steps 30 times a second
const NET_SNAP_DIST = 4; // units: if my predicted tank is further than this from the server's, jump to the server's
const NET_FIX_DEADZONE = 0.3; // units: smaller differences are not worth correcting
const NET_FIX_RATE = 0.3; // part of a difference corrected at each snapshot
const NET_EXTRAPOLATE_MAX = 160; // ms: if a snapshot is late, keep moving things along their last velocity for at most this long
const PLAYER_COLOR = 0x3a78c9;
const net = { hist: [], predAt: 0, predicting: false, rtt: 100, err: 0, events: [], lobby: false, lobbyTimer: 0, on: false, joining: false, ws: null, you: -1, puppets: [], snaps: [], lastKeys: '', lastSend: 0, pingAt: 0, ping: 0, pings: [], offsets: [], offset: 0, spare: null, badgeAt: 0, frameMs: 33, lastNow: 0 };
const netEls = {
  name: $('net-name'), url: $('net-url'), join: $('net-join'), rooms: $('net-rooms'), status: $('net-status'), badge: $('net-badge'),
  lobby: $('lobby'), list: $('lobby-list'), server: $('lobby-server'), map: $('lobby-map'), mode: $('lobby-mode'), create: $('lobby-create'), msg: $('lobby-msg'),
};

function netSay(text, bad = false) {
  netEls.status.textContent = text;
  netEls.status.classList.toggle('bad', bad);
}

function defaultServerUrl() {
  const saved = load('treadstorm-server', '');
  if (saved && !(location.protocol === 'https:' && saved.startsWith('ws://'))) return saved; // (a plain ws:// address cannot work from a secure page)
  const asked = new URLSearchParams(location.search).get('server');
  if (asked) return asked;
  if (import.meta.env.VITE_SERVER_URL) return import.meta.env.VITE_SERVER_URL; // the address baked in when building for the web
  return location.protocol === 'https:' ? '' : `ws://${location.hostname || 'localhost'}:8787`;
}
netEls.name.value = load('treadstorm-name', '');
netEls.url.value = defaultServerUrl();

// the server address from the menu, made safe (or '' after telling the person what is wrong)
function netAddress() {
  let url = netEls.url.value.trim();
  if (!url) { netSay('Type the server address first, for example ws://localhost:8787', true); return ''; }
  if (!/^wss?:\/\//.test(url)) url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + url;
  if (location.protocol === 'https:' && url.startsWith('ws://') && !/^ws:\/\/(localhost|127\.0\.0\.1)/.test(url)) {
    netSay('This page is secure (https), so the server address must start with wss://', true);
    return '';
  }
  return url;
}

// opens the connection; `onOpen` says what to ask first (the list of rooms, or to join)
function netConnect(url, onOpen) {
  save('treadstorm-server', url);
  save('treadstorm-name', netEls.name.value.trim());
  Sound.init();
  Sound.click();
  let ws;
  try { ws = new WebSocket(url); } catch { netSay('That is not a valid server address.', true); return false; }
  net.ws = ws;
  netEls.join.textContent = 'Cancel';
  netSay('Connecting...');
  const giveUp = setTimeout(() => { if (net.ws === ws && ws.readyState !== 1) leaveOnline('Could not reach the server (no answer).'); }, 8000);
  ws.onopen = () => { clearTimeout(giveUp); onOpen(ws); };
  ws.onmessage = (e) => netMessage(e.data);
  ws.onerror = () => {};
  ws.onclose = () => {
    clearTimeout(giveUp);
    if (net.ws !== ws) return;
    leaveOnline(net.on ? 'Disconnected from the server.' : 'Could not connect to the server.');
  };
  return true;
}

const netJoinMessage = (extra = {}) => JSON.stringify({ t: 'join', name: netEls.name.value.trim() || 'Player', hull: progress.hull, weapon: progress.weapon, ...extra });

// `extra`: { room } to join a room from the list, { create: {map, mode} } to open a new one; nothing = the first room with space
function netJoin(extra = {}) {
  if (net.on || (net.joining && !net.lobby)) {
    leaveOnline();
    return;
  }
  if (net.lobby && net.ws && net.ws.readyState === 1) { // already talking to the server from the room list
    net.joining = true;
    net.ws.send(netJoinMessage(extra));
    netMsg('Joining...');
    return;
  }
  const url = netAddress();
  if (!url) return;
  net.joining = true;
  if (!netConnect(url, (ws) => ws.send(netJoinMessage(extra)))) net.joining = false;
}

// ---- the room list
const netMsg = (text, bad = false) => { netEls.msg.textContent = text; netEls.msg.classList.toggle('bad', bad); };

function netOpenLobby() {
  if (net.on || net.joining) return;
  const url = netAddress();
  if (!url) return;
  if (!netEls.map.children.length) {
    for (const m of MAPS) netEls.map.add(new Option(m.name, m.id));
    for (const m of Object.values(MODES)) netEls.mode.add(new Option(m.name, m.id));
  }
  netEls.map.value = selectedMap;
  netEls.mode.value = selectedMode;
  netEls.server.textContent = url.replace(/^wss?:\/\//, '');
  netEls.list.innerHTML = '<div class="lobby-empty">Connecting...</div>';
  netMsg('');
  netEls.lobby.classList.remove('hidden');
  net.lobby = true;
  const ask = () => { if (net.ws && net.ws.readyState === 1) net.ws.send('{"t":"rooms"}'); };
  const ok = netConnect(url, (ws) => {
    ws.send('{"t":"rooms"}');
    net.lobbyTimer = setInterval(ask, 3000); // also keeps the server from dropping a quiet connection
  });
  if (!ok) closeLobby();
}

function closeLobby(keepConnection = false) {
  clearInterval(net.lobbyTimer);
  net.lobbyTimer = 0;
  net.lobby = false;
  netEls.lobby.classList.add('hidden');
  if (!keepConnection && !net.on && net.ws) leaveOnline();
}

function netShowRooms(list) {
  netEls.list.textContent = '';
  if (!list.length) {
    netEls.list.innerHTML = '<div class="lobby-empty">No rooms are open. Open one below.</div>';
    return;
  }
  for (const r of list) {
    const row = document.createElement('div');
    const full = r.players >= r.slots;
    row.className = `lobby-row${full ? ' full' : ''}`;
    const name = document.createElement('span');
    name.className = 'rn';
    name.textContent = r.name;
    const count = document.createElement('span');
    count.className = 'rp';
    count.textContent = `${r.players} / ${r.slots} players`;
    const btn = document.createElement('button');
    btn.className = 'ghost small';
    btn.textContent = full ? 'Full' : 'Join';
    btn.disabled = full;
    btn.addEventListener('click', () => netJoin({ room: r.id }));
    row.append(name, count, btn);
    netEls.list.append(row);
  }
}

netEls.join.addEventListener('click', () => netJoin());
netEls.rooms.addEventListener('click', netOpenLobby);
$('lobby-close').addEventListener('click', () => closeLobby());
netEls.create.addEventListener('click', () => netJoin({ create: { map: netEls.map.value, mode: netEls.mode.value } }));

// put the bots back as they were before a server changed their names, colours and turrets
function restoreBots() {
  botPool.forEach((b, i) => {
    const [name, color, hull, weapon] = BOT_DEFS[i];
    b.name = name;
    b.ffaColor = color;
    if (b.hullId !== hull) b.setHull(hull, {});
    if (b.weaponId !== weapon) b.setWeapon(weapon, {});
    b.remote = null;
    b.drawTag();
  });
}

function leaveOnline(message = '') {
  const ws = net.ws;
  net.ws = null;
  if (ws) { ws.onclose = null; try { ws.close(); } catch { /* already closed */ } }
  const wasOn = net.on;
  net.on = false;
  net.joining = false;
  clearInterval(net.lobbyTimer);
  net.lobby = false;
  netEls.lobby.classList.add('hidden');
  netEls.rooms.disabled = false;
  net.snaps.length = 0;
  net.events.length = 0;
  net.puppets = [];
  net.spare = null;
  netEls.join.textContent = 'Join online';
  netEls.badge.classList.add('hidden');
  $('restart-btn').classList.remove('hidden');
  if (wasOn) { // back to your own offline game
    restoreBots();
    player.name = 'You';
    player.setColor(PLAYER_COLOR);
    $('player-swatch').style.background = '';
    const wanted = MAPS.find((m) => m.id === selectedMap);
    if (!currentMap || currentMap.id !== wanted.id) buildMap(wanted);
    botExtra = 0;
    setMode(selectedMode);
    applyLoadout();
    resetGame();
    hud.win.classList.add('hidden');
    state = 'paused';
    matchStarted = false;
    refreshMenu();
    hud.start.classList.remove('hidden');
    Sound.stopFlames();
    Sound.engine(0, false, false);
  }
  netSay(message, !!message);
}

function netMessage(raw) {
  let m;
  try { m = JSON.parse(raw); } catch { return; }
  if (m.t === 'snap') {
    // server time of this snapshot, and the best (smallest) delivery delay seen lately = how the two clocks line up
    netAddSnapshot(m.k, m.a, performance.now());
    netReconcile(m.k * NET_TICK_MS, m.a);
    netWorld(m);
    if (m.e) {
      for (const e of m.e) {
        // what happens to my own tank is shown the moment I hear of it (my tank is not drawn in the past); the rest at its time
        const mine = (e[1] === 'f' || e[1] === 'c' || e[1] === 'l' || e[1] === 'p') ? e[2] === net.you : (e[1] === 'h' || e[1] === 'x') ? e[3] === net.you : false;
        if (mine) netEvent(e);
        else net.events.push({ s: e[0] * NET_TICK_MS, e });
      }
    }
  } else if (m.t === 'welcome') netStart(m);
  else if (m.t === 'full') leaveOnline('The server is full. Try again in a moment.');
  else if (m.t === 'rooms') { if (net.lobby) netShowRooms(m.rooms); }
  else if (m.t === 'err') { // a room request was refused: stay in the list and say why
    net.joining = false;
    if (net.lobby) { netMsg(m.msg, true); net.ws?.send('{"t":"rooms"}'); } else leaveOnline(m.msg);
  }
  else if (m.t === 'slots') netApplySlots(m.slots);
  else if (m.t === 'end') netShowEnd(m.line);
  else if (m.t === 'start') netNewMatch(m.slots);
  else if (m.t === 'pong') { // the median of the last few, so one slow frame does not make the number jump
    net.pings.push(performance.now() - m.ts);
    if (net.pings.length > 5) net.pings.shift();
    net.ping = Math.round([...net.pings].sort((a, b) => a - b)[net.pings.length >> 1]);
    net.rtt = Math.min(...net.pings); // the best recent answer time (the others are slowed by this computer being busy)
  }
}

// a snapshot arrived at time `now`: remember it on the server's clock, and how the two clocks line up
function netAddSnapshot(k, rows, now) {
  const s = k * NET_TICK_MS;
  net.offsets.push(now - s);
  if (net.offsets.length > 45) net.offsets.shift();
  net.offset = Math.min(...net.offsets);
  net.snaps.push({ s, a: rows });
  if (net.snaps.length > 14) net.snaps.shift();
}

// the server's team scores, flags and crates, copied into the local objects that draw them
function netWorld(m) {
  if (m.ts) { teamScore.blue = m.ts[0]; teamScore.red = m.ts[1]; }
  if (m.f) {
    ['blue', 'red'].forEach((k, i) => {
      const f = flags[k], r = m.f[i];
      f.state = r[0] === 0 ? 'home' : r[0] === 1 ? 'carried' : 'dropped';
      f.carrier = r[1] >= 0 ? net.puppets[r[1]] || null : null;
      f.x = r[2];
      f.z = r[3];
      f.dropTimer = r[4];
    });
    for (const t of tanks) t.carrying = null;
    for (const f of Object.values(flags)) if (f.carrier) f.carrier.carrying = f;
  }
  const ids = new Set();
  for (const r of m.d || []) {
    ids.add(r[0]);
    let d = drops.find((x) => x.id === r[0]);
    if (!d) {
      d = buildDrop(DROP_KEYS[r[1]], r[2], r[3], r[0]);
      drops.push(d);
    }
    d.life = r[5];
    if (r[4] && !d.landed) d.group.position.y = Math.min(d.group.position.y, 0.65); // it has landed already
  }
  for (const d of [...drops]) if (!ids.has(d.id)) removeDrop(d);
}

// My own tank is driven here at once from my keys (prediction). The server's snapshot says where it really was at server
// time `s`; that moment of my own history is `s + offset - round trip`, so compare there and nudge my tank by the difference.
function netReconcile(s, rows) {
  const H = net.hist, row = rows[net.you];
  if (!net.predicting || H.length < 2 || !row || row[6] !== 1) return;
  // (the server's clock can fall behind when the server is overloaded, so it may not be trusted far from "when it arrived")
  const arrived = performance.now() - clamp(net.rtt, 10, 400);
  const tc = clamp(s + net.offset - clamp(net.rtt, 10, 400), arrived - 120, arrived + 20);
  if (tc < H[0].t) return; // that moment is already forgotten
  let i = H.length - 2;
  while (i > 0 && H[i].t > tc) i--;
  const a = H[i], b = H[i + 1], f = clamp((tc - a.t) / Math.max(1, b.t - a.t), 0, 1);
  const ex = row[1] - lerp(a.x, b.x, f), ez = row[2] - lerp(a.z, b.z, f);
  const eh = angleDiff(row[3], lerpAngle(a.h, b.h, f)), et = angleDiff(row[4], lerpAngle(a.ty, b.ty, f));
  const d = Math.hypot(ex, ez);
  net.err = d;
  let k = 0;
  if (d > NET_SNAP_DIST || Math.abs(eh) > 0.6) k = 1;
  else if (d > NET_FIX_DEADZONE || Math.abs(eh) > 0.05 || Math.abs(et) > 0.05) k = NET_FIX_RATE;
  if (!k) return;
  // the same shift for the tank and for every remembered pose, so the same difference is never corrected twice
  const dx = ex * k, dz = ez * k, dh = eh * k, dty = et * k;
  player.pos.x += dx; player.pos.z += dz; player.heading += dh; player.turretYaw += dty;
  for (const h of H) { h.x += dx; h.z += dz; h.h += dh; h.ty += dty; }
  resolveBoxes(player);
}

// How far in the past the world is drawn. It grows when this computer draws slowly (messages are only handled
// between frames, so slow frames mean bunched-up snapshots) and shrinks when the game runs smoothly.
const netDelay = () => clamp(70 + net.frameMs * 1.6, 110, 260);

// The pose of every tank at server time `at`: blended between the two snapshots around it, or, if the newest one
// is already older than `at`, carried on along its last movement for a moment instead of freezing.
// Returns { A, B, f, extra } where extra > 0 means "extrapolating" by that many ms.
function netPose(S, at) {
  if (!S.length) return null;
  let ia = 0;
  for (let i = S.length - 1; i >= 0; i--) if (S[i].s <= at) { ia = i; break; }
  const A = S[ia], B = S[ia + 1] || null;
  if (B) return { A, B, f: clamp((at - A.s) / Math.max(1, B.s - A.s), 0, 1), extra: 0 };
  const prev = S[ia - 1];
  if (!prev) return { A, B: null, f: 0, extra: 0 };
  return { A: prev, B: A, f: 1 + clamp(at - A.s, 0, NET_EXTRAPOLATE_MAX) / Math.max(1, A.s - prev.s), extra: Math.max(0, at - A.s) };
}

// One thing that happened on the server, shown now: e = [tick, type, ...]
//   f slot: fired   c slot: railgun charging   l slot on: flamethrower on/off
//   h attacker victim burn: damage was dealt   x killer victim: a tank was destroyed
function netEvent(e) {
  const type = e[1], a = net.puppets[e[2]];
  if (type === 'f') {
    if (!a || !a.alive) return;
    if (a.weapon.kind === 'rail') fireRail(a);
    else if (a.weapon.kind !== 'flame') fireShell(a);
  } else if (type === 'c') {
    if (a && a.alive) startCharge(a);
  } else if (type === 'l') {
    if (!a) return;
    a.netFlame = e[3] === 1;
    if (!a.netFlame) setFlaming(a, false);
  } else if (type === 'h') {
    const v = net.puppets[e[3]];
    if (!v) return;
    if (e[4] === 1) { // a flame stream: lighter feedback
      v.flash = Math.max(v.flash, 0.08);
      if (v === player) damageFlash = Math.max(damageFlash, 0.45);
      if (a === player) hitMarker = Math.max(hitMarker, 0.1);
    } else {
      v.flash = 0.15;
      if (v === player) { damageFlash = 1; addShake(0.4); Sound.hurt(); }
      if (a === player) hitMarker = 0.15;
    }
  } else if (type === 'p') { // a crate was picked up
    const def = DROP_TYPES[e[3]];
    if (!def) return;
    fireball(e[4], 1, e[5], 0.6, 3.5, 0.4, new THREE.Color(def.color).multiplyScalar(1.8));
    Sound.pickup(e[4], e[5]);
    if (a === player) {
      if (e[3] === 'crystal') earnCrystals(CRYSTAL_DROP_REWARD);
      showToast(`+ ${e[3] === 'crystal' ? `${CRYSTAL_DROP_REWARD} crystals` : def.name}`, def.css);
    }
  } else if (type === 'F') { // flag news: 0 taken, 1 dropped, 2 returned, 3 captured
    const kind = e[2], team = e[3], t = net.puppets[e[4]];
    if (kind === 0 && t) {
      pushFeed(`${tankLabel(t)}<span class="kf-icon">took</span>${teamLabel(team)} flag`, t === player);
      if (t === player) showToast('You have the flag! Bring it home', TEAMS[team].css);
      else if (team === player.team) showToast('Your flag was taken!', TEAMS[t.team].css);
      Sound.flagEvent(t.team === player.team);
    } else if (kind === 1) {
      pushFeed(`${teamLabel(team)} flag<span class="kf-icon">dropped</span>`, false);
    } else if (kind === 2) {
      pushFeed(t ? `${tankLabel(t)}<span class="kf-icon">returned</span>${teamLabel(team)} flag` : `${teamLabel(team)} flag<span class="kf-icon">returned</span>`, t === player);
      if (t === player) earnCrystals(RETURN_REWARD);
      if (team === player.team) Sound.flagEvent(true);
    } else if (kind === 3 && t) {
      const home = flags[t.team].home;
      fireball(home.x, 2, home.z, 1, 6, 0.6, new THREE.Color(TEAMS[t.team].colors[0]).multiplyScalar(1.6));
      pushFeed(`${tankLabel(t)}<span class="kf-icon">captured</span>${teamLabel(team)} flag`, t === player);
      if (t === player) {
        earnCrystals(CAPTURE_REWARD);
        showToast('Flag captured!', TEAMS[t.team].css);
      } else showToast(`${TEAMS[t.team].name} team scores`, TEAMS[t.team].css);
      Sound.flagEvent(t.team === player.team, true);
    }
  } else if (type === 'x') {
    const v = net.puppets[e[3]];
    if (!a || !v) return;
    v.charge = 0;
    v.netFlame = false;
    setFlaming(v, false);
    if (v === player) player.killedBy = a;
    deathFx(v);
    addKillFeed(a, v);
    if (a === player) {
      earnCrystals(KILL_REWARD);
      showKillMsg(v);
      Sound.kill();
    }
  }
}

// tank names, colours, teams and turrets come from the server
function netApplySlots(slots) {
  for (const sl of slots) {
    const t = net.puppets[sl.i];
    if (!t) continue;
    t.name = sl.name;
    t.team = sl.team;
    t.setColor(sl.color);
    if (t.hullId !== sl.hull) t.setHull(sl.hull, {});
    if (t.weaponId !== sl.weapon) t.setWeapon(sl.weapon, {});
    if (t.tag) t.drawTag();
  }
  const me = slots.find((sl) => sl.i === net.you);
  if (me) $('player-swatch').style.background = `#${new THREE.Color(me.color).getHexString()}`;
}

function netStart(w) {
  const wanted = MAPS.find((m) => m.id === w.map);
  if (!wanted || !MODES[w.mode]) { leaveOnline('This server uses a map or mode this game does not have.'); return; }
  net.joining = false;
  net.on = true;
  closeLobby(true);
  netEls.rooms.disabled = true;
  if (!currentMap || currentMap.id !== wanted.id) buildMap(wanted);
  botExtra = Math.max(0, w.slots.length - 1 - MODES[w.mode].bots); // (team modes: the server's extra blue bot)
  setMode(w.mode);
  resetGame();
  net.you = w.you;
  net.snaps.length = 0;
  net.events.length = 0;
  net.offsets.length = 0;
  net.pings.length = 0;
  // server tank 0 is the server's own parked player; tanks 1.. are its bots, which line up with ours
  net.puppets = w.slots.map((sl) => (sl.i === w.you ? player : sl.i >= 1 ? bots[sl.i - 1] : null));
  net.spare = w.you >= 1 ? bots[w.you - 1] : null; // our copy of the bot whose tank I am driving: not needed
  if (net.spare) {
    net.spare.alive = false;
    net.spare.setVisible(false);
    tanks = tanks.filter((t) => t !== net.spare); // so it is not on the scoreboard or the minimap
  }
  netApplySlots(w.slots);
  $('restart-btn').classList.add('hidden');
  hud.win.classList.add('hidden');
  hud.start.classList.add('hidden');
  matchStarted = true;
  state = 'playing';
  Sound.resume();
  netEls.badge.classList.remove('hidden');
  netEls.join.textContent = 'Leave online';
  netSay(`Online on ${wanted.name}`);
  showToast(`Connected: ${wanted.name}, ${MODES[w.mode].name}`, '#ffc23d');
}

function netNewMatch(slots) {
  clearDrops();
  net.snaps.length = 0;
  net.events.length = 0;
  net.offsets.length = 0;
  hud.win.classList.add('hidden');
  netApplySlots(slots);
  clearEffects();
}

function netShowEnd(line) {
  hud.winTitle.textContent = 'MATCH OVER';
  hud.winTitle.classList.remove('defeat');
  hud.winTagline.textContent = line;
  hud.winStats.innerHTML = `<b>${player.kills}</b> kills &middot; <b>${player.deaths}</b> deaths<div class="win-reward">Next match starts in a few seconds</div>`;
  hud.win.classList.remove('hidden');
}

const lerpAngle = (a, b, t) => a + angleDiff(b, a) * t;

// every frame while online: send what I am pressing, then show the world as the server last described it
function netUpdate(dt) {
  const now = performance.now();
  const open = net.ws && net.ws.readyState === 1;
  if (open) {
    const k = state === 'playing' ? { W: !!keys.KeyW, S: !!keys.KeyS, A: !!keys.KeyA, D: !!keys.KeyD, Z: !!keys.KeyZ, X: !!keys.KeyX, Space: !!keys.Space, C: !!keys.KeyC } : {};
    const json = JSON.stringify(k);
    if ((json !== net.lastKeys && now - net.lastSend > 35) || now - net.lastSend > 500) {
      net.ws.send(`{"t":"in","k":${json}}`);
      net.lastKeys = json;
      net.lastSend = now;
    }
    if (now - net.pingAt > 1000) {
      net.pingAt = now;
      net.ws.send(`{"t":"ping","ts":${now}}`);
    }
  }
  if (now - net.badgeAt > 500) {
    net.badgeAt = now;
    netEls.badge.textContent = `ONLINE · ${net.ping} ms`;
  }
  // how long this computer takes per frame (a slow average makes the drawn world lag a little further behind)
  if (net.lastNow) net.frameMs += (clamp(now - net.lastNow, 5, 400) - net.frameMs) * 0.05;
  net.lastNow = now;
  const S = net.snaps;
  const at = now - net.offset - netDelay(); // the server time being drawn
  const pose = netPose(S, at);
  if (!pose) return;
  const { A, B, f } = pose;
  const rowsA = A.a, rowsB = (B || A).a, latest = S[S.length - 1].a;
  // my own tank answers my keys right now; the snapshots only correct it (netReconcile)
  const predicting = state === 'playing' && player.alive && !!latest[net.you] && latest[net.you][6] === 1;
  if (predicting) {
    if (!net.predicting) { net.predicting = true; net.hist.length = 0; net.predAt = now; }
    // real elapsed time, in steps no longer than the server's, so a slow computer's tank still keeps pace with the server's
    let rest = clamp((now - net.predAt) / 1000, 0, 0.25);
    net.predAt = now;
    while (rest > 1e-4) {
      const d = Math.min(rest, 1 / 30);
      driveBody(player, keys, d);
      rest -= d;
    }
    net.hist.push({ t: now, x: player.pos.x, z: player.pos.z, h: player.heading, ty: player.turretYaw });
    if (net.hist.length > 120) net.hist.shift();
  } else net.predicting = false;
  for (let i = 0; i < rowsB.length; i++) {
    const t = net.puppets[i];
    if (!t) continue;
    const own = t === player; // my tank is not drawn in the past: it follows the newest snapshot (or my own prediction)
    const ra = own ? latest[i] : rowsA[i] || rowsB[i], rb = own ? latest[i] : rowsB[i];
    const alive = rb[6] === 1;
    if (alive !== t.alive) {
      t.alive = alive;
      t.setVisible(alive);
      if (!alive && t === player) player.respawn = PLAYER_RESPAWN;
      if (alive && t === player) player.killedBy = null;
    }
    if (alive && own && predicting) {
      // already driven above
    } else if (alive) {
      const both = ra[6] === 1 && !own; // a tank that has just respawned jumps to its new position instead of sliding
      const k = both ? f : 1; // (above 1 = carrying on past the newest snapshot)
      t.pos.x = lerp(ra[1], rb[1], k);
      t.pos.z = lerp(ra[2], rb[2], k);
      t.heading = both ? lerpAngle(ra[3], rb[3], k) : rb[3];
      t.turretYaw = both ? lerpAngle(ra[4], rb[4], k) : rb[4];
      if (k > 1) resolveBoxes(t); // never carry a tank into a wall
      t.speed = rb[7];
      t.sync();
    }
    t.hp = rb[5];
    t.kills = rb[8];
    t.deaths = rb[9];
    BUFFS.forEach((k, j) => { t.buffs[k] = rb[10] ? rb[10][j] : 0; });
  }
  // what happened (shots, hits, kills) up to the moment being drawn
  const q = net.events;
  while (q.length && q[0].s <= at) netEvent(q.shift().e);
  if (q.length > 200) q.splice(0, q.length - 200); // never let a long stall pile up
  if (!player.alive) player.respawn = Math.max(0, player.respawn - dt);
  for (const t of tanks) {
    if (t.reload > 0) t.reload = Math.max(0, t.reload - dt);
    if (t.charge > 0) t.charge = Math.max(0, t.charge - dt);
    if (t.alive && t.netFlame) {
      setFlaming(t, true);
      flameTick(t, dt);
    }
  }
  for (const t of tanks) if (t.alive) t.updateVisuals(dt, elapsed);
  Sound.engine(player.speed, player.alive, false);
}

// ---------- Main loop ----------
let elapsed = 0;

let skyTime = 0; // keeps running in the menu so clouds and smoke never freeze
function step(dt) {
  if (net.on) {
    elapsed += dt;
    netUpdate(dt);
    updateBullets(dt);
    updateDrops(dt, elapsed);
    updateFlags(dt, elapsed);
  } else if (state === 'playing') {
    elapsed += dt;
    updatePlayer(dt);
    for (const bot of bots) {
      if (!bot.remote) updateBot(bot, dt);
      else if (bot.alive) driveTank(bot, bot.remote.input, dt); // a person on the network is driving
    }
    updateBullets(dt);
    updateDrops(dt, elapsed);
    updateFlags(dt, elapsed);
    updateRespawns(dt);
    for (const t of tanks) if (t.alive) updateBurn(t, dt);
    for (const t of tanks) if (t.alive) t.updateVisuals(dt, elapsed);
  }
  if (state !== 'paused') {
    updateParticles(dt);
    updateBeams(dt);
    updateLights(dt);
    updateScorches(dt);
    updateCamera(dt);
    updateBridgeFade(dt);
    updateHud(dt);
  }
  skyTime += dt;
  skyUniforms.skyTime.value = skyTime;
  updateSnow(dt, elapsed);
  hemi.intensity = theme.hemi[2]; // reset every frame: lightning and distant flashes add to it below
  updateWar(dt, skyTime);
  updateLightning(dt, skyTime);
  if (keys.Tab) updateScoreboard();
  updateBotBars();
  drawMinimap();
  sky.position.copy(camera.position);
  composer.render(dt);
}

buildMenu();
if (!import.meta.env.SSR) loadModels(); // a game server (Node) has no models to load
buildMap(MAPS.find((m) => m.id === selectedMap));
setMode(selectedMode);
resetGame();
refreshMenu();
updateSoundHint();

applyQuality(qualityLevel);
refreshQualityUI();

const timer = new THREE.Timer();
timer.connect(document);
function frame(time) {
  meterFps(time);
  timer.update(time);
  // clamp both ways: a long stall shouldn't teleport things, and a backwards
  // timestamp must never make effects run in reverse
  step(clamp(timer.getDelta() || 0, 0, 0.05));
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// What a game server (or a test) may use. In the browser this export is simply unused.
// A person on the network takes over a bot's tank (the AI stops driving it); when they leave, the AI gets it back.
const NET_KEYS = ['KeyW', 'KeyS', 'KeyA', 'KeyD', 'KeyZ', 'KeyX', 'Space'];
function addHuman(name, hull, weapon) {
  const t = bots.find((b) => !b.remote);
  if (!t) return null;
  t.remote = { input: Object.fromEntries(NET_KEYS.map((k) => [k, false])), origName: t.name, origHull: t.hullId, origWeapon: t.weaponId, center: false };
  // the tank and turret the person chose (only ones that exist, at base strength: upgrades are not trusted from a browser)
  if (Object.hasOwn(HULLS, hull) && hull !== t.hullId) t.setHull(hull, {});
  if (Object.hasOwn(WEAPONS, weapon) && weapon !== t.weaponId) t.setWeapon(weapon, {});
  t.hp = t.maxHp;
  t.name = name;
  if (t.tag) t.drawTag();
  t.path = null;
  return t;
}
function removeHuman(t) {
  if (!t || !t.remote) return;
  t.name = t.remote.origName;
  if (t.hullId !== t.remote.origHull) t.setHull(t.remote.origHull, {});
  if (t.weaponId !== t.remote.origWeapon) t.setWeapon(t.remote.origWeapon, {});
  t.hp = t.maxHp;
  t.remote = null;
  t.centering = false;
  if (t.tag) t.drawTag();
}
// keys: { W, S, A, D, Z, X, Space, C } as booleans (anything else is ignored)
function setHumanInput(t, keys) {
  if (!t || !t.remote) return;
  const i = t.remote.input;
  i.KeyW = keys.W === true; i.KeyS = keys.S === true; i.KeyA = keys.A === true; i.KeyD = keys.D === true;
  i.KeyZ = keys.Z === true; i.KeyX = keys.X === true; i.Space = keys.Space === true;
  if (keys.C === true && !t.remote.center) t.centering = true; // C swings the turret back to the front
  t.remote.center = keys.C === true;
}
// the server has no player of its own: park that tank out of the match
// a server's team modes get one more bot (see botExtra)
function setRoster(extra) {
  botExtra = extra;
  setMode(mode.id);
}
function parkPlayer() {
  player.alive = false;
  player.respawn = Infinity;
  player.setVisible(false);
}
function restartMatch() {
  resetGame();
  hud.win.classList.add('hidden');
  state = 'paused';
  play();
  parkPlayer();
}
// the first call switches event collection on (a server wants it, single player never does)
function takeEvents() {
  const e = hostEvents || [];
  hostEvents = [];
  return e;
}
function snapshot() {
  return tanks.map((t, i) => [
    i, +t.pos.x.toFixed(2), +t.pos.z.toFixed(2), +t.heading.toFixed(3), +t.turretYaw.toFixed(3),
    Math.round(t.hp), t.alive ? 1 : 0, +t.speed.toFixed(2), t.kills, t.deaths,
    BUFFS.some((k) => t.buffs[k] > 0) ? BUFFS.map((k) => +t.buffs[k].toFixed(1)) : 0,
  ]);
}
// everything else a browser has to draw: team scores, flags (capture the flag), bonus crates
function worldState() {
  const o = {};
  if (mode.teams) o.ts = [teamScore.blue, teamScore.red];
  if (mode.id === 'ctf') {
    o.f = ['blue', 'red'].map((k) => {
      const f = flags[k];
      return [f.state === 'home' ? 0 : f.state === 'carried' ? 1 : 2, f.carrier ? slotOf(f.carrier) : -1, +f.x.toFixed(1), +f.z.toFixed(1), Math.round(f.dropTimer)];
    });
  }
  if (drops.length) o.d = drops.map((d) => [d.id, DROP_KEYS.indexOf(d.type), +d.x.toFixed(1), +d.z.toFixed(1), d.landed ? 1 : 0, Math.round(d.life)]);
  return o;
}
function slotInfo() {
  return tanks.map((t, i) => ({
    i, name: t.name, color: t.color.getHex(), hull: t.hullId, weapon: t.weaponId, team: t.team || null, human: !!t.remote,
  }));
}

export const G = {
  step, play, resetGame, player, boxes, MODES, ARENA, pointInBox,
  addHuman, removeHuman, setHumanInput, setRoster, parkPlayer, restartMatch, snapshot, worldState, takeEvents, slotInfo, hud,
  get currentMap() { return currentMap; },
  get tanks() { return tanks; }, get bots() { return bots; }, get state() { return state; },
  get mode() { return mode; }, get SPAWNS() { return SPAWNS; }, get particles() { return particles; }, get bullets() { return bullets; },
};
