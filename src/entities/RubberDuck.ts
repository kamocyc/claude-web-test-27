import { ConeGeometry, Group, Mesh, MeshStandardMaterial, SphereGeometry, Vector3 } from 'three'
import { FloatingObject } from './FloatingObject'

const HULL_RADIUS = 0.12
const HULL_SPHERE = 0.115

/**
 * The giant inflatable duck.
 *
 * Its hull is four spheres in a horizontal ring with the head raised in front.
 * That spread is what rights it after a knock: tip the duck and the submerged
 * side gains displacement while the raised side loses it. A low centre of mass
 * would do nothing here — the proxy spheres define where buoyancy acts, and the
 * waterplane is what carries the restoring moment.
 */
export class RubberDuck extends FloatingObject {
  constructor() {
    const spheres = []
    for (let i = 0; i < 4; i++) {
      const angle = (i / 4) * Math.PI * 2 + Math.PI / 4
      spheres.push({
        local: new Vector3(Math.cos(angle) * HULL_RADIUS, 0, Math.sin(angle) * HULL_RADIUS),
        radius: HULL_SPHERE,
      })
    }
    spheres.push({ local: new Vector3(0, 0.17, 0.14), radius: 0.075 })

    super({
      mass: 2.6,
      spheres,
      restitution: 0.35,
      dragCoefficient: 0.75,
      angularDamping: 3,
      splashThreshold: 0.9,
    })

    this.object.add(RubberDuck.buildMesh())
    this.object.name = 'rubber-duck'
  }

  private static buildMesh(): Group {
    const group = new Group()
    const yellow = new MeshStandardMaterial({ color: '#ffd029', roughness: 0.42, metalness: 0.02 })
    const orange = new MeshStandardMaterial({ color: '#ff8a1f', roughness: 0.4, metalness: 0.02 })
    const dark = new MeshStandardMaterial({ color: '#1d1a17', roughness: 0.3, metalness: 0.05 })

    const body = new Mesh(new SphereGeometry(0.22, 24, 18), yellow)
    body.scale.set(1.15, 0.92, 1.3)
    body.position.y = 0.01
    body.castShadow = true
    group.add(body)

    // Tail, swept up at the back.
    const tail = new Mesh(new ConeGeometry(0.11, 0.24, 14), yellow)
    tail.rotation.x = -1.15
    tail.position.set(0, 0.13, -0.24)
    tail.castShadow = true
    group.add(tail)

    const neck = new Mesh(new SphereGeometry(0.075, 16, 12), yellow)
    neck.scale.set(1, 1.5, 1)
    neck.position.set(0, 0.13, 0.11)
    group.add(neck)

    const head = new Mesh(new SphereGeometry(0.115, 20, 16), yellow)
    head.position.set(0, 0.25, 0.14)
    head.castShadow = true
    group.add(head)

    const beak = new Mesh(new ConeGeometry(0.055, 0.13, 12), orange)
    beak.rotation.x = Math.PI / 2
    beak.position.set(0, 0.235, 0.25)
    group.add(beak)

    for (const side of [-1, 1]) {
      const eye = new Mesh(new SphereGeometry(0.019, 10, 8), dark)
      eye.position.set(side * 0.055, 0.285, 0.215)
      group.add(eye)
    }

    return group
  }
}
