import { Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import {
  GRAVITY,
  PHYSICS_DT,
  POOL,
  SLIDE,
  WATER_LEVEL,
  WAVE_DT,
  WAVE_SUBSTEPS,
} from '../src/core/config'
import { BeachBall } from '../src/entities/PoolFloat'
import { SwimRing } from '../src/entities/SwimRing'
import { Swimmer } from '../src/entities/Swimmer'
import { WaterSlide } from '../src/entities/WaterSlide'
import type { FloatingObject } from '../src/entities/FloatingObject'
import { PhysicsWorld } from '../src/physics/PhysicsWorld'
import { FlowField } from '../src/sim/FlowField'
import { WaveFieldCPU } from '../src/sim/WaveFieldCPU'
import { SplatQueue } from '../src/sim/WaveSplat'

/**
 * The slide is ridden by the physics, not by a rail.
 *
 * That is the whole design, and it is also what makes it worth testing: a rail
 * cannot lose anyone, cannot jam, and cannot invent energy, whereas a body
 * bouncing down the inside of a pipe can do all three. So these check the
 * things a rail would have made true by construction — it goes down, it comes
 * out no faster than the height it fell allows, a body longer than the pipe is
 * wide does not wedge across it, and nobody is left stranded halfway.
 */

const LONG_RUN_TIMEOUT = 120_000

function world() {
  const water = new WaveFieldCPU({ width: POOL.width, depth: POOL.depth, cols: 128, rows: 80 })
  const flow = new FlowField()
  const splats = new SplatQueue()
  const physics = new PhysicsWorld(water, flow, splats)
  const slide = physics.addFeature(new WaterSlide())
  return { water, flow, splats, physics, slide }
}

interface RideResult {
  reachedOutlet: boolean
  timeToOutlet: number
  maxSpeed: number
  /** Largest distance from the centreline seen while still inside the flume. */
  maxStray: number
  minY: number
  peak: number
  stalled: boolean
}

/** Drop a body in at the top of the flume and watch it go down. */
function ride(
  scene: ReturnType<typeof world>,
  body: FloatingObject,
  seconds = 10,
  boundingRadius = 0.25,
): RideResult {
  const start = scene.slide.curve.getPointAt(0.01)
  body.placeAt(start.x, start.z, start.y)
  scene.physics.add(body)

  const outlet = scene.slide.outlet
  const point = new Vector3()
  const result: RideResult = {
    reachedOutlet: false,
    timeToOutlet: 0,
    maxSpeed: 0,
    maxStray: 0,
    minY: Number.POSITIVE_INFINITY,
    peak: 0,
    stalled: false,
  }

  let lastProgressAt = 0
  let furthestDown = start.y
  const steps = Math.round(seconds / PHYSICS_DT)
  for (let i = 0; i < steps; i++) {
    scene.splats.clear()
    scene.physics.step(PHYSICS_DT)
    scene.water.applySplats(scene.splats)
    for (let k = 0; k < WAVE_SUBSTEPS; k++) scene.water.step(WAVE_DT)

    const position = body.body.position
    const time = (i + 1) * PHYSICS_DT
    result.maxSpeed = Math.max(result.maxSpeed, body.body.velocity.length())
    result.minY = Math.min(result.minY, position.y)
    result.peak = Math.max(result.peak, scene.water.peakAmplitude())

    if (position.y < furthestDown - 0.05) {
      furthestDown = position.y
      lastProgressAt = time
    }

    if (!result.reachedOutlet) {
      // Only meaningful while they are still in the pipe: once they are out of
      // the end, distance from the centreline is just how far they have flown.
      let nearest = Number.POSITIVE_INFINITY
      let nearestU = 0
      for (let s = 0; s <= 60; s++) {
        scene.slide.curve.getPointAt(s / 60, point)
        const distance = point.distanceTo(position)
        if (distance < nearest) {
          nearest = distance
          nearestU = s / 60
        }
      }
      if (nearestU > 0.05 && nearestU < 0.9) result.maxStray = Math.max(result.maxStray, nearest)

      if (position.distanceTo(outlet) < 0.9 && nearestU > 0.9) {
        result.reachedOutlet = true
        result.timeToOutlet = time
      }
    }
  }

  result.stalled = !result.reachedOutlet && lastProgressAt < seconds - 2
  void boundingRadius
  return result
}

describe('riding the flume', () => {
  it(
    'takes a body down under gravity alone, and no faster than the drop allows',
    () => {
      const scene = world()
      const drop = scene.slide.curve.getPointAt(0).y - scene.slide.outlet.y
      const result = ride(scene, new BeachBall())

      console.log(
        `[slide] ball reached the outlet in ${result.timeToOutlet.toFixed(2)}s at up to ` +
          `${result.maxSpeed.toFixed(2)}m/s (free fall over ${drop.toFixed(2)}m gives ` +
          `${Math.sqrt(2 * GRAVITY * drop).toFixed(2)}m/s), straying ${result.maxStray.toFixed(2)}m ` +
          `from the centreline`,
      )

      expect(result.reachedOutlet).toBe(true)
      expect(result.timeToOutlet).toBeGreaterThan(1)
      expect(result.timeToOutlet).toBeLessThan(6)

      // Nothing may come out with more energy than the height it fell through,
      // plus what the pumped water in the flume can add. A contact that pushes
      // a body out with more than it went in with fails here long before it
      // looks wrong on screen.
      expect(result.maxSpeed).toBeLessThan(Math.sqrt(2 * GRAVITY * drop) + SLIDE.flumeFlow * 0.5)
    },
    LONG_RUN_TIMEOUT,
  )

  it(
    'does not let a body through the floor of the flume',
    () => {
      const scene = world()
      const result = ride(scene, new BeachBall())
      // A beach ball is 0.24 m across the proxy sphere, so resting in the
      // bottom of the trough puts its centre this far off the centreline. A
      // contact that let it through would show a much larger number.
      expect(result.maxStray).toBeLessThan(SLIDE.flumeRadius + 0.1)
    },
    LONG_RUN_TIMEOUT,
  )

  it(
    'does not wedge a body longer than the flume is wide',
    () => {
      // The reason the bend has a three-metre radius. A swimmer is 1.7 m of
      // rigid body in a 1.2 m pipe; on a tight bend they jam across it and
      // stop, which is exactly the failure a rail-driven ride would hide.
      const scene = world()
      const swimmer = new Swimmer(0)
      swimmer.pose = 'ride'
      swimmer.throttle = 0
      const result = ride(scene, swimmer, 12)

      console.log(
        `[slide] swimmer reached the outlet in ${result.timeToOutlet.toFixed(2)}s at up to ` +
          `${result.maxSpeed.toFixed(2)}m/s, straying ${result.maxStray.toFixed(2)}m`,
      )
      expect(result.stalled).toBe(false)
      expect(result.reachedOutlet).toBe(true)
      expect(result.maxStray).toBeLessThan(SLIDE.flumeRadius + 0.1)
    },
    LONG_RUN_TIMEOUT,
  )

  it(
    'lands hard enough to throw the water about',
    () => {
      const scene = world()
      const result = ride(scene, new SwimRing(0), 12)
      console.log(`[slide] entry raised a ${result.peak.toExponential(2)}m peak`)
      expect(result.reachedOutlet).toBe(true)
      // Somebody arriving at six metres a second makes a wave you can see from
      // the far side of the pool.
      expect(result.peak).toBeGreaterThan(0.02)
    },
    LONG_RUN_TIMEOUT,
  )
})

describe('getting on and off the slide', () => {
  /**
   * Watched as eager, the way the player is. An AI swimmer only takes the slide
   * some of the time — otherwise everyone who drifted past the steps would end
   * up on them — and a test that rolled that dice would be flaky.
   */
  function swimmerAt(scene: ReturnType<typeof world>, x: number, z: number): Swimmer {
    const swimmer = new Swimmer(1)
    swimmer.placeAt(x, z, WATER_LEVEL - 0.04)
    swimmer.throttle = 0
    scene.physics.add(swimmer)
    scene.slide.watch(swimmer, true)
    return swimmer
  }

  function advance(scene: ReturnType<typeof world>, seconds: number): void {
    const steps = Math.round(seconds / PHYSICS_DT)
    for (let i = 0; i < steps; i++) {
      scene.splats.clear()
      scene.physics.step(PHYSICS_DT)
      scene.water.applySplats(scene.splats)
      for (let k = 0; k < WAVE_SUBSTEPS; k++) scene.water.step(WAVE_DT)
    }
  }

  it('picks up a swimmer who comes to the steps, and leaves everyone else alone', () => {
    const scene = world()
    const boarding = swimmerAt(scene, SLIDE.boardingX + 0.3, SLIDE.boardingZ)
    const passing = swimmerAt(scene, -SLIDE.boardingX, -SLIDE.boardingZ)

    advance(scene, 0.5)

    expect(scene.slide.isRiding(boarding)).toBe(true)
    expect(boarding.body.dynamic).toBe(false)
    expect(scene.slide.isRiding(passing)).toBe(false)
    expect(passing.body.dynamic).toBe(true)
  })

  it('takes no more riders at once than it has room for', () => {
    const scene = world()
    scene.slide.maxRiders = 2
    const crowd = [0, 1, 2, 3].map((i) => swimmerAt(scene, SLIDE.boardingX + i * 0.2, SLIDE.boardingZ))

    advance(scene, 0.5)
    expect(scene.slide.ridersOnSlide).toBe(2)
    expect(crowd.filter((s) => scene.slide.isRiding(s))).toHaveLength(2)
  })

  it(
    'never strands a rider: they go up, they come down, they are swimming again',
    () => {
      const scene = world()
      const swimmer = swimmerAt(scene, SLIDE.boardingX, SLIDE.boardingZ)
      advance(scene, 30)

      console.log(
        `[slide] after 30s: riding=${scene.slide.isRiding(swimmer)} ` +
          `completed=${scene.slide.completed} y=${swimmer.body.position.y.toFixed(2)}`,
      )

      expect(scene.slide.completed).toBe(1)
      expect(scene.slide.isRiding(swimmer)).toBe(false)
      expect(swimmer.body.dynamic).toBe(true)
      expect(swimmer.pose).toBe('swim')
      // Back in the water at a sensible depth, not sunk to the floor or left
      // standing on the deck.
      expect(swimmer.body.position.y).toBeGreaterThan(-0.4)
      expect(swimmer.body.position.y).toBeLessThan(0.3)
    },
    LONG_RUN_TIMEOUT,
  )
})
