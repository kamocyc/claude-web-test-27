import { describe, expect, it } from 'vitest'
import {
  ISLAND,
  ISLAND_TOP,
  PHYSICS_DT,
  POOL,
  RIVER,
  RIVER_BANK,
  WAVE_DT,
  WAVE_SUBSTEPS,
} from '../src/core/config'
import { AirMattress, BeachBall } from '../src/entities/PoolFloat'
import { SwimRing } from '../src/entities/SwimRing'
import { PhysicsWorld } from '../src/physics/PhysicsWorld'
import { RampObstacle } from '../src/physics/BoxObstacle'
import { RIVER_RAMP } from '../src/core/world'
import { StadiumBank, StadiumObstacle } from '../src/physics/StadiumObstacle'
import { stadiumDistance, type Vec2 } from '../src/core/shapes'
import { FlowField } from '../src/sim/FlowField'
import { WaveFieldCPU } from '../src/sim/WaveFieldCPU'
import { SplatQueue } from '../src/sim/WaveSplat'

/**
 * The lazy river: a closed circuit of moving water round the island.
 *
 * Two things have to hold for this to be a river rather than a stirred pool.
 * The field has to be tangential and closed, so that following it takes you
 * back where you started; and something floating on it has to actually go
 * round, which is a different claim — it involves drag, the banks, and the
 * body's own momentum through the bends, and it is the one that failed first.
 * The first version had the current fade out before the walls, and every float
 * coasted out of the stream at the ends and parked in the dead water for good.
 */

const LONG_RUN_TIMEOUT = 120_000
const out: Vec2 = { x: 0, z: 0 }
const outward: Vec2 = { x: 0, z: 0 }

function river(): FlowField {
  const flow = new FlowField()
  flow.addChannel({
    x: ISLAND.x,
    z: ISLAND.z,
    halfLength: ISLAND.halfLength,
    radius: ISLAND.radius,
    innerRadius: RIVER.innerRadius,
    outerRadius: RIVER.outerRadius,
    strength: RIVER.speed,
  })
  return flow
}

/** Distance from the island's axis, which is what the channel is defined by. */
function ringDistance(x: number, z: number): number {
  return stadiumDistance(ISLAND, x, z, outward)
}

describe('the river as a flow field', () => {
  it('runs tangentially to the island everywhere, never into it or away from it', () => {
    const flow = river()
    for (const [x, z] of [
      [0, 2.5],
      [0, -3],
      [5, 0],
      [-4.5, 1.2],
      [3.4, 3.4],
      [-2, -2.6],
    ] as [number, number][]) {
      const distance = ringDistance(x, z)
      flow.velocityAt(x, z, out)
      const radial = out.x * outward.x + out.z * outward.z
      expect(Math.hypot(out.x, out.z)).toBeGreaterThan(0.05)
      expect(Math.abs(radial)).toBeLessThan(1e-12)
      expect(distance).toBeGreaterThan(RIVER.innerRadius)
    }
  })

  it('is still on the island and beyond the far bank', () => {
    const flow = river()
    for (const [x, z] of [
      [0, 0],
      [2, 0.5],
      [-2.5, 1],
    ] as [number, number][]) {
      expect(flow.speedAt(x, z)).toBe(0)
    }
    // Outside the bank there is no water at all, only the filled-in corner.
    expect(flow.speedAt(0, RIVER.outerRadius + 0.2)).toBe(0)
    expect(flow.speedAt(ISLAND.halfLength + RIVER.outerRadius + 0.3, 0)).toBe(0)
  })

  it('keeps moving right up against the outer bank', () => {
    // The failure this pins: a symmetric profile has the current die at both
    // walls, and since a float carried through a bend ends up pressed against
    // the outer one, it ends up in still water and stops there.
    const flow = river()
    const atBank = flow.speedAt(0, RIVER.outerRadius - 0.35)
    expect(atBank).toBeGreaterThan(RIVER.speed * 0.3)
  })

  it('closes on itself: following the flow comes back to where it started', () => {
    const flow = river()
    const start = { x: 0, z: 3.1 }
    let x = start.x
    let z = start.z
    let angle = Math.atan2(z - ISLAND.z, x - ISLAND.x)
    let turned = 0
    let travelled = 0

    const step = 0.02
    for (let i = 0; i < 4000; i++) {
      flow.velocityAt(x, z, out)
      const speed = Math.hypot(out.x, out.z)
      expect(speed).toBeGreaterThan(0)
      x += (out.x / speed) * step
      z += (out.z / speed) * step
      travelled += step

      const next = Math.atan2(z - ISLAND.z, x - ISLAND.x)
      let delta = next - angle
      if (delta > Math.PI) delta -= 2 * Math.PI
      if (delta < -Math.PI) delta += 2 * Math.PI
      turned += delta
      angle = next
      if (turned >= 2 * Math.PI) break
    }

    expect(turned).toBeGreaterThanOrEqual(2 * Math.PI)
    expect(Math.hypot(x - start.x, z - start.z)).toBeLessThan(0.25)
    // A lap of the channel, not a tight orbit of one end.
    expect(travelled).toBeGreaterThan(15)
    expect(travelled).toBeLessThan(45)
  })

  it('is divergence-free, so it cannot pile water up anywhere', () => {
    // This is why the current can be as strong as it likes without moving the
    // water level: it transports, it does not source.
    const flow = river()
    const h = 0.005
    const a: Vec2 = { x: 0, z: 0 }
    const b: Vec2 = { x: 0, z: 0 }
    for (const [x, z] of [
      [0, 2.5],
      [1.5, -3.2],
      [4.6, 1.1],
      [-3.2, 2.4],
      [-5.5, -0.4],
    ] as [number, number][]) {
      flow.velocityAt(x + h, z, a)
      flow.velocityAt(x - h, z, b)
      const dvxdx = (a.x - b.x) / (2 * h)
      flow.velocityAt(x, z + h, a)
      flow.velocityAt(x, z - h, b)
      const dvzdz = (a.z - b.z) / (2 * h)
      expect(Math.abs(dvxdx + dvzdz)).toBeLessThan(1e-5)
    }
  })
})

