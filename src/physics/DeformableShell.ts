import type { Vector3 } from 'three'
import { PHYSICS_DT } from '../core/config'
import type { RigidBody } from './RigidBody'

export interface ShellOptions {
  /**
   * How hard the trapped air pushes back, newtons per metre of squash. Set it
   * from what a known load should do: a rider's weight spread over three nodes
   * is a couple of hundred newtons each, and a swim ring should give about a
   * third of its tube radius under that.
   */
  stiffness: number
  /**
   * Effective mass of one node, kilograms.
   *
   * Far larger than the vinyl itself weighs, and it should be: a length of tube
   * moving in and out has to shove the water around it out of the way, and that
   * water outweighs the plastic by an order of magnitude. Using the vinyl's own
   * mass would put the wobble at twenty-odd hertz — invisible at a glance, and
   * close enough to the step rate to be explicitly integrated badly.
   */
  nodeMass: number
  /** Damping, newton-seconds per metre. */
  damping: number
  /**
   * Coupling between neighbouring nodes, newtons per metre.
   *
   * This is what makes it read as an inflatable rather than a row of unrelated
   * springs: press one side and the squash spreads to its neighbours and
   * travels round, because that is what the air inside does.
   */
  coupling: number
  /**
   * Which nodes are next to which. Defaults to a closed loop, which is what a
   * swim ring is.
   */
  neighbours?: number[][]
  /** Smallest and largest fraction of its own radius a node may reach. */
  minScale?: number
  maxScale?: number
}

/**
 * An inflatable, deforming under the loads it actually takes.
 *
 * The body stays a rigid body: what deforms is the set of proxy spheres, each
 * getting its own radial deflection driven by the contact impulses recorded on
 * it. That one choice is what makes the deformation physical rather than
 * decorative, because those radii are not just a drawing — buoyancy integrates
 * them for the displaced volume and the collision solver tests against them.
 *
 * The consequence is the interesting part. `applyBuoyancy` rescales the sphere
 * volumes every step so they still sum to the body's stated volume, so squashing
 * one side does not remove buoyancy, it *moves* it to the other side. That is
 * exactly what a sealed air chamber does, and it is why a swim ring tips and
 * settles low on the side somebody is sitting on without anybody writing down
 * that riders make rings tip.
 *
 * Inertia is not recomputed. It is built once from the resting radii, and at
 * the scale of squash an inflatable survives the error is a few per cent of a
 * tensor that is itself a sphere-set approximation.
 */
export class DeformableShell {
  /** Radial deflection of each node, metres. Negative is squashed. */
  readonly deflection: Float32Array
  private readonly velocity: Float32Array
  private readonly baseRadius: Float32Array
  /** Last contact direction per node, packed xyz. */
  private readonly axis: Float32Array
  private readonly neighbours: number[][]
  private readonly options: Required<Omit<ShellOptions, 'neighbours'>>

  constructor(body: RigidBody, options: ShellOptions) {
    const count = body.spheres.length
    this.deflection = new Float32Array(count)
    this.velocity = new Float32Array(count)
    this.baseRadius = Float32Array.from(body.spheres, (s) => s.radius)
    this.axis = new Float32Array(count * 3)
    this.neighbours = options.neighbours ?? DeformableShell.loop(count)
    this.options = {
      stiffness: options.stiffness,
      nodeMass: options.nodeMass,
      damping: options.damping,
      coupling: options.coupling,
      minScale: options.minScale ?? 0.45,
      maxScale: options.maxScale ?? 1.2,
    }
  }

  /** Neighbour lists for a closed ring of `count` nodes. */
  static loop(count: number): number[][] {
    const lists: number[][] = []
    for (let i = 0; i < count; i++) {
      lists.push([(i + count - 1) % count, (i + 1) % count])
    }
    return lists
  }

