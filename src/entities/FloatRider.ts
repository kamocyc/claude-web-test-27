import { Vector3 } from 'three'
import { GRAVITY, WATER_LEVEL } from '../core/config'
import type { PhysicsContext, WorldFeature } from '../physics/PhysicsWorld'
import type { RigidBody } from './../physics/RigidBody'
import type { FloatingObject } from './FloatingObject'
import type { Swimmer } from './Swimmer'

/** What it takes to ride a particular float. Set by the float itself. */
export interface RideSpec {
  /** How the rider holds themselves: sitting in a ring, lying on a mattress. */
  pose: 'sit' | 'ride'
  /** Height of the rider's centre of mass above the float's origin. */
  seatHeight: number
  /**
   * How close you have to be to climb on. Getting a third of it further out
   * again than that is the point at which you are no longer on it — a rider
   * whose ring is hauled out from under them is left where they were.
   */
  radius: number
}

interface Rider {
  float: FloatingObject
  spec: RideSpec
  /** Seconds left before an AI rider gets bored. */
  remaining: number
  age: number
  /** Which hand is in the water this stroke. */
  side: number
  phase: number
  /**
   * This step's forces, worked out in `update` and applied in `applyForces`.
   *
   * They have to be split that way round: the step clears every body's forces
   * after the features' `update` and before their `applyForces`, so anything
   * added in the first is gone by the time it would have been integrated.
   */
  readonly hold: Vector3
  readonly seat: Vector3
  readonly paddleForce: Vector3
  readonly paddleAt: Vector3
}

const _seat = new Vector3()
const _force = new Vector3()
const _hand = new Vector3()
const _lean = new Vector3()
const _right = new Vector3()
const _forward = new Vector3()

/**
 * Getting on a float, paddling it about, and being thrown off it.
 *
 * Nothing here is a constraint. A rider is held on by a spring between their
 * centre of mass and the seat, capped at a bit over a gravity's worth of force,
 * which means the ordinary business of the pool can still take them off it: a
 * wave, a fountain, somebody else's landing off the slide. That is deliberate,
 * and it is the same choice the slide made — a rail cannot be knocked off.
 *
 * The interesting half is what the float feels. The spring's reaction goes back
 * into the float as a force *and* as load on the deformation nodes nearest the
 * rider, which is what a person sitting on an inflatable actually does to it:
 * their weight goes into the tube under them, that tube squashes, and because
 * the squashed spheres are the ones buoyancy integrates, the ring settles low
 * on the side they are sitting. None of that is written down anywhere as a
 * rule; it is three existing mechanisms meeting.
 */
export class FloatRider implements WorldFeature {
  private readonly floats: FloatingObject[] = []
  private readonly watched = new Map<Swimmer, boolean>()
  private readonly riders = new Map<Swimmer, Rider>()
  private readonly cooldown = new Map<Swimmer, number>()
  /** Floats being dragged by the pointer, which nobody may climb onto. */
  private readonly busy = new Set<FloatingObject>()

  /** Anything with a `ride` spec can be climbed onto. */
  add(float: FloatingObject): void {
    if (float.ride !== null) this.floats.push(float)
  }

  remove(float: FloatingObject): void {
    const index = this.floats.indexOf(float)
    if (index >= 0) this.floats.splice(index, 1)
    for (const [swimmer, rider] of this.riders) {
      if (rider.float === float) this.dismount(swimmer)
    }
  }

  /** Watch a swimmer. `eager` riders climb on whenever they can — the player. */
  watch(swimmer: Swimmer, eager = false): void {
    this.watched.set(swimmer, eager)
  }

  isRiding(swimmer: Swimmer): boolean {
    return this.riders.has(swimmer)
  }

  /** The float a swimmer is on, if any. */
  mountOf(swimmer: Swimmer): FloatingObject | null {
    return this.riders.get(swimmer)?.float ?? null
  }

  get riderCount(): number {
    return this.riders.size
  }

  /** True while somebody is on this float. */
  isRidden(float: FloatingObject): boolean {
    for (const rider of this.riders.values()) if (rider.float === float) return true
    return false
  }

  /** Mark a float as being dragged, so nobody climbs onto it mid-throw. */
  setBusy(float: FloatingObject | null, busy: boolean): void {
    if (float === null) return
    if (busy) this.busy.add(float)
    else this.busy.delete(float)
  }

