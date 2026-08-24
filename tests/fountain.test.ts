import { describe, expect, it } from 'vitest'
import { PHYSICS_DT, POOL, WATER_LEVEL, WAVE_DT, WAVE_SUBSTEPS } from '../src/core/config'
import { Fountain } from '../src/entities/Fountain'
import type { FloatingObject } from '../src/entities/FloatingObject'
import { BeachBall } from '../src/entities/PoolFloat'
import { RubberDuck } from '../src/entities/RubberDuck'
import { Swimmer } from '../src/entities/Swimmer'
import { PhysicsWorld } from '../src/physics/PhysicsWorld'
import { SprayParticles } from '../src/render/SprayParticles'
import { FlowField } from '../src/sim/FlowField'
import { WaveFieldCPU } from '../src/sim/WaveFieldCPU'
import { SplatQueue } from '../src/sim/WaveSplat'

/**
 * A fountain, as a force rather than an effect.
 *
 * The jet is its own momentum flux: rho * A * v kilograms a second leaving the
 * nozzle at v metres a second, and a body takes the share of that it blocks.
 * Everything interesting follows from the arithmetic — the same jet that throws
 * a beach ball over the deck is nothing at all under a swimmer — so these tests
 * are mostly about the force being right *per unit mass*, which is the part a
 * hand-tuned "make it look bouncy" number would get wrong.
 *
 * The ripples are checked here too, because nothing in the fountain writes
 * them: they exist only because real droplets land and every landing droplet
 * puts a volume-neutral impulse into the height field.
 */

const LONG_RUN_TIMEOUT = 120_000

function scene(options: { levelDecay?: number } = {}) {
  const water = new WaveFieldCPU({
    width: POOL.width,
    depth: POOL.depth,
    cols: 128,
    rows: 80,
    ...(options.levelDecay === undefined ? {} : { levelDecay: options.levelDecay }),
  })
  const flow = new FlowField()
  const splats = new SplatQueue()
  const physics = new PhysicsWorld(water, flow, splats)
  const spray = new SprayParticles({ capacity: 4000 })
  physics.splash = spray
  const fountain = physics.addFeature(new Fountain({ x: 0, z: 0 }))
  return { water, flow, splats, physics, spray, fountain }
}

function advance(world: ReturnType<typeof scene>, seconds: number): void {
  const steps = Math.round(seconds / PHYSICS_DT)
  for (let i = 0; i < steps; i++) {
    world.splats.clear()
    world.physics.step(PHYSICS_DT)
    world.spray.update(PHYSICS_DT, world.water, world.flow, world.splats)
    world.water.applySplats(world.splats)
    for (let k = 0; k < WAVE_SUBSTEPS; k++) world.water.step(WAVE_DT)
  }
}