  /** Neighbour lists for a `cols` by `rows` grid, indexed row-major. */
  static grid(cols: number, rows: number): number[][] {
    const lists: number[][] = []
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const list: number[] = []
        if (i > 0) list.push(j * cols + i - 1)
        if (i < cols - 1) list.push(j * cols + i + 1)
        if (j > 0) list.push((j - 1) * cols + i)
        if (j < rows - 1) list.push((j + 1) * cols + i)
        lists.push(list)
      }
    }
    return lists
  }

  /** Resting radius of a node, before any squash. */
  restRadius(index: number): number {
    return this.baseRadius[index]!
  }

  /**
   * The direction the last load on a node came from, as a unit vector, or null
   * if nothing has pressed on it. Only bodies whose shape has an orientation —
   * a ball, rather than a tube — need it.
   *
   * Held over after the contact ends so the squash can spring back along the
   * axis it happened on rather than snapping to some other one.
   */
  loadAxis(index: number, out: Vector3): Vector3 | null {
    const base = index * 3
    out.set(this.axis[base]!, this.axis[base + 1]!, this.axis[base + 2]!)
    const length = out.length()
    if (length < 1e-6) return null
    return out.divideScalar(length)
  }

  /** Largest squash anywhere, metres. */
  get peak(): number {
    let peak = 0
    for (let i = 0; i < this.deflection.length; i++) {
      peak = Math.max(peak, Math.abs(this.deflection[i]!))
    }
    return peak
  }

  /**
   * Advance the deformation and write the new radii back onto the body.
   *
   * Reads the impulses the contact solver recorded this step and clears them,
   * so a node stops being squashed the moment whatever was pressing on it
   * stops.
   */
  update(body: RigidBody, dt: number): void {
    const { stiffness, nodeMass, damping, coupling, minScale, maxScale } = this.options
    const { deflection, velocity, baseRadius } = this
    // An impulse is a force times the step it was applied over. Recovering the
    // force that way keeps the squash the same whatever the step size is.
    const perImpulse = 1 / Math.max(dt, 1e-6)

    for (let i = 0; i < deflection.length; i++) {
      const load = body.sphereLoad[i]! * perImpulse
      if (load > 0) {
        const base = i * 3
        this.axis[base] = body.sphereLoadNormal[base]!
        this.axis[base + 1] = body.sphereLoadNormal[base + 1]!
        this.axis[base + 2] = body.sphereLoadNormal[base + 2]!
      }
      let spread = 0
      for (const j of this.neighbours[i]!) spread += deflection[j]! - deflection[i]!

      const force = -load - stiffness * deflection[i]! + coupling * spread - damping * velocity[i]!
      velocity[i]! += (force / nodeMass) * dt
      let next = deflection[i]! + velocity[i]! * dt

      const base = baseRadius[i]!
      const lowest = base * (minScale - 1)
      const highest = base * (maxScale - 1)
      if (next < lowest) {
        next = lowest
        velocity[i] = 0
      } else if (next > highest) {
        next = highest
        velocity[i] = 0
      }
      deflection[i] = next
      body.spheres[i]!.radius = base + next
    }

    body.clearLoads()
    body.syncDerived()
  }

  /** Put everything back the way it started. */
  reset(body: RigidBody): void {
    for (let i = 0; i < this.deflection.length; i++) {
      this.deflection[i] = 0
      this.velocity[i] = 0
      body.spheres[i]!.radius = this.baseRadius[i]!
    }
    body.clearLoads()
  }
}

/**
 * The largest step this shell can be integrated at before the explicit scheme
 * starts to ring. Used by the tests to check the tuning stays inside it.
 */
export function shellStableStep(options: ShellOptions): number {
  const omega = Math.sqrt(options.stiffness / options.nodeMass)
  return 2 / omega
}

/** True when a shell's tuning is comfortable at the simulation's fixed step. */
export function shellIsStable(options: ShellOptions): boolean {
  return shellStableStep(options) > PHYSICS_DT * 4
}
