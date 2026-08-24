/**
 * Caustics by ray convergence.
 *
 * Each texel refracts a sun ray through the surface normal and works out where
 * it lands on the floor. Comparing that landing point with its neighbours' gives
 * the Jacobian of the mapping, and the brightness is its reciprocal: where
 * neighbouring rays bunch together the floor is bright, where they spread it is
 * dim. That is the actual mechanism, so the bands move and braid the way real
 * ones do instead of scrolling like a texture.
 */
export const CAUSTICS_FRAG = /* glsl */ `
varying vec2 vUv;
uniform sampler2D uNormal;
uniform vec2 uTexel;
uniform vec2 uDomain;
uniform vec3 uSunDirection;
uniform sampler2D uBathymetry;
uniform float uStrength;

const float IOR_AIR_TO_WATER = 0.7519; // 1.0 / 1.33

vec2 landingPoint(vec2 uv) {
  vec4 surface = texture2D(uNormal, uv);
  vec3 normal = normalize(surface.xyz);
  vec3 refracted = refract(-uSunDirection, normal, IOR_AIR_TO_WATER);
  float floorDepth = texture2D(uBathymetry, uv).r;
  float travel = (floorDepth + surface.w) / max(-refracted.y, 1e-3);
  return uv + (refracted.xz * travel) / uDomain;
}

void main() {
  if (texture2D(uBathymetry, vUv).g < 0.5) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  vec2 centre = landingPoint(vUv);
  vec2 alongX = landingPoint(vUv + vec2(uTexel.x, 0.0)) - centre;
  vec2 alongZ = landingPoint(vUv + vec2(0.0, uTexel.y)) - centre;

  float spread = abs(alongX.x * alongZ.y - alongX.y * alongZ.x);
  // 'flat' is a reserved word in GLSL, hence the name.
  float flatArea = uTexel.x * uTexel.y;
  float intensity = flatArea / max(spread, flatArea * 0.06);

  gl_FragColor = vec4(clamp((intensity - 1.0) * uStrength, 0.0, 6.0), 0.0, 0.0, 1.0);
}
`

/**
 * Injected into the pool's standard material so the floor and walls pick the
 * caustics up with the rest of their lighting.
 *
 * The pattern is computed in surface space, so a floor fragment has to look
 * back up along the refracted sun ray to find the patch of surface that lit it.
 * Sampling straight overhead instead slides the whole pattern sideways as the
 * sun moves, which reads as a bug the moment you drag the time of day.
 */
export const CAUSTICS_RECEIVER_GLSL = /* glsl */ `
uniform sampler2D uCaustics;
uniform vec2 uCausticsDomain;
uniform vec2 uCausticsCentre;
uniform vec3 uCausticsSun;
uniform float uCausticsWaterLevel;
uniform float uCausticsIntensity;
uniform vec3 uCausticsTint;
varying vec3 vPoolWorldPos;

vec3 poolCaustics() {
  float below = uCausticsWaterLevel - vPoolWorldPos.y;
  if (below <= 0.0 || uCausticsIntensity <= 0.0) return vec3(0.0);

  vec3 refracted = refract(-normalize(uCausticsSun), vec3(0.0, 1.0, 0.0), 0.7519);
  vec2 back = (refracted.xz * (below / max(-refracted.y, 1e-3))) / uCausticsDomain;
  vec2 uv = (vPoolWorldPos.xz - uCausticsCentre) / uCausticsDomain + 0.5 - back;

  // Deep floor near the far wall is lit by surface that lies outside the
  // simulated domain, so the lookup runs off the edge of the texture. Fade it
  // out rather than cutting: a hard bounds test draws a visible seam straight
  // across the pool, right where the back-projection first leaves range.
  vec2 edge = smoothstep(vec2(0.0), vec2(0.07), uv) *
              (vec2(1.0) - smoothstep(vec2(0.93), vec2(1.0), uv));
  float border = edge.x * edge.y;
  if (border <= 0.0) return vec3(0.0);

  float caustic = texture2D(uCaustics, clamp(uv, vec2(0.0), vec2(1.0))).r;
  // Deep water blurs and dims the pattern; shallow water keeps it sharp.
  float fade = exp(-below * 0.32);
  return uCausticsTint * caustic * uCausticsIntensity * fade * border;
}
`
