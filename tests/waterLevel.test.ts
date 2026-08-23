import { describe, expect, it } from 'vitest'
import { PHYSICS_DT, POOL, WAVE_DT, WAVE_SUBSTEPS } from '../src/core/config'
import type { FloatingObject } from '../src/entities/FloatingObject'
import { AirMattress, BeachBall } from '../src/entities/PoolFloat'
import { RubberDuck } from '../src/entities/RubberDuck'
import { SwimRing } from '../src/entities/SwimRing'
import { Swimmer } from '../src/entities/Swimmer'
import { PhysicsWorld } from '../src/physics/PhysicsWorld'
import { FlowField } from '../src/sim/FlowField'
import { WaveFieldCPU } from '../src/sim/WaveFieldCPU'
import { SplatQueue } from '../src/sim/WaveSplat'

/**
 * A busy pool, run headlessly for long enough that a slow leak would show.
 *
 * This is the regression guard for the water inflating and floating away. The
 * fault had two halves. The splat sources were not volume-neutral — the
 * buoyancy wake carried the wrong sign, so a rising surface emitted a splat
 * that raised it further, the bow wave was unsigned, and every splash was a
 * one-sided dent. And the level decay that was supposed to absorb the residue
 * did not run on the GPU at all, because at half-float precision a multiply by
 * 1 - 2.1e-4 is less than half an ULP and rounds straight back.
 */
function buildPool(levelDecay?: number) {
  const water = new WaveFieldCPU({
    width: POOL.width,
    depth: POOL.depth,
    cols: 128,
    rows: 80,
    ...(levelDecay === undefined ? {} : { levelDecay }),
  })
  const flow = new FlowField()
  flow.addJet({ x: -8.15, z: -2.6, dirX: 1, dirZ: 0.22, strength: 0.72, radius: 4.5 })
  flow.addJet({ x: 8.15, z: 2.6, dirX: -1, dirZ: -0.22, strength: 0.72, radius: 4.5 })
  flow.addVortex({ x: -3.4, z: 2.2, strength: 0.34, coreRadius: 1.9 })
  flow.addVortex({ x: 3.4, z: -2.2, strength: -0.34, coreRadius: 1.9 })

  const splats = new SplatQueue()
  const physics = new PhysicsWorld(water, flow, splats)

  // Deterministic placement, so a failure is reproducible.
  let seed = 12345
  const random = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)

  for (let i = 0; i < 5; i++) {
    const swimmer = new Swimmer(i)
    swimmer.placeAt((random() * 2 - 1) * 6, (random() * 2 - 1) * 3, -0.04)
    swimmer.throttle = 0.85
    swimmer.desiredHeading = random() * Math.PI * 2
    physics.add(swimmer)
  }

  // The same set the app spawns, so the test exercises the load the bug
  // actually showed up under.
  const floats: [FloatingObject, number, number][] = [
    [new SwimRing(0), -5.4, -2.2],
    [new SwimRing(1), -4.1, 1.9],
    [new SwimRing(2), 5.9, 3.1],
    [new RubberDuck(), 2.4, -3.2],
    [new RubberDuck(), -1.6, 3.4],
    [new AirMattress('#4fd1c5'), 4.6, -0.6],
    [new AirMattress('#f7b267'), -6.4, 3.4],
    [new BeachBall(), 1.2, 1.1],
    [new BeachBall(), 6.6, -3.4],
  ]
  for (const [object, x, z] of floats) {
    object.placeAt(x, z, 0.08)
    physics.add(object)
  }

  return { water, flow, splats, physics }
}

function meanLevel(water: WaveFieldCPU): number {
  let sum = 0
  let count = 0
  for (let x = -7.5; x <= 7.5; x += 0.5) {
    for (let z = -4.5; z <= 4.5; z += 0.5) {
      sum += water.heightAt(x, z)
      count++
    }
  }
  return sum / count
}

function run(seconds: number, levelDecay?: number) {
  const { water, splats, physics } = buildPool(levelDecay)
  const steps = Math.round(seconds / PHYSICS_DT)
  const samples: number[] = []
  const sampleEvery = Math.round(10 / PHYSICS_DT)

  for (let i = 0; i <= steps; i++) {
    if (i > 0 && i % sampleEvery === 0) samples.push(meanLevel(water))
    splats.clear()
    physics.step(PHYSICS_DT)
    water.applySplats(splats)
    for (let k = 0; k < WAVE_SUBSTEPS; k++) water.step(WAVE_DT)
  }
  return { water, samples }
}

/** These simulate minutes of pool time; the default per-test budget is 5s. */
const LONG_RUN_TIMEOUT = 120_000

describe('water level over a long session', () => {
  it('does not drift away as bodies churn the pool', () => {
    const { water, samples } = run(90)

    expect(water.isFinite()).toBe(true)
    // A pool full of people barely moves its mean level. Anything approaching
    // the coping height means volume is being manufactured.
    for (const level of samples) {
      expect(Math.abs(level)).toBeLessThan(0.05)
    }
    // And it must not be climbing: the last third should look like the first.
    const third = Math.floor(samples.length / 3)
    const early = samples.slice(0, third).reduce((a, b) => a + b, 0) / third
    const late = samples.slice(-third).reduce((a, b) => a + b, 0) / third
    expect(Math.abs(late - early)).toBeLessThan(0.01)

    // Waves stay at pool scale rather than growing without bound.
    expect(water.peakAmplitude()).toBeLessThan(0.25)
  }, LONG_RUN_TIMEOUT)

  it('holds its volume even with the level decay switched off', () => {
    // The decay is a safety net, not the mechanism. This pins the sources
    // themselves: over two and a half minutes of hard swimming the splats must
    // very nearly cancel, with no help from the decay at all.
    //
    // This is the condition the GPU was silently running under, and the shape
    // the bug took: on the original code the mean climbed past +28 mm here and
    // kept going, which on screen is the pool visibly swelling up.
    const { water, samples } = run(150, 0)

    expect(water.isFinite()).toBe(true)
    expect(Math.abs(samples[samples.length - 1]!)).toBeLessThan(0.015)
    expect(water.peakAmplitude()).toBeLessThan(0.1)

    // And it must not be walking in one direction, which is what a residual
    // volume source looks like before it gets big enough to notice.
    const third = Math.floor(samples.length / 3)
    const early = samples.slice(0, third).reduce((a, b) => a + b, 0) / third
    const late = samples.slice(-third).reduce((a, b) => a + b, 0) / third
    expect(Math.abs(late - early)).toBeLessThan(0.01)
  }, LONG_RUN_TIMEOUT)

  it('leaves the surface at rest once everything settles', () => {
    const { water, splats, physics } = buildPool()
    // Nobody swimming: only the floats and the current disturb the water.
    for (const actor of physics.actors) {
      if ('throttle' in actor) (actor as { throttle: number }).throttle = 0
    }
    for (let i = 0; i < Math.round(60 / PHYSICS_DT); i++) {
      splats.clear()
      physics.step(PHYSICS_DT)
      water.applySplats(splats)
      for (let k = 0; k < WAVE_SUBSTEPS; k++) water.step(WAVE_DT)
    }
    expect(water.peakAmplitude()).toBeLessThan(0.05)
    expect(Math.abs(meanLevel(water))).toBeLessThan(0.03)
  }, LONG_RUN_TIMEOUT)
})
