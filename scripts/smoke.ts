/**
 * Headless render check.
 *
 * Starts the dev server, opens the page in the pre-installed Chromium, and
 * verifies the simulation is genuinely running rather than merely not throwing:
 * it waits for the app object, checks the height field is carrying energy after
 * the swimmers have had a moment to stir it up, confirms floats are sitting at
 * a sensible waterline, and captures screenshots to look at.
 *
 * Any console error or shader compile failure fails the run.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium, type ConsoleMessage } from 'playwright'

const PORT = Number(process.env.SMOKE_PORT ?? 5199)
// Software rasterisation is slow, so ask for the cheap preset: the point of
// this run is that the simulation behaves, not that it hits a frame rate.
const URL = `http://127.0.0.1:${PORT}/?quality=low`
const OUT_DIR = 'artifacts'
const CAPTURES = [0.5, 3, 9]

async function waitForServer(timeoutMs = 40_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(URL)
      if (response.ok) return
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`dev server did not come up at ${URL}`)
}

function startServer(): ChildProcess {
  const server = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
    detached: true,
  })
  server.stdout?.on('data', () => {})
  server.stderr?.on("data", (chunk: Buffer) => process.stderr.write(`[vite] ${chunk}`))
  return server
}

interface Probe {
  elapsed: number
  steps: number
  waveEnergy: number
  wavePeak: number
  waveFinite: boolean
  sprayCount: number
  swimmerSpeeds: number[]
  floatDrafts: number[]
  drawCalls: number
  /** Read back from the GPU height field, which nothing else here can see. */
  gpu: { peak: number; mean: number; nonFinite: number }
  gpuHighPrecision: boolean
}

