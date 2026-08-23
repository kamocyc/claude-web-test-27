import { Vector3 } from 'three'
import { GRAVITY, WATER_DENSITY } from '../core/config'
import type { FlowField, Vec2 } from '../sim/FlowField'
import type { WaveFieldCPU } from '../sim/WaveFieldCPU'
import type { SplatQueue } from '../sim/WaveSplat'
import type { RigidBody } from './RigidBody'

/**
 * Volume of the submerged cap of a sphere whose centre sits `submersion`
 * metres below the surface. Continuous and monotonic across the whole range,
 * which is what keeps a body settling smoothly at its waterline instead of
 * buzzing between "in" and "out".
 */
export function submergedSphereVolume(radius: number, submersion: number): number {
  if (submersion <= -radius) return 0
  const full = (4 / 3) * Math.PI * radius ** 3
  if (submersion >= radius) return full
  const capHeight = submersion + radius
  return (Math.PI * capHeight * capHeight * (3 * radius - capHeight)) / 3
}

export interface BuoyancyOptions {
  /** Scales the wave-making splats a body emits. 0 disables the feedback. */
  wakeStrength?: number
  /** Vertical drag multiplier; higher settles bobbing faster. */
  verticalDrag?: number
  /**
   * Added-mass coefficient. 0.5 is the textbook value for a sphere; 0 disables
   * the correction entirely.
   */
  addedMass?: number
}

const _up = new Vector3(0, 1, 0)
const _force = new Vector3()
const _pointVel = new Vector3()
const _relVel = new Vector3()
const _flow: Vec2 = { x: 0, z: 0 }
const _slope: Vec2 = { x: 0, z: 0 }

/**
 * Buoyancy, drag and wave-making for one body against the water field.
 *
 * Each proxy sphere is handled on its own: it gets its own local surface
 * height, its own submerged volume, and its own drag, all applied at its own
 * world position. Restoring torque, list under an off-centre load, and the
 * way a swim ring slaps flat again after you tip it are all emergent from
 * that — none of it is special-cased.
 *
 * The last step closes the loop: a sphere crossing the surface injects a splat
 * proportional to how fast it is displacing water. That is what makes an
 * object's motion *create* the waves that then move everything else.
 */
