import {
  BoxGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  SphereGeometry,
  Vector3,
  type BufferAttribute,
} from 'three'
import { DeformableShell } from '../physics/DeformableShell'
import { FloatingObject } from './FloatingObject'

const _axis = new Vector3()
const _up = new Vector3(0, 1, 0)
const _turn = new Quaternion()

/**
 * An air mattress. Wide and flat, so it tracks the wave field closely: a swell
 * passing underneath tilts it end to end rather than lifting it as a lump.
 */
export class AirMattress extends FloatingObject {
  private readonly slab: Mesh
  private readonly restPositions: Float32Array

  constructor(color = '#4fd1c5') {
    const spheres = []
    for (let ix = -1; ix <= 1; ix++) {
      for (let iz = -1; iz <= 1; iz += 2) {
        spheres.push({ local: new Vector3(ix * 0.52, 0, iz * 0.26), radius: 0.15 })
      }
    }

    super({
      mass: 3.4,
      spheres,
      // A 1.7 x 0.75 x 0.16 m inflatable, mostly air.
      volume: 1.7 * 0.75 * 0.16 * 0.82,
      restitution: 0.25,
      dragCoefficient: 1.05,
      angularDamping: 3.4,
      splashThreshold: 0.8,
    })

    const built = AirMattress.buildMesh(color)
    this.object.add(built.group)
    this.slab = built.slab
    this.object.name = 'air-mattress'

    const position = this.slab.geometry.attributes.position as BufferAttribute
    this.restPositions = Float32Array.from(position.array)

    // Lying flat on top, the length of it.
    this.ride = { pose: 'ride', seatHeight: 0.22, radius: 0.8 }

    // Six nodes in a three-by-two lattice, coupled to their grid neighbours so
    // a weight in the middle dips the middle and the ends lift.
    this.shell = new DeformableShell(this.body, {
      stiffness: 2100,
      nodeMass: 4,
      damping: 75,
      coupling: 900,
      neighbours: DeformableShell.grid(2, 3),
      minScale: 0.5,
      maxScale: 1.1,
    })
  }

  /**
   * Sag the slab where the load is.
   *
   * The lattice is coarse — three nodes along, two across — so the mesh is
   * subdivided to match and each vertex takes a bilinear blend of the four
   * nodes around it. The underside follows at a third of the amount, which is
   * what an inflatable does: it thins where you press rather than moving down
   * as a plank.
   */
  protected override skin(shell: DeformableShell): void {
    const attribute = this.slab.geometry.attributes.position as BufferAttribute
    const array = attribute.array as Float32Array
    const rest = this.restPositions

    for (let v = 0; v < array.length; v += 3) {
      const x = rest[v]!
      const y = rest[v + 1]!
      const z = rest[v + 2]!
      // Grid coordinates: rows run along X at -0.52, 0, +0.52; columns across
      // Z at -0.26 and +0.26.
      const row = Math.min(Math.max((x / 0.52 + 1) * 0.5, 0), 1) * 2
      const col = Math.min(Math.max((z / 0.26 + 1) * 0.5, 0), 1)
      const r0 = Math.min(Math.floor(row), 1)
      const c0 = Math.min(Math.floor(col), 0)
      const fr = row - r0
      const fc = col - c0
      const sag =
        (shell.deflection[r0 * 2 + c0]! * (1 - fc) + shell.deflection[r0 * 2 + c0 + 1]! * fc) *
          (1 - fr) +
        (shell.deflection[(r0 + 1) * 2 + c0]! * (1 - fc) +
          shell.deflection[(r0 + 1) * 2 + c0 + 1]! * fc) *
          fr

      array[v] = x
      array[v + 1] = y + sag * (y > 0 ? 1 : 0.35)
      array[v + 2] = z
    }
    attribute.needsUpdate = true
    this.slab.geometry.computeVertexNormals()
  }

