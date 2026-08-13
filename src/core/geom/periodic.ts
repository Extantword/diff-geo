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

  /**
   * A length scale for the surface, from the diagonal of a coarse sample of its own points.
   *
   * Needed because the comparison is relative: without it, a sphere of radius 10⁻³ would have
   * every boundary pair look identical and a sphere of radius 10⁶ would have none.
   */
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  let sampled = 0;
  const probe: [number, number, number] = [0, 0, 0];

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
  if (sampled === 0) return { u: false, v: false };

  const scale = Math.max(
    Math.hypot(maxX - minX, maxY - minY, maxZ - minZ),
    // A surface that is a single point has no scale of its own; fall back to absolute.
    1e-12,
  );
  const tolerance = scale * RELATIVE_TOLERANCE;

  return {
    u: boundariesAgree(surface, params, tolerance, u0, u1, v0, v1, true),
    v: boundariesAgree(surface, params, tolerance, v0, v1, u0, u1, false),
  };
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
