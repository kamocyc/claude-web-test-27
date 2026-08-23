# Water simulation

Two height fields run side by side over the same pool, driven by the same
sources, with the same wave speed.

| | `WaveField` (GPU) | `WaveFieldCPU` |
|---|---|---|
| Resolution | 512 x 320 (quality preset) | 128 x 80 |
| Storage | two RGBA16F targets, ping-ponged; R = h(t), G = h(t-1) | three `Float32Array`s |
| Read by | the water surface shader, foam, caustics | buoyancy, spray, click tests |

## Why two fields instead of one

Buoyancy has to sample the surface height at a few dozen points every physics
step. Reading that back from the GPU is the obvious thing to try and both ways
of doing it are bad:

- `readRenderTargetPixels` is synchronous. It stalls the pipeline, and the cost
  lands on the frame, not the simulation.
- `readRenderTargetPixelsAsync` arrives one or two frames late. Buoyancy is a
  stiff spring; feeding it a stale surface makes floats buzz instead of settle.

So nothing is ever read back. The coarse CPU field integrates the same equation
from the same splats, and buoyancy samples that. The two agree on the
low-frequency content — the swells that actually carry force — while the fine
ripples that only exist on the GPU field are a visual detail that would move
nothing anyway.

Both fields use texel-centred cells, so cell `(i, j)` sits at the same fraction
of the pool in each, and both derive their wave speed from the same
`waterDepthAt`.

## The scheme

`h` is integrated with an explicit leapfrog step of the conservative wave
equation:

```
h(t+1) = h(t) + (h(t) - h(t-1)) * rateKeep + div(c^2 grad h)
```

- **Conservative form.** The floor slopes, so `c` varies from row to row. Only
  `div(c^2 grad h)` — with face weights averaged between adjacent cells — keeps
  energy honest as a wave shoals into the shallow end. The naive
  `c^2 * laplacian(h)` quietly manufactures amplitude there.
- **Stability.** Each stencil weight `K = (c dt / dx)^2` is capped at 0.24, so
  the four weights sum to at most 0.96 and the update can never amplify. The cap,
  not the tuning knobs, is what guarantees the field stays finite whatever the
  GUI is set to.
- **Damping is viscous.** It sheds the surface's *rate*. Scaling the whole
  update instead pulls a standing bump towards zero, which conjures vertical
  velocity out of nothing and drives the field's energy up rather than down.
- **Level decay** bleeds any net volume the splats inject, and scales *both*
  time levels by the same factor so it does not reintroduce that same problem.
- **Boundaries are Neumann.** Neighbour lookups clamp at the edges (and the GPU
  targets are clamp-to-edge), so pool walls reflect waves instead of swallowing
  them. That ringing is a large part of reading as a pool rather than open water.

`WaveFieldCPU.energy()` is the discrete energy the scheme conserves — kinetic
from the height rate, potential from the surface gradient, with the gradient
terms pairing consecutive time levels. Squaring a single level instead leaves
the sum oscillating at the wave frequency, because the scheme stores height and
rate half a step apart. The tests use it to check that damping actually removes
energy.

## Splats

Every interaction in the simulation speaks one language: `WaveSplat`, a gaussian
of a given radius and displacement at a point. A bobbing float, a swimmer's hand
entering the water, a landing droplet, a click on the surface — all of them push
into `SplatQueue`, and both fields consume the identical list each step.

Two things matter about how they are applied:

- **They displace both time levels.** Writing only the current level leaves the
  solver reading an implied vertical velocity of `strength / dt` — tens of metres
  per second for a centimetre-scale splash — and the field balloons far past the
  amplitude that was asked for.
- **On the GPU they are a separate pass.** The step's stencil reads four
  neighbours, and those neighbours have to already carry the splat, or the
  disturbance propagates from a surface the solver never saw. The splat pass
  runs `stateA -> stateB` and the step runs `stateB -> stateA`.

The wave fields take `WAVE_SUBSTEPS` steps per physics step, and the splat list
is injected on the first substep only — passing it every time would inject the
disturbance twice on the GPU and once on the CPU.

## Cadence

```
PHYSICS_DT = 1/120   entities, rigid bodies, spray
WAVE_DT    = 1/240   both height fields (WAVE_SUBSTEPS = 2 per physics step)
```

Nothing in the simulation ever sees a variable time step. Rendering runs at
whatever rate the display gives; `App.frame` accumulates real time and spends it
in fixed steps, dropping the backlog rather than spiralling if the machine
cannot keep up.

## Wave speed, and why the GUI slider stops at 0.7

`waveSpeedAt(depth, scale) = scale * sqrt(g * depth)`, capped by the stencil
weight. The GPU field has the smaller cells, so it hits the 0.24 cap first. Past
a scale of about 0.7 the GPU field is clamped while the coarser CPU field is
still well inside its own limit, and the waves on screen would start travelling
slower than the ones moving the floats. The slider stops short of that.

## Flow and foam

`FlowField` is analytic — directed jets with a distance falloff and a forward
cone, plus Rankine vortices — evaluated on demand. It is baked to a small RG
texture each time it changes, which the foam advection and the water's detail
normals both read, so drifting foam, drifting floats and the drifting surface
texture all agree.

`FoamField` advects that foam semi-Lagrangian along the current, decays it, and
deposits more wherever the surface is churning (read straight off the two stored
time levels) or wherever a splat asked for it.
