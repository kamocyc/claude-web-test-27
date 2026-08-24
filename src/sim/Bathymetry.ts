import { ClampToEdgeWrapping, DataTexture, FloatType, NearestFilter, RGFormat } from 'three'

/** The rectangle a field covers, in world metres. */
export interface DomainRect {
  centerX: number
  centerZ: number
  width: number
  depth: number
}

/**
 * The shape of the bottom, as a texture: R is the water depth in metres and G
 * is 1 where there is water at all.
 *
 * Both simulation passes read it. Depth sets the local wave speed, which used
 * to be a formula in Z alone and cannot be now that two pools with different
 * floors share one field. The wet flag is the wall: a texel whose neighbour is
 * dry reads its own height back instead of the neighbour's, so the wave
 * reflects there. That is what keeps the lazy river's chop out of the calm pool
 * five metres away, and what finally makes ripples bounce off the island rather
 * than passing through it.
 *
 * Sampled with nearest filtering, deliberately: an interpolated wet flag would
 * put a half-solid ring of cells around every wall.
 */
export function buildBathymetry(
  width: number,
  height: number,
  domain: DomainRect,
  depthAt: (x: number, z: number) => number,
): DataTexture {
  const data = new Float32Array(width * height * 2)
  let i = 0
  for (let j = 0; j < height; j++) {
    const z = domain.centerZ + ((j + 0.5) / height - 0.5) * domain.depth
    for (let k = 0; k < width; k++) {
      const x = domain.centerX + ((k + 0.5) / width - 0.5) * domain.width
      const depth = depthAt(x, z)
      data[i++] = depth > 0 ? depth : 0
      data[i++] = depth > 0 ? 1 : 0
    }
  }

  const texture = new DataTexture(data, width, height, RGFormat, FloatType)
  texture.minFilter = NearestFilter
  texture.magFilter = NearestFilter
  texture.wrapS = ClampToEdgeWrapping
  texture.wrapT = ClampToEdgeWrapping
  texture.needsUpdate = true
  return texture
}
