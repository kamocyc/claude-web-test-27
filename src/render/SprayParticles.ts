import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Points,
  ShaderMaterial,
  Vector3,
} from 'three'
import { GRAVITY, WATER_LEVEL } from '../core/config'
import { groundYAt } from '../core/world'
import type { SplashOptions } from '../physics/PhysicsWorld'
import type { FlowField, Vec2 } from '../sim/FlowField'
import type { WaveFieldCPU } from '../sim/WaveFieldCPU'
import type { SplatQueue } from '../sim/WaveSplat'

const SPRAY_VERT = /* glsl */ `
attribute float aLife;
attribute float aSize;
uniform float uPixelScale;
varying float vLife;

void main() {
  vLife = aLife;
  vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * viewPosition;
  // aSize is the droplet's diameter in metres and uPixelScale converts metres
  // at one metre away into pixels, so a droplet covers the same solid angle as
  // real geometry of that size would. The upper clamp stops a droplet that
  // drifts across the lens from filling the screen.
  float size = aSize * uPixelScale * smoothstep(0.0, 0.35, aLife) / max(-viewPosition.z, 0.1);
  gl_PointSize = clamp(size, 1.0, 48.0);
}
`

const SPRAY_FRAG = /* glsl */ `
varying float vLife;
uniform vec3 uColor;

void main() {
  vec2 offset = gl_PointCoord - 0.5;
  float d = dot(offset, offset);
  if (d > 0.25) discard;
  float core = smoothstep(0.25, 0.02, d);
  gl_FragColor = vec4(uColor, core * smoothstep(0.0, 0.25, vLife) * 0.85);
}
`

export interface SprayOptions {
  capacity?: number
  /** Droplet air drag, per second. */
  drag?: number
}

/**
 * Airborne droplets, thrown by anything that hits the water hard enough.
 *
 * The loop closes here too: a droplet that lands emits its own wave splat and
 * a dab of foam, so a big entry throws spray that then ripples the surface
 * a moment later rather than just vanishing.
 */
export class SprayParticles {
  readonly points: Points
  private readonly positions: Float32Array
  private readonly velocities: Float32Array
  private readonly lives: Float32Array
  private readonly sizes: Float32Array
  private readonly capacity: number
  private readonly drag: number
  private cursor = 0
  private liveCount = 0

  constructor(options: SprayOptions = {}) {
    this.capacity = options.capacity ?? 4000
    this.drag = options.drag ?? 1.1

    this.positions = new Float32Array(this.capacity * 3)
    this.velocities = new Float32Array(this.capacity * 3)
    this.lives = new Float32Array(this.capacity)
    this.sizes = new Float32Array(this.capacity)

    // Park every droplet far below the pool until it is spawned.
    for (let i = 0; i < this.capacity; i++) this.positions[i * 3 + 1] = -1000

    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(this.positions, 3))
    geometry.setAttribute('aLife', new BufferAttribute(this.lives, 1))
    geometry.setAttribute('aSize', new BufferAttribute(this.sizes, 1))
    geometry.boundingSphere = null

    const material = new ShaderMaterial({
      vertexShader: SPRAY_VERT,
      fragmentShader: SPRAY_FRAG,
      uniforms: {
        uPixelScale: { value: 300 },
        uColor: { value: new Vector3(0.92, 0.97, 1) },
      },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    })

