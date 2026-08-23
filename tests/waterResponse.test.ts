import { Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { PHYSICS_DT, POOL, WAVE_DT, WAVE_SUBSTEPS } from '../src/core/config'
import { BeachBall } from '../src/entities/PoolFloat'
import { Swimmer } from '../src/entities/Swimmer'
import { PhysicsWorld } from '../src/physics/PhysicsWorld'
import { FlowField } from '../src/sim/FlowField'
import { WaveFieldCPU } from '../src/sim/WaveFieldCPU'
import { SplatQueue } from '../src/sim/WaveSplat'

/**
 * The water has to *respond*, not merely stay bounded.
 *
 * Every other suite here checks that the field cannot blow up or drift. None of
 * them noticed when the buoyancy wake term turned into a damper strong enough
 * to iron the pool flat while five people swam through it — 41 tests and a
 * 13-check smoke run all stayed green. These are the other half of that pair:
 * they fail when the simulation goes quiet.
 */

const LONG_RUN_TIMEOUT = 120_000

interface Harness {
  water: WaveFieldCPU
  flow: FlowField
  splats: SplatQueue
  physics: PhysicsWorld
  advance(seconds: number): void
  /** Advance while tracking the largest peak amplitude seen along the way. */
  advanceTrackingPeak(seconds: number): number
}

/** A still pool with no current, so only the bodies disturb the water. */
function harness(): Harness {
  const water = new WaveFieldCPU({ width: POOL.width, depth: POOL.depth, cols: 128, rows: 80 })
  const flow = new FlowField()
  const splats = new SplatQueue()
  const physics = new PhysicsWorld(water, flow, splats)

  return {
    water,
    flow,
    splats,
    physics,
    advance(seconds: number) {
      this.advanceTrackingPeak(seconds)
    },
    advanceTrackingPeak(seconds: number) {
      const steps = Math.round(seconds / PHYSICS_DT)
      let peak = 0
      for (let i = 0; i < steps; i++) {
        splats.clear()
        physics.step(PHYSICS_DT)
        water.applySplats(splats)
        for (let k = 0; k < WAVE_SUBSTEPS; k++) water.step(WAVE_DT)
        // Sampling only at the end would land on an arbitrary point of the
        // stroke cycle; the crater a hand makes has spread into a low ring
        // within a second.
        if (i % 12 === 0) peak = Math.max(peak, water.peakAmplitude())
      }
      return peak
    },
  }
}

function swimmerAt(h: Harness, x: number, z: number, headingX: number, headingZ: number): Swimmer {
  const swimmer = new Swimmer(0)
  swimmer.placeAt(x, z, -0.04)
  swimmer.faceDirection(headingX, headingZ)
  swimmer.throttle = 1
  h.physics.add(swimmer)
  return swimmer
}

/** Largest |height| found along a line of samples. */
function peakAlong(water: WaveFieldCPU, from: Vector3, to: Vector3, samples = 40): number {
  let peak = 0
  for (let i = 0; i <= samples; i++) {
    const t = i / samples
    const x = from.x + (to.x - from.x) * t
    const z = from.z + (to.z - from.z) * t
    peak = Math.max(peak, Math.abs(water.heightAt(x, z)))
  }
  return peak
}

describe('the water responds to what moves through it', () => {
  it(
    'is visibly stirred by someone swimming',
    () => {
      const h = harness()
      const swimmer = swimmerAt(h, -7, 0, 1, 0)
      h.advance(2)
      const peak = h.advanceTrackingPeak(6)

      // Diagnostics, so a failure says how far off it is rather than just that
      // it is off.
      console.log(
        `[stirred] speed=${swimmer.speed.toFixed(2)}m/s x=${swimmer.body.position.x.toFixed(2)} ` +
          `peak=${peak.toExponential(2)}m energy=${h.water.energy(WAVE_DT).toExponential(2)}`,
      )

      // Energy is the assertion that does the work. Peak alone is a weak
      // discriminator: even the collapsed version briefly showed a fresh
      // crater under the hand before erasing it, so it scores ~2e-2 m here
      // against this version's ~8e-2 m. Energy integrates over the whole
      // field, so a disturbance that is wiped out immediately barely counts —
      // 0.13 for the collapsed version against about 6 for this one.
      expect(peak).toBeGreaterThan(8e-3)
      expect(h.water.energy(WAVE_DT)).toBeGreaterThan(2)
    },
    LONG_RUN_TIMEOUT,
  )

  it(
    'leaves a wake behind the swimmer, not just a dimple under them',
    () => {
      const h = harness()
      const swimmer = swimmerAt(h, -7, 0, 1, 0)
      h.advance(8)

      const behind = swimmer.body.position.x - 3
      const wake = peakAlong(
        h.water,
        new Vector3(behind - 1.5, 0, -0.8),
        new Vector3(behind - 1.5, 0, 0.8),
      )
      console.log(
        `[wake] swimmer x=${swimmer.body.position.x.toFixed(2)} ` +
          `wake at x=${(behind - 1.5).toFixed(2)} peak=${wake.toExponential(2)}m`,
      )

      // Water they passed several seconds ago must still be moving. Measures
      // about 2e-3 m here; the collapsed version managed 4e-4.
      expect(wake).toBeGreaterThan(1.1e-3)
    },
    LONG_RUN_TIMEOUT,
  )

  it(
    'carries a ripple across the pool instead of killing it on the spot',
    () => {
      const h = harness()
      // One sharp disturbance in otherwise still water.
      h.water.splat(-4, 0, 0.25, 0.03)

      // Shallow-water speed at mid-pool is ~2.6 m/s, so 3 m takes a bit over a
      // second. Track the largest amplitude that ever reaches the probe.
      let arrived = 0
      const steps = Math.round(3 / PHYSICS_DT)
      for (let i = 0; i < steps; i++) {
        for (let k = 0; k < WAVE_SUBSTEPS; k++) h.water.step(WAVE_DT)
        arrived = Math.max(arrived, Math.abs(h.water.heightAt(-1, 0)))
      }
      console.log(`[propagate] peak 3m away = ${arrived.toExponential(2)}m of a 0.03m splat`)

      // It will have spread and damped, but it must actually get there.
      expect(arrived).toBeGreaterThan(1.5e-3)
    },
    LONG_RUN_TIMEOUT,
  )

  it(
    'makes a real wave when something lands in it',
    () => {
      const h = harness()
      const ball = new BeachBall()
      ball.placeAt(0, 0, 1.2) // dropped from 1.2 m up
      h.physics.add(ball)

      h.advance(2.5)
      console.log(`[impact] peak=${h.water.peakAmplitude().toExponential(2)}m`)

      expect(h.water.peakAmplitude()).toBeGreaterThan(3e-3)
    },
    LONG_RUN_TIMEOUT,
  )

  it(
    'stays flat when there is nothing in it',
    () => {
      // The other side of the coin: quiet water must stay quiet, so none of the
      // thresholds above can be met by a field that simply rings on its own.
      const h = harness()
      h.advance(20)
      expect(h.water.peakAmplitude()).toBeLessThan(1e-6)
    },
    LONG_RUN_TIMEOUT,
  )

  it(
    'settles again once the swimmer stops',
    () => {
      const h = harness()
      const swimmer = swimmerAt(h, -3, 0, 1, 0)
      h.advance(8)
      const whileSwimming = h.water.peakAmplitude()

      swimmer.throttle = 0
      h.advance(12)
      const afterResting = h.water.peakAmplitude()
      console.log(
        `[settle] swimming=${whileSwimming.toExponential(2)}m ` +
          `resting=${afterResting.toExponential(2)}m`,
      )

      // Damping must be low enough for waves to live, but not so low that the
      // pool never calms down.
      expect(afterResting).toBeLessThan(whileSwimming * 0.5)
    },
    LONG_RUN_TIMEOUT,
  )
})
