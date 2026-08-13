import { ctx, type Expr } from "../core/expr/ast.ts";
import { buildDiffMap, type DiffMap } from "../core/jets/compile.ts";
import { bishopFrames, createSpaceCurve, makeFrenetFrame } from "../core/geom/curve.ts";
import { createParametricSurface } from "../core/geom/parametric.ts";
import { detectPeriodicity, detectPoles, type ChartPoles } from "../core/geom/periodic.ts";
import {
  integrateCurvatureLine,
  integrateGeodesic,
  sprayDirections,
} from "../core/geom/geodesic.ts";
import { robustScale, sampleCurvatureRange } from "../core/geom/curvatureColor.ts";
import {
  interval,
  makeChartData,
  makeSurfacePoint,
  sampleBounds,
  type Vec3,
} from "../core/geom/types.ts";
import { compileScalar } from "../core/expr/eval.ts";
import { tessellate, type TessellatedSurface } from "../core/mesh/tessellate.ts";
import { gaussImage, meshArea } from "../core/mesh/gaussMap.ts";
import type { LineGroup, Polyline } from "../gl/passes/lines.ts";
import type { Item, RowId } from "./graph.ts";
import {
  chartGrid,
  chartLift,
  pushForward,
  sampleChartGraph,
  sampleChartRelation,
  type ChartBounds,
} from "./chart.ts";

/**
 * Turning a resolved document into things on screen.
 *
 * Every row that classified into a drawable object is compiled, sampled and packed here.
 * Surfaces are **concatenated into one mesh** rather than drawn per-object: the surface
 * pass owns a single VAO, and one combined buffer keeps the draw count at one however many
 * surfaces the document holds. A shared curvature scale across all of them is a bonus
 * rather than a compromise — colours then mean the same thing on every surface at once.
 */

/** Default sampling domains, following do Carmo's variable conventions. */
export const DEFAULT_DOMAIN: Readonly<Record<string, readonly [number, number]>> = {
  u: [0, 2 * Math.PI],
  v: [0, 2 * Math.PI],
  t: [0, 2 * Math.PI],
  x: [-2, 2],
  y: [-2, 2],
};

export interface DomainRange {
  min: number;
  max: number;
}

/** Per-row request to draw a moving frame at one parameter value. */
export interface FrameRequest {
  readonly show: boolean;
  /** position along the domain, as a fraction in [0, 1] */
  readonly at: number;
}

export interface SceneRequest {
  readonly items: readonly Item[];
  /** live slider values by name; these win */
  readonly parameters: ReadonlyMap<string, number>;
  /**
   * Values declared by numeric rows, used for any parameter the caller did not override.
   *
   * Without this, a document reading `R = 2` / `r = 0.6` would compile R and r as slots and
   * then fill them with an arbitrary default — the torus renders with R = r, self-intersects,
   * and loses a ring of triangles. Passing the declared values closes that gap.
   */
  readonly declaredParameters?: ReadonlyMap<string, number>;
  /** per-row, per-variable sampling ranges */
  readonly domains: ReadonlyMap<RowId, readonly DomainRange[]>;
  readonly resolution: number;
  /** which curve rows should show their Frenet trihedron, and where */
  readonly frames?: ReadonlyMap<RowId, FrameRequest>;
  /** per-surface overlays: geodesic sprays and lines of curvature */
  readonly overlays?: ReadonlyMap<RowId, SurfaceOverlay>;
  /**
   * Plane-curve rows to read as curves in the chart rather than in the z = 0 plane.
   *
   * Their two components become (u, v), and the curve is drawn twice: flat in the chart inset,
   * and pushed forward onto the surface in the same colour, so the parametrization itself
   * becomes visible.
   */
  readonly inChart?: ReadonlySet<RowId>;
}

/**
 * Intrinsic and extrinsic curves drawn on a surface.
 *
 * Both start from `start` if given and from the centre of the domain otherwise. The centre is
 * the honest default rather than a placeholder: it needs no interaction, so a surface shows its
 * geodesics the moment the overlay is switched on, and a figure in the eventual book is
 * reproducible from its formula alone. A click supplies `start` and nothing else changes.
 */
export interface SurfaceOverlay {
  /** fan this many geodesics from the start point; 0 for none */
  readonly geodesics: number;
  /** arc length of each geodesic, as a fraction of the surface's extent */
  readonly geodesicLength: number;
  /** draw the two lines of curvature through the start point */
  readonly curvatureLines: boolean;
  /**
   * Draw the Gauss image on a sphere beside the surface.
   *
   * Side by side rather than in its own viewport: the two meshes share a colour scale and a vertex
   * correspondence, so having them in one scene under one camera is what lets you see which patch
   * went where as you orbit. A second viewport would break the shared framing that makes the
   * comparison legible.
   */
  readonly gaussMap?: boolean;
  /**
   * Where both start, in chart coordinates. Defaults to the centre of the domain.
   *
   * Clamped to the sampled domain rather than rejected when outside it, because a pick lands on
   * a triangle whose interpolated (u, v) can sit a hair past the last sample row.
   */
  readonly start?: readonly [number, number];
}

