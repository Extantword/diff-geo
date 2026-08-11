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

uniform mat4 uView;
uniform mat4 uProjection;

out vec3 vWorldPosition;
out vec3 vNormal;
out vec2 vChart;

void main() {
  vWorldPosition = aPosition;
  vNormal = aNormal;
  vChart = aChart;
  gl_Position = uProjection * uView * vec4(aPosition, 1.0);
}
`;

export const surfaceFragment = /* glsl */ `#version 300 es
precision highp float;

in vec3 vWorldPosition;
in vec3 vNormal;
in vec2 vChart;

uniform vec3 uEye;
uniform vec3 uBaseColor;
uniform float uGridOpacity;
uniform vec2 uGridSpacing;

out vec4 fragColor;

const vec3 LIGHT_KEY_DIR   = normalize(vec3( 5.0, 8.0,  3.0));
const vec3 LIGHT_FILL_DIR  = normalize(vec3(-4.0,-2.0, -5.0));
const float AMBIENT = 0.30;
const float KEY     = 0.85;
const float FILL    = 0.25;

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

  /* A zero normal means the mesh builder found a degenerate vertex (a cone tip, a
     chart pole). Shade it flat rather than letting normalize() produce NaN. */
  if (dot(vNormal, vNormal) < 1e-12) {
    fragColor = vec4(uBaseColor * AMBIENT, 1.0);
    return;
  }

  vec3 viewDir = normalize(uEye - vWorldPosition);
  if (dot(n, viewDir) < 0.0) n = -n;

  float key  = max(dot(n, LIGHT_KEY_DIR),  0.0);
  float fill = max(dot(n, LIGHT_FILL_DIR), 0.0);

  /* A touch of rim light reads the silhouette against the dark background, which is
     what makes the shape legible when curvature colours flatten the diffuse term. */
  float rim = pow(1.0 - max(dot(n, viewDir), 0.0), 3.0) * 0.25;

  vec3 color = uBaseColor * (AMBIENT + KEY * key + FILL * fill) + vec3(rim);

  float grid = chartGrid(vChart, uGridSpacing) * uGridOpacity;
  color = mix(color, vec3(0.85, 0.92, 0.98), grid * 0.35);

  fragColor = vec4(color, 1.0);
}
`;
