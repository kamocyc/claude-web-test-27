import { Vector3 } from 'three'
import { POOL_HALF_D, POOL_HALF_W } from '../core/config'
import type { PhysicsContext } from '../physics/PhysicsWorld'
import type { Swimmer } from './Swimmer'

const WALL_MARGIN = 1.4
const ARRIVAL_RADIUS = 1.1

const _toTarget = new Vector3()
const _steer = new Vector3()
const _separation = new Vector3()

/**
 * Steering for the swimmers nobody is driving.
 *
 * The AI only ever sets a heading and a throttle — it never moves anyone
 * directly. Everything else (getting shoved by a wave, drifting on the current,
 * bumping into a ring) still comes from the physics, so an AI swimmer and the
 * player behave identically once you stop pressing keys.
 */
export class SwimmerAI {
  private readonly target = new Vector3()
  private restTimer = 0
  private repathTimer = 0

  constructor(
    readonly swimmer: Swimmer,
    private readonly peers: Swimmer[],
  ) {
    this.pickTarget()
  }

  private pickTarget(): void {
    this.target.set(
      (Math.random() * 2 - 1) * (POOL_HALF_W - WALL_MARGIN),
      0,
      (Math.random() * 2 - 1) * (POOL_HALF_D - WALL_MARGIN),
    )
    this.repathTimer = 8 + Math.random() * 10
  }

  update(dt: number, _context: PhysicsContext): void {
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

    _steer.copy(_toTarget).normalize()

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
    swimmer.throttle = Math.min(1, 0.45 + Math.min(distance / 4, 1) * 0.5)
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
