import { Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import {
  ISLAND,
  ISLAND_TOP,
  POOL,
  POOL_HALF_D,
  POOL_HALF_W,
  RIVER,
  RIVER_BANK,
  WATER_LEVEL,
  floorYAt,
} from '../src/core/config'
import { stadiumDistance, type Vec2 } from '../src/core/shapes'
import { collideInsideStadium, collidePair, collideWithPool, collideWithStadium } from '../src/physics/Collide'
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

const _outward: Vec2 = { x: 0, z: 0 }

describe('the island and the river bank', () => {
  it('pushes a float that has been driven into the island wall back out', () => {
    // The case that happens: something in the channel shoved against the side.
    // A body buried much deeper than this is closer to the top than to the
    // wall, and the contact takes it out that way instead — which is the right
    // answer for a solid block, and why the test is at the wall.
    const body = ball(0.3, 5)
    body.position.set(0.5, -0.05, 1)
    body.syncDerived()
    for (let i = 0; i < 60; i++) collideWithStadium(body, ISLAND, ISLAND_TOP)

    const distance = stadiumDistance(ISLAND, body.position.x, body.position.z, _outward)
    expect(distance).toBeGreaterThan(ISLAND.radius + 0.3 - 1e-2)
    // Out through the wall, not up over the top.
    expect(body.position.y).toBeLessThan(0.1)
  })

  it('holds a body up on top of the island rather than through it', () => {
    const body = ball(0.25, 5)
    body.position.set(0, ISLAND_TOP + 0.1, 0)
    body.syncDerived()
    for (let i = 0; i < 80; i++) collideWithStadium(body, ISLAND, ISLAND_TOP)

    expect(body.position.y).toBeGreaterThan(ISLAND_TOP + 0.2)
    // And it stayed where it was, instead of being shoved off the side.
    expect(Math.hypot(body.position.x, body.position.z)).toBeLessThan(0.2)
  })

  it('keeps a body inside the outer bank', () => {
    const body = ball(0.3, 5)
    // Out in what is now the filled-in corner of the pool.
    body.position.set(6.4, -0.3, 4.4)
    body.syncDerived()
    for (let i = 0; i < 60; i++) collideInsideStadium(body, RIVER_BANK, ISLAND_TOP)

    const distance = stadiumDistance(RIVER_BANK, body.position.x, body.position.z, _outward)
    expect(distance).toBeLessThan(RIVER.outerRadius - 0.3 + 1e-2)
  })
})

describe('the pool shell above the water line', () => {
  it('lands a body that left the pool on the deck', () => {
    // The flume passes over the deck, so anyone who goes over its side has to
    // have something to land on. Before the walls were given a height they
    // would have been dragged sideways back into the pool from any altitude.
    const body = ball(0.25, 5)
    body.position.set(POOL_HALF_W + 2.5, WATER_LEVEL + POOL.copingHeight - 0.4, 2)
    body.syncDerived()
    for (let i = 0; i < 80; i++) collideWithPool(body)

    expect(body.position.y).toBeGreaterThan(WATER_LEVEL + POOL.copingHeight)
    expect(body.position.x).toBeGreaterThan(POOL_HALF_W + 2)
  })

  it('does not touch a body flying over the pool well above the coping', () => {
    const body = ball(0.25, 5)
    body.position.set(POOL_HALF_W - 0.1, 2.5, 0)
    body.syncDerived()
    for (let i = 0; i < 40; i++) collideWithPool(body)

    expect(body.position.x).toBeCloseTo(POOL_HALF_W - 0.1, 9)
    expect(body.velocity.length()).toBe(0)
  })
})
