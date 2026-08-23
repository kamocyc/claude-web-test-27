import { FRESNEL_GLSL, GGX_GLSL, SKY_GLSL } from '../../sim/shaders/common'

export const WATER_VERT = /* glsl */ `
uniform sampler2D uSurface;
uniform vec2 uDomain;
uniform mat4 uReflectionMatrix;

varying vec3 vWorldPos;
varying vec2 vFieldUv;
varying vec4 vReflectUv;
varying vec3 vViewPos;

void main() {
  // Field UV comes from the undisplaced XZ position rather than the geometry's
  // own uv attribute: the plane is pre-rotated into XZ, and deriving the
  // lookup from world space removes any doubt about which way v runs.
  vec2 fieldUv = position.xz / uDomain + 0.5;
  vFieldUv = fieldUv;

  vec3 displaced = position;
  displaced.y += texture2D(uSurface, fieldUv).a;

  vec4 world = modelMatrix * vec4(displaced, 1.0);
  vWorldPos = world.xyz;
  vReflectUv = uReflectionMatrix * world;

  vec4 viewPosition = viewMatrix * world;
  vViewPos = viewPosition.xyz;
  gl_Position = projectionMatrix * viewPosition;
}
`

export const WATER_FRAG = /* glsl */ `
uniform sampler2D uSurface;
uniform sampler2D uFoam;
uniform sampler2D uFlow;
uniform sampler2D uRipple;
uniform sampler2D uSceneColor;
uniform sampler2D uSceneDepth;
uniform sampler2D uReflection;

uniform vec2 uResolution;
uniform vec2 uDomain;
uniform float uCameraNear;
uniform float uCameraFar;
uniform float uTime;
uniform float uReflectionMix;
uniform float uRefractionScale;
uniform float uDetailStrength;
uniform float uDetailScale;
uniform float uEdgeSoftness;
uniform vec3 uAbsorption;
uniform vec3 uDeepColor;
uniform vec3 uFoamColor;
uniform float uRoughness;
uniform float uGlitter;

varying vec3 vWorldPos;
varying vec2 vFieldUv;
varying vec4 vReflectUv;
varying vec3 vViewPos;

${SKY_GLSL}
${FRESNEL_GLSL}
${GGX_GLSL}

/** Window-space depth to positive distance along the view ray. */
float linearDistance(float depth) {
  float ndc = depth * 2.0 - 1.0;
  return (2.0 * uCameraNear * uCameraFar) /
         (uCameraFar + uCameraNear - ndc * (uCameraFar - uCameraNear));
}

/** Two scrolling octaves of ripple normal, carried along by the current. */
vec3 detailNormal(vec2 flow) {
  vec2 drift = flow * uTime * 0.06;
  vec2 uvA = vWorldPos.xz * uDetailScale - drift + vec2(uTime * 0.013, uTime * 0.021);
  vec2 uvB = vWorldPos.xz * uDetailScale * 2.17 - drift * 1.6 - vec2(uTime * 0.024, uTime * 0.011);

  vec3 a = texture2D(uRipple, uvA).xyz * 2.0 - 1.0;
  vec3 b = texture2D(uRipple, uvB).xyz * 2.0 - 1.0;
  vec2 slope = (a.xy + b.xy * 0.55) * uDetailStrength;
  // The ripple map is world-aligned: its x maps to world x, its y to world z.
  return normalize(vec3(slope.x, 1.0, slope.y));
}

void main() {
  vec4 surface = texture2D(uSurface, vFieldUv);
  vec2 flow = texture2D(uFlow, vFieldUv).rg;
  float foam = texture2D(uFoam, vFieldUv).r;

  vec3 simNormal = normalize(surface.xyz);
  vec3 detail = detailNormal(flow);
  vec3 normal = normalize(vec3(simNormal.x + detail.x, 1.0, simNormal.z + detail.z));

  vec3 viewDir = normalize(cameraPosition - vWorldPos);
  vec2 screenUv = gl_FragCoord.xy / uResolution;
  float waterDistance = -vViewPos.z;

  // --- Refraction and absorption -------------------------------------------
  float sceneDistance = linearDistance(texture2D(uSceneDepth, screenUv).x);
  float thickness = max(sceneDistance - waterDistance, 0.0);

  vec2 offset = normal.xz * uRefractionScale * min(thickness, 2.0);
  vec2 refractUv = clamp(screenUv + offset, vec2(0.001), vec2(0.999));
  float refractedSceneDistance = linearDistance(texture2D(uSceneDepth, refractUv).x);
  // If the distorted sample lands on something in front of the water, the
  // offset has dragged an object over the surface. Fall back to the straight
  // sample rather than smearing a swimmer's arm across the pool.
  if (refractedSceneDistance < waterDistance) {
    refractUv = screenUv;
    refractedSceneDistance = sceneDistance;
  }
  float pathLength = max(refractedSceneDistance - waterDistance, 0.0);

  vec3 refracted = texture2D(uSceneColor, refractUv).rgb;
  vec3 transmittance = exp(-uAbsorption * pathLength);
  vec3 underwater = refracted * transmittance + uDeepColor * (1.0 - transmittance);

  // --- Reflection -----------------------------------------------------------
  vec3 reflectDir = reflect(-viewDir, normal);
  vec3 sky = skyColor(reflectDir);

  vec2 reflectUv = vReflectUv.xy / max(vReflectUv.w, 1e-4) + normal.xz * 0.055;
  float inside = step(0.0, reflectUv.x) * step(reflectUv.x, 1.0) *
                 step(0.0, reflectUv.y) * step(reflectUv.y, 1.0);
  vec3 mirrored = texture2D(uReflection, clamp(reflectUv, vec2(0.0), vec2(1.0))).rgb;
  vec3 reflection = mix(sky, mirrored, inside * uReflectionMix);

  // --- Combine --------------------------------------------------------------
  float fresnel = fresnelSchlick(max(dot(normal, viewDir), 0.0), 0.02);
  vec3 color;
  float alpha = 1.0;

  if (gl_FrontFacing) {
    color = mix(underwater, reflection, fresnel);

    // Sun glitter. GGX peaks in the thousands at these roughnesses, so it is
    // weighted by the Fresnel term and clamped: without the ceiling the glitter
    // path washes out into one flat white sheet across half the pool.
    float glitter = ggxSpecular(normal, viewDir, uSunDirection, uRoughness);
    color += uSunColor * min(glitter * fresnel * uGlitter, 1.6);

    // Whitewater sits on top and roughens the surface where it lands.
    float foamMask = smoothstep(0.05, 0.55, foam);
    color = mix(color, uFoamColor, foamMask * 0.85);

    // Feather the very edge so the waterline against tiles and skin is soft
    // rather than a hard geometric seam.
    alpha = clamp(thickness / max(uEdgeSoftness, 1e-3), 0.0, 1.0);
    alpha = mix(alpha, 1.0, foamMask * 0.6);
  } else {
    // Seen from below. Beyond the critical angle the surface mirrors the pool
    // back at you; inside it, a bright circle of sky - the Snell window.
    vec3 upward = refract(-viewDir, -normal, 1.3333);
    float totalInternal = step(dot(upward, upward), 1e-6);
    vec3 window = skyColor(normalize(upward + vec3(0.0, 1e-4, 0.0)));
    color = mix(window, uDeepColor * 1.35, totalInternal);
    color = mix(color, uFoamColor, smoothstep(0.1, 0.7, foam) * 0.5);
  }

  gl_FragColor = vec4(color, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`
