/**
 * Analytic 2D current in the pool, evaluated on demand.
 *
 * Two source types, superposed:
 *  - jets: the wall inlets that circulate a real pool, a directed plume that
 *    falls off with distance and is confined to a forward cone
 *  - vortices: Rankine swirls — rigid-body rotation inside the core, 1/r
 *    outside — which is what actually forms in the corners of a circulating pool
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

export interface Vec2 {
  x: number
  z: number
}

export class FlowField {
  readonly jets: Jet[] = []
  readonly vortices: Vortex[] = []
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

const scratch: Vec2 = { x: 0, z: 0 }
