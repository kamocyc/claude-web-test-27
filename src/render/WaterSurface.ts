import {
  Color,
  DepthTexture,
  DoubleSide,
  HalfFloatType,
  LinearFilter,

  Mesh,
  NearestFilter,
  PerspectiveCamera,
  PlaneGeometry,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  UnsignedIntType,
  DepthFormat,
  Vector2,
  Vector3,
  WebGLRenderTarget,
  type Texture,
  type WebGLRenderer,
} from 'three'
import { WATER_LEVEL } from '../core/config'
import { DOMAIN, isWet } from '../core/world'
import type { SkyUniforms } from '../core/Environment'
import type { WaveField } from '../sim/WaveField'
import { PlanarReflection } from './PlanarReflection'
import { makeRippleNormalTexture } from './textures'
import { WATER_FRAG, WATER_VERT } from './shaders/water'

export interface WaterSurfaceOptions {
  /** Vertices along X for the displaced surface mesh. */
  segments?: number
  /** Fraction of canvas resolution used for the mirror pass. */
  reflectionScale?: number
}

/**
 * The water surface itself: geometry displaced by the height field, shaded with
 * screen-space refraction, planar reflection, depth absorption and foam.
 *
 * Getting the refraction right needs the opaque scene rendered once without the
 * water, into a colour target with a depth attachment. `renderFrame` owns that
 * sequence — reflection pass, refraction pass, final pass — because the three
 * have to happen in that order with the water hidden for the first two.
 */
export class WaterSurface {
  readonly mesh: Mesh
  readonly material: ShaderMaterial
  private readonly reflection: PlanarReflection
  private readonly sceneTarget: WebGLRenderTarget
  private readonly depthTexture: DepthTexture
  private readonly rippleTexture: Texture
  private readonly reflectionScale: number
  private readonly resolution = new Vector2(1, 1)

  constructor(
    private readonly waves: WaveField,
    sky: SkyUniforms,
    options: WaterSurfaceOptions = {},
  ) {
    const segments = options.segments ?? 256
    this.reflectionScale = options.reflectionScale ?? 0.5

    this.depthTexture = new DepthTexture(1, 1, UnsignedIntType)
    this.depthTexture.format = DepthFormat
    this.depthTexture.minFilter = NearestFilter
    this.depthTexture.magFilter = NearestFilter

    this.sceneTarget = new WebGLRenderTarget(1, 1, {
      type: HalfFloatType,
      format: RGBAFormat,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      depthTexture: this.depthTexture,
      stencilBuffer: false,
      generateMipmaps: false,
    })

    this.reflection = new PlanarReflection(1, 1)
    this.rippleTexture = makeRippleNormalTexture()

    const geometry = new PlaneGeometry(
      DOMAIN.width,
      DOMAIN.depth,
      segments,
      Math.round((segments * DOMAIN.depth) / DOMAIN.width),
    )
    geometry.rotateX(-Math.PI / 2)

    this.material = new ShaderMaterial({
      vertexShader: WATER_VERT,
      fragmentShader: WATER_FRAG,
      transparent: true,
      side: DoubleSide,
      uniforms: {
        ...sky,
        uSurface: { value: waves.normalTexture },
        uFoam: { value: waves.foamTexture },
        uFlow: { value: waves.flowTexture },
        uRipple: { value: this.rippleTexture },
        uSceneColor: { value: this.sceneTarget.texture },
        uSceneDepth: { value: this.depthTexture },
        uReflection: { value: this.reflection.texture },
        uReflectionMatrix: { value: this.reflection.textureMatrix },
        uResolution: { value: this.resolution },
        uDomain: { value: new Vector2(DOMAIN.width, DOMAIN.depth) },
        uCameraNear: { value: 0.1 },
        uCameraFar: { value: 400 },
        uTime: { value: 0 },
        uReflectionMix: { value: 0.85 },
        uRefractionScale: { value: 0.09 },
        // Kept low on purpose: this is the fine wind-ripple texture, and at
        // higher values it swamps the ripples the simulation is producing,
        // which are the ones that carry meaning.
        uDetailStrength: { value: 0.085 },
        uDetailScale: { value: 0.32 },
        uEdgeSoftness: { value: 0.28 },
        // Beer-Lambert coefficients per metre. Red is absorbed fastest, which
        // is exactly why deep water reads blue-green.
        uAbsorption: { value: new Vector3(0.78, 0.2, 0.11) },
        uDeepColor: { value: new Color('#0a4d61') },
        uFoamColor: { value: new Color('#eef8ff') },
        uRoughness: { value: 0.075 },
        uGlitter: { value: 6 },
      },
    })

    this.mesh = new Mesh(geometry, this.material)
    // The domain is not centred on the origin any more; the mesh carries the
    // offset so the vertex shader's `position.xz / uDomain + 0.5` lookup stays
    // exactly as it was.
    this.mesh.position.set(DOMAIN.centerX, WATER_LEVEL, DOMAIN.centerZ)
    this.mesh.renderOrder = 10
    this.mesh.frustumCulled = false
    this.mesh.name = 'water-surface'
  }

