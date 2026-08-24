import {
  CapsuleGeometry,
  Color,
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  SphereGeometry,
  Vector3,
} from 'three'
import { WATER_LEVEL } from '../core/config'
import type { PhysicsContext } from '../physics/PhysicsWorld'
import { FloatingObject } from './FloatingObject'

/**
 * What the body is doing with itself.
 *
 * `swim` is the stroke that drives everything; `stand` is a person on their
 * feet, used for the walk up the slide's steps; `ride` is prone and streamlined
 * in the flume, where the slide's shape does the steering and the swimmer only
 * has to keep from tumbling.
 */
export type SwimmerPose = 'swim' | 'stand' | 'ride'

export interface SwimmerColors {
  skin: string
  suit: string
  cap: string
}

const DEFAULT_COLORS: SwimmerColors[] = [
  { skin: '#e6b98f', suit: '#e8453c', cap: '#f2f4f6' },
  { skin: '#8d5a3b', suit: '#2f6fd0', cap: '#ffd93d' },
  { skin: '#f0cdae', suit: '#28b487', cap: '#2b2f36' },
  { skin: '#5c3a26', suit: '#ff9f1c', cap: '#f2f4f6' },
  { skin: '#d9a273', suit: '#8e44ad', cap: '#4fd1c5' },
]

const _forward = new Vector3()
const _localUp = new Vector3()
const _worldUp = new Vector3(0, 1, 0)
const _axis = new Vector3()
const _torque = new Vector3()
const _thrust = new Vector3()
const _handWorld = new Vector3()
const _handPrevious = new Vector3()
const _emitDir = new Vector3()
const _quat = new Quaternion()

/** Signed shortest angle from `from` to `to`. */
function angleDelta(from: number, to: number): number {
  let delta = (to - from) % (Math.PI * 2)
  if (delta > Math.PI) delta -= Math.PI * 2
  if (delta < -Math.PI) delta += Math.PI * 2
  return delta
}

/**
 * A swimmer, built from primitives and driven by forces rather than animated
 * along a path.
 *
 * The stroke is the engine: the arm phase decides when thrust is applied, so
 * the body surges with each pull and coasts between them. Because nothing is
 * kinematic, a swimmer gets carried by the current, rocked by passing waves,
 * and shoved by a swim ring, all without any of that being written down
 * anywhere. Hands entering the water emit their own splats and spray, which is
 * what leaves a wake behind someone doing lengths.
 */
export class Swimmer extends FloatingObject {
  /** Desired heading in world yaw radians (atan2(x, z) convention). */
  desiredHeading = 0
  /** 0 = drifting, 1 = full effort. */
  throttle = 0
  /** -1 dives, +1 climbs. */
  pitchInput = 0
  /** Extra push, held while sprinting. */
  sprint = 0
  /** Swimming, on their feet, or going down the slide. */
  pose: SwimmerPose = 'swim'

  readonly colors: SwimmerColors

  private phase = Math.random() * Math.PI * 2
  private readonly rig: {
    root: Group
    shoulders: [Group, Group]
    elbows: [Group, Group]
    hands: [Object3D, Object3D]
    hips: [Group, Group]
    knees: [Group, Group]
    head: Group
  }

  private readonly handPrevY: [number, number] = [1, 1]
  private kickTimer = 0

  constructor(palette = 0) {
    super({
      mass: 64,
      spheres: [
        { local: new Vector3(0, 0.03, 0.46), radius: 0.105 },
        { local: new Vector3(0, 0, 0.2), radius: 0.16 },
        { local: new Vector3(0, 0, -0.16), radius: 0.145 },
        { local: new Vector3(-0.085, 0, -0.46), radius: 0.105 },
        { local: new Vector3(0.085, 0, -0.46), radius: 0.105 },
        { local: new Vector3(-0.085, 0, -0.78), radius: 0.075 },
        { local: new Vector3(0.085, 0, -0.78), radius: 0.075 },
      ],
      // Slightly less dense than water, so a relaxed swimmer floats with their
      // back and the top of their head clear of the surface.
      volume: 0.0665,
      restitution: 0.12,
      // Low, because a prone body is streamlined and because the proxy spheres
      // sit in a line: summing their cross-sections badly overstates the real
      // frontal area.
      dragCoefficient: 0.2,
      angularDamping: 2.2,
      splashThreshold: 1.4,
      buoyancy: { wakeStrength: 1.35 },
    })

    this.colors = DEFAULT_COLORS[palette % DEFAULT_COLORS.length]!
    this.rig = this.buildRig()
    this.object.name = 'swimmer'
  }