/**
 * Polyline segments per unit of the scene's extent, for overlay curves.
 *
 * Sets how finely a geodesic is sampled: a segment spans extent/this, so the drawn curve stays
 * smooth no matter how long it is. High enough that a great circle reads as round rather than
 * faceted, low enough that a long spray stays a few tens of thousands of segments.
 */
const SEGMENTS_PER_EXTENT = 220;

/**
 * Ceiling on the segments one surface's whole geodesic spray may spend.
 *
 * Density has to be bounded twice, because the two limits guard different things.
 * `SEGMENTS_PER_EXTENT` sets the spacing needed for a curve to look round; this stops the *total*
 * from growing without limit as the length and ray count are both turned up. Twelve rays of forty
 * units cost 89k points and 0.9s of integration without it, which is well past interactive — so
 * past this point the spray trades smoothness for staying responsive, which is the right way round
 * when the alternative is a frozen UI.
 */
const MAX_SPRAY_SEGMENTS = 26000;

/**
 * Where to put a Gauss image sphere so it sits clear of the surface it belongs to.
 *
 * Just past the surface's own +x extent, with a gap, and centred on the surface in y and z so the
 * two read as a pair at the same height rather than as two unrelated objects.
 */
function besideMesh(mesh: TessellatedSurface, radius: number): Vec3 {
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let k = 0; k < mesh.vertexCount; k++) {
    const x = mesh.positions[k * 3]!;
    const y = mesh.positions[k * 3 + 1]!;
    const z = mesh.positions[k * 3 + 2]!;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  if (!Number.isFinite(maxX)) return [0, 0, 0];
  return [maxX + radius * 1.35, (minY + maxY) / 2, (minZ + maxZ) / 2];
}

/** One note about a row, before notes are merged per row. */
interface RawReport {
  readonly rowId: RowId;
  readonly error?: string;
  readonly info?: string;
  readonly warning?: string;
}

/**
 * Everything to say about one row, as lists.
 *
 * Lists rather than single strings because a row genuinely can have several things to report at
 * once — a surface has its K and H, and separately how its geodesic spray ended. An earlier
 * version returned one entry per note and the UI keyed them by row into a Map, so the last note
 * silently erased the others: turning on geodesics made the curvature readout disappear.
 */
export interface RowReport {
  readonly rowId: RowId;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  readonly info: readonly string[];
}

export interface Scene {
  readonly mesh: TessellatedSurface | null;
  readonly lines: readonly LineGroup[];
  /** polylines for the chart inset, in (u, v) */
  readonly chartLines: readonly LineGroup[];
  /** the domain the inset shows, or null when there is no surface to chart */
  readonly chartBounds: ChartBounds | null;
  readonly reports: readonly RowReport[];
  readonly bounds: { center: Vec3; radius: number } | null;
  /** the shared colour scale, for the legend */
  readonly curvatureScale: number;
}

/** Distinct colours for curves, cycled by row order. */
const CURVE_PALETTE: readonly Vec3[] = [
  [0.45, 0.78, 1.0],
  [1.0, 0.78, 0.35],
  [0.55, 1.0, 0.65],
  [1.0, 0.55, 0.75],
  [0.75, 0.65, 1.0],
];

const CURVE_SAMPLES = 700;

/**
 * Compiled jets, keyed by the interned identity of their inputs.
 *
 * Differentiating and simplifying a surface costs a few milliseconds — fine once, ruinous at
 * 60 frames a second while a slider moves. Because expressions are interned, a node's id *is*
 * its structural identity, so the key is exact and cheap to build: same mathematics, same
 * entry, no re-differentiation.
 *
 * Parameter *values* are deliberately absent from the key. They are compiled as slots, so a
 * slider changes the numbers fed to an unchanged program — which is the whole reason dragging
 * one can be free.
 */
const diffMapCache = new Map<string, DiffMap>();
const DIFF_MAP_CACHE_LIMIT = 64;

function cachedDiffMap(request: {
  id: string;
  comps: readonly Expr[];
  vars: readonly string[];
  params: readonly string[];
  order: number;
}): DiffMap {
  const key =
    `${request.order}|${request.vars.join(",")}|${request.params.join(",")}|` +
    request.comps.map((comp) => comp.id).join(",");

  const hit = diffMapCache.get(key);
  if (hit) return hit;

  const built = buildDiffMap({
    id: request.id,
    comps: request.comps,
    vars: [...request.vars],
    params: [...request.params],
    order: request.order,
  });

  if (diffMapCache.size >= DIFF_MAP_CACHE_LIMIT) {
    // Plain FIFO eviction. The working set is the handful of rows on screen, so anything
    // fancier would be complexity without a payoff.
    const oldest = diffMapCache.keys().next().value;
    if (oldest !== undefined) diffMapCache.delete(oldest);
  }
  diffMapCache.set(key, built);
  return built;
}

