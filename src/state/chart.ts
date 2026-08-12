import { compileMany } from "../core/expr/eval.ts";
import type { Expr } from "../core/expr/ast.ts";
import type { ParametricSurface } from "../core/geom/parametric.ts";
import { makeSurfacePoint, type Vec3 } from "../core/geom/types.ts";
import { marchingSquares } from "../core/mesh/contour.ts";
import type { LineGroup, Polyline } from "../gl/passes/lines.ts";

/**
 * The chart view: the (u, v) domain drawn flat, and curves in it pushed forward to the surface.
 *
 * This is how do Carmo actually reasons. A parametrization is a map from a flat piece of R² to
 * a surface, and almost every construction in the book — a coordinate curve, a line of
 * curvature, a geodesic — is a curve *in the chart* whose image is what you see in space.
 * Showing both at once, in the same colour, makes the map itself visible instead of leaving it
 * implicit.
 *
 * Everything here reuses the thick-line pass: the grid, the domain border and the curves are
 * all polylines, just drawn under an orthographic projection in a corner viewport.
 */

/** Domain border. */
const BORDER_COLOR: Vec3 = [0.42, 0.5, 0.6];
/** Interior grid lines. */
const GRID_COLOR: Vec3 = [0.16, 0.21, 0.27];
/** Distinct colours for chart curves, matched between the inset and the surface. */
export const CHART_CURVE_PALETTE: readonly Vec3[] = [
  [1.0, 0.85, 0.35],
  [0.45, 0.95, 0.7],
  [1.0, 0.55, 0.8],
  [0.55, 0.75, 1.0],
];

export interface ChartBounds {
  readonly u: [number, number];
  readonly v: [number, number];
}

/** A curve given in chart coordinates: t ↦ (u(t), v(t)). */
export interface ChartCurveRequest {
  readonly rowId: number;
  /** the two components, in chart coordinates */
  readonly comps: readonly Expr[];
  readonly params: readonly string[];
  /** the curve's own parameter name */
  readonly variable: string;
  readonly range: { min: number; max: number };
  readonly colorIndex: number;
}

export interface ChartCurveResult {
  readonly rowId: number;
  /** the curve in (u, v), for the inset */
  readonly chart: Polyline;
  /** its image on the surface, lifted clear of the mesh */
  readonly surface: Polyline | null;
  /** how much of the curve fell outside the domain */
  readonly outsideFraction: number;
}

const SAMPLES = 500;

function segment(from: Vec3, to: Vec3, color: Vec3): Polyline {
  return {
    points: new Float64Array([...from, ...to]),
    count: 2,
    color,
  };
}

/**
 * The domain rectangle plus interior grid lines, as polylines in (u, v).
 *
 * Drawn in the inset only. On the surface these same lines are already visible as the
 * fragment-shader chart grid, so duplicating them in 3D would just be clutter.
 */
export function chartGrid(bounds: ChartBounds, divisions = 8): LineGroup[] {
  const [u0, u1] = bounds.u;
  const [v0, v1] = bounds.v;

  const interior: Polyline[] = [];
  for (let i = 1; i < divisions; i++) {
    const u = u0 + ((u1 - u0) * i) / divisions;
    const v = v0 + ((v1 - v0) * i) / divisions;
    interior.push(segment([u, v0, 0], [u, v1, 0], GRID_COLOR));
    interior.push(segment([u0, v, 0], [u1, v, 0], GRID_COLOR));
  }

  const border: Polyline[] = [
    {
      points: new Float64Array([
        u0, v0, 0,
        u1, v0, 0,
        u1, v1, 0,
        u0, v1, 0,
        u0, v0, 0,
      ]),
      count: 5,
      color: BORDER_COLOR,
    },
  ];

  return [
    { polylines: interior, style: { widthPx: 1.2, opacity: 0.9 } },
    { polylines: border, style: { widthPx: 2 } },
  ];
}

/**
 * Sample a chart curve and push it forward through the surface.
 *
 * Samples landing outside the domain are marked invalid rather than clamped: the line pass
 * breaks the polyline there, so a curve that wanders off the chart visibly leaves it instead of
 * being silently folded back onto the edge. `outsideFraction` lets the row say so in words.
 */
