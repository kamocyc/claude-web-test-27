import {
  ClampToEdgeWrapping,
  Color,
  DataTexture,
  FloatType,
  HalfFloatType,
  LinearFilter,
  NearestFilter,
  RGFormat,
  RGBAFormat,
  Vector2,
  WebGLRenderTarget,
  type TextureDataType,
  type WebGLRenderer,
} from 'three'
import { POOL, PHYSICS_DT, clamp } from '../core/config'
import { FullScreenPass } from '../render/FullScreenPass'
import type { FlowField, Vec2 } from './FlowField'
import { FOAM_STEP_FRAG } from './shaders/foamStep'
import { COPY_FRAG, WAVE_NORMAL_FRAG, WAVE_STEP_FRAG } from './shaders/waveStep'
import { SplatRenderer } from './SplatRenderer'
import type { SplatQueue } from './WaveSplat'

const _clearColor = new Color()

/** IEEE half-float bits to a number, for reading back a half-precision field. */
function decodeHalf(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1
  const exponent = (bits & 0x7c00) >> 10
  const fraction = bits & 0x03ff
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024)
  if (exponent === 0x1f) return fraction ? Number.NaN : sign * Number.POSITIVE_INFINITY
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024)
}

export interface WaveFieldOptions {
  /** Texels along X. Texels along Z follow from the pool's aspect ratio. */
  resolution?: number
  speedScale?: number
  damping?: number
  levelDecay?: number
}

export interface FieldStats {
  /** Largest absolute surface height in the field, metres. */
  peak: number
  /** Mean surface height — the quantity a volume leak would send climbing. */
  mean: number
  /** Count of non-finite texels. Anything above zero means it has diverged. */
  nonFinite: number
}

function createTarget(
  width: number,
  height: number,
  type: TextureDataType,
  filter: typeof LinearFilter | typeof NearestFilter,
) {
  return new WebGLRenderTarget(width, height, {
    type,
    format: RGBAFormat,
    minFilter: filter,
    magFilter: filter,
    wrapS: ClampToEdgeWrapping,
    wrapT: ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  })
}

/**
 * The high-resolution water surface, simulated entirely on the GPU.
 *
 * Two float render targets ping-pong; R holds the current height and G the
 * previous one, which is all the leapfrog scheme needs. Each step copies the
 * state, stamps the splats into the copy, advances it, and then a normal pass
 * derives shading data. A foam field rides alongside, advected by the same
 * current that pushes the floats.
 *
 * This field is for looks only. Buoyancy reads WaveFieldCPU instead — see the
 * note there for why nothing is ever read back from these targets during
 * normal operation.
 */
export class WaveField {
  readonly width = POOL.width
  readonly depth = POOL.depth
  readonly resolutionX: number
  readonly resolutionY: number
  readonly cellSize: number
  /** True when the state targets got full float precision. See below. */
  readonly highPrecision: boolean

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

  private readonly copyPass: FullScreenPass
  private readonly stepPass: FullScreenPass
  private readonly normalPass: FullScreenPass
  private readonly foamPass: FullScreenPass
  private readonly splatRenderer = new SplatRenderer()

  /** Coarse RG texture of the current, shared by foam advection and the water shader. */
  readonly flowTexture: DataTexture
  private readonly flowWidth = 64
  private readonly flowHeight = 40
  private readonly flowData: Float32Array
  private flowDirty = true