  /** Put a swimmer on a float now. Used by the GUI and by the tests. */
  mount(swimmer: Swimmer, float: FloatingObject): boolean {
    if (this.riders.has(swimmer) || float.ride === null || this.isRidden(float)) return false
    if (swimmer.poseLocked) return false
    this.riders.set(swimmer, {
      float,
      spec: float.ride,
      remaining: 20 + Math.random() * 25,
      age: 0,
      side: 0,
      phase: 0,
      hold: new Vector3(),
      seat: new Vector3(),
      paddleForce: new Vector3(),
      paddleAt: new Vector3(),
    })
    swimmer.poseLocked = true
    swimmer.pose = float.ride.pose
    return true
  }

  dismount(swimmer: Swimmer): void {
    if (!this.riders.delete(swimmer)) return
    swimmer.poseLocked = false
    swimmer.pose = 'swim'
    swimmer.dismountRequested = false
    this.cooldown.set(swimmer, 6)
  }

  update(dt: number, context: PhysicsContext): void {
    for (const [swimmer, left] of this.cooldown) {
      if (left <= dt) this.cooldown.delete(swimmer)
      else this.cooldown.set(swimmer, left - dt)
    }

    for (const [swimmer, eager] of this.watched) {
      if (this.riders.has(swimmer) || this.cooldown.has(swimmer) || swimmer.poseLocked) continue
      const float = this.nearestMountable(swimmer)
      if (float === null) continue
      // The player climbs on whenever they steer into one. An AI only
      // sometimes, or the pool empties into a raft of occupied rings.
      if (!eager && Math.random() > 0.02) continue
      this.mount(swimmer, float)
    }

    for (const [swimmer, rider] of this.riders) {
      rider.age += dt
      rider.remaining -= dt
      this.stepRide(swimmer, rider, dt, context)
    }
  }

  /** Apply this step's ride forces to whichever body is being asked about. */
  applyForces(body: RigidBody, _dt: number, _context: PhysicsContext): void {
    for (const [swimmer, rider] of this.riders) {
      if (body === swimmer.body) {
        body.addForce(rider.hold)
      } else if (body === rider.float.body) {
        _force.copy(rider.hold).negate()
        body.addForceAtPoint(_force, rider.seat)
        if (rider.paddleForce.lengthSq() > 0) {
          body.addForceAtPoint(rider.paddleForce, rider.paddleAt)
        }
      }
    }
  }

  /** The float this swimmer could climb onto right now, if any. */
  private nearestMountable(swimmer: Swimmer): FloatingObject | null {
    const body = swimmer.body
    let best: FloatingObject | null = null
    let bestDistance = Number.POSITIVE_INFINITY

    for (const float of this.floats) {
      const spec = float.ride!
      if (this.isRidden(float) || this.busy.has(float)) continue
      const other = float.body
      const dx = body.position.x - other.position.x
      const dz = body.position.z - other.position.z
      const distance = Math.hypot(dx, dz)
      if (distance > spec.radius) continue
      if (Math.abs(body.position.y - other.position.y) > 0.9) continue
      // Climbing on is something you do at a drift, not a collision.
      if (relativeSpeed(body, other) > 1.5) continue
      if (distance < bestDistance) {
        bestDistance = distance
        best = float
      }
    }
    return best
  }

  private stepRide(swimmer: Swimmer, rider: Rider, dt: number, context: PhysicsContext): void {
    const body = swimmer.body
    const float = rider.float.body
    const spec = rider.spec

    _seat.copy(float.position)
    _seat.y += spec.seatHeight

    const offset = Math.hypot(body.position.x - float.position.x, body.position.z - float.position.z)
    if (
      swimmer.dismountRequested ||
      rider.remaining <= 0 ||
      offset > spec.radius * 1.3 ||
      body.position.y - float.position.y > 1.4
    ) {
      this.dismount(swimmer)
      return
    }

    // Hold on. Capped at a shade over a gravity, so a fountain or a bad wave
    // still wins and the rider comes off.
    _force.copy(_seat).sub(body.position).multiplyScalar(26)
    _force.addScaledVector(body.velocity, -7)
    _force.addScaledVector(float.velocity, 7)
    // A seat pushes; it never pulls. Without that the link is rigid in both
    // directions and a swimmer — who is very nearly neutrally buoyant, and so
    // floats perfectly well on their own — drags the ring half a metre under
    // rather than sitting on it.
    //
    // One-sided, the loop closes on itself properly: the seat lifts the rider
    // until their chest is out of the water, the buoyancy they lose by being
    // lifted is exactly what they then weigh on the ring, and that is the load
    // the tube squashes under. Nobody had to decide how heavy a rider is.
    if (_force.y < 0) _force.y = 0
    if (_force.length() > GRAVITY * 1.35) _force.setLength(GRAVITY * 1.35)
    rider.hold.copy(_force).multiplyScalar(body.mass)
    rider.seat.copy(_seat)

    // The float carries the other half of that, which is the whole reason it
    // knows it has somebody on it.
    this.pressOn(rider.float, body.position, Math.max(0, rider.hold.y), dt)

    this.paddle(swimmer, rider, dt, context)
  }

