/**
 * Whitewater: advected by the current, decaying everywhere, deposited wherever
 * the surface is churning.
 *
 * The churn term reads the two stored time levels and deposits foam in
 * proportion to how fast the surface is moving vertically, so wave crests
 * whipped up by a swimmer go white without anyone having to spawn foam
 * explicitly. Splashes add their own on top, stamped in afterwards by
 * SplatRenderer.
 */
export const FOAM_STEP_FRAG = /* glsl */ `
varying vec2 vUv;
uniform sampler2D uFoam;
uniform sampler2D uState;
uniform sampler2D uFlow;
uniform float uDt;
uniform float uDecay;
uniform float uChurnThreshold;
uniform float uChurnGain;
uniform vec2 uDomain;

void main() {
  // Semi-Lagrangian advection: look back along the current.
  vec2 flow = texture2D(uFlow, vUv).rg;
  vec2 source = vUv - (flow * uDt) / uDomain;
  float foam = texture2D(uFoam, clamp(source, vec2(0.0), vec2(1.0))).r;

  foam *= exp(-uDecay * uDt);

  vec4 state = texture2D(uState, vUv);
  float churn = abs(state.r - state.g) / max(uDt, 1e-5);
  foam += smoothstep(uChurnThreshold, uChurnThreshold * 3.0, churn) * uChurnGain * uDt;

  gl_FragColor = vec4(clamp(foam, 0.0, 1.0), 0.0, 0.0, 1.0);
}
`
