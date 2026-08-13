import { sampleBounds } from "./types.ts";
import type { ParametricSurface } from "./parametric.ts";

/**
 * Detecting that a chart closes up on itself.
 *
 * ## Why this has to be inferred rather than declared
 *
 * A sphere's v runs 0 → 2π and comes back to where it started; a geodesic crossing that seam has
 * not left the surface, it has gone around. Whether the boundary is a **wall or a seam** decides
 * three separate things — whether a geodesic stops there, whether the mesh welds its normals
 * across it, and whether a curve in the chart wraps — and getting it wrong makes a great circle
 * on a sphere end abruptly in the middle of nowhere.
 *
 * The surface catalog declares this per template. But a template is loaded by inserting its
 * **source text** into a row, so by the time the row is compiled the declaration is gone, and a
 * user who types the same sphere by hand never had one to begin with. Both deserve the same
 * behaviour, so periodicity is measured from the parametrization itself.
 *
 * ## The test
 *
 * u is periodic when `X(u₀, v) = X(u₁, v)` for every v, and symmetrically for v. Comparison is
 * relative to the surface's own size, since "the same point" means nothing in absolute units
 * when the surface might be a sphere of radius 10⁻³.
 *
 * ## What it deliberately does not claim
 *
 * A pole is not a seam. The sphere's u endpoints both collapse to single points — the north and
 * south poles — and those points are *different*, so u is correctly found aperiodic. But a chart
 * whose two ends collapse onto the **same** point (some cones and lens-shaped charts) will report
 * periodic, because by this test it is: the boundary really is glued, even though the gluing is a
 * single point rather than a curve. Treating it as a seam is harmless for geodesics, which stop at
 * a degenerate point anyway.
 *
 * A Möbius-like chart that closes up with a *flip* is reported aperiodic, which is the safe
 * answer: this only ever compares matched v against matched v.
 */

/** How many samples along each boundary to compare. */
const SAMPLES = 9;

/**
 * Relative tolerance for calling two boundary points the same.
 *
 * Loose enough to survive a domain inset — pulling the sampling in from a periodic boundary
 * leaves the two edges close but not identical — and far tighter than the gap between genuinely
 * distinct edges.
 */
const RELATIVE_TOLERANCE = 1e-6;

export interface Periodicity {
  readonly u: boolean;
  readonly v: boolean;
}

/**
 * Which of the four chart boundaries are coordinate poles rather than edges of the surface.
 *
 * The distinction decides whether a geodesic reaching a boundary has *left the surface* or merely
 * run out of chart. At the sphere's u = 0 the whole boundary line collapses to a single point and
 * X_u × X_v vanishes: the surface continues perfectly well through there, and it is the
 * coordinates that fail. At a cylinder's u = 0 the surface genuinely stops, and a geodesic should
 * stop with it.
 *
 * ## Measured by collapse, not by degeneracy
 *
 * The obvious test — is X_u × X_v zero along the boundary — fails in practice, because the pole is
 * usually just *outside* the interval being examined. Domain insets exist to keep sampling off a
 * pole, and by the time a domain arrives here the inset has often been folded into the bounds: the
 * sphere comes as u ∈ [0.0063, 3.1353] rather than [0, π] with an inset. At 0.0063 the surface is
 * perfectly regular, so the pole goes unnoticed and every meridian keeps stopping at an invisible
 * wall. Probing outward does not rescue it either — the degeneracy sits at exactly one value of u
 * and discrete samples step straight over it.
 *
 * What survives the inset is that the boundary's **image collapses**: X(0.0063, ·) traces a circle
 * of radius 0.0063, which is a point next to a surface of size 2. So the test is whether the whole
 * boundary line maps into a region negligible against the surface's own extent. That is what a
 * coordinate pole *is*, it needs no probing, and it is scale-free.
 */
export interface ChartPoles {
  readonly uMin: boolean;
  readonly uMax: boolean;
  readonly vMin: boolean;
  readonly vMax: boolean;
}

/**
 * Measure whether either chart coordinate closes up, by comparing the two opposite boundaries.
 *
 * Returns `false` for a coordinate whose boundary evaluation is non-finite, since nothing can be
 * concluded from a NaN and a wall is the conservative reading.
 */
export function detectPeriodicity(
  surface: ParametricSurface,
  params: ArrayLike<number>,
): Periodicity {
  const [u0, u1] = sampleBounds(surface.u);
  const [v0, v1] = sampleBounds(surface.v);

  const scale = extentOf(surface, params);
  if (!(scale > 0)) return { u: false, v: false };
  const tolerance = scale * RELATIVE_TOLERANCE;

  return {
    u: boundariesAgree(surface, params, tolerance, u0, u1, v0, v1, true),
    v: boundariesAgree(surface, params, tolerance, v0, v1, u0, u1, false),
  };
}

/**
 * Find which chart boundaries are coordinate poles.
 *
 * A boundary counts as a pole only if it is degenerate **along its whole length** — one degenerate
 * sample is a cone point or a pinch, not a collapsed edge, and continuing a geodesic through it
 * would not be justified.
 */
