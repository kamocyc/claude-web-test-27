import { ConeGeometry, CylinderGeometry, Group, Mesh, MeshStandardMaterial, Vector3 } from 'three'
import { GRAVITY, WATER_DENSITY, WATER_LEVEL } from '../core/config'
import { floorYAt } from '../core/world'
import type { Stadium } from '../core/shapes'
import { collideWithStadium } from '../physics/Collide'
import type { PhysicsContext, WorldFeature } from '../physics/PhysicsWorld'
import type { RigidBody } from '../physics/RigidBody'

export interface FountainOptions {
  x: number
  z: number
  /** Speed at the nozzle, m/s. */
  speed?: number
  /** Radius of the nozzle bore, m. */
  bore?: number
  /** Half-angle of the plume, radians. */
  spread?: number
  /** Droplets a second. */
  rate?: number
  /** Height of the nozzle above the still water line. */
  height?: number
  /** Seconds per breath of the slow rise and fall in pressure. */
  period?: number
  phase?: number
}

const _force = new Vector3()
const _point = new Vector3()
const _origin = new Vector3()
const _direction = new Vector3()

/**
 * A jet of water standing in the river, and the only thing here that pushes on
 * bodies without touching them.
 *
 * The force is the jet's momentum flux, which is what a jet actually is: the
 * nozzle throws `rho * A * v` kilograms a second at `v` metres a second, and
 * anything that gets in the way takes the share of that it blocks. A 24 mm
 * bore at 7 m/s is about two litres a second and twenty-two newtons — a
 * plausible decorative fountain, and the numbers do the rest: twenty-two
 * newtons under a two-kilo swim ring is most of a g and it goes flying, while
 * the same jet under a sixty-four kilo swimmer is a third of a metre per second
 * squared and they barely notice. Neither case is special-cased.
 *
 * The ripples are not written down anywhere either. The droplets it throws are
 * ordinary spray, and spray that lands already puts a volume-neutral impulse
 * into the height field, so the ring of waves round a fountain — and the way
 * the current carries it downstream — comes out of machinery that was there
 * before.
 */
export class Fountain implements WorldFeature {
  readonly object = new Group()
  enabled = true
  /** Nozzle speed, m/s. The GUI drives this. */
  speed: number

  readonly x: number
  readonly z: number
  readonly height: number
  private readonly bore: number
  private readonly spread: number
  private readonly rate: number
  private readonly period: number
  private readonly stem: Stadium
  private phase: number
  private pending = 0
  /**
   * Height of the lowest thing blocking the column, from the last step. One
   * step late, which nobody can see, and it saves walking the bodies twice.
   */
  private blockedAt = Number.POSITIVE_INFINITY
  private nextBlocked = Number.POSITIVE_INFINITY

  constructor(options: FountainOptions) {
    this.x = options.x
    this.z = options.z
    this.speed = options.speed ?? 7
    this.bore = options.bore ?? 0.011
    this.spread = options.spread ?? (7 * Math.PI) / 180
    this.rate = options.rate ?? 260
    this.height = options.height ?? WATER_LEVEL + 0.1
    this.period = options.period ?? 7
    this.phase = options.phase ?? 0
    this.stem = { x: this.x, z: this.z, halfLength: 0, radius: 0.06 }

    this.object.add(this.buildNozzle())
    this.object.name = 'fountain'
  }

  /** Mass a second leaving the nozzle. */
  get massFlow(): number {
    return WATER_DENSITY * Math.PI * this.bore * this.bore * this.speed
  }

  /** Speed of the column at a height above the nozzle, or 0 past the apex. */
  speedAt(above: number): number {
    const squared = this.speed * this.speed - 2 * GRAVITY * above
    return squared > 0 ? Math.sqrt(squared) : 0
  }

  /** Radius of the column at a height above the nozzle. */
  radiusAt(above: number): number {
    return this.bore + Math.tan(this.spread) * Math.max(above, 0)
  }

  /** How high the water gets, ignoring air drag. */
  get apex(): number {
    return (this.speed * this.speed) / (2 * GRAVITY)
  }

  // --- Physics --------------------------------------------------------------

