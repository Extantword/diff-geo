import {
  colormapColor,
  colormapGradient,
  type ColormapName,
} from "./colormaps.ts";
import type { ParametricSurface } from "./parametric.ts";
import { makeSurfacePoint, sampleBounds, type Vec3 } from "./types.ts";

/**
 * The curvature colour scale.
 *
 * ## The scale must be robust, not maximal
 *
 * ManifoldSandbox computed its scale as `max(|min K|, |max K|)` over a sample grid. That
 * is the natural thing to write and it is badly wrong for user-authored formulas: a
 * single sample near a chart singularity returns K ≈ 10¹², the scale becomes 10¹², and
 * the entire surface paints uniform grey because every honest curvature value maps to
 * ~0. The failure is silent and looks like a rendering bug.
 *
 * So the scale is a **high quantile of |K| over the finite samples**, not the maximum.
 * Outliers then saturate at the ends of the colormap — which is exactly what a diverging
 * scale is for — while the bulk of the surface keeps its contrast.
 *
 * The palette has one definition, shared by the mesh vertex colours and the CSS legend
 * gradient, so the two can never drift apart.
 */


/**
 * Distinct grey for a point where curvature is not defined — a chart pole, a cone
 * point, a formula that blew up. Never silently coloured as if K were 0: "undefined" and
 * "flat" are completely different facts about a surface.
 */
export const INVALID_COLOR: Vec3 = [0.42, 0.44, 0.47];

/**
 * Diverging blue → light → red for `t` in [−1, 1]; values outside saturate.
 *
 * Kept as its own export because it is the DEFAULT map and the one the ground-truth tests pin,
 * but the table now lives in `colormaps.ts` alongside the others so a surface can be painted with
 * a different one without two copies of the curvature palette drifting apart.
 */
export function divergingColor(t: number, out: Vec3 = [0, 0, 0]): Vec3 {
  if (!Number.isFinite(t)) {
    out[0] = INVALID_COLOR[0];
    out[1] = INVALID_COLOR[1];
    out[2] = INVALID_COLOR[2];
    return out;
  }
  return colormapColor("curvature", t, out, INVALID_COLOR);
}

/** Smallest scale worth using; below this the colours are numerical noise. */
const MIN_SCALE = 1e-6;

/**
 * A high quantile of the absolute values, ignoring non-finite entries.
 *
 * `quantile = 1` recovers the maximum, which is precisely the behaviour to avoid; the
 * default of 0.98 lets the worst 2% of samples saturate instead of flattening everything
 * else.
 */
export function robustScale(values: readonly number[], quantile = 0.98): number {
  const finite: number[] = [];
  for (const value of values) {
    if (Number.isFinite(value)) finite.push(Math.abs(value));
  }
  if (finite.length === 0) return MIN_SCALE;
  finite.sort((a, b) => a - b);
  const index = Math.min(finite.length - 1, Math.floor(quantile * (finite.length - 1)));
  return Math.max(finite[index]!, MIN_SCALE);
}

export interface CurvatureRange {
  /** symmetric scale: K is mapped through K / scale */
  readonly scale: number;
  readonly minK: number;
  readonly maxK: number;
  /** fraction of samples where curvature was not defined */
  readonly invalidFraction: number;
}

/**
 * Sample Gaussian curvature over the (inset) domain to choose a colour scale.
 *
 * Sampled on a coarser grid than the mesh — the scale only needs to know the
 * distribution, and this runs on every parameter change.
 */
export function sampleCurvatureRange(
  surface: ParametricSurface,
  params: ArrayLike<number>,
  resolution = 32,
): CurvatureRange {
  const [u0, u1] = sampleBounds(surface.u);
  const [v0, v1] = sampleBounds(surface.v);
  const point = makeSurfacePoint();

  const values: number[] = [];
  let minK = Infinity;
  let maxK = -Infinity;
  let invalid = 0;
  let total = 0;

  for (let i = 0; i <= resolution; i++) {
    const u = u0 + ((u1 - u0) * i) / resolution;
    for (let j = 0; j <= resolution; j++) {
      const v = v0 + ((v1 - v0) * j) / resolution;
      surface.at(u, v, params, point);
      total++;
      if (point.degenerate || !Number.isFinite(point.K)) {
        invalid++;
        continue;
      }
      values.push(point.K);
      if (point.K < minK) minK = point.K;
      if (point.K > maxK) maxK = point.K;
    }
  }

  return {
    scale: robustScale(values),
    minK: Number.isFinite(minK) ? minK : Number.NaN,
    maxK: Number.isFinite(maxK) ? maxK : Number.NaN,
    invalidFraction: total === 0 ? 1 : invalid / total,
  };
}

/** CSS gradient for the legend, built from the same palette as the mesh colours. */
export function legendGradient(name: ColormapName = "curvature", steps = 24): string {
  return colormapGradient(name, steps);
}
