import { Vector3 } from 'three'
import { ISLAND } from '../core/config'
import { ALL_RAMPS, BASINS, RIVER_POOL, basinAt, type Basin, type Ramp } from '../core/world'
import { stadiumDistance, type Vec2 } from '../core/shapes'
import type { PhysicsContext } from '../physics/PhysicsWorld'
import type { FloatingObject } from './FloatingObject'
import type { Swimmer } from './Swimmer'

const WALL_MARGIN = 1.4
const ARRIVAL_RADIUS = 1.1
/** How far clear of the island wall a target is allowed to be picked. */
const ISLAND_MARGIN = 0.9

const _toTarget = new Vector3()
const _steer = new Vector3()
const _separation = new Vector3()
const _outward: Vec2 = { x: 0, z: 0 }
const _flow: Vec2 = { x: 0, z: 0 }

/**
 * Steering for the swimmers nobody is driving.
 *
 * The AI only ever sets a heading and a throttle — it never moves anyone
 * directly. Everything else (getting shoved by a wave, drifting on the current,
 * bumping into a ring) still comes from the physics, so an AI swimmer and the
 * player behave identically once you stop pressing keys.
 *
 * There are two moods: crossing the pool towards a point, and going round with
 * the lazy river. The second one is not a path — it steers along whatever the
 * flow field says underneath them — so a swimmer riding the circuit and a
 * beach ball drifting on it follow the same water.
 */
export class SwimmerAI {
  private readonly target = new Vector3()
  private restTimer = 0
  private repathTimer = 0
  /** Seconds left of going round with the current instead of crossing. */
  private ridingTimer = 0
  /**
   * The pool this swimmer belongs to. Fixed at birth: an AI that wandered
   * between the two would have to climb out and walk, which is a thing the
   * player does deliberately, not something to do by accident while picking a
   * random point to swim to.
   */
  basin: Basin
  /** Set while this swimmer is on their way to the other pool. */
  private crossing: { to: Basin; walking: boolean; age: number } | null = null

  constructor(
    readonly swimmer: Swimmer,
    private readonly peers: Swimmer[],
    private readonly floats: FloatingObject[] = [],
  ) {
    this.basin =
      basinAt(swimmer.body.position.x, swimmer.body.position.z) ?? RIVER_POOL
    this.pickTarget()
  }

  /** The nearest float in this swimmer's own pool that nobody is on. */
  private nearestFreeFloat(): FloatingObject | null {
    const position = this.swimmer.body.position
    let best: FloatingObject | null = null
    let bestDistance = Number.POSITIVE_INFINITY
    for (const float of this.floats) {
      if (float.ride === null) continue
      const at = float.body.position
      if (basinAt(at.x, at.z) !== this.basin) continue
      const distance = Math.hypot(at.x - position.x, at.z - position.z)
      if (distance < bestDistance) {
        bestDistance = distance
        best = float
      }
    }
    return best
  }

  /** The ramp that leads out of a basin, and a point a little way up it. */
  private static rampOf(basin: Basin): Ramp {
    return ALL_RAMPS.find((ramp) => ramp.basin === basin) ?? ALL_RAMPS[0]!
  }

  /**
   * Head for the other pool.
   *
   * There is no route to follow and no waypoint list: aim at your own pool's
   * ramp until you are on your feet, then aim at the other pool's ramp until
   * you are back in the water. The two ramps face each other across the
   * walkway, so "walk towards it" is the whole path. If it somehow takes more
   * than a minute, give up and go back to swimming — the deck is no place to
   * be stuck.
   */
  private stepCrossing(dt: number, position: Vector3): boolean {
    const crossing = this.crossing
    if (crossing === null) return false
    crossing.age += dt

    const here = basinAt(position.x, position.z)
    if (this.swimmer.pose === 'swim' && here === crossing.to) {
      this.basin = crossing.to
      this.crossing = null
      this.pickTarget()
      return false
    }
    if (crossing.age > 60) {
      this.crossing = null
      this.pickTarget()
      return false
    }

    if (this.swimmer.pose === 'stand') crossing.walking = true
    const ramp = SwimmerAI.rampOf(crossing.walking ? crossing.to : this.basin)
    // Aim past the crest, into the water on the far side, so nobody stops on
    // the crest itself with one foot in each world.
    this.target.set(ramp.centreX, 0, ramp.wallZ + ramp.into * (crossing.walking ? 1.6 : -0.4))
    return true
  }

