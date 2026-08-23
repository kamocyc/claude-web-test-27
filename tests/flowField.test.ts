import { describe, expect, it } from 'vitest'
import { FlowField, type Vec2 } from '../src/sim/FlowField'

const out: Vec2 = { x: 0, z: 0 }

describe('FlowField', () => {
  it('is still with no sources', () => {
    const flow = new FlowField()
    flow.velocityAt(1, 2, out)
    expect(out.x).toBe(0)
    expect(out.z).toBe(0)
  })

  it('normalises a jet direction that was not given as a unit vector', () => {
    const flow = new FlowField()
    const jet = flow.addJet({ x: 0, z: 0, dirX: 3, dirZ: 4, strength: 1, radius: 2 })
    expect(Math.hypot(jet.dirX, jet.dirZ)).toBeCloseTo(1, 12)
  })

  it('pushes along the jet axis and falls to half strength at its radius', () => {
    const flow = new FlowField()
    flow.addJet({ x: 0, z: 0, dirX: 1, dirZ: 0, strength: 2, radius: 3 })

    flow.velocityAt(3, 0, out)
    expect(out.x).toBeCloseTo(1, 6) // half of 2, on-axis so the cone factor is 1
    expect(out.z).toBeCloseTo(0, 12)

    flow.velocityAt(0.001, 0, out)
    expect(out.x).toBeGreaterThan(1.9)
  })

  it('weakens with distance', () => {
    const flow = new FlowField()
    flow.addJet({ x: 0, z: 0, dirX: 1, dirZ: 0, strength: 2, radius: 3 })
    let previous = Number.POSITIVE_INFINITY
    for (const d of [0.5, 1, 2, 4, 8, 16]) {
      const speed = flow.speedAt(d, 0)
      expect(speed).toBeLessThan(previous)
      previous = speed
    }
  })

  it('does not suck water backwards out of the wall it is mounted in', () => {
    const flow = new FlowField()
    flow.addJet({ x: 0, z: 0, dirX: 1, dirZ: 0, strength: 2, radius: 3 })
    const ahead = flow.speedAt(1, 0)
    const behind = flow.speedAt(-1, 0)
    expect(behind).toBeLessThan(ahead * 0.4)
  })

  it('circulates a vortex tangentially, never radially', () => {
    const flow = new FlowField()
    flow.addVortex({ x: 0, z: 0, strength: 1.5, coreRadius: 1 })

    for (const [x, z] of [
      [2, 0],
      [0, 2],
      [-1.5, 1.5],
      [0.4, -0.3],
    ] as [number, number][]) {
      flow.velocityAt(x, z, out)
      const radial = (out.x * x + out.z * z) / Math.hypot(x, z)
      expect(Math.abs(radial)).toBeLessThan(1e-12)
    }
  })

  it('spins a positive vortex counter-clockwise about +Y', () => {
    const flow = new FlowField()
    flow.addVortex({ x: 0, z: 0, strength: 1, coreRadius: 1 })
    flow.velocityAt(1, 0, out)
    // At +X the counter-clockwise tangent points towards +Z.
    expect(out.z).toBeGreaterThan(0.5)
    expect(out.x).toBeCloseTo(0, 12)
  })

  it('rotates rigidly inside the core and decays as 1/r outside it', () => {
    const flow = new FlowField()
    flow.addVortex({ x: 0, z: 0, strength: 2, coreRadius: 1 })
    expect(flow.speedAt(0.5, 0)).toBeCloseTo(1, 6) // 2 * 0.5/1
    expect(flow.speedAt(1, 0)).toBeCloseTo(2, 6) // peak at the core edge
    expect(flow.speedAt(4, 0)).toBeCloseTo(0.5, 6) // 2 * 1/4
  })

  it('superposes sources and scales them all with intensity', () => {
    const flow = new FlowField()
    flow.addJet({ x: -4, z: 0, dirX: 1, dirZ: 0, strength: 1, radius: 4 })
    flow.addVortex({ x: 2, z: 1, strength: 0.8, coreRadius: 1.2 })

    flow.velocityAt(0.5, 0.5, out)
    const full = { x: out.x, z: out.z }
    flow.intensity = 0.25
    flow.velocityAt(0.5, 0.5, out)
    expect(out.x).toBeCloseTo(full.x * 0.25, 12)
    expect(out.z).toBeCloseTo(full.z * 0.25, 12)
  })

  it('stays finite at a vortex centre', () => {
    const flow = new FlowField()
    flow.addVortex({ x: 0, z: 0, strength: 3, coreRadius: 0.5 })
    flow.velocityAt(0, 0, out)
    expect(Number.isFinite(out.x)).toBe(true)
    expect(Number.isFinite(out.z)).toBe(true)
  })
})
