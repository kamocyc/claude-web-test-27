import { PerspectiveCamera, Vector3 } from 'three'
import { WATER_LEVEL, clamp } from '../core/config'
import { GROUNDS, floorYAt } from '../core/world'

const _desired = new Vector3()
const _offset = new Vector3()

/**
 * Third-person orbit camera that trails the player.
 *
 * Position and target are both smoothed towards their goals rather than snapped,
 * so the swimmer's surge and bob shows in the framing without shaking the shot.
 */
export class FollowCamera {
  yaw = 2.5
  pitch = 0.32
  distance = 5.4
  readonly target = new Vector3(0, -0.1, 0)

  private readonly smoothedTarget = new Vector3(0, -0.1, 0)
  private readonly smoothedPosition = new Vector3(-11, 5.4, 12)

  constructor(readonly camera: PerspectiveCamera) {}

  orbit(yawDelta: number, pitchDelta: number, zoomDelta: number): void {
    this.yaw += yawDelta
    this.pitch = clamp(this.pitch + pitchDelta, -0.45, 1.32)
    this.distance = clamp(this.distance + zoomDelta, 1.8, 26)
  }

  update(dt: number, focus: Vector3): void {
    this.target.copy(focus)

    // Exponential smoothing, framed so the rate is independent of frame time.
    const blend = 1 - Math.exp(-dt * 6)
    this.smoothedTarget.lerp(this.target, blend)

    const cosPitch = Math.cos(this.pitch)
    _offset.set(
      Math.sin(this.yaw) * cosPitch,
      Math.sin(this.pitch),
      Math.cos(this.yaw) * cosPitch,
    )
    _desired.copy(this.smoothedTarget).addScaledVector(_offset, this.distance)

    // Do not let the camera drop through the floor or wander off the grounds.
    _desired.x = clamp(_desired.x, GROUNDS.minX + 0.4, GROUNDS.maxX - 0.4)
    _desired.z = clamp(_desired.z, GROUNDS.minZ + 0.4, GROUNDS.maxZ - 0.4)
    _desired.y = Math.max(_desired.y, floorYAt(_desired.x, _desired.z) + 0.35)

    this.smoothedPosition.lerp(_desired, 1 - Math.exp(-dt * 7))
    this.camera.position.copy(this.smoothedPosition)
    this.camera.lookAt(this.smoothedTarget)
  }

  /** True when the lens is under the water line. */
  isSubmerged(surfaceHeight: number): boolean {
    return this.camera.position.y < WATER_LEVEL + surfaceHeight
  }
}
