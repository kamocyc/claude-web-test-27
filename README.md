# Pool Simulation

A swimming pool in the browser, built around one idea: everything in the water
interacts with the water, and the water interacts back.

A lazy river runs a full circuit round an island in the middle, a water slide
drops riders into it, and three fountains stand in the channel throwing water
that lands as real ripples.

Three.js + TypeScript, no binary assets — every model, texture and the sky
itself is generated in code.

![the pool](docs/screenshot.png)

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
and absorption, foam and caustics, the strength of the river and each jet, the
fountains, the time of day, a button to send someone down the slide, and buttons
to drop more things in.

Swim into the boarding circle at the foot of the slide's steps and you will
climb out and take the slide yourself.

## What makes it interact

**One channel for every disturbance.** A float bobbing, a swimmer's hand
entering the water, a droplet landing, a click on the surface — all of them emit
the same `WaveSplat`, and both height fields consume the identical list each
step. Add a new object and it makes correct waves without anyone writing wave
code for it. Every source is built to add no net water, so the pool holds its
level over a long session.

**The loop closes.** Buoyancy emits splats in proportion to how fast a body is
displacing water; those splats become waves; those waves push on every other
body's buoyancy samples. A swimmer's wake rocks a duck three metres away because
that is the only path the forces can take, not because anything says so.

**Nothing is animated along a path.** Swimmers apply thrust in time with their
stroke and steer with torque, so they surge between pulls, get carried by the
current, and are shoved around by a swim ring exactly the way a float is. The
player and the AI swimmers run the same code; the AI just sets a heading and a
throttle.

**The furniture is physics too.** The island, the flume and the fountains are
`WorldFeature`s: they can add forces to a body and resolve contacts with it, and
that is all any of them do. The slide has no rail — riders are ordinary rigid
bodies falling down the inside of a pipe, so they gather speed on the steep
section, ride up the outside of the bend, and go over the side if they carry too
much speed into it, because the pipe is only closed for 300 degrees and there is
nothing above them. The fountains push with the jet's own momentum flux, which
is why the same nozzle throws a beach ball over the deck and does nothing at all
to a swimmer.

**Buoyancy is per-sphere.** A body is a set of spheres, and each one gets its own
surface height, its own submerged cap and its own drag, applied at its own
position. Restoring torque, list under an off-centre load and a swim ring
slapping flat again after you tip it all emerge from that.

## The pool itself

The basin is a stadium: a rectangle with its corners filled in to a curve
concentric with the island, so the water is a channel of even width all the way
round. That shape is not decoration. The current is tangential to the island
everywhere and divergence-free, so it transports water without ever piling it
up — but with the corners left open it has to fade out before the walls, and
anything carried through a bend coasts out of the stream and parks in the dead
water for the rest of the session. With both banks in place a float goes round,
and keeps going round. `tests/lazyRiver.test.ts` fails if it does not.

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
  core/       renderer, camera, sky and lighting, input, constants, shapes
  sim/        the water: GPU and CPU height fields, flow, foam, shaders
  physics/    rigid bodies, buoyancy, collision, the fixed-step world
  entities/   pool and island, water slide, fountains, swim rings, ducks,
              floats, swimmers and their AI
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

Two suites cover the water itself and are deliberately a pair, because either
one alone can be satisfied by breaking the other. `tests/waterLevel.test.ts`
fails if the pool gains or loses volume over a long session.
`tests/waterResponse.test.ts` fails if it stops moving — that someone swimming
visibly stirs the surface, leaves a wake behind them, that a ripple crosses the
pool rather than dying where it started, and that the water settles again once
they stop.

The river, the slide and the fountains get the same treatment. `tests/lazyRiver.test.ts` checks
the current is tangential, closed and divergence-free, and then — separately,
because it is a different claim — that a ring, a ball and a mattress dropped in
it each complete a lap of the island. `tests/waterSlide.test.ts` checks the
things a rail would have made true for free: that gravity alone takes a body
down, that nothing comes out faster than the drop allows, that a body longer
than the flume is wide does not wedge across it, and that a rider is never left
stranded halfway. `tests/fountain.test.ts` checks the jet is a plausible one
(bore, flow and column height), that it throws a beach ball clear of the water
while barely moving a swimmer, that it rings the surface with waves purely
through the droplets it throws, and that a minute of it does not raise the pool.

`npm run smoke` covers the parts that need a GPU: it drives the real page in
headless Chromium and asserts the loop is turning, the field is finite and
bounded, swimmers are moving, floats are at plausible waterlines, the floats are
drifting the way the river runs, nothing is stuck inside a wall, the fountains
have water in the air, the slide takes a rider, clicking disturbs the water, and
no shader failed to compile.
