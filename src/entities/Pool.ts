import {
  BoxGeometry,
  BufferGeometry,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshStandardMaterial,
  Path,
  PlaneGeometry,
  Shape,
  ShapeGeometry,
  TorusGeometry,
  Vector3,
} from 'three'
import { POOL, POOL_HALF_D, POOL_HALF_W, WATER_LEVEL, floorYAt } from '../core/config'
import type { CausticsProjector } from '../render/CausticsProjector'
import { makeDeckTexture, makeTileTexture } from '../render/textures'

/**
 * The pool shell and its surroundings.
 *
 * The floor slopes from the shallow end to the deep end, which is what makes
 * the wave speed vary across the pool and gives the caustics somewhere to
 * stretch. Every surface below the water line receives caustics.
 */
export class Pool {
  readonly group = new Group()
  readonly interiorMaterial: MeshStandardMaterial
  readonly deckMaterial: MeshStandardMaterial
  readonly copingMaterial: MeshStandardMaterial

  constructor(caustics: CausticsProjector) {
    const tiles = makeTileTexture({ count: 8, repeat: 1 })
    tiles.repeat.set(POOL.width / 1.6, POOL.depth / 1.6)

    this.interiorMaterial = new MeshStandardMaterial({
      map: tiles,
      roughness: 0.32,
      metalness: 0.02,
      envMapIntensity: 0.5,
    })

    const deckTexture = makeDeckTexture()
    deckTexture.repeat.set(0.45, 0.45)
    this.deckMaterial = new MeshStandardMaterial({
      map: deckTexture,
      color: '#b9b2a4',
      roughness: 0.92,
      metalness: 0,
      envMapIntensity: 0.35,
    })

    this.copingMaterial = new MeshStandardMaterial({
      color: '#ddd8cd',
      roughness: 0.62,
      metalness: 0.02,
      envMapIntensity: 0.4,
    })

    this.group.add(this.buildFloor())
    for (const wall of this.buildWalls()) this.group.add(wall)
    this.group.add(this.buildDeck())
    this.group.add(this.buildCoping())
    this.group.add(this.buildLadder())
    this.group.add(this.buildSurroundings())

    // Only the wetted surfaces need caustics; the deck is above the water.
    caustics.attach(this.interiorMaterial)
  }

  /** Sloping tiled floor. */
  private buildFloor(): Mesh {
    const geometry = new PlaneGeometry(POOL.width, POOL.depth, 48, 30)
    geometry.rotateX(-Math.PI / 2)
    const position = geometry.attributes.position!
    for (let i = 0; i < position.count; i++) {
      position.setY(i, floorYAt(position.getZ(i)))
    }
    position.needsUpdate = true
    geometry.computeVertexNormals()

    const mesh = new Mesh(geometry, this.interiorMaterial)
    mesh.receiveShadow = true
    mesh.name = 'pool-floor'
    return mesh
  }

  /** Four tiled walls, following the floor slope where it matters. */
  private buildWalls(): Mesh[] {
    const top = WATER_LEVEL + POOL.copingHeight
    const walls: Mesh[] = []

    // Long walls run along Z, so their bottom edge follows the slope.
    for (const side of [-1, 1] as const) {
      const geometry = new PlaneGeometry(POOL.depth, 1, 30, 6)
      geometry.rotateY((side * Math.PI) / 2)
      const position = geometry.attributes.position!
      for (let i = 0; i < position.count; i++) {
        // Before displacement the plane spans z in [-D/2, D/2] and y in [-.5,.5].
        const z = position.getZ(i)
        const t = position.getY(i) + 0.5 // 0 at the bottom edge, 1 at the top
        position.setY(i, floorYAt(z) + t * (top - floorYAt(z)))
        position.setX(i, side * POOL_HALF_W)
      }
      position.needsUpdate = true
      geometry.computeVertexNormals()
      const mesh = new Mesh(geometry, this.interiorMaterial)
      mesh.receiveShadow = true
      walls.push(mesh)
    }

    // End walls are flat: the depth is constant along X.
    for (const side of [-1, 1] as const) {
      const depth = POOL.shallowDepth + (POOL.deepDepth - POOL.shallowDepth) * (side > 0 ? 1 : 0)
      const height = depth + POOL.copingHeight
      const geometry = new PlaneGeometry(POOL.width, height)
      geometry.rotateY(side > 0 ? Math.PI : 0)
      geometry.translate(0, top - height / 2, side * POOL_HALF_D)
      const mesh = new Mesh(geometry, this.interiorMaterial)
      mesh.receiveShadow = true
      walls.push(mesh)
    }

    return walls
  }

  /** Paved deck with a pool-shaped hole in it. */
  private buildDeck(): Mesh {
    const outerW = POOL_HALF_W + POOL.deckWidth
    const outerD = POOL_HALF_D + POOL.deckWidth

    const shape = new Shape()
    shape.moveTo(-outerW, -outerD)
    shape.lineTo(outerW, -outerD)
    shape.lineTo(outerW, outerD)
    shape.lineTo(-outerW, outerD)
    shape.closePath()

    const hole = new Path()
    hole.moveTo(-POOL_HALF_W, -POOL_HALF_D)
    hole.lineTo(-POOL_HALF_W, POOL_HALF_D)
    hole.lineTo(POOL_HALF_W, POOL_HALF_D)
    hole.lineTo(POOL_HALF_W, -POOL_HALF_D)
    hole.closePath()
    shape.holes.push(hole)

    const geometry = new ShapeGeometry(shape)
    geometry.rotateX(-Math.PI / 2)
    geometry.translate(0, WATER_LEVEL + POOL.copingHeight, 0)

    const mesh = new Mesh(geometry, this.deckMaterial)
    mesh.receiveShadow = true
    mesh.name = 'deck'
    return mesh
  }

