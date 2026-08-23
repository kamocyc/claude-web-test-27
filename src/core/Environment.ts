import {
  BackSide,
  Color,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  PMREMGenerator,
  Scene,
  ShaderMaterial,
  SRGBColorSpace,
  SphereGeometry,
  Vector3,
  type IUniform,
  type WebGLRenderer,
} from 'three'
import { SKY_GLSL } from '../sim/shaders/common'

export interface SkyUniforms extends Record<string, IUniform> {
  uSunDirection: IUniform<Vector3>
  uSunColor: IUniform<Color>
  uZenithColor: IUniform<Color>
  uHorizonColor: IUniform<Color>
  uGroundColor: IUniform<Color>
  uSkyIntensity: IUniform<number>
}

const SKY_VERT = /* glsl */ `
varying vec3 vDirection;
void main() {
  vDirection = position;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  gl_Position.z = gl_Position.w; // pin to the far plane
}
`

const SKY_FRAG = /* glsl */ `
varying vec3 vDirection;
${SKY_GLSL}
void main() {
  gl_FragColor = vec4(skyColor(normalize(vDirection)), 1.0);
}
`

/**
 * Procedural sky, sun and image-based lighting.
 *
 * The sky is analytic rather than a texture, and the water's reflection shader
 * calls the very same GLSL function through a shared uniform block. That is
 * what keeps a reflected sun in the pool lined up with the sun in the sky when
 * the time of day is dragged around.
 */
export class Environment {
  readonly uniforms: SkyUniforms
  readonly sunDirection = new Vector3()
  readonly sun: DirectionalLight
  readonly ambient: HemisphereLight
  readonly skyMesh: Mesh

  private readonly pmrem: PMREMGenerator
  private readonly skyScene = new Scene()
  private environmentDirty = true

  constructor(
    private readonly scene: Scene,
    renderer: WebGLRenderer,
  ) {
    this.uniforms = {
      uSunDirection: { value: new Vector3(0.4, 0.72, 0.57).normalize() },
      uSunColor: { value: new Color('#fff2d6') },
      uZenithColor: { value: new Color('#3f86d8') },
      uHorizonColor: { value: new Color('#9dc9e8') },
      // Roughly the hedge and deck the sky dome sits behind, so the horizon
      // blends into the scene instead of banding against it.
      uGroundColor: { value: new Color('#6f7f68') },
      // The sky is a light source as much as a backdrop; ACES pulls the
      // midtones down hard, so it is authored above 1 to survive tone mapping.
      uSkyIntensity: { value: 1.55 },
    }

    const material = new ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      uniforms: this.uniforms,
      side: BackSide,
      depthWrite: false,
      toneMapped: true,
    })
    this.skyMesh = new Mesh(new SphereGeometry(1, 32, 16), material)
    this.skyMesh.frustumCulled = false
    this.skyMesh.renderOrder = -1000
    scene.add(this.skyMesh)

    this.sun = new DirectionalLight(0xfff3dd, 2.6)
    this.sun.castShadow = true
    this.sun.shadow.mapSize.set(2048, 2048)
    this.sun.shadow.camera.near = 1
    this.sun.shadow.camera.far = 60
    this.sun.shadow.camera.left = -16
    this.sun.shadow.camera.right = 16
    this.sun.shadow.camera.top = 16
    this.sun.shadow.camera.bottom = -16
    this.sun.shadow.bias = -0.0012
    this.sun.shadow.normalBias = 0.03
    scene.add(this.sun)
    scene.add(this.sun.target)

    this.ambient = new HemisphereLight(0xcfe6f4, 0x6f7a70, 0.85)
    scene.add(this.ambient)

    this.pmrem = new PMREMGenerator(renderer)
    // The IBL scene holds only the sky; a second, unit-scaled copy of the mesh
    // keeps it independent of whatever the main sky dome is doing.
    const iblSky = new Mesh(this.skyMesh.geometry, material)
    iblSky.scale.setScalar(10)
    this.skyScene.add(iblSky)

    this.setSun(42, 35)
  }

  /** Position the sun. Elevation and azimuth are in degrees. */
  setSun(elevationDeg: number, azimuthDeg: number): void {
    const elevation = (elevationDeg * Math.PI) / 180
    const azimuth = (azimuthDeg * Math.PI) / 180
    this.sunDirection
      .set(Math.cos(elevation) * Math.sin(azimuth), Math.sin(elevation), Math.cos(elevation) * Math.cos(azimuth))
      .normalize()
    this.uniforms.uSunDirection.value.copy(this.sunDirection)

    this.sun.position.copy(this.sunDirection).multiplyScalar(26)
    this.sun.target.position.set(0, -1, 0)
    this.sun.target.updateMatrixWorld()

    // Redden and dim the light as the sun drops, so dusk reads as dusk.
    //
    // Warmth stays at zero until the sun is genuinely low. Ramping it linearly
    // from the zenith instead desaturates the sky all afternoon and leaves a
    // midday horizon looking grey.
    //
    // The colours are given in sRGB explicitly: setRGB defaults to the
    // renderer's linear working space, and numbers picked to look like a hex
    // colour come out far brighter and much flatter there.
    const height = Math.max(this.sunDirection.y, 0)
    const warmth = Math.pow(Math.max(0, 1 - height / 0.4), 1.5)

    this.sun.color.setRGB(1, 0.97 - warmth * 0.25, 0.9 - warmth * 0.45, SRGBColorSpace)
    this.sun.intensity = 0.4 + height * 2.6
    this.uniforms.uSunColor.value.setRGB(1, 0.96 - warmth * 0.22, 0.88 - warmth * 0.4, SRGBColorSpace)
    this.uniforms.uHorizonColor.value.setRGB(
      0.6 + warmth * 0.38,
      0.78 - warmth * 0.16,
      0.93 - warmth * 0.51,
      SRGBColorSpace,
    )
    this.uniforms.uSkyIntensity.value = 1.55 - warmth * 0.5
    this.ambient.intensity = 0.35 + height * 0.85

    this.environmentDirty = true
  }

  /** Keep the sky dome centred on the camera so it never clips. */
  follow(cameraPosition: Vector3): void {
    this.skyMesh.position.copy(cameraPosition)
    this.skyMesh.scale.setScalar(300)
  }

  /** Rebuild the environment map when the sky has changed. Cheap to call every frame. */
  updateEnvironment(): void {
    if (!this.environmentDirty) return
    this.environmentDirty = false
    const previous = this.scene.environment
    const target = this.pmrem.fromScene(this.skyScene)
    this.scene.environment = target.texture
    this.scene.environmentIntensity = 0.85
    previous?.dispose()
  }

  dispose(): void {
    this.pmrem.dispose()
    this.skyMesh.geometry.dispose()
    ;(this.skyMesh.material as ShaderMaterial).dispose()
  }
}
