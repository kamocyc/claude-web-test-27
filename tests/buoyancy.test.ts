import { Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { PHYSICS_DT, WATER_DENSITY } from '../src/core/config'
import {
  applyBuoyancy,
  equilibriumSubmersion,
  submergedSphereVolume,
  wetFraction,
} from '../src/physics/Buoyancy'
import { RigidBody } from '../src/physics/RigidBody'
import { FlowField } from '../src/sim/FlowField'
import { WaveFieldCPU } from '../src/sim/WaveFieldCPU'
import { SplatQueue } from '../src/sim/WaveSplat'

function stillWater() {
  return new WaveFieldCPU({ width: 16, depth: 10, cols: 128, rows: 80 })
}

/** Settle a body under buoyancy alone for `seconds` of simulated time. */
function settle(body: RigidBody, seconds: number, flow = new FlowField()) {
  const water = stillWater()
  const splats = new SplatQueue()
  const steps = Math.round(seconds / PHYSICS_DT)
  for (let i = 0; i < steps; i++) {
    body.clearForces()
    applyBuoyancy(body, water, flow, splats, PHYSICS_DT)
    body.integrate(PHYSICS_DT)
    splats.clear()
  }
  return { water, splats }
}

describe('submergedSphereVolume', () => {
  it('spans empty to full across the sphere', () => {
    const r = 0.5
    const full = (4 / 3) * Math.PI * r ** 3
    expect(submergedSphereVolume(r, -r)).toBe(0)
    expect(submergedSphereVolume(r, -r - 1)).toBe(0)
    expect(submergedSphereVolume(r, r)).toBeCloseTo(full, 10)
    expect(submergedSphereVolume(r, r + 1)).toBeCloseTo(full, 10)
    expect(submergedSphereVolume(r, 0)).toBeCloseTo(full / 2, 10)
  })

  it('increases monotonically, with no steps that could make a body chatter', () => {
    const r = 0.4
    let previous = -1
    for (let s = -r; s <= r; s += r / 200) {
      const v = submergedSphereVolume(r, s)
      expect(v).toBeGreaterThanOrEqual(previous)
      previous = v
    }
  })
})

describe('applyBuoyancy', () => {
  it('settles a light body at the draft where displaced water matches its mass', () => {
    const radius = 0.35
    const mass = 12
    const body = new RigidBody({
      mass,
      spheres: [{ local: new Vector3(0, 0, 0), radius }],
    })
    body.position.set(0, 0.8, 0)

    settle(body, 12)

    const expected = equilibriumSubmersion(radius, mass)
    // Surface is at y = 0, so the centre should sit `expected` below it.
    expect(body.position.y).toBeCloseTo(-expected, 2)
    expect(Math.abs(body.velocity.y)).toBeLessThan(0.02)
  })

  it('displaces exactly its own mass of water at rest', () => {
    const radius = 0.3
    const mass = 20
    const body = new RigidBody({ mass, spheres: [{ local: new Vector3(), radius }] })
    body.position.set(0, 0.5, 0)
    settle(body, 12)

    const displaced = submergedSphereVolume(radius, -body.position.y)
    expect(displaced * WATER_DENSITY).toBeCloseTo(mass, 0)
  })

  it('sinks a body denser than water all the way to the floor', () => {
    const radius = 0.2
    const volume = (4 / 3) * Math.PI * radius ** 3
    const body = new RigidBody({
      mass: volume * WATER_DENSITY * 2.5,
      spheres: [{ local: new Vector3(), radius }],
    })
    body.position.set(0, 0.4, 0)
    settle(body, 6)
    expect(body.position.y).toBeLessThan(-0.5)
  })

  it('flattens a tilted swim ring, because each sphere lifts where it sits', () => {
    const spheres = []
    const ringRadius = 0.55
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2
      spheres.push({
        local: new Vector3(Math.cos(a) * ringRadius, 0, Math.sin(a) * ringRadius),
        radius: 0.14,
      })
    }
    const body = new RigidBody({ mass: 2.2, spheres, angularDamping: 2.5 })
    body.position.set(0, 0.05, 0)
    body.quaternion.setFromAxisAngle(new Vector3(0, 0, 1), 0.9) // tipped ~52 degrees

    const startTilt = Math.abs(new Vector3(0, 1, 0).applyQuaternion(body.quaternion).y)
    settle(body, 14)
    const up = new Vector3(0, 1, 0).applyQuaternion(body.quaternion)

    // A torus is symmetric front to back, so it may settle either face up. What
    // matters is that it ends up lying flat rather than on edge.
    expect(Math.abs(up.y)).toBeGreaterThan(0.97)
    expect(Math.abs(up.y)).toBeGreaterThan(startTilt)
  })

  it('rights a knocked-over duck, because the deeper side gains buoyancy', () => {
    // A wide hull with the head raised in front — the shape RubberDuck uses.
    // Righting comes from the waterplane, not from a low centre of mass: tip it
    // and the submerged side gains displacement while the raised side loses it.
    const spheres = []
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4
      spheres.push({
        local: new Vector3(Math.cos(a) * 0.12, 0, Math.sin(a) * 0.12),
        radius: 0.115,
      })
    }
    spheres.push({ local: new Vector3(0, 0.17, 0.14), radius: 0.075 })

    for (const axis of [new Vector3(1, 0, 0), new Vector3(0, 0, 1)]) {
      const body = new RigidBody({ mass: 1.4, spheres, angularDamping: 3 })
      body.position.set(0, 0.05, 0)
      body.quaternion.setFromAxisAngle(axis, 1.2) // knocked ~69 degrees over
      settle(body, 18)
      const up = new Vector3(0, 1, 0).applyQuaternion(body.quaternion)
      expect(up.y).toBeGreaterThan(0.95)
    }
  })

  it('keeps a very light, very buoyant body stable instead of launching it', () => {
    // A swim ring is ~2 kg of plastic displacing ~90 litres. Held on edge, its
    // deepest section is fully submerged and pushed up with fifty times the
    // body's weight. Without the added-mass correction the integrator diverges
    // within a couple of seconds; this pins that down.
    const spheres = []
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2
      spheres.push({
        local: new Vector3(Math.cos(a) * 0.55, 0, Math.sin(a) * 0.55),
        radius: 0.14,
      })
    }
    const body = new RigidBody({ mass: 2.2, spheres, angularDamping: 2.5 })
    body.position.set(0, 0.05, 0)
    body.quaternion.setFromAxisAngle(new Vector3(0, 0, 1), 1.4) // nearly on edge

    settle(body, 20)

    expect(Number.isFinite(body.position.y)).toBe(true)
    expect(Math.abs(body.position.y)).toBeLessThan(1)
    expect(body.velocity.length()).toBeLessThan(0.5)
    expect(body.angularVelocity.length()).toBeLessThan(2)
  })

  it('emits wave splats while bobbing, closing the object-to-water loop', () => {
    const body = new RigidBody({
      mass: 8,
      spheres: [{ local: new Vector3(), radius: 0.3 }],
    })
    body.position.set(0, 0.9, 0) // dropped from above the surface

    const water = stillWater()
    const flow = new FlowField()
    const splats = new SplatQueue()
    let emitted = 0
    for (let i = 0; i < 600; i++) {
      body.clearForces()
      applyBuoyancy(body, water, flow, splats, PHYSICS_DT)
      body.integrate(PHYSICS_DT)
      emitted += splats.length
      water.applySplats(splats)
      splats.clear()
      water.step(PHYSICS_DT)
    }

    expect(emitted).toBeGreaterThan(0)
    expect(water.peakAmplitude()).toBeGreaterThan(1e-4)
    expect(water.isFinite()).toBe(true)
  })

  it('carries a float along with the current', () => {
    const body = new RigidBody({ mass: 3, spheres: [{ local: new Vector3(), radius: 0.4 }] })
    body.position.set(0, -0.05, 0)

    const flow = new FlowField()
    flow.addJet({ x: -6, z: 0, dirX: 1, dirZ: 0, strength: 1.2, radius: 8 })

    settle(body, 8, flow)
    expect(body.position.x).toBeGreaterThan(0.5)
    expect(body.velocity.x).toBeGreaterThan(0.1)
  })

  it('reports wetness between fully dry and fully submerged', () => {
    const water = stillWater()
    const body = new RigidBody({ mass: 1, spheres: [{ local: new Vector3(), radius: 0.25 }] })

    body.position.set(0, 2, 0)
    body.syncDerived()
    expect(wetFraction(body, water)).toBe(0)

    body.position.set(0, -2, 0)
    body.syncDerived()
    expect(wetFraction(body, water)).toBe(1)

    body.position.set(0, 0, 0)
    body.syncDerived()
    expect(wetFraction(body, water)).toBeCloseTo(0.5, 6)
  })
})
