import {
  AddEquation,
  CustomBlending,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  BufferAttribute,
  Camera,
  Mesh,
  OneFactor,
  RawShaderMaterial,
  Vector2,
  Vector4,
  type WebGLRenderTarget,
  type WebGLRenderer,
} from 'three'
import { POOL } from '../core/config'
import type { SplatQueue } from './WaveSplat'

const VERTEX = /* glsl */ `
precision highp float;
attribute vec3 position;
attribute vec2 aCentre;
attribute vec2 aShape;   // x = sigma (metres), y = amount

uniform vec2 uDomain;

varying vec2 vOffset;
varying float vSigma;
varying float vAmount;

void main() {
  // The quad is sized to the gaussian's own reach, so a splat only ever
  // rasterises the handful of texels it can actually affect.
  float reach = aShape.x * 3.5;
  vOffset = position.xy * reach;
  vSigma = aShape.x;
  vAmount = aShape.y;

  vec2 world = aCentre + vOffset;
  gl_Position = vec4((world / uDomain) * 2.0, 0.0, 1.0);
}
`

const FRAGMENT = /* glsl */ `
precision highp float;
uniform vec4 uMask;

varying vec2 vOffset;
varying float vSigma;
varying float vAmount;

void main() {
  float bump = vAmount * exp(-dot(vOffset, vOffset) / (2.0 * vSigma * vSigma));
  gl_FragColor = uMask * bump;
}
`

/** Which field a batch of splats is being written into. */
export type SplatChannel = 'height' | 'foam'

const camera = /* @__PURE__ */ new Camera()

/**
 * Draws the step's splats into a field as additive gaussian quads.
 *
 * The obvious implementation — a fullscreen pass looping over an array of splat
 * uniforms — caps out at whatever array size the shader declares, and a busy
 * pool produces well over a hundred splats a step. Anything past the cap was
 * silently dropped, so the GPU field and the CPU field stopped agreeing about
 * what had happened to the water. Instancing a quad per splat has no such
 * ceiling and costs less: each splat only touches the texels inside its own
 * three-sigma footprint, rather than every texel in the pool.
 */
export class SplatRenderer {
  private geometry: InstancedBufferGeometry
  private readonly material: RawShaderMaterial
  private readonly mesh: Mesh
  private centres: InstancedBufferAttribute
  private shapes: InstancedBufferAttribute
  private capacity: number

  constructor(initialCapacity = 256) {
    this.capacity = Math.max(16, initialCapacity)

    this.geometry = new InstancedBufferGeometry()
    // A unit quad in [-1, 1]; the vertex shader scales it to each splat.
    // Three components even though the quad is flat: three.js computes bounding
    // volumes from this attribute assuming three, and a two-component one gives
    // it a NaN radius to complain about.
    this.geometry.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3),
    )
    this.geometry.setIndex([0, 1, 2, 0, 2, 3])
    this.centres = this.makeAttribute(this.capacity, 2)
    this.shapes = this.makeAttribute(this.capacity, 2)
    this.geometry.setAttribute('aCentre', this.centres)
    this.geometry.setAttribute('aShape', this.shapes)

    this.material = new RawShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: {
        uDomain: { value: new Vector2(POOL.width, POOL.depth) },
        uMask: { value: new Vector4(1, 1, 0, 0) },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      // Straight addition on every channel. The named Additive preset weights
      // the source by its alpha, which is not what a height impulse wants.
      blending: CustomBlending,
      blendEquation: AddEquation,
      blendSrc: OneFactor,
      blendDst: OneFactor,
      blendEquationAlpha: AddEquation,
      blendSrcAlpha: OneFactor,
      blendDstAlpha: OneFactor,
    })

    this.mesh = new Mesh(this.geometry, this.material)
    this.mesh.frustumCulled = false
  }

  private makeAttribute(capacity: number, size: number): InstancedBufferAttribute {
    const attribute = new InstancedBufferAttribute(new Float32Array(capacity * size), size)
    attribute.setUsage(DynamicDrawUsage)
    return attribute
  }

  private grow(needed: number): void {
    while (this.capacity < needed) this.capacity *= 2
    this.centres = this.makeAttribute(this.capacity, 2)
    this.shapes = this.makeAttribute(this.capacity, 2)
    this.geometry.setAttribute('aCentre', this.centres)
    this.geometry.setAttribute('aShape', this.shapes)
  }

  /**
   * Stamp every splat in the queue into `target`.
   *
   * `minSigma` floors the gaussian width at a texel or so, so a splat can never
   * fall between texels and vanish on the fine field while still registering on
   * the coarse one. `scale` converts the queue's units into whatever the target
   * field wants — height is already in metres, but foam is a deposition *rate*
   * and has to be multiplied by the step length.
   */
  render(
    renderer: WebGLRenderer,
    target: WebGLRenderTarget,
    queue: SplatQueue,
    channel: SplatChannel,
    minSigma: number,
    scale = 1,
  ): number {
    const count = queue.length
    if (count === 0) return 0
    if (count > this.capacity) this.grow(count)

    const centres = this.centres.array as Float32Array
    const shapes = this.shapes.array as Float32Array
    let written = 0
    for (let i = 0; i < count; i++) {
      const splat = queue.at(i)
      const amount = channel === 'height' ? splat.strength : splat.foam
      if (amount === 0) continue
      const sigma = Math.max(splat.radius, minSigma) * (channel === 'foam' ? 1.6 : 1)
      centres[written * 2] = splat.x
      centres[written * 2 + 1] = splat.z
      shapes[written * 2] = sigma
      shapes[written * 2 + 1] = amount * scale
      written++
    }
    if (written === 0) return 0

    this.centres.needsUpdate = true
    this.shapes.needsUpdate = true
    this.geometry.instanceCount = written

    // Height goes into both stored time levels (R and G) so the disturbance
    // starts at rest; foam is a single channel.
    this.material.uniforms.uMask!.value.set(
      1,
      channel === 'height' ? 1 : 0,
      0,
      0,
    )

    const previousTarget = renderer.getRenderTarget()
    const previousAutoClear = renderer.autoClear
    renderer.autoClear = false
    renderer.setRenderTarget(target)
    renderer.render(this.mesh, camera)
    renderer.autoClear = previousAutoClear
    renderer.setRenderTarget(previousTarget)

    return written
  }

  dispose(): void {
    this.geometry.dispose()
    this.material.dispose()
  }
}
