/**
 * Surface pass shaders (GLSL ES 3.00).
 *
 * Two-sided lighting is not optional here: almost every surface in do Carmo is an
 * open patch (helicoid, catenoid, saddle, Enneper) or is being cut away by domain
 * insets, so the back face is visible constantly. A one-sided model renders those
 * interiors black and reads as a rendering bug.
 */

export const surfaceVertex = /* glsl */ `#version 300 es
precision highp float;

in vec3 aPosition;
in vec3 aNormal;
in vec2 aChart;
in vec3 aColor;

uniform mat4 uView;
uniform mat4 uProjection;

out vec3 vWorldPosition;
out vec3 vNormal;
out vec2 vChart;
out vec3 vColor;

void main() {
  vWorldPosition = aPosition;
  vNormal = aNormal;
  vChart = aChart;
  vColor = aColor;
  gl_Position = uProjection * uView * vec4(aPosition, 1.0);
}
`;

export const surfaceFragment = /* glsl */ `#version 300 es
precision highp float;

in vec3 vWorldPosition;
in vec3 vNormal;
in vec2 vChart;
in vec3 vColor;

uniform vec3 uEye;
uniform vec3 uBaseColor;
uniform float uGridOpacity;
uniform vec2 uGridSpacing;
/** 0 = flat base colour, 1 = per-vertex curvature colour */
uniform float uCurvatureMix;

out vec4 fragColor;

const vec3 LIGHT_KEY_DIR   = normalize(vec3( 5.0, 8.0,  3.0));
const vec3 LIGHT_FILL_DIR  = normalize(vec3(-4.0,-2.0, -5.0));
/**
 * Lighting gains, chosen so the total multiplier never exceeds 1.
 *
 * On a white background a surface can only read by being DARKER than the page, so any face that
 * saturates is a face that has disappeared. AMBIENT + KEY + FILL = 1 keeps the brightest lit face
 * exactly at its albedo and lets everything else fall below it; the old values summed to 1.4,
 * which was right against black and blows a light albedo out to flat white here.
 */
const float AMBIENT = 0.52;
const float KEY     = 0.36;
const float FILL    = 0.12;

/* Chart grid lines, drawn as a screen-space-derivative-antialiased overlay so the
   parametrization stays visible without a separate wireframe pass. */
float chartGrid(vec2 uv, vec2 spacing) {
  vec2 t = uv / spacing;
  vec2 w = fwidth(t);
  vec2 d = abs(fract(t - 0.5) - 0.5) / max(w, vec2(1e-5));
  return 1.0 - min(min(d.x, d.y), 1.0);
}

void main() {
  vec3 n = normalize(vNormal);
  vec3 albedo = mix(uBaseColor, vColor, uCurvatureMix);

  /* A zero normal means the mesh builder found a degenerate vertex (a cone tip, a
     chart pole). Shade it flat rather than letting normalize() produce NaN. */
  if (dot(vNormal, vNormal) < 1e-12) {
    fragColor = vec4(albedo * AMBIENT, 1.0);
    return;
  }

  vec3 viewDir = normalize(uEye - vWorldPosition);
  if (dot(n, viewDir) < 0.0) n = -n;

  float key  = max(dot(n, LIGHT_KEY_DIR),  0.0);
  float fill = max(dot(n, LIGHT_FILL_DIR), 0.0);

  /* The rim term DARKENS here rather than adding light. Its job is to separate the silhouette
     from the background, and against white that means the edge has to fall away from the page,
     not glow into it — an additive rim on a light background erases the outline it exists to
     draw. Same shape of falloff, opposite sign. */
  float rim = pow(1.0 - max(dot(n, viewDir), 0.0), 3.0) * 0.30;

  vec3 color = albedo * (AMBIENT + KEY * key + FILL * fill) * (1.0 - rim);

  float grid = chartGrid(vChart, uGridSpacing) * uGridOpacity;
  /* Grid lines darker than any albedo, for the same reason as the rim: a near-white line was
     legible on a dark surface and vanishes on a pale one. */
  color = mix(color, vec3(0.20, 0.26, 0.33), grid * 0.38);

  fragColor = vec4(color, 1.0);
}
`;
