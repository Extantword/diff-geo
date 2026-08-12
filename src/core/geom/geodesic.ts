import { createStepper } from "../num/ode.ts";
import type { ParametricSurface } from "./parametric.ts";
import {
  makeChartData,
  makeSurfacePoint,
  sampleBounds,
  type Mat2,
  type Vec2,
  type Vec3,
} from "./types.ts";

/**
 * Geodesics in chart coordinates.
 *
 *     γ̈ᵏ = −Γᵏᵢⱼ γ̇ⁱ γ̇ʲ
 *
 * Ported from ManifoldSandbox's `src/math/geodesic.ts`, which was correct and battle-tested,
 * with three changes:
 *
 *  - Γ comes from the compiled jet rather than from sympy-generated code, so it works for any
 *    formula the user types instead of only a curated catalog;
 *  - the surface normal used to lift a drawn curve off the surface is **exact** (Xu × Xv from
 *    the jet) where the precedent finite-differenced it with h = 1e-4, which also removes its
 *    one-sided-difference special case at the chart boundary;
 *  - the integrator is `num/ode.ts` rather than a dependency.
 *
 * ## Every integration returns a reason for stopping
 *
 * Never a NaN-tailed array. Leaving the chart, a coordinate singularity, a non-finite
 * right-hand side and simply running out of arc length are four different facts about the
 * geometry, and the caller — and the readout — wants to know which one happened.
 */

export type StopReason =
  /** the requested arc length was reached */
  | "length"
  /** the geodesic left the chart's domain */
  | "outOfDomain"
  /** the step size collapsed: a pole of the chart, or a cone point */
  | "singular"
  | "nonFinite"
  | "maxSteps";

export interface GeodesicResult {
  /** chart coordinates (u, v) along the geodesic */
  readonly chart: Vec2[];
  /** the embedded polyline in R³ */
  readonly path: Vec3[];
  /** |γ̇|_g at each sample — constant for a true geodesic, so this is a self-check */
  readonly speeds: number[];
  readonly stop: StopReason;
  /** arc length actually covered */
  readonly length: number;
}

/** |w|_g for a chart vector w = (du, dv). */
export function metricNorm(I: Mat2, du: number, dv: number): number {
  const value =
    I[0][0] * du * du + 2 * I[0][1] * du * dv + I[1][1] * dv * dv;
  return Math.sqrt(Math.max(0, value));
}

/** Rescale a chart direction to unit metric speed, so the parameter is arc length. */
export function unitDirection(I: Mat2, du: number, dv: number): Vec2 {
  const norm = metricNorm(I, du, dv);
  if (!(norm > 1e-12)) return [0, 0];
  return [du / norm, dv / norm];
}

/**
 * A metric-orthonormal tangent frame in chart components, by Gram–Schmidt with I.
 *
 * Used to fan geodesics out at evenly spaced *angles* — evenly spaced in the metric, which is
 * the only spacing that means anything on a surface.
 */
export function orthonormalFrame(I: Mat2): { e1: Vec2; e2: Vec2 } {
  const rootE = Math.sqrt(Math.max(I[0][0], 1e-12));
  const e1: Vec2 = [1 / rootE, 0];
  // w = ∂v − ⟨∂v, e1⟩_g e1
  const projection = I[0][1] / rootE;
  const w: Vec2 = [-(projection / rootE), 1];
  const norm = metricNorm(I, w[0], w[1]) || 1;
  return { e1, e2: [w[0] / norm, w[1] / norm] };
}

/** Evenly-angled unit directions for a geodesic spray. */
export function sprayDirections(I: Mat2, count: number): Vec2[] {
  const { e1, e2 } = orthonormalFrame(I);
  const out: Vec2[] = [];
  for (let i = 0; i < count; i++) {
    const angle = (2 * Math.PI * i) / count;
    out.push([
      Math.cos(angle) * e1[0] + Math.sin(angle) * e2[0],
      Math.cos(angle) * e1[1] + Math.sin(angle) * e2[1],
    ]);
  }
  return out;
}

export interface GeodesicOptions {
  readonly maxSteps?: number;
  readonly tolerance?: number;
  /**
   * Fewest samples to produce along the requested arc length.
   *
   * Error tolerance governs *accuracy*; this governs *density*, and they are not the same
   * requirement. On a smooth surface the adaptive stepper grows its step until the error
   * estimate objects, which on a cylinder means five steps for two units of arc — perfectly
   * accurate and visibly faceted when drawn. Capping the step only ever makes it smaller, so
   * accuracy is unaffected.
   */
  readonly minSamples?: number;
}

