import { ISLAND, ISLAND_TOP, POOL, RIVER_BANK, WATER_LEVEL } from './config'
import { insideStadium, stadiumDistance, type Stadium, type Vec2 } from './shapes'

/**
 * The layout of the place: where there is water, how deep it is, and what you
 * can stand on.
 *
 * Everything that used to assume "the pool" was one rectangle centred on the
 * origin asks here instead. That is what lets a second, ordinary pool exist
 * beside the lazy river without the two sharing a floor, a wall or a wave.
 */

/**
 * One basin of water. The floor slopes linearly along Z between the depths at
 * its two ends, which is enough for both pools and keeps the wave field's
 * per-cell wave speed a straight lookup.
 */
export interface Basin {
  readonly name: string
  readonly minX: number
  readonly maxX: number
  readonly minZ: number
  readonly maxZ: number
  /** Water depth at the minZ end, metres. */
  readonly depthAtMinZ: number
  /** Water depth at the maxZ end, metres. */
  readonly depthAtMaxZ: number
}

/**
 * The lazy river. Unchanged from when it was the only pool — the island, the
 * bank, the slide and the fountains are all placed against these numbers.
 */
export const RIVER_POOL: Basin = {
  name: 'river',
  minX: -POOL.width / 2,
  maxX: POOL.width / 2,
  minZ: -POOL.depth / 2,
  maxZ: POOL.depth / 2,
  depthAtMinZ: POOL.shallowDepth,
  depthAtMaxZ: POOL.deepDepth,
}

/** Width of the paved strip between the two pools. */
export const DIVIDE_WIDTH = 5

/**
 * The ordinary pool: a plain rectangle with no island, no circuit and no
 * fountains, deep at the far end. Somewhere to just swim.
 */
export const CALM_POOL: Basin = {
  name: 'calm',
  minX: -8,
  maxX: 8,
  minZ: RIVER_POOL.minZ - DIVIDE_WIDTH - 10,
  maxZ: RIVER_POOL.minZ - DIVIDE_WIDTH,
  depthAtMinZ: 3,
  depthAtMaxZ: 1,
}

export const BASINS: readonly Basin[] = [RIVER_POOL, CALM_POOL]

/** Height of the paving, and of every pool's rim. */
export const DECK_TOP = WATER_LEVEL + POOL.copingHeight

/**
 * The rectangle the wave simulation covers: the two basins together.
 *
 * It is not centred on the origin any more, so every place that maps world XZ
 * onto the field — the height texture, the splat renderer, the caustics, the
 * surface mesh — carries the centre as well as the size.
 */
export const DOMAIN = {
  centerX: (Math.min(RIVER_POOL.minX, CALM_POOL.minX) + Math.max(RIVER_POOL.maxX, CALM_POOL.maxX)) / 2,
  centerZ: (Math.min(RIVER_POOL.minZ, CALM_POOL.minZ) + Math.max(RIVER_POOL.maxZ, CALM_POOL.maxZ)) / 2,
  width: Math.max(RIVER_POOL.maxX, CALM_POOL.maxX) - Math.min(RIVER_POOL.minX, CALM_POOL.minX),
  depth: Math.max(RIVER_POOL.maxZ, CALM_POOL.maxZ) - Math.min(RIVER_POOL.minZ, CALM_POOL.minZ),
} as const

/** Outer edge of the paving, which is also as far as the camera may wander. */
export const GROUNDS = {
  minX: DOMAIN.centerX - DOMAIN.width / 2 - POOL.deckWidth,
  maxX: DOMAIN.centerX + DOMAIN.width / 2 + POOL.deckWidth,
  minZ: DOMAIN.centerZ - DOMAIN.depth / 2 - POOL.deckWidth,
  maxZ: DOMAIN.centerZ + DOMAIN.depth / 2 + POOL.deckWidth,
} as const

/**
 * A ramped entry into a pool: a hip of paving that runs down off the deck and
 * disappears under the water.
 *
 * It started as a flight of steps and had to stop being one. Every wall of the
 * lazy river is also the circuit, so anything set into a wall stands in the
 * stream, and a tread's vertical side face is a perfect trap: a beach ball
 * driven onto it by the current parked there and never moved again — 0.92 laps
 * in four minutes against 2.9 with the wall clear.
 *
 * Sloping the faces was not enough either. A flank that falls away straight
 * sideways has a normal pointing straight back up the stream, so the current
 * and the paving simply balance and the ball sits in the notch between them.
 * What is needed is a surface that pushes things *around* it, and that is why
 * the height falls with distance from the crest *line* rather than with
 * distance from the wall: at the ends of the crest the contours are arcs, so
 * the normal turns to face out into the pool and anything arriving along the
 * wall is deflected past. The rest of the shape is under water anyway, where a
 * float rides straight over the top.
 */
export interface Ramp {
  /** The basin it leads into. */
  readonly basin: Basin
  /** Z of the wall the crest sits on. */
  readonly wallZ: number
  /** +1 if the water lies towards +Z of the wall, -1 if towards -Z. */
  readonly into: 1 | -1
  /** X of the middle of the crest. */
  readonly centreX: number
  /** Half-length of the level crest along the wall. */
  readonly halfLength: number
  /** How far the slope reaches before it meets the floor. */
  readonly run: number
  readonly topY: number
  readonly bottomY: number
}

