import {
  BufferAttribute,
  Color,
  Mesh,
  MeshStandardMaterial,
  TorusGeometry,
  Vector3,
} from 'three'
import { DeformableShell } from '../physics/DeformableShell'
import { FloatingObject } from './FloatingObject'

const RING_RADIUS = 0.45
const TUBE_RADIUS = 0.11
/** Volume of a torus: 2 * pi^2 * R * r^2. */
const TORUS_VOLUME = 2 * Math.PI ** 2 * RING_RADIUS * TUBE_RADIUS ** 2
/** Proxy spheres, and therefore deformation nodes, around the tube. */
const NODES = 8

const PALETTES: [string, string][] = [
  ['#ff5d5d', '#fdf6ec'],
  ['#ffc23d', '#fdf6ec'],
  ['#4fc3f7', '#fdf6ec'],
  ['#7ed957', '#fdf6ec'],
]

/**
 * How hard the air inside pushes back, newtons per metre.
 *
 * Chosen from what it has to do rather than from a material property: a person
 * sitting in the ring puts something like six hundred newtons through three or
 * four nodes, and the tube should give about a third of its radius under that.
 * Two hundred newtons over 0.06 m is about three thousand.
 */
const RING_STIFFNESS = 3200
/** See ShellOptions.nodeMass — mostly the water a length of tube shifts. */
const RING_NODE_MASS = 3
const RING_DAMPING = 70
const RING_COUPLING = 2000

const _centre = new Vector3()
const _offset = new Vector3()

/**
 * An inflatable ring: a couple of kilos of vinyl around a hundred litres of
 * air. It rides very high, gets shoved around by the smallest wave, and rights
 * itself flat because whichever side dips gains buoyancy.
 *
 * It is also the one thing in the pool that is properly soft. The eight proxy
 * spheres round its tube are deformation nodes as well: press on one and it
 * gives, the give spreads to its neighbours and travels round the ring, and
 * because those same radii are what buoyancy integrates, the side that is
 * squashed is also the side that sits lower in the water.
 */
export class SwimRing extends FloatingObject {
  private readonly tube: Mesh
  private readonly restPositions: Float32Array

  constructor(palette = 0) {
    const spheres = []
    for (let i = 0; i < NODES; i++) {
      const angle = (i / NODES) * Math.PI * 2
      spheres.push({
        local: new Vector3(Math.cos(angle) * RING_RADIUS, 0, Math.sin(angle) * RING_RADIUS),
        radius: TUBE_RADIUS,
      })
    }

    super({
      mass: 2.1,
      spheres,
      // The proxy spheres only sample the tube; the real buoyant volume is the
      // whole torus, so state it rather than letting the spheres understate it.
      volume: TORUS_VOLUME,
      restitution: 0.45,
      dragCoefficient: 0.85,
      angularDamping: 2.6,
      splashThreshold: 0.9,
    })

    this.tube = SwimRing.buildMesh(palette)
    this.object.add(this.tube)
    this.object.name = 'swim-ring'

    const position = this.tube.geometry.attributes.position as BufferAttribute
    this.restPositions = Float32Array.from(position.array)

    // Sitting in the hole with the legs through it, which is what the ring is
    // for. The seat height puts the head well clear and the feet in the water.
    this.ride = { pose: 'sit', seatHeight: 0.3, radius: 0.62 }

    this.shell = new DeformableShell(this.body, {
      stiffness: RING_STIFFNESS,
      nodeMass: RING_NODE_MASS,
      damping: RING_DAMPING,
      coupling: RING_COUPLING,
      minScale: 0.4,
      maxScale: 1.15,
    })
  }

  /**
   * Push every vertex of the tube in or out to match the node it belongs to.
   *
   * A vertex knows which way round the ring it is from its own position, so the
   * mapping needs no extra attribute: find the point on the ring's centre
   * circle it belongs to, and scale its offset from that point by how squashed
   * the tube is there. Interpolating between the two nearest nodes is what makes
   * a dent look like a dent rather than an octagon.
   */
  protected override skin(shell: DeformableShell): void {
    const attribute = this.tube.geometry.attributes.position as BufferAttribute
    const array = attribute.array as Float32Array
    const rest = this.restPositions

    for (let v = 0; v < array.length; v += 3) {
      const x = rest[v]!
      const y = rest[v + 1]!
      const z = rest[v + 2]!

      const angle = Math.atan2(z, x)
      const turns = (angle / (Math.PI * 2) + 1) % 1
      const a = turns * NODES
      const i0 = Math.floor(a) % NODES
      const i1 = (i0 + 1) % NODES
      const f = a - Math.floor(a)
      const squash = shell.deflection[i0]! * (1 - f) + shell.deflection[i1]! * f

      _centre.set(Math.cos(angle) * RING_RADIUS, 0, Math.sin(angle) * RING_RADIUS)
      _offset.set(x - _centre.x, y, z - _centre.z)
      const scale = (TUBE_RADIUS + squash) / TUBE_RADIUS
      array[v] = _centre.x + _offset.x * scale
      array[v + 1] = _offset.y * scale
      array[v + 2] = _centre.z + _offset.z * scale
    }
    attribute.needsUpdate = true
    this.tube.geometry.computeVertexNormals()
  }

  /**
   * One torus rather than four arcs, because it has to be deformed as a single
   * surface. The banding that used to come from separate meshes is painted on
   * with vertex colours instead.
   */
  private static buildMesh(palette: number): Mesh {
    const [primary, secondary] = PALETTES[palette % PALETTES.length]!
    const geometry = new TorusGeometry(RING_RADIUS, TUBE_RADIUS, 12, 48)
    geometry.rotateX(-Math.PI / 2)

    const position = geometry.attributes.position as BufferAttribute
    const colors = new Float32Array(position.count * 3)
    const a = new Color(primary)
    const b = new Color(secondary)
    for (let i = 0; i < position.count; i++) {
      const angle = Math.atan2(position.getZ(i), position.getX(i))
      const quarter = Math.floor(((angle / (Math.PI * 2) + 1) % 1) * 4)
      const colour = quarter % 2 === 0 ? a : b
      colors[i * 3] = colour.r
      colors[i * 3 + 1] = colour.g
      colors[i * 3 + 2] = colour.b
    }
    geometry.setAttribute('color', new BufferAttribute(colors, 3))

    const mesh = new Mesh(
      geometry,
      new MeshStandardMaterial({ vertexColors: true, roughness: 0.4, metalness: 0.02 }),
    )
    mesh.castShadow = true
    return mesh
  }
}