  /** Aim the swimmer along a world direction without spinning them into it. */
  faceDirection(x: number, z: number): void {
    this.desiredHeading = Math.atan2(x, z)
    _quat.setFromAxisAngle(_worldUp, this.desiredHeading)
    this.body.quaternion.copy(_quat)
    this.body.syncDerived()
  }

  get speed(): number {
    return Math.hypot(this.body.velocity.x, this.body.velocity.z)
  }

  /** Stroke phase in radians, for anything that wants to sync to the rhythm. */
  get strokePhase(): number {
    return this.phase
  }

  applyControl(dt: number, context: PhysicsContext): void {
    if (this.pose !== 'swim') {
      this.holdPose(dt, context)
      return
    }

    const effort = Math.min(1, this.throttle * (1 + this.sprint * 0.55))

    // Stroke rate rises with effort; a drifting swimmer still sculls gently.
    const rate = 1.1 + effort * 3.4
    this.phase = (this.phase + rate * dt) % (Math.PI * 2)

    _forward.set(0, 0, 1).applyQuaternion(this.body.quaternion)

    // Thrust pulses with the catch-and-pull half of each arm cycle. Both arms
    // are half a cycle apart, so the sum is a steady beat rather than a stall.
    const pullLeft = Math.max(0, Math.sin(this.phase))
    const pullRight = Math.max(0, Math.sin(this.phase + Math.PI))
    const kick = 0.35 + 0.65 * Math.abs(Math.sin(this.phase * 2))
    const stroke = (pullLeft + pullRight) * 0.75 + kick * 0.35

    const wet = Math.min(1, Math.max(0, (WATER_LEVEL + 0.25 - this.body.position.y) / 0.5))
    const thrustMagnitude = 260 * effort * stroke * wet
    _thrust.copy(_forward).multiplyScalar(thrustMagnitude)
    this.body.addForce(_thrust)

    // Diving and surfacing.
    if (this.pitchInput !== 0) {
      this.body.force.y += this.pitchInput * 420 * wet
    }

    // Keeping your head up. A swimmer is barely lighter than the water they
    // displace, and the wave-radiation drag that stops a float bobbing for ever
    // also means buoyancy alone takes the best part of a minute to bring
    // someone back up from half a metre down. Anyone who has been pushed under
    // — by a wave, by a bad landing off the slide — kicks for the surface, so
    // this is a control input like the stroke, not a correction to the physics:
    // it fades to nothing as the head reaches the air.
    const head = this.body.worldSpheres[0]!
    const headDepth = WATER_LEVEL + context.water.heightAt(head.x, head.z) - head.y
    if (headDepth > 0.02) {
      this.body.force.y += Math.min(headDepth, 0.5) * 1200
    }

    // --- Attitude control -----------------------------------------------------
    // Swimmers hold themselves level and point where they are going; both are
    // torques so waves and collisions can still knock them about.
    _torque.setScalar(0)

    const currentHeading = Math.atan2(_forward.x, _forward.z)
    const headingError = angleDelta(currentHeading, this.desiredHeading)
    _torque.y += headingError * 26 - this.body.angularVelocity.y * 11

    _localUp.set(0, 1, 0).applyQuaternion(this.body.quaternion)
    _axis.copy(_localUp).cross(_worldUp)
    _torque.addScaledVector(_axis, 42 * wet)
    _torque.x -= this.body.angularVelocity.x * 14
    _torque.z -= this.body.angularVelocity.z * 14

    this.body.addTorque(_torque)

    this.animate(dt, effort, context)
  }

  /**
   * Off the water: no stroke, no thrust, just enough attitude control to stay
   * the right way up.
   *
   * A rider in the flume is an ordinary rigid body — the trough steers them and
   * gravity accelerates them — but a body with no way to brace itself tumbles
   * on the first bump and arrives head down. This is the bracing: the same
   * levelling torque the swimmer uses in the water, applied while they are
   * dry, and nothing else. It cannot drive them along, so the ride is still
   * entirely the slide's doing.
   */
  private holdPose(dt: number, context: PhysicsContext): void {
    if (this.pose === 'ride' && this.body.dynamic) {
      _localUp.set(0, 1, 0).applyQuaternion(this.body.quaternion)
      _axis.copy(_localUp).cross(_worldUp)
      _torque.copy(_axis).multiplyScalar(30)
      _torque.x -= this.body.angularVelocity.x * 9
      _torque.y -= this.body.angularVelocity.y * 6
      _torque.z -= this.body.angularVelocity.z * 9
      this.body.addTorque(_torque)
    }
    this.animate(dt, 0, context)
  }

