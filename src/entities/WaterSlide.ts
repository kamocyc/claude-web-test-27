import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CatmullRomCurve3,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshStandardMaterial,
  Vector3,
} from 'three'
import { POOL, SLIDE, WATER_LEVEL } from '../core/config'
import { isWet } from '../core/world'
import { resolveOneSided } from '../physics/Collide'
import type { PhysicsContext, WorldFeature } from '../physics/PhysicsWorld'
import type { RigidBody } from '../physics/RigidBody'
import type { Swimmer } from './Swimmer'

/**
 * The flume's centreline: a constant-radius descending bend, then a straight
 * run-out over the water.
 *
 * It is generated rather than hand-placed because the radius is the number that
 * matters. A prone swimmer is 1.7 m of rigid body inside a 1.2 m pipe, so a
 * tight bend would wedge them across it: the sagitta of a body-length chord is
 * L^2/8R, which over this bend is 0.11 m and disappears into the flume's width,
 * but at the 1.3 m an eyeballed set of control points happened to produce, it
 * is 0.28 m and a swimmer jams solid. Hand-tuned points hide that number; this
 * puts it on the page.
 */
const FLUME = {
  /** Centre of the bend, in XZ. */
  centreX: 1.2,
  centreZ: 6.6,
  /** Radius of the bend. */
  radius: 3.2,
  /** Start and end angles, degrees. The sweep descends from the platform. */
  fromAngle: 45,
  toAngle: -90,
  /** Straight run-out past the end of the bend. */
  runOut: 2,
  topY: 4.3,
  outletY: 0.95,
  /**
   * How the drop is spread along the flume. Above one it is steepest at the
   * top and flattens towards the outlet, which is how a slide is built: the
   * height buys speed early and the run-out just carries it out over the water.
   */
  dropCurve: 1.15,
} as const

/** Sampled centreline of the flume, in order from the platform to the outlet. */
function buildCentreline(count: number): Vector3[] {
  const from = (FLUME.fromAngle * Math.PI) / 180
  const to = (FLUME.toAngle * Math.PI) / 180
  const arc = Math.abs(to - from) * FLUME.radius
  const total = arc + FLUME.runOut
  const points: Vector3[] = []

  for (let i = 0; i <= count; i++) {
    const travelled = (i / count) * total
    let x: number
    let z: number
    if (travelled <= arc) {
      const angle = from + (to - from) * (travelled / arc)
      x = FLUME.centreX + Math.cos(angle) * FLUME.radius
      z = FLUME.centreZ + Math.sin(angle) * FLUME.radius
    } else {
      // Straight on along the tangent the bend ended with.
      const way = Math.sign(to - from)
      const run = travelled - arc
      x = FLUME.centreX + Math.cos(to) * FLUME.radius - Math.sin(to) * run * way
      z = FLUME.centreZ + Math.sin(to) * FLUME.radius + Math.cos(to) * run * way
    }
    const t = travelled / total
    const y = FLUME.outletY + (FLUME.topY - FLUME.outletY) * (1 - t) ** FLUME.dropCurve
    points.push(new Vector3(x, y, z))
  }
  return points
}

/** How many pieces the centreline is chopped into for contact and for drawing. */
const SEGMENTS = 120
/** Cross-section vertices, over the closed part of the tube. */
const RING = 18
/** Horizontal run of the flight of steps up to the platform. */
const STAIR_RUN = 4

const _up = new Vector3(0, 1, 0)
const _radial = new Vector3()
const _contact = new Vector3()
const _normal = new Vector3()
const _force = new Vector3()
const _toward = new Vector3()
const _scratch = new Vector3()

interface Hit {
  /** Distance from the centreline. */
  distance: number
  /** Index of the sample whose frame applies. */
  index: number
}

type RiderStage = 'climbing' | 'riding' | 'plunging'

interface Rider {
  stage: RiderStage
  /** Distance walked up the stairs, metres. */
  walked: number
  /** Seconds spent in the current stage, for the stuck-rider guard. */
  age: number
}