  setSize(width: number, height: number, pixelRatio: number): void {
    const w = Math.max(2, Math.floor(width * pixelRatio))
    const h = Math.max(2, Math.floor(height * pixelRatio))
    this.resolution.set(w, h)
    this.sceneTarget.setSize(w, h)
    this.reflection.setSize(
      Math.floor(w * this.reflectionScale),
      Math.floor(h * this.reflectionScale),
    )
  }

  set reflectionEnabled(value: boolean) {
    this.reflection.enabled = value
    this.material.uniforms.uReflectionMix!.value = value ? 0.85 : 0
  }

  get reflectionEnabled(): boolean {
    return this.reflection.enabled
  }

  /**
   * Draw one frame: mirror pass, refraction pass, then the real thing.
   *
   * `alsoHidden` is for anything that must stay out of the reflection and
   * refraction buffers alongside the water — spray particles, say, which would
   * otherwise be sampled as if they were solid geometry behind the surface.
   */
  renderFrame(
    renderer: WebGLRenderer,
    scene: Scene,
    camera: PerspectiveCamera,
    elapsed: number,
    alsoHidden: { visible: boolean }[] = [],
  ): void {
    const uniforms = this.material.uniforms
    uniforms.uTime!.value = elapsed
    uniforms.uCameraNear!.value = camera.near
    uniforms.uCameraFar!.value = camera.far
    uniforms.uSurface!.value = this.waves.normalTexture
    uniforms.uFoam!.value = this.waves.foamTexture

    const hidden = [this.mesh, ...alsoHidden]
    this.reflection.render(renderer, scene, camera, hidden)

    // Refraction source: the scene as it looks with the water taken away.
    const wasVisible = hidden.map((object) => object.visible)
    for (const object of hidden) object.visible = false
    renderer.setRenderTarget(this.sceneTarget)
    renderer.clear()
    renderer.render(scene, camera)
    renderer.setRenderTarget(null)
    hidden.forEach((object, i) => {
      object.visible = wasVisible[i]!
    })

    renderer.render(scene, camera)
  }

  /** World-space surface point under a screen ray, for click-to-splash. */
  static intersectSurface(origin: Vector3, direction: Vector3, out: Vector3): boolean {
    if (Math.abs(direction.y) < 1e-5) return false
    const t = (WATER_LEVEL - origin.y) / direction.y
    if (t < 0) return false
    out.copy(direction).multiplyScalar(t).add(origin)
    return isWet(out.x, out.z)
  }

  dispose(): void {
    this.mesh.geometry.dispose()
    this.material.dispose()
    this.sceneTarget.dispose()
    this.depthTexture.dispose()
    this.reflection.dispose()
    this.rippleTexture.dispose()
  }
}