/** Colours for the moving frame, shared with the row legend. */
const GEODESIC_COLOR: Vec3 = [1.0, 0.88, 0.4];
/** k1 and k2 get distinct colours; they are different curves through the same point. */
const CURVATURE_LINE_1: Vec3 = [1.0, 0.42, 0.42];
const CURVATURE_LINE_2: Vec3 = [0.45, 0.78, 1.0];
const T_COLOR: Vec3 = [0.42, 1.0, 0.58];
const N_COLOR: Vec3 = [1.0, 0.88, 0.4];
const B_COLOR: Vec3 = [1.0, 0.42, 0.42];
const POINT_COLOR: Vec3 = [1.0, 0.85, 0.45];

/** A two-point polyline standing in for one frame vector. */
function arrow(from: Vec3, direction: Vec3, length: number, color: Vec3): Polyline {
  return {
    points: new Float64Array([
      from[0],
      from[1],
      from[2],
      from[0] + direction[0] * length,
      from[1] + direction[1] * length,
      from[2] + direction[2] * length,
    ]),
    count: 2,
    color,
    arcLength: new Float64Array([0, length]),
  };
}

export function buildScene(request: SceneRequest): Scene {
  const { items, parameters, domains, resolution } = request;
  const frameRequests = request.frames ?? new Map<RowId, FrameRequest>();
  const declared = request.declaredParameters ?? new Map<string, number>();
  const inChart = request.inChart ?? new Set<RowId>();
  const overlays = request.overlays ?? new Map<RowId, SurfaceOverlay>();

  const reports: RawReport[] = [];
  const meshes: TessellatedSurface[] = [];
  const lines: LineGroup[] = [];
  const curvatureSamples: number[] = [];

  let curveIndex = 0;

  // Surfaces first, in two passes: sample every one to agree on a colour scale, then
  // tessellate. Without the shared pass each surface would get its own scale and identical
  // curvatures would paint differently on different objects.
  const surfaceItems = items.filter(
    (item) => item.kind === "parametricSurface" || item.kind === "graphSurface",
  );

  const compiledSurfaces: Array<{
    item: Item;
    surface: ReturnType<typeof createParametricSurface>;
    params: Float64Array;
    poles: ChartPoles;
    /**
     * The tessellated mesh, filled in by the tessellation pass below.
     *
     * Held on the entry rather than looked up by index in the parallel `meshes` array, because the
     * two only stay aligned while every tessellation succeeds — one throw and every later surface's
     * Gauss image would be built from its neighbour's normals.
     */
    mesh?: TessellatedSurface;
  }> = [];

  for (const item of surfaceItems) {
    try {
      const comps = surfaceComponents(item);
      const paramNames = [...item.params];
      const map = cachedDiffMap({
        id: `row-${item.rowId}`,
        comps,
        vars: surfaceVars(item),
        params: paramNames,
        order: 2,
      });
      const [uRange, vRange] = surfaceRanges(item, domains);
      const params = packParameters(paramNames, parameters, declared);

      /**
       * Built twice, because periodicity can only be measured and only matters once measured.
       *
       * Whether a chart boundary is a wall or a seam decides where geodesics stop, whether the
       * mesh welds its normals across it, and whether curves in the chart wrap — but the test
       * needs to evaluate X, which needs the parameters, which are not available when a surface
       * is compiled. So a provisional surface answers the question and a second one carries the
       * answer. Both share the cached DiffMap, so the only repeated cost is a few field copies.
       *
       * The alternative — declaring periodicity per template — does not survive loading one,
       * since a template is inserted as source text and a hand-typed sphere has no declaration
       * at all. Measuring it treats both the same.
       */
      const provisional = createParametricSurface({
        id: `row-${item.rowId}`,
        map,
        u: uRange,
        v: vRange,
      });
      const periodic = detectPeriodicity(provisional, params);
      const poles = detectPoles(provisional, params);
      const surface = createParametricSurface({
        id: `row-${item.rowId}`,
        map,
        u: uRange,
        v: vRange,
        periodicU: periodic.u,
        periodicV: periodic.v,
      });
      compiledSurfaces.push({ item, surface, params, poles });

      const range = sampleCurvatureRange(surface, params, 24);
      if (Number.isFinite(range.minK)) curvatureSamples.push(range.minK, range.maxK);
    } catch (thrown) {
      reports.push({ rowId: item.rowId, error: messageOf(thrown) });
    }
  }

  const curvatureScale = robustScale(curvatureSamples, 1);

  for (const entry of compiledSurfaces) {
    const { item, surface, params } = entry;
    try {
      const mesh = tessellate(surface, params, {
        resU: resolution,
        resV: resolution,
        range: {
          scale: curvatureScale,
          minK: Number.NaN,
          maxK: Number.NaN,
          invalidFraction: 0,
        },
        // The row id travels into the mesh so a pick can name the row it landed on.
        objectId: item.rowId,
      });
      meshes.push(mesh);
      entry.mesh = mesh;

      const point = makeSurfacePoint();
      const uMid = (surface.u.min + surface.u.max) / 2;
      const vMid = (surface.v.min + surface.v.max) / 2;
      surface.at(uMid, vMid, params, point);
      reports.push({
        rowId: item.rowId,
        info: point.degenerate
          ? "no tangent plane at the domain centre"
          : `K = ${point.K.toFixed(3)}   H = ${point.H.toFixed(3)}`,
        warning:
          mesh.droppedTriangles > mesh.triangleCount
            ? `${mesh.droppedTriangles} triangles dropped — check the domain`
            : undefined,
      });
    } catch (thrown) {
      reports.push({ rowId: item.rowId, error: messageOf(thrown) });
    }
  }

  // ---- geodesics and lines of curvature ----
  //
  // Placed after tessellation because the lift and the arc length both scale with the surface's
  // own size, which is only known once its mesh exists.
  const sceneExtent = meshes.length > 0 ? extentOfMeshes(meshes) : 1;
  const overlayLift = chartLift(sceneExtent, resolution, curvatureScale);

  for (const { item, surface, params, poles, mesh: sourceMesh } of compiledSurfaces) {
    const overlay = overlays.get(item.rowId);
    if (!overlay) continue;

    /**
     * The domain the overlay curves may integrate through, widened across coordinate poles.
     *
     * A pole is not an edge of the surface: the sphere's u = 0 collapses to a single point and the
     * parametrization runs straight through it, so a great circle reaching it has left nothing and
     * stopping there is an artifact of the chart. Extending by the interval's own width is exactly
     * enough for one crossing on each side — for the sphere that turns u ∈ [0, π] into [-π, 2π],
     * and since X(u + 2π, v) = X(u, v) a meridian traverses a whole great circle within it.
     *
     * A REGULAR boundary is left alone: a cylinder's rim really is where the surface ends, and a
     * geodesic must stop with it rather than run off into the analytic continuation.
     */
    const uWidth = surface.u.max - surface.u.min;
    const vWidth = surface.v.max - surface.v.min;
    const [uLo, uHi] = sampleBounds(surface.u);
    const [vLo, vHi] = sampleBounds(surface.v);
    const bounds = {
      u: [
        poles.uMin ? surface.u.min - uWidth : uLo,
        poles.uMax ? surface.u.max + uWidth : uHi,
      ] as const,
      v: [
        poles.vMin ? surface.v.min - vWidth : vLo,
        poles.vMax ? surface.v.max + vWidth : vHi,
      ] as const,
    };

    /**
     * Cap the step so density is geometric, not a fixed sample count.
     *
     * `minSamples` alone divides the requested arc length, so a geodesic wrapping a sphere nine
     * times got the same 242 points as one crossing it once and was drawn as a visible polygon.
     * Tying the spacing to the surface's own extent keeps the curve smooth however far it runs.
     */
    const sprayArc = Math.max(sceneExtent * overlay.geodesicLength * overlay.geodesics, 1e-9);
    const maxStepArc = Math.max(
      sceneExtent / SEGMENTS_PER_EXTENT,
      sprayArc / MAX_SPRAY_SEGMENTS,
    );

    if (overlay.gaussMap && sourceMesh) {
      {
        const source = sourceMesh;
        /**
         * Placed to the right of everything drawn so far, at a radius that reads as comparable to
         * the surface rather than dwarfed by it. The true Gauss map has radius 1, so this is a
         * presentation scale — the shape of the image and its area RATIO are what carry meaning,
         * and both are preserved.
         */
        const radius = sceneExtent * 0.55;
        const center = besideMesh(source, radius);
        const image = gaussImage(source, { radius, center });
        meshes.push(image);
        // Reported as a ratio, which is the one number that means something: the image's area over
        // the surface's is the average |K|, and equals it exactly in the limit.
        const imageArea = meshArea(image) / (radius * radius);
        reports.push({
          rowId: item.rowId,
          info: `Gauss image area ${imageArea.toFixed(3)} = ∫|K| dA`,
        });
      }
    }
    const clamp = (value: number, min: number, max: number) =>
      Math.min(max, Math.max(min, value));
    const uMid = overlay.start
      ? clamp(overlay.start[0], surface.u.min, surface.u.max)
      : (surface.u.min + surface.u.max) / 2;
    const vMid = overlay.start
      ? clamp(overlay.start[1], surface.v.min, surface.v.max)
      : (surface.v.min + surface.v.max) / 2;

    try {
      if (overlay.geodesics > 0) {
        const point = makeSurfacePoint();
        const chart = makeChartData();
        surface.at(uMid, vMid, params, point, chart);

        if (point.degenerate) {
          reports.push({
            rowId: item.rowId,
            warning: "no tangent plane at the domain centre, so no geodesics were shot",
          });
        } else {
          const length = sceneExtent * overlay.geodesicLength;
          const polylines: Polyline[] = [];
          const stops = new Map<string, number>();

          for (const direction of sprayDirections(chart.I, overlay.geodesics)) {
            const geodesic = integrateGeodesic(surface, params, [uMid, vMid], direction, length, {
              bounds,
              maxStepArc,
            });
            stops.set(geodesic.stop, (stops.get(geodesic.stop) ?? 0) + 1);
            if (geodesic.chart.length < 2) continue;
            polylines.push(
              liftedPolyline(surface, params, geodesic.chart, overlayLift, GEODESIC_COLOR),
            );
          }
          if (polylines.length > 0) {
            lines.push({ polylines, style: { widthPx: 2.6 } });
          }
          // Reporting WHY each ray ended is the difference between a picture and a diagnosis.
          reports.push({
            rowId: item.rowId,
            info: `${polylines.length} geodesics · ${[...stops]
              .map(([reason, count]) => `${count} ${reason}`)
              .join(", ")}`,
          });
        }
      }

      if (overlay.curvatureLines) {
        const point = makeSurfacePoint();
        surface.at(uMid, vMid, params, point);
        if (point.degenerate) {
          // Checked before `umbilic`, because a degenerate point is not umbilic — the flags are
          // cleared there — so testing only for umbilic left this case drawing nothing at all
          // and saying nothing either.
          reports.push({
            rowId: item.rowId,
            warning: "no tangent plane at the domain centre, so no lines of curvature",
          });
        } else if (point.umbilic) {
          reports.push({
            rowId: item.rowId,
            warning: point.planar
              ? "planar point at the centre: every direction is principal"
              : "umbilic point at the centre: the principal directions are arbitrary here",
          });
        } else {
          const polylines: Polyline[] = [];
          for (const which of [1, 2] as const) {
            const colour = which === 1 ? CURVATURE_LINE_1 : CURVATURE_LINE_2;
            // Both ways from the centre, so the curve is not a one-sided half.
            for (const sign of [1, -1] as const) {
              const run = integrateCurvatureLine(
                surface,
                params,
                [uMid, vMid],
                which,
                sign * sceneExtent * 1.2,
                { bounds },
              );
              if (run.chart.length < 2) continue;
              polylines.push(
                liftedPolyline(surface, params, run.chart, overlayLift, colour),
              );
            }
          }
          if (polylines.length > 0) lines.push({ polylines, style: { widthPx: 3 } });
        }
      }
    } catch (thrown) {
      reports.push({ rowId: item.rowId, error: messageOf(thrown) });
    }
  }

  // Curves.
  for (const item of items) {
    if (item.kind !== "spaceCurve" && item.kind !== "planeCurve") continue;
    // Chart curves take the push-forward path below instead.
    if (item.kind === "planeCurve" && inChart.has(item.rowId)) continue;
    try {
      // A plane curve is drawn in the z = 0 plane. Its signed curvature remains a
      // separate quantity computed from the genuine two-component map — see curve.ts on
      // why the 3D kappa is not a substitute.
      const comps = [...item.comps];
      if (item.kind === "planeCurve") comps.push(ctx.zero);
      const paramNames = [...item.params];
      const map = cachedDiffMap({
        id: `row-${item.rowId}`,
        comps,
        vars: [item.vars[0] ?? "t"],
        params: paramNames,
        order: 3,
      });
      const range = domains.get(item.rowId)?.[0];
      const curve = createSpaceCurve({
        id: `row-${item.rowId}`,
        map,
        t: interval(
          range?.min ?? DEFAULT_DOMAIN["t"]![0],
          range?.max ?? DEFAULT_DOMAIN["t"]![1],
        ),
      });
      const params = packParameters(paramNames, parameters, declared);
      const frames = bishopFrames(curve, params, CURVE_SAMPLES);

      const polyline: Polyline = {
        points: frames.points,
        count: frames.count,
        valid: frames.valid,
        arcLength: frames.arcLength,
        color: CURVE_PALETTE[curveIndex % CURVE_PALETTE.length]!,
      };
      lines.push({ polylines: [polyline], style: { widthPx: 3.5 } });
      curveIndex++;

      // The moving frame, if this row asked for one. Its position along the domain is
      // where kappa and tau are reported too, so the readout follows the glyphs.
      const wanted = frameRequests.get(item.rowId);
      const at = wanted?.show ? Math.min(Math.max(wanted.at, 0), 1) : 0.5;
      const t = curve.t.min + (curve.t.max - curve.t.min) * at;

      const frame = makeFrenetFrame();
      curve.frenet(t, params, frame);

      if (wanted?.show) {
        // Glyph length tracks the curve's own extent, so the frame stays legible whether
        // the curve is a unit circle or a hundred units across.
        const extent = extentOf(frames);
        const glyphLength = Math.max(extent * 0.22, 1e-3);
        const glyphs: Polyline[] = [];
        // T exists wherever the parametrization is regular.
        if (frame.status !== "singular") {
          glyphs.push(arrow(frame.p, frame.T, glyphLength, T_COLOR));
        }
        // N and B exist only where the osculating plane does. Refusing to draw them at an
        // inflection is the whole point of tracking `status`.
        if (frame.status === "regular") {
          glyphs.push(arrow(frame.p, frame.N, glyphLength, N_COLOR));
          glyphs.push(arrow(frame.p, frame.B, glyphLength, B_COLOR));
        }
        if (glyphs.length > 0) {
          lines.push({ polylines: glyphs, style: { widthPx: 5 } });
        }
      }

      reports.push({
        rowId: item.rowId,
        info:
          frame.status === "regular"
            ? `t = ${t.toFixed(3)}   κ = ${frame.kappa.toFixed(3)}` +
              (frame.tauValid ? `   τ = ${frame.tau.toFixed(3)}` : "   τ undefined")
            : frame.status === "inflection"
              ? `t = ${t.toFixed(3)}   κ = 0 — N and B undefined here`
              : `t = ${t.toFixed(3)}   singular parametrization here`,
      });
    } catch (thrown) {
      reports.push({ rowId: item.rowId, error: messageOf(thrown) });
    }
  }

  // ---- the chart view ----
  //
  // The first surface in the document owns the chart. With several surfaces there is no single
  // (u, v) plane to show, so picking the first is a stated convention rather than a guess.
  const primary = compiledSurfaces[0] ?? null;
  const chartBounds: ChartBounds | null = primary
    ? {
        u: [primary.surface.u.min, primary.surface.u.max],
        v: [primary.surface.v.min, primary.surface.v.max],
      }
    : null;

  const chartLines: LineGroup[] = chartBounds ? [...chartGrid(chartBounds)] : [];
  const chartCurves: Polyline[] = [];
  let chartColorIndex = 0;

  if (chartBounds && primary) {
    // The lift needs the scene's size, which is only known once the meshes exist.
    const provisional = meshes.length > 0 ? extentOfMeshes(meshes) : 1;
    const lift = chartLift(provisional, resolution, curvatureScale);

    // Graphs v = f(u) and relations F(u,v) = 0 are chart objects by construction — no toggle
    // needed, because there is nothing else they could mean.
    for (const item of items) {
      if (item.kind !== "chartGraph") continue;
      try {
        const paramNames = [...item.params];
        const result = sampleChartGraph(
          {
            rowId: item.rowId,
            body: item.comps[0]!,
            params: paramNames,
            variable: (item.vars[0] === "v" ? "v" : "u") as "u" | "v",
            colorIndex: chartColorIndex++,
          },
          chartBounds,
          primary.surface,
          packParameters(paramNames, parameters, declared),
          primary.params,
          lift,
        );
        chartCurves.push(result.chart);
        if (result.surface) lines.push({ polylines: [result.surface], style: { widthPx: 4 } });
        reports.push({
          rowId: item.rowId,
          info:
            item.vars[0] === "v"
              ? `u = ${item.name ?? "f"}(v) in the chart`
              : `v = ${item.name ?? "f"}(u) in the chart`,
          warning:
            result.outsideFraction > 0.02
              ? `${Math.round(result.outsideFraction * 100)}% of the graph leaves the domain`
              : undefined,
        });
      } catch (thrown) {
        reports.push({ rowId: item.rowId, error: messageOf(thrown) });
      }
    }

    for (const item of items) {
      if (item.kind !== "chartRelation") continue;
      try {
        const paramNames = [...item.params];
        const result = sampleChartRelation(
          {
            rowId: item.rowId,
            comps: item.comps,
            params: paramNames,
            colorIndex: chartColorIndex++,
          },
          chartBounds,
          primary.surface,
          packParameters(paramNames, parameters, declared),
          primary.params,
          lift,
          Math.max(resolution, 120),
        );
        chartCurves.push(...result.chart);
        if (result.surface.length > 0) {
          lines.push({ polylines: result.surface, style: { widthPx: 4 } });
        }
        reports.push({
          rowId: item.rowId,
          info:
            result.segmentCount === 0
              ? "no solutions in this domain"
              : `${result.segmentCount} contour segments`,
        });
      } catch (thrown) {
        reports.push({ rowId: item.rowId, error: messageOf(thrown) });
      }
    }

    for (const item of items) {
      if (item.kind !== "planeCurve" || !inChart.has(item.rowId)) continue;
      try {
        const range = domains.get(item.rowId)?.[0] ?? {
          min: DEFAULT_DOMAIN["t"]![0],
          max: DEFAULT_DOMAIN["t"]![1],
        };
        const paramNames = [...item.params];
        const result = pushForward(
          {
            rowId: item.rowId,
            comps: item.comps,
            params: paramNames,
            variable: item.vars[0] ?? "t",
            range,
            colorIndex: chartColorIndex++,
          },
          primary.surface,
          packParameters(paramNames, parameters, declared),
          primary.params,
          lift,
        );

        chartCurves.push(result.chart);
        if (result.surface) lines.push({ polylines: [result.surface], style: { widthPx: 4 } });

        reports.push({
          rowId: item.rowId,
          info: `in the chart of the first surface`,
          warning:
            result.outsideFraction > 0.02
              ? `${Math.round(result.outsideFraction * 100)}% of this curve lies outside the domain`
              : undefined,
        });
      } catch (thrown) {
        reports.push({ rowId: item.rowId, error: messageOf(thrown) });
      }
    }
  }

  if (chartCurves.length > 0) {
    chartLines.push({ polylines: chartCurves, style: { widthPx: 2.5 } });
  }

  // Points come free from the lines pass: a zero-length segment with round caps renders
  // as a disc, so no separate billboard pass is needed for them.
  const dots: Polyline[] = [];
  for (const item of items) {
    if (item.kind !== "point") continue;
    try {
      const coords = item.comps.map((comp) => {
        const compiled = compileScalar(comp, { vars: [], params: [...item.params] });
        return compiled.call([], packParameters([...item.params], parameters, declared));
      });
      const position: Vec3 = [coords[0] ?? 0, coords[1] ?? 0, coords[2] ?? 0];
      if (!position.every((value) => Number.isFinite(value))) {
        reports.push({ rowId: item.rowId, error: "this point is not finite" });
        continue;
      }
      dots.push({
        points: new Float64Array([...position, ...position]),
        count: 2,
        color: POINT_COLOR,
      });
      reports.push({
        rowId: item.rowId,
        info: `(${position.map((v) => v.toFixed(3)).join(", ")})`,
      });
    } catch (thrown) {
      reports.push({ rowId: item.rowId, error: messageOf(thrown) });
    }
  }
  if (dots.length > 0) lines.push({ polylines: dots, style: { widthPx: 11 } });

  const mesh = meshes.length === 0 ? null : concatenate(meshes);
  const bounds = computeBounds(mesh, lines);

  return {
    mesh,
    lines,
    chartLines,
    chartBounds,
    reports: mergeReports(reports),
    bounds,
    curvatureScale,
  };
}

