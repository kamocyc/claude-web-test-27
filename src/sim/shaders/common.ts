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
 * Wave-speed weight for one row of the field.
 *
 * Mirrors WaveFieldCPU.updateRowK, including the 0.24 cap: the two fields must
 * agree on how fast waves travel, or the ripples you see and the forces bodies
 * feel would drift apart.
 */
export const WAVE_SPEED_GLSL = /* glsl */ `
uniform float uShallowDepth;
uniform float uDeepDepth;
uniform float uSpeedScale;
uniform float uDt;
uniform float uCellSize;

float stencilWeight(float v) {
  float depth = max(uShallowDepth + (uDeepDepth - uShallowDepth) * v, 0.05);
  float speed = uSpeedScale * sqrt(9.81 * depth);
  float courant = speed * uDt / uCellSize;
  return min(0.24, courant * courant);
}
`

/** Uniform block and evaluation for the gaussian splats. */
export const SPLAT_GLSL = /* glsl */ `
#define MAX_SPLATS 32
uniform int uSplatCount;
// xy = world centre, z = sigma (metres), w = displacement (metres)
uniform vec4 uSplats[MAX_SPLATS];
uniform vec4 uSplatFoam[MAX_SPLATS];
uniform vec2 uDomain;

vec2 worldFromUv(vec2 uv) {
  return (uv - 0.5) * uDomain;
}

float splatHeight(vec2 world) {
  float total = 0.0;
  for (int i = 0; i < MAX_SPLATS; i++) {
    if (i >= uSplatCount) break;
    vec4 s = uSplats[i];
    vec2 d = world - s.xy;
    total += s.w * exp(-dot(d, d) / (2.0 * s.z * s.z));
  }
  return total;
}

float splatFoam(vec2 world) {
  float total = 0.0;
  for (int i = 0; i < MAX_SPLATS; i++) {
    if (i >= uSplatCount) break;
    vec4 s = uSplatFoam[i];
    vec2 d = world - s.xy;
    total += s.w * exp(-dot(d, d) / (2.0 * s.z * s.z));
  }
  return total;
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