  /** A pale lip around the water's edge, so the tiles do not meet the deck raw. */
  private buildCoping(): Mesh {
    const lip = 0.34
    const shape = new Shape()
    shape.moveTo(-POOL_HALF_W - lip, -POOL_HALF_D - lip)
    shape.lineTo(POOL_HALF_W + lip, -POOL_HALF_D - lip)
    shape.lineTo(POOL_HALF_W + lip, POOL_HALF_D + lip)
    shape.lineTo(-POOL_HALF_W - lip, POOL_HALF_D + lip)
    shape.closePath()

    const hole = new Path()
    hole.moveTo(-POOL_HALF_W, -POOL_HALF_D)
    hole.lineTo(-POOL_HALF_W, POOL_HALF_D)
    hole.lineTo(POOL_HALF_W, POOL_HALF_D)
    hole.lineTo(POOL_HALF_W, -POOL_HALF_D)
    hole.closePath()
    shape.holes.push(hole)

    const geometry = new ShapeGeometry(shape)
    geometry.rotateX(-Math.PI / 2)
    geometry.translate(0, WATER_LEVEL + POOL.copingHeight + 0.004, 0)

    const mesh = new Mesh(geometry, this.copingMaterial)
    mesh.receiveShadow = true
    return mesh
  }

  /** Stainless ladder at the deep end. */
  private buildLadder(): Group {
    const group = new Group()
    const metal = new MeshStandardMaterial({ color: '#cdd6da', roughness: 0.22, metalness: 0.9 })

    const railShape: BufferGeometry = new TorusGeometry(0.22, 0.028, 10, 24, Math.PI)
    for (const offset of [-0.3, 0.3]) {
      const top = new Mesh(railShape, metal)
      top.rotation.z = Math.PI / 2
      top.rotation.y = Math.PI / 2
      top.position.set(POOL_HALF_W - 0.28, WATER_LEVEL + POOL.copingHeight + 0.22, 2.4 + offset)
      top.castShadow = true
      group.add(top)

      const post = new Mesh(new CylinderGeometry(0.028, 0.028, 1.35, 10), metal)
      post.position.set(POOL_HALF_W - 0.5, WATER_LEVEL - 0.45, 2.4 + offset)
      post.castShadow = true
      group.add(post)
    }

    for (let i = 0; i < 3; i++) {
      const step = new Mesh(new CylinderGeometry(0.026, 0.026, 0.6, 8), metal)
      step.rotation.x = Math.PI / 2
      step.position.set(POOL_HALF_W - 0.5, WATER_LEVEL - 0.2 - i * 0.35, 2.4)
      step.castShadow = true
      group.add(step)
    }

    return group
  }

  /**
   * A clipped hedge beyond the deck and a pair of parasols.
   *
   * Without something out there the deck just stops and the horizon reads as a
   * flat grey band. A low hedge closes the space off and gives the reflection
   * pass something to put in the water.
   */
  private buildSurroundings(): Group {
    const group = new Group()
    const hedge = new MeshStandardMaterial({ color: '#3f6b3a', roughness: 0.95 })
    const deckTop = WATER_LEVEL + POOL.copingHeight

    const outerW = POOL_HALF_W + POOL.deckWidth
    const outerD = POOL_HALF_D + POOL.deckWidth
    const thickness = 0.7
    const height = 1.35

    const walls: [number, number, number, number][] = [
      [0, -outerD - thickness / 2, (outerW + thickness) * 2, thickness],
      [0, outerD + thickness / 2, (outerW + thickness) * 2, thickness],
      [-outerW - thickness / 2, 0, thickness, outerD * 2],
      [outerW + thickness / 2, 0, thickness, outerD * 2],
    ]
    for (const [x, z, sx, sz] of walls) {
      const mesh = new Mesh(new BoxGeometry(sx, height, sz), hedge)
      mesh.position.set(x, deckTop + height / 2, z)
      mesh.castShadow = true
      mesh.receiveShadow = true
      group.add(mesh)
    }

    const poleMaterial = new MeshStandardMaterial({ color: '#8a7a63', roughness: 0.7 })
    const canopyMaterial = new MeshStandardMaterial({
      color: '#f4f1e6',
      roughness: 0.85,
      side: DoubleSide,
    })
    for (const [x, z] of [
      [-POOL_HALF_W - 2.4, -2.8],
      [POOL_HALF_W + 2.4, 2.8],
    ] as [number, number][]) {
      const pole = new Mesh(new CylinderGeometry(0.045, 0.045, 2.4, 10), poleMaterial)
      pole.position.set(x, deckTop + 1.2, z)
      pole.castShadow = true
      group.add(pole)

      const canopy = new Mesh(new ConeGeometry(1.55, 0.55, 12, 1, true), canopyMaterial)
      canopy.position.set(x, deckTop + 2.35, z)
      canopy.castShadow = true
      group.add(canopy)
    }

    return group
  }

  /** Nearest point inside the pool walls, used when spawning objects. */
  static clampInside(point: Vector3, margin: number): Vector3 {
    point.x = Math.max(-POOL_HALF_W + margin, Math.min(POOL_HALF_W - margin, point.x))
    point.z = Math.max(-POOL_HALF_D + margin, Math.min(POOL_HALF_D - margin, point.z))
    return point
  }

  dispose(): void {
    this.interiorMaterial.map?.dispose()
    this.interiorMaterial.dispose()
    this.deckMaterial.map?.dispose()
    this.deckMaterial.dispose()
    this.copingMaterial.dispose()
  }
}