/** Half the largest span across a set of meshes — a stand-in for scene size. */
function extentOfMeshes(meshes: readonly TessellatedSurface[]): number {
  let min = [Infinity, Infinity, Infinity];
  let max = [-Infinity, -Infinity, -Infinity];
  for (const mesh of meshes) {
    for (let i = 0; i < mesh.vertexCount; i++) {
      for (let c = 0; c < 3; c++) {
        const value = mesh.positions[i * 3 + c]!;
        if (!Number.isFinite(value)) continue;
        if (value < min[c]!) min[c] = value;
        if (value > max[c]!) max[c] = value;
      }
    }
  }
  let span = 0;
  for (let c = 0; c < 3; c++) {
    const width = max[c]! - min[c]!;
    if (Number.isFinite(width)) span = Math.max(span, width);
  }
  return Math.max(span / 2, 1e-3);
}

/** Largest span of a sampled curve, used to scale frame glyphs to the object. */
function extentOf(frames: {
  points: Float64Array;
  valid: Uint8Array;
  count: number;
}): number {
  let min = [Infinity, Infinity, Infinity];
  let max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < frames.count; i++) {
    if (!frames.valid[i]) continue;
    for (let c = 0; c < 3; c++) {
      const value = frames.points[i * 3 + c]!;
      if (!Number.isFinite(value)) continue;
      if (value < min[c]!) min[c] = value;
      if (value > max[c]!) max[c] = value;
    }
  }
  let span = 0;
  for (let c = 0; c < 3; c++) {
    const width = max[c]! - min[c]!;
    if (Number.isFinite(width)) span = Math.max(span, width);
  }
  return span;
}

