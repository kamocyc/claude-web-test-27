import type { Ramp } from '../core/world'
import { collideWithBox, collideWithRamp, type Box } from './Collide'
import type { WorldFeature } from './PhysicsWorld'
import type { RigidBody } from './RigidBody'

/** A solid axis-aligned block. Pushes; is never pushed. */
export class BoxObstacle implements WorldFeature {
  constructor(readonly box: Box) {}

  collide(body: RigidBody): void {
    collideWithBox(body, this.box)
  }
}

/**
 * A ramped pool entry.
 *
 * Nothing about climbing it is scripted: it is a contact like the deck, a
 * swimmer standing on it is held up by it exactly as they are by the paving,
 * and the walk controller does not know the difference. Walking back down into
 * the water works for the same reason.
 */
export class RampObstacle implements WorldFeature {
  constructor(readonly ramp: Ramp) {}

  collide(body: RigidBody): void {
    collideWithRamp(body, this.ramp)
  }
}
