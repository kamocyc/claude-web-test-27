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
