import { describe, expect, it } from 'vitest'
import { Vector3 } from 'three'
import { ISLAND, PHYSICS_DT, WAVE_DT, WAVE_SUBSTEPS } from '../src/core/config'
import {
  ALL_RAMPS,
  CALM_POOL,
  CALM_RAMP,
  DECK_TOP,
  DOMAIN,
  RIVER_POOL,
  RIVER_RAMP,
  basinAt,
  basinDepthAt,
  floorYAt,
  groundYAt,
  isWet,
  rampHeightAt,
  wetDepthAt,
} from '../src/core/world'
import { Swimmer } from '../src/entities/Swimmer'
import { RampObstacle } from '../src/physics/BoxObstacle'
import { PhysicsWorld } from '../src/physics/PhysicsWorld'
import { FlowField } from '../src/sim/FlowField'
import { WaveFieldCPU } from '../src/sim/WaveFieldCPU'
import { SplatQueue } from '../src/sim/WaveSplat'

/**
 * There are two pools now, and they are separate pools.
 *
 * That is a claim about three different things agreeing: the geometry says
 * there is paving between them, the physics says you can walk on it, and the
 * wave field says a wave in one of them stays there. The last is the one worth
 * testing hardest, because it is the one that used to be false — before the
 * bathymetry mask, ripples went straight through the island as though it were
 * not there, and across five metres of dry walkway into the other pool.
 */

const LONG_RUN_TIMEOUT = 120_000

function field(options: { masked?: boolean } = {}) {
  return new WaveFieldCPU({
    width: DOMAIN.width,
    depth: DOMAIN.depth,
    centerX: DOMAIN.centerX,
    centerZ: DOMAIN.centerZ,
    cols: 128,
    rows: Math.round((128 * DOMAIN.depth) / DOMAIN.width),
    levelDecay: 0,
    ...(options.masked === false ? {} : { depthAt: wetDepthAt }),
  })
}

/** Largest surface height anywhere inside a basin. */
function peakIn(water: WaveFieldCPU, minX: number, maxX: number, minZ: number, maxZ: number) {
  let peak = 0
  for (let z = minZ + 0.3; z < maxZ - 0.3; z += 0.4) {
    for (let x = minX + 0.3; x < maxX - 0.3; x += 0.4) {
      peak = Math.max(peak, Math.abs(water.heightAt(x, z)))
    }
  }
  return peak
}

