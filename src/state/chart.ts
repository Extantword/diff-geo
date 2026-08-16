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
const BORDER_COLOR: Vec3 = [0.38, 0.45, 0.54];
/** Interior grid lines — lighter than the border, so the frame still reads as the frame. */
const GRID_COLOR: Vec3 = [0.80, 0.84, 0.88];
/**
 * How many squares the chart is drawn in, both in the inset and on the surface.
 *
 * One number for both, so a square in the inset is a square on the object.
 */
export const GRID_DIVISIONS = 8;

/**
 * Ink for the grid drawn ON the surface, which cannot be the inset's ink.
 *
 * The inset is a pale drawing on white, so its grid is nearly white and its border a soft grey.
 * The same colours on a shaded object disappear: a surface is drawn darker than the page, and a
 * line lighter than the surface reads as a highlight rather than as a rule. These are darker than
 * any albedo, for the same reason the shader's rim term darkens instead of glowing.
 */
const SURFACE_GRID_COLOR: Vec3 = [0.30, 0.36, 0.44];
const SURFACE_BORDER_COLOR: Vec3 = [0.13, 0.18, 0.24];

/** Distinct colours for chart curves, matched between the inset and the surface. */
export const CHART_CURVE_PALETTE: readonly Vec3[] = [
  [0.85, 0.50, 0.0],
  [0.10, 0.60, 0.40],
  [0.78, 0.20, 0.55],
  [0.15, 0.40, 0.80],
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
  /** Overrides the palette when the row has been given a colour of its own. */
  readonly color?: Vec3;
}

export interface ChartCurveResult {
  readonly rowId: number;
  /** the part of the curve lying over the domain, for the inset */
  readonly chart: Polyline;
  /**
   * The rest of it: finite, but outside the rectangle the surface is defined over.
   *
   * Drawn in the inset and never on the surface, because **the chart is the whole (u, v) plane**
   * and the domain is only the part of it this parametrization has been given. A line `v = cu + a`
   * exists everywhere; where it leaves the rectangle it stops being a curve on the surface, and
   * showing that — rather than cropping it at the border — is what makes the domain readable as a
   * choice rather than as the edge of the world.
   */
  readonly chartBeyond: Polyline | null;
  /** its image on the surface, lifted clear of the mesh */
  readonly surface: Polyline | null;
  /** how much of the curve fell outside the domain */
  readonly outsideFraction: number;
}

/** Was this sample used, anywhere? */
function anySet(mask: Uint8Array): boolean {
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) return true;
  }
  return false;
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
 * Drawn in the inset. The same lines appear on the surface itself as the *image* of this grid
 * (`surfaceGridLines`), traced through the same number of divisions, so the two pictures line up
 * square for square and the parametrization can be read across from one to the other.
 */
