import { WAVE_SPEED_GLSL } from './common'

/**
 * Straight copy between the two state targets.
 *
 * The step's stencil reads four neighbours, so those neighbours have to already
 * carry this step's splats — otherwise the disturbance propagates out of a
 * surface the solver never actually saw. So the splats are stamped into a copy
 * first (by SplatRenderer, additively) and the step then reads that copy.
 */
export const COPY_FRAG = /* glsl */ `
varying vec2 vUv;
uniform sampler2D uState;

void main() {
  gl_FragColor = texture2D(uState, vUv);
}
`

/**
 * One step of the wave equation, in the conservative form div(c^2 grad h).
 *
 * Kept line-for-line equivalent to WaveFieldCPU.step: same face-averaged
 * weights, same viscous damping on the rate, same level bleed applied to both
 * time levels. Clamp-to-edge sampling gives the reflecting pool walls for free.
 */
export const WAVE_STEP_FRAG = /* glsl */ `
varying vec2 vUv;
uniform sampler2D uState;
uniform vec2 uTexel;
uniform float uRateKeep;
uniform float uLevelKeep;
${WAVE_SPEED_GLSL}

/**
 * A neighbour's height and the weight of the face leading to it.
 *
 * On land there is no neighbour: the reading texel gets its own height back,
 * so the face carries no flux and the wave bounces. WaveFieldCPU reaches the
 * same place by writing that height into the dry cell itself; the two agree
 * everywhere except inside a concave corner, where the CPU averages the two
 * shores that meet there.
 */
vec2 neighbour(vec2 uv, float h, float k) {
  vec2 bathymetry = bathymetryAt(uv);
  if (bathymetry.g < 0.5) return vec2(h, k);
  return vec2(texture2D(uState, uv).r, stencilWeight(bathymetry.r));
}

void main() {
  vec2 own = bathymetryAt(vUv);
  if (own.g < 0.5) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  vec4 state = texture2D(uState, vUv);
  float h = state.r;
  float hPrev = state.g;
  float k = stencilWeight(own.r);

  vec2 left = neighbour(vec2(vUv.x - uTexel.x, vUv.y), h, k);
  vec2 right = neighbour(vec2(vUv.x + uTexel.x, vUv.y), h, k);
  vec2 up = neighbour(vec2(vUv.x, vUv.y - uTexel.y), h, k);
  vec2 down = neighbour(vec2(vUv.x, vUv.y + uTexel.y), h, k);

  float divergence =
    0.5 * (k + left.y) * (left.x - h) +
    0.5 * (k + right.y) * (right.x - h) +
    0.5 * (k + up.y) * (up.x - h) +
    0.5 * (k + down.y) * (down.x - h);
  float next = (h + (h - hPrev) * uRateKeep + divergence) * uLevelKeep;

  gl_FragColor = vec4(next, h * uLevelKeep, 0.0, 1.0);
}
`

/**
 * Height field to surface normal, by central difference.
 * RGB is the world-space normal; A carries the height through so the water's
 * vertex shader can displace and shade from a single texture fetch.
 */
export const WAVE_NORMAL_FRAG = /* glsl */ `
varying vec2 vUv;
uniform sampler2D uState;
uniform vec2 uTexel;
uniform vec2 uCell;

void main() {
  float left = texture2D(uState, vec2(vUv.x - uTexel.x, vUv.y)).r;
  float right = texture2D(uState, vec2(vUv.x + uTexel.x, vUv.y)).r;
  float up = texture2D(uState, vec2(vUv.x, vUv.y - uTexel.y)).r;
  float down = texture2D(uState, vec2(vUv.x, vUv.y + uTexel.y)).r;
  float height = texture2D(uState, vUv).r;

  float dhdx = (right - left) / (2.0 * uCell.x);
  float dhdz = (down - up) / (2.0 * uCell.y);
  vec3 normal = normalize(vec3(-dhdx, 1.0, -dhdz));

  gl_FragColor = vec4(normal, height);
}
`