  constructor(renderer: WebGLRenderer, options: WaveFieldOptions = {}) {
    const resolution = options.resolution ?? 512
    this.resolutionX = resolution
    this.resolutionY = Math.round((resolution * POOL.depth) / POOL.width)
    this.cellSize = POOL.width / this.resolutionX

    this.speedScale = options.speedScale ?? 0.6
    this.damping = options.damping ?? 0.3
    this.levelDecay = options.levelDecay ?? 0.05

    // The state must be full float. Half float carries about eleven bits of
    // mantissa, and the level decay is a multiply by 1 - 2.1e-4 per step —
    // always less than half an ULP, so it rounds straight back to the value it
    // started from. The decay silently stops happening, any net volume the
    // splats inject accumulates forever, and the pool inflates until it leaves
    // the screen. Everything downstream (normals, foam) is fine at half.
    this.highPrecision = renderer.extensions.has('EXT_color_buffer_float')
    const stateType: TextureDataType = this.highPrecision ? FloatType : HalfFloatType

    // Nearest filtering on the state: every read is at an exact texel centre,
    // and it keeps float targets off the OES_texture_float_linear extension.
    this.stateA = createTarget(this.resolutionX, this.resolutionY, stateType, NearestFilter)
    this.stateB = createTarget(this.resolutionX, this.resolutionY, stateType, NearestFilter)
    this.normalTarget = createTarget(
      this.resolutionX,
      this.resolutionY,
      HalfFloatType,
      LinearFilter,
    )
    this.foamA = createTarget(
      this.resolutionX >> 1,
      this.resolutionY >> 1,
      HalfFloatType,
      LinearFilter,
    )
    this.foamB = createTarget(
      this.resolutionX >> 1,
      this.resolutionY >> 1,
      HalfFloatType,
      LinearFilter,
    )

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

    this.copyPass = new FullScreenPass(COPY_FRAG, { uState: { value: null } })

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
      uDomain: { value: new Vector2(POOL.width, POOL.depth) },
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

    // Copy stateA into stateB, stamp this step's splats on top, then advance
    // stateB back into stateA. The copy is what lets the step's stencil see
    // neighbours that already carry the disturbance.
    this.copyPass.uniforms.uState!.value = this.stateA.texture
    this.copyPass.render(renderer, this.stateB)
    if (queue) {
      this.splatRenderer.render(renderer, this.stateB, queue, 'height', this.cellSize * 1.5)
    }

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
    this.foamPass.render(renderer, this.foamB)
    if (queue) {
      // Foam is a rate, so it scales with the step length; the height channel
      // is a displacement in metres and goes in as-is.
      this.splatRenderer.render(renderer, this.foamB, queue, 'foam', this.cellSize * 2, dt * 6)
    }
    const swapFoam = this.foamA
    this.foamA = this.foamB
    this.foamB = swapFoam
  }

  /** Recompute normals. Run once per rendered frame, after the last sim step. */
  refreshNormals(renderer: WebGLRenderer): void {
    this.normalPass.uniforms.uState!.value = this.stateA.texture
    this.normalPass.render(renderer, this.normalTarget)
  }

  /**
   * Read the height field back and summarise it.
   *
   * Diagnostic only — it stalls the pipeline, so it is for the smoke test and
   * the debug panel, never the frame loop.
   */
  sampleStats(renderer: WebGLRenderer): FieldStats {
    const width = this.resolutionX
    const height = this.resolutionY
    // The read buffer has to match the target's storage, which is not always
    // float — see highPrecision.
    const buffer = this.highPrecision
      ? new Float32Array(width * height * 4)
      : new Uint16Array(width * height * 4)
    renderer.readRenderTargetPixels(this.stateA, 0, 0, width, height, buffer)

    let peak = 0
    let sum = 0
    let nonFinite = 0
    for (let i = 0; i < width * height; i++) {
      const raw = buffer[i * 4]!
      const value = this.highPrecision ? raw : decodeHalf(raw)
      if (!Number.isFinite(value)) {
        nonFinite++
        continue
      }
      peak = Math.max(peak, Math.abs(value))
      sum += value
    }
    return { peak, mean: sum / (width * height), nonFinite }
  }

  /** Flatten the surface and clear the whitewater. */
  reset(renderer: WebGLRenderer): void {
    const previousTarget = renderer.getRenderTarget()
    const previousClear = renderer.getClearColor(_clearColor).getHex()
    const previousAlpha = renderer.getClearAlpha()
    renderer.setClearColor(0x000000, 0)
    for (const target of [this.stateA, this.stateB, this.normalTarget, this.foamA, this.foamB]) {
      renderer.setRenderTarget(target)
      renderer.clear(true, false, false)
    }
    renderer.setRenderTarget(previousTarget)
    renderer.setClearColor(previousClear, previousAlpha)
  }

  dispose(): void {
    for (const target of [this.stateA, this.stateB, this.normalTarget, this.foamA, this.foamB]) {
      target.dispose()
    }
    this.copyPass.dispose()
    this.stepPass.dispose()
    this.normalPass.dispose()
    this.foamPass.dispose()
    this.splatRenderer.dispose()
    this.flowTexture.dispose()
  }
}
