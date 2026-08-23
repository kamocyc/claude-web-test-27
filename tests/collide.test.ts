import { Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { POOL_HALF_D, POOL_HALF_W, floorYAt } from '../src/core/config'
import { collidePair, collideWithPool } from '../src/physics/Collide'
import { RigidBody } from '../src/physics/RigidBody'

function ball(radius: number, mass: number) {
  return new RigidBody({
    mass,
    spheres: [{ local: new Vector3(), radius }],
    restitution: 1,
    linearDragRate: 0,
  })
}

/** Total linear momentum of a set of bodies. */
function momentum(...bodies: RigidBody[]) {
  const p = new Vector3()
  for (const b of bodies) p.addScaledVector(b.velocity, b.mass)
  return p
}

describe('collidePair', () => {
  it('separates overlapping spheres', () => {
    const a = ball(0.5, 1)
    const b = ball(0.5, 1)
    a.position.set(-0.3, 0, 0)
    b.position.set(0.3, 0, 0)
    a.syncDerived()
    b.syncDerived()

    const before = a.position.distanceTo(b.position)
    for (let i = 0; i < 40; i++) collidePair(a, b)
    const after = a.position.distanceTo(b.position)

    expect(after).toBeGreaterThan(before)
    expect(after).toBeGreaterThan(0.95)
  })

  it('conserves linear momentum in a head-on impact', () => {
    const a = ball(0.5, 1)
    const b = ball(0.5, 1)
    // Overlapping by 0.1 m, so there is an actual contact to resolve.
    a.position.set(-0.45, 0, 0)
    b.position.set(0.45, 0, 0)
    a.velocity.set(2, 0, 0)
    b.velocity.set(-2, 0, 0)
    a.syncDerived()
    b.syncDerived()

    const before = momentum(a, b)
    collidePair(a, b)
    const after = momentum(a, b)

    expect(after.x).toBeCloseTo(before.x, 9)
    expect(after.y).toBeCloseTo(before.y, 9)
    expect(after.z).toBeCloseTo(before.z, 9)
  })

  it('swaps the velocities of equal masses bouncing perfectly', () => {
    const a = ball(0.5, 1)
    const b = ball(0.5, 1)
    a.position.set(-0.45, 0, 0)
    b.position.set(0.45, 0, 0)
    a.velocity.set(2, 0, 0)
    b.velocity.set(0, 0, 0)
    a.syncDerived()
    b.syncDerived()

    collidePair(a, b)

    expect(a.velocity.x).toBeCloseTo(0, 6)
    expect(b.velocity.x).toBeCloseTo(2, 6)
  })

  it('leaves separating bodies alone', () => {
    const a = ball(0.5, 1)
    const b = ball(0.5, 1)
    a.position.set(-0.4, 0, 0)
    b.position.set(0.4, 0, 0)
    a.velocity.set(-1, 0, 0)
    b.velocity.set(1, 0, 0)
    a.syncDerived()
    b.syncDerived()

    collidePair(a, b)

    expect(a.velocity.x).toBeCloseTo(-1, 9)
    expect(b.velocity.x).toBeCloseTo(1, 9)
  })

  it('ignores pairs that are nowhere near each other', () => {
    const a = ball(0.5, 1)
    const b = ball(0.5, 1)
    a.position.set(-5, 0, 0)
    b.position.set(5, 0, 0)
    a.syncDerived()
    b.syncDerived()

    collidePair(a, b)
    expect(a.velocity.length()).toBe(0)
    expect(b.velocity.length()).toBe(0)
  })

  it('spins a body struck off-centre', () => {
    const a = new RigidBody({
      mass: 1,
      spheres: [
        { local: new Vector3(-0.4, 0, 0), radius: 0.2 },
        { local: new Vector3(0.4, 0, 0), radius: 0.2 },
      ],
      restitution: 1,
    })
    const b = ball(0.2, 1)
    a.position.set(0, 0, 0)
    b.position.set(0.4, 0, 0.35)
    b.velocity.set(0, 0, -3)
    a.syncDerived()
    b.syncDerived()

    collidePair(a, b)
    expect(a.angularVelocity.length()).toBeGreaterThan(0.1)
  })
})

describe('collideWithPool', () => {
  it('pushes a body back inside every wall', () => {
    for (const start of [
      new Vector3(POOL_HALF_W + 0.2, -0.5, 0),
      new Vector3(-POOL_HALF_W - 0.2, -0.5, 0),
      new Vector3(0, -0.5, POOL_HALF_D + 0.2),
      new Vector3(0, -0.5, -POOL_HALF_D - 0.2),
    ]) {
      const body = ball(0.3, 5)
      body.position.copy(start)
      body.syncDerived()
      for (let i = 0; i < 60; i++) collideWithPool(body)

      expect(Math.abs(body.position.x)).toBeLessThanOrEqual(POOL_HALF_W - 0.3 + 1e-2)
      expect(Math.abs(body.position.z)).toBeLessThanOrEqual(POOL_HALF_D - 0.3 + 1e-2)
    }
  })

  it('lifts a body off the sloping floor at the depth for its own position', () => {
    for (const z of [-4, 0, 4]) {
      const body = ball(0.25, 30)
      body.position.set(0, floorYAt(z) - 0.4, z)
      body.syncDerived()
      for (let i = 0; i < 80; i++) collideWithPool(body)
      expect(body.position.y).toBeGreaterThan(floorYAt(z) + 0.2)
    }
  })

  it('does not disturb a body sitting well clear of the shell', () => {
    const body = ball(0.3, 2)
    body.position.set(0, -0.4, 0)
    body.syncDerived()
    collideWithPool(body)
    expect(body.velocity.length()).toBe(0)
    expect(body.position.y).toBeCloseTo(-0.4, 12)
  })
})
