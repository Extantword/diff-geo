/**
 * Thick antialiased line shaders (GLSL ES 3.00).
 *
 * WebGL's native `lineWidth` is 1 pixel and widely ignored by drivers, so every line in
 * this project — geodesics, lines of curvature, asymptotic curves, Frenet frames, the
 * Gauss map image — is drawn as geometry. This is the highest visual-value shader in the
 * codebase.
 *
 * ## The technique
 *
 * One instanced quad per segment, expanded in **screen space** so the width is a constant
 * number of pixels regardless of depth. The quad is also extended half a width *past*
 * each endpoint, and the fragment shader measures distance to the segment rather than to
 * an infinite centreline. Two things fall out of that for free:
 *
 *  - **round caps**, without a separate pass;
 *  - **round joins**, because consecutive segments overlap in the extended region, so
 *    there is no wedge-shaped gap on the outside of a turn.
 *
 * That is worth stating because the obvious alternative — mitre joins — needs the
 * neighbouring vertices and degenerates at 180° turns, which geodesics on a torus produce
 * routinely.
 *
 * ## Three traps, each handled explicitly
 *
 * 1. **The near plane.** A segment straddling `w = 0` has its projected direction flipped,
 *    so the quad turns inside out and the line flickers violently as soon as the camera
 *    is close enough for a segment to cross the eye plane. Both endpoints are clipped
 *    against a small positive `w` before any screen-space work.
 *
 * 2. **Constant pixel width.** Offsetting in NDC and then multiplying by `clip.w`
 *    cancels the perspective divide, giving a width in pixels. Dividing instead would
 *    give a width in world units — useful for frame arrows that should shrink with
 *    distance, hence `uWidthIsPixels`.
 *
 * 3. **Depth.** Interpolating in *clip* space keeps `z` perspective-correct, so lines
 *    occlude against the surface properly. A small constant NDC bias then wins the ties
 *    that remain when a curve lies exactly on the surface it was computed from.
 */

export const linesVertex = /* glsl */ `#version 300 es
precision highp float;

/* the unit quad: x selects the endpoint, y selects the side */
in vec2 aQuad;

/* per-instance */
in vec3 aStart;
in vec3 aEnd;
in vec3 aColorA;
in vec3 aColorB;
in vec2 aArc;

uniform mat4 uViewProj;
/** drawing-buffer size in device pixels */
uniform vec2 uViewport;
uniform float uWidthPx;
uniform float uFeatherPx;
uniform float uDepthBias;
/** 1 = width in pixels, 0 = width in world units */
uniform float uWidthIsPixels;

flat out vec2 vPixelA;
flat out vec2 vPixelB;
flat out float vHalfWidth;
out vec3 vColor;
out float vArc;

/** Smallest w we are willing to divide by. */
const float W_MIN = 1e-4;

void main() {
  vec4 clipA = uViewProj * vec4(aStart, 1.0);
  vec4 clipB = uViewProj * vec4(aEnd, 1.0);

  /* Trap 1: a segment crossing the eye plane. Cull it when both ends are behind, and
     clip to W_MIN when only one is — without this, lines flicker on close zoom. */
  if (clipA.w < W_MIN && clipB.w < W_MIN) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vPixelA = vec2(0.0);
    vPixelB = vec2(0.0);
    vHalfWidth = 0.0;
    vColor = vec3(0.0);
    vArc = 0.0;
    return;
  }
  if (clipA.w < W_MIN) {
    clipA = mix(clipA, clipB, (W_MIN - clipA.w) / (clipB.w - clipA.w));
  } else if (clipB.w < W_MIN) {
    clipB = mix(clipB, clipA, (W_MIN - clipB.w) / (clipA.w - clipB.w));
  }

  vec2 pixelA = (clipA.xy / clipA.w * 0.5 + 0.5) * uViewport;
  vec2 pixelB = (clipB.xy / clipB.w * 0.5 + 0.5) * uViewport;

  vec4 clip = mix(clipA, clipB, aQuad.x);

  /* Trap 2: pixels or world units. In pixel mode the offset is scaled by clip.w so the
     perspective divide cancels; in world mode it is not. */
  float halfWidth = 0.5 * (uWidthPx + uFeatherPx);
  float worldScale = mix(uViewport.y * 0.5 / max(clip.w, W_MIN), 1.0, uWidthIsPixels);
  halfWidth *= worldScale;

  vec2 delta = pixelB - pixelA;
  vec2 direction = length(delta) > 1e-6 ? normalize(delta) : vec2(1.0, 0.0);
  vec2 normal = vec2(-direction.y, direction.x);

  /* Extend past each endpoint by a half width, so caps round and joins fill in. */
  vec2 offset = normal * aQuad.y * halfWidth
              + direction * (aQuad.x * 2.0 - 1.0) * halfWidth;

  clip.xy += offset / (uViewport * 0.5) * clip.w;

  /* Trap 3: a small constant bias in NDC, to win depth ties against the surface. */
  clip.z -= uDepthBias * clip.w;

  gl_Position = clip;

  vPixelA = pixelA;
  vPixelB = pixelB;
  vHalfWidth = halfWidth;
  vColor = mix(aColorA, aColorB, aQuad.x);
  vArc = mix(aArc.x, aArc.y, aQuad.x);
}
`;

export const linesFragment = /* glsl */ `#version 300 es
precision highp float;

flat in vec2 vPixelA;
flat in vec2 vPixelB;
flat in float vHalfWidth;
in vec3 vColor;
in float vArc;

uniform float uWidthPx;
uniform float uFeatherPx;
uniform float uOpacity;
/** dash period in arc-length units; 0 disables dashing */
uniform float uDashPeriod;
uniform float uDashDuty;

out vec4 fragColor;

/** Distance from p to the segment [a, b] — this is what rounds the caps and joins. */
float distanceToSegment(vec2 p, vec2 a, vec2 b) {
  vec2 ab = b - a;
  float denominator = dot(ab, ab);
  if (denominator < 1e-12) return distance(p, a);
  float t = clamp(dot(p - a, ab) / denominator, 0.0, 1.0);
  return distance(p, a + t * ab);
}

void main() {
  /* Dashes come before the distance test so a discarded fragment costs less. Keying off
     arc length rather than screen length keeps dash spacing uniform along the curve
     regardless of foreshortening — which matters when the pattern is carrying meaning,
     e.g. asymptotic curves dashed against solid lines of curvature. */
  if (uDashPeriod > 0.0 && fract(vArc / uDashPeriod) > uDashDuty) discard;

  float d = distanceToSegment(gl_FragCoord.xy, vPixelA, vPixelB);
  /* Named "inner" because half is a reserved word in GLSL ES. */
  float inner = max(vHalfWidth - uFeatherPx, 0.0);
  float alpha = 1.0 - smoothstep(inner, vHalfWidth, d);
  alpha *= uOpacity;

  if (alpha < 0.004) discard;

  /* Premultiplied, to composite correctly against the surface. */
  fragColor = vec4(vColor * alpha, alpha);
}
`;
