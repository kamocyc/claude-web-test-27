import { describe, expect, it } from 'vitest'
import { WaveFieldCPU } from '../src/sim/WaveFieldCPU'
import { SplatQueue } from '../src/sim/WaveSplat'

const DT = 1 / 240

function makeField(overrides: Partial<ConstructorParameters<typeof WaveFieldCPU>[0]> = {}) {
  return new WaveFieldCPU({
    width: 16,
    depth: 10,
    cols: 128,
    rows: 80,
    speedScale: 0.6,
    damping: 0.9,
    ...overrides,
  })
}

describe('WaveFieldCPU', () => {
  it('keeps the Courant number inside the stable band', () => {
    const field = makeField()
    expect(field.maxCourant(DT)).toBeLessThanOrEqual(0.5)
  })

  it('stays finite and bounded even when driven far past its nominal speed', () => {
    // The C^2 cap is what makes this safe, so push the speed absurdly high.
    const field = makeField({ speedScale: 40 })
    for (let i = 0; i < 4000; i++) {
      if (i % 60 === 0) field.splat(0, 0, 0.4, 0.3)
      field.step(DT)
    }
    expect(field.isFinite()).toBe(true)
    expect(field.peakAmplitude()).toBeLessThan(10)
  })

  it('loses energy monotonically once the driving stops', () => {
    const field = makeField()
    field.splat(0, 0, 0.6, 0.25)
    for (let i = 0; i < 200; i++) field.step(DT)

    let previous = field.energy(DT)
    for (let block = 0; block < 20; block++) {
      for (let i = 0; i < 120; i++) field.step(DT)
      const current = field.energy(DT)
      expect(current).toBeLessThan(previous)
      previous = current
    }
  })

  it('propagates a splat outwards symmetrically', () => {
    const field = makeField()
    field.splat(0, 0, 0.3, 0.4)
    for (let i = 0; i < 240; i++) field.step(DT)

    // Along X the floor depth (and so the wave speed) is constant, so the
    // disturbance must be mirror-symmetric about the splat.
    for (const distance of [0.5, 1, 1.5, 2]) {
      const left = field.heightAt(-distance, 0)
      const right = field.heightAt(distance, 0)
      expect(Math.abs(left - right)).toBeLessThan(1e-4)
    }

    // ... and it must have actually travelled.
    expect(Math.abs(field.heightAt(1.2, 0))).toBeGreaterThan(1e-5)
  })

  it('refracts towards the shallow end, where the floor slows waves down', () => {
    // Probe along X at a fixed Z, so the depth (and hence the wave speed) is
    // constant along the path and only the end of the pool differs.
    const stepsToReach = (z: number) => {
      const field = makeField()
      field.splat(0, z, 0.3, 0.4)
      for (let i = 1; i <= 900; i++) {
        field.step(DT)
        if (Math.abs(field.heightAt(2.5, z)) > 5e-4) return i
      }
      return Number.POSITIVE_INFINITY
    }
    const deepEnd = stepsToReach(3.5)
    const shallowEnd = stepsToReach(-3.5)
    expect(deepEnd).toBeLessThan(shallowEnd)
    expect(shallowEnd).toBeLessThan(Number.POSITIVE_INFINITY)
  })

  it('reflects off the pool walls instead of absorbing the wave', () => {
    const field = makeField()
    field.splat(7.2, 0, 0.25, 0.5)
    let peakAtWall = 0
    for (let i = 0; i < 600; i++) {
      field.step(DT)
      peakAtWall = Math.max(peakAtWall, Math.abs(field.heightAt(7.95, 0)))
    }
    // A Neumann boundary doubles the amplitude at the wall rather than
    // swallowing it, so the very edge must ring.
    expect(peakAtWall).toBeGreaterThan(1e-3)
  })

  it('samples heights consistently through the splat queue', () => {
    const direct = makeField()
    const viaQueue = makeField()
    const queue = new SplatQueue()
    queue.add(1.5, -2, 0.4, 0.2)
    queue.add(-3, 1, 0.3, -0.1)

    direct.splat(1.5, -2, 0.4, 0.2)
    direct.splat(-3, 1, 0.3, -0.1)
    viaQueue.applySplats(queue)

    for (let i = 0; i < 60; i++) {
      direct.step(DT)
      viaQueue.step(DT)
    }
    expect(viaQueue.heightAt(1.5, -2)).toBeCloseTo(direct.heightAt(1.5, -2), 10)
  })

  it('reads back a flat zero field outside any disturbance', () => {
    const field = makeField()
    expect(field.heightAt(0, 0)).toBe(0)
    expect(field.verticalVelocityAt(0, 0)).toBe(0)
  })
})
