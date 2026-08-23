import {
  BufferAttribute,
  BufferGeometry,
  Camera,
  Mesh,
  RawShaderMaterial,
  ShaderMaterial,
  type IUniform,
  type WebGLRenderTarget,
  type WebGLRenderer,
} from 'three'
import { FULLSCREEN_VERT } from '../sim/shaders/common'

/** One triangle covering the viewport — cheaper and seam-free versus two. */
function fullScreenTriangle(): BufferGeometry {
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3))
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2))
  return geometry
}

const sharedGeometry = /* @__PURE__ */ fullScreenTriangle()
const sharedCamera = /* @__PURE__ */ new Camera()

/**
 * A single fragment-shader pass over a render target.
 *
 * The simulation is a stack of these — wave step, splat, normals, foam,
 * caustics — so they all share one geometry, one camera and one code path.
 */
export class FullScreenPass {
  readonly material: ShaderMaterial
  private readonly mesh: Mesh

  constructor(fragmentShader: string, uniforms: Record<string, IUniform>) {
    this.material = new RawShaderMaterial({
      vertexShader: `precision highp float;\nattribute vec3 position;\nattribute vec2 uv;\n${FULLSCREEN_VERT}`,
      fragmentShader: `precision highp float;\n${fragmentShader}`,
      uniforms,
      depthTest: false,
      depthWrite: false,
    })
    this.mesh = new Mesh(sharedGeometry, this.material)
    this.mesh.frustumCulled = false
  }

  get uniforms(): Record<string, IUniform> {
    return this.material.uniforms
  }

  render(renderer: WebGLRenderer, target: WebGLRenderTarget | null): void {
    const previousTarget = renderer.getRenderTarget()
    const previousAutoClear = renderer.autoClear
    renderer.setRenderTarget(target)
    renderer.autoClear = false
    renderer.render(this.mesh, sharedCamera)
    renderer.autoClear = previousAutoClear
    renderer.setRenderTarget(previousTarget)
  }

  dispose(): void {
    this.material.dispose()
  }
}
