import { Matrix3, Matrix4, Quaternion, Vector3 } from 'three'

/**
 * One sphere of a body's collision/buoyancy proxy.
 *
 * A body is described entirely as a set of spheres in local space. That single
 * representation feeds both the buoyancy solver (each sphere contributes its
 * own submerged cap, so restoring torque falls out for free) and the collision
 * solver (sphere-sphere is the cheapest useful pair test there is). A swim ring
 * becomes eight spheres on a circle; a duck becomes three.
 */
export interface BodySphere {
  local: Vector3
  radius: number
}

export interface RigidBodyOptions {
  mass: number
  spheres: BodySphere[]
  /** Volume used for buoyancy. Defaults to the sum of the sphere volumes. */
  volume?: number
  /** Bounce, 0..1. */
  restitution?: number
  /** Quadratic drag coefficient while submerged. */
  dragCoefficient?: number
  /**
   * Linear vertical drag, per second, scaled by displaced volume. Stands in
   * for wave radiation - the energy a bobbing body loses by making waves.
   * Without it a float never settles: quadratic drag alone dies off as v^2 and
   * leaves a small oscillation ringing forever. Vertical only; see Buoyancy.
   */
  linearDragRate?: number
  /** Angular velocity lost per second while submerged. */
  angularDamping?: number
  /** Set false for static geometry that pushes but is never pushed. */
  dynamic?: boolean
}

const _r = new Vector3()
const _tmp = new Vector3()
const _rot = new Matrix3()
const _rotT = new Matrix3()
const _m4 = new Matrix4()
const _spin = new Quaternion()

export class RigidBody {
  readonly position = new Vector3()
  readonly quaternion = new Quaternion()
  readonly velocity = new Vector3()
  readonly angularVelocity = new Vector3()

  readonly force = new Vector3()
  readonly torque = new Vector3()

  readonly spheres: BodySphere[]
  /** Sphere centres in world space, refreshed by `syncDerived`. */
  readonly worldSpheres: Vector3[]

  mass: number
  invMass: number
  /** Diagonal inertia tensor in local space. */
  readonly inertia = new Vector3(1, 1, 1)
  readonly invInertia = new Vector3(1, 1, 1)

  volume: number
  restitution: number
  dragCoefficient: number
  linearDragRate: number
  angularDamping: number
  dynamic: boolean
  /**
   * Multiplier on the friction of every contact this body makes.
   *
   * One is an object resting on a surface. A walking swimmer turns it right
   * down: feet are not a block being dragged, and Coulomb friction against a
   * body being driven by its own control forces cancels most of the drive —
   * the first attempt at climbing the entry ramp managed three centimetres a
   * second. The controller supplies the braking instead, which is what the
   * legs are doing in any case.
   */
  frictionScale = 1

  /**
   * Added-mass factor for this step, set by the buoyancy pass and applied once
   * every force is in.
   *
   * A body accelerating through water has to shove water aside, so it behaves
   * as if it were heavier by roughly half the mass of the fluid it displaces.
   * For a swim ring — two kilos of plastic displacing a hundred litres — that
   * is a factor of about twenty-five, and it must apply to *every* force the
   * body takes, not just the buoyant one. Scaling only part of them moves the
   * equilibrium: a thirty-newton push from something that skipped the scaling
   * beats a thousand newtons of buoyancy that did not, and the ring sinks.
   */
  addedMassScale = 1

  /** Fold this step's added mass into the accumulated force and torque. */
  applyAddedMass(): void {
    if (this.addedMassScale === 1) return
    this.force.multiplyScalar(this.addedMassScale)
    this.torque.multiplyScalar(this.addedMassScale)
    this.addedMassScale = 1
  }

  /** Largest distance from the origin to a sphere surface — a bounding radius. */
  readonly boundingRadius: number

  /**
   * Normal impulse each sphere took from contacts this step, in newton-seconds.
   *
   * Only deformable bodies read it, and this is the honest place to measure the
   * load on them: it is the actual impulse the solver applied, at the sphere it
   * was applied to. A swim ring dips where somebody is sitting because that is
   * where the contact is, not because anything is looking for riders.
   */
  readonly sphereLoad: Float32Array
  /**
   * Impulse-weighted contact normal on each sphere, packed as xyz triples.
   *
   * A ring only needs to know how hard it was pressed — its tube squashes
   * radially whatever pushes it. A ball needs to know which way: it flattens
   * against the thing it hit and bulges at right angles to it.
   */
  readonly sphereLoadNormal: Float32Array

  constructor(options: RigidBodyOptions) {
    this.spheres = options.spheres.map((s) => ({ local: s.local.clone(), radius: s.radius }))
    this.worldSpheres = this.spheres.map(() => new Vector3())
    this.dynamic = options.dynamic ?? true
    this.mass = options.mass
    this.invMass = this.dynamic && options.mass > 0 ? 1 / options.mass : 0
    this.restitution = options.restitution ?? 0.25
    this.dragCoefficient = options.dragCoefficient ?? 0.9
    this.linearDragRate = options.linearDragRate ?? 11
    this.angularDamping = options.angularDamping ?? 1.6

    let sphereVolume = 0
    let bounding = 0
    for (const s of this.spheres) {
      sphereVolume += (4 / 3) * Math.PI * s.radius ** 3
      bounding = Math.max(bounding, s.local.length() + s.radius)
    }
    this.volume = options.volume ?? sphereVolume
    this.boundingRadius = bounding
    this.sphereLoad = new Float32Array(this.spheres.length)
    this.sphereLoadNormal = new Float32Array(this.spheres.length * 3)

    this.computeInertiaFromSpheres()
    this.syncDerived()
  }

