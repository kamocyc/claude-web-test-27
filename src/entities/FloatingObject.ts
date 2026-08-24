import { Group, Object3D, Vector3 } from 'three'
import { WATER_LEVEL } from '../core/config'
import type { BuoyancyOptions } from '../physics/Buoyancy'
import type { PhysicsActor, PhysicsContext } from '../physics/PhysicsWorld'
import type { DeformableShell } from '../physics/DeformableShell'
import type { RideSpec } from './FloatRider'
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
  /**
   * Set by subclasses that are inflatable. The shell owns the proxy sphere
   * radii from then on, so the body is still rigid in the solver's eyes while
   * being a different shape every step.
   */
  shell: DeformableShell | null = null
  /** Set by floats you can climb onto. Null for anything you cannot. */
  ride: RideSpec | null = null
  private readonly splashThreshold: number
  private wasAboveSurface = true
  /** Radius of the sphere that `lowestPoint` last reported. */
  private lowestRadius = 0.1

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

  postStep(dt: number, context: PhysicsContext): void {
    // Deformation first: it reads the contact impulses this step recorded and
    // rewrites the sphere radii, which is what the next step's buoyancy and
    // contacts will see. Then the mesh is fitted to the result.
    if (this.shell !== null) {
      this.shell.update(this.body, dt)
      this.skin(this.shell)
    }
    this.syncTransform()

    // Spray on entry: the moment the body's lowest point crosses the surface
    // going down, and only if it is moving fast enough to break it.
    const lowest = this.lowestPoint()
    const surface = WATER_LEVEL + context.water.heightAt(lowest.x, lowest.z)
    const above = lowest.y > surface

    if (this.wasAboveSurface && !above) {
      const impact = -this.body.velocity.y
      if (impact > 0.25) {
        // The wave an object makes as it lands is an event, not something the
        // continuous wake term should be asked to produce — that one is
        // deliberately gentle, because it damps as readily as it radiates.
        // addImpulse keeps this volume-neutral however hard the landing is.
        const radius = this.lowestRadius
        const depth = Math.min(impact * 0.02 * (radius / 0.25), 0.1)
        context.splats.addImpulse(
          lowest.x,
          lowest.z,
          radius * 1.5,
          depth,
          Math.min(1, impact * 0.3),
        )
      }
      if (impact > this.splashThreshold && context.splash) {
        const count = Math.min(90, Math.round(impact * 15))
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

  /** Fit the mesh to the deformed shell. Subclasses with a shell override it. */
  protected skin(_shell: DeformableShell): void {}

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
    this.lowestRadius = this.body.spheres[index]!.radius
    return _lowest.set(centre.x, best, centre.z)
  }
}

const _lowest = new Vector3()
