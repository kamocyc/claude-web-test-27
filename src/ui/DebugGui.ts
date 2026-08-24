import GUI from 'lil-gui'
import Stats from 'stats.js'
import type { App } from '../App'

export interface GuiHandle {
  gui: GUI
  stats: Stats
  /** Call once per frame, around the frame body. */
  beginFrame(): void
  endFrame(): void
  dispose(): void
}

/**
 * Controls for everything worth poking at while the simulation runs.
 *
 * The wave-speed slider stops at 0.7 deliberately: past that the GPU field's
 * stencil weight hits its stability cap while the coarser CPU field is still
 * well inside its own, so the waves on screen would start travelling slower
 * than the ones moving the floats.
 */
export function createDebugGui(app: App): GuiHandle {
  const gui = new GUI({ title: 'Pool Simulation', width: 292 })

  const stats = new Stats()
  stats.dom.style.left = 'auto'
  stats.dom.style.right = '0'
  stats.dom.style.top = '0'
  document.body.appendChild(stats.dom)

  const state = {
    sunElevation: 42,
    sunAzimuth: 35,
    reflections: app.surface.reflectionEnabled,
    showFlow: false,
    paused: false,
  }

  // --- Water ---------------------------------------------------------------
  const water = gui.addFolder('Water')
  water
    .add(app.waves, 'speedScale', 0.2, 0.7, 0.01)
    .name('wave speed')
    .onChange(() => app.syncWaveSettings())
  water
    .add(app.waves, 'damping', 0.1, 3, 0.05)
    .name('damping')
    .onChange(() => app.syncWaveSettings())
  water
    .add(app.waves, 'levelDecay', 0, 0.4, 0.01)
    .name('level decay')
    .onChange(() => app.syncWaveSettings())

  const uniforms = app.surface.material.uniforms
  water.add(uniforms.uRefractionScale!, 'value', 0, 0.3, 0.005).name('refraction')
  water.add(uniforms.uDetailStrength!, 'value', 0, 0.6, 0.01).name('ripple detail')
  water.add(uniforms.uRoughness!, 'value', 0.01, 0.3, 0.005).name('surface gloss')
  water.add(uniforms.uGlitter!, 'value', 0, 20, 0.5).name('sun glitter')
  water.add(uniforms.uEdgeSoftness!, 'value', 0.02, 1.2, 0.02).name('edge softness')
  water.addColor({ deep: `#${uniforms.uDeepColor!.value.getHexString()}` }, 'deep')
    .name('deep colour')
    .onChange((value: string) => uniforms.uDeepColor!.value.set(value))
  water.add(uniforms.uAbsorption!.value, 'x', 0.05, 1.5, 0.01).name('absorb red')
  water.add(uniforms.uAbsorption!.value, 'y', 0.02, 1, 0.01).name('absorb green')
  water.add(uniforms.uAbsorption!.value, 'z', 0.02, 1, 0.01).name('absorb blue')

  // --- Foam and caustics ----------------------------------------------------
  const surface = gui.addFolder('Foam & caustics')
  surface.add(app.waves, 'foamDecay', 0.05, 3, 0.05).name('foam decay')
  surface.add(app.waves, 'foamChurnGain', 0, 5, 0.1).name('foam from churn')
  surface.add(app.caustics, 'intensity', 0, 3, 0.05).name('caustics')

  // --- Current --------------------------------------------------------------
  const current = gui.addFolder('Current')
  current
    .add(app.flow, 'intensity', 0, 3, 0.05)
    .name('overall strength')
    .onChange(() => app.waves.markFlowDirty())
  for (let i = 0; i < app.flow.jets.length; i++) {
    current
      .add(app.flow.jets[i]!, 'strength', 0, 3, 0.05)
      .name(`jet ${i + 1}`)
      .onChange(() => app.waves.markFlowDirty())
  }
  for (let i = 0; i < app.flow.vortices.length; i++) {
    current
      .add(app.flow.vortices[i]!, 'strength', -1.5, 1.5, 0.05)
      .name(`eddy ${i + 1}`)
      .onChange(() => app.waves.markFlowDirty())
  }
  for (let i = 0; i < app.flow.channels.length; i++) {
    current
      .add(app.flow.channels[i]!, 'strength', 0, 2.5, 0.05)
      .name('lazy river')
      .onChange(() => app.waves.markFlowDirty())
  }

  // --- Slide and fountains ---------------------------------------------------
  const rides = gui.addFolder('Slide & fountains')
  rides
    .add({ send: () => app.sendDownTheSlide() }, 'send')
    .name('send someone down the slide')
  const fountainState = {
    running: true,
    speed: app.fountains[0]?.speed ?? 7,
  }
  rides
    .add(fountainState, 'running')
    .name('fountains on')
    .onChange((value: boolean) => {
      for (const fountain of app.fountains) fountain.enabled = value
    })
  rides
    .add(fountainState, 'speed', 2, 11, 0.25)
    .name('jet speed')
    .onChange((value: number) => {
      for (const fountain of app.fountains) fountain.speed = value
    })

  // --- Sky ------------------------------------------------------------------
  const sky = gui.addFolder('Sky')
  sky
    .add(state, 'sunElevation', 3, 88, 1)
    .name('sun elevation')
    .onChange(() => app.environment.setSun(state.sunElevation, state.sunAzimuth))
  sky
    .add(app.environment.uniforms.uSkyIntensity, 'value', 0.4, 3, 0.05)
    .name('sky brightness')
  sky
    .add(state, 'sunAzimuth', -180, 180, 1)
    .name('sun azimuth')
    .onChange(() => app.environment.setSun(state.sunElevation, state.sunAzimuth))

  // --- Objects --------------------------------------------------------------
  const objects = gui.addFolder('Objects')
  objects.add({ drop: () => app.spawn('ring') }, 'drop').name('drop a swim ring')
  objects.add({ drop: () => app.spawn('duck') }, 'drop').name('drop a duck')
  objects.add({ drop: () => app.spawn('mattress') }, 'drop').name('drop a mattress')
  objects.add({ drop: () => app.spawn('ball') }, 'drop').name('drop a beach ball')
  objects.add({ clear: () => app.clearFloats() }, 'clear').name('remove extras')

  // --- Scene ----------------------------------------------------------------
  const scene = gui.addFolder('Scene')
  scene
    .add(state, 'reflections')
    .name('planar reflections')
    .onChange((value: boolean) => {
      app.surface.reflectionEnabled = value
    })
  scene.add({ calm: () => app.calmWater() }, 'calm').name('calm the water')
  scene
    .add(state, 'paused')
    .name('pause')
    .onChange((value: boolean) => {
      app.paused = value
    })

  return {
    gui,
    stats,
    beginFrame: () => stats.begin(),
    endFrame: () => stats.end(),
    dispose: () => {
      gui.destroy()
      stats.dom.remove()
    },
  }
}
