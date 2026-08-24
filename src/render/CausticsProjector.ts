import {
  ClampToEdgeWrapping,
  Color,
  HalfFloatType,
  LinearFilter,
  RGBAFormat,
  Vector2,
  Vector3,
  WebGLRenderTarget,
  type Material,
  type MeshStandardMaterial,
  type Texture,
  type WebGLRenderer,
} from 'three'
import { WATER_LEVEL } from '../core/config'
import { DOMAIN } from '../core/world'
import { CAUSTICS_FRAG, CAUSTICS_RECEIVER_GLSL } from '../sim/shaders/caustics'
import { FullScreenPass } from './FullScreenPass'

/**
 * Renders the caustics texture and wires it into any material that should
 * receive it — the pool floor and walls, and anything drifting below the
 * surface.
 */
export class CausticsProjector {
  private readonly target: WebGLRenderTarget
  private readonly pass: FullScreenPass
  readonly sunDirection = new Vector3(0, 1, 0)
  intensity = 1.15
  readonly tint = new Color('#cfeeff')

  constructor(normalTexture: Texture, bathymetry: Texture, resolution = 512) {
    const height = Math.round((resolution * DOMAIN.depth) / DOMAIN.width)
    this.target = new WebGLRenderTarget(resolution, height, {
      type: HalfFloatType,
      format: RGBAFormat,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      wrapS: ClampToEdgeWrapping,
      wrapT: ClampToEdgeWrapping,
      depthBuffer: false,
      stencilBuffer: false,
    })

    this.pass = new FullScreenPass(CAUSTICS_FRAG, {
      uNormal: { value: normalTexture },
      uTexel: { value: new Vector2(1 / resolution, 1 / height) },
      uDomain: { value: new Vector2(DOMAIN.width, DOMAIN.depth) },
      uSunDirection: { value: this.sunDirection },
      uBathymetry: { value: bathymetry },
      uStrength: { value: 0.6 },
    })
  }

  get texture(): Texture {
    return this.target.texture
  }

  render(renderer: WebGLRenderer): void {
    this.pass.render(renderer, this.target)
  }

  /**
   * Patch a standard material so its underwater fragments pick up the caustics.
   * Returns the uniforms so the caller can retune them later.
   */
  attach(material: MeshStandardMaterial): void {
    const uniforms = {
      uCaustics: { value: this.texture },
      uCausticsDomain: { value: new Vector2(DOMAIN.width, DOMAIN.depth) },
      uCausticsCentre: { value: new Vector2(DOMAIN.centerX, DOMAIN.centerZ) },
      uCausticsSun: { value: this.sunDirection },
      uCausticsWaterLevel: { value: WATER_LEVEL },
      uCausticsIntensity: { value: this.intensity },
      uCausticsTint: { value: this.tint },
    }

    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms)
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vPoolWorldPos;')
        .replace(
          '#include <worldpos_vertex>',
          '#include <worldpos_vertex>\n  vPoolWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;',
        )
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${CAUSTICS_RECEIVER_GLSL}`)
        .replace(
          '#include <tonemapping_fragment>',
          '  gl_FragColor.rgb += poolCaustics();\n#include <tonemapping_fragment>',
        )
    }
    // Force a recompile if the material has already been used.
    material.needsUpdate = true
    trackedMaterials.push({ material, uniforms })
  }

  /** Push current settings into every attached material. */
  syncAttached(): void {
    for (const entry of trackedMaterials) {
      entry.uniforms.uCausticsIntensity.value = this.intensity
      entry.uniforms.uCaustics.value = this.texture
    }
  }

  dispose(): void {
    this.target.dispose()
    this.pass.dispose()
    trackedMaterials.length = 0
  }
}

interface TrackedMaterial {
  material: Material
  uniforms: {
    uCaustics: { value: Texture }
    uCausticsIntensity: { value: number }
  }
}

const trackedMaterials: TrackedMaterial[] = []