  private pickTarget(): void {
    const basin = this.basin

    // Now and then, go and get on something. Arriving is all this does — the
    // rider takes over from there, and only if they are still drifting slowly
    // when they get there.
    if (this.crossing === null && Math.random() < 0.25) {
      const float = this.nearestFreeFloat()
      if (float !== null) {
        this.target.copy(float.body.position)
        this.target.y = 0
        this.repathTimer = 14
        this.ridingTimer = 0
        return
      }
    }

    // Now and then, go and see the other pool.
    if (this.crossing === null && BASINS.length > 1 && Math.random() < 0.06) {
      const other = BASINS.find((candidate) => candidate !== basin)
      if (other) {
        this.crossing = { to: other, walking: false, age: 0 }
        this.repathTimer = 90
        this.ridingTimer = 0
        return
      }
    }
    // Retry rather than project: projecting every rejected point onto the
    // island's outline would cluster targets against its wall.
    for (let attempt = 0; attempt < 12; attempt++) {
      this.target.set(
        basin.minX + WALL_MARGIN + Math.random() * (basin.maxX - basin.minX - 2 * WALL_MARGIN),
        0,
        basin.minZ + WALL_MARGIN + Math.random() * (basin.maxZ - basin.minZ - 2 * WALL_MARGIN),
      )
      if (basin !== RIVER_POOL) break
      const distance = stadiumDistance(ISLAND, this.target.x, this.target.z, _outward)
      if (distance > ISLAND.radius + ISLAND_MARGIN) break
    }
    this.repathTimer = 8 + Math.random() * 10

    // Every so often, stop going anywhere in particular and just go round.
    if (basin === RIVER_POOL && Math.random() < 0.4) this.ridingTimer = 20 + Math.random() * 25
  }

  update(dt: number, context: PhysicsContext): void {
    const swimmer = this.swimmer
    const position = swimmer.body.position

    this.repathTimer -= dt
    const crossing = this.stepCrossing(dt, position)
    _toTarget.set(this.target.x - position.x, 0, this.target.z - position.z)
    const distance = _toTarget.length()

    if (crossing) {
      // Straight at the ramp, no wall repulsion and no island detour: the whole
      // point is to leave the water.
      if (distance > 1e-3) {
        swimmer.desiredHeading = Math.atan2(_toTarget.x, _toTarget.z)
        swimmer.throttle = 1
        swimmer.pitchInput = 0
      }
      return
    }

    if (distance < ARRIVAL_RADIUS || this.repathTimer <= 0) {
      // Pause at the wall now and then, the way people actually swim lengths.
      if (this.restTimer <= 0 && Math.random() < 0.45) {
        this.restTimer = 1.5 + Math.random() * 3.5
      }
      this.pickTarget()
      _toTarget.set(this.target.x - position.x, 0, this.target.z - position.z)
    }

    if (this.restTimer > 0) {
      this.restTimer -= dt
      swimmer.throttle = 0.06
      swimmer.pitchInput = 0
      return
    }

    // Riding the circuit: follow the water rather than a destination. Falls
    // back to the target whenever the local current is too weak to read, so a
    // swimmer who drifts out of the channel finds their way back.
    this.ridingTimer -= dt
    let riding = false
    if (this.ridingTimer > 0) {
      context.flow.velocityAt(position.x, position.z, _flow)
      if (Math.hypot(_flow.x, _flow.z) > 0.12) {
        _steer.set(_flow.x, 0, _flow.z).normalize()
        riding = true
      }
    }
    if (!riding) _steer.copy(_toTarget).normalize()

    // Keep off the island, the same way as off the walls.
    if (this.basin === RIVER_POOL) {
      const islandDistance = stadiumDistance(ISLAND, position.x, position.z, _outward)
      const intrusion = ISLAND.radius + ISLAND_MARGIN - islandDistance
      if (intrusion > 0) {
        _steer.x += _outward.x * intrusion * 2.2
        _steer.z += _outward.z * intrusion * 2.2
      }
    }

    // Push away from the walls before reaching them, so nobody swims into tile.
    _steer.x += softWall(position.x, this.basin.minX, this.basin.maxX) * 1.8
    _steer.z += softWall(position.z, this.basin.minZ, this.basin.maxZ) * 1.8

    // Keep clear of the other swimmers.
    _separation.setScalar(0)
    for (const peer of this.peers) {
      if (peer === swimmer) continue
      const dx = position.x - peer.body.position.x
      const dz = position.z - peer.body.position.z
      const gap = Math.hypot(dx, dz)
      if (gap > 1e-3 && gap < 1.6) {
        const weight = (1.6 - gap) / 1.6
        _separation.x += (dx / gap) * weight
        _separation.z += (dz / gap) * weight
      }
    }
    _steer.x += _separation.x * 1.4
    _steer.z += _separation.z * 1.4

    if (_steer.lengthSq() < 1e-6) return
    _steer.normalize()

    swimmer.desiredHeading = Math.atan2(_steer.x, _steer.z)
    // Ease off when close, so they glide in rather than ramming the wall.
    swimmer.throttle = riding ? 0.4 : Math.min(1, 0.45 + Math.min(distance / 4, 1) * 0.5)
    swimmer.pitchInput = 0
  }
}

/** Repulsion that is zero in open water and grows steeply near a wall. */
function softWall(coordinate: number, lo: number, hi: number): number {
  const toPositive = hi - WALL_MARGIN - coordinate
  const toNegative = coordinate - (lo + WALL_MARGIN)
  if (toPositive < 0) return toPositive
  if (toNegative < 0) return -toNegative
  return 0
}