  private static buildMesh(color: string): { group: Group; slab: Mesh } {
    const group = new Group()
    const vinyl = new MeshStandardMaterial({ color, roughness: 0.44, metalness: 0.02 })
    const trim = new MeshStandardMaterial({ color: '#f6fbf9', roughness: 0.5 })

    // Subdivided so the sag has somewhere to happen.
    const slab = new Mesh(new BoxGeometry(1.5, 0.13, 0.68, 12, 1, 6), vinyl)
    slab.castShadow = true
    group.add(slab)

    // Rolled edges along the long sides.
    for (const side of [-1, 1]) {
      const roll = new Mesh(new CylinderGeometry(0.085, 0.085, 1.62, 12), vinyl)
      roll.rotation.z = Math.PI / 2
      roll.position.set(0, 0.008, side * 0.34)
      roll.castShadow = true
      group.add(roll)
    }

    // Ribs, so the surface is not a blank slab.
    for (let i = -2; i <= 2; i++) {
      const rib = new Mesh(new BoxGeometry(0.045, 0.145, 0.66), trim)
      rib.position.set(i * 0.3, 0.004, 0)
      group.add(rib)
    }

    // A raised pillow at one end.
    const pillow = new Mesh(new BoxGeometry(0.34, 0.11, 0.58), vinyl)
    pillow.position.set(0.65, 0.1, 0)
    pillow.castShadow = true
    group.add(pillow)

    return { group, slab }
  }
}

const BALL_RADIUS = 0.24

/**
 * A beach ball. Almost weightless, so it skitters across the surface with the
 * current and bounces off everything.
 */
export class BeachBall extends FloatingObject {
  /** Outer frame carries the squash; the inner one undoes its rotation. */
  private readonly squashFrame = new Group()
  private readonly gores = new Group()

  constructor() {
    super({
      mass: 0.22,
      spheres: [{ local: new Vector3(), radius: BALL_RADIUS }],
      restitution: 0.72,
      dragCoefficient: 0.6,
      angularDamping: 0.5,
      splashThreshold: 0.7,
    })

    this.gores.add(BeachBall.buildMesh())
    this.squashFrame.add(this.gores)
    this.object.add(this.squashFrame)
    this.object.name = 'beach-ball'

    this.shell = new DeformableShell(this.body, {
      stiffness: 3000,
      nodeMass: 1.2,
      damping: 60,
      coupling: 0,
      neighbours: [[]],
      minScale: 0.55,
      maxScale: 1.05,
    })
  }

  /**
   * Flatten against whatever it hit.
   *
   * One node means one number, so the direction has to come from the contact
   * itself: the ball squashes along the normal it was struck on and swells at
   * right angles to it, keeping its volume. The rotation is applied and then
   * undone inside it, so the painted gores stay where they are on the ball
   * while the shape changes around them.
   */
  protected override skin(shell: DeformableShell): void {
    const squash = shell.deflection[0]!
    const along = (BALL_RADIUS + squash) / BALL_RADIUS
    const across = 1 / Math.sqrt(along)

    if (shell.loadAxis(0, _axis) === null || Math.abs(squash) < 1e-4) {
      this.squashFrame.scale.setScalar(1)
      this.gores.quaternion.identity()
      this.squashFrame.quaternion.identity()
      return
    }

    _turn.setFromUnitVectors(_up, _axis)
    this.squashFrame.quaternion.copy(_turn)
    this.gores.quaternion.copy(_turn).invert()
    this.squashFrame.scale.set(across, along, across)
  }

  private static buildMesh(): Group {
    const group = new Group()
    const colors = ['#ff5252', '#ffd54f', '#4fc3f7', '#81c784', '#fdf6ec', '#ba68c8']

    // Six gores, each a thin lune of the sphere.
    for (let i = 0; i < colors.length; i++) {
      const geometry = new SphereGeometry(
        BALL_RADIUS,
        10,
        14,
        (i / colors.length) * Math.PI * 2,
        (Math.PI * 2) / colors.length,
      )
      const mesh = new Mesh(
        geometry,
        new MeshStandardMaterial({ color: colors[i]!, roughness: 0.35, metalness: 0.03 }),
      )
      mesh.castShadow = true
      group.add(mesh)
    }
    return group
  }
}