  /** Drive the visual rig and let the limbs talk back to the water. */
  private animate(dt: number, effort: number, context: PhysicsContext): void {
    const { root, shoulders, elbows, hips, knees, head } = this.rig

    if (this.pose !== 'swim') {
      // Standing turns the whole rig upright: it is built lying along +Z, so a
      // quarter turn about X puts the head above the hips.
      root.rotation.x = this.pose === 'stand' ? -Math.PI / 2 : 0
      const stand = this.pose === 'stand'
      for (let side = 0; side < 2; side++) {
        // Every limb hangs along -Z from its joint, so standing needs the
        // joints at rest: the quarter turn above already points them at the
        // ground. Riding puts the arms overhead, which is +Z, half a turn away.
        shoulders[side]!.rotation.x = stand ? -0.12 : Math.PI
        elbows[side]!.rotation.x = stand ? -0.18 : -0.05
        hips[side]!.rotation.x = stand ? 0.05 : 0.05
        knees[side]!.rotation.x = stand ? -0.05 : -0.08
      }
      head.rotation.set(0, 0, 0)
      this.object.updateMatrixWorld(true)
      return
    }
    root.rotation.x = 0

    for (let side = 0; side < 2; side++) {
      const armPhase = this.phase + (side === 0 ? 0 : Math.PI)
      shoulders[side]!.rotation.x = armPhase
      // Elbow tucks through the recovery, straightens for the catch.
      const recovery = Math.max(0, -Math.sin(armPhase))
      elbows[side]!.rotation.x = -0.15 - recovery * 1.15

      const legPhase = this.phase * 2 + (side === 0 ? 0 : Math.PI)
      const amplitude = 0.18 + effort * 0.24
      hips[side]!.rotation.x = Math.sin(legPhase) * amplitude
      knees[side]!.rotation.x = -0.12 - Math.max(0, Math.sin(legPhase + 0.9)) * 0.55
    }

    // A breath every other stroke, rolling the head to the side.
    head.rotation.y = Math.sin(this.phase) * 0.34 * effort
    head.rotation.z = Math.sin(this.phase) * 0.16 * effort

    this.object.updateMatrixWorld(true)
    this.emitStrokeEffects(dt, effort, context)
  }

  /**
   * Hand entries and kicks disturb the water.
   *
   * Both go through the ordinary splat queue, so the ripples a swimmer leaves
   * are the same waves that push the floats around — there is no separate
   * "wake" system to keep in sync.
   */
  private emitStrokeEffects(dt: number, effort: number, context: PhysicsContext): void {
    const { hands } = this.rig

    for (let side = 0; side < 2; side++) {
      hands[side]!.getWorldPosition(_handWorld)
      const surface = WATER_LEVEL + context.water.heightAt(_handWorld.x, _handWorld.z)
      const previous = this.handPrevY[side]!
      this.handPrevY[side] = _handWorld.y - surface

      // Crossing the surface downwards is the catch: the loudest moment of the
      // stroke and the one that throws spray forward.
      if (previous > 0 && _handWorld.y - surface <= 0) {
        // The catch is the loudest moment of the stroke, and it is one of the
        // main things making the wake. Event-driven impulses like this — rather
        // than the continuous wake term in Buoyancy — are where the waves
        // should come from: they are one-shot and volume-neutral, so making
        // them emphatic cannot destabilise the level.
        const bite = 0.014 + effort * 0.036
        context.splats.addImpulse(_handWorld.x, _handWorld.z, 0.2, bite, 0.3 + effort * 0.3)
        if (context.splash && effort > 0.15) {
          _emitDir.set(0, 1, 0).addScaledVector(_forward, 0.35).normalize()
          _handPrevious.set(_handWorld.x, surface, _handWorld.z)
          context.splash.emit(_handPrevious, _emitDir, Math.round(5 + effort * 13), 1.05 + effort * 1.35, 0.8)
        }
      }
    }

    // Flutter kick: a churn of small splats behind the swimmer whenever the
    // feet are near enough to the surface to break it.
    this.kickTimer -= dt
    if (this.kickTimer <= 0 && effort > 0.12) {
      this.kickTimer = 0.055
      const feetLeft = this.body.worldSpheres[5]!
      const feetRight = this.body.worldSpheres[6]!
      for (const foot of [feetLeft, feetRight]) {
        const surface = WATER_LEVEL + context.water.heightAt(foot.x, foot.z)
        if (foot.y > surface - 0.22) {
          context.splats.addImpulse(foot.x, foot.z, 0.15, 0.012 * effort, 0.28 * effort)
          if (context.splash && Math.random() < 0.5 + effort * 0.4) {
            _emitDir.set(0, 1, 0).addScaledVector(_forward, -0.5).normalize()
            _handPrevious.set(foot.x, surface, foot.z)
            context.splash.emit(_handPrevious, _emitDir, 2 + Math.round(effort * 5), 1 + effort * 1.1, 0.95)
          }
        }
      }
    }
  }