function inDomain(surface: ParametricSurface, u: number, v: number): boolean {
  const [u0, u1] = sampleBounds(surface.u);
  const [v0, v1] = sampleBounds(surface.v);
  const okU = surface.periodicU || (u >= u0 && u <= u1);
  const okV = surface.periodicV || (v >= v0 && v <= v1);
  return okU && okV;
}

/**
 * Integrate γ̈ᵏ = −Γᵏᵢⱼ γ̇ⁱ γ̇ʲ from `start` in chart direction `dir`, for `length` of arc.
 *
 * The direction is normalized to unit metric speed first, so the integration parameter *is*
 * arc length and the returned `speeds` should stay at 1 — a cheap, strong self-check that the
 * connection and the integrator agree.
 */
export function integrateGeodesic(
  surface: ParametricSurface,
  params: ArrayLike<number>,
  start: Vec2,
  dir: Vec2,
  length: number,
  options: GeodesicOptions = {},
): GeodesicResult {
  const maxSteps = options.maxSteps ?? Math.max(4000, (options.minSamples ?? 240) * 4);
  const point = makeSurfacePoint();
  const chartData = makeChartData();

  surface.at(start[0], start[1], params, point, chartData);
  const [du0, dv0] = unitDirection(chartData.I, dir[0], dir[1]);

  if (du0 === 0 && dv0 === 0) {
    return {
      chart: [[start[0], start[1]]],
      path: [[point.p[0], point.p[1], point.p[2]]],
      speeds: [0],
      stop: "nonFinite",
      length: 0,
    };
  }

  const derivative = (_s: number, y: Float64Array, out: Float64Array) => {
    const u = y[0]!;
    const v = y[1]!;
    const pu = y[2]!;
    const pv = y[3]!;
    surface.at(u, v, params, point, chartData);
    const G = chartData.Gamma;
    out[0] = pu;
    out[1] = pv;
    out[2] = -(
      G[0][0][0] * pu * pu +
      2 * G[0][0][1] * pu * pv +
      G[0][1][1] * pv * pv
    );
    out[3] = -(
      G[1][0][0] * pu * pu +
      2 * G[1][0][1] * pu * pv +
      G[1][1][1] * pv * pv
    );
  };

  const minSamples = options.minSamples ?? 240;
  const stepper = createStepper(derivative, [start[0], start[1], du0, dv0], 0, {
    tolerance: options.tolerance ?? 1e-9,
    initialStep: Math.max(length / 400, 1e-4),
    maxStep: length / minSamples,
  });

  const chart: Vec2[] = [[start[0], start[1]]];
  const path: Vec3[] = [[point.p[0], point.p[1], point.p[2]]];
  const speeds: number[] = [metricNorm(chartData.I, du0, dv0)];

  let stop: StopReason = "length";
  let steps = 0;

  while (steps < maxSteps) {
    const advanced = stepper.step(length);
    if (!advanced) {
      // Distinguish "arrived" from "gave up": both end the loop, but only one is success.
      stop = stepper.collapsed ? "singular" : "length";
      break;
    }
    steps++;

    const u = stepper.y[0]!;
    const v = stepper.y[1]!;
    const pu = stepper.y[2]!;
    const pv = stepper.y[3]!;

    if (![u, v, pu, pv].every(Number.isFinite)) {
      stop = "nonFinite";
      break;
    }
    if (!inDomain(surface, u, v)) {
      stop = "outOfDomain";
      break;
    }

    surface.at(u, v, params, point, chartData);
    if (point.degenerate) {
      stop = "singular";
      break;
    }

    chart.push([u, v]);
    path.push([point.p[0], point.p[1], point.p[2]]);
    speeds.push(metricNorm(chartData.I, pu, pv));
  }

  if (steps >= maxSteps) stop = "maxSteps";

  return { chart, path, speeds, stop, length: stepper.t };
}

/**
 * Lift a chart polyline slightly along the surface normal, so a drawn curve is not hidden
 * inside the mesh it lies on.
 *
 * The offset is **derived, not a constant**. A curve lying on a surface has to clear the
 * *sagitta* — the gap between the true surface and the flat triangle chord that approximates
 * it — which for grid step h and normal curvature κ is about κh²/8. ManifoldSandbox used a
 * fixed 0.015, which is far too small for a sphere of radius 100 and absurdly large for one of
 * radius 0.01. Scaling with the mesh and the curvature is scale-independent by construction.
 */