describe('the layout', () => {
  it('has two basins with paving between them', () => {
    expect(basinAt(0, 0)).toBe(RIVER_POOL)
    expect(basinAt(0, (CALM_POOL.minZ + CALM_POOL.maxZ) / 2)).toBe(CALM_POOL)
    // Halfway across the divide.
    const between = (RIVER_POOL.minZ + CALM_POOL.maxZ) / 2
    expect(basinAt(0, between)).toBeNull()
    expect(isWet(0, between)).toBe(false)
    expect(groundYAt(0, between)).toBeCloseTo(DECK_TOP, 9)
  })

  it('covers both basins with one simulation domain', () => {
    for (const basin of [RIVER_POOL, CALM_POOL]) {
      expect(basin.minX).toBeGreaterThanOrEqual(DOMAIN.centerX - DOMAIN.width / 2 - 1e-9)
      expect(basin.maxX).toBeLessThanOrEqual(DOMAIN.centerX + DOMAIN.width / 2 + 1e-9)
      expect(basin.minZ).toBeGreaterThanOrEqual(DOMAIN.centerZ - DOMAIN.depth / 2 - 1e-9)
      expect(basin.maxZ).toBeLessThanOrEqual(DOMAIN.centerZ + DOMAIN.depth / 2 + 1e-9)
    }
  })

  it('slopes each floor its own way', () => {
    // The river deepens towards +Z, the calm pool towards -Z.
    expect(floorYAt(0, RIVER_POOL.maxZ - 0.1)).toBeLessThan(floorYAt(0, RIVER_POOL.minZ + 0.1))
    expect(floorYAt(0, CALM_POOL.minZ + 0.1)).toBeLessThan(floorYAt(0, CALM_POOL.maxZ - 0.1))
  })

  it('counts the island and the filled corners as dry land', () => {
    expect(isWet(ISLAND.x, ISLAND.z)).toBe(false)
    // A corner of the river's rectangle, outside the stadium bank.
    expect(isWet(RIVER_POOL.maxX - 0.2, RIVER_POOL.maxZ - 0.2)).toBe(false)
    // And the channel between them is water.
    expect(isWet(0, ISLAND.radius + 1)).toBe(true)
  })

  it('gives every ramp a crest at deck level and a toe on the floor', () => {
    for (const ramp of ALL_RAMPS) {
      expect(rampHeightAt(ramp, ramp.centreX, ramp.wallZ)).toBeCloseTo(DECK_TOP, 9)
      const toe = ramp.wallZ + ramp.into * (ramp.run - 1e-4)
      expect(rampHeightAt(ramp, ramp.centreX, toe)!).toBeCloseTo(ramp.bottomY, 3)
      expect(ramp.bottomY).toBeCloseTo(-basinDepthAt(ramp.basin, ramp.wallZ), 9)
      // Past the toe there is no ramp at all, only floor.
      const beyond = ramp.wallZ + ramp.into * (ramp.run + 0.2)
      expect(rampHeightAt(ramp, ramp.centreX, beyond)).toBeNull()
    }
  })

  it('falls away from the crest in every direction, which is what stops it trapping floats', () => {
    // Straight out from the middle of the crest, and off the end of it: both
    // must descend. A flank that only fell away sideways had a normal pointing
    // straight back up the current, and the current simply held things against
    // it — a beach ball parked there for four minutes.
    const ramp = RIVER_RAMP
    const out = rampHeightAt(ramp, ramp.centreX, ramp.wallZ + ramp.into * 1)!
    const along = rampHeightAt(ramp, ramp.centreX + ramp.halfLength + 1, ramp.wallZ + 0.01)!
    expect(out).toBeLessThan(DECK_TOP - 0.3)
    expect(along).toBeLessThan(DECK_TOP - 0.3)
  })
})

describe('the two pools do not share their water', () => {
  it(
    'keeps a wave struck in one of them out of the other',
    () => {
      const masked = field()
      masked.splat(0, RIVER_POOL.maxZ - 1, 0.3, 0.06)
      masked.splat(-6, 0, 0.3, 0.06)

      const open = field({ masked: false })
      open.splat(0, RIVER_POOL.maxZ - 1, 0.3, 0.06)
      open.splat(-6, 0, 0.3, 0.06)

      let river = 0
      let calm = 0
      let calmUnmasked = 0
      for (let i = 0; i < 20 / WAVE_DT; i++) {
        masked.step(WAVE_DT)
        open.step(WAVE_DT)
        river = Math.max(river, peakIn(masked, -7.5, 7.5, RIVER_POOL.minZ, RIVER_POOL.maxZ))
        calm = Math.max(calm, peakIn(masked, -7.5, 7.5, CALM_POOL.minZ, CALM_POOL.maxZ))
        calmUnmasked = Math.max(calmUnmasked, peakIn(open, -7.5, 7.5, CALM_POOL.minZ, CALM_POOL.maxZ))
      }

      console.log(
        `[mask] struck the river: river peak ${(river * 1000).toFixed(1)}mm, ` +
          `calm pool ${(calm * 1000).toFixed(3)}mm ` +
          `(without the mask the calm pool sees ${(calmUnmasked * 1000).toFixed(2)}mm)`,
      )

      expect(river).toBeGreaterThan(0.02)
      expect(calm).toBeLessThan(river * 0.01)
      // And the check has teeth: the same field with no land in it leaks.
      expect(calmUnmasked).toBeGreaterThan(calm * 100)
    },
    LONG_RUN_TIMEOUT,
  )

  it('has no water to move on the land itself', () => {
    const water = field()
    expect(water.isWetAt(ISLAND.x, ISLAND.z)).toBe(false)
    expect(water.isWetAt(0, (RIVER_POOL.minZ + CALM_POOL.maxZ) / 2)).toBe(false)
    expect(water.isWetAt(0, 3)).toBe(true)
  })

  it('stays finite and inside its stability budget over the whole domain', () => {
    const water = field()
    expect(water.maxCourant(WAVE_DT)).toBeLessThan(0.5)
    water.splat(0, 3, 0.3, 0.08)
    for (let i = 0; i < 2000; i++) water.step(WAVE_DT)
    expect(water.isFinite()).toBe(true)
  })
})