  private buildRig() {
    const { skin, suit, cap } = this.colors
    const skinMaterial = new MeshStandardMaterial({ color: new Color(skin), roughness: 0.62 })
    const suitMaterial = new MeshStandardMaterial({ color: new Color(suit), roughness: 0.5 })
    const capMaterial = new MeshStandardMaterial({ color: new Color(cap), roughness: 0.34 })

    const root = new Group()
    this.object.add(root)

    const limb = (radius: number, length: number, material: MeshStandardMaterial) => {
      const geometry = new CapsuleGeometry(radius, length, 6, 12)
      // Capsules are built along Y; the whole rig works in +Z, so turn them and
      // shift the origin to the joint rather than the middle.
      geometry.rotateX(Math.PI / 2)
      geometry.translate(0, 0, -length / 2)
      const mesh = new Mesh(geometry, material)
      mesh.castShadow = true
      return mesh
    }

    // Torso, running from the hips forward to the shoulders.
    const torsoGeometry = new CapsuleGeometry(0.145, 0.44, 8, 16)
    torsoGeometry.rotateX(Math.PI / 2)
    const torso = new Mesh(torsoGeometry, suitMaterial)
    torso.position.set(0, 0, 0.03)
    torso.scale.set(1.15, 0.86, 1)
    torso.castShadow = true
    root.add(torso)

    const hipBlock = new Mesh(new SphereGeometry(0.15, 14, 12), suitMaterial)
    hipBlock.scale.set(1.1, 0.8, 1)
    hipBlock.position.set(0, 0, -0.2)
    hipBlock.castShadow = true
    root.add(hipBlock)

    // Head, on its own group so it can roll to breathe.
    const head = new Group()
    head.position.set(0, 0.04, 0.36)
    root.add(head)
    const skull = new Mesh(new SphereGeometry(0.105, 18, 14), skinMaterial)
    skull.position.z = 0.08
    skull.castShadow = true
    head.add(skull)
    const swimCap = new Mesh(new SphereGeometry(0.109, 18, 14, 0, Math.PI * 2, 0, Math.PI * 0.62), capMaterial)
    swimCap.position.z = 0.08
    swimCap.rotation.x = -0.35
    head.add(swimCap)

    const shoulders: [Group, Group] = [new Group(), new Group()]
    const elbows: [Group, Group] = [new Group(), new Group()]
    const hands: [Object3D, Object3D] = [new Object3D(), new Object3D()]
    const hips: [Group, Group] = [new Group(), new Group()]
    const knees: [Group, Group] = [new Group(), new Group()]

    for (let side = 0; side < 2; side++) {
      const sign = side === 0 ? -1 : 1

      const shoulder = shoulders[side]!
      shoulder.position.set(sign * 0.16, 0.02, 0.22)
      root.add(shoulder)
      shoulder.add(limb(0.052, 0.28, skinMaterial))

      const elbow = elbows[side]!
      elbow.position.set(0, 0, -0.3)
      shoulder.add(elbow)
      elbow.add(limb(0.042, 0.26, skinMaterial))

      const hand = hands[side]!
      hand.position.set(0, 0, -0.3)
      elbow.add(hand)
      const palm = new Mesh(new SphereGeometry(0.05, 10, 8), skinMaterial)
      palm.scale.set(1, 0.45, 1.25)
      hand.add(palm)

      const hip = hips[side]!
      hip.position.set(sign * 0.085, 0, -0.24)
      root.add(hip)
      hip.add(limb(0.068, 0.32, skinMaterial))

      const knee = knees[side]!
      knee.position.set(0, 0, -0.34)
      hip.add(knee)
      knee.add(limb(0.05, 0.32, skinMaterial))

      const foot = new Mesh(new SphereGeometry(0.06, 10, 8), skinMaterial)
      foot.scale.set(0.8, 0.5, 1.5)
      foot.position.set(0, -0.01, -0.38)
      knee.add(foot)
    }

    return { root, shoulders, elbows, hands, hips, knees, head }
  }
}