export function pushForward(
  request: ChartCurveRequest,
  surface: ParametricSurface | null,
  parameters: ArrayLike<number>,
  lift: number,
): ChartCurveResult {
  const compiled = compileMany([...request.comps], {
    vars: [request.variable],
    params: [...request.params],
  });

  const count = SAMPLES + 1;
  const chartPoints = new Float64Array(count * 3);
  const surfacePoints = new Float64Array(count * 3);
  const chartValid = new Uint8Array(count);
  const surfaceValid = new Uint8Array(count);
  const arcLength = new Float64Array(count);

  const out = new Float64Array(2);
  const argument = new Float64Array(1);
  const point = makeSurfacePoint();

  const [uLo, uHi] = surface ? [surface.u.min, surface.u.max] : [-Infinity, Infinity];
  const [vLo, vHi] = surface ? [surface.v.min, surface.v.max] : [-Infinity, Infinity];

  let outside = 0;

  for (let i = 0; i < count; i++) {
    const t = request.range.min + ((request.range.max - request.range.min) * i) / SAMPLES;
    argument[0] = t;
    compiled.evaluate(argument, parameters, out);
    const u = out[0]!;
    const v = out[1]!;

    chartPoints[i * 3] = u;
    chartPoints[i * 3 + 1] = v;
    chartValid[i] = Number.isFinite(u) && Number.isFinite(v) ? 1 : 0;

    if (i > 0) {
      const du = u - chartPoints[(i - 1) * 3]!;
      const dv = v - chartPoints[(i - 1) * 3 + 1]!;
      const step = Math.hypot(du, dv);
      arcLength[i] = arcLength[i - 1]! + (Number.isFinite(step) ? step : 0);
    }

    if (!surface || !chartValid[i]) continue;

    // Periodic directions wrap rather than leaving the chart, so they are always in range.
    const insideU = surface.periodicU || (u >= uLo && u <= uHi);
    const insideV = surface.periodicV || (v >= vLo && v <= vHi);
    if (!insideU || !insideV) {
      outside++;
      continue;
    }

    surface.at(u, v, parameters, point);
    if (point.degenerate) continue;

    // Lifted along the normal, so the curve sits on the surface rather than inside it.
    surfacePoints[i * 3] = point.p[0] + point.N[0] * lift;
    surfacePoints[i * 3 + 1] = point.p[1] + point.N[1] * lift;
    surfacePoints[i * 3 + 2] = point.p[2] + point.N[2] * lift;
    surfaceValid[i] = 1;
  }

  const color = CHART_CURVE_PALETTE[request.colorIndex % CHART_CURVE_PALETTE.length]!;

  const chart: Polyline = {
    points: chartPoints,
    count,
    valid: chartValid,
    arcLength,
    color,
  };

  let anyOnSurface = false;
  for (let i = 0; i < count; i++) {
    if (surfaceValid[i]) {
      anyOnSurface = true;
      break;
    }
  }

  return {
    rowId: request.rowId,
    chart,
    surface: anyOnSurface
      ? { points: surfacePoints, count, valid: surfaceValid, arcLength, color }
      : null,
    outsideFraction: outside / count,
  };
}

/**
 * A lift distance derived from the mesh, not chosen.
 *
 * A curve lying on a surface has to clear the **sagitta** — the gap between the true surface
 * and the flat triangle chord approximating it — which for grid step h and normal curvature κ
 * is about κh²/8. A fixed constant (the sibling project used 0.015) is simultaneously too small
 * for a sphere of radius 100 and absurd for one of radius 0.01.
 *
 * `curvatureScale` is a Gaussian curvature, so √|K| stands in for a principal curvature
 * magnitude. That is an estimate rather than a bound, hence the floor term.
 */
export function chartLift(
  sceneExtent: number,
  resolution: number,
  curvatureScale: number,
): number {
  const gridStep = (2 * sceneExtent) / Math.max(resolution, 1);
  const curvature = Math.sqrt(Math.max(curvatureScale, 0));
  return Math.max(0.25 * gridStep * gridStep * curvature, 2e-3 * sceneExtent);
}


/** A chart graph `v = f(u)` (or `u = f(v)`), sampled and pushed forward. */
export interface ChartGraphRequest {
  readonly rowId: number;
  readonly body: Expr;
  readonly params: readonly string[];
  /** which chart variable is the input: "u" gives v = f(u), "v" gives u = f(v) */
  readonly variable: "u" | "v";
  readonly colorIndex: number;
}

/**
 * Sample `v = f(u)` across the chart's own u-range.
 *
 * The input runs over the domain the surface actually has, so the graph is drawn exactly where
 * it means something — and samples whose output falls outside the *other* range are marked
 * invalid rather than clamped, so the curve visibly leaves the chart.
 */
