import {
  BoxGeometry,
  BufferGeometry,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  ExtrudeGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Path,
  PlaneGeometry,
  Shape,
  ShapeGeometry,
  SphereGeometry,
  TorusGeometry,
  Vector2,
  Vector3,
} from 'three'
import {
  ISLAND,
  ISLAND_TOP,
  POOL,
  RIVER,
  RIVER_BANK,
  POOL_HALF_D,
  POOL_HALF_W,
  WATER_LEVEL,
} from '../core/config'
import { clampToRing, stadiumDistance, type Stadium, type Vec2 } from '../core/shapes'
import {
  ALL_RAMPS,
  BASINS,
  CALM_POOL,
  DECK_TOP,
  GROUNDS,
  RIVER_POOL,
  basinDepthAt,
  floorYAt,
  rampCrest,
  rampHeightAt,
  type Basin,
  type Ramp,
} from '../core/world'
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

    for (const basin of BASINS) {
      this.group.add(this.buildFloor(basin))
      for (const wall of this.buildWalls(basin)) this.group.add(wall)
    }
    this.group.add(this.buildDeck())
    this.group.add(this.buildCornerFill())
    this.group.add(this.buildRiverCoping())
    this.group.add(this.buildRectangularCoping(CALM_POOL))
    this.group.add(this.buildIsland())
    this.group.add(this.buildLadder())
    for (const ramp of ALL_RAMPS) this.group.add(this.buildRamp(ramp))
    this.group.add(this.buildSurroundings())

    // Only the wetted surfaces need caustics; the deck is above the water.
    caustics.attach(this.interiorMaterial)
  }

  /** Sloping tiled floor for one basin. */
  private buildFloor(basin: Basin): Mesh {
    const width = basin.maxX - basin.minX
    const depth = basin.maxZ - basin.minZ
    const geometry = new PlaneGeometry(width, depth, 48, 30)
    geometry.rotateX(-Math.PI / 2)
    geometry.translate((basin.minX + basin.maxX) / 2, 0, (basin.minZ + basin.maxZ) / 2)
    const position = geometry.attributes.position!
    for (let i = 0; i < position.count; i++) {
      position.setY(i, floorYAt(position.getX(i), position.getZ(i)))
    }
    position.needsUpdate = true
    geometry.computeVertexNormals()

    const mesh = new Mesh(geometry, this.interiorMaterial)
    mesh.receiveShadow = true
    mesh.name = `${basin.name}-floor`
    return mesh
  }

  /** Four tiled walls for one basin, following the floor slope where it matters. */
  private buildWalls(basin: Basin): Mesh[] {
    const width = basin.maxX - basin.minX
    const depth = basin.maxZ - basin.minZ
    const centreX = (basin.minX + basin.maxX) / 2
    const centreZ = (basin.minZ + basin.maxZ) / 2
    const walls: Mesh[] = []

    // Long walls run along Z, so their bottom edge follows the slope.
    for (const side of [-1, 1] as const) {
      const wallX = side > 0 ? basin.maxX : basin.minX
      const geometry = new PlaneGeometry(depth, 1, 30, 6)
      geometry.rotateY((side * Math.PI) / 2)
      const position = geometry.attributes.position!
      for (let i = 0; i < position.count; i++) {
        // Before displacement the plane spans z in [-D/2, D/2] and y in [-.5,.5].
        const z = position.getZ(i) + centreZ
        const floor = WATER_LEVEL - basinDepthAt(basin, z)
        const t = position.getY(i) + 0.5 // 0 at the bottom edge, 1 at the top
        position.setY(i, floor + t * (DECK_TOP - floor))
        position.setX(i, wallX)
        position.setZ(i, z)
      }
      position.needsUpdate = true
      geometry.computeVertexNormals()
      const mesh = new Mesh(geometry, this.interiorMaterial)
      mesh.receiveShadow = true
      walls.push(mesh)
    }

    // End walls are flat: the depth is constant along X.
    for (const side of [-1, 1] as const) {
      const wallZ = side > 0 ? basin.maxZ : basin.minZ
      const height = basinDepthAt(basin, wallZ) + POOL.copingHeight
      const geometry = new PlaneGeometry(width, height)
      geometry.rotateY(side > 0 ? Math.PI : 0)
      geometry.translate(centreX, DECK_TOP - height / 2, wallZ)
      const mesh = new Mesh(geometry, this.interiorMaterial)
      mesh.receiveShadow = true
      walls.push(mesh)
    }

    return walls
  }

  /**
   * One slab of paving with a hole for each pool.
   *
   * The strip between the two holes is the walkway: it is ordinary deck, so
   * anyone standing on it is held up by the same plane that catches a rider
   * thrown off the flume.
   */
  private buildDeck(): Mesh {
    const shape = new Shape()
    shape.moveTo(GROUNDS.minX, GROUNDS.minZ)
    shape.lineTo(GROUNDS.maxX, GROUNDS.minZ)
    shape.lineTo(GROUNDS.maxX, GROUNDS.maxZ)
    shape.lineTo(GROUNDS.minX, GROUNDS.maxZ)
    shape.closePath()

    for (const basin of BASINS) {
      const hole = new Path()
      hole.moveTo(basin.minX, basin.minZ)
      hole.lineTo(basin.minX, basin.maxZ)
      hole.lineTo(basin.maxX, basin.maxZ)
      hole.lineTo(basin.maxX, basin.minZ)
      hole.closePath()
      shape.holes.push(hole)
    }

    const geometry = new ShapeGeometry(shape)
    geometry.rotateX(-Math.PI / 2)
    geometry.translate(0, DECK_TOP, 0)

    const mesh = new Mesh(geometry, this.deckMaterial)
    mesh.receiveShadow = true
    mesh.name = 'deck'
    return mesh
  }

  /** A pale lip around the river's edge, so the tiles do not meet the deck raw. */
  private buildRiverCoping(): Mesh {
    const lip = 0.34
    const shape = new Shape(stadiumOutline({ ...RIVER_BANK, radius: RIVER_BANK.radius + lip }, 20))
    const hole = new Path()
    hole.setFromPoints(stadiumOutline(RIVER_BANK, 20))
    shape.holes.push(hole)

    const geometry = new ShapeGeometry(shape, 4)
    geometry.rotateX(-Math.PI / 2)
    geometry.translate(RIVER_BANK.x, DECK_TOP + 0.004, RIVER_BANK.z)

    const mesh = new Mesh(geometry, this.copingMaterial)
    mesh.receiveShadow = true
    return mesh
  }

  /** The same lip, square, for a pool that is just a rectangle. */
  private buildRectangularCoping(basin: Basin): Mesh {
    const lip = 0.34
    const shape = new Shape()
    shape.moveTo(basin.minX - lip, basin.minZ - lip)
    shape.lineTo(basin.maxX + lip, basin.minZ - lip)
    shape.lineTo(basin.maxX + lip, basin.maxZ + lip)
    shape.lineTo(basin.minX - lip, basin.maxZ + lip)
    shape.closePath()

    const hole = new Path()
    hole.moveTo(basin.minX, basin.minZ)
    hole.lineTo(basin.minX, basin.maxZ)
    hole.lineTo(basin.maxX, basin.maxZ)
    hole.lineTo(basin.maxX, basin.minZ)
    hole.closePath()
    shape.holes.push(hole)

    const geometry = new ShapeGeometry(shape)
    geometry.rotateX(-Math.PI / 2)
    geometry.translate(0, DECK_TOP + 0.004, 0)

    const mesh = new Mesh(geometry, this.copingMaterial)
    mesh.receiveShadow = true
    mesh.name = `${basin.name}-coping`
    return mesh
  }

  /**
   * A ramped entry, drawn by evaluating the same surface function the contacts
   * use.
   *
   * Sampling the collision shape rather than modelling the mesh separately is
   * the point: what you can see you can stand on, and the hip where the front
   * slope meets a side slope lands in exactly the same place in both.
   */
  private buildRamp(ramp: Ramp): Mesh {
    const halfWidth = ramp.halfLength + ramp.run
    const geometry = new PlaneGeometry(halfWidth * 2, ramp.run, 48, 24)
    geometry.rotateX(-Math.PI / 2)
    geometry.translate(ramp.centreX, 0, ramp.wallZ + (ramp.into * ramp.run) / 2)

    const crest = rampCrest(ramp)
    const position = geometry.attributes.position!
    for (let i = 0; i < position.count; i++) {
      let x = position.getX(i)
      let z = position.getZ(i)
      // The footprint is a rounded rectangle round the crest, not the square
      // patch the grid starts as. Vertices outside it are pulled in onto the
      // toe rather than left flat, which is what stops the ramp reading as a
      // slab hanging above the floor at its corners.
      const distance = stadiumDistance(crest, x, z, _toe)
      if (distance > ramp.run) {
        x -= _toe.x * (distance - ramp.run)
        z -= _toe.z * (distance - ramp.run)
        position.setX(i, x)
        position.setZ(i, z)
      }
      position.setY(i, rampHeightAt(ramp, x, z) ?? ramp.bottomY)
    }
    position.needsUpdate = true
    geometry.computeVertexNormals()

    const mesh = new Mesh(geometry, this.interiorMaterial)
    mesh.receiveShadow = true
    mesh.castShadow = true
    mesh.name = `${ramp.basin.name}-ramp`
    return mesh
  }

  /**
   * The pool's corners, filled in to the river's outer bank.
   *
   * This is what turns the basin into an even channel: the water that is left
   * is the ring between the island and this wall, of the same width all the way
   * round. Leave the corners open and the current has to fade out before
   * reaching them — anything carried round a bend then coasts out of the
   * stream and sits in the dead water for the rest of the session.
   */
  private buildCornerFill(): Mesh {
    const top = DECK_TOP
    const bottom = WATER_LEVEL - RIVER_POOL.depthAtMaxZ - 0.05

    const shape = new Shape()
    shape.moveTo(-POOL_HALF_W, -POOL_HALF_D)
    shape.lineTo(POOL_HALF_W, -POOL_HALF_D)
    shape.lineTo(POOL_HALF_W, POOL_HALF_D)
    shape.lineTo(-POOL_HALF_W, POOL_HALF_D)
    shape.closePath()

    const hole = new Path()
    hole.setFromPoints(stadiumOutline(RIVER_BANK, 20))
    shape.holes.push(hole)

    const geometry = new ExtrudeGeometry(shape, {
      depth: top - bottom,
      bevelEnabled: false,
      curveSegments: 4,
    })
    geometry.rotateX(-Math.PI / 2)
    geometry.translate(0, bottom, 0)

    // Group 0 is the caps — the top one is deck level — and group 1 the walls,
    // which are underwater and want the same tiles as the rest of the shell.
    const mesh = new Mesh(geometry, [this.deckMaterial, this.interiorMaterial])
    mesh.receiveShadow = true
    mesh.name = 'corner-fill'
    return mesh
  }

  /**
   * The island the lazy river runs round.
   *
   * Its wall is the same tiled interior as the pool shell — it is a wall of the
   * same basin — so it picks up caustics for free. The top is level with the
   * deck, which is what lets someone thrown up onto it stand there rather than
   * fall into a gap.
   */
  private buildIsland(): Group {
    const group = new Group()
    const bottom = floorYAt(ISLAND.x, ISLAND.z + ISLAND.radius) - 0.05
    const height = ISLAND_TOP - bottom

    const geometry = new ExtrudeGeometry(new Shape(stadiumOutline(ISLAND, 16)), {
      depth: height,
      bevelEnabled: false,
      curveSegments: 4,
    })
    // The profile is drawn in XY and extruded along +Z; turn it so the
    // extrusion runs up the world's Y instead.
    geometry.rotateX(-Math.PI / 2)
    geometry.translate(ISLAND.x, bottom, ISLAND.z)

    // Group 0 is the caps, group 1 the side wall.
    const mesh = new Mesh(geometry, [this.copingMaterial, this.interiorMaterial])
    mesh.castShadow = true
    mesh.receiveShadow = true
    mesh.name = 'island'
    group.add(mesh)

    // Something growing on it, so it reads as an island rather than a block.
    const foliage = new MeshStandardMaterial({ color: '#4a7b42', roughness: 0.95 })
    const trunkMaterial = new MeshStandardMaterial({ color: '#7d6748', roughness: 0.85 })
    for (const [x, z, scale] of [
      [-1.7, 0.1, 1],
      [1.9, -0.2, 0.82],
      [0.2, 0.35, 0.65],
    ] as [number, number, number][]) {
      const trunk = new Mesh(new CylinderGeometry(0.055, 0.075, 0.9 * scale, 8), trunkMaterial)
      trunk.position.set(x, ISLAND_TOP + 0.45 * scale, z)
      trunk.castShadow = true
      group.add(trunk)

      const crown = new Mesh(new SphereGeometry(0.52 * scale, 12, 10), foliage)
      crown.scale.set(1, 0.7, 1)
      crown.position.set(x, ISLAND_TOP + 1.05 * scale, z)
      crown.castShadow = true
      group.add(crown)
    }

    return group
  }

  /**
   * Stainless ladder. It sits on a long wall, between the tangent points where
   * the river's bank meets the straight shell — out at the ends the water no
   * longer reaches the original wall.
   */
  private buildLadder(): Group {
    const group = new Group()
    const metal = new MeshStandardMaterial({ color: '#cdd6da', roughness: 0.22, metalness: 0.9 })

    const railShape: BufferGeometry = new TorusGeometry(0.22, 0.028, 10, 24, Math.PI)
    for (const offset of [-0.3, 0.3]) {
      const top = new Mesh(railShape, metal)
      top.rotation.z = Math.PI / 2
      top.rotation.y = Math.PI / 2
      top.position.set(-0.28, WATER_LEVEL + POOL.copingHeight + 0.22, offset)
      top.castShadow = true
      group.add(top)

      const post = new Mesh(new CylinderGeometry(0.028, 0.028, 1.35, 10), metal)
      post.position.set(-0.5, WATER_LEVEL - 0.45, offset)
      post.castShadow = true
      group.add(post)
    }

    for (let i = 0; i < 3; i++) {
      const step = new Mesh(new CylinderGeometry(0.026, 0.026, 0.6, 8), metal)
      step.rotation.x = Math.PI / 2
      step.position.set(-0.5, WATER_LEVEL - 0.2 - i * 0.35, 0)
      step.castShadow = true
      group.add(step)
    }

    // Built facing -X against a wall at the local origin; turn it to face -Z.
    group.position.set(1.8, 0, POOL_HALF_D)
    group.rotation.y = -Math.PI / 2
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
    const deckTop = DECK_TOP

    const thickness = 0.7
    const height = 1.35
    const midX = (GROUNDS.minX + GROUNDS.maxX) / 2
    const midZ = (GROUNDS.minZ + GROUNDS.maxZ) / 2
    const spanX = GROUNDS.maxX - GROUNDS.minX
    const spanZ = GROUNDS.maxZ - GROUNDS.minZ

    const walls: [number, number, number, number][] = [
      [midX, GROUNDS.minZ - thickness / 2, spanX + thickness * 2, thickness],
      [midX, GROUNDS.maxZ + thickness / 2, spanX + thickness * 2, thickness],
      [GROUNDS.minX - thickness / 2, midZ, thickness, spanZ],
      [GROUNDS.maxX + thickness / 2, midZ, thickness, spanZ],
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
      [-5.4, RIVER_POOL.minZ - 2.5],
      [5.4, CALM_POOL.minZ - 2.2],
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

  /**
   * Nearest point in the river channel, used when spawning things: outside the
   * island, inside the bank.
   */
  static clampInside(point: Vector3, margin: number): Vector3 {
    clampToRing(
      RIVER_BANK,
      point.x,
      point.z,
      ISLAND.radius + margin,
      RIVER.outerRadius - margin,
      _ring,
    )
    point.x = _ring.x
    point.z = _ring.z
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

const _ring: Vec2 = { x: 0, z: 0 }
const _toe: Vec2 = { x: 0, z: 0 }

/**
 * The outline of a stadium as a closed polyline, in the shape's own XZ frame.
 * Used for the island's extruded wall; the same shape drives its collision and
 * the current that runs round it.
 */
function stadiumOutline(shape: Stadium, segmentsPerCap: number): Vector2[] {
  const points: Vector2[] = []
  for (let i = 0; i <= segmentsPerCap; i++) {
    const angle = -Math.PI / 2 + (Math.PI * i) / segmentsPerCap
    points.push(
      new Vector2(shape.halfLength + Math.cos(angle) * shape.radius, Math.sin(angle) * shape.radius),
    )
  }
  for (let i = 0; i <= segmentsPerCap; i++) {
    const angle = Math.PI / 2 + (Math.PI * i) / segmentsPerCap
    points.push(
      new Vector2(-shape.halfLength + Math.cos(angle) * shape.radius, Math.sin(angle) * shape.radius),
    )
  }
  return points
}
