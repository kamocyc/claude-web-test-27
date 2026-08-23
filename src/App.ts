import {
  Color,
  FogExp2,
  PerspectiveCamera,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
  type WebGLRenderer,
} from 'three'
import {
  MAX_STEPS_PER_FRAME,
  PHYSICS_DT,
  POOL,
  POOL_HALF_D,
  POOL_HALF_W,
  WATER_LEVEL,
  WAVE_DT,
  WAVE_SUBSTEPS,
} from './core/config'
import { Environment } from './core/Environment'
import { FollowCamera } from './core/FollowCamera'
import { Input } from './core/Input'
import { attachResize, createRenderer } from './core/Renderer'
import { AirMattress, BeachBall } from './entities/PoolFloat'
import { Pool } from './entities/Pool'
import { RubberDuck } from './entities/RubberDuck'
import { SwimRing } from './entities/SwimRing'
import { Swimmer } from './entities/Swimmer'
import { SwimmerAI } from './entities/SwimmerAI'
import type { FloatingObject } from './entities/FloatingObject'
import { PhysicsWorld } from './physics/PhysicsWorld'
import { CausticsProjector } from './render/CausticsProjector'
import { SprayParticles } from './render/SprayParticles'
import { WaterSurface } from './render/WaterSurface'
import { FlowField } from './sim/FlowField'
import { WaveField } from './sim/WaveField'
import { WaveFieldCPU } from './sim/WaveFieldCPU'
import { SplatQueue } from './sim/WaveSplat'

const UNDERWATER_FOG = new Color('#0c4b5c')
const ABOVE_WATER_CLEAR = new Color('#8fc6e8')

export interface AppQuality {
  /** Height-field texels along X. */
  waveResolution: number
  /** Vertices along X for the displaced surface. */
  surfaceSegments: number
  reflection: boolean
}

export const QUALITY_PRESETS: Record<string, AppQuality> = {
  low: { waveResolution: 256, surfaceSegments: 128, reflection: false },
  medium: { waveResolution: 384, surfaceSegments: 192, reflection: true },
  high: { waveResolution: 512, surfaceSegments: 256, reflection: true },
}

/**
 * Wires the simulation, the physics and the renderer into one running app.
 *
 * The frame is a fixed-step accumulator: physics and entities advance at
 * PHYSICS_DT, the wave fields take WAVE_SUBSTEPS smaller steps inside each of
 * those, and rendering happens once per animation frame at whatever rate the
 * display gives us. Nothing in the simulation ever sees a variable time step,
 * because the wave equation is unforgiving about that.
 */
export class App {
  readonly renderer: WebGLRenderer
  readonly camera: PerspectiveCamera
  readonly scene = new Scene()
  readonly environment: Environment
  readonly waves: WaveField
  readonly water: WaveFieldCPU
  readonly flow = new FlowField()
  readonly splats = new SplatQueue()
  readonly physics: PhysicsWorld
  readonly surface: WaterSurface
  readonly spray = new SprayParticles({ capacity: 4200 })
  readonly caustics: CausticsProjector
  readonly pool: Pool
  readonly input: Input
  readonly follow: FollowCamera

  readonly player: Swimmer
  readonly swimmers: Swimmer[] = []
  readonly floats: FloatingObject[] = []
  private readonly ai: SwimmerAI[] = []

  /** Wall time the simulation has covered, in seconds. */
  elapsed = 0
  /** Physics steps run in the last frame; the GUI shows it. */
  lastStepCount = 0
  paused = false

  private accumulator = 0
  private lastFrameTime = 0
  private readonly pixelRatio: number
  private readonly detachResize: () => void
  private readonly raycaster = new Raycaster()
  private readonly pointer = new Vector2()
  private readonly scratch = new Vector3()
  /** When set, the camera orbits this point instead of trailing the player. */
  focusOverride: Vector3 | null = null
  private readonly moveAxis = { x: 0, y: 0 }
  private readonly dragState = { yaw: 0, pitch: 0, zoom: 0 }
  private submerged = false