/**
 * A water slide that is ridden, not animated.
 *
 * Everything from the top of the steps down is ordinary rigid-body physics:
 * gravity is already applied to every dynamic body, the flume is a one-sided
 * contact against the inside of a pipe, and friction is the same tangential
 * impulse that a swim ring feels against the pool wall. Nobody is moved along a
 * rail, so the ride comes out of the shape — riders pick up speed on the steep
 * section, ride up the outside of a bend, and if they carry too much speed
 * through one they go over the side, because the pipe is only closed for 300
 * degrees and there is nothing above them.
 *
 * The one part that is not physics is the walk up the steps, which is animated:
 * a body with no legs cannot climb stairs, and pretending otherwise would be a
 * much bigger lie than moving them along a line at walking pace.
 */
export class WaterSlide implements WorldFeature {
  readonly object = new Group()
  readonly curve: CatmullRomCurve3
  /** Total riders that have made it down, for the smoke test and the GUI. */
  completed = 0

  private readonly points: Vector3[] = []
  private readonly tangents: Vector3[] = []
  private readonly ups: Vector3[] = []
  private readonly rights: Vector3[] = []
  /** Last matched sample per body, so the search does not start from scratch. */
  private readonly lastIndex = new WeakMap<RigidBody, number>()
  /** Centre and radius of a sphere containing the whole flume. */
  private readonly boundsCentre = new Vector3()
  private readonly boundsRadius: number

  private readonly stairs: Vector3[]
  private readonly stairsLength: number

  /** Most riders on the steps and in the flume at once. */
  maxRiders = 2

  private readonly watched: Swimmer[] = []
  private readonly eager = new Set<Swimmer>()
  private readonly riders = new Map<Swimmer, Rider>()
  private readonly cooldown = new Map<Swimmer, number>()
  private outflowPhase = 0

  constructor() {
    this.curve = new CatmullRomCurve3(buildCentreline(24), false, 'centripetal', 0.5)

    for (let i = 0; i <= SEGMENTS; i++) {
      const u = i / SEGMENTS
      this.points.push(this.curve.getPointAt(u))
      const tangent = this.curve.getTangentAt(u).normalize()
      this.tangents.push(tangent)
      // A frame built from world up rather than the Frenet normal: the open
      // side of the flume has to face the sky the whole way down, and the
      // Frenet normal flips through an inflection.
      const up = _scratch.copy(_up).addScaledVector(tangent, -_up.dot(tangent)).normalize().clone()
      this.ups.push(up)
      this.rights.push(new Vector3().crossVectors(tangent, up).normalize())
    }

    let radius = 0
    for (const point of this.points) this.boundsCentre.add(point)
    this.boundsCentre.divideScalar(this.points.length)
    for (const point of this.points) radius = Math.max(radius, this.boundsCentre.distanceTo(point))
    this.boundsRadius = radius + SLIDE.flumeRadius + 1.2

    this.stairs = this.buildClimbPath()
    let walk = 0
    for (let i = 1; i < this.stairs.length; i++) walk += this.stairs[i]!.distanceTo(this.stairs[i - 1]!)
    this.stairsLength = walk

    this.object.add(this.buildFlume())
    this.object.add(this.buildTower())
    this.object.name = 'water-slide'
  }

  /** Position of the flume's outlet, where the water pours out. */
  get outlet(): Vector3 {
    return this.points[SEGMENTS]!
  }

  /**
   * Let a swimmer use the slide. `eager` marks someone who came to the steps on
   * purpose — the player — and always boards; everyone else takes it now and
   * then, or the pool empties out onto the stairs.
   */
  watch(swimmer: Swimmer, eager = false): void {
    this.watched.push(swimmer)
    if (eager) this.eager.add(swimmer)
  }

  /** True while this swimmer is on the steps or in the flume. */
  isRiding(swimmer: Swimmer): boolean {
    const rider = this.riders.get(swimmer)
    return rider !== undefined && rider.stage !== 'plunging'
  }

  get ridersOnSlide(): number {
    let count = 0
    for (const rider of this.riders.values()) if (rider.stage !== 'plunging') count++
    return count
  }

