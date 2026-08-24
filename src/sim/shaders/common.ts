/**
 * GLSL fragments shared between passes.
 *
 * Everything here is written for three.js's default GLSL1 dialect, which the
 * renderer transparently upgrades for WebGL2.
 */

/**
 * Analytic sky. The same function shades the sky dome, feeds the environment
 * map, and supplies the water's distant reflection, so a reflected sunset
 * matches the sunset overhead instead of drifting away from it.
 */
export const SKY_GLSL = /* glsl */ `
uniform vec3 uSunDirection;
uniform vec3 uSunColor;
uniform vec3 uZenithColor;
uniform vec3 uHorizonColor;
uniform vec3 uGroundColor;
uniform float uSkyIntensity;

vec3 skyColor(vec3 dir) {
  float up = dir.y;
  vec3 sky = mix(uHorizonColor, uZenithColor, pow(clamp(up, 0.0, 1.0), 0.55));

  // Warm scatter around the sun, plus a tight disc.
  float sun = max(dot(dir, uSunDirection), 0.0);
  sky += uSunColor * pow(sun, 8.0) * 0.28;
  sky += uSunColor * pow(sun, 900.0) * 14.0;

  // Below the horizon we are looking at the deck, not the sky.
  float ground = smoothstep(0.02, -0.06, up);
  return mix(sky, uGroundColor, ground) * uSkyIntensity;
}
`

/** Schlick's approximation of the Fresnel reflectance of a dielectric. */
export const FRESNEL_GLSL = /* glsl */ `
float fresnelSchlick(float cosTheta, float f0) {
  float m = clamp(1.0 - cosTheta, 0.0, 1.0);
  float m2 = m * m;
  return f0 + (1.0 - f0) * m2 * m2 * m;
}
`

/** GGX specular for a single directional light — the sun glitter on the waves. */
export const GGX_GLSL = /* glsl */ `
float ggxSpecular(vec3 normal, vec3 viewDir, vec3 lightDir, float roughness) {
  vec3 halfway = normalize(viewDir + lightDir);
  float nDotH = max(dot(normal, halfway), 0.0);
  float nDotL = max(dot(normal, lightDir), 0.0);
  float nDotV = max(dot(normal, viewDir), 1e-4);
  float a = max(roughness * roughness, 1e-4);
  float a2 = a * a;

  float d = nDotH * nDotH * (a2 - 1.0) + 1.0;
  float distribution = a2 / (3.14159265 * d * d);

  float k = a * 0.5;
  float gv = nDotV / (nDotV * (1.0 - k) + k);
  float gl = nDotL / (nDotL * (1.0 - k) + k);

  return distribution * gv * gl * nDotL / (4.0 * nDotV);
}
`

/**
 * Wave-speed weight for one texel of the field.
 *
 * Mirrors WaveFieldCPU.updateCellK, including the 0.24 cap: the two fields must
 * agree on how fast waves travel, or the ripples you see and the forces bodies
 * feel would drift apart. The depth comes from the bathymetry texture rather
 * than a formula, because there is more than one basin now and they do not
 * share a floor.
 */
export const WAVE_SPEED_GLSL = /* glsl */ `
uniform sampler2D uBathymetry;
uniform float uSpeedScale;
uniform float uDt;
uniform float uCellSize;

/** R = water depth in metres, G = 1 where there is water. */
vec2 bathymetryAt(vec2 uv) {
  return texture2D(uBathymetry, uv).rg;
}

float stencilWeight(float depth) {
  if (depth <= 0.0) return 0.0;
  float speed = uSpeedScale * sqrt(9.81 * max(depth, 0.05));
  float courant = speed * uDt / uCellSize;
  return min(0.24, courant * courant);
}
`

/** Vertex shader for every fullscreen simulation pass. */
export const FULLSCREEN_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`
