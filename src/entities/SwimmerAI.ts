import { Vector3 } from 'three'
import { ISLAND, POOL_HALF_D, POOL_HALF_W } from '../core/config'
import { stadiumDistance, type Vec2 } from '../core/shapes'
import type { PhysicsContext } from '../physics/PhysicsWorld'
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

  constructor(
    readonly swimmer: Swimmer,
    private readonly peers: Swimmer[],
  ) {
    this.pickTarget()
  }

  private pickTarget(): void {
    // Retry rather than project: projecting every rejected point onto the
    // island's outline would cluster targets against its wall.
    for (let attempt = 0; attempt < 12; attempt++) {
      this.target.set(
        (Math.random() * 2 - 1) * (POOL_HALF_W - WALL_MARGIN),
        0,
        (Math.random() * 2 - 1) * (POOL_HALF_D - WALL_MARGIN),
      )
      const distance = stadiumDistance(ISLAND, this.target.x, this.target.z, _outward)
      if (distance > ISLAND.radius + ISLAND_MARGIN) break
    }
    this.repathTimer = 8 + Math.random() * 10

    // Every so often, stop going anywhere in particular and just go round.
    if (Math.random() < 0.4) this.ridingTimer = 20 + Math.random() * 25
  }

  update(dt: number, context: PhysicsContext): void {
    const swimmer = this.swimmer
    const position = swimmer.body.position

    this.repathTimer -= dt
    _toTarget.set(this.target.x - position.x, 0, this.target.z - position.z)
    const distance = _toTarget.length()

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
    const islandDistance = stadiumDistance(ISLAND, position.x, position.z, _outward)
    const intrusion = ISLAND.radius + ISLAND_MARGIN - islandDistance
    if (intrusion > 0) {
      _steer.x += _outward.x * intrusion * 2.2
      _steer.z += _outward.z * intrusion * 2.2
    }

    // Push away from the walls before reaching them, so nobody swims into tile.
    const wallPushX = softWall(position.x, POOL_HALF_W)
    const wallPushZ = softWall(position.z, POOL_HALF_D)
    _steer.x += wallPushX * 1.8
    _steer.z += wallPushZ * 1.8

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
function softWall(coordinate: number, half: number): number {
  const toPositive = half - WALL_MARGIN - coordinate
  const toNegative = coordinate - (WALL_MARGIN - half)
  if (toPositive < 0) return toPositive
  if (toNegative < 0) return -toNegative
  return 0
}
