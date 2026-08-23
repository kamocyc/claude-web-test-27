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

/**
 * Anything that can throw droplets. SprayParticles satisfies it structurally,
 * which keeps the physics layer from having to know about rendering.
 */
export interface SplashSink {
  emit(origin: Vector3, direction: Vector3, count: number, speed: number, spread?: number): void
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

  step(dt: number): void {
    this.elapsed += dt
    const context: PhysicsContext = {
      water: this.water,
      flow: this.flow,
      splats: this.splats,
      splash: this.splash,
      elapsed: this.elapsed,
    }

    for (const actor of this.actors) {
      actor.body.clearForces()
      actor.applyControl?.(dt, context)
      applyBuoyancy(actor.body, this.water, this.flow, this.splats, dt, actor.buoyancy ?? {})
    }

    for (const actor of this.actors) actor.body.integrate(dt)

    for (let iteration = 0; iteration < this.iterations; iteration++) {
      for (let i = 0; i < this.actors.length; i++) {
        const a = this.actors[i]!.body
        for (let j = i + 1; j < this.actors.length; j++) {
          collidePair(a, this.actors[j]!.body)
        }
      }
      for (const actor of this.actors) collideWithPool(actor.body)
    }

    for (const actor of this.actors) actor.postStep?.(dt, context)
  }
}
