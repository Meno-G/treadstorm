// Stand-ins for the browser, so the game's own code can run in Node with no screen, no canvas and no sound.
// Nothing here draws anything: every element is a harmless dummy that accepts any call.
const noop = () => {};

function ctx2d() {
  const gradient = { addColorStop: noop };
  const base = {
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
    createPattern: () => ({}),
    measureText: () => ({ width: 0 }),
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(1, w * h * 4)), width: w, height: h }),
    putImageData: noop,
  };
  return new Proxy(base, {
    get: (t, k) => (k in t ? t[k] : typeof k === 'symbol' ? undefined : noop),
    set: () => true,
  });
}

const els = new Map();
function makeEl(tag = 'div', id = '') {
  const list = new Set();
  const el = {
    tagName: String(tag).toUpperCase(), id, style: {}, dataset: {}, children: [], childNodes: [],
    className: '', innerHTML: '', textContent: '', innerText: '', value: '', src: '', width: 300, height: 150,
    offsetWidth: 0, offsetHeight: 0, clientWidth: 0, clientHeight: 0, disabled: false, checked: false,
    classList: {
      add: (...c) => c.forEach((x) => list.add(x)), remove: (...c) => c.forEach((x) => list.delete(x)),
      contains: (c) => list.has(c), toggle: (c, on) => { const want = on === undefined ? !list.has(c) : !!on; want ? list.add(c) : list.delete(c); return want; },
    },
    getContext: () => ctx2d(),
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 }),
    querySelector: () => makeEl(), querySelectorAll: () => [],
    appendChild: (c) => c, append: noop, prepend: noop, remove: noop, insertAdjacentHTML: noop, removeChild: noop,
    addEventListener: noop, removeEventListener: noop, setAttribute: noop, getAttribute: () => null, focus: noop, blur: noop, click: noop,
    toDataURL: () => '',
  };
  // properties that point at other elements get a fresh dummy each time
  for (const k of ['parentElement', 'parentNode', 'firstChild', 'lastChild', 'nextSibling', 'previousSibling', 'firstElementChild', 'lastElementChild', 'offsetParent']) {
    Object.defineProperty(el, k, { get: () => makeEl(), enumerable: false });
  }
  return new Proxy(el, { get: (t, k) => (k in t ? t[k] : typeof k === 'symbol' ? undefined : noop), set: (t, k, v) => { t[k] = v; return true; } });
}

const storage = new Map();
globalThis.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => { storage.set(k, String(v)); },
  removeItem: (k) => { storage.delete(k); }, clear: () => storage.clear(), key: (i) => [...storage.keys()][i] ?? null,
  get length() { return storage.size; },
};
// settings for a headless run come from environment variables
if (process.env.MAP) localStorage.setItem('treadstorm-map', process.env.MAP);
if (process.env.MODE) localStorage.setItem('treadstorm-mode', process.env.MODE);
localStorage.setItem('treadstorm-muted', '1');

globalThis.document = {
  createElement: (tag) => makeEl(tag),
  getElementById: (id) => { if (!els.has(id)) els.set(id, makeEl('div', id)); return els.get(id); },
  querySelector: () => makeEl(), querySelectorAll: () => [],
  body: makeEl('body'), documentElement: makeEl('html'), hidden: false,
  addEventListener: noop, removeEventListener: noop, exitPointerLock: noop,
};
globalThis.window = globalThis;
globalThis.innerWidth = 1280;
globalThis.innerHeight = 720;
globalThis.devicePixelRatio = 1;
globalThis.location = { search: '', href: 'http://localhost/', hash: '' };
globalThis.addEventListener = noop;
globalThis.removeEventListener = noop;
globalThis.requestAnimationFrame = () => 0; // the server drives the game itself
globalThis.cancelAnimationFrame = noop;
globalThis.matchMedia = () => ({ matches: false, addEventListener: noop });
if (!globalThis.navigator) globalThis.navigator = { userAgent: 'node' };
