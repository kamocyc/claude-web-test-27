import { App, QUALITY_PRESETS, type AppQuality } from './App'
import { createDebugGui } from './ui/DebugGui'

/**
 * Quality can be forced with ?quality=low|medium|high. Useful on a machine
 * whose capabilities the guess below gets wrong, and for the smoke test, which
 * runs against a software rasteriser.
 */
function requestedQuality(): AppQuality | null {
  const requested = new URLSearchParams(window.location.search).get('quality')
  if (requested && requested in QUALITY_PRESETS) return QUALITY_PRESETS[requested]!
  return null
}

/** Pick a starting quality from what the machine looks like it can handle. */
function guessQuality(): AppQuality {
  const cores = navigator.hardwareConcurrency ?? 4
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false
  if (coarse || cores <= 4) return QUALITY_PRESETS.low!
  if (cores <= 8) return QUALITY_PRESETS.medium!
  return QUALITY_PRESETS.high!
}

function reportFatal(error: unknown): void {
  const panel = document.getElementById('fatal')
  if (!panel) return
  panel.style.display = 'grid'
  panel.textContent =
    'The pool simulation could not start.\n\n' +
    (error instanceof Error ? `${error.name}: ${error.message}` : String(error)) +
    '\n\nIt needs WebGL2 with float render targets.'
  console.error(error)
}

function start(): void {
  const app = new App(requestedQuality() ?? guessQuality())
  const gui = createDebugGui(app)

  // Expose for the smoke test and for poking at things from the console.
  Object.assign(window, { poolApp: app })

  const loop = (now: number) => {
    gui.beginFrame()
    app.frame(now)
    gui.endFrame()
    requestAnimationFrame(loop)
  }
  requestAnimationFrame(loop)
}

try {
  start()
} catch (error) {
  reportFatal(error)
}