/**
 * A chart polyline as a 3D one, lifted clear of the mesh.
 *
 * Degenerate samples are marked invalid rather than dropped, so the line pass breaks the stroke
 * there instead of connecting across a pole.
 */
function liftedPolyline(
  surface: ReturnType<typeof createParametricSurface>,
  params: ArrayLike<number>,
  chart: readonly (readonly [number, number])[],
  lift: number,
  color: Vec3,
): Polyline {
  const count = chart.length;
  const points = new Float64Array(count * 3);
  const valid = new Uint8Array(count);
  const arcLength = new Float64Array(count);
  const point = makeSurfacePoint();

  for (let i = 0; i < count; i++) {
    const [u, v] = chart[i]!;
    surface.at(u, v, params, point);
    if (point.degenerate) continue;
    points[i * 3] = point.p[0] + point.N[0] * lift;
    points[i * 3 + 1] = point.p[1] + point.N[1] * lift;
    points[i * 3 + 2] = point.p[2] + point.N[2] * lift;
    valid[i] = 1;
    if (i > 0) {
      arcLength[i] =
        arcLength[i - 1]! +
        Math.hypot(
          points[i * 3]! - points[(i - 1) * 3]!,
          points[i * 3 + 1]! - points[(i - 1) * 3 + 1]!,
          points[i * 3 + 2]! - points[(i - 1) * 3 + 2]!,
        );
    }
  }

  return { points, count, valid, arcLength, color };
}