  /** Put a swimmer on the steps now, whatever they were doing. */
  send(swimmer: Swimmer): void {
    if (this.riders.has(swimmer)) return
    this.riders.set(swimmer, { stage: 'climbing', walked: 0, age: 0 })
    // The slide owns the pose from here until they are back in the water: the
    // steps and the flume are both places where what the ground says and what
    // the rider is doing disagree.
    swimmer.poseLocked = true
    swimmer.pose = 'stand'
    swimmer.throttle = 0
    swimmer.body.dynamic = false
    swimmer.body.velocity.setScalar(0)
    swimmer.body.angularVelocity.setScalar(0)
  }

  // --- Physics --------------------------------------------------------------

  /**
   * Water pumped down the flume. It only ever pushes a body that is going
   * slower than the water, so it keeps anyone from stalling on the flat run-out
   * without capping the speed the gradient gives them.
   */
  applyForces(body: RigidBody, _dt: number, _context: PhysicsContext): void {
    if (!body.dynamic) return
    if (body.position.distanceToSquared(this.boundsCentre) > this.boundsRadius ** 2) return
    const hit = this.nearest(body.position, body)
    if (hit === null || hit.distance > SLIDE.flumeRadius) return

    const tangent = this.tangents[hit.index]!
    const along = body.velocity.dot(tangent)
    if (along >= SLIDE.flumeFlow) return
    _force.copy(tangent).multiplyScalar((SLIDE.flumeFlow - along) * body.mass * 1.4)
    body.addForce(_force)
  }

  /** One-sided contact against the inside of the pipe. */
  collide(body: RigidBody): void {
    if (!body.dynamic) return
    if (body.position.distanceToSquared(this.boundsCentre) > this.boundsRadius ** 2) return

    for (let i = 0; i < body.spheres.length; i++) {
      const centre = body.worldSpheres[i]!
      const radius = body.spheres[i]!.radius
      const hit = this.nearest(centre, body)
      if (hit === null) continue
      if (hit.distance + radius - SLIDE.flumeRadius <= 0) continue

      // Which way round the section the body is sitting. Past the open angle
      // there is no wall, so this is where a rider carrying too much speed
      // through a bend leaves the slide.
      const up = this.ups[hit.index]!
      const right = this.rights[hit.index]!
      _radial.copy(centre).sub(this.points[hit.index]!)
      _radial.addScaledVector(this.tangents[hit.index]!, -_radial.dot(this.tangents[hit.index]!))
      const length = _radial.length()
      if (length < 1e-6) continue
      _radial.divideScalar(length)
      // Measured in the frame the normal comes from, so the two agree.
      const penetration = length + radius - SLIDE.flumeRadius
      if (penetration <= 0) continue
      const angle = Math.atan2(_radial.dot(right), -_radial.dot(up))
      if (Math.abs(angle) > SLIDE.openHalfAngle) continue

      _normal.copy(_radial).multiplyScalar(-1)
      _contact.copy(centre).addScaledVector(_normal, -radius)
      // Wet plastic: barely any friction, which is the whole point of a slide.
      resolveOneSided(body, _contact, _normal, penetration, 0.1, 0.06, i)
    }
  }

  update(dt: number, context: PhysicsContext): void {
    for (const [swimmer, remaining] of this.cooldown) {
      if (remaining <= dt) this.cooldown.delete(swimmer)
      else this.cooldown.set(swimmer, remaining - dt)
    }

    for (const swimmer of this.watched) {
      if (this.riders.has(swimmer) || this.cooldown.has(swimmer)) continue
      if (this.ridersOnSlide >= this.maxRiders) continue
      const dx = swimmer.body.position.x - SLIDE.boardingX
      const dz = swimmer.body.position.z - SLIDE.boardingZ
      if (dx * dx + dz * dz >= SLIDE.boardingRadius * SLIDE.boardingRadius) continue

      if (this.eager.has(swimmer) || Math.random() < 0.35) {
        this.send(swimmer)
      } else {
        // Not this time. The cooldown is what makes that a decision rather than
        // a dice roll a hundred and twenty times a second, which would board
        // everyone who drifted past within a frame or two.
        this.cooldown.set(swimmer, 20)
      }
    }

    for (const [swimmer, rider] of this.riders) {
      rider.age += dt
      if (rider.stage === 'climbing') this.stepClimb(swimmer, rider, dt)
      else if (rider.stage === 'riding') this.stepRide(swimmer, rider, context)
      else this.stepPlunge(swimmer, rider, context)
    }

    this.pourOutlet(dt, context)
  }

