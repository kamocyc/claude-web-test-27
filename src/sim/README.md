# Water simulation

Two height fields run side by side over the same pool, driven by the same
sources, with the same wave speed.

| | `WaveField` (GPU) | `WaveFieldCPU` |
|---|---|---|
| Resolution | 512 x 320 (quality preset) | 128 x 80 |
| Storage | two RGBA32F targets, ping-ponged; R = h(t), G = h(t-1) | three `Float32Array`s |
| Read by | the water surface shader, foam, caustics | buoyancy, spray, click tests |

### The state targets must be full float

This is not a quality setting. Half float carries about eleven bits of mantissa,
so its resolution is roughly one part in a thousand — and the level decay is a
multiply by `1 - levelDecay * dt` = `1 - 2.1e-4` per step. That is always less
than half an ULP, so it rounds straight back to the value it started from, at
every height the pool ever reaches.

The effect is that the decay silently does not happen. Any net volume the splats
inject then accumulates with nothing to bleed it off, and over a few minutes the
whole surface lifts and sails away. Meanwhile the CPU field, in float32, bleeds
it correctly and stays flat — so the two disagree, and the one you can see is the
broken one.

`WaveField.highPrecision` records whether `EXT_color_buffer_float` was available.
The smoke test asserts it. Everything downstream — normals, foam — is fine at
half precision, because their per-step changes are far larger relative to their
magnitudes.

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
- **On the GPU they are stamped into a copy.** The step's stencil reads four
  neighbours, and those neighbours have to already carry the splat, or the
  disturbance propagates from a surface the solver never saw. So `stateA` is
  copied to `stateB`, `SplatRenderer` stamps the splats into it additively, and
  the step runs `stateB -> stateA`.
- **There is no cap on how many.** `SplatRenderer` draws one instanced quad per
  splat, sized to its own three-sigma footprint. The earlier version looped over
  an array of shader uniforms, which capped at 32 while a busy pool produces
  well over a hundred a step — everything past the cap was dropped, so the field
  you looked at and the field bodies felt stopped agreeing. Instancing is also
  cheaper: a splat only rasterises the texels it can actually affect.

### The wake term damps as readily as it radiates

The buoyancy wake is driven by each sphere's vertical speed *relative to the
surface*. That is the physically right form — it is radiation damping — but it
means the term is a relaxation that pins the water to the body, and it cannot
tell the difference between making a wave and absorbing one.

At the magnitude the "displaced volume per unit time" argument suggests, it
cancels roughly a third of the surface's own motion every step, giving a time
constant of about 30 ms. A swimmer drags seven such patches around the pool and
erases the craters their own hands just made; five swimmers iron the whole pool
flat. Measured, that state was a peak amplitude of 0.26 mm after fifty seconds
of hard swimming.

So the gain is held at roughly an eighth of that scale, and it is not what makes
the waves. **Wave generation is the job of the event-driven impulses** — hand
entries, kicks, the bow-wave dipole, the impulse an object emits as it lands.
Those are one-shot and volume-neutral, so they can be as emphatic as the look
needs without putting the level at risk. The continuous term only bleeds off the
residual.

`tests/waterResponse.test.ts` is the guard. Every other suite here checks the
field cannot blow up or drift; none of them noticed the pool going flat, because
a dead simulation satisfies every stability bound there is.

### Splats must be volume-neutral

Nothing in the scheme conserves volume on its own, and the level decay is a
safety net rather than the mechanism. Every source is therefore built to add no
net water:

- The buoyancy wake carries the sign of the body's vertical motion *relative to
  the surface*. Moving down into the water pushes the surface down at the
  contact — the crater a ball makes as it lands. Getting this backwards inverts
  the coupling into positive feedback: a rising surface emits a splat that
  raises it further.
- The bow wave goes in as a dipole, positive ahead of the body and negative
  behind. A single unsigned bump would make every moving object a steady source.
- Splashes — a landing droplet, a hand entering, a click — use
  `SplatQueue.addImpulse`, which emits a crater *and* a rim whose volumes cancel
  exactly (a gaussian's volume is `amplitude * 2*pi*sigma^2`, so a rim at twice
  the radius takes a quarter of the amplitude). A bare one-sided dent is a
  steady sink. It also happens to be what a splash looks like.

`tests/waterLevel.test.ts` pins this by running a full pool for two and a half
minutes with the level decay switched *off*, which is the condition the GPU was
unknowingly running under.

The two suites are deliberately a pair, and both are needed. `waterLevel` fails
if the water gains or loses volume; `waterResponse` fails if it stops moving.
Either one alone can be satisfied by breaking the other.

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
cone, Rankine vortices, and the lazy river's channel — evaluated on demand. It
is baked to a small RG texture each time it changes, which the foam advection
and the water's detail normals both read, so drifting foam, drifting floats and
the drifting surface texture all agree.

The channel is the one worth explaining. Its velocity is tangential to the
island's outline everywhere, with a magnitude that depends only on the distance
from the island's axis. Written that way it is divergence-free by construction:
along the straight sides the speed does not vary with x and there is no
cross-channel component, and round the ends the flow is purely azimuthal. That
matters because the current drags on every floating body, and a source or a sink
hidden in it would show up as the water level walking away over a long
session — the exact failure `waterLevel` exists to catch. Being able to make the
river as strong as it needs to be without touching the level rests on it.

The two banks are deliberately not symmetric. The profile ramps up over a
quarter of the channel's width at the island and falls off over an eighth of it
at the outer wall, because a float carried through a bend ends up pressed
against the outer bank: with a symmetric profile it would be sitting in still
water and would stop there for good. `tests/lazyRiver.test.ts` measures the
speed against that bank for exactly this reason.

`FoamField` advects that foam semi-Lagrangian along the current, decays it, and
deposits more wherever the surface is churning (read straight off the two stored
time levels) or wherever a splat asked for it.
