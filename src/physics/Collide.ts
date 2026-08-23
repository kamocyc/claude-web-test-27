import { Vector3 } from 'three'
import { POOL_HALF_D, POOL_HALF_W, floorYAt } from '../core/config'
import type { RigidBody } from './RigidBody'

/**
 * Sphere-set collision resolution.
 *
 * Every body is already a bag of spheres for buoyancy, so contacts reuse that
 * same proxy. With a few dozen bodies the pairwise test is a few thousand
 * distance checks per step — cheaper than maintaining a broadphase, and much
 * easier to keep correct.
 */

const _normal = new Vector3()
const _rA = new Vector3()
const _rB = new Vector3()
const _velA = new Vector3()
const _velB = new Vector3()
const _rel = new Vector3()
const _impulse = new Vector3()
const _cross = new Vector3()
const _contact = new Vector3()
const _tangent = new Vector3()

/** How much of a penetration is corrected per iteration. */
const CORRECTION = 0.4
/** Penetration tolerated without correction, to stop contacts jittering. */
const SLOP = 0.002

/**
 * Angular term of the effective mass along `normal` for a contact at `r`.
 * (invI * (r x n)) x r . n
 */
function angularTerm(body: RigidBody, r: Vector3, normal: Vector3): number {
  if (!body.dynamic) return 0
  _cross.copy(r).cross(normal)
  body.applyInvInertia(_cross)
  _cross.cross(r)
  return _cross.dot(normal)
}

/**
 * Resolve one contact: normal impulse with restitution, a tangential impulse
 * standing in for friction, then a positional nudge so bodies do not sink into
 * each other over time.
 */
function resolveContact(
  a: RigidBody,
  b: RigidBody | null,
  contact: Vector3,
  normal: Vector3,
  penetration: number,
  restitution: number,
  friction: number,
): void {
  const invMassSum = a.invMass + (b ? b.invMass : 0)
  if (invMassSum <= 0) return

  _rA.copy(contact).sub(a.position)
  a.pointVelocity(contact, _velA)
  if (b) {
    _rB.copy(contact).sub(b.position)
    b.pointVelocity(contact, _velB)
  } else {
    _rB.setScalar(0)
    _velB.setScalar(0)
  }

  _rel.copy(_velA).sub(_velB)
  const normalVel = _rel.dot(normal)
  if (normalVel > 0) return // already separating

  const denom = invMassSum + angularTerm(a, _rA, normal) + (b ? angularTerm(b, _rB, normal) : 0)
  if (denom <= 1e-9) return

  // Soften restitution for slow contacts so resting objects settle.
  const e = normalVel < -0.4 ? restitution : 0
  const j = (-(1 + e) * normalVel) / denom

  _impulse.copy(normal).multiplyScalar(j)
  a.applyImpulse(_impulse, contact)
  if (b) b.applyImpulse(_impulse.negate(), contact)

  // Coulomb-ish tangential impulse.
  if (friction > 0) {
    _tangent.copy(_rel).addScaledVector(normal, -normalVel)
    const tangentSpeed = _tangent.length()
    if (tangentSpeed > 1e-5) {
      _tangent.divideScalar(tangentSpeed)
      const denomT =
        invMassSum + angularTerm(a, _rA, _tangent) + (b ? angularTerm(b, _rB, _tangent) : 0)
      if (denomT > 1e-9) {
        let jt = -tangentSpeed / denomT
        const limit = friction * Math.abs(j)
        jt = Math.max(-limit, Math.min(limit, jt))
        _impulse.copy(_tangent).multiplyScalar(jt)
        a.applyImpulse(_impulse, contact)
        if (b) b.applyImpulse(_impulse.negate(), contact)
      }
    }
  }

  const correction = Math.max(penetration - SLOP, 0) * (CORRECTION / invMassSum)
  if (correction > 0) {
    a.position.addScaledVector(normal, correction * a.invMass)
    if (b) b.position.addScaledVector(normal, -correction * b.invMass)
    a.syncDerived()
    if (b) b.syncDerived()
  }
}

/** Resolve every overlapping sphere pair between two bodies. */
export function collidePair(a: RigidBody, b: RigidBody): void {
  if (!a.dynamic && !b.dynamic) return
  const reach = a.boundingRadius + b.boundingRadius
  if (a.position.distanceToSquared(b.position) > reach * reach) return

  const restitution = Math.min(a.restitution, b.restitution)
  for (let i = 0; i < a.spheres.length; i++) {
    const ca = a.worldSpheres[i]!
    const ra = a.spheres[i]!.radius
    for (let j = 0; j < b.spheres.length; j++) {
      const cb = b.worldSpheres[j]!
      const rb = b.spheres[j]!.radius
      const sum = ra + rb
      _normal.copy(ca).sub(cb)
      const distSq = _normal.lengthSq()
      if (distSq >= sum * sum) continue

      const dist = Math.sqrt(distSq)
      if (dist < 1e-6) {
        _normal.set(0, 1, 0)
      } else {
        _normal.divideScalar(dist)
      }
      const penetration = sum - dist
      _contact
        .copy(cb)
        .addScaledVector(_normal, rb)
        .add(_scratch.copy(ca).addScaledVector(_normal, -ra))
        .multiplyScalar(0.5)
      resolveContact(a, b, _contact, _normal, penetration, restitution, 0.25)
    }
  }
}

/** Keep a body inside the pool shell: four walls plus the sloping floor. */
export function collideWithPool(body: RigidBody): void {
  if (!body.dynamic) return

  for (let i = 0; i < body.spheres.length; i++) {
    const centre = body.worldSpheres[i]!
    const radius = body.spheres[i]!.radius

    // Side walls.
    checkPlane(body, centre, radius, 1, 0, 0, -POOL_HALF_W)
    checkPlane(body, centre, radius, -1, 0, 0, -POOL_HALF_W)
    checkPlane(body, centre, radius, 0, 0, 1, -POOL_HALF_D)
    checkPlane(body, centre, radius, 0, 0, -1, -POOL_HALF_D)

    // Sloping floor, treated as the local horizontal plane under this sphere.
    const floor = floorYAt(centre.z)
    const penetration = floor + radius - centre.y
    if (penetration > 0) {
      _normal.set(0, 1, 0)
      _contact.set(centre.x, centre.y - radius, centre.z)
      resolveContact(body, null, _contact, _normal, penetration, body.restitution * 0.5, 0.4)
    }
  }
}

/**
 * Half-space test against a wall whose inward normal is (nx, ny, nz) and whose
 * plane passes `offset` from the origin along that normal.
 */
function checkPlane(
  body: RigidBody,
  centre: Vector3,
  radius: number,
  nx: number,
  ny: number,
  nz: number,
  offset: number,
): void {
  const signedDistance = centre.x * nx + centre.y * ny + centre.z * nz - offset
  const penetration = radius - signedDistance
  if (penetration <= 0) return
  _normal.set(nx, ny, nz)
  _contact.copy(centre).addScaledVector(_normal, -radius)
  resolveContact(body, null, _contact, _normal, penetration, body.restitution * 0.6, 0.2)
}

const _scratch = new Vector3()