function makeRamp(
  basin: Basin,
  wallZ: number,
  into: 1 | -1,
  centreX: number,
  halfLength: number,
  run: number,
): Ramp {
  return {
    basin,
    wallZ,
    into,
    centreX,
    halfLength,
    run,
    topY: DECK_TOP,
    bottomY: WATER_LEVEL - basinDepthAt(basin, wallZ),
  }
}

/**
 * One ramp in each pool, both on the wall facing the divide, so the walk from
 * one pool to the other is up, across and down.
 *
 * The river's is offset from the slide's boarding circle, so that climbing out
 * is not mistaken for queuing for the slide.
 */
export const RIVER_RAMP = makeRamp(RIVER_POOL, RIVER_POOL.minZ, 1, -1.6, 0.9, 2.6)
export const CALM_RAMP = makeRamp(CALM_POOL, CALM_POOL.maxZ, -1, 0, 1.6, 3)
export const ALL_RAMPS: readonly Ramp[] = [RIVER_RAMP, CALM_RAMP]

/**
 * How far down the slope a point is: 0 on the crest, 1 at the toe, more than
 * that once it is off the ramp altogether.
 */
export function rampParameter(ramp: Ramp, x: number, z: number): number {
  if ((z - ramp.wallZ) * ramp.into < 0) return Number.POSITIVE_INFINITY
  return stadiumDistance(rampCrest(ramp), x, z, _outward) / ramp.run
}

/** The crest as a shape: a bare line segment on the wall. */
export function rampCrest(ramp: Ramp): Stadium {
  return { x: ramp.centreX, z: ramp.wallZ, halfLength: ramp.halfLength, radius: 0 }
}

/** Height of the ramp's surface, or null where there is no ramp. */
export function rampHeightAt(ramp: Ramp, x: number, z: number): number | null {
  const t = rampParameter(ramp, x, z)
  if (t >= 1) return null
  return ramp.topY - (ramp.topY - ramp.bottomY) * t
}

/** The basin whose rectangle contains this point, or null out on the paving. */
export function basinAt(x: number, z: number): Basin | null {
  for (const basin of BASINS) {
    if (x >= basin.minX && x <= basin.maxX && z >= basin.minZ && z <= basin.maxZ) return basin
  }
  return null
}

/** Water depth at a Z inside a basin, from its two end depths. */
export function basinDepthAt(basin: Basin, z: number): number {
  const t = (z - basin.minZ) / (basin.maxZ - basin.minZ)
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t
  return basin.depthAtMinZ + (basin.depthAtMaxZ - basin.depthAtMinZ) * clamped
}

/**
 * Y of the surface a falling body would land on: a basin's floor inside one,
 * the paving outside.
 *
 * Deliberately blind to the island and the corner fill. Those are solid blocks
 * standing on this floor and they have contacts of their own; the floor
 * underneath them is still the floor.
 */
export function floorYAt(x: number, z: number): number {
  const basin = basinAt(x, z)
  if (basin === null) return DECK_TOP
  return WATER_LEVEL - basinDepthAt(basin, z)
}

/**
 * Depth of *water* at a point: zero wherever something solid fills the basin
 * to the top.
 *
 * This is the quantity the wave fields need. Where it is zero there is no
 * surface to move, and a wet cell next to a dry one has a wall between them —
 * which is how a wave in one pool stays in that pool, and how the island
 * finally reflects the ripples that used to pass straight through it.
 */
export function wetDepthAt(x: number, z: number): number {
  const basin = basinAt(x, z)
  if (basin === null) return 0
  if (basin === RIVER_POOL) {
    // The island, and the filled-in corners outside the river's outer bank.
    if (insideStadium(ISLAND, x, z)) return 0
    if (stadiumDistance(RIVER_BANK, x, z, _outward) > RIVER_BANK.radius) return 0
  }
  return basinDepthAt(basin, z)
}

/** True where there is water to swim in. */
export function isWet(x: number, z: number): boolean {
  return wetDepthAt(x, z) > 0
}

/**
 * Y of the highest thing that can be stood on here.
 *
 * The walk controller uses it to decide whether a swimmer is supported. It has
 * to agree with the contacts — deck, island top, treads, basin floor — or
 * somebody would try to walk on water.
 */
export function groundYAt(x: number, z: number): number {
  let best = Number.NEGATIVE_INFINITY
  for (const ramp of ALL_RAMPS) {
    const height = rampHeightAt(ramp, x, z)
    if (height !== null) best = Math.max(best, height)
  }
  if (best > Number.NEGATIVE_INFINITY) return best

  const basin = basinAt(x, z)
  if (basin === null) return DECK_TOP
  if (basin === RIVER_POOL) {
    if (insideStadium(ISLAND, x, z)) return ISLAND_TOP
    if (stadiumDistance(RIVER_BANK, x, z, _outward) > RIVER_BANK.radius) return DECK_TOP
  }
  return WATER_LEVEL - basinDepthAt(basin, z)
}

/** Nearest point inside a basin, kept `margin` clear of its walls. */
export function clampToBasin(basin: Basin, x: number, z: number, margin: number, out: Vec2): Vec2 {
  out.x = Math.min(Math.max(x, basin.minX + margin), basin.maxX - margin)
  out.z = Math.min(Math.max(z, basin.minZ + margin), basin.maxZ - margin)
  return out
}

const _outward: Vec2 = { x: 0, z: 0 }
