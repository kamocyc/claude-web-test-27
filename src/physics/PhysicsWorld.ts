import type { Vector3 } from 'three'
import type { FlowField } from '../sim/FlowField'
import type { WaveFieldCPU } from '../sim/WaveFieldCPU'
import type { SplatQueue } from '../sim/WaveSplat'
import { applyBuoyancy, type BuoyancyOptions } from './Buoyancy'
import { collidePair, collideWithPool } from './Collide'
import type { RigidBody } from './RigidBody'

export interface PhysicsActor {
  body: RigidBody
  /** Buoyancy tuning for this actor. */
  buoyancy?: BuoyancyOptions
  /** Called before integration so entities can add their own forces. */
  applyControl?(dt: number, context: PhysicsContext): void
  /** Called after integration so entities can sync meshes / emit effects. */
  postStep?(dt: number, context: PhysicsContext): void
}

/** Per-burst overrides for droplets that are not an ordinary splash. */
export interface SplashOptions {
  /** Seconds a droplet lives. A fountain's have to outlast the whole flight. */
  life?: number
  /** Droplet diameter in metres. */
  size?: number
  /**
   * Spread of the launch speed, 0..1. An impact throws water at every speed at
   * once; a nozzle does not, and letting it would smear the column over three
   * metres of height instead of putting the top of it where the physics says.
   */
  speedJitter?: number
}

/**
 * Anything that can throw droplets. SprayParticles satisfies it structurally,
 * which keeps the physics layer from having to know about rendering.
 */
export interface SplashSink {
  emit(
    origin: Vector3,
    direction: Vector3,
    count: number,
    speed: number,
    spread?: number,
    options?: SplashOptions,
  ): void
}

/**
 * Something in the world that is not a rigid body but takes part in the
 * physics: the island, the slide's flume, a fountain's jet.
 *
 * All three want the same three moments — their own state, a force on the
 * bodies they touch, and a contact — so they share one interface rather than
 * each growing a hook of its own in the step loop.
 */
export interface WorldFeature {
  /** Own state and emitters: riders, droplets, the water running down a flume. */
  update?(dt: number, context: PhysicsContext): void
  /** Forces on a body it touches. Called in the force phase, before integration. */
  applyForces?(body: RigidBody, dt: number, context: PhysicsContext): void
  /** One-sided contacts. Called once per relaxation iteration, like the walls. */
  collide?(body: RigidBody): void
}

export interface PhysicsContext {
  water: WaveFieldCPU
  flow: FlowField
  splats: SplatQueue
  /** Present once the renderer is up; absent in headless tests. */
  splash: SplashSink | null
  elapsed: number
}

/**
 * Fixed-step world: forces, integration, then a few relaxation passes over the
 * contacts. Iterating contacts (rather than solving them simultaneously) is
 * plenty for a pool full of light, bouncy objects and keeps the solver short
 * enough to read.
 */
export class PhysicsWorld {
  readonly actors: PhysicsActor[] = []
  /** Fixed furniture: the island, the water slide, the fountains. */
  readonly features: WorldFeature[] = []
  /** Set by the app once particles exist. */
  splash: SplashSink | null = null
  /** Contact relaxation passes per step. */
  iterations = 3
  elapsed = 0

  constructor(
    readonly water: WaveFieldCPU,
    readonly flow: FlowField,
    readonly splats: SplatQueue,
  ) {}

  add(actor: PhysicsActor): PhysicsActor {
    this.actors.push(actor)
    return actor
  }

  remove(actor: PhysicsActor): void {
    const i = this.actors.indexOf(actor)
    if (i >= 0) this.actors.splice(i, 1)
  }

  addFeature<T extends WorldFeature>(feature: T): T {
    this.features.push(feature)
    return feature
  }

  step(dt: number): void {
    this.elapsed += dt
    const context: PhysicsContext = {
      water: this.water,
      flow: this.flow,
      splats: this.splats,
      splash: this.splash,
      elapsed: this.elapsed,
    }

    for (const feature of this.features) feature.update?.(dt, context)

    for (const actor of this.actors) {
      actor.body.clearForces()
      actor.applyControl?.(dt, context)
      applyBuoyancy(actor.body, this.water, this.flow, this.splats, dt, actor.buoyancy ?? {})
      for (const feature of this.features) feature.applyForces?.(actor.body, dt, context)
      // Last, so that everything pushing on this body is scaled by the same
      // added mass. See RigidBody.addedMassScale.
      actor.body.applyAddedMass()
    }

    for (const actor of this.actors) actor.body.integrate(dt)

    for (let iteration = 0; iteration < this.iterations; iteration++) {
      for (let i = 0; i < this.actors.length; i++) {
        const a = this.actors[i]!.body
        for (let j = i + 1; j < this.actors.length; j++) {
          collidePair(a, this.actors[j]!.body)
        }
      }
      for (const actor of this.actors) {
        collideWithPool(actor.body)
        for (const feature of this.features) feature.collide?.(actor.body)
      }
    }

    for (const actor of this.actors) actor.postStep?.(dt, context)
  }
}
