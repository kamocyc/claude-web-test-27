/**
 * The one shape the pool furniture is built from.
 *
 * A stadium is a line segment in the XZ plane, thickened by a radius: a
 * rectangle with two half-discs on the ends. The island is a long one, a
 * fountain's stem is one of zero length, and the lazy river is the band of
 * water at a given distance from the island's. Because all three come from the
 * same distance function, the current runs exactly parallel to the wall a
 * swimmer bumps into, with nothing to keep in sync.
 */

export interface Vec2 {
  x: number
  z: number
}

export interface Stadium {
  /** Centre of the axis segment. */
  x: number
  z: number
  /** Half-length of the axis, which runs along X. Zero makes a circle. */
  halfLength: number
  /** Distance from the axis to the surface. */
  radius: number
}

/**
 * Distance from a point to the stadium's axis segment, with the outward unit
 * direction written into `out`. Subtracting `radius` gives the signed distance
 * to the surface itself: negative inside, positive outside.
 *
 * `out` is left pointing along +X when the point sits exactly on the axis,
 * which is degenerate but has to be *some* finite direction for the callers
 * that push a body out of the shape.
 */
export function stadiumDistance(shape: Stadium, x: number, z: number, out: Vec2): number {
  const localX = x - shape.x
  const clamped = Math.max(-shape.halfLength, Math.min(shape.halfLength, localX))
  const dx = localX - clamped
  const dz = z - shape.z
  const distance = Math.hypot(dx, dz)
  if (distance < 1e-9) {
    out.x = 1
    out.z = 0
    return 0
  }
  out.x = dx / distance
  out.z = dz / distance
  return distance
}

/**
 * Move a point so that it lies between `min` and `max` from the stadium's axis,
 * along the shortest way out. That band is the lazy river's channel, so this is
 * "put this somewhere in the water" for anything being spawned or steered.
 */
export function clampToRing(
  shape: Stadium,
  x: number,
  z: number,
  min: number,
  max: number,
  out: Vec2,
): Vec2 {
  const distance = stadiumDistance(shape, x, z, out)
  const wanted = Math.min(Math.max(distance, min), Math.max(min, max))
  if (wanted === distance) {
    out.x = x
    out.z = z
    return out
  }
  const axisX = shape.x + Math.max(-shape.halfLength, Math.min(shape.halfLength, x - shape.x))
  const nx = out.x
  const nz = out.z
  out.x = axisX + nx * wanted
  out.z = shape.z + nz * wanted
  return out
}

/** True when the point is inside the stadium, with an optional margin. */
export function insideStadium(shape: Stadium, x: number, z: number, margin = 0): boolean {
  return stadiumDistance(shape, x, z, _scratch) < shape.radius + margin
}

const _scratch: Vec2 = { x: 0, z: 0 }