export function detectPoles(
  surface: ParametricSurface,
  params: ArrayLike<number>,
): ChartPoles {
  const [uLo, uHi] = sampleBounds(surface.u);
  const [vLo, vHi] = sampleBounds(surface.v);
  const scale = extentOf(surface, params);
  if (!(scale > 0)) return { uMin: false, uMax: false, vMin: false, vMax: false };
  const limit = scale * COLLAPSE_FRACTION;

  return {
    uMin: boundaryCollapses(surface, params, uLo, vLo, vHi, true, limit),
    uMax: boundaryCollapses(surface, params, uHi, vLo, vHi, true, limit),
    vMin: boundaryCollapses(surface, params, vLo, uLo, uHi, false, limit),
    vMax: boundaryCollapses(surface, params, vHi, uLo, uHi, false, limit),
  };
}

/**
 * How small a boundary's image may be, relative to the surface, and still count as collapsed.
 *
 * Has to exceed the inset — a sphere inset by 0.0063 leaves a circle of that radius, about 0.6% of
 * the surface's size — while staying far below any boundary that is a genuine curve. A cylinder's
 * rim measures 100% by this yardstick, so there is a wide margin between the two cases.
 */
const COLLAPSE_FRACTION = 0.05;

/** Does the whole boundary line map into a region negligible against the surface? */
function boundaryCollapses(
  surface: ParametricSurface,
  params: ArrayLike<number>,
  fixed: number,
  otherLo: number,
  otherHi: number,
  fixedIsU: boolean,
  limit: number,
): boolean {
  const probe: [number, number, number] = [0, 0, 0];
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  for (let k = 0; k < SAMPLES; k++) {
    const t = otherLo + ((otherHi - otherLo) * k) / (SAMPLES - 1);
    const ok = fixedIsU
      ? position(surface, fixed, t, params, probe)
      : position(surface, t, fixed, params, probe);
    // A boundary that cannot be evaluated is not a pole; an edge is the conservative reading.
    if (!ok) return false;
    if (probe[0] < minX) minX = probe[0];
    if (probe[1] < minY) minY = probe[1];
    if (probe[2] < minZ) minZ = probe[2];
    if (probe[0] > maxX) maxX = probe[0];
    if (probe[1] > maxY) maxY = probe[1];
    if (probe[2] > maxZ) maxZ = probe[2];
  }
  return Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) <= limit;
}

/**
 * Compare `X(fixed = a, ·)` against `X(fixed = b, ·)` along the other coordinate.
 *
 * `fixedIsU` says which coordinate is held at the boundary, so the same routine serves both
 * directions rather than being written twice with the arguments swapped.
 */
function boundariesAgree(
  surface: ParametricSurface,
  params: ArrayLike<number>,
  tolerance: number,
  a: number,
  b: number,
  otherLo: number,
  otherHi: number,
  fixedIsU: boolean,
): boolean {
  // A degenerate interval has no two boundaries to compare.
  if (!(Math.abs(b - a) > 0)) return false;

  const left: [number, number, number] = [0, 0, 0];
  const right: [number, number, number] = [0, 0, 0];

  for (let k = 0; k < SAMPLES; k++) {
    const t = otherLo + ((otherHi - otherLo) * k) / (SAMPLES - 1);
    const okLeft = fixedIsU
      ? position(surface, a, t, params, left)
      : position(surface, t, a, params, left);
    const okRight = fixedIsU
      ? position(surface, b, t, params, right)
      : position(surface, t, b, params, right);
    // Nothing can be concluded from a non-finite boundary, and a wall is the safe reading.
    if (!okLeft || !okRight) return false;
    const distance = Math.hypot(left[0] - right[0], left[1] - right[1], left[2] - right[2]);
    if (distance > tolerance) return false;
  }
  return true;
}

/**
 * A length scale for the surface, from the diagonal of a coarse sample of its own points.
 *
 * Both tests here are relative to it, and they have to be: without it a sphere of radius 10⁻³
 * would have every boundary pair look identical and one of radius 10⁶ would have none.
 */
function extentOf(surface: ParametricSurface, params: ArrayLike<number>): number {
  const [u0, u1] = sampleBounds(surface.u);
  const [v0, v1] = sampleBounds(surface.v);
  const probe: [number, number, number] = [0, 0, 0];
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  let sampled = 0;

  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      const u = u0 + ((u1 - u0) * i) / 3;
      const v = v0 + ((v1 - v0) * j) / 3;
      if (!position(surface, u, v, params, probe)) continue;
      sampled++;
      if (probe[0] < minX) minX = probe[0];
      if (probe[1] < minY) minY = probe[1];
      if (probe[2] < minZ) minZ = probe[2];
      if (probe[0] > maxX) maxX = probe[0];
      if (probe[1] > maxY) maxY = probe[1];
      if (probe[2] > maxZ) maxZ = probe[2];
    }
  }
  if (sampled === 0) return 0;
  // A surface that is a single point has no scale of its own; fall back to absolute.
  return Math.max(Math.hypot(maxX - minX, maxY - minY, maxZ - minZ), 1e-12);
}

/** Evaluate the position only, reporting whether it came back finite. */
function position(
  surface: ParametricSurface,
  u: number,
  v: number,
  params: ArrayLike<number>,
  out: [number, number, number],
): boolean {
  surface.position(u, v, params, out);
  return Number.isFinite(out[0]) && Number.isFinite(out[1]) && Number.isFinite(out[2]);
}