  constructor(quality: AppQuality = QUALITY_PRESETS.high!) {
    const bundle = createRenderer()
    this.renderer = bundle.renderer
    this.camera = bundle.camera
    this.pixelRatio = bundle.pixelRatio

    this.scene.background = ABOVE_WATER_CLEAR
    this.environment = new Environment(this.scene, this.renderer)

    this.waves = new WaveField({ resolution: quality.waveResolution })
    this.water = new WaveFieldCPU({
      width: POOL.width,
      depth: POOL.depth,
      // A quarter of the GPU field's linear resolution: enough to carry every
      // wave a floating body can feel, cheap enough to run on the main thread.
      cols: 128,
      rows: 80,
      speedScale: this.waves.speedScale,
      damping: this.waves.damping,
      levelDecay: this.waves.levelDecay,
    })

    this.caustics = new CausticsProjector(this.waves.normalTexture, quality.waveResolution)
    this.caustics.sunDirection.copy(this.environment.sunDirection)

    this.pool = new Pool(this.caustics)
    this.scene.add(this.pool.group)

    this.surface = new WaterSurface(this.waves, this.environment.uniforms, {
      segments: quality.surfaceSegments,
    })
    this.surface.reflectionEnabled = quality.reflection
    this.scene.add(this.surface.mesh)
    this.scene.add(this.spray.points)

    this.physics = new PhysicsWorld(this.water, this.flow, this.splats)
    this.physics.splash = this.spray

    this.buildCurrent()

    this.player = this.addSwimmer(0, -3.5, 1.5, true)
    for (let i = 0; i < 4; i++) {
      const swimmer = this.addSwimmer(
        i + 1,
        (Math.random() * 2 - 1) * (POOL_HALF_W - 2),
        (Math.random() * 2 - 1) * (POOL_HALF_D - 2),
        false,
      )
      this.ai.push(new SwimmerAI(swimmer, this.swimmers))
    }

    this.spawnFloats()

    this.input = new Input(this.renderer.domElement)
    this.follow = new FollowCamera(this.camera)
    this.follow.target.copy(this.player.body.position)

    this.detachResize = attachResize(this.renderer, this.camera, (width, height) => {
      this.surface.setSize(width, height, this.pixelRatio)
      this.spray.setProjection(height * this.pixelRatio, this.camera.fov)
    })

    this.environment.updateEnvironment()
    this.waves.reset(this.renderer)
  }

  /** Wall inlets and the two slow eddies they set up in the corners. */
  private buildCurrent(): void {
    this.flow.addJet({
      x: -POOL_HALF_W + 0.15,
      z: -2.6,
      dirX: 1,
      dirZ: 0.22,
      strength: 0.72,
      radius: 4.5,
    })
    this.flow.addJet({
      x: POOL_HALF_W - 0.15,
      z: 2.6,
      dirX: -1,
      dirZ: -0.22,
      strength: 0.72,
      radius: 4.5,
    })
    this.flow.addVortex({ x: -3.4, z: 2.2, strength: 0.34, coreRadius: 1.9 })
    this.flow.addVortex({ x: 3.4, z: -2.2, strength: -0.34, coreRadius: 1.9 })
    this.waves.markFlowDirty()
  }

  private addSwimmer(palette: number, x: number, z: number, isPlayer: boolean): Swimmer {
    const swimmer = new Swimmer(palette)
    swimmer.placeAt(x, z, WATER_LEVEL - 0.04)
    swimmer.faceDirection(isPlayer ? 0 : Math.random() * 2 - 1, isPlayer ? 1 : Math.random() * 2 - 1)
    this.scene.add(swimmer.object)
    this.physics.add(swimmer)
    this.swimmers.push(swimmer)
    return swimmer
  }

