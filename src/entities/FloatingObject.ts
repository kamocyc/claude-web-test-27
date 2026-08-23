import { Group, Object3D, Vector3 } from 'three'
import { WATER_LEVEL } from '../core/config'
import type { BuoyancyOptions } from '../physics/Buoyancy'
import type { PhysicsActor, PhysicsContext } from '../physics/PhysicsWorld'
import { RigidBody, type BodySphere } from '../physics/RigidBody'

export interface FloatingObjectOptions {
  mass: number
  spheres: BodySphere[]
  /** Buoyant volume. Defaults to the sum of the proxy spheres. */
  volume?: number
  restitution?: number
  dragCoefficient?: number
  linearDragRate?: number
  angularDamping?: number
  buoyancy?: BuoyancyOptions
  /** Impact speed, m/s, above which the object throws visible spray. */
  splashThreshold?: number
}

const _velocity = new Vector3()
const _up = new Vector3(0, 1, 0)

/**
 * A rigid body paired with something to look at.
 *
 * Subclasses supply the mesh and the sphere proxy; everything shared — driving
 * the transform from the physics, and throwing spray when the object hits the
 * water hard — lives here.
 */
export abstract class FloatingObject implements PhysicsActor {
  readonly body: RigidBody
  readonly object: Object3D
  buoyancy: BuoyancyOptions
  private readonly splashThreshold: number
  private wasAboveSurface = true

  protected constructor(options: FloatingObjectOptions, object: Object3D = new Group()) {
    this.body = new RigidBody({
      mass: options.mass,
      spheres: options.spheres,
      ...(options.volume !== undefined ? { volume: options.volume } : {}),
      ...(options.restitution !== undefined ? { restitution: options.restitution } : {}),
      ...(options.dragCoefficient !== undefined
        ? { dragCoefficient: options.dragCoefficient }
        : {}),
      ...(options.linearDragRate !== undefined
        ? { linearDragRate: options.linearDragRate }
        : {}),
      ...(options.angularDamping !== undefined
        ? { angularDamping: options.angularDamping }
        : {}),
    })
    this.buoyancy = options.buoyancy ?? {}
    this.splashThreshold = options.splashThreshold ?? 1.1
    this.object = object
  }

  /** Drop the object in at a position, already at rest. */
  placeAt(x: number, z: number, y = 0.06): this {
    this.body.position.set(x, y, z)
    this.body.velocity.setScalar(0)
    this.body.angularVelocity.setScalar(0)
    this.body.syncDerived()
    this.syncTransform()
    return this
  }

  protected syncTransform(): void {
    this.object.position.copy(this.body.position)
    this.object.quaternion.copy(this.body.quaternion)
  }

  postStep(_dt: number, context: PhysicsContext): void {
    this.syncTransform()

    // Spray on entry: the moment the body's lowest point crosses the surface
    // going down, and only if it is moving fast enough to break it.
    const lowest = this.lowestPoint()
    const surface = WATER_LEVEL + context.water.heightAt(lowest.x, lowest.z)
    const above = lowest.y > surface

    if (this.wasAboveSurface && !above) {
      const impact = -this.body.velocity.y
      if (impact > this.splashThreshold && context.splash) {
        const count = Math.min(90, Math.round(impact * 14))
        _velocity.copy(_up)
        context.splash.emit(
          lowest.setY(surface),
          _velocity,
          count,
          Math.min(impact * 0.75, 4.5),
          0.85,
        )
      }
    }
    this.wasAboveSurface = above
  }

  /** Lowest sphere surface point, where an impact would first break the water. */
  private lowestPoint(): Vector3 {
    let best = Number.POSITIVE_INFINITY
    let index = 0
    for (let i = 0; i < this.body.spheres.length; i++) {
      const y = this.body.worldSpheres[i]!.y - this.body.spheres[i]!.radius
      if (y < best) {
        best = y
        index = i
      }
    }
    const centre = this.body.worldSpheres[index]!
    return _lowest.set(centre.x, best, centre.z)
  }
}

const _lowest = new Vector3()
