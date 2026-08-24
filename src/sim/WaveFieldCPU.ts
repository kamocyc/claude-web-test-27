import { POOL, clamp, waveSpeedAt } from '../core/config'
import type { SplatQueue } from './WaveSplat'

export interface WaveFieldCPUOptions {
  /** Domain extent along X, metres. */
  width: number
  /** Domain extent along Z, metres. */
  depth: number
  /** World X of the domain centre. Defaults to the origin. */
  centerX?: number
  /** World Z of the domain centre. Defaults to the origin. */
  centerZ?: number
  /** Cells along X. */
  cols: number
  /** Cells along Z. */
  rows: number
  /**
   * Water depth at a world position, zero on land. Defaults to a single basin
   * sloping along Z, which is what this field was before there were two pools.
   */
  depthAt?: (x: number, z: number) => number
  /** Multiplier on sqrt(g*h); see core/config.waveSpeedAt. */
  speedScale?: number
  /** Viscous loss: fraction of the surface's vertical rate shed per second. */
  damping?: number
  /**
   * Slow pull back towards the rest level, per second. Small on purpose - it
   * exists only so the net volume the splats inject cannot accumulate over a
   * long session and leave the pool sitting above its rim.
   */
  levelDecay?: number
}

/**
 * Coarse CPU mirror of the water height field, integrated with the same
 * discrete wave equation as the GPU field and fed by the same splats.
 *
 * Buoyancy samples this instead of reading the GPU field back: a synchronous
 * readback stalls the pipeline and an asynchronous one arrives a frame or two
 * late, which makes floating bodies jitter. Both fields share their sources and
 * their wave speed, so their low-frequency content — the part buoyancy cares
 * about — matches. The fine ripples that only exist on the GPU field are a
 * visual detail and carry negligible force.
 *
 * Cells are texel-centred: cell (i, j) sits at
 *   x = -width/2 + (i + 0.5) * dx
 *   z = -depth/2 + (j + 0.5) * dz
 * matching the GPU texture's sampling convention exactly.
 */
export class WaveFieldCPU {
  readonly cols: number
  readonly rows: number
  readonly width: number
  readonly depth: number
  readonly centerX: number
  readonly centerZ: number
  readonly dx: number
  readonly dz: number

  speedScale: number
  damping: number
  levelDecay: number

  private cur: Float32Array
  private prev: Float32Array
  private next: Float32Array
  /** Water depth per cell, metres. Zero marks a cell that is dry land. */
  private readonly cellDepth: Float32Array
  /** Per-cell stencil weight K = (c*dt/dx)^2, from that cell's own depth. */
  private readonly cellK: Float32Array
  /** Indices of the cells that hold water, in order. */
  private readonly wetCells: Int32Array
  /** Indices of the dry cells that touch water: the ghost cells. */
  private readonly ghostCells: Int32Array
  private cellKDt = -1
  private cellKScale = -1
  /** Step size the current/previous pair was produced with, for rate queries. */
  private lastDt = 1 / 240

  constructor(options: WaveFieldCPUOptions) {
    this.cols = Math.max(4, Math.floor(options.cols))
    this.rows = Math.max(4, Math.floor(options.rows))
    this.width = options.width
    this.depth = options.depth
    this.centerX = options.centerX ?? 0
    this.centerZ = options.centerZ ?? 0
    this.dx = options.width / this.cols
    this.dz = options.depth / this.rows
    this.speedScale = options.speedScale ?? 0.6
    this.damping = options.damping ?? 0.3
    this.levelDecay = options.levelDecay ?? 0.05

    const n = this.cols * this.rows
    this.cur = new Float32Array(n)
    this.prev = new Float32Array(n)
    this.next = new Float32Array(n)
    this.cellDepth = new Float32Array(n)
    this.cellK = new Float32Array(n)

    const depthAt = options.depthAt ?? defaultDepthAt
    const wet: number[] = []
    for (let j = 0; j < this.rows; j++) {
      for (let i = 0; i < this.cols; i++) {
        const d = depthAt(this.colX(i), this.rowZ(j))
        const idx = j * this.cols + i
        this.cellDepth[idx] = d > 0 ? d : 0
        if (d > 0) wet.push(idx)
      }
    }
    this.wetCells = Int32Array.from(wet)

    // A dry cell next to water is a ghost cell: it exists only to be read by
    // the stencil, and it carries the average of the water beside it. That is
    // the reflecting wall — a wave arriving at one sees its own height mirrored
    // back — and it also means bilinear sampling right up against the island
    // returns the water's height rather than fading towards a dry zero.
    const ghosts: number[] = []
    for (let j = 0; j < this.rows; j++) {
      for (let i = 0; i < this.cols; i++) {
        const idx = j * this.cols + i
        if (this.cellDepth[idx]! > 0) continue
        if (this.wetNeighbourCount(i, j) > 0) ghosts.push(idx)
      }
    }
    this.ghostCells = Int32Array.from(ghosts)
  }