export function liftAlongNormal(
  surface: ParametricSurface,
  params: ArrayLike<number>,
  chart: readonly Vec2[],
  options: { gridStep: number; maxCurvature: number; sceneExtent: number },
): Vec3[] {
  const point = makeSurfacePoint();
  const sagitta = 0.25 * options.gridStep * options.gridStep * options.maxCurvature;
  const floor = 1e-3 * options.sceneExtent;
  const lift = Math.max(sagitta, floor);

  const out: Vec3[] = [];
  for (const [u, v] of chart) {
    surface.at(u, v, params, point);
    if (point.degenerate) {
      out.push([point.p[0], point.p[1], point.p[2]]);
      continue;
    }
    out.push([
      point.p[0] + point.N[0] * lift,
      point.p[1] + point.N[1] * lift,
      point.p[2] + point.N[2] * lift,
    ]);
  }
  return out;
}

/**
 * Integrate a principal direction field, giving a line of curvature.
 *
 * Two things this must get right, and both are easy to get wrong:
 *
 *  - **Eigenvector sign.** `resolveShape` returns e₁ only up to sign, so a naive integrator
 *    flips direction on some step and doubles back along the curve it just drew. Each step
 *    therefore picks the sign agreeing with the previous direction.
 *  - **Umbilics.** Where k₁ = k₂ the principal directions are genuinely arbitrary, and lines
 *    of curvature actually branch there. Stopping is the correct behaviour, not a limitation —
 *    continuing would draw an arbitrary choice as though it meant something.
 */
export function integrateCurvatureLine(
  surface: ParametricSurface,
  params: ArrayLike<number>,
  start: Vec2,
  which: 1 | 2,
  length: number,
  options: { steps?: number } = {},
): { chart: Vec2[]; stop: StopReason | "umbilic" } {
  const steps = options.steps ?? 900;
  const step = length / steps;
  const point = makeSurfacePoint();
  const chartData = makeChartData();

  const chart: Vec2[] = [[start[0], start[1]]];
  let u = start[0];
  let v = start[1];
  let previous: Vec2 | null = null;

  for (let i = 0; i < steps; i++) {
    surface.at(u, v, params, point, chartData);
    if (point.degenerate) return { chart, stop: "singular" };
    if (point.umbilic) return { chart, stop: "umbilic" };

    const direction: Vec2 = which === 1 ? [...chartData.e1uv] : [...chartData.e2uv];

    // Normalize to unit metric speed so `length` is arc length rather than a chart distance.
    const norm = metricNorm(chartData.I, direction[0], direction[1]);
    if (!(norm > 1e-12)) return { chart, stop: "singular" };
    direction[0] /= norm;
    direction[1] /= norm;

    // Sign continuity: keep going the way we were going.
    if (previous) {
      const alignment =
        chartData.I[0][0] * direction[0] * previous[0] +
        chartData.I[0][1] * (direction[0] * previous[1] + direction[1] * previous[0]) +
        chartData.I[1][1] * direction[1] * previous[1];
      if (alignment < 0) {
        direction[0] = -direction[0];
        direction[1] = -direction[1];
      }
    }

    // Midpoint step: markedly straighter than forward Euler for the same cost, and a
    // direction field does not warrant an adaptive integrator.
    const midU = u + 0.5 * step * direction[0];
    const midV = v + 0.5 * step * direction[1];
    if (!inDomain(surface, midU, midV)) return { chart, stop: "outOfDomain" };

    surface.at(midU, midV, params, point, chartData);
    if (point.degenerate) return { chart, stop: "singular" };
    const mid: Vec2 = which === 1 ? [...chartData.e1uv] : [...chartData.e2uv];
    const midNorm = metricNorm(chartData.I, mid[0], mid[1]);
    if (midNorm > 1e-12) {
      mid[0] /= midNorm;
      mid[1] /= midNorm;
      const alignment = mid[0] * direction[0] + mid[1] * direction[1];
      if (alignment < 0) {
        mid[0] = -mid[0];
        mid[1] = -mid[1];
      }
      u += step * mid[0];
      v += step * mid[1];
      previous = mid;
    } else {
      u += step * direction[0];
      v += step * direction[1];
      previous = direction;
    }

    if (!Number.isFinite(u) || !Number.isFinite(v)) return { chart, stop: "nonFinite" };
    if (!inDomain(surface, u, v)) {
      chart.push([u, v]);
      return { chart, stop: "outOfDomain" };
    }
    chart.push([u, v]);
  }

  return { chart, stop: "length" };
}
