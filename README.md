# Pool Simulation

A swimming pool in the browser, built around one idea: everything in the water
interacts with the water, and the water interacts back.

Three.js + TypeScript, no binary assets — every model, texture and the sky
itself is generated in code.

![the pool](artifacts/pool-9s.png)

## Running it

```sh
npm install
npm run dev        # http://localhost:5173
```

| Command | What it does |
|---|---|
| `npm run dev` | dev server with hot reload |
| `npm run build` | production build into `dist/` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run test` | unit tests for the simulation and physics (vitest) |
| `npm run smoke` | launches the page in headless Chromium, checks it renders and behaves, writes screenshots to `artifacts/` |

Append `?quality=low`, `?quality=medium` or `?quality=high` to override the
automatic quality guess.

## Controls

| | |
|---|---|
| `W` `A` `S` `D` / arrows | swim (relative to the camera) |
| `Shift` | sprint |
| `Space` | dive |
| drag | orbit |
| wheel | zoom |
| click the water | splash |

The panel on the right exposes the wave speed and damping, the water's colour
and absorption, foam and caustics, the strength of each jet and eddy, the time
of day, and buttons to drop more things in.

## What makes it interact

**One channel for every disturbance.** A float bobbing, a swimmer's hand
entering the water, a droplet landing, a click on the surface — all of them emit
the same `WaveSplat`, and both height fields consume the identical list each
step. Add a new object and it makes correct waves without anyone writing wave
code for it.

**The loop closes.** Buoyancy emits splats in proportion to how fast a body is
displacing water; those splats become waves; those waves push on every other
body's buoyancy samples. A swimmer's wake rocks a duck three metres away because
that is the only path the forces can take, not because anything says so.

**Nothing is animated along a path.** Swimmers apply thrust in time with their
stroke and steer with torque, so they surge between pulls, get carried by the
current, and are shoved around by a swim ring exactly the way a float is. The
player and the AI swimmers run the same code; the AI just sets a heading and a
throttle.

**Buoyancy is per-sphere.** A body is a set of spheres, and each one gets its own
surface height, its own submerged cap and its own drag, applied at its own
position. Restoring torque, list under an off-centre load and a swim ring
slapping flat again after you tip it all emerge from that.

## What makes it look like water

- **Screen-space refraction** with a fallback when the distortion drags an
  object over the surface
- **Beer–Lambert absorption** along the view ray through the water, which is why
  the deep end goes blue-green and the shallow end stays clear
- **Planar reflection** through a mirrored camera with an oblique near plane,
  blended by Fresnel with an analytic sky
- **Caustics by ray convergence** — the floor is lit by the Jacobian of the
  refracted sun rays, so the bands braid and move rather than scrolling
- **Foam** advected by the current, deposited wherever the surface churns
- **Spray** that flies, and then splashes back into the height field on landing
- **A Snell window** when you drop the camera below the surface

## Layout

```
src/
  core/       renderer, camera, sky and lighting, input, constants
  sim/        the water: GPU and CPU height fields, flow, foam, shaders
  physics/    rigid bodies, buoyancy, collision, the fixed-step world
  entities/   pool, swim rings, ducks, floats, swimmers and their AI
  render/     water surface, planar reflection, caustics, spray, textures
  ui/         debug GUI
tests/        unit tests for the pure-logic layer
scripts/      headless render check
```

`src/sim/README.md` covers the water simulation in detail: why there are two
height fields, what keeps the scheme stable, and how splats are applied.

## Verification

The simulation and physics are pure logic with no WebGL dependency, so they are
tested directly: that the height field stays finite when driven far past its
nominal wave speed, that its energy falls monotonically once the driving stops,
that a splat spreads symmetrically and reflects off the walls, that waves refract
towards the shallow end, that a float settles at the draft where displaced water
matches its mass, that a knocked-over duck rights itself, and that collisions
conserve momentum.

`npm run smoke` covers the parts that need a GPU: it drives the real page in
headless Chromium and asserts the loop is turning, the field is finite and
bounded, swimmers are moving, floats are at plausible waterlines, clicking
disturbs the water, and no shader failed to compile.