  private wetNeighbourCount(i: number, j: number): number {
    let count = 0
    if (i > 0 && this.cellDepth[j * this.cols + i - 1]! > 0) count++
    if (i < this.cols - 1 && this.cellDepth[j * this.cols + i + 1]! > 0) count++
    if (j > 0 && this.cellDepth[(j - 1) * this.cols + i]! > 0) count++
    if (j < this.rows - 1 && this.cellDepth[(j + 1) * this.cols + i]! > 0) count++
    return count
  }

  /** Water depth at a cell, metres. Zero on land. */
  depthOf(i: number, j: number): number {
    return this.cellDepth[j * this.cols + i]!
  }

  /**
   * Is there water at this world position?
   *
   * Answered from the field's own bathymetry rather than from the world's, so
   * anything asking — the spray, a test rig with a plain rectangular field —
   * gets the same answer the simulation is actually using.
   */
  isWetAt(x: number, z: number): boolean {
    const i = clamp(Math.round(this.gridU(x)), 0, this.cols - 1)
    const j = clamp(Math.round(this.gridV(z)), 0, this.rows - 1)
    return this.cellDepth[j * this.cols + i]! > 0
  }

  /** World Z at the centre of row j. */
  rowZ(j: number): number {
    return this.centerZ - this.depth / 2 + (j + 0.5) * this.dz
  }

  /** World X at the centre of column i. */
  colX(i: number): number {
    return this.centerX - this.width / 2 + (i + 0.5) * this.dx
  }

  /**
   * Refresh the per-row stencil weights.
   *
   * Each is capped at 0.24 so the four weights sum to at most 0.96 and the
   * explicit update can never amplify. The cap — not the tuning knobs — is what
   * guarantees the field cannot blow up, whatever the GUI is set to.
   */
  private updateCellK(dt: number): void {
    if (this.cellKDt === dt && this.cellKScale === this.speedScale) return
    const cellSize = Math.min(this.dx, this.dz)
    for (let idx = 0; idx < this.cellK.length; idx++) {
      const depth = this.cellDepth[idx]!
      if (depth <= 0) {
        this.cellK[idx] = 0
        continue
      }
      const c = waveSpeedAt(depth, this.speedScale)
      const courant = (c * dt) / cellSize
      this.cellK[idx] = Math.min(0.24, courant * courant)
    }
    this.cellKDt = dt
    this.cellKScale = this.speedScale
  }

  /** Largest Courant number currently in use. Stays below 0.5 by construction. */
  maxCourant(dt: number): number {
    this.updateCellK(dt)
    let worst = 0
    for (let idx = 0; idx < this.cellK.length; idx++) {
      worst = Math.max(worst, Math.sqrt(this.cellK[idx]!))
    }
    return worst
  }

  /**
   * Add a gaussian bump to the surface. `strength` is the displacement in
   * metres at the centre; negative pushes the water down.
   *
   * The bump goes into *both* time levels. Writing only the current level would
   * leave the scheme reading an implied vertical velocity of strength/dt — tens
   * of metres per second for a centimetre-scale splash — and the field would
   * balloon far past the amplitude that was asked for. Displacing both levels
   * starts the disturbance at rest, so a 2 cm splash makes a 2 cm wave.
   * Mirrors waveStep.frag's splat term exactly.
   */
  splat(x: number, z: number, radius: number, strength: number): void {
    if (radius <= 0 || strength === 0) return
    const sigma = Math.max(radius, Math.min(this.dx, this.dz) * 0.75)
    const inv2Sigma2 = 1 / (2 * sigma * sigma)
    const reach = sigma * 3.5

    // Bounds are the cells whose *centres* fall inside the reach. Deriving them
    // that way keeps the stamped footprint mirror-symmetric about the centre;
    // rounding the two ends independently does not, and the extra tail cell on
    // one side shows up as a visibly lopsided wave.
    const i0 = clamp(Math.ceil(this.gridU(x - reach)), 0, this.cols - 1)
    const i1 = clamp(Math.floor(this.gridU(x + reach)), 0, this.cols - 1)
    const j0 = clamp(Math.ceil(this.gridV(z - reach)), 0, this.rows - 1)
    const j1 = clamp(Math.floor(this.gridV(z + reach)), 0, this.rows - 1)

    for (let j = j0; j <= j1; j++) {
      const dzz = this.rowZ(j) - z
      for (let i = i0; i <= i1; i++) {
        const dxx = this.colX(i) - x
        const d2 = dxx * dxx + dzz * dzz
        const idx = j * this.cols + i
        if (this.cellDepth[idx]! <= 0) continue
        const bump = strength * Math.exp(-d2 * inv2Sigma2)
        this.cur[idx]! += bump
        this.prev[idx]! += bump
      }
    }
  }

