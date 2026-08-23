import { CanvasTexture, RepeatWrapping, SRGBColorSpace, type Texture } from 'three'

/**
 * Procedural textures, drawn once into an offscreen canvas at startup.
 *
 * Generating them keeps the project free of binary assets: nothing to load,
 * nothing to fail, and the tile colours stay adjustable from code.
 */

function canvas(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const element = document.createElement('canvas')
  element.width = size
  element.height = size
  const context = element.getContext('2d')
  if (!context) throw new Error('2D canvas context unavailable')
  return [element, context]
}

function finish(element: HTMLCanvasElement, repeat: number, srgb = true): CanvasTexture {
  const texture = new CanvasTexture(element)
  texture.wrapS = RepeatWrapping
  texture.wrapT = RepeatWrapping
  texture.repeat.set(repeat, repeat)
  texture.anisotropy = 8
  if (srgb) texture.colorSpace = SRGBColorSpace
  return texture
}

export interface TileOptions {
  /** Tiles across one texture tile-set. */
  count?: number
  base?: string
  /** Per-tile colour jitter, drawn from these. */
  variants?: string[]
  grout?: string
  groutWidth?: number
  /** Texture repeats per metre when applied. */
  repeat?: number
  size?: number
}

/** Glazed ceramic tiles with grout lines and gentle per-tile colour variation. */
export function makeTileTexture(options: TileOptions = {}): CanvasTexture {
  const size = options.size ?? 512
  const count = options.count ?? 8
  const [element, context] = canvas(size)
  const cell = size / count

  context.fillStyle = options.grout ?? '#e8eef0'
  context.fillRect(0, 0, size, size)

  const variants = options.variants ?? ['#3f9fd0', '#4fb0dd', '#379ac9', '#59bce6']
  const groutWidth = options.groutWidth ?? Math.max(1, cell * 0.06)

  for (let y = 0; y < count; y++) {
    for (let x = 0; x < count; x++) {
      // Deterministic hash so the pattern is stable between reloads.
      const hash = Math.sin(x * 127.1 + y * 311.7) * 43758.5453
      const pick = Math.floor((hash - Math.floor(hash)) * variants.length)
      context.fillStyle = variants[pick % variants.length]!
      context.fillRect(
        x * cell + groutWidth * 0.5,
        y * cell + groutWidth * 0.5,
        cell - groutWidth,
        cell - groutWidth,
      )

      // A soft highlight across the top-left of each tile reads as glaze.
      const gradient = context.createLinearGradient(x * cell, y * cell, (x + 1) * cell, (y + 1) * cell)
      gradient.addColorStop(0, 'rgba(255,255,255,0.16)')
      gradient.addColorStop(0.5, 'rgba(255,255,255,0.02)')
      gradient.addColorStop(1, 'rgba(0,0,0,0.07)')
      context.fillStyle = gradient
      context.fillRect(
        x * cell + groutWidth * 0.5,
        y * cell + groutWidth * 0.5,
        cell - groutWidth,
        cell - groutWidth,
      )
    }
  }

  return finish(element, options.repeat ?? 1)
}

/** Large pale paving slabs for the deck around the pool. */
export function makeDeckTexture(): CanvasTexture {
  const size = 512
  const [element, context] = canvas(size)
  context.fillStyle = '#d9d2c6'
  context.fillRect(0, 0, size, size)

  // Speckle, for a cast-stone feel.
  for (let i = 0; i < 9000; i++) {
    const x = Math.random() * size
    const y = Math.random() * size
    const shade = 190 + Math.random() * 55
    context.fillStyle = `rgba(${shade},${shade - 6},${shade - 18},0.5)`
    context.fillRect(x, y, 1.4, 1.4)
  }

  context.strokeStyle = 'rgba(150,142,130,0.75)'
  context.lineWidth = 3
  for (let i = 0; i <= 2; i++) {
    const p = (i * size) / 2
    context.beginPath()
    context.moveTo(p, 0)
    context.lineTo(p, size)
    context.moveTo(0, p)
    context.lineTo(size, p)
    context.stroke()
  }

  return finish(element, 1)
}

/** Tiling value noise, used to break up the water's fine detail normals. */
export function makeRippleNormalTexture(): CanvasTexture {
  const size = 256
  const [element, context] = canvas(size)
  const image = context.createImageData(size, size)

  const height = new Float32Array(size * size)
  // A couple of octaves of smooth noise, wrapped so the texture tiles.
  for (let octave = 0; octave < 3; octave++) {
    const frequency = 4 << octave
    const amplitude = 1 / (1 << octave)
    const grid = new Float32Array(frequency * frequency)
    for (let i = 0; i < grid.length; i++) grid[i] = Math.random()
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const fx = (x / size) * frequency
        const fy = (y / size) * frequency
        const x0 = Math.floor(fx)
        const y0 = Math.floor(fy)
        const tx = smoothstep(fx - x0)
        const ty = smoothstep(fy - y0)
        const at = (gx: number, gy: number) =>
          grid[(((gy % frequency) + frequency) % frequency) * frequency + (((gx % frequency) + frequency) % frequency)]!
        const top = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * tx
        const bottom = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * tx
        height[y * size + x]! += (top + (bottom - top) * ty) * amplitude
      }
    }
  }

  // Central differences on the height give the tangent-space normal.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sample = (dx: number, dy: number) =>
        height[(((y + dy) % size) + size) % size * size + ((((x + dx) % size) + size) % size)]!
      const dhdx = (sample(1, 0) - sample(-1, 0)) * 4
      const dhdy = (sample(0, 1) - sample(0, -1)) * 4
      const length = Math.hypot(dhdx, dhdy, 1)
      const index = (y * size + x) * 4
      image.data[index] = ((-dhdx / length) * 0.5 + 0.5) * 255
      image.data[index + 1] = ((-dhdy / length) * 0.5 + 0.5) * 255
      image.data[index + 2] = (1 / length) * 0.5 * 255 + 127
      image.data[index + 3] = 255
    }
  }
  context.putImageData(image, 0, 0)
  return finish(element, 1, false)
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t)
}

export function disposeTextures(...textures: (Texture | undefined)[]): void {
  for (const texture of textures) texture?.dispose()
}