export function chartGrid(bounds: ChartBounds, divisions = GRID_DIVISIONS): LineGroup[] {
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

export interface SurfaceGridLines {
  /** the interior lines of the grid */
  readonly interior: Polyline[];
  /** the four edges of the domain, drawn heavier */
  readonly border: Polyline[];
}

/**
 * The chart grid, drawn on the surface as **real curves read off the mesh**.
 *
 * It used to be a fragment-shader overlay: `fract(uv / spacing)` antialiased by `fwidth`. Three
 * things were wrong with that, and all three are the same thing. A line was drawn wherever a
 * fragment happened to be near a multiple of a fixed spacing, so it followed the *facets* — a
 * circle of constant u came back as a visible polygon, and the border of the domain was drawn
 * only when the domain happened to end on a multiple of the spacing, which is to say never. And
 * with the face turned off the overlay had to threshold its own coverage and discard, which threw
 * away the antialiasing it had just computed and left every line stepped.
 *
 * Tracing the mesh's own rows and columns fixes all of it at once: the lines are exactly as smooth
 * as the surface is (they *are* the surface's samples), the border is just the first and last row,
 * and the thick-line pass draws them antialiased with round caps like every other curve. The lift
 * clears the sagitta, the same one a geodesic uses.
 *
 * The mesh is a grid of (resU + 1) × (resV + 1) vertices in u-major order, which is what makes a
 * row a contiguous walk. A vertex with a zero normal is one the tessellator could not place — a
 * chart pole, a non-finite sample — and it breaks the line rather than being drawn through, which
 * is the non-finite contract as the line pass states it.
 */
export function surfaceGridLines(
  mesh: {
    positions: Float32Array;
    normals: Float32Array;
  },
  resU: number,
  resV: number,
  lift: number,
  divisions = GRID_DIVISIONS,
): SurfaceGridLines {
  const nV = resV + 1;
  const interior: Polyline[] = [];
  const border: Polyline[] = [];

  const trace = (fixed: number, isoU: boolean, color: Vec3): Polyline | null => {
    const count = (isoU ? resV : resU) + 1;
    const points = new Float32Array(count * 3);
    const valid = new Uint8Array(count);
    let usable = 0;

    for (let step = 0; step < count; step++) {
      const k = isoU ? fixed * nV + step : step * nV + fixed;
      const nx = mesh.normals[k * 3] ?? 0;
      const ny = mesh.normals[k * 3 + 1] ?? 0;
      const nz = mesh.normals[k * 3 + 2] ?? 0;
      // A zero normal is the tessellator's mark for a vertex with no tangent plane. Its position
      // may still be finite, but nothing can be lifted off a surface that has no normal there.
      if (nx * nx + ny * ny + nz * nz < 1e-12) continue;
      points[step * 3] = (mesh.positions[k * 3] ?? 0) + nx * lift;
      points[step * 3 + 1] = (mesh.positions[k * 3 + 1] ?? 0) + ny * lift;
      points[step * 3 + 2] = (mesh.positions[k * 3 + 2] ?? 0) + nz * lift;
      valid[step] = 1;
      usable++;
    }

    return usable >= 2 ? { points, count, valid, color } : null;
  };

  for (const [isoU, resolution] of [
    [true, resU],
    [false, resV],
  ] as const) {
    for (let i = 0; i <= divisions; i++) {
      const index = Math.round((i * resolution) / divisions);
      const edge = i === 0 || i === divisions;
      const line = trace(index, isoU, edge ? SURFACE_BORDER_COLOR : SURFACE_GRID_COLOR);
      if (!line) continue;
      (edge ? border : interior).push(line);
    }
  }

  return { interior, border };
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
  /**
   * The **surface's** parameter slots, which are a different list from the curve's.
   *
   * Passing the curve's array here is a silent disaster rather than a type error: both are
   * `Float64Array`, so a relation with no parameters hands an empty array to a sphere that
   * needs R, every point evaluates to NaN, every point reads as degenerate, and the whole
   * push-forward vanishes with no diagnostic.
   */
  surfaceParameters: ArrayLike<number>,
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
  const beyondValid = new Uint8Array(count);
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
    const finite = Number.isFinite(u) && Number.isFinite(v);

    if (i > 0) {
      const du = u - chartPoints[(i - 1) * 3]!;
      const dv = v - chartPoints[(i - 1) * 3 + 1]!;
      const step = Math.hypot(du, dv);
      arcLength[i] = arcLength[i - 1]! + (Number.isFinite(step) ? step : 0);
    }

    if (!finite) continue;

    // Periodic directions wrap rather than leaving the chart, so they are always in range.
    const insideU = !surface || surface.periodicU || (u >= uLo && u <= uHi);
    const insideV = !surface || surface.periodicV || (v >= vLo && v <= vHi);
    const inside = insideU && insideV;
    chartValid[i] = inside ? 1 : 0;
    beyondValid[i] = inside ? 0 : 1;
    if (!inside) {
      outside++;
      continue;
    }
    if (!surface) continue;

    surface.at(u, v, surfaceParameters, point);
    if (point.degenerate) continue;

    // Lifted along the normal, so the curve sits on the surface rather than inside it.
    surfacePoints[i * 3] = point.p[0] + point.N[0] * lift;
    surfacePoints[i * 3 + 1] = point.p[1] + point.N[1] * lift;
    surfacePoints[i * 3 + 2] = point.p[2] + point.N[2] * lift;
    surfaceValid[i] = 1;
  }

  const color = request.color ?? CHART_CURVE_PALETTE[request.colorIndex % CHART_CURVE_PALETTE.length]!;

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
    chartBeyond: anySet(beyondValid)
      ? { points: chartPoints, count, valid: beyondValid, arcLength, color }
      : null,
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
  /** Overrides the palette when the row has been given a colour of its own. */
  readonly color?: Vec3;
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
  /** the surface's own parameter slots — see `pushForward` on why these are separate */
  surfaceParameters: ArrayLike<number>,
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
  const beyondValid = new Uint8Array(count);
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
    // Off the domain but perfectly well defined: drawn in the chart, never on the surface.
    beyondValid[i] = finite && !inside ? 1 : 0;
    if (finite && !inside) outside++;

    if (i > 0) {
      const du = u - chartPoints[(i - 1) * 3]!;
      const dv = v - chartPoints[(i - 1) * 3 + 1]!;
      const step = Math.hypot(du, dv);
      arcLength[i] = arcLength[i - 1]! + (Number.isFinite(step) ? step : 0);
    }

    if (!surface || !inside) continue;
    surface.at(u, v, surfaceParameters, point);
    if (point.degenerate) continue;
    surfacePoints[i * 3] = point.p[0] + point.N[0] * lift;
    surfacePoints[i * 3 + 1] = point.p[1] + point.N[1] * lift;
    surfacePoints[i * 3 + 2] = point.p[2] + point.N[2] * lift;
    surfaceValid[i] = 1;
  }

  const color = request.color ?? CHART_CURVE_PALETTE[request.colorIndex % CHART_CURVE_PALETTE.length]!;
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
    chartBeyond: anySet(beyondValid)
      ? { points: chartPoints, count, valid: beyondValid, arcLength, color }
      : null,
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
  /** Overrides the palette when the row has been given a colour of its own. */
  readonly color?: Vec3;
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
  /** the surface's own parameter slots — see `pushForward` on why these are separate */
  surfaceParameters: ArrayLike<number>,
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

  const color = request.color ?? CHART_CURVE_PALETTE[request.colorIndex % CHART_CURVE_PALETTE.length]!;
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
      surface.at(u, v, surfaceParameters, point);
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