  /** Apply every splat in the queue. */
  applySplats(queue: SplatQueue): void {
    for (let i = 0; i < queue.length; i++) {
      const s = queue.at(i)
      this.splat(s.x, s.z, s.radius, s.strength)
    }
  }

  /**
   * Advance one step of the discrete wave equation.
   *
   * The spatial operator is the conservative form div(c^2 grad h) rather than
   * c^2 * laplacian(h). With a sloping floor the wave speed varies from row to
   * row, and only the conservative form keeps energy honest as a wave shoals
   * into the shallow end — the naive form quietly manufactures amplitude there.
   * Face weights are the average of the two cells either side.
   *
   * Damping is viscous: it sheds the surface's vertical rate rather than its
   * displacement, so the field's discrete energy falls monotonically.
   *
   * Boundaries clamp their neighbour lookups, giving a Neumann (fully
   * reflecting) condition: a pool wall bounces waves back rather than
   * swallowing them, and that ringing is a big part of reading as a pool.
   */
  step(dt: number): void {
    this.updateCellK(dt)
    this.lastDt = dt
    // Viscous damping acts on the surface's *rate*, not its displacement.
    // Scaling the whole update instead pulls a standing bump towards zero,
    // which manufactures vertical velocity out of nothing and drives the
    // field's energy up rather than down.
    const rateKeep = clamp(1 - this.damping * dt, 0, 1)
    const levelKeep = clamp(1 - this.levelDecay * dt, 0, 1)
    const { cols, rows, cur, prev, next, cellK, wetCells } = this

    for (let w = 0; w < wetCells.length; w++) {
      const idx = wetCells[w]!
      const i = idx % cols
      const j = (idx - i) / cols
      const h = cur[idx]!
      const k = cellK[idx]!

      // A neighbour off the edge of the domain is the cell itself, which makes
      // that face contribute nothing — the same reflecting wall the clamped
      // lookups used to give. A neighbour on land is a ghost cell holding the
      // water's own height, so it does the same thing.
      const left = i > 0 ? idx - 1 : idx
      const right = i < cols - 1 ? idx + 1 : idx
      const up = j > 0 ? idx - cols : idx
      const down = j < rows - 1 ? idx + cols : idx

      const divergence =
        faceWeight(k, cellK[left]!) * (cur[left]! - h) +
        faceWeight(k, cellK[right]!) * (cur[right]! - h) +
        faceWeight(k, cellK[up]!) * (cur[up]! - h) +
        faceWeight(k, cellK[down]!) * (cur[down]! - h)

      next[idx] = (h + (h - prev[idx]!) * rateKeep + divergence) * levelKeep
    }

    this.fillGhosts(next)

    // Bleed the DC level by scaling *both* time levels identically. Scaling
    // only the new one would leave a height difference across the pair, i.e. a
    // vertical velocity conjured out of a standing bump — the same mistake the
    // damping term above avoids.
    if (levelKeep !== 1) {
      for (let i = 0; i < cur.length; i++) cur[i]! *= levelKeep
    }

    const recycled = this.prev
    this.prev = this.cur
    this.cur = this.next
    this.next = recycled
  }

  /**
   * Discrete wave energy: kinetic from the height rate, potential from the
   * surface gradient. Without damping the scheme conserves this; with damping
   * it decays. That makes it the honest way to check the field is losing energy
   * rather than merely spreading a pulse over more cells, which is what a sum
   * of |h| would show.
   */
  energy(dt: number): number {
    this.updateCellK(dt)
    const { cols, rows, cur, prev, cellK, wetCells } = this
    const invDt2 = 1 / (dt * dt)
    let total = 0
    for (let w = 0; w < wetCells.length; w++) {
      const idx = wetCells[w]!
      const i = idx % cols
      const j = (idx - i) / cols
      const k = cellK[idx]!
      const h = cur[idx]!
      const hp = prev[idx]!
      const rate = (h - hp) / dt

      const right = i < cols - 1 ? idx + 1 : idx
      const down = j < rows - 1 ? idx + cols : idx
      // Gradient terms pair consecutive time levels. Squaring a single level
      // instead leaves the sum oscillating at the wave frequency: the scheme
      // stores height and rate half a step apart, and this staggered product
      // is the quantity it actually conserves.
      const dxCur = cur[right]! - h
      const dxPrev = prev[right]! - hp
      const dzCur = cur[down]! - h
      const dzPrev = prev[down]! - hp
      total +=
        rate * rate +
        invDt2 *
          (faceWeight(k, cellK[right]!) * dxCur * dxPrev +
            faceWeight(k, cellK[down]!) * dzCur * dzPrev)
    }
    return 0.5 * total
  }