  private spawnFloats(): void {
    const add = (object: FloatingObject, x: number, z: number) => {
      object.placeAt(x, z, WATER_LEVEL + 0.08)
      this.scene.add(object.object)
      this.physics.add(object)
      this.floats.push(object)
      return object
    }

    add(new SwimRing(0), -5.4, -2.2)
    add(new SwimRing(1), -4.1, 1.9)
    add(new SwimRing(2), 5.9, 3.1)
    add(new RubberDuck(), 2.4, -3.2)
    add(new RubberDuck(), -1.6, 3.4)
    add(new AirMattress('#4fd1c5'), 4.6, -0.6)
    add(new AirMattress('#f7b267'), -6.4, 3.4)
    add(new BeachBall(), 1.2, 1.1)
    add(new BeachBall(), 6.6, -3.4)
  }

  /** Add another floating object at a random spot, for the GUI's spawn buttons. */
  spawn(kind: 'ring' | 'duck' | 'mattress' | 'ball'): void {
    const x = (Math.random() * 2 - 1) * (POOL_HALF_W - 1.5)
    const z = (Math.random() * 2 - 1) * (POOL_HALF_D - 1.5)
    const object =
      kind === 'ring'
        ? new SwimRing(Math.floor(Math.random() * 4))
        : kind === 'duck'
          ? new RubberDuck()
          : kind === 'mattress'
            ? new AirMattress()
            : new BeachBall()

    object.placeAt(x, z, WATER_LEVEL + 1.6)
    this.scene.add(object.object)
    this.physics.add(object)
    this.floats.push(object)
  }

  /** Remove every float that was not part of the initial set-up. */
  clearFloats(): void {
    for (const object of this.floats.splice(9)) {
      this.scene.remove(object.object)
      this.physics.remove(object)
    }
  }

  /**
   * Park the camera at a fixed vantage point. Used by the smoke test so its
   * screenshots frame the same shot every run, and handy for looking around.
   */
  setCamera(yaw: number, pitch: number, distance: number, focus?: Vector3): void {
    this.follow.yaw = yaw
    this.follow.pitch = pitch
    this.follow.distance = distance
    this.focusOverride = focus ? focus.clone() : new Vector3(0, -0.3, 0)
  }

  /** Hand the camera back to the player. */
  followPlayer(): void {
    this.focusOverride = null
  }

  /** Flatten the water and clear the spray. */
  calmWater(): void {
    this.water.reset()
    this.waves.reset(this.renderer)
    this.spray.clear()
  }

  private handleInput(dt: number): void {
    this.input.consumeDrag(this.dragState)
    this.follow.orbit(this.dragState.yaw, this.dragState.pitch, this.dragState.zoom)

    this.input.moveAxis(this.moveAxis)
    const magnitude = Math.hypot(this.moveAxis.x, this.moveAxis.y)
    if (magnitude > 0) {
      // Steer relative to the camera, which is how anyone expects WASD to work.
      const camForwardX = Math.sin(this.follow.yaw + Math.PI)
      const camForwardZ = Math.cos(this.follow.yaw + Math.PI)
      const dirX = camForwardX * this.moveAxis.y + camForwardZ * this.moveAxis.x
      const dirZ = camForwardZ * this.moveAxis.y - camForwardX * this.moveAxis.x
      this.player.desiredHeading = Math.atan2(dirX, dirZ)
      this.player.throttle = Math.min(1, magnitude)
    } else {
      this.player.throttle = 0.05
    }

    this.player.sprint = this.input.isDown('ShiftLeft', 'ShiftRight') ? 1 : 0
    this.player.pitchInput = this.input.isDown('Space') ? -1 : 0

    const click = this.input.consumeClick()
    if (click) this.splashAt(click.x, click.y)

    void dt
  }