    this.points = new Points(geometry, material)
    this.points.frustumCulled = false
    this.points.renderOrder = 20
    this.points.name = 'spray'
  }

  get activeCount(): number {
    return this.liveCount
  }

  /**
   * Live droplets above a height. Anything well clear of the surface came out
   * of a fountain or a hard entry rather than a stroke, which is what makes
   * this worth asking.
   */
  countAbove(height: number): number {
    let count = 0
    for (let i = 0; i < this.capacity; i++) {
      if (this.lives[i]! > 0 && this.positions[i * 3 + 1]! > height) count++
    }
    return count
  }

  /**
   * Recompute the metres-to-pixels conversion. Must be called on resize and
   * whenever the field of view changes.
   */
  setProjection(heightInPixels: number, verticalFovDegrees: number): void {
    const scale = heightInPixels / (2 * Math.tan((verticalFovDegrees * Math.PI) / 360))
    ;(this.points.material as ShaderMaterial).uniforms.uPixelScale!.value = scale
  }

  /**
   * Throw `count` droplets from a point, biased upwards around `direction`.
   * `speed` sets how far they fly; `spread` how much they fan out.
   */
  emit(
    origin: Vector3,
    direction: Vector3,
    count: number,
    speed: number,
    spread = 0.7,
    options: SplashOptions = {},
  ): void {
    const jitter = options.speedJitter ?? 1
    for (let i = 0; i < count; i++) {
      const index = this.cursor
      this.cursor = (this.cursor + 1) % this.capacity
      if (this.lives[index]! <= 0) this.liveCount++

      const p = index * 3
      this.positions[p] = origin.x + (Math.random() - 0.5) * 0.08
      this.positions[p + 1] = origin.y + Math.random() * 0.05
      this.positions[p + 2] = origin.z + (Math.random() - 0.5) * 0.08

      const jitterX = (Math.random() - 0.5) * spread
      const jitterY = Math.random() * spread * 0.8
      const jitterZ = (Math.random() - 0.5) * spread
      // With jitter at 1 this is the old spread exactly; at 0 every droplet
      // leaves at the speed asked for, which is what a nozzle does.
      const varied = 0.55 + Math.random() * 0.75
      const magnitude = speed * (1 + (varied - 1) * jitter)
      this.velocities[p] = (direction.x + jitterX) * magnitude
      this.velocities[p + 1] = (direction.y + jitterY) * magnitude
      this.velocities[p + 2] = (direction.z + jitterZ) * magnitude

      this.lives[index] = (options.life ?? 0.9) * (0.5 + Math.random() * 0.94)
      // Droplet diameter in metres: fat splash beads, not fine mist. At the
      // distance the pool is usually viewed from, anything under a couple of
      // centimetres covers about two pixels and reads as nothing at all.
      this.sizes[index] = (options.size ?? 0.029) * (0.5 + Math.random() * 0.97)
    }
  }

  /** Integrate every live droplet and let the ones that land talk to the water. */
  update(dt: number, water: WaveFieldCPU, flow: FlowField, splats: SplatQueue): void {
    const airFlow: Vec2 = { x: 0, z: 0 }
    const dragFactor = Math.max(0, 1 - this.drag * dt)
    let live = 0

    for (let i = 0; i < this.capacity; i++) {
      const life = this.lives[i]!
      if (life <= 0) continue

      const p = i * 3
      const nextLife = life - dt
      if (nextLife <= 0) {
        this.lives[i] = 0
        this.positions[p + 1] = -1000
        continue
      }
      this.lives[i] = nextLife
      live++

      // Wind is the pool's own current, weakly coupled through the air.
      flow.velocityAt(this.positions[p]!, this.positions[p + 2]!, airFlow)
      this.velocities[p] = (this.velocities[p]! + airFlow.x * dt * 0.6) * dragFactor
      this.velocities[p + 1] = this.velocities[p + 1]! - GRAVITY * dt
      this.velocities[p + 2] = (this.velocities[p + 2]! + airFlow.z * dt * 0.6) * dragFactor

      const x = this.positions[p]! + this.velocities[p]! * dt
      const y = this.positions[p + 1]! + this.velocities[p + 1]! * dt
      const z = this.positions[p + 2]! + this.velocities[p + 2]! * dt

      // A droplet ends on whatever is under it: the moving surface where there
      // is water, the paving or the island where there is not. Without the
      // second case the ones thrown onto the deck fall on through it to y = 0.
      const insidePool = water.isWetAt(x, z)
      const surface = insidePool ? WATER_LEVEL + water.heightAt(x, z) : groundYAt(x, z)

      if (y <= surface && this.velocities[p + 1]! < 0) {
        if (insidePool) {
          // The droplet is reabsorbed, and it dents the surface as it goes.
          const impact = Math.min(-this.velocities[p + 1]! * 0.0016, 0.02)
          splats.addImpulse(x, z, 0.11, impact, 0.28)
        }
        this.lives[i] = 0
        this.positions[p + 1] = -1000
        live--
        continue
      }

      this.positions[p] = x
      this.positions[p + 1] = y
      this.positions[p + 2] = z
    }

    this.liveCount = live
    const geometry = this.points.geometry
    geometry.attributes.position!.needsUpdate = true
    geometry.attributes.aLife!.needsUpdate = true
    geometry.attributes.aSize!.needsUpdate = true
  }

  clear(): void {
    this.lives.fill(0)
    for (let i = 0; i < this.capacity; i++) this.positions[i * 3 + 1] = -1000
    this.liveCount = 0
    this.points.geometry.attributes.position!.needsUpdate = true
    this.points.geometry.attributes.aLife!.needsUpdate = true
  }

  dispose(): void {
    this.points.geometry.dispose()
    ;(this.points.material as ShaderMaterial).dispose()
  }
}