/** Collapse the raw notes into one entry per row, preserving every line. */
function mergeReports(raw: readonly RawReport[]): RowReport[] {
  const byRow = new Map<RowId, { errors: string[]; warnings: string[]; info: string[] }>();
  for (const note of raw) {
    let entry = byRow.get(note.rowId);
    if (!entry) {
      entry = { errors: [], warnings: [], info: [] };
      byRow.set(note.rowId, entry);
    }
    if (note.error) entry.errors.push(note.error);
    if (note.warning) entry.warnings.push(note.warning);
    if (note.info) entry.info.push(note.info);
  }
  return [...byRow].map(([rowId, entry]) => ({ rowId, ...entry }));
}

function messageOf(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}

/** A graph `z = f(x,y)` is the parametric surface (x, y, f) — nothing more. */
function surfaceComponents(item: Item): Expr[] {
  if (item.kind !== "graphSurface") return [...item.comps];
  const [first = "x", second = "y"] = item.vars;
  return [ctx.variable(first), ctx.variable(second), item.comps[0]!];
}

function surfaceVars(item: Item): string[] {
  if (item.kind === "graphSurface") return [item.vars[0] ?? "x", item.vars[1] ?? "y"];
  return [item.vars[0] ?? "u", item.vars[1] ?? "v"];
}

