import {
  ClampToEdgeWrapping,
  DataTexture,
  FloatType,
  HalfFloatType,
  LinearFilter,
  NearestFilter,
  RGFormat,
  RGBAFormat,
  Vector2,
  Vector4,
  WebGLRenderTarget,
  type WebGLRenderer,
} from 'three'
import { POOL, PHYSICS_DT, clamp } from '../core/config'
import { FullScreenPass } from '../render/FullScreenPass'
import type { FlowField, Vec2 } from './FlowField'
import { FOAM_STEP_FRAG } from './shaders/foamStep'
import { WAVE_NORMAL_FRAG, WAVE_SPLAT_FRAG, WAVE_STEP_FRAG } from './shaders/waveStep'
import type { SplatQueue } from './WaveSplat'

const MAX_SPLATS = 32

export interface WaveFieldOptions {
  /** Texels along X. Texels along Z follow from the pool's aspect ratio. */
  resolution?: number
  speedScale?: number
  damping?: number
  levelDecay?: number
}

function createTarget(width: number, height: number, filter: typeof LinearFilter | typeof NearestFilter) {
  const target = new WebGLRenderTarget(width, height, {
    type: HalfFloatType,
    format: RGBAFormat,
    minFilter: filter,
    magFilter: filter,
    wrapS: ClampToEdgeWrapping,
    wrapT: ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  })
  return target
}

/**
 * The high-resolution water surface, simulated entirely on the GPU.
 *
 * Two RGBA16F targets ping-pong; R holds the current height and G the previous
 * one, which is all the leapfrog scheme needs. Each step is a splat pass
 * followed by a step pass, then a normal pass derives shading data. A foam
 * field rides alongside, advected by the same current that pushes the floats.
 *
 * This field is for looks only. Buoyancy reads WaveFieldCPU instead — see the
 * note there for why nothing is ever read back from these targets.
 */
export class WaveField {
  readonly width = POOL.width
  readonly depth = POOL.depth
  readonly resolutionX: number
  readonly resolutionY: number
  readonly cellSize: number

  speedScale: number
  damping: number
  levelDecay: number
  /** Whitewater lifetime control, exposed to the GUI. */
  foamDecay = 0.55
  foamChurnThreshold = 0.35
  foamChurnGain = 1.4

  private stateA: WebGLRenderTarget
  private stateB: WebGLRenderTarget
  private normalTarget: WebGLRenderTarget
  private foamA: WebGLRenderTarget
  private foamB: WebGLRenderTarget

  private readonly splatPass: FullScreenPass
  private readonly stepPass: FullScreenPass
  private readonly normalPass: FullScreenPass
  private readonly foamPass: FullScreenPass

  private readonly splatData: Vector4[] = []
  private readonly splatFoamData: Vector4[] = []

  /** Coarse RG texture of the current, shared by foam advection and the water shader. */
  readonly flowTexture: DataTexture
  private readonly flowWidth = 64
  private readonly flowHeight = 40
  private readonly flowData: Float32Array
  private flowDirty = true

  constructor(options: WaveFieldOptions = {}) {
    const resolution = options.resolution ?? 512
    this.resolutionX = resolution
    this.resolutionY = Math.round((resolution * POOL.depth) / POOL.width)
    this.cellSize = POOL.width / this.resolutionX

    this.speedScale = options.speedScale ?? 0.6
    this.damping = options.damping ?? 0.9
    this.levelDecay = options.levelDecay ?? 0.05

    this.stateA = createTarget(this.resolutionX, this.resolutionY, LinearFilter)
    this.stateB = createTarget(this.resolutionX, this.resolutionY, LinearFilter)
    this.normalTarget = createTarget(this.resolutionX, this.resolutionY, LinearFilter)
    this.foamA = createTarget(this.resolutionX >> 1, this.resolutionY >> 1, LinearFilter)
    this.foamB = createTarget(this.resolutionX >> 1, this.resolutionY >> 1, LinearFilter)

    for (let i = 0; i < MAX_SPLATS; i++) {
      this.splatData.push(new Vector4(0, 0, 1, 0))
      this.splatFoamData.push(new Vector4(0, 0, 1, 0))
    }

    this.flowData = new Float32Array(this.flowWidth * this.flowHeight * 2)
    this.flowTexture = new DataTexture(
      this.flowData,
      this.flowWidth,
      this.flowHeight,
      RGFormat,
      FloatType,
    )
    this.flowTexture.minFilter = LinearFilter
    this.flowTexture.magFilter = LinearFilter
    this.flowTexture.wrapS = ClampToEdgeWrapping
    this.flowTexture.wrapT = ClampToEdgeWrapping
    this.flowTexture.needsUpdate = true

    const texel = new Vector2(1 / this.resolutionX, 1 / this.resolutionY)
    const domain = new Vector2(POOL.width, POOL.depth)

    this.splatPass = new FullScreenPass(WAVE_SPLAT_FRAG, {
      uState: { value: null },
      uSplatCount: { value: 0 },
      uSplats: { value: this.splatData },
      uSplatFoam: { value: this.splatFoamData },
      uDomain: { value: domain },
    })

    this.stepPass = new FullScreenPass(WAVE_STEP_FRAG, {
      uState: { value: null },
      uTexel: { value: texel },
      uRateKeep: { value: 1 },
      uLevelKeep: { value: 1 },
      uShallowDepth: { value: POOL.shallowDepth },
      uDeepDepth: { value: POOL.deepDepth },
      uSpeedScale: { value: this.speedScale },
      uDt: { value: PHYSICS_DT },
      uCellSize: { value: this.cellSize },
    })

    this.normalPass = new FullScreenPass(WAVE_NORMAL_FRAG, {
      uState: { value: null },
      uTexel: { value: texel },
      uCell: { value: new Vector2(POOL.width / this.resolutionX, POOL.depth / this.resolutionY) },
    })

    this.foamPass = new FullScreenPass(FOAM_STEP_FRAG, {
      uFoam: { value: null },
      uState: { value: null },
      uFlow: { value: this.flowTexture },
      uDt: { value: PHYSICS_DT },
      uDecay: { value: this.foamDecay },
      uChurnThreshold: { value: this.foamChurnThreshold },
      uChurnGain: { value: this.foamChurnGain },
      uSplatCount: { value: 0 },
      uSplats: { value: this.splatData },
      uSplatFoam: { value: this.splatFoamData },
      uDomain: { value: domain },
    })
  }