  /**
   * Put a rider's weight into the float's deformation nodes.
   *
   * Weighted towards the ones nearest where the rider is sitting, so somebody
   * on the middle of a ring squashes it evenly and somebody leaning to one side
   * squashes that side. The sphere proxy has no thighs to make this contact by
   * itself — a body sitting in the hole of a ring is nowhere near the tube — so
   * the load is stated here rather than discovered, and it is the one place in
   * the ride that is.
   */
  private pressOn(float: FloatingObject, riderAt: Vector3, load: number, dt: number): void {
    if (float.shell === null || load <= 0) return
    const body = float.body
    _lean.set(riderAt.x - body.position.x, 0, riderAt.z - body.position.z)

    let total = 0
    for (let i = 0; i < body.spheres.length; i++) {
      const node = body.worldSpheres[i]!
      const dx = node.x - body.position.x
      const dz = node.z - body.position.z
      // Nodes on the rider's side of the float take more of them.
      total += 1 + Math.max(0, dx * _lean.x + dz * _lean.z) * 6
    }
    if (total <= 0) return

    for (let i = 0; i < body.spheres.length; i++) {
      const node = body.worldSpheres[i]!
      const dx = node.x - body.position.x
      const dz = node.z - body.position.z
      const share = (1 + Math.max(0, dx * _lean.x + dz * _lean.z) * 6) / total
      body.recordLoad(i, load * share * dt)
    }
  }

  /**
   * Paddling, one hand at a time.
   *
   * The force goes in at the hand, off to one side of the float, so a stroke on
   * the left turns you right — there is no separate steering term. Which side
   * gets used is chosen by where the rider wants to point: if they are already
   * heading the right way the sides alternate and it goes straight.
   */
  private paddle(swimmer: Swimmer, rider: Rider, dt: number, context: PhysicsContext): void {
    const float = rider.float.body
    rider.paddleForce.setScalar(0)
    const effort = Math.min(1, swimmer.throttle * (1 + swimmer.sprint * 0.5))
    if (effort < 0.12) return

    rider.phase += dt * (1.4 + effort * 2.2)
    if (rider.phase > Math.PI) {
      rider.phase -= Math.PI
      rider.side = 1 - rider.side
    }

    _forward.set(Math.sin(swimmer.desiredHeading), 0, Math.cos(swimmer.desiredHeading))
    _right.set(_forward.z, 0, -_forward.x)
    const heading = Math.atan2(float.velocity.x, float.velocity.z)
    const error = angleDelta(heading, swimmer.desiredHeading)
    // Turning is just choosing a side. Paddle on the right to go left.
    const side =
      Math.abs(error) > 0.35 || float.velocity.lengthSq() < 0.04
        ? (error > 0 ? -1 : 1)
        : rider.side * 2 - 1

    const reach = rider.spec.radius * 0.75
    _hand.copy(float.position).addScaledVector(_right, side * reach)
    _hand.y = WATER_LEVEL + context.water.heightAt(_hand.x, _hand.z)

    const pull = Math.sin(rider.phase)
    if (pull <= 0) return
    rider.paddleForce.copy(_forward).multiplyScalar(effort * pull * 190)
    rider.paddleAt.copy(_hand)

    // The hand is in the water, so the water hears about it.
    if (pull > 0.85 && rider.phase - dt * 3 <= 0.85) {
      context.splats.addImpulse(_hand.x, _hand.z, 0.19, 0.016 * effort, 0.4 * effort)
      if (context.splash) {
        _force.set(0, 1, 0).addScaledVector(_forward, -0.4).normalize()
        context.splash.emit(_hand, _force, 4 + Math.round(effort * 8), 1 + effort, 0.9)
      }
    }
  }
}

function relativeSpeed(a: RigidBody, b: RigidBody): number {
  return Math.hypot(a.velocity.x - b.velocity.x, a.velocity.z - b.velocity.z)
}

/** Signed shortest angle from `from` to `to`. */
function angleDelta(from: number, to: number): number {
  let delta = (to - from) % (Math.PI * 2)
  if (delta > Math.PI) delta -= Math.PI * 2
  if (delta < -Math.PI) delta += Math.PI * 2
  return delta
}
