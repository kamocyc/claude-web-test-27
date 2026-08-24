import type { Stadium } from './shapes'

/**
 * Shared world constants. Everything in SI units: metres, seconds, kilograms.
 * The still water surface is y = 0; the pool floor is below it.
 */

export const GRAVITY = 9.81
export const WATER_DENSITY = 1000
export const AIR_DENSITY = 1.2

/** Water surface rest height. */
export const WATER_LEVEL = 0

export const POOL = {
  /** Extent along X. */
  width: 16,
  /** Extent along Z. */
  depth: 10,
  /** Water depth at the shallow end (z = -depth/2). */
  shallowDepth: 1.1,
  /** Water depth at the deep end (z = +depth/2). */
  deepDepth: 2.6,
  /** Height of the coping/deck above the water line. */
  copingHeight: 0.34,
  /** Width of the deck surrounding the pool. */
  deckWidth: 4.5,
} as const

export const POOL_HALF_W = POOL.width / 2
export const POOL_HALF_D = POOL.depth / 2

/** Water depth (positive, metres) at a world Z coordinate. Floor slopes along Z. */
export function waterDepthAt(z: number): number {
  const t = clamp01((z + POOL_HALF_D) / POOL.depth)
  return POOL.shallowDepth + (POOL.deepDepth - POOL.shallowDepth) * t
}

/** World Y of the pool floor at a given Z. */
export function floorYAt(z: number): number {
  return WATER_LEVEL - waterDepthAt(z)
}

/**
 * The island in the middle of the pool, and the lazy river that runs round it.
 *
 * The island's footprint is x in [-3.85, 3.85], z in [-1.25, 1.25], which
 * leaves a channel about three metres wide all the way round and still keeps a
 * metre of quiet water against the walls.
 */
export const ISLAND: Stadium = { x: 0, z: 0, halfLength: 2.6, radius: 1.25 }

/** Top of the island, level with the deck. */
export const ISLAND_TOP = WATER_LEVEL + POOL.copingHeight

/**
 * The circuit itself. Its outer wall is a stadium concentric with the island,
 * which is why the pool's corners are filled in: without them the current has
 * to die away before the walls, and anything riding it slides out into the
 * dead water at the ends and parks there for good. With both banks in place
 * the water area *is* the channel, so a float goes round and keeps going round.
 */
export const RIVER = {
  /** Distance from the island axis at which the current starts. */
  innerRadius: ISLAND.radius,
  /** Distance from the island axis to the outer bank. */
  outerRadius: 5,
  /** Peak tangential speed, m/s. Positive circulates counter-clockwise about +Y. */
  speed: 0.9,
} as const

/** The outer bank of the river, as a shape in its own right. */
export const RIVER_BANK: Stadium = {
  x: ISLAND.x,
  z: ISLAND.z,
  halfLength: ISLAND.halfLength,
  radius: RIVER.outerRadius,
}

/** The water slide. Its centreline lives in entities/WaterSlide. */
export const SLIDE = {
  /** Inside radius of the flume. Wide enough that a prone swimmer does not jam. */
  flumeRadius: 0.6,
  /**
   * How far round from the bottom the flume wall reaches, in radians. Past this
   * the section is open, so anyone carrying too much speed through a bend goes
   * over the side.
   */
  openHalfAngle: (150 * Math.PI) / 180,
  /** Speed of the water pumped down the flume, m/s. */
  flumeFlow: 3,
  /**
   * Centre of the boarding circle on the water, and its radius. It has to sit
   * on the straight part of the shell — out towards the ends the river's bank
   * curves in and the water no longer reaches the original wall.
   */
  boardingX: 2.2,
  boardingZ: 4.3,
  boardingRadius: 1.15,
} as const

/**
 * Phase speed of a gravity wave in water of the given depth.
 * `scale` trims the physical value so the simulation stays inside its CFL
 * budget on the finest grid — see sim/README.md.
 */
export function waveSpeedAt(depth: number, scale: number): number {
  return scale * Math.sqrt(GRAVITY * Math.max(depth, 0.05))
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/** Fixed simulation cadence. Two wave substeps per physics step. */
export const PHYSICS_DT = 1 / 120
export const WAVE_SUBSTEPS = 2
export const WAVE_DT = PHYSICS_DT / WAVE_SUBSTEPS

/** Highest number of physics steps run for one rendered frame (spiral-of-death guard). */
export const MAX_STEPS_PER_FRAME = 8
