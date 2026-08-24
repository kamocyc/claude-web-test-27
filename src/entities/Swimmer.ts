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
import { GRAVITY, WATER_LEVEL, clamp } from '../core/config'
import { groundYAt } from '../core/world'
import type { PhysicsContext } from '../physics/PhysicsWorld'
import { FloatingObject } from './FloatingObject'

/**
 * What the body is doing with itself.
 *
 * `swim` is the stroke that drives everything; `stand` is a person on their
 * feet — walking the deck between the two pools, or up the slide's steps;
 * `ride` is prone and braced, in the flume or lying on a mattress; `sit` is
 * upright with the legs hanging, which is how you are in a swim ring.
 *
 * Standing turns the *body* upright, not just the drawing of it. That matters
 * because the proxy spheres run head to toe: upright, they stack into a column
 * that stands on a ramp or a paving slab the way a person does, and the same
 * contacts that hold a swim ring up hold the swimmer up. Nothing about walking
 * out of the water is scripted as a result.
 */
export type SwimmerPose = 'swim' | 'stand' | 'ride' | 'sit'

/**
 * Water no deeper than this can be stood up in. Past it the floor is out of
 * reach and there is nothing to do but swim.
 */
const WADING_DEPTH = 1.05

/** How much of a surface's friction a pair of feet feels. See RigidBody. */
const WALKING_FRICTION = 0.12

/**
 * Height of the body's centre above the ground when standing. The proxy
 * spheres run from the head at +0.46 to the feet at -0.78, so this is where
 * the middle of that column sits once it is upright.
 */
const STANDING_HEIGHT = 0.86