  /** Continuous grid coordinate (may fall outside [0, cols-1] before clamping). */
  private gridU(x: number): number {
    return (x - this.centerX + this.width / 2) / this.dx - 0.5
  }

  private gridV(z: number): number {
    return (z - this.centerZ + this.depth / 2) / this.dz - 0.5
  }

  private texel(field: Float32Array, i: number, j: number): number {
    const ci = i < 0 ? 0 : i > this.cols - 1 ? this.cols - 1 : i
    const cj = j < 0 ? 0 : j > this.rows - 1 ? this.rows - 1 : j
    return field[cj * this.cols + ci]!
  }

  private bilinear(field: Float32Array, x: number, z: number): number {
    const u = this.gridU(x)
    const v = this.gridV(z)
    const i = Math.floor(u)
    const j = Math.floor(v)
    const fu = u - i
    const fv = v - j
    const a = this.texel(field, i, j)
    const b = this.texel(field, i + 1, j)
    const c = this.texel(field, i, j + 1)
    const d = this.texel(field, i + 1, j + 1)
    return (a + (b - a) * fu) * (1 - fv) + (c + (d - c) * fu) * fv
  }

  /** Surface height (metres above WATER_LEVEL) at a world position. */
  heightAt(x: number, z: number): number {
    return this.bilinear(this.cur, x, z)
  }

  /** Vertical velocity of the surface, metres/second. */
  verticalVelocityAt(x: number, z: number): number {
    if (this.lastDt <= 0) return 0
    return (this.bilinear(this.cur, x, z) - this.bilinear(this.prev, x, z)) / this.lastDt
  }

  /** Surface slope (dh/dx, dh/dz) by central difference. */
  slopeAt(x: number, z: number, out: { x: number; z: number }): void {
    const e = Math.min(this.dx, this.dz)
    out.x = (this.heightAt(x + e, z) - this.heightAt(x - e, z)) / (2 * e)
    out.z = (this.heightAt(x, z + e) - this.heightAt(x, z - e)) / (2 * e)
  }

  /** True unless the field contains a non-finite value (i.e. it has diverged). */
  isFinite(): boolean {
    for (let i = 0; i < this.cur.length; i++) {
      if (!Number.isFinite(this.cur[i]!)) return false
    }
    return true
  }

  /** Peak absolute height anywhere in the field. */
  peakAmplitude(): number {
    let peak = 0
    for (let i = 0; i < this.cur.length; i++) peak = Math.max(peak, Math.abs(this.cur[i]!))
    return peak
  }

  /**
   * Give every dry cell that touches water the average height of the water
   * beside it.
   *
   * With this in place the stencil needs no special case at a shore: reading a
   * ghost cell returns (for a straight wall) exactly the reading cell's own
   * height, so the face carries no flux and the wave reflects. Sampling gets
   * the same benefit — `heightAt` a centimetre off the island returns the
   * water's height instead of blending towards a dry zero.
   */
  private fillGhosts(field: Float32Array): void {
    const { cols, rows, ghostCells, cellDepth } = this
    for (let g = 0; g < ghostCells.length; g++) {
      const idx = ghostCells[g]!
      const i = idx % cols
      const j = (idx - i) / cols
      let sum = 0
      let count = 0
      if (i > 0 && cellDepth[idx - 1]! > 0) {
        sum += field[idx - 1]!
        count++
      }
      if (i < cols - 1 && cellDepth[idx + 1]! > 0) {
        sum += field[idx + 1]!
        count++
      }
      if (j > 0 && cellDepth[idx - cols]! > 0) {
        sum += field[idx - cols]!
        count++
      }
      if (j < rows - 1 && cellDepth[idx + cols]! > 0) {
        sum += field[idx + cols]!
        count++
      }
      field[idx] = count > 0 ? sum / count : 0
    }
  }

  reset(): void {
    this.cur.fill(0)
    this.prev.fill(0)
    this.next.fill(0)
  }
}

/**
 * Weight of the face between two cells.
 *
 * The average of the two, except against land: a dry cell's weight is zero and
 * averaging it in would halve the face and quietly absorb energy at every wall
 * instead of reflecting it.
 */
function faceWeight(own: number, neighbour: number): number {
  return neighbour > 0 ? 0.5 * (own + neighbour) : own
}

/** The single sloped basin this field described before there were two pools. */
function defaultDepthAt(_x: number, z: number): number {
  const t = clamp((z + POOL.depth / 2) / POOL.depth, 0, 1)
  return POOL.shallowDepth + (POOL.deepDepth - POOL.shallowDepth) * t
}