  private stepClimb(swimmer: Swimmer, rider: Rider, dt: number): void {
    rider.walked += 1.6 * dt
    const body = swimmer.body
    if (rider.walked >= this.stairsLength) {
      // Into the mouth of the flume, upright and facing down it, then let go.
      body.position.copy(this.points[0]!).addScaledVector(this.ups[0]!, 0.1)
      body.velocity.copy(this.tangents[0]!).multiplyScalar(1.2)
      body.angularVelocity.setScalar(0)
      body.dynamic = true
      body.syncDerived()
      swimmer.pose = 'ride'
      rider.stage = 'riding'
      rider.age = 0
      return
    }

    this.samplePath(this.stairs, rider.walked, body.position, _toward)
    swimmer.faceDirection(_toward.x, _toward.z)
    body.velocity.setScalar(0)
    body.syncDerived()
  }

  private stepRide(swimmer: Swimmer, rider: Rider, context: PhysicsContext): void {
    const body = swimmer.body
    const surface = WATER_LEVEL + context.water.heightAt(body.position.x, body.position.z)
    // Done when they are in the water, or when they have left the slide's
    // neighbourhood entirely (over the side and onto the deck).
    const clear = body.position.distanceToSquared(this.boundsCentre) > this.boundsRadius ** 2
    if (body.position.y < surface + 0.35 || clear || rider.age > 30) {
      rider.stage = 'plunging'
      rider.age = 0
      swimmer.pose = 'swim'
    }
  }

  private stepPlunge(swimmer: Swimmer, rider: Rider, context: PhysicsContext): void {
    const body = swimmer.body
    const surface = WATER_LEVEL + context.water.heightAt(body.position.x, body.position.z)
    const landed = body.position.y <= surface + 0.1
    // The guard is for a rider who went over the side and is sitting on the
    // deck: they are no longer the slide's business, but they never touch the
    // water either.
    if (!landed && rider.age < 4) return

    const inPool = isWet(body.position.x, body.position.z)
    if (landed && inPool) {
      // The plume of a body arriving at six metres a second: a broad ring of
      // whitewater on top of the dent the entry itself makes.
      const speed = Math.abs(body.velocity.y) + 0.5
      context.splats.addImpulse(body.position.x, body.position.z, 0.55, Math.min(speed * 0.02, 0.09), 1)
      if (context.splash) {
        _scratch.set(body.position.x, surface, body.position.z)
        _normal.set(0, 1, 0)
        context.splash.emit(_scratch, _normal, 70, Math.min(speed * 0.8, 5), 1.15)
      }
      this.completed++
    }

    this.riders.delete(swimmer)
    this.cooldown.set(swimmer, 12)
    swimmer.poseLocked = false
    swimmer.pose = 'swim'
  }

  /** The flume's own water, running out of the outlet the whole time. */
  private pourOutlet(dt: number, context: PhysicsContext): void {
    this.outflowPhase += dt
    if (this.outflowPhase < 0.05) return
    this.outflowPhase = 0

    const outlet = this.outlet
    const tangent = this.tangents[SEGMENTS]!
    const landingX = outlet.x + tangent.x * 0.6
    const landingZ = outlet.z + tangent.z * 0.6
    context.splats.addImpulse(landingX, landingZ, 0.24, 0.006, 0.25)
    if (context.splash) {
      _scratch.copy(outlet)
      _toward.copy(tangent).multiplyScalar(0.6)
      _toward.y -= 0.5
      context.splash.emit(_scratch, _toward, 3, 1.6, 0.35)
    }
  }

  // --- Geometry -------------------------------------------------------------

