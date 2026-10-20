// Builds the game's code for Node (no browser): `npm run build:server`
import { fileURLToPath } from 'node:url';
const r = (p) => fileURLToPath(new URL(p, import.meta.url));
export default {
  base: './',
  publicDir: false,
  resolve: {
    alias: [
      { find: /^three$/, replacement: r('./server/stubs/three.js') },
      { find: /^three\/addons\/postprocessing\/.*$/, replacement: r('./server/stubs/composer.js') },
      { find: 'three/addons/shaders/FXAAShader.js', replacement: r('./server/stubs/composer.js') },
      { find: 'three/addons/loaders/GLTFLoader.js', replacement: r('./server/stubs/composer.js') },
      { find: 'three/addons/loaders/DRACOLoader.js', replacement: r('./server/stubs/composer.js') },
      { find: 'three/addons/libs/meshopt_decoder.module.js', replacement: r('./server/stubs/composer.js') },
    ],
  },
  ssr: { noExternal: true, target: 'node' },
  build: {
    ssr: true, outDir: 'dist-server', emptyOutDir: true, minify: false, sourcemap: false,
    // two programs: the lobby (entry.js) and one game room (room.js, started by the lobby in its own thread)
    rollupOptions: { input: { entry: r('./server/entry.js'), room: r('./server/room.js') }, external: ['ws'], output: { entryFileNames: '[name].js' } },
  },
};