/** Turns a prone body upright: local +Z (head) onto world +Y. */
const UPRIGHT = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2)

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
const _delta = new Quaternion()

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
  /**
   * Set while something else owns the pose — the slide, while it is walking
   * somebody up its steps or sending them down the flume. Everything else
   * lets the water and the ground decide.
   */
  poseLocked = false
  /** Raised for one step to push off the ground. */
  jumpRequested = false
  /** Raised to get off whatever is being ridden at the next opportunity. */
  dismountRequested = false

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
  private walkPhase = 0

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
    if (this.pose === 'stand' || this.pose === 'sit') _quat.multiply(UPRIGHT)
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
    if (!this.poseLocked) this.pose = this.readPose(context)
    if (this.pose === 'stand') {
      this.walk(dt, context)
      return
    }
    if (this.pose === 'sit') {
      // Upright, and nothing else: the seat holds them there and the paddling
      // goes into the float, not into them.
      _quat.setFromAxisAngle(_worldUp, this.desiredHeading).multiply(UPRIGHT)
      this.holdOrientation(_quat, 300, 60)
      this.animate(dt, 0, context)
      return
    }
    this.body.frictionScale = 1
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
   * Swimming or standing, decided by the ground rather than by a state machine.
   *
   * Two conditions, both about the world and neither about what the swimmer was
   * doing a moment ago: the water here is shallow enough to stand up in, and
   * the feet are close enough to the bottom to have reached it. Walking up the
   * entry ramp satisfies both about half way up; stepping off the edge of the
   * deck stops satisfying them immediately, and the swimmer falls in.
   */
  private readPose(context: PhysicsContext): SwimmerPose {
    const { x, z } = this.body.position
    const ground = groundYAt(x, z)
    const surface = WATER_LEVEL + context.water.heightAt(x, z)
    if (surface - ground > WADING_DEPTH) return 'swim'

    let lowest = Number.POSITIVE_INFINITY
    for (let i = 0; i < this.body.spheres.length; i++) {
      lowest = Math.min(lowest, this.body.worldSpheres[i]!.y - this.body.spheres[i]!.radius)
    }
    // Feet within reach of the ground, and not a metre under it: somebody who
    // has ended up inside a solid block is not standing on it, and pretending
    // otherwise would have them walking about inside the island.
    const clearance = lowest - ground
    return clearance < 0.35 && clearance > -0.5 ? 'stand' : 'swim'
  }

  /**
   * On their feet.
   *
   * The legs are a velocity servo, not a force: people walk at the speed they
   * intend to and the ground gives them whatever traction that needs, which is
   * both what it feels like and much better behaved than pushing with a fixed
   * force and letting friction sort it out. Everything else — being knocked
   * over by a wave washing up the ramp, sliding on a wet slope, falling in at
   * the edge — is still the contacts doing their job.
   */
  private walk(dt: number, context: PhysicsContext): void {
    const body = this.body
    body.frictionScale = WALKING_FRICTION

    // The legs, as a spring holding the body at standing height over whatever
    // is underfoot. Without it a swimmer cannot get up at all: turning upright
    // from prone swings the feet down into the ground, the contact cancels
    // exactly that rotation, and they lie there at eighty degrees off vertical
    // for as long as you care to watch. Applied at the centre of mass rather
    // than at the feet, because a lifting force at the feet of a body lying
    // flat tips it the wrong way — feet up, head down.
    const clearance = body.position.y - groundYAt(body.position.x, body.position.z)
    if (clearance < STANDING_HEIGHT) {
      const push = (STANDING_HEIGHT - clearance) * 55 - body.velocity.y * 9
      body.force.y += clamp(push, 0, GRAVITY * 3) * body.mass
    }
    const speed = (this.throttle > 0.1 ? 1.5 : 0) * (1 + this.sprint * 0.7)
    _thrust.set(
      Math.sin(this.desiredHeading) * speed - body.velocity.x,
      0,
      Math.cos(this.desiredHeading) * speed - body.velocity.z,
    )
    // Capped at about nine tenths of a g. It has to beat the entry ramp, whose
    // slope costs four metres a second squared on its own, and it is also the
    // only thing stopping a standing swimmer sliding back down it.
    const accel = _thrust.length() * 6
    if (accel > GRAVITY * 0.9) _thrust.setLength(GRAVITY * 0.9)
    else _thrust.multiplyScalar(6)
    body.force.addScaledVector(_thrust, body.mass)

    if (this.jumpRequested) {
      this.jumpRequested = false
      body.velocity.y = Math.max(body.velocity.y, 3.2)
      body.velocity.x += Math.sin(this.desiredHeading) * 1.4
      body.velocity.z += Math.cos(this.desiredHeading) * 1.4
    }

    _quat.setFromAxisAngle(_worldUp, this.desiredHeading).multiply(UPRIGHT)
    this.holdOrientation(_quat, 520, 90)

    this.walkPhase += dt * (1.6 + Math.hypot(body.velocity.x, body.velocity.z) * 1.9)
    this.animate(dt, 0, context)
  }

  /**
   * Torque towards an orientation, as one axis-angle error rather than a pair
   * of cross products.
   *
   * The prone swimmer only ever has to be levelled, which a single "roll my up
   * vector onto the world's" term does. Standing has to pin all three axes —
   * upright *and* facing somewhere — and doing that as two separate terms lets
   * them fight each other near the poles.
   */
  private holdOrientation(target: Quaternion, stiffness: number, damping: number): void {
    _delta.copy(this.body.quaternion).conjugate().premultiply(target)
    if (_delta.w < 0) _delta.set(-_delta.x, -_delta.y, -_delta.z, -_delta.w)
    const sin = Math.sqrt(Math.max(0, 1 - _delta.w * _delta.w))
    if (sin > 1e-5) {
      const angle = 2 * Math.acos(clamp(_delta.w, -1, 1))
      _axis.set(_delta.x, _delta.y, _delta.z).multiplyScalar(angle / sin)
      _torque.copy(_axis).multiplyScalar(stiffness)
    } else {
      _torque.setScalar(0)
    }
    _torque.addScaledVector(this.body.angularVelocity, -damping)
    this.body.addTorque(_torque)
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
      // The rig is never rotated any more: standing tips the body itself, so
      // the limbs only have to do what limbs do. Every one of them hangs along
      // -Z from its joint, which upright means straight down.
      root.rotation.x = 0
      const stand = this.pose === 'stand'
      const sit = this.pose === 'sit'
      const stride = stand ? Math.sin(this.walkPhase) * 0.5 : 0
      for (let side = 0; side < 2; side++) {
        const sign = side === 0 ? 1 : -1
        if (sit) {
          // Knees up and hands out, the way you sit in a ring.
          shoulders[side]!.rotation.x = -1.1
          elbows[side]!.rotation.x = -0.5
          hips[side]!.rotation.x = 1.15
          knees[side]!.rotation.x = -1.0
          continue
        }
        shoulders[side]!.rotation.x = stand ? -0.12 - stride * sign * 0.5 : Math.PI
        elbows[side]!.rotation.x = stand ? -0.18 : -0.05
        hips[side]!.rotation.x = stand ? 0.05 + stride * sign : 0.05
        knees[side]!.rotation.x = stand ? -0.05 - Math.max(0, stride * sign) * 0.9 : -0.08
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
