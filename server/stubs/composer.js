const rt = () => ({ samples: 0, dispose() {}, texture: {} });
export class EffectComposer {
  constructor() { this.renderTarget1 = rt(); this.renderTarget2 = rt(); }
  addPass() {} setSize() {} setPixelRatio() {} render() {}
}
export class RenderPass {}
export class UnrealBloomPass { constructor() { this.enabled = true; } setSize() {} }
export class OutputPass {}
export class ShaderPass { constructor() { this.enabled = false; this.material = { uniforms: { resolution: { value: { set() {} } } } }; } }
export const FXAAShader = { name: 'FXAAShader', uniforms: {}, vertexShader: '', fragmentShader: '' };
export class GLTFLoader { setDRACOLoader() { return this; } setMeshoptDecoder() { return this; } load(url, ok, progress, fail) { if (fail) fail(new Error('no models in headless mode')); } }
export class DRACOLoader { setDecoderPath() { return this; } }
export const MeshoptDecoder = {};