function surfaceRanges(
  item: Item,
  domains: ReadonlyMap<RowId, readonly DomainRange[]>,
) {
  const vars = surfaceVars(item);
  const stored = domains.get(item.rowId);
  const rangeFor = (index: number) => {
    const explicit = stored?.[index];
    if (explicit) return interval(explicit.min, explicit.max);
    const fallback = DEFAULT_DOMAIN[vars[index]!] ?? [0, 2 * Math.PI];
    return interval(fallback[0], fallback[1]);
  };
  return [rangeFor(0), rangeFor(1)] as const;
}

function packParameters(
  names: readonly string[],
  values: ReadonlyMap<string, number>,
  declared: ReadonlyMap<string, number> = new Map(),
): Float64Array {
  return Float64Array.from(
    names.map((name) => values.get(name) ?? declared.get(name) ?? 1),
  );
}

/**
 * Pack several tessellated surfaces into one set of buffers.
 *
 * Index offsets shift per mesh; everything else concatenates directly, since all surfaces
 * share one shader and one colour scale.
 */
function concatenate(meshes: readonly TessellatedSurface[]): TessellatedSurface {
  if (meshes.length === 1) return meshes[0]!;

  let vertexCount = 0;
  let indexCount = 0;
  let droppedVertices = 0;
  let droppedTriangles = 0;
  for (const mesh of meshes) {
    vertexCount += mesh.vertexCount;
    indexCount += mesh.indices.length;
    droppedVertices += mesh.droppedVertices;
    droppedTriangles += mesh.droppedTriangles;
  }

  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const colors = new Float32Array(vertexCount * 3);
  const chart = new Float32Array(vertexCount * 2);
  const ids = new Float32Array(vertexCount);
  const curvature = new Float64Array(vertexCount);
  const indices = new Uint32Array(indexCount);

  let vertexOffset = 0;
  let indexOffset = 0;
  for (const mesh of meshes) {
    positions.set(mesh.positions, vertexOffset * 3);
    normals.set(mesh.normals, vertexOffset * 3);
    colors.set(mesh.colors, vertexOffset * 3);
    chart.set(mesh.chart, vertexOffset * 2);
    ids.set(mesh.ids, vertexOffset);
    curvature.set(mesh.curvature, vertexOffset);
    for (let i = 0; i < mesh.indices.length; i++) {
      indices[indexOffset + i] = mesh.indices[i]! + vertexOffset;
    }
    vertexOffset += mesh.vertexCount;
    indexOffset += mesh.indices.length;
  }

  return {
    positions,
    normals,
    colors,
    chart,
    ids,
    curvature,
    indices,
    vertexCount,
    triangleCount: indexCount / 3,
    droppedVertices,
    droppedTriangles,
    /**
     * Taking the first mesh's range is safe because there is only one.
     *
     * `curvatureScale` is computed once from samples pooled across every surface and then handed
     * to all of them, so all the ranges here are equal by construction. That matters: the legend
     * labels a single scale, and if each surface had been coloured against its own, two shapes
     * would show the same colour for different curvatures — a figure that lies about the one
     * thing it exists to show.
     */
    range: meshes[0]!.range,
  };
}