  /**
   * Inertia from the sphere set, treating each as a solid sphere with mass in
   * proportion to its volume and applying the parallel axis theorem.
   */
  private computeInertiaFromSpheres(): void {
    let totalVolume = 0
    for (const s of this.spheres) totalVolume += (4 / 3) * Math.PI * s.radius ** 3
    if (totalVolume <= 0 || this.mass <= 0) {
      this.inertia.set(1, 1, 1)
      this.invInertia.set(0, 0, 0)
      return
    }

    let ix = 0
    let iy = 0
    let iz = 0
    for (const s of this.spheres) {
      const v = (4 / 3) * Math.PI * s.radius ** 3
      const m = (this.mass * v) / totalVolume
      const own = 0.4 * m * s.radius * s.radius
      const { x, y, z } = s.local
      ix += own + m * (y * y + z * z)
      iy += own + m * (x * x + z * z)
      iz += own + m * (x * x + y * y)
    }
    this.inertia.set(ix, iy, iz)
    this.invInertia.set(
      this.dynamic && ix > 0 ? 1 / ix : 0,
      this.dynamic && iy > 0 ? 1 / iy : 0,
      this.dynamic && iz > 0 ? 1 / iz : 0,
    )
  }

  /** Recompute world-space sphere centres from the current transform. */
  syncDerived(): void {
    for (let i = 0; i < this.spheres.length; i++) {
      this.worldSpheres[i]!.copy(this.spheres[i]!.local)
        .applyQuaternion(this.quaternion)
        .add(this.position)
    }
  }

  clearForces(): void {
    this.force.setScalar(0)
    this.torque.setScalar(0)
  }

  /** Note a contact impulse on one sphere, and which way it pushed. */
  recordLoad(index: number, impulse: number, normal?: Vector3): void {
    if (index < 0 || index >= this.sphereLoad.length) return
    this.sphereLoad[index]! += impulse
    if (normal === undefined) return
    const base = index * 3
    this.sphereLoadNormal[base]! += normal.x * impulse
    this.sphereLoadNormal[base + 1]! += normal.y * impulse
    this.sphereLoadNormal[base + 2]! += normal.z * impulse
  }

  /** Forget the loads once whatever cares about them has read them. */
  clearLoads(): void {
    this.sphereLoad.fill(0)
    this.sphereLoadNormal.fill(0)
  }

  addForce(force: Vector3): void {
    this.force.add(force)
  }

  /** Apply a force at a world-space point, producing torque about the centre. */
  addForceAtPoint(force: Vector3, worldPoint: Vector3): void {
    this.force.add(force)
    _r.copy(worldPoint).sub(this.position)
    this.torque.add(_tmp.copy(_r).cross(force))
  }

  addTorque(torque: Vector3): void {
    this.torque.add(torque)
  }

  /** Transform a world vector by the inverse world inertia tensor, in place. */
  applyInvInertia(worldVector: Vector3): Vector3 {
    _rot.setFromMatrix4(_m4.makeRotationFromQuaternion(this.quaternion))
    _rotT.copy(_rot).transpose()
    worldVector.applyMatrix3(_rotT)
    worldVector.set(
      worldVector.x * this.invInertia.x,
      worldVector.y * this.invInertia.y,
      worldVector.z * this.invInertia.z,
    )
    worldVector.applyMatrix3(_rot)
    return worldVector
  }

  /** Velocity of a world-space point attached to the body: v + omega x r. */
  pointVelocity(worldPoint: Vector3, out: Vector3): Vector3 {
    _r.copy(worldPoint).sub(this.position)
    out.copy(this.angularVelocity).cross(_r).add(this.velocity)
    return out
  }

  /** Semi-implicit Euler integration. */
  integrate(dt: number): void {
    if (!this.dynamic) {
      this.syncDerived()
      return
    }

    this.velocity.addScaledVector(this.force, this.invMass * dt)

    _tmp.copy(this.torque)
    this.applyInvInertia(_tmp)
    this.angularVelocity.addScaledVector(_tmp, dt)

    this.position.addScaledVector(this.velocity, dt)

    const w = this.angularVelocity
    if (w.lengthSq() > 1e-12) {
      _spin.set(w.x * dt * 0.5, w.y * dt * 0.5, w.z * dt * 0.5, 0)
      _spin.multiply(this.quaternion)
      this.quaternion.set(
        this.quaternion.x + _spin.x,
        this.quaternion.y + _spin.y,
        this.quaternion.z + _spin.z,
        this.quaternion.w + _spin.w,
      )
      this.quaternion.normalize()
    }

    this.syncDerived()
  }

  /** Apply an impulse at a world point (used by the collision solver). */
  applyImpulse(impulse: Vector3, worldPoint: Vector3): void {
    if (!this.dynamic) return
    this.velocity.addScaledVector(impulse, this.invMass)
    _r.copy(worldPoint).sub(this.position)
    _tmp.copy(_r).cross(impulse)
    this.applyInvInertia(_tmp)
    this.angularVelocity.add(_tmp)
  }
}
