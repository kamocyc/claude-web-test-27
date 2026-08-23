/**
 * A single disturbance injected into the water height field.
 *
 * Every source of interaction in the simulation — a floating body bobbing, a
 * swimmer's hand entering the water, a jet outlet, a droplet landing — speaks
 * this one language. Both the GPU field (for looks) and the CPU field (for
 * buoyancy) consume the exact same list each step, which is what keeps the
 * waves you see and the waves you feel in agreement.
 */
export interface WaveSplat {
  /** World X of the centre. */
  x: number
  /** World Z of the centre. */
  z: number
  /** Gaussian sigma in metres. */
  radius: number
  /** Height impulse in metres at the centre. Negative pushes water down. */
  strength: number
  /** Extra whitewater deposited at this spot, 0..1. */
  foam: number
}

/** Reusable buffer so the per-step splat list never allocates. */
export class SplatQueue {
  private readonly pool: WaveSplat[] = []
  private count = 0

  /** Queue a disturbance. Ignored when it carries no energy. */
  add(x: number, z: number, radius: number, strength: number, foam = 0): void {
    if (radius <= 0) return
    if (strength === 0 && foam === 0) return
    let splat = this.pool[this.count]
    if (splat === undefined) {
      splat = { x: 0, z: 0, radius: 0, strength: 0, foam: 0 }
      this.pool.push(splat)
    }
    splat.x = x
    splat.z = z
    splat.radius = radius
    splat.strength = strength
    splat.foam = foam
    this.count++
  }

  get length(): number {
    return this.count
  }

  at(i: number): WaveSplat {
    const splat = this.pool[i]
    if (splat === undefined) throw new RangeError(`splat index ${i} out of range`)
    return splat
  }

  clear(): void {
    this.count = 0
  }
}