export function sampleChartGraph(
  request: ChartGraphRequest,
  bounds: ChartBounds,
  surface: ParametricSurface | null,
  parameters: ArrayLike<number>,
  lift: number,
): ChartCurveResult {
  const compiled = compileMany([request.body], {
    vars: [request.variable],
    params: [...request.params],
  });

  const alongU = request.variable === "u";
  const [inLo, inHi] = alongU ? bounds.u : bounds.v;
  const [outLo, outHi] = alongU ? bounds.v : bounds.u;

  const count = SAMPLES + 1;
  const chartPoints = new Float64Array(count * 3);
  const surfacePoints = new Float64Array(count * 3);
  const chartValid = new Uint8Array(count);
  const surfaceValid = new Uint8Array(count);
  const arcLength = new Float64Array(count);

  const out = new Float64Array(1);
  const argument = new Float64Array(1);
  const point = makeSurfacePoint();
  let outside = 0;

  for (let i = 0; i < count; i++) {
    const input = inLo + ((inHi - inLo) * i) / SAMPLES;
    argument[0] = input;
    compiled.evaluate(argument, parameters, out);
    const value = out[0]!;

    const u = alongU ? input : value;
    const v = alongU ? value : input;
    chartPoints[i * 3] = u;
    chartPoints[i * 3 + 1] = v;

    const finite = Number.isFinite(value);
    // Outside the opposite range the point is off the chart entirely — not clamped to its edge,
    // which would draw a line along the boundary that is not part of the graph.
    const inside = finite && value >= outLo && value <= outHi;
    chartValid[i] = inside ? 1 : 0;
    if (finite && !inside) outside++;

    if (i > 0) {
      const du = u - chartPoints[(i - 1) * 3]!;
      const dv = v - chartPoints[(i - 1) * 3 + 1]!;
      const step = Math.hypot(du, dv);
      arcLength[i] = arcLength[i - 1]! + (Number.isFinite(step) ? step : 0);
    }

    if (!surface || !inside) continue;
    surface.at(u, v, parameters, point);
    if (point.degenerate) continue;
    surfacePoints[i * 3] = point.p[0] + point.N[0] * lift;
    surfacePoints[i * 3 + 1] = point.p[1] + point.N[1] * lift;
    surfacePoints[i * 3 + 2] = point.p[2] + point.N[2] * lift;
    surfaceValid[i] = 1;
  }

  const color = CHART_CURVE_PALETTE[request.colorIndex % CHART_CURVE_PALETTE.length]!;
  let anyOnSurface = false;
  for (let i = 0; i < count; i++) {
    if (surfaceValid[i]) {
      anyOnSurface = true;
      break;
    }
  }

  return {
    rowId: request.rowId,
    chart: { points: chartPoints, count, valid: chartValid, arcLength, color },
    surface: anyOnSurface
      ? { points: surfacePoints, count, valid: surfaceValid, arcLength, color }
      : null,
    outsideFraction: outside / count,
  };
}

export interface ChartRelationRequest {
  readonly rowId: number;
  /** lhs and rhs; the level set of lhs − rhs is the curve */
  readonly comps: readonly Expr[];
  readonly params: readonly string[];
  readonly colorIndex: number;
}

export interface ChartRelationResult {
  readonly rowId: number;
  /** one two-point polyline per contour segment, in (u, v) */
  readonly chart: Polyline[];
  /** the same segments pushed onto the surface */
  readonly surface: Polyline[];
  readonly segmentCount: number;
}

/**
 * The level set of a relation in the chart, by marching squares, pushed forward.
 *
 * Segments are independent rather than linked into contours — the line pass draws per-segment
 * instances anyway and its round caps make them abut cleanly, so tracing would buy nothing.
 */
export function sampleChartRelation(
  request: ChartRelationRequest,
  bounds: ChartBounds,
  surface: ParametricSurface | null,
  parameters: ArrayLike<number>,
  lift: number,
  resolution: number,
): ChartRelationResult {
  const compiled = compileMany([...request.comps], {
    vars: ["u", "v"],
    params: [...request.params],
  });

  const out = new Float64Array(request.comps.length);
  const argument = new Float64Array(2);

  // F = lhs − rhs, so the relation holds exactly where F vanishes.
  const field = (u: number, v: number): number => {
    argument[0] = u;
    argument[1] = v;
    compiled.evaluate(argument, parameters, out);
    return (out[0] ?? Number.NaN) - (out[1] ?? 0);
  };

  const contour = marchingSquares(field, bounds, {
    resU: resolution,
    resV: resolution,
  });

  const color = CHART_CURVE_PALETTE[request.colorIndex % CHART_CURVE_PALETTE.length]!;
  const chart: Polyline[] = [];
  const onSurface: Polyline[] = [];
  const point = makeSurfacePoint();

  for (let i = 0; i < contour.segmentCount; i++) {
    const au = contour.segments[i * 4]!;
    const av = contour.segments[i * 4 + 1]!;
    const bu = contour.segments[i * 4 + 2]!;
    const bv = contour.segments[i * 4 + 3]!;

    chart.push({
      points: new Float64Array([au, av, 0, bu, bv, 0]),
      count: 2,
      color,
    });

    if (!surface) continue;
    const ends: number[] = [];
    let usable = true;
    for (const [u, v] of [
      [au, av],
      [bu, bv],
    ] as const) {
      surface.at(u, v, parameters, point);
      if (point.degenerate) {
        usable = false;
        break;
      }
      ends.push(
        point.p[0] + point.N[0] * lift,
        point.p[1] + point.N[1] * lift,
        point.p[2] + point.N[2] * lift,
      );
    }
    if (usable && ends.length === 6) {
      onSurface.push({ points: Float64Array.from(ends), count: 2, color });
    }
  }

  return { rowId: request.rowId, chart, surface: onSurface, segmentCount: contour.segmentCount };
}