  /**
   * The push of the column on whatever is standing in it, and a note of what
   * is in the way.
   *
   * Blocking is geometry, so it is recorded for a body the jet cannot move as
   * well: something held in the column still stops the water going past it.
   */
  applyForces(body: RigidBody, _dt: number, _context: PhysicsContext): void {
    if (!this.enabled) return

    const flow = this.massFlow
    for (let i = 0; i < body.spheres.length; i++) {
      const centre = body.worldSpheres[i]!
      const sphereRadius = body.spheres[i]!.radius
      const above = centre.y - sphereRadius - this.height
      if (above < -sphereRadius * 2 || above > this.apex) continue

      const jetRadius = this.radiusAt(Math.max(above, 0))
      const offset = Math.hypot(centre.x - this.x, centre.z - this.z)
      const overlap = jetRadius + sphereRadius - offset
      if (overlap <= 0) continue

      // Fraction of the column the body blocks. Full when the plume is
      // narrower than the sphere and centred on it, tapering to nothing as it
      // slides off the edge.
      const width = 2 * Math.min(jetRadius, sphereRadius)
      const fraction = Math.min(1, overlap / Math.max(width, 1e-6))
      const speed = this.speedAt(Math.max(above, 0))
      if (speed <= 0) continue

      // A plume that hits a curved body does not simply stop: it splits and
      // runs off to the side, and the reaction shoves the body off the column.
      // That instability is why nothing balances on a fountain for long, and
      // without it a ball sits dead centre taking the full thrust for the whole
      // height of the jet and leaves the scene vertically.
      const lateral = Math.min(1, offset / Math.max(sphereRadius, 1e-6))
      const thrust = fraction * flow * speed
      const outward = offset > 1e-6 ? lateral * 0.7 : 0
      _force.set(
        ((centre.x - this.x) / Math.max(offset, 1e-6)) * thrust * outward,
        thrust * (1 - 0.45 * lateral),
        ((centre.z - this.z) / Math.max(offset, 1e-6)) * thrust * outward,
      )
      // Applied where the water actually hits — the underside of the sphere,
      // over the nozzle — so a body sitting off-centre gets spun as well as
      // lifted.
      _point.set(
        this.x + (centre.x - this.x) * 0.2,
        centre.y - sphereRadius,
        this.z + (centre.z - this.z) * 0.2,
      )
      if (body.dynamic) body.addForceAtPoint(_force, _point)

      const blockedAt = centre.y - sphereRadius
      if (blockedAt < this.nextBlocked) this.nextBlocked = blockedAt
    }
  }

  /** Bodies bump into the standpipe rather than drifting through it. */
  collide(body: RigidBody): void {
    collideWithStadium(body, this.stem, this.height)
  }

  update(dt: number, context: PhysicsContext): void {
    this.blockedAt = this.nextBlocked
    this.nextBlocked = Number.POSITIVE_INFINITY
    if (!this.enabled || context.splash === null) return

    // Fountains breathe: the pump's pressure wanders, and a column of exactly
    // constant height reads as a cylinder of plastic.
    this.phase += dt
    const breath = 0.88 + 0.12 * Math.sin((this.phase * 2 * Math.PI) / this.period)

    this.pending += this.rate * dt
    const count = Math.floor(this.pending)
    this.pending -= count
    if (count <= 0) return

    const blocked = this.blockedAt - this.height
    const reachable =
      blocked < this.apex ? Math.sqrt(2 * GRAVITY * Math.max(blocked, 0.05)) : this.speed * breath

    _origin.set(this.x, this.height, this.z)
    _direction.set(0, 1, 0)
    context.splash.emit(_origin, _direction, count, reachable, this.spread * 2, {
      life: 2 * reachable / GRAVITY + 0.35,
      size: 0.026,
      speedJitter: 0.16,
    })

    // Water piling into whatever is blocking the column has to go somewhere.
    if (blocked < this.apex) {
      _origin.set(this.x, this.blockedAt, this.z)
      _direction.set(0, 0.25, 0)
      context.splash.emit(_origin, _direction, Math.max(1, count), reachable * 0.7, 1.5, {
        life: 0.8,
        size: 0.022,
      })
    }
  }

  // --- Geometry -------------------------------------------------------------

  private buildNozzle(): Group {
    const group = new Group()
    const metal = new MeshStandardMaterial({ color: '#c8d0d4', roughness: 0.3, metalness: 0.85 })

    const floor = floorYAt(this.x, this.z)
    const stem = new Mesh(
      new CylinderGeometry(this.stem.radius, this.stem.radius, this.height - floor, 10),
      metal,
    )
    stem.position.set(this.x, (this.height + floor) / 2, this.z)
    stem.castShadow = true
    group.add(stem)

    const head = new Mesh(new ConeGeometry(this.stem.radius * 1.3, 0.14, 10), metal)
    head.position.set(this.x, this.height + 0.04, this.z)
    head.castShadow = true
    group.add(head)

    return group
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