describe('the river as somewhere to float', () => {
  function pool() {
    const water = new WaveFieldCPU({ width: POOL.width, depth: POOL.depth, cols: 128, rows: 80 })
    const flow = river()
    const splats = new SplatQueue()
    const physics = new PhysicsWorld(water, flow, splats)
    physics.addFeature(new StadiumObstacle(ISLAND, ISLAND_TOP))
    physics.addFeature(new StadiumBank(RIVER_BANK, ISLAND_TOP))
    // The entry ramp sticks out into the circuit, so it belongs in this test:
    // anything a float can be pinned against is exactly what it is checking.
    physics.addFeature(new RampObstacle(RIVER_RAMP))
    return { water, flow, splats, physics }
  }

  /** Laps completed about the island, signed, plus how the ride went. */
  function drift(seconds: number, bodies: { body: { position: { x: number; z: number } } }[], world: ReturnType<typeof pool>) {
    const angles = bodies.map((b) => Math.atan2(b.body.position.z, b.body.position.x))
    const laps = bodies.map(() => 0)
    let closest = Number.POSITIVE_INFINITY
    let furthest = 0

    const steps = Math.round(seconds / PHYSICS_DT)
    for (let i = 0; i < steps; i++) {
      world.splats.clear()
      world.physics.step(PHYSICS_DT)
      world.water.applySplats(world.splats)
      for (let k = 0; k < WAVE_SUBSTEPS; k++) world.water.step(WAVE_DT)

      for (let b = 0; b < bodies.length; b++) {
        const position = bodies[b]!.body.position
        const angle = Math.atan2(position.z, position.x)
        let delta = angle - angles[b]!
        if (delta > Math.PI) delta -= 2 * Math.PI
        if (delta < -Math.PI) delta += 2 * Math.PI
        laps[b] = laps[b]! + delta / (2 * Math.PI)
        angles[b] = angle

        const distance = ringDistance(position.x, position.z)
        closest = Math.min(closest, distance)
        furthest = Math.max(furthest, distance)
      }
    }
    return { laps, closest, furthest }
  }

  it(
    'carries a float all the way round the island',
    () => {
      const world = pool()
      const ring = new SwimRing(0)
      ring.placeAt(0, 3.1, 0.05)
      world.physics.add(ring)
      const ball = new BeachBall()
      ball.placeAt(0, -2.4, 0.05)
      world.physics.add(ball)
      const mattress = new AirMattress()
      mattress.placeAt(4.6, 0, 0.05)
      world.physics.add(mattress)

      const { laps, closest, furthest } = drift(110, [ring, ball, mattress], world)
      console.log(
        `[river] laps after 110s: ${laps.map((l) => l.toFixed(2)).join(', ')} ` +
          `(channel is ${RIVER.innerRadius}..${RIVER.outerRadius}m from the axis, ` +
          `they stayed within ${closest.toFixed(2)}..${furthest.toFixed(2)})`,
      )

      // A lap is about 30 m of centreline at 0.9 m/s peak, and a float sits
      // slower than the peak, so half of the run is margin: anything really
      // being carried gets round, anything merely nudged does not.
      for (const lap of laps) expect(lap).toBeGreaterThan(1)
      // Positive: the current runs counter-clockwise about +Y, and all of them
      // go the same way.
      expect(closest).toBeGreaterThan(ISLAND.radius - 0.35)
      expect(furthest).toBeLessThan(RIVER.outerRadius + 0.35)
    },
    LONG_RUN_TIMEOUT,
  )

  it(
    'never lets anything end up inside the island or out in the filled corners',
    () => {
      const world = pool()
      // Aimed straight at the island, hard enough to bury itself in it.
      const ball = new BeachBall()
      ball.placeAt(0, 2.2, 0.05)
      ball.body.velocity.set(0, 0, -4)
      world.physics.add(ball)

      const { closest, furthest } = drift(25, [ball], world)
      expect(closest).toBeGreaterThan(ISLAND.radius - 0.3)
      expect(furthest).toBeLessThan(RIVER.outerRadius + 0.3)
    },
    LONG_RUN_TIMEOUT,
  )
})