  /**
   * Nearest point on the centreline, or null when the body is past either end.
   *
   * Past the ends there is deliberately no contact: the mouth has to let a
   * rider in and the outlet has to let them out, and a cap that reached round
   * the end would grab anyone floating underneath it.
   */
  private nearest(point: Vector3, body?: RigidBody): Hit | null {
    let bestDistance = Number.POSITIVE_INFINITY
    let bestIndex = 0
    let bestT = 0

    // A body moves about a segment and a half per step even at full tilt, so a
    // window around where it was last time finds the same answer as a full
    // sweep for a fraction of the work. Only when the best is at the edge of
    // the window — a body that jumped, or one being looked at for the first
    // time — does it fall back to sweeping the lot.
    const seed = body === undefined ? undefined : this.lastIndex.get(body)
    const window = 10
    let from = 0
    let to = SEGMENTS
    if (seed !== undefined) {
      from = Math.max(0, seed - window)
      to = Math.min(SEGMENTS, seed + window)
    }

    for (let pass = 0; pass < 2; pass++) {
      bestDistance = Number.POSITIVE_INFINITY
      for (let i = from; i < to; i++) {
        const a = this.points[i]!
        const b = this.points[i + 1]!
        _scratch.copy(b).sub(a)
        const lengthSq = _scratch.lengthSq()
        if (lengthSq < 1e-12) continue
        const t = Math.max(0, Math.min(1, _toward.copy(point).sub(a).dot(_scratch) / lengthSq))
        const distance = _toward.addScaledVector(_scratch, -t).length()
        if (distance < bestDistance) {
          bestDistance = distance
          bestIndex = i
          bestT = t
        }
      }

      const edged = bestIndex <= from && from > 0
      const edgedFar = bestIndex >= to - 1 && to < SEGMENTS
      if (!edged && !edgedFar) break
      from = 0
      to = SEGMENTS
    }
    if (body !== undefined) this.lastIndex.set(body, bestIndex)

    if (bestIndex === 0 && bestT <= 0) {
      _scratch.copy(point).sub(this.points[0]!)
      if (_scratch.dot(this.tangents[0]!) < 0) return null
    }
    if (bestIndex === SEGMENTS - 1 && bestT >= 1) {
      _scratch.copy(point).sub(this.points[SEGMENTS]!)
      if (_scratch.dot(this.tangents[SEGMENTS]!) > 0) return null
    }

    return { distance: bestDistance, index: bestT > 0.5 ? bestIndex + 1 : bestIndex }
  }

