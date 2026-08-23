import {
  BoxGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  SphereGeometry,
  Vector3,
} from 'three'
import { FloatingObject } from './FloatingObject'

/**
 * An air mattress. Wide and flat, so it tracks the wave field closely: a swell
 * passing underneath tilts it end to end rather than lifting it as a lump.
 */
export class AirMattress extends FloatingObject {
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

    this.object.add(AirMattress.buildMesh(color))
    this.object.name = 'air-mattress'
  }

  private static buildMesh(color: string): Group {
    const group = new Group()
    const vinyl = new MeshStandardMaterial({ color, roughness: 0.44, metalness: 0.02 })
    const trim = new MeshStandardMaterial({ color: '#f6fbf9', roughness: 0.5 })

    const slab = new Mesh(new BoxGeometry(1.5, 0.13, 0.68), vinyl)
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

    return group
  }
}

/**
 * A beach ball. Almost weightless, so it skitters across the surface with the
 * current and bounces off everything.
 */
export class BeachBall extends FloatingObject {
  constructor() {
    super({
      mass: 0.22,
      spheres: [{ local: new Vector3(), radius: 0.24 }],
      restitution: 0.72,
      dragCoefficient: 0.6,
      angularDamping: 0.5,
      splashThreshold: 0.7,
    })

    this.object.add(BeachBall.buildMesh())
    this.object.name = 'beach-ball'
  }

  private static buildMesh(): Group {
    const group = new Group()
    const colors = ['#ff5252', '#ffd54f', '#4fc3f7', '#81c784', '#fdf6ec', '#ba68c8']

    // Six gores, each a thin lune of the sphere.
    for (let i = 0; i < colors.length; i++) {
      const geometry = new SphereGeometry(
        0.24,
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