describe('getting from one pool to the other', () => {
  it(
    'walks a swimmer up the ramp, across the paving and into the other pool',
    () => {
      const water = field()
      const flow = new FlowField()
      const splats = new SplatQueue()
      const physics = new PhysicsWorld(water, flow, splats)
      for (const ramp of ALL_RAMPS) physics.addFeature(new RampObstacle(ramp))

      const swimmer = new Swimmer(0)
      swimmer.placeAt(CALM_RAMP.centreX, CALM_POOL.maxZ - 4, -0.04)
      swimmer.faceDirection(0, 1)
      swimmer.throttle = 1
      physics.add(swimmer)

      let stoodUp = false
      let crossedTheDivide = false
      const start = new Vector3().copy(swimmer.body.position)
      for (let i = 0; i < 30 / PHYSICS_DT; i++) {
        // Head straight for the river the whole way.
        swimmer.desiredHeading = 0
        splats.clear()
        physics.step(PHYSICS_DT)
        water.applySplats(splats)
        for (let k = 0; k < WAVE_SUBSTEPS; k++) water.step(WAVE_DT)
        if (swimmer.pose === 'stand') stoodUp = true
        if (
          swimmer.pose === 'stand' &&
          swimmer.body.position.z > CALM_POOL.maxZ + 1 &&
          swimmer.body.position.z < RIVER_POOL.minZ - 1
        ) {
          crossedTheDivide = true
        }
      }

      console.log(
        `[walk] ${start.z.toFixed(1)} -> ${swimmer.body.position.z.toFixed(1)} in 30s, ` +
          `stood up=${stoodUp}, walked the divide=${crossedTheDivide}, ` +
          `ended in the ${basinAt(swimmer.body.position.x, swimmer.body.position.z)?.name ?? 'open'}`,
      )

      expect(stoodUp).toBe(true)
      expect(crossedTheDivide).toBe(true)
      expect(basinAt(swimmer.body.position.x, swimmer.body.position.z)).toBe(RIVER_POOL)
      expect(swimmer.pose).toBe('swim')
    },
    LONG_RUN_TIMEOUT,
  )

  it(
    'stands a swimmer upright rather than leaving them lying on the paving',
    () => {
      const water = field()
      const physics = new PhysicsWorld(water, new FlowField(), new SplatQueue())
      const swimmer = new Swimmer(0)
      // Dropped flat onto the middle of the walkway.
      swimmer.placeAt(0, (RIVER_POOL.minZ + CALM_POOL.maxZ) / 2, 0.9)
      physics.add(swimmer)

      for (let i = 0; i < 3 / PHYSICS_DT; i++) physics.step(PHYSICS_DT)

      const head = new Vector3(0, 0, 1).applyQuaternion(swimmer.body.quaternion)
      const tilt = (Math.acos(Math.min(1, Math.max(-1, head.y))) * 180) / Math.PI
      console.log(`[stand] ${tilt.toFixed(0)} degrees off vertical after 3s`)

      expect(swimmer.pose).toBe('stand')
      // Without the leg spring this settles at about eighty degrees: turning
      // upright from prone drives the feet into the ground and the contact
      // cancels exactly that rotation.
      expect(tilt).toBeLessThan(25)
      expect(swimmer.body.position.y).toBeGreaterThan(DECK_TOP + 0.6)
    },
    LONG_RUN_TIMEOUT,
  )
})