function computeBounds(
  mesh: TessellatedSurface | null,
  lines: readonly LineGroup[],
): { center: Vec3; radius: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  const include = (x: number, y: number, z: number) => {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  };

  if (mesh) {
    for (let i = 0; i < mesh.vertexCount; i++) {
      include(mesh.positions[i * 3]!, mesh.positions[i * 3 + 1]!, mesh.positions[i * 3 + 2]!);
    }
  }
  for (const group of lines) {
    for (const line of group.polylines) {
      for (let i = 0; i < line.count; i++) {
        if (line.valid && !line.valid[i]) continue;
        include(line.points[i * 3]!, line.points[i * 3 + 1]!, line.points[i * 3 + 2]!);
      }
    }
  }

  if (!Number.isFinite(minX)) return null;
  const center: Vec3 = [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];

  // Robust radius: the far corner of the box would over-frame a flat object badly.
  let maxDistanceSquared = 0;
  const consider = (x: number, y: number, z: number) => {
    const dx = x - center[0];
    const dy = y - center[1];
    const dz = z - center[2];
    const d = dx * dx + dy * dy + dz * dz;
    if (Number.isFinite(d) && d > maxDistanceSquared) maxDistanceSquared = d;
  };
  if (mesh) {
    for (let i = 0; i < mesh.vertexCount; i++) {
      consider(mesh.positions[i * 3]!, mesh.positions[i * 3 + 1]!, mesh.positions[i * 3 + 2]!);
    }
  }
  for (const group of lines) {
    for (const line of group.polylines) {
      for (let i = 0; i < line.count; i++) {
        if (line.valid && !line.valid[i]) continue;
        consider(line.points[i * 3]!, line.points[i * 3 + 1]!, line.points[i * 3 + 2]!);
      }
    }
  }

  return { center, radius: Math.max(Math.sqrt(maxDistanceSquared), 0.05) };
}
