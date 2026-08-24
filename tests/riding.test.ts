import { describe, expect, it } from 'vitest'
import { PHYSICS_DT, WAVE_DT, WAVE_SUBSTEPS } from '../src/core/config'
import { CALM_POOL, DOMAIN, wetDepthAt } from '../src/core/world'
import { FloatRider } from '../src/entities/FloatRider'
import { AirMattress } from '../src/entities/PoolFloat'
import { RubberDuck } from '../src/entities/RubberDuck'
import { SwimRing } from '../src/entities/SwimRing'
import { Swimmer } from '../src/entities/Swimmer'
import { PhysicsWorld } from '../src/physics/PhysicsWorld'
import { FlowField } from '../src/sim/FlowField'
import { WaveFieldCPU } from '../src/sim/WaveFieldCPU'
import { SplatQueue } from '../src/sim/WaveSplat'

/**
 * Riding a float, and what the float makes of it.
 *
 * The rider is held on by a spring, not a constraint, and the spring is
 * one-sided: a seat can push you up and it cannot pull you down. That one
 * detail is what closes the loop between three separate mechanisms — the seat
 * lifts the rider until their chest is out of the water, the buoyancy they lose
 * by being lifted is what they then weigh on the ring, and that weight is the
 * load the tube squashes under. Nobody wrote down how heavy a rider is.
 */

const LONG_RUN_TIMEOUT = 120_000
const MID_Z = (CALM_POOL.minZ + CALM_POOL.maxZ) / 2

function scene() {
  const water = new WaveFieldCPU({
    width: DOMAIN.width,
    depth: DOMAIN.depth,
    centerX: DOMAIN.centerX,
    centerZ: DOMAIN.centerZ,
    cols: 128,
    rows: Math.round((128 * DOMAIN.depth) / DOMAIN.width),
    depthAt: wetDepthAt,
  })
  const flow = new FlowField()
  const splats = new SplatQueue()
  const physics = new PhysicsWorld(water, flow, splats)
  const rider = physics.addFeature(new FloatRider())
  return { water, flow, splats, physics, rider }
}

function advance(world: ReturnType<typeof scene>, seconds: number): void {
  const steps = Math.round(seconds / PHYSICS_DT)
  for (let i = 0; i < steps; i++) {
    world.splats.clear()
    world.physics.step(PHYSICS_DT)
    world.water.applySplats(world.splats)
    for (let k = 0; k < WAVE_SUBSTEPS; k++) world.water.step(WAVE_DT)
  }
}

function ringAt(world: ReturnType<typeof scene>, x: number, z: number): SwimRing {
  const ring = new SwimRing(0)
  ring.placeAt(x, z, 0.05)
  world.physics.add(ring)
  world.rider.add(ring)
  return ring
}

function swimmerAt(world: ReturnType<typeof scene>, x: number, z: number, eager = true): Swimmer {
  const swimmer = new Swimmer(0)
  swimmer.placeAt(x, z, 0.05)
  world.physics.add(swimmer)
  world.rider.watch(swimmer, eager)
  return swimmer
}

describe('getting on', () => {
  it('picks up a swimmer who drifts into a float, and leaves one who does not', () => {
    const world = scene()
    ringAt(world, 0, MID_Z)
    const near = swimmerAt(world, 0.2, MID_Z)
    const far = swimmerAt(world, 4, MID_Z)
    advance(world, 1.5)

    expect(world.rider.isRiding(near)).toBe(true)
    expect(world.rider.isRiding(far)).toBe(false)
    expect(near.pose).toBe('sit')
  })

  it('will not put two people on one ring', () => {
    const world = scene()
    ringAt(world, 0, MID_Z)
    const first = swimmerAt(world, 0.1, MID_Z)
    const second = swimmerAt(world, -0.1, MID_Z)
    advance(world, 1.5)
    const riding = [first, second].filter((s) => world.rider.isRiding(s))
    expect(riding).toHaveLength(1)
  })

  it('offers nothing to climb onto that is not made to be climbed on', () => {
    const world = scene()
    const duck = new RubberDuck()
    duck.placeAt(0, MID_Z, 0.05)
    world.physics.add(duck)
    world.rider.add(duck)
    const swimmer = swimmerAt(world, 0.1, MID_Z)
    advance(world, 2)
    expect(world.rider.isRiding(swimmer)).toBe(false)
  })

  it('lies a rider flat on a mattress and sits them up in a ring', () => {
    const world = scene()
    const mattress = new AirMattress()
    mattress.placeAt(0, MID_Z, 0.05)
    world.physics.add(mattress)
    world.rider.add(mattress)
    const swimmer = swimmerAt(world, 0.2, MID_Z)
    advance(world, 2)
    expect(world.rider.isRiding(swimmer)).toBe(true)
    expect(swimmer.pose).toBe('ride')
  })
})

