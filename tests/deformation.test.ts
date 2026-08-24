import { describe, expect, it } from 'vitest'
import { PHYSICS_DT } from '../src/core/config'
import { AirMattress, BeachBall } from '../src/entities/PoolFloat'
import { RubberDuck } from '../src/entities/RubberDuck'
import { SwimRing } from '../src/entities/SwimRing'
import { shellIsStable } from '../src/physics/DeformableShell'
import type { RigidBody } from '../src/physics/RigidBody'

/**
 * The inflatables are soft, and softness that only exists in the mesh is a lie.
 *
 * What these check is that the deformation is the same object as the physics:
 * the thing that squashes is the proxy sphere set, which is what buoyancy
 * integrates and what the collision solver tests against. So the ring giving
 * where a rider sits and the ring sitting lower on that side are not two
 * features that have to be kept in step — they are one number.
 */

/** Press on a node for a while and report where it settles. */
function press(body: RigidBody, shell: NonNullable<SwimRing['shell']>, node: number, newtons: number, seconds: number) {
  const steps = Math.round(seconds / PHYSICS_DT)
  for (let i = 0; i < steps; i++) {
    body.recordLoad(node, newtons * PHYSICS_DT)
    shell.update(body, PHYSICS_DT)
  }
}

function release(body: RigidBody, shell: NonNullable<SwimRing['shell']>, seconds: number) {
  const steps = Math.round(seconds / PHYSICS_DT)
  for (let i = 0; i < steps; i++) shell.update(body, PHYSICS_DT)
}

describe('what deforms and what does not', () => {
  it('gives the ring, the mattress and the ball a shell but not the duck', () => {
    expect(new SwimRing(0).shell).not.toBeNull()
    expect(new AirMattress().shell).not.toBeNull()
    expect(new BeachBall().shell).not.toBeNull()
    // Hard plastic. It should not squash, and it does not.
    expect(new RubberDuck().shell).toBeNull()
  })

  it('is tuned inside the fixed step it is integrated at', () => {
    // An explicit spring rings if its period gets close to the step. Node mass
    // here is mostly the water the tube has to shove, which is what keeps these
    // slow enough to integrate honestly.
    for (const options of [
      { stiffness: 3200, nodeMass: 3, damping: 70, coupling: 2000 },
      { stiffness: 2100, nodeMass: 4, damping: 75, coupling: 900 },
      { stiffness: 3000, nodeMass: 1.2, damping: 60, coupling: 0 },
    ]) {
      expect(shellIsStable(options)).toBe(true)
    }
  })
})

describe('a swim ring under load', () => {
  it('squashes where it is pressed, in proportion to the load', () => {
    const ring = new SwimRing(0)
    const shell = ring.shell!
    press(ring.body, shell, 2, 200, 1.5)
    const gentle = Math.abs(shell.deflection[2]!)

    const other = new SwimRing(0)
    press(other.body, other.shell!, 2, 400, 1.5)
    const hard = Math.abs(other.shell!.deflection[2]!)

    console.log(
      `[ring] 200N gives ${(gentle * 1000).toFixed(1)}mm, 400N gives ${(hard * 1000).toFixed(1)}mm ` +
        `on a 110mm tube`,
    )
    expect(gentle).toBeGreaterThan(0.03)
    expect(hard).toBeGreaterThan(gentle * 1.8)
  })

  it('spreads the squash to its neighbours and leaves the far side alone', () => {
    const ring = new SwimRing(0)
    const shell = ring.shell!
    press(ring.body, shell, 2, 200, 1.5)

    const pressed = Math.abs(shell.deflection[2]!)
    const beside = Math.abs(shell.deflection[1]!)
    const opposite = Math.abs(shell.deflection[6]!)

    console.log(
      `[ring] pressed ${(pressed * 1000).toFixed(1)}mm, next to it ${(beside * 1000).toFixed(1)}mm, ` +
        `opposite ${(opposite * 1000).toFixed(1)}mm`,
    )
    expect(beside).toBeGreaterThan(pressed * 0.08)
    expect(beside).toBeLessThan(pressed * 0.6)
    expect(opposite).toBeLessThan(beside * 0.5)
  })

  it('shrinks the proxy sphere itself, not only the drawing of it', () => {
    const ring = new SwimRing(0)
    const before = ring.body.spheres[2]!.radius
    press(ring.body, ring.shell!, 2, 300, 1.5)
    const after = ring.body.spheres[2]!.radius
    expect(after).toBeLessThan(before * 0.9)
    // The one the load never reached is untouched.
    expect(ring.body.spheres[6]!.radius).toBeGreaterThan(before * 0.97)
  })

  it('comes back when the load goes away', () => {
    const ring = new SwimRing(0)
    const shell = ring.shell!
    press(ring.body, shell, 2, 300, 1.5)
    expect(shell.peak).toBeGreaterThan(0.03)
    release(ring.body, shell, 2)
    console.log(`[ring] settled back to ${(shell.peak * 1000).toFixed(2)}mm`)
    expect(shell.peak).toBeLessThan(0.001)
    expect(ring.body.spheres[2]!.radius).toBeCloseTo(shell.restRadius(2), 4)
  })

  it('never squashes past its own limit, however hard it is pressed', () => {
    const ring = new SwimRing(0)
    press(ring.body, ring.shell!, 2, 100_000, 1)
    for (let i = 0; i < ring.body.spheres.length; i++) {
      expect(ring.body.spheres[i]!.radius).toBeGreaterThan(0)
      expect(Number.isFinite(ring.body.spheres[i]!.radius)).toBe(true)
    }
    expect(ring.body.spheres[2]!.radius).toBeGreaterThan(ring.shell!.restRadius(2) * 0.39)
  })
})

describe('a beach ball', () => {
  it('flattens along the direction it was struck from', () => {
    const ball = new BeachBall()
    const shell = ball.shell!
    let peak = 0
    for (let i = 0; i < Math.round(1 / PHYSICS_DT); i++) {
      if (i < 3) ball.body.recordLoad(0, 0.7)
      shell.update(ball.body, PHYSICS_DT)
      peak = Math.max(peak, Math.abs(shell.deflection[0]!))
    }
    console.log(`[ball] a 2.1 N s knock squashed it ${(peak * 1000).toFixed(1)}mm of 240`)
    expect(peak).toBeGreaterThan(0.01)
    // And it recovers: a ball that stayed dented would be a bad ball.
    for (let i = 0; i < Math.round(1 / PHYSICS_DT); i++) shell.update(ball.body, PHYSICS_DT)
    expect(Math.abs(shell.deflection[0]!)).toBeLessThan(0.001)
  })
})

describe('an air mattress', () => {
  it('sags under the middle of the lattice and lets the ends rise', () => {
    const mattress = new AirMattress()
    const shell = mattress.shell!
    // Nodes 2 and 3 are the middle pair.
    for (let i = 0; i < Math.round(2 / PHYSICS_DT); i++) {
      mattress.body.recordLoad(2, 150 * PHYSICS_DT)
      mattress.body.recordLoad(3, 150 * PHYSICS_DT)
      shell.update(mattress.body, PHYSICS_DT)
    }
    const middle = Math.abs(shell.deflection[2]!)
    const end = Math.abs(shell.deflection[0]!)
    console.log(`[mattress] middle ${(middle * 1000).toFixed(1)}mm, end ${(end * 1000).toFixed(1)}mm`)
    expect(middle).toBeGreaterThan(0.03)
    expect(end).toBeLessThan(middle * 0.7)
    expect(end).toBeGreaterThan(0.001)
  })
})