/** Run a body over the nozzle and report how high it got and how fast it spun. */
function overTheJet(
  body: FloatingObject,
  x: number,
  z: number,
  seconds: number,
  enabled = true,
): { maxY: number; maxSpin: number; peak: number } {
  const world = scene()
  world.fountain.enabled = enabled
  body.placeAt(x, z, WATER_LEVEL + 0.05)
  world.physics.add(body)

  let maxY = -Infinity
  let maxSpin = 0
  let peak = 0
  const steps = Math.round(seconds / PHYSICS_DT)
  for (let i = 0; i < steps; i++) {
    world.splats.clear()
    world.physics.step(PHYSICS_DT)
    world.spray.update(PHYSICS_DT, world.water, world.flow, world.splats)
    world.water.applySplats(world.splats)
    for (let k = 0; k < WAVE_SUBSTEPS; k++) world.water.step(WAVE_DT)
    maxY = Math.max(maxY, body.body.position.y)
    maxSpin = Math.max(maxSpin, body.body.angularVelocity.length())
    peak = Math.max(peak, world.water.peakAmplitude())
  }
  return { maxY, maxSpin, peak }
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

describe('what the jet does to things floating on it', () => {
  it('is a plausible fountain rather than a number that felt right', () => {
    const fountain = new Fountain({ x: 0, z: 0 })
    // A 22 mm bore at 7 m/s: about two and a half litres a second, two and a
    // half metres of column, twenty-odd newtons of thrust.
    expect(fountain.massFlow).toBeGreaterThan(1.5)
    expect(fountain.massFlow).toBeLessThan(4)
    expect(fountain.apex).toBeGreaterThan(2)
    expect(fountain.apex).toBeLessThan(3.5)
    expect(fountain.speedAt(fountain.apex)).toBe(0)
    expect(fountain.radiusAt(2)).toBeGreaterThan(fountain.radiusAt(0))
  })

  it(
    'throws a beach ball clear of the water',
    () => {
      const lifted = overTheJet(new BeachBall(), 0, 0, 6)
      const floating = overTheJet(new BeachBall(), 0, 0, 6, false)
      console.log(
        `[fountain] beach ball reached ${lifted.maxY.toFixed(2)}m with the jet on, ` +
          `${floating.maxY.toFixed(2)}m with it off`,
      )
      // A beach ball dropped in bounces once on its way to floating, hence a
      // control number rather than zero.
      expect(floating.maxY).toBeLessThan(0.5)
      expect(lifted.maxY).toBeGreaterThan(1.5)
      expect(lifted.maxY).toBeGreaterThan(floating.maxY * 3)
    },
    LONG_RUN_TIMEOUT,
  )

  it(
    'barely moves a swimmer, because a swimmer is three hundred times the mass',
    () => {
      // The same jet, the same code path, one number different. If the thrust
      // were tuned to look good under a float it would be launching people.
      const swimmer = new Swimmer(0)
      swimmer.throttle = 0
      const hit = overTheJet(swimmer, 0, 0, 6)
      console.log(`[fountain] swimmer rose to ${hit.maxY.toFixed(3)}m`)
      expect(hit.maxY).toBeLessThan(0.12)
    },
    LONG_RUN_TIMEOUT,
  )

  it(
    'spins something it catches off-centre',
    () => {
      const duck = new RubberDuck()
      const struck = overTheJet(duck, 0.06, 0, 5)
      console.log(`[fountain] duck spun at up to ${struck.maxSpin.toFixed(2)}rad/s`)
      expect(struck.maxSpin).toBeGreaterThan(1)
    },
    LONG_RUN_TIMEOUT,
  )
})

describe('what the jet does to the water', () => {
  it(
    'rings the surface with waves, purely by way of the water it throws',
    () => {
      const world = scene()
      advance(world, 6)
      const running = {
        peak: world.water.peakAmplitude(),
        energy: world.water.energy(WAVE_DT),
        aloft: world.spray.countAbove(0.6),
      }
      console.log(
        `[fountain] peak=${running.peak.toExponential(2)}m ` +
          `energy=${running.energy.toFixed(2)} aloft=${running.aloft}`,
      )

      expect(running.aloft).toBeGreaterThan(50)
      expect(running.peak).toBeGreaterThan(5e-3)
      expect(running.energy).toBeGreaterThan(1)

      // And the other half: switched off, the same pool is glass.
      const still = scene()
      still.fountain.enabled = false
      advance(still, 6)
      expect(still.water.peakAmplitude()).toBeLessThan(1e-6)
    },
    LONG_RUN_TIMEOUT,
  )

  it(
    'does not fill the pool up, however long it runs',
    () => {
      // With the level decay switched off there is nothing to absorb a bias, so
      // this pins the sources themselves: every droplet that lands puts in a
      // crater and an equal ring, and the water it left with was never taken
      // out of the field in the first place.
      const world = scene({ levelDecay: 0 })
      advance(world, 20)
      const early = meanLevel(world.water)
      advance(world, 60)
      const late = meanLevel(world.water)

      console.log(
        `[fountain] mean level ${(early * 1000).toFixed(2)}mm -> ${(late * 1000).toFixed(2)}mm ` +
          `over a minute with no level decay`,
      )
      expect(world.water.isFinite()).toBe(true)
      expect(Math.abs(late)).toBeLessThan(0.01)
      expect(Math.abs(late - early)).toBeLessThan(0.005)
    },
    LONG_RUN_TIMEOUT,
  )

  it(
    'stops throwing water past whatever is standing in the column',
    () => {
      const world = scene()
      const ball = new BeachBall()
      ball.placeAt(0, 0, 0.6)
      // Held there, so the column has something to break against for the whole
      // run rather than punting it away in the first tenth of a second.
      ball.body.dynamic = false
      world.physics.add(ball)
      advance(world, 3)

      const aboveTheBall = world.spray.countAbove(1.2)
      const belowIt = world.spray.countAbove(0.2) - aboveTheBall
      console.log(`[fountain] droplets above the obstruction=${aboveTheBall}, below it=${belowIt}`)
      expect(belowIt).toBeGreaterThan(20)
      expect(aboveTheBall).toBeLessThan(belowIt * 0.25)
    },
    LONG_RUN_TIMEOUT,
  )
})