  /** Open-topped trough swept along the centreline. */
  private buildFlume(): Mesh {
    const radius = SLIDE.flumeRadius
    const thickness = 0.05
    const positions: number[] = []
    const normals: number[] = []
    const uvs: number[] = []
    const indices: number[] = []

    for (let i = 0; i <= SEGMENTS; i++) {
      const centre = this.points[i]!
      const up = this.ups[i]!
      const right = this.rights[i]!
      for (let j = 0; j <= RING; j++) {
        const angle = -SLIDE.openHalfAngle + ((2 * SLIDE.openHalfAngle) / RING) * j
        const nx = -up.x * Math.cos(angle) + right.x * Math.sin(angle)
        const ny = -up.y * Math.cos(angle) + right.y * Math.sin(angle)
        const nz = -up.z * Math.cos(angle) + right.z * Math.sin(angle)
        positions.push(
          centre.x + nx * (radius + thickness),
          centre.y + ny * (radius + thickness),
          centre.z + nz * (radius + thickness),
        )
        // Normals point inwards: the surface anyone looks at is the inside.
        normals.push(-nx, -ny, -nz)
        uvs.push(i / SEGMENTS, j / RING)
      }
    }

    for (let i = 0; i < SEGMENTS; i++) {
      for (let j = 0; j < RING; j++) {
        const a = i * (RING + 1) + j
        const b = a + RING + 1
        indices.push(a, b, a + 1, a + 1, b, b + 1)
      }
    }

    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
    geometry.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3))
    geometry.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2))
    geometry.setIndex(indices)

    const material = new MeshStandardMaterial({
      color: '#3fa9e0',
      roughness: 0.28,
      metalness: 0.05,
      side: DoubleSide,
      envMapIntensity: 0.6,
    })
    const mesh = new Mesh(geometry, material)
    mesh.castShadow = true
    mesh.receiveShadow = true
    mesh.name = 'flume'
    return mesh
  }

  /** Legs, platform and steps under the top of the flume. */
  private buildTower(): Group {
    const group = new Group()
    const deck = WATER_LEVEL + POOL.copingHeight
    const mouth = this.points[0]!
    const top = mouth.y
    const steel = new MeshStandardMaterial({ color: '#d8dee2', roughness: 0.35, metalness: 0.7 })
    const platform = new MeshStandardMaterial({ color: '#e2e6e8', roughness: 0.7 })

    for (const [dx, dz] of [
      [-0.6, -0.55],
      [0.6, -0.55],
      [-0.6, 0.55],
      [0.6, 0.55],
    ] as [number, number][]) {
      const leg = new Mesh(new CylinderGeometry(0.06, 0.06, top - deck, 8), steel)
      leg.position.set(mouth.x + dx, (top + deck) / 2, mouth.z + dz)
      leg.castShadow = true
      group.add(leg)
    }

    const slab = new Mesh(new BoxGeometry(1.7, 0.12, 1.5), platform)
    slab.position.set(mouth.x, top - 0.22, mouth.z + 0.15)
    slab.castShadow = true
    slab.receiveShadow = true
    group.add(slab)

    const rail = new Mesh(new BoxGeometry(1.7, 0.06, 0.06), steel)
    rail.position.set(mouth.x, top + 0.75, mouth.z + 0.85)
    group.add(rail)

    // Steps, climbing in -X to the platform.
    const steps = 16
    for (let i = 0; i < steps; i++) {
      const step = new Mesh(new BoxGeometry(0.26, 0.05, 0.9), platform)
      step.position.set(
        mouth.x + STAIR_RUN - (i * STAIR_RUN) / steps,
        deck + ((i + 1) * (top - 0.28 - deck)) / steps,
        mouth.z,
      )
      step.castShadow = true
      step.receiveShadow = true
      group.add(step)
    }

    // A handrail alongside them, or the flight reads as a stack of slabs.
    for (const side of [-0.5, 0.5]) {
      const bar = new Mesh(new BoxGeometry(STAIR_RUN * 1.05, 0.05, 0.05), steel)
      bar.position.set(mouth.x + STAIR_RUN / 2, (deck + top) / 2 + 0.55, mouth.z + side)
      bar.rotation.z = Math.atan2(top - 0.28 - deck, STAIR_RUN)
      group.add(bar)
    }

    return group
  }

  /**
   * Waypoints from the water, out of the pool and up the steps.
   *
   * This is the one animated part of the ride. Everything below the platform is
   * physics; a walk is not something a bag of spheres can do, and faking it
   * with forces would look far worse than moving them along this line.
   */
  private buildClimbPath(): Vector3[] {
    const deck = WATER_LEVEL + POOL.copingHeight
    const mouth = this.points[0]!
    const stand = deck + 0.92
    return [
      new Vector3(SLIDE.boardingX, WATER_LEVEL - 0.15, SLIDE.boardingZ),
      new Vector3(SLIDE.boardingX, stand, POOL.depth / 2 + 0.6),
      new Vector3(SLIDE.boardingX, stand, mouth.z - 1.2),
      new Vector3(mouth.x + STAIR_RUN, stand, mouth.z),
      new Vector3(mouth.x + 0.4, mouth.y + 0.75, mouth.z),
      new Vector3(mouth.x, mouth.y + 0.45, mouth.z),
    ]
  }

  /** Position and heading at a distance along a polyline. */
  private samplePath(path: Vector3[], distance: number, outPoint: Vector3, outDirection: Vector3): void {
    let remaining = distance
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1]!
      const b = path[i]!
      const length = a.distanceTo(b)
      if (remaining <= length || i === path.length - 1) {
        const t = length > 1e-6 ? Math.min(1, remaining / length) : 1
        outPoint.copy(a).lerp(b, t)
        outDirection.copy(b).sub(a).normalize()
        return
      }
      remaining -= length
    }
  }

  dispose(): void {
    this.object.traverse((node) => {
      const mesh = node as Mesh
      if (mesh.isMesh) {
        mesh.geometry.dispose()
        const material = mesh.material
        if (Array.isArray(material)) for (const m of material) m.dispose()
        else material.dispose()
      }
    })
  }
}
