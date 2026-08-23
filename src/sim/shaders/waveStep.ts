import { SPLAT_GLSL, WAVE_SPEED_GLSL } from './common'

/**
 * Adds this step's gaussian splats to both stored time levels.
 *
 * A separate pass rather than a term folded into the step: the step's stencil
 * reads its four neighbours, and those neighbours have to already carry the
 * splat or the disturbance would propagate from a surface the solver never
 * actually saw. Displacing both levels — rather than just the current one —
 * starts the disturbance at rest; see WaveFieldCPU.splat for why that matters.
 */
export const WAVE_SPLAT_FRAG = /* glsl */ `
varying vec2 vUv;
uniform sampler2D uState;
${SPLAT_GLSL}

void main() {
  vec4 state = texture2D(uState, vUv);
  float bump = splatHeight(worldFromUv(vUv));
  gl_FragColor = vec4(state.r + bump, state.g + bump, 0.0, 1.0);
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

void main() {
  vec4 state = texture2D(uState, vUv);
  float h = state.r;
  float hPrev = state.g;

  float left = texture2D(uState, vec2(vUv.x - uTexel.x, vUv.y)).r;
  float right = texture2D(uState, vec2(vUv.x + uTexel.x, vUv.y)).r;
  float up = texture2D(uState, vec2(vUv.x, vUv.y - uTexel.y)).r;
  float down = texture2D(uState, vec2(vUv.x, vUv.y + uTexel.y)).r;

  float k = stencilWeight(vUv.y);
  float kUp = 0.5 * (k + stencilWeight(vUv.y - uTexel.y));
  float kDown = 0.5 * (k + stencilWeight(vUv.y + uTexel.y));

  float divergence = k * (left + right - 2.0 * h) + kUp * (up - h) + kDown * (down - h);
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
