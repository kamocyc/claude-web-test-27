import { stadiumDistance, type Stadium, type Vec2 } from '../core/shapes'

/**
 * Analytic 2D current in the pool, evaluated on demand.
 *
 * Three source types, superposed:
 *  - jets: the wall inlets that circulate a real pool, a directed plume that
 *    falls off with distance and is confined to a forward cone
 *  - vortices: Rankine swirls — rigid-body rotation inside the core, 1/r
 *    outside — which is what actually forms in the corners of a circulating pool
 *  - channels: the lazy river, a band of water running round the island
 *
 * The same field drives drag on rigid bodies and swimmers, transports foam and
 * spray, and advects the surface detail normals, so everything drifts together.
 */

export interface Jet {
  x: number
  z: number
  /** Unit direction of the plume in the XZ plane. */
  dirX: number
  dirZ: number
  /** Peak speed at the outlet, m/s. */
  strength: number
  /** Distance at which the plume has dropped to half strength, metres. */
  radius: number
}

export interface Vortex {
  x: number
  z: number
  /** Peak tangential speed, m/s. Positive spins counter-clockwise (+Y). */
  strength: number
  /** Radius of the rigid-rotation core, metres. */
  coreRadius: number
}

/**
 * A closed circuit of moving water round a stadium-shaped island: the lazy
 * river.
 *
 * The velocity is tangential to the island's outline everywhere, with a
 * strength that rises from nothing at the island wall and falls back to nothing
 * before the pool wall. Written this way the field is divergence-free — along
 * the straight sides the speed does not vary with x, and round the ends it is
 * purely azimuthal — so the current pushes water round and round without ever
 * piling it up. That matters more than it sounds: the current feeds the same
 * drag term as every wave, and a source or sink hidden in it would walk the
 * water level away over a long session.
 */
export type { Vec2 }

export interface Channel extends Stadium {
  /** Distance from the axis at which the current starts (the island wall). */
  innerRadius: number
  /** Distance at which it has died away again. */
  outerRadius: number
  /** Peak tangential speed, m/s. Positive circulates counter-clockwise about +Y. */
  strength: number
  /**
   * Boundary layers at the two banks, as fractions of the channel width. The
   * flow has to reach zero at a wall, but the outer one is kept thin on
   * purpose: a float pressed against the outer bank by its own momentum sits
   * inside that layer, and if the profile were symmetric it would be sitting in
   * still water and stop there. Default 0.25 inside, 0.12 outside.
   */
  innerLayer?: number
  outerLayer?: number
}

export class FlowField {
  readonly jets: Jet[] = []
  readonly vortices: Vortex[] = []
  readonly channels: Channel[] = []
  /** Global multiplier, so the GUI can fade the whole current in and out. */
  intensity = 1

  addJet(jet: Jet): Jet {
    const len = Math.hypot(jet.dirX, jet.dirZ) || 1
    jet.dirX /= len
    jet.dirZ /= len
    this.jets.push(jet)
    return jet
  }

  addVortex(vortex: Vortex): Vortex {
    this.vortices.push(vortex)
    return vortex
  }

  addChannel(channel: Channel): Channel {
    this.channels.push(channel)
    return channel
  }

  /** Horizontal water velocity at a world position, written into `out`. */
  velocityAt(x: number, z: number, out: Vec2): Vec2 {
    let vx = 0
    let vz = 0

    for (const jet of this.jets) {
      const dx = x - jet.x
      const dz = z - jet.z
      const dist = Math.hypot(dx, dz)
      // Radial falloff: half strength at `radius`, ~1/d^2 far away.
      const falloff = 1 / (1 + (dist / jet.radius) * (dist / jet.radius))
      // Confine the plume to the forward hemisphere so a jet does not suck
      // water sideways out of the wall it is mounted in.
      let cone = 1
      if (dist > 1e-4) {
        const along = (dx * jet.dirX + dz * jet.dirZ) / dist
        cone = Math.max(0, 0.25 + 0.75 * along)
      }
      const mag = jet.strength * falloff * cone
      vx += jet.dirX * mag
      vz += jet.dirZ * mag
    }

    for (const vortex of this.vortices) {
      const dx = x - vortex.x
      const dz = z - vortex.z
      const dist = Math.hypot(dx, dz)
      if (dist < 1e-5) continue
      const core = Math.max(vortex.coreRadius, 1e-4)
      const mag = dist < core ? vortex.strength * (dist / core) : vortex.strength * (core / dist)
      // Tangent, counter-clockwise about +Y.
      vx += (-dz / dist) * mag
      vz += (dx / dist) * mag
    }

    for (const channel of this.channels) {
      const distance = stadiumDistance(channel, x, z, radial)
      const span = channel.outerRadius - channel.innerRadius
      if (span <= 0 || distance <= channel.innerRadius || distance >= channel.outerRadius) continue
      // sin^2 rises and falls to zero with zero slope at both banks, so there is
      // no shear discontinuity against the island or against the still water
      // outside the circuit.
      const t = (distance - channel.innerRadius) / span
      const profile =
        smoothstep(t / (channel.innerLayer ?? 0.25)) * smoothstep((1 - t) / (channel.outerLayer ?? 0.12))
      const mag = channel.strength * profile
      // Tangent, counter-clockwise about +Y — the same sense as a vortex.
      vx += -radial.z * mag
      vz += radial.x * mag
    }

    out.x = vx * this.intensity
    out.z = vz * this.intensity
    return out
  }

  /** Speed at a position, without needing a scratch vector. */
  speedAt(x: number, z: number): number {
    this.velocityAt(x, z, scratch)
    return Math.hypot(scratch.x, scratch.z)
  }
}

/** Hermite ramp, clamped: 0 below 0, 1 above 1, flat at both ends. */
function smoothstep(t: number): number {
  if (t <= 0) return 0
  if (t >= 1) return 1
  return t * t * (3 - 2 * t)
}

const scratch: Vec2 = { x: 0, z: 0 }
const radial: Vec2 = { x: 0, z: 0 }
