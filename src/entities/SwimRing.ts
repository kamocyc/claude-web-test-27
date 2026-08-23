import { Group, Mesh, MeshStandardMaterial, TorusGeometry, Vector3 } from 'three'
import { FloatingObject } from './FloatingObject'

const RING_RADIUS = 0.45
const TUBE_RADIUS = 0.11
/** Volume of a torus: 2 * pi^2 * R * r^2. */
const TORUS_VOLUME = 2 * Math.PI ** 2 * RING_RADIUS * TUBE_RADIUS ** 2

const PALETTES: [string, string][] = [
  ['#ff5d5d', '#fdf6ec'],
  ['#ffc23d', '#fdf6ec'],
  ['#4fc3f7', '#fdf6ec'],
  ['#7ed957', '#fdf6ec'],
]

/**
 * An inflatable ring: a couple of kilos of vinyl around a hundred litres of
 * air. It rides very high, gets shoved around by the smallest wave, and rights
 * itself flat because whichever side dips gains buoyancy.
 */
export class SwimRing extends FloatingObject {
  constructor(palette = 0) {
    const spheres = []
    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2
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

    this.object.add(SwimRing.buildMesh(palette))
    this.object.name = 'swim-ring'
  }

  private static buildMesh(palette: number): Group {
    const group = new Group()
    const [primary, secondary] = PALETTES[palette % PALETTES.length]!

    const materials = [
      new MeshStandardMaterial({ color: primary, roughness: 0.4, metalness: 0.02 }),
      new MeshStandardMaterial({ color: secondary, roughness: 0.45, metalness: 0.02 }),
    ]

    // Four quarter-arcs in alternating colours, the way a beach ring is banded.
    for (let i = 0; i < 4; i++) {
      const geometry = new TorusGeometry(RING_RADIUS, TUBE_RADIUS, 14, 24, Math.PI / 2)
      geometry.rotateX(-Math.PI / 2)
      geometry.rotateY(-(i * Math.PI) / 2)
      const mesh = new Mesh(geometry, materials[i % 2]!)
      mesh.castShadow = true
      group.add(mesh)
    }
    return group
  }
}