  /** RGB = world-space surface normal, A = height in metres. */
  get normalTexture() {
    return this.normalTarget.texture
  }

  get foamTexture() {
    return this.foamA.texture
  }

  /** Rebuild the current texture. Cheap, but only needed when the flow changes. */
  markFlowDirty(): void {
    this.flowDirty = true
  }

  private updateFlowTexture(flow: FlowField): void {
    if (!this.flowDirty) return
    const out: Vec2 = { x: 0, z: 0 }
    let i = 0
    for (let j = 0; j < this.flowHeight; j++) {
      const z = ((j + 0.5) / this.flowHeight - 0.5) * POOL.depth
      for (let k = 0; k < this.flowWidth; k++) {
        const x = ((k + 0.5) / this.flowWidth - 0.5) * POOL.width
        flow.velocityAt(x, z, out)
        this.flowData[i++] = out.x
        this.flowData[i++] = out.z
      }
    }
    this.flowTexture.needsUpdate = true
    this.flowDirty = false
  }

  private uploadSplats(queue: SplatQueue): number {
    const count = Math.min(queue.length, MAX_SPLATS)
    for (let i = 0; i < count; i++) {
      const splat = queue.at(i)
      // Sigma is floored at a texel so a splat can never fall between texels
      // and vanish on the GPU while still registering on the coarse CPU field.
      const sigma = Math.max(splat.radius, this.cellSize * 1.5)
      this.splatData[i]!.set(splat.x, splat.z, sigma, splat.strength)
      this.splatFoamData[i]!.set(splat.x, splat.z, sigma * 1.6, splat.foam)
    }
    return count
  }

  /**
   * Advance the surface by one step and refresh the derived textures.
   *
   * `queue` must be the same list handed to WaveFieldCPU, and only on the first
   * substep — pass null for the rest, or the disturbance would be injected once
   * per substep here and once in total on the CPU, and the two fields would
   * disagree about how hard the water was hit.
   */
  step(renderer: WebGLRenderer, queue: SplatQueue | null, flow: FlowField, dt: number): void {
    this.updateFlowTexture(flow)
    const count = queue ? this.uploadSplats(queue) : 0

    // Splat pass: stateA -> stateB, so the step below sees neighbours that
    // already carry the disturbance. With no splats this is a plain copy, which
    // keeps the ping-pong parity the same on every substep.
    this.splatPass.uniforms.uState!.value = this.stateA.texture
    this.splatPass.uniforms.uSplatCount!.value = count
    this.splatPass.render(renderer, this.stateB)

    // Step pass: stateB -> stateA, leaving the current state back in A.
    const step = this.stepPass.uniforms
    step.uState!.value = this.stateB.texture
    step.uRateKeep!.value = clamp(1 - this.damping * dt, 0, 1)
    step.uLevelKeep!.value = clamp(1 - this.levelDecay * dt, 0, 1)
    step.uSpeedScale!.value = this.speedScale
    step.uDt!.value = dt
    this.stepPass.render(renderer, this.stateA)

    const foam = this.foamPass.uniforms
    foam.uFoam!.value = this.foamA.texture
    foam.uState!.value = this.stateA.texture
    foam.uDt!.value = dt
    foam.uDecay!.value = this.foamDecay
    foam.uChurnThreshold!.value = this.foamChurnThreshold
    foam.uChurnGain!.value = this.foamChurnGain
    foam.uSplatCount!.value = count
    this.foamPass.render(renderer, this.foamB)
    const swapFoam = this.foamA
    this.foamA = this.foamB
    this.foamB = swapFoam
  }

  /** Recompute normals. Run once per rendered frame, after the last sim step. */
  refreshNormals(renderer: WebGLRenderer): void {
    this.normalPass.uniforms.uState!.value = this.stateA.texture
    this.normalPass.render(renderer, this.normalTarget)
  }

  /** Flatten the surface and clear the whitewater. */
  reset(renderer: WebGLRenderer): void {
    const previous = renderer.getRenderTarget()
    for (const target of [this.stateA, this.stateB, this.normalTarget, this.foamA, this.foamB]) {
      renderer.setRenderTarget(target)
      renderer.setClearColor(0x000000, 0)
      renderer.clear(true, false, false)
    }
    renderer.setRenderTarget(previous)
  }

  dispose(): void {
    for (const target of [this.stateA, this.stateB, this.normalTarget, this.foamA, this.foamB]) {
      target.dispose()
    }
    this.splatPass.dispose()
    this.stepPass.dispose()
    this.normalPass.dispose()
    this.foamPass.dispose()
    this.flowTexture.dispose()
  }
}
