import {
  Color,
  FogExp2,
  PerspectiveCamera,
  Quaternion,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
  type WebGLRenderer,
} from 'three'
import {
  ISLAND,
  ISLAND_TOP,
  MAX_STEPS_PER_FRAME,
  PHYSICS_DT,
  POOL,
  RIVER,
  RIVER_BANK,
  WATER_LEVEL,
  WAVE_DT,
  WAVE_SUBSTEPS,
} from './core/config'
import { clampToRing, type Vec2 } from './core/shapes'
import {
  ALL_RAMPS,
  CALM_POOL,
  DOMAIN,
  RIVER_POOL,
  clampToBasin,
  wetDepthAt,
  type Basin,
} from './core/world'
import { Environment } from './core/Environment'
import { FollowCamera } from './core/FollowCamera'
import { Input } from './core/Input'
import { attachResize, createRenderer } from './core/Renderer'
import { FloatRider } from './entities/FloatRider'
import { Fountain } from './entities/Fountain'
import { AirMattress, BeachBall } from './entities/PoolFloat'
import { Pool } from './entities/Pool'
import { RubberDuck } from './entities/RubberDuck'
import { SwimRing } from './entities/SwimRing'
import { Swimmer } from './entities/Swimmer'
import { SwimmerAI } from './entities/SwimmerAI'
import { WaterSlide } from './entities/WaterSlide'
import type { FloatingObject } from './entities/FloatingObject'
import { PhysicsWorld } from './physics/PhysicsWorld'
import { RampObstacle } from './physics/BoxObstacle'
import { StadiumBank, StadiumObstacle } from './physics/StadiumObstacle'
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
  readonly spray = new SprayParticles({ capacity: 5600 })
  readonly caustics: CausticsProjector
  readonly pool: Pool
  readonly slide: WaterSlide
  readonly rider: FloatRider
  readonly fountains: Fountain[] = []
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
  private spaceHeld = false
  /** The float the pointer has hold of, and where on it. */
  private grabbed: FloatingObject | null = null
  private readonly grabLocal = new Vector3()

  constructor(quality: AppQuality = QUALITY_PRESETS.high!) {
    const bundle = createRenderer()
    this.renderer = bundle.renderer
    this.camera = bundle.camera
    this.pixelRatio = bundle.pixelRatio

    this.scene.background = ABOVE_WATER_CLEAR
    this.environment = new Environment(this.scene, this.renderer)

    this.waves = new WaveField(this.renderer, { resolution: quality.waveResolution })
    this.water = new WaveFieldCPU({
      width: DOMAIN.width,
      depth: DOMAIN.depth,
      centerX: DOMAIN.centerX,
      centerZ: DOMAIN.centerZ,
      // A quarter of the GPU field's linear resolution: enough to carry every
      // wave a floating body can feel, cheap enough to run on the main thread.
      cols: 128,
      rows: Math.round((128 * DOMAIN.depth) / DOMAIN.width),
      depthAt: wetDepthAt,
      speedScale: this.waves.speedScale,
      damping: this.waves.damping,
      levelDecay: this.waves.levelDecay,
    })

    this.caustics = new CausticsProjector(
      this.waves.normalTexture,
      this.waves.bathymetry,
      quality.waveResolution,
    )
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
    this.physics.addFeature(new StadiumObstacle(ISLAND, ISLAND_TOP))
    this.physics.addFeature(new StadiumBank(RIVER_BANK, WATER_LEVEL + POOL.copingHeight))
    for (const ramp of ALL_RAMPS) this.physics.addFeature(new RampObstacle(ramp))

    this.slide = this.physics.addFeature(new WaterSlide())
    this.scene.add(this.slide.object)
    this.rider = this.physics.addFeature(new FloatRider())
    this.buildFountains()

    this.player = this.addSwimmer(0, 0, -3.6, true)
    for (let i = 0; i < 5; i++) {
      // Three on the circuit, two in the ordinary pool.
      const basin = i < 3 ? RIVER_POOL : CALM_POOL
      const spot = inWater(
        basin,
        randomIn(basin.minX + 2, basin.maxX - 2),
        randomIn(basin.minZ + 2, basin.maxZ - 2),
      )
      const swimmer = this.addSwimmer(i + 1, spot.x, spot.z, false)
      this.ai.push(new SwimmerAI(swimmer, this.swimmers, this.floats))
    }
    // The player boards whenever they steer into the circle; the AI only some
    // of the time, so there is still a pool full of people.
    for (const swimmer of this.swimmers) {
      this.slide.watch(swimmer, swimmer === this.player)
      this.rider.watch(swimmer, swimmer === this.player)
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

  /**
   * The lazy river, and the wall inlets that drive it.
   *
   * The pair of counter-rotating eddies this used to have are gone: they sat
   * either side of the island and turned against the circuit, so whichever was
   * stronger won and nothing went round.
   */
  private buildCurrent(): void {
    this.buildCalmCurrent()
    this.flow.addChannel({
      x: ISLAND.x,
      z: ISLAND.z,
      halfLength: ISLAND.halfLength,
      radius: ISLAND.radius,
      innerRadius: RIVER.innerRadius,
      outerRadius: RIVER.outerRadius,
      strength: RIVER.speed,
    })

    // Inlets in the long walls, each aimed the way the circuit already runs on
    // its own side of the island: +X below the axis, -X above it.
    this.flow.addJet({
      x: RIVER_POOL.minX + 0.15,
      z: -3.4,
      dirX: 1,
      dirZ: 0,
      strength: 0.4,
      radius: 4,
    })
    this.flow.addJet({
      x: RIVER_POOL.maxX - 0.15,
      z: 3.4,
      dirX: -1,
      dirZ: 0,
      strength: 0.4,
      radius: 4,
    })
    this.waves.markFlowDirty()
  }

  /**
   * The ordinary pool's water: two wall inlets and a pair of counter-rotating
   * eddies between them.
   *
   * This is the arrangement the pool had before the circuit was cut into it.
   * It works here for the same reason it stopped working there — the two
   * eddies turn against each other, so nothing ever goes all the way round and
   * the water just mills about. In a pool you are only swimming in, that is
   * what you want.
   */
  private buildCalmCurrent(): void {
    const midZ = (CALM_POOL.minZ + CALM_POOL.maxZ) / 2
    this.flow.addJet({
      x: CALM_POOL.minX + 0.15,
      z: midZ - 2.6,
      dirX: 1,
      dirZ: 0.22,
      strength: 0.72,
      radius: 4.5,
    })
    this.flow.addJet({
      x: CALM_POOL.maxX - 0.15,
      z: midZ + 2.6,
      dirX: -1,
      dirZ: -0.22,
      strength: 0.72,
      radius: 4.5,
    })
    this.flow.addVortex({ x: -3.4, z: midZ + 2.2, strength: 0.34, coreRadius: 1.9 })
    this.flow.addVortex({ x: 3.4, z: midZ - 2.2, strength: -0.34, coreRadius: 1.9 })
  }

  /**
   * Three jets standing in the channel, spread round it so the current always
   * has one to carry the ripples away from.
   */
  private buildFountains(): void {
    const places: [number, number, number][] = [
      [-5.2, 0, 0],
      [5.2, 0, 2.6],
      [0, -3.2, 5.1],
    ]
    for (const [x, z, phase] of places) {
      const fountain = this.physics.addFeature(new Fountain({ x, z, phase }))
      this.scene.add(fountain.object)
      this.fountains.push(fountain)
    }
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
      const spot = inWater(basinFor(x, z), x, z, 0.6)
      object.placeAt(spot.x, spot.z, WATER_LEVEL + 0.08)
      this.scene.add(object.object)
      this.physics.add(object)
      this.rider.add(object)
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
    add(new BeachBall(), 1.2, 2.7)
    add(new BeachBall(), 6.6, -3.4)

    const calmZ = (CALM_POOL.minZ + CALM_POOL.maxZ) / 2
    add(new SwimRing(3), -3.2, calmZ + 2.4)
    add(new SwimRing(1), 4.4, calmZ - 1.6)
    add(new AirMattress('#b58cf0'), 0.4, calmZ + 3.2)
    add(new RubberDuck(), -5.6, calmZ - 3)
    add(new BeachBall(), 2.6, calmZ + 0.4)
  }

  /** Add another floating object at a random spot, for the GUI's spawn buttons. */
  spawn(kind: 'ring' | 'duck' | 'mattress' | 'ball'): void {
    // Into whichever pool the player is nearest, so the button drops it where
    // they are looking.
    const basin = basinFor(this.player.body.position.x, this.player.body.position.z)
    const { x, z } = inWater(
      basin,
      randomIn(basin.minX + 1.5, basin.maxX - 1.5),
      randomIn(basin.minZ + 1.5, basin.maxZ - 1.5),
    )
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
    this.rider.add(object)
    this.floats.push(object)
  }

  /**
   * Send someone down the slide now. Picks whoever is not already on it,
   * preferring an AI so the camera does not get yanked away from the player.
   */
  sendDownTheSlide(): void {
    const candidate =
      this.swimmers.find((swimmer) => swimmer !== this.player && !this.slide.isRiding(swimmer)) ??
      this.swimmers.find((swimmer) => !this.slide.isRiding(swimmer))
    if (candidate) this.slide.send(candidate)
  }

  /**
   * Put the player on whatever float is nearest, wherever it is. For the GUI
   * and for screenshots; ordinarily you get on one by swimming into it.
   */
  ridePlayerOnNearestFloat(): boolean {
    let best: FloatingObject | null = null
    let bestDistance = Number.POSITIVE_INFINITY
    for (const float of this.floats) {
      if (float.ride === null || this.rider.isRidden(float)) continue
      const distance = float.body.position.distanceTo(this.player.body.position)
      if (distance < bestDistance) {
        bestDistance = distance
        best = float
      }
    }
    if (best === null) return false
    // Drop them onto it rather than teleporting the float to them.
    this.player.body.position.set(
      best.body.position.x,
      best.body.position.y + best.ride!.seatHeight,
      best.body.position.z,
    )
    this.player.body.velocity.setScalar(0)
    this.player.body.syncDerived()
    return this.rider.mount(this.player, best)
  }

  /** Remove every float that was not part of the initial set-up. */
  clearFloats(): void {
    for (const object of this.floats.splice(14)) {
      this.scene.remove(object.object)
      this.physics.remove(object)
      this.rider.remove(object)
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
    // Space dives in the water and jumps on land, which is the same key doing
    // the same thing: push against whatever you are in.
    const space = this.input.isDown('Space')
    const riding = this.rider.isRiding(this.player)
    this.player.pitchInput = space && !riding && this.player.pose !== 'stand' ? -1 : 0
    if (space && !this.spaceHeld) {
      if (riding) this.player.dismountRequested = true
      else if (this.player.pose === 'stand') this.player.jumpRequested = true
    }
    this.spaceHeld = space

    this.updateGrab()

    const click = this.input.consumeClick()
    if (click) this.splashAt(click.x, click.y)

    void dt
  }

  /**
   * Picking a float up and hauling it about.
   *
   * A spring between where you grabbed it and where the pointer is now, capped
   * at sixty newtons — enough to drag a swim ring across the pool, not enough
   * to pull it out of the water or through a wall. Everything else follows: it
   * turns as you drag it because the spring pulls at the point you took hold
   * of, it makes a wake because it is moving through the water, and letting go
   * throws it because it keeps the speed it had.
   */
  private updateGrab(): void {
    const press = this.input.consumePress()
    if (press !== null) {
      const float = this.floatUnder(press.x, press.y)
      if (float !== null) {
        this.grabbed = float
        this.grabLocal
          .copy(this.scratch)
          .sub(float.body.position)
          .applyQuaternion(_inverse.copy(float.body.quaternion).invert())
        this.input.suppressDrag = true
        this.rider.setBusy(float, true)
      }
    }

    if (this.grabbed === null) return
    if (!this.input.pointerDown) {
      this.rider.setBusy(this.grabbed, false)
      this.grabbed = null
      return
    }

    const body = this.grabbed.body
    _hold.copy(this.grabLocal).applyQuaternion(body.quaternion).add(body.position)

    this.pointer.set(this.input.pointerNdc.x, this.input.pointerNdc.y)
    this.raycaster.setFromCamera(this.pointer, this.camera)
    const direction = this.raycaster.ray.direction
    if (Math.abs(direction.y) < 1e-4) return
    // Aim at the horizontal plane the grabbed point is already on, so dragging
    // moves it about the pool rather than lifting it into the air.
    const t = (_hold.y - this.raycaster.ray.origin.y) / direction.y
    if (t < 0) return
    _target.copy(direction).multiplyScalar(t).add(this.raycaster.ray.origin)

    _pull.copy(_target).sub(_hold).multiplyScalar(90 * body.mass)
    body.pointVelocity(_hold, _handVelocity)
    _pull.addScaledVector(_handVelocity, -18 * body.mass)
    _pull.y = 0
    if (_pull.length() > GRAB_FORCE) _pull.setLength(GRAB_FORCE)
    body.addForceAtPoint(_pull, _hold)
  }

  /** The float whose mesh is under this screen point, if any. */
  private floatUnder(ndcX: number, ndcY: number): FloatingObject | null {
    this.pointer.set(ndcX, ndcY)
    this.raycaster.setFromCamera(this.pointer, this.camera)
    for (const float of this.floats) {
      const hits = this.raycaster.intersectObject(float.object, true)
      if (hits.length > 0 && hits[0]) {
        this.scratch.copy(hits[0].point)
        return float
      }
    }
    return null
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

    this.splats.addImpulse(this.scratch.x, this.scratch.z, 0.3, 0.055, 0.8)
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
    this.slide.dispose()
    for (const fountain of this.fountains) fountain.dispose()
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

/** Hardest you can pull a float about with the pointer, newtons. */
const GRAB_FORCE = 60

const _hold = new Vector3()
const _target = new Vector3()
const _pull = new Vector3()
const _handVelocity = new Vector3()
const _inverse = new Quaternion()

/**
 * Put a spawn point somewhere there is actually water: in the river that means
 * the channel between the island and the bank, in the ordinary pool it just
 * means clear of the walls.
 */
function inWater(basin: Basin, x: number, z: number, margin = 0.8): Vec2 {
  if (basin === RIVER_POOL) {
    return clampToRing(RIVER_BANK, x, z, ISLAND.radius + margin, RIVER.outerRadius - margin, _spawn)
  }
  return clampToBasin(basin, x, z, margin + 0.4, _spawn)
}

/** Whichever basin a point is in or nearest to. */
function basinFor(x: number, z: number): Basin {
  const toCalm = Math.abs(z - (CALM_POOL.minZ + CALM_POOL.maxZ) / 2)
  const toRiver = Math.abs(z - (RIVER_POOL.minZ + RIVER_POOL.maxZ) / 2)
  void x
  return toCalm < toRiver ? CALM_POOL : RIVER_POOL
}

function randomIn(lo: number, hi: number): number {
  return lo + Math.random() * (hi - lo)
}

const _spawn: Vec2 = { x: 0, z: 0 }
