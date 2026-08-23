import { ACESFilmicToneMapping, PerspectiveCamera, SRGBColorSpace, WebGLRenderer } from 'three'

export interface RendererBundle {
  renderer: WebGLRenderer
  camera: PerspectiveCamera
  /** Device pixel ratio actually in use, after the quality cap. */
  pixelRatio: number
}

/**
 * Renderer, camera and resize handling.
 *
 * Shadow maps are switched to manual refresh: the frame draws the scene three
 * times (reflection, refraction, final) and three.js would otherwise re-render
 * every shadow map on each of those passes.
 */
export function createRenderer(maxPixelRatio = 1.75): RendererBundle {
  const renderer = new WebGLRenderer({
    antialias: true,
    powerPreference: 'high-performance',
    stencil: false,
  })
  renderer.outputColorSpace = SRGBColorSpace
  renderer.toneMapping = ACESFilmicToneMapping
  // Deliberately under 1: the deck is a large, pale, unshadowed surface and at
  // unity exposure it clips to flat white, taking the pool's highlights with it.
  renderer.toneMappingExposure = 0.86
  renderer.shadowMap.enabled = true
  renderer.shadowMap.autoUpdate = false
  renderer.setClearColor(0x8fc6e8, 1)

  const pixelRatio = Math.min(window.devicePixelRatio || 1, maxPixelRatio)
  renderer.setPixelRatio(pixelRatio)
  renderer.setSize(window.innerWidth, window.innerHeight)
  document.body.appendChild(renderer.domElement)

  const camera = new PerspectiveCamera(52, window.innerWidth / window.innerHeight, 0.08, 400)
  camera.position.set(-11, 5.4, 12)
  camera.lookAt(0, -0.4, 0)

  return { renderer, camera, pixelRatio }
}

export function attachResize(
  renderer: WebGLRenderer,
  camera: PerspectiveCamera,
  onResize?: (width: number, height: number) => void,
): () => void {
  const handle = () => {
    const width = window.innerWidth
    const height = window.innerHeight
    camera.aspect = width / height
    camera.updateProjectionMatrix()
    renderer.setSize(width, height)
    onResize?.(width, height)
  }
  window.addEventListener('resize', handle)
  handle()
  return () => window.removeEventListener('resize', handle)
}