  /** Turn a click into a real disturbance: a dent in the surface plus spray. */
  private splashAt(ndcX: number, ndcY: number): void {
    this.pointer.set(ndcX, ndcY)
    this.raycaster.setFromCamera(this.pointer, this.camera)
    const hit = WaterSurface.intersectSurface(
      this.raycaster.ray.origin,
      this.raycaster.ray.direction,
      this.scratch,
    )
    if (!hit) return

    this.splats.add(this.scratch.x, this.scratch.z, 0.3, -0.055, 0.8)
    this.spray.emit(this.scratch, UP, 60, 3.2, 0.9)
  }

  /** One fixed simulation step. */
  private stepSimulation(dt: number): void {
    this.splats.clear()

    this.handleInput(dt)
    for (const ai of this.ai) {
      ai.update(dt, {
        water: this.water,
        flow: this.flow,
        splats: this.splats,
        splash: this.spray,
        elapsed: this.elapsed,
      })
    }

    this.physics.step(dt)
    this.spray.update(dt, this.water, this.flow, this.splats)

    // Both fields consume the identical splat list, then advance in lockstep.
    this.water.applySplats(this.splats)
    for (let i = 0; i < WAVE_SUBSTEPS; i++) {
      this.water.step(WAVE_DT)
      this.waves.step(this.renderer, i === 0 ? this.splats : null, this.flow, WAVE_DT)
    }

    this.elapsed += dt
  }

  /** Advance and draw. Call once per animation frame. */
  frame(now: number): void {
    if (this.lastFrameTime === 0) this.lastFrameTime = now
    const frameDelta = Math.min((now - this.lastFrameTime) / 1000, 0.25)
    this.lastFrameTime = now

    if (!this.paused) {
      this.accumulator += frameDelta
      let steps = 0
      while (this.accumulator >= PHYSICS_DT && steps < MAX_STEPS_PER_FRAME) {
        this.stepSimulation(PHYSICS_DT)
        this.accumulator -= PHYSICS_DT
        steps++
      }
      // If we hit the cap the machine cannot keep up; drop the backlog rather
      // than spiralling further behind.
      if (steps >= MAX_STEPS_PER_FRAME) this.accumulator = 0
      this.lastStepCount = steps
    }

    this.follow.update(frameDelta, this.focusOverride ?? this.player.body.position)
    this.environment.follow(this.camera.position)
    this.environment.updateEnvironment()
    this.caustics.sunDirection.copy(this.environment.sunDirection)
    this.caustics.syncAttached()

    this.updateUnderwater()

    // Shadow maps refresh once per frame, not once per scene pass.
    this.renderer.shadowMap.needsUpdate = true

    this.waves.refreshNormals(this.renderer)
    this.caustics.render(this.renderer)
    this.surface.renderFrame(this.renderer, this.scene, this.camera, this.elapsed, [
      this.spray.points,
    ])
  }

  /** Swap to a murky, close-fogged look whenever the lens goes under. */
  private updateUnderwater(): void {
    const surfaceHeight = this.water.heightAt(this.camera.position.x, this.camera.position.z)
    const submerged = this.camera.position.y < WATER_LEVEL + surfaceHeight
    if (submerged === this.submerged) return
    this.submerged = submerged

    if (submerged) {
      this.scene.fog = new FogExp2(UNDERWATER_FOG.getHex(), 0.13)
      this.scene.background = UNDERWATER_FOG
    } else {
      this.scene.fog = null
      this.scene.background = ABOVE_WATER_CLEAR
    }
  }

  /** Push simulation tuning from the GUI into both wave fields at once. */
  syncWaveSettings(): void {
    this.water.speedScale = this.waves.speedScale
    this.water.damping = this.waves.damping
    this.water.levelDecay = this.waves.levelDecay
  }

  dispose(): void {
    this.detachResize()
    this.input.dispose()
    this.surface.dispose()
    this.spray.dispose()
    this.caustics.dispose()
    this.waves.dispose()
    this.pool.dispose()
    this.environment.dispose()
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }
}

const UP = new Vector3(0, 1, 0)
