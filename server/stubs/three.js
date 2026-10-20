// The real three.js, except the parts that need a graphics card are replaced with do-nothing versions.
export * from 'three/src/Three.js';

const noop = () => {};
export class WebGLRenderer {
  constructor() {
    this.domElement = document.createElement('canvas');
    this.shadowMap = { enabled: false, type: 0 };
    this.capabilities = { getMaxAnisotropy: () => 1 };
    this.info = { render: { calls: 0, triangles: 0 }, memory: { geometries: 0, textures: 0 }, reset: noop };
    this.toneMapping = 0;
    this.toneMappingExposure = 1;
  }
  setPixelRatio() {}
  getPixelRatio() { return 1; }
  setSize() {}
  getSize(v) { return v; }
  getDrawingBufferSize(v) { return v; }
  render() {}
  dispose() {}
}
