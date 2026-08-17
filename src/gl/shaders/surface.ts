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
in vec3 aColor;
in vec3 aBaseColor;
in float aStyle;

uniform mat4 uView;
uniform mat4 uProjection;

out vec3 vWorldPosition;
out vec3 vNormal;
out vec3 vColor;
out vec3 vBaseColor;
/**
 * What of this patch is drawn, carried per vertex and NOT interpolated.
 *
 * flat, because it is a set of flags rather than a quantity: every vertex of a triangle belongs
 * to the same patch, so there is nothing to blend, and interpolating would turn "fill" and "grid"
 * into fractions somewhere in between.
 */
flat out float vStyle;

void main() {
  vWorldPosition = aPosition;
  vNormal = aNormal;
  vColor = aColor;
  vBaseColor = aBaseColor;
  vStyle = aStyle;
  gl_Position = uProjection * uView * vec4(aPosition, 1.0);
}
`;

export const surfaceFragment = /* glsl */ `#version 300 es
precision highp float;

in vec3 vWorldPosition;
in vec3 vNormal;
in vec3 vColor;
in vec3 vBaseColor;
flat in float vStyle;

uniform vec3 uEye;
/** 0 = flat base colour, 1 = per-vertex curvature colour */
uniform float uCurvatureMix;
out vec4 fragColor;

/* Above means +z, like everything else here: the camera's up is z because the mathematics puts
   every axis of symmetry there, and a key light left on +y would rake across each surface from
   the side instead of falling on it. */
const vec3 LIGHT_KEY_DIR   = normalize(vec3( 5.0, 3.0,  8.0));
const vec3 LIGHT_FILL_DIR  = normalize(vec3(-4.0,-5.0, -2.0));
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

/**
 * A small specular highlight, and why a matte surface wanted one.
 *
 * Diffuse shading is a function of the normal alone, so two surfaces with the same normals at the
 * eye look identical however differently they curve away — a sphere and a paraboloid shade almost
 * the same from in front. A highlight is a function of the normal's **derivative** as much as the
 * normal: it compresses where curvature is high and stretches where it is low, so it draws the
 * shape of the bend rather than the tilt of the surface. That is worth a lot on a page about
 * curvature.
 *
 * Kept deliberately faint. On a white background a face that saturates is a face that has
 * disappeared, so this is a sheen at a broad exponent rather than a plastic dot, and the diffuse
 * term is scaled back by exactly what the highlight can add so the maximum stays where it was.
 */
const float SPECULAR = 0.09;
const float SHININESS = 24.0;

void main() {
  /**
   * Bit 1 is the shaded face — per patch, not per scene. Bit 2, the chart grid, is not this
   * pass's business any more: the grid is drawn as real curves through the line pass, which is
   * what makes it as smooth as the surface and lets the domain border be part of it. So with the
   * face off there is nothing HERE to draw, and the patch reads as a wireframe you can see
   * through — and, more usefully, see other objects through.
   */
  if (mod(vStyle, 2.0) < 0.5) discard;

  vec3 n = normalize(vNormal);
  /* The base colour arrives per vertex, not as a uniform: every surface is concatenated into one
     draw call, so a uniform could only give them all the same colour. */
  vec3 albedo = mix(vBaseColor, vColor, uCurvatureMix);

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

  /* Blinn–Phong, on the key light only: a second highlight would say something about the lighting
     rig rather than about the surface. */
  vec3 halfway = normalize(LIGHT_KEY_DIR + viewDir);
  /* The name here is NOT half: that is a reserved word in GLSL ES and will not compile — a
     failure nothing in the suite can see, since node has no GL context. See tests/gl/shaders. */
  float sheen = SPECULAR * pow(max(dot(n, halfway), 0.0), SHININESS) * step(1e-6, key);

  vec3 color = albedo * (AMBIENT + KEY * key + FILL * fill) * (1.0 - SPECULAR) * (1.0 - rim)
             + sheen;

  fragColor = vec4(color, 1.0);
}
`;