async function main(): Promise<number> {
  await mkdir(OUT_DIR, { recursive: true })
  const server = startServer()
  const errors: string[] = []
  let browser

  try {
    await waitForServer()
    // The environment ships a Chromium build that may not match the one this
    // Playwright release expects, so point at it explicitly rather than letting
    // Playwright go looking for a download it is not allowed to make.
    const executablePath = process.env.PLAYWRIGHT_CHROMIUM ?? '/opt/pw-browsers/chromium'
    browser = await chromium.launch({
      ...(existsSync(executablePath) ? { executablePath } : {}),
      args: [
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        '--disable-gpu-sandbox',
      ],
    })
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })

    page.on('console', (message: ConsoleMessage) => {
      if (message.type() === 'error') errors.push(message.text())
      const text = message.text()
      if (/shader|glsl|compil/i.test(text) && /error|fail/i.test(text)) errors.push(text)
    })
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))

    await page.goto(URL, { waitUntil: 'domcontentloaded' })

    const fatal = await page.locator('#fatal').evaluate((node) => node.textContent ?? '')
    if (fatal.trim().length > 0) errors.push(`fatal panel: ${fatal.trim()}`)

    await page.waitForFunction(() => 'poolApp' in window, undefined, { timeout: 30_000 })

    // Fix the camera so every run frames the same shot and the screenshots can
    // be compared against each other.
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(window as any).poolApp.setCamera(2.35, 0.42, 13.5)
    })

    const probes: Probe[] = []
    let previous = 0
    for (const at of CAPTURES) {
      await page.waitForTimeout(Math.max(0, (at - previous) * 1000))
      previous = at

      const probe = (await page.evaluate(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const app = (window as any).poolApp
        return {
          elapsed: app.elapsed,
          steps: app.lastStepCount,
          waveEnergy: app.water.energy(1 / 240),
          wavePeak: app.water.peakAmplitude(),
          waveFinite: app.water.isFinite(),
          sprayCount: app.spray.activeCount,
          swimmerSpeeds: app.swimmers.map((s: { speed: number }) => s.speed),
          floatDrafts: app.floats.map((f: { body: { position: { y: number } } }) => f.body.position.y),
          drawCalls: app.renderer.info.render.calls,
          gpu: app.waves.sampleStats(app.renderer),
          gpuHighPrecision: app.waves.highPrecision,
        }
      })) as Probe

      probes.push(probe)
      await page.screenshot({ path: `${OUT_DIR}/pool-${at}s.png` })
      console.log(
        `t=${at}s  simTime=${probe.elapsed.toFixed(2)}s  steps/frame=${probe.steps}  ` +
          `cpuPeak=${probe.wavePeak.toFixed(4)}m  gpuPeak=${probe.gpu.peak.toFixed(4)}m  ` +
          `gpuMean=${probe.gpu.mean.toExponential(2)}m  spray=${probe.sprayCount}  ` +
          `draws=${probe.drawCalls}`,
      )
    }

    // Click the middle of the pool and confirm it actually disturbs the water.
    const beforeClick = await page.evaluate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => (window as any).poolApp.water.peakAmplitude(),
    )
    await page.mouse.click(640, 480)
    await page.waitForTimeout(700)
    const afterClick = await page.evaluate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => (window as any).poolApp.water.peakAmplitude(),
    )
    await page.screenshot({ path: `${OUT_DIR}/pool-click.png` })

    // A near-horizontal shot, where Fresnel puts most of the weight on the
    // planar reflection. Looking down at the pool barely reflects anything, so
    // this is the frame that shows whether the mirror pass is working.
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(window as any).poolApp.setCamera(2.35, 0.1, 8.5)
    })
    await page.waitForTimeout(1500)
    await page.screenshot({ path: `${OUT_DIR}/pool-grazing.png` })

    const last = probes[probes.length - 1]!
    const checks: [string, boolean, string][] = [
      // Deliberately low: under SwiftShader the renderer manages only a couple
      // of frames a second, so this asserts the loop is turning, not that it is
      // fast.
      ['simulation advanced', last.elapsed > 1, `elapsed ${last.elapsed.toFixed(2)}s`],
      ['height field finite', last.waveFinite, 'field contains a non-finite value'],
      [
        'water is moving',
        last.waveEnergy > 1e-3 && last.wavePeak > 1e-4,
        `energy ${last.waveEnergy}, peak ${last.wavePeak}`,
      ],
      [
        'height field bounded',
        last.wavePeak < 1.5,
        `peak ${last.wavePeak.toFixed(3)}m is implausible for a pool`,
      ],
      [
        'swimmers are swimming',
        last.swimmerSpeeds.some((speed) => speed > 0.15),
        `speeds ${last.swimmerSpeeds.map((s) => s.toFixed(2)).join(', ')}`,
      ],
      [
        'floats are floating',
        last.floatDrafts.every((y) => y > -0.7 && y < 0.9),
        `drafts ${last.floatDrafts.map((y) => y.toFixed(2)).join(', ')}`,
      ],
      ['scene is drawing', last.drawCalls > 20, `${last.drawCalls} draw calls`],
      // Half float cannot represent the level decay's per-step multiply — it is
      // under half an ULP, so it rounds away and the field's volume is never
      // bled off. Falling back to it means the pool will slowly inflate.
      [
        'GPU height field has float precision',
        last.gpuHighPrecision,
        'EXT_color_buffer_float missing; the state fell back to half float',
      ],
      ['GPU height field finite', last.gpu.nonFinite === 0, `${last.gpu.nonFinite} bad texels`],
      [
        'GPU height field bounded',
        last.gpu.peak < 0.5 && Math.abs(last.gpu.mean) < 0.05,
        `peak ${last.gpu.peak.toFixed(4)}, mean ${last.gpu.mean.toExponential(2)}`,
      ],
      [
        'GPU and CPU fields agree in scale',
        last.gpu.peak > 1e-5 && last.gpu.peak < last.wavePeak * 12 + 0.02,
        `gpu ${last.gpu.peak.toExponential(2)} vs cpu ${last.wavePeak.toExponential(2)}`,
      ],
      // The counterpart to every "stays bounded" check above. Measured after
      // the spawn transient has passed, so it is the swimmers keeping the water
      // moving rather than the objects settling in. A damping regression that
      // irons the pool flat passes every other check here.
      [
        'swimmers keep the water moving',
        last.waveEnergy > 0.5 && last.wavePeak > 3e-3,
        `energy ${last.waveEnergy.toFixed(3)}, peak ${last.wavePeak.toExponential(2)}`,
      ],
      [
        'clicking splashes',
        afterClick > beforeClick * 1.05 || afterClick > 0.01,
        `peak ${beforeClick.toFixed(4)} -> ${afterClick.toFixed(4)}`,
      ],
      ['no console errors', errors.length === 0, errors.slice(0, 5).join(' | ')],
    ]

    let failed = 0
    for (const [name, passed, detail] of checks) {
      console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${passed ? '' : ` - ${detail}`}`)
      if (!passed) failed++
    }

    await writeFile(`${OUT_DIR}/smoke.json`, JSON.stringify({ probes, errors }, null, 2))
    return failed === 0 ? 0 : 1
  } finally {
    await browser?.close()
    // Kill the whole group: `npx` spawns vite as a child, and signalling only
    // npx leaves the server holding the port for the next run.
    try {
      if (server.pid) process.kill(-server.pid, 'SIGTERM')
    } catch {
      server.kill('SIGKILL')
    }
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
