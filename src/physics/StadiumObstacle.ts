import { collideInsideStadium, collideWithStadium } from './Collide'
import type { WorldFeature } from './PhysicsWorld'
import type { RigidBody } from './RigidBody'
import type { Stadium } from '../core/shapes'

/**
 * A solid stadium-shaped block standing in the pool — the island, in practice.
 *
 * It only ever pushes; nothing pushes back. That is the whole of it, which is
 * why it is a few lines rather than a static rigid body with an infinite mass
 * and an inertia tensor nobody would ever use.
 */
export class StadiumObstacle implements WorldFeature {
  constructor(
    readonly shape: Stadium,
    readonly topY: number,
  ) {}

  collide(body: RigidBody): void {
    collideWithStadium(body, this.shape, this.topY)
  }
}

/**
 * The complement: a stadium-shaped wall that keeps bodies *in*. The pool's
 * corners are filled to this outline, so the water is an even channel all the
 * way round the island.
 */
export class StadiumBank implements WorldFeature {
  constructor(
    readonly shape: Stadium,
    readonly topY: number,
  ) {}

  collide(body: RigidBody): void {
    collideInsideStadium(body, this.shape, this.topY)
  }
}