describe('what the ring makes of a rider', () => {
  it(
    'settles lower in the water and squashes under them, and recovers when they get off',
    () => {
      const empty = scene()
      const alone = ringAt(empty, 0, MID_Z)
      advance(empty, 8)
      const emptyDraft = alone.body.position.y

      const world = scene()
      const ring = ringAt(world, 0, MID_Z)
      const swimmer = swimmerAt(world, 0.2, MID_Z)
      advance(world, 10)

      const loadedDraft = ring.body.position.y
      const squash = ring.shell!.peak
      console.log(
        `[ride] ring floats at ${emptyDraft.toFixed(3)}m empty, ${loadedDraft.toFixed(3)}m with ` +
          `somebody in it, tube squashed ${(squash * 1000).toFixed(1)}mm of 110`,
      )

      expect(world.rider.isRiding(swimmer)).toBe(true)
      expect(loadedDraft).toBeLessThan(emptyDraft - 0.03)
      expect(squash).toBeGreaterThan(0.006)
      // The rider is up out of the water, which is the point of a swim ring.
      expect(swimmer.body.position.y).toBeGreaterThan(ring.body.position.y + 0.05)

      world.rider.dismount(swimmer)
      advance(world, 6)
      console.log(`[ride] after getting off: squash ${(ring.shell!.peak * 1000).toFixed(2)}mm`)
      expect(ring.shell!.peak).toBeLessThan(squash * 0.35)
      expect(ring.body.position.y).toBeGreaterThan(loadedDraft + 0.02)
    },
    LONG_RUN_TIMEOUT,
  )

  it(
    'squashes hardest on the side the rider is leaning',
    () => {
      const world = scene()
      const ring = ringAt(world, 0, MID_Z)
      const swimmer = swimmerAt(world, 0.3, MID_Z)
      advance(world, 6)
      // Lean towards +X, which is where node 0 is.
      for (let i = 0; i < Math.round(4 / PHYSICS_DT); i++) {
        swimmer.body.velocity.x += 0.02
        world.splats.clear()
        world.physics.step(PHYSICS_DT)
        world.water.applySplats(world.splats)
        for (let k = 0; k < WAVE_SUBSTEPS; k++) world.water.step(WAVE_DT)
      }

      const near = Math.abs(ring.shell!.deflection[0]!)
      const far = Math.abs(ring.shell!.deflection[4]!)
      console.log(`[lean] near side ${(near * 1000).toFixed(1)}mm, far side ${(far * 1000).toFixed(1)}mm`)
      expect(near).toBeGreaterThan(far * 1.05)
    },
    LONG_RUN_TIMEOUT,
  )
})

describe('driving it', () => {
  it(
    'paddles a float across the pool',
    () => {
      const world = scene()
      const ring = ringAt(world, 0, MID_Z)
      const swimmer = swimmerAt(world, 0.2, MID_Z)
      advance(world, 6)

      // From a standstill in the middle, paddle towards -Z.
      ring.body.position.set(0, ring.body.position.y, MID_Z)
      ring.body.velocity.setScalar(0)
      swimmer.body.position.set(0, swimmer.body.position.y, MID_Z)
      swimmer.body.velocity.setScalar(0)
      swimmer.throttle = 1
      swimmer.desiredHeading = Math.PI

      advance(world, 8)
      const travelled = MID_Z - ring.body.position.z
      console.log(
        `[paddle] ${travelled.toFixed(2)}m in 8s, still aboard=${world.rider.isRiding(swimmer)}`,
      )
      expect(travelled).toBeGreaterThan(1.5)
      expect(world.rider.isRiding(swimmer)).toBe(true)
    },
    LONG_RUN_TIMEOUT,
  )

  it(
    'stays on for a long quiet ride, and comes off when asked',
    () => {
      const world = scene()
      ringAt(world, 0, MID_Z)
      const swimmer = swimmerAt(world, 0.2, MID_Z)
      advance(world, 1.5)
      expect(world.rider.isRiding(swimmer)).toBe(true)

      advance(world, 18)
      expect(world.rider.isRiding(swimmer)).toBe(true)

      swimmer.dismountRequested = true
      advance(world, 0.5)
      expect(world.rider.isRiding(swimmer)).toBe(false)
      expect(swimmer.poseLocked).toBe(false)
      // Whatever they are doing now, they are not sitting in a ring: the water
      // and the ground decide again, so standing in the shallows counts.
      expect(swimmer.pose).not.toBe('sit')
    },
    LONG_RUN_TIMEOUT,
  )

  it(
    'is a spring and not a rail: haul the ring away and the rider is left behind',
    () => {
      const world = scene()
      const ring = ringAt(world, 0, MID_Z)
      const swimmer = swimmerAt(world, 0.2, MID_Z)
      advance(world, 2)
      expect(world.rider.isRiding(swimmer)).toBe(true)

      // Somebody grabs the ring and drags it out from under them. A constraint
      // would take the rider with it; a capped spring lets go.
      for (let i = 0; i < Math.round(1.5 / PHYSICS_DT); i++) {
        ring.body.velocity.x = 6
        world.splats.clear()
        world.physics.step(PHYSICS_DT)
        world.water.applySplats(world.splats)
        for (let k = 0; k < WAVE_SUBSTEPS; k++) world.water.step(WAVE_DT)
      }

      const gap = Math.hypot(
        swimmer.body.position.x - ring.body.position.x,
        swimmer.body.position.z - ring.body.position.z,
      )
      console.log(
        `[thrown] ring ran off ${gap.toFixed(2)}m ahead; still aboard=${world.rider.isRiding(swimmer)}`,
      )
      expect(world.rider.isRiding(swimmer)).toBe(false)
      expect(swimmer.poseLocked).toBe(false)
    },
    LONG_RUN_TIMEOUT,
  )
})