export function applyBuoyancy(
  body: RigidBody,
  water: WaveFieldCPU,
  flow: FlowField,
  splats: SplatQueue,
  dt: number,
  options: BuoyancyOptions = {},
): void {
  if (!body.dynamic) return
  const wakeStrength = options.wakeStrength ?? 1
  const verticalDrag = options.verticalDrag ?? 1
  const addedMassCoefficient = options.addedMass ?? 0.5
  let displacedTotal = 0

  // Gravity acts on the whole body, once.
  body.force.y -= body.mass * GRAVITY

  const spheres = body.spheres
  const perSphereVolumeScale = body.volume / Math.max(sumSphereVolume(body), 1e-9)

  for (let i = 0; i < spheres.length; i++) {
    const sphere = spheres[i]!
    const centre = body.worldSpheres[i]!
    const surfaceY = water.heightAt(centre.x, centre.z)
    const submersion = surfaceY - centre.y

    if (submersion <= -sphere.radius) continue

    const displaced = submergedSphereVolume(sphere.radius, submersion) * perSphereVolumeScale
    displacedTotal += displaced
    const submergedFraction = displaced / Math.max((4 / 3) * Math.PI * sphere.radius ** 3, 1e-9)

    // Archimedes, applied at the sphere's own position so torque emerges.
    _force.copy(_up).multiplyScalar(WATER_DENSITY * GRAVITY * displaced)
    body.addForceAtPoint(_force, centre)

    // Drag relative to the moving water: horizontal flow plus the surface's
    // own vertical motion, so a passing wave actually carries things along.
    flow.velocityAt(centre.x, centre.z, _flow)
    const waterVy = water.verticalVelocityAt(centre.x, centre.z)
    body.pointVelocity(centre, _pointVel)
    _relVel.set(_pointVel.x - _flow.x, _pointVel.y - waterVy, _pointVel.z - _flow.z)

    const area = Math.PI * sphere.radius * sphere.radius * submergedFraction
    const speed = _relVel.length()
    if (speed > 1e-6) {
      // Quadratic form drag on every axis, plus a linear term on the vertical
      // only. The linear term stands in for wave radiation, which damps heave
      // and is what finally brings a bobbing float to rest — quadratic drag
      // falls off as v^2 and leaves the last centimetre ringing on. Applying it
      // horizontally too would be wrong: it scales with displaced volume, so a
      // swimmer-sized body would face hundreds of newtons of surge drag and be
      // unable to move under any plausible stroke.
      const quadratic = 0.5 * WATER_DENSITY * body.dragCoefficient * area * speed
      _force.copy(_relVel).multiplyScalar(-quadratic)
      _force.y -= body.linearDragRate * WATER_DENSITY * displaced * _relVel.y
      _force.y *= verticalDrag
      // Never let one step's drag reverse the body outright — that is how an
      // explicit drag term explodes on light objects at small time steps.
      const maxImpulse = (body.mass * speed) / Math.max(dt, 1e-6)
      if (_force.length() > maxImpulse) _force.setLength(maxImpulse)
      body.addForceAtPoint(_force, centre)
    }

    // Waves push floating things downhill. Slope times displaced weight is the
    // horizontal component of the pressure gradient, to first order.
    water.slopeAt(centre.x, centre.z, _slope)
    _force.set(
      -_slope.x * WATER_DENSITY * GRAVITY * displaced,
      0,
      -_slope.z * WATER_DENSITY * GRAVITY * displaced,
    )
    body.addForceAtPoint(_force, centre)

    // Wave making: only spheres straddling the surface disturb it, and only in
    // proportion to how fast they are pushing water out of the way.
    if (wakeStrength > 0 && Math.abs(submersion) < sphere.radius * 1.5) {
      const plunge = waterVy - _pointVel.y
      const horizontal = Math.hypot(_relVel.x, _relVel.z)
      const strength = (plunge * 0.016 + horizontal * 0.004) * sphere.radius * wakeStrength
      const foam = Math.min(1, Math.max(0, (Math.abs(plunge) - 0.7) * 0.35 + horizontal * 0.05))
      if (Math.abs(strength) > 1e-5 || foam > 0.01) {
        splats.add(centre.x, centre.z, sphere.radius * 1.4, strength, foam)
      }
    }
  }

  // Angular damping, scaled by how much of the body is actually wet.
  const wetness = wetFraction(body, water)
  if (wetness > 0) {
    const damp = Math.max(0, 1 - body.angularDamping * wetness * dt)
    body.angularVelocity.multiplyScalar(damp)
  }

  // Added mass. A body accelerating through water has to shove water aside, so
  // it behaves as if it were heavier by roughly half the mass of the fluid it
  // displaces. For a swim ring — two kilos of plastic displacing ninety litres
  // — that is the difference between a plausible bob and fifty g of buoyancy
  // launching it out of the pool and diverging the integrator. Scaling the
  // whole accumulated force leaves every equilibrium untouched (there the net
  // force is zero) while taming the transients that break it.
  //
  // Torque is scaled by the same factor. Added inertia has its own
  // distribution, but using the linear ratio is close enough at this scale and
  // avoids carrying a second tensor around.
  if (addedMassCoefficient > 0 && displacedTotal > 0) {
    const addedMass = addedMassCoefficient * WATER_DENSITY * displacedTotal
    const scale = body.mass / (body.mass + addedMass)
    body.force.multiplyScalar(scale)
    body.torque.multiplyScalar(scale)
  }
}

function sumSphereVolume(body: RigidBody): number {
  let total = 0
  for (const s of body.spheres) total += (4 / 3) * Math.PI * s.radius ** 3
  return total
}

/** Fraction of the body's spheres that are at least partly under water. */
export function wetFraction(body: RigidBody, water: WaveFieldCPU): number {
  let wet = 0
  for (let i = 0; i < body.spheres.length; i++) {
    const sphere = body.spheres[i]!
    const centre = body.worldSpheres[i]!
    const submersion = water.heightAt(centre.x, centre.z) - centre.y
    wet += Math.min(1, Math.max(0, (submersion + sphere.radius) / (2 * sphere.radius)))
  }
  return wet / Math.max(body.spheres.length, 1)
}

/**
 * Draft a freely floating body settles at: the submersion depth where
 * displaced water weighs exactly as much as the body. Used by tests and to
 * place objects at rest when they spawn.
 */
export function equilibriumSubmersion(radius: number, mass: number): number {
  const target = mass / WATER_DENSITY
  const full = (4 / 3) * Math.PI * radius ** 3
  if (target >= full) return radius
  let lo = -radius
  let hi = radius
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2
    if (submergedSphereVolume(radius, mid) < target) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}
