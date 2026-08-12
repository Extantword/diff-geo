import { ctx, type Expr } from "../core/expr/ast.ts";
import { buildDiffMap, type DiffMap } from "../core/jets/compile.ts";
import { bishopFrames, createSpaceCurve, makeFrenetFrame } from "../core/geom/curve.ts";
import { createParametricSurface } from "../core/geom/parametric.ts";
import { robustScale, sampleCurvatureRange } from "../core/geom/curvatureColor.ts";
import { interval, makeSurfacePoint, type Vec3 } from "../core/geom/types.ts";
import { compileScalar } from "../core/expr/eval.ts";
import { tessellate, type TessellatedSurface } from "../core/mesh/tessellate.ts";
import type { LineGroup, Polyline } from "../gl/passes/lines.ts";
import type { Item, RowId } from "./graph.ts";
import { chartGrid, chartLift, pushForward, type ChartBounds } from "./chart.ts";

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
  /**
   * Plane-curve rows to read as curves in the chart rather than in the z = 0 plane.
   *
   * Their two components become (u, v), and the curve is drawn twice: flat in the chart inset,
   * and pushed forward onto the surface in the same colour, so the parametrization itself
   * becomes visible.
   */
  readonly inChart?: ReadonlySet<RowId>;
}

export interface RowReport {
  readonly rowId: RowId;
  /** something went wrong compiling or sampling this row */
  readonly error?: string;
  /** e.g. "K ∈ [−1.00, 1.00]" or "κ = 0.92, τ = 0.31" */
  readonly info?: string;
  /** dropped geometry, worth surfacing when it is most of the row */
  readonly warning?: string;
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

  const reports: RowReport[] = [];
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
      const surface = createParametricSurface({
        id: `row-${item.rowId}`,
        map,
        u: uRange,
        v: vRange,
      });
      const params = packParameters(paramNames, parameters, declared);
      compiledSurfaces.push({ item, surface, params });

      const range = sampleCurvatureRange(surface, params, 24);
      if (Number.isFinite(range.minK)) curvatureSamples.push(range.minK, range.maxK);
    } catch (thrown) {
      reports.push({ rowId: item.rowId, error: messageOf(thrown) });
    }
  }

  const curvatureScale = robustScale(curvatureSamples, 1);

  for (const { item, surface, params } of compiledSurfaces) {
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
      });
      meshes.push(mesh);

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
    reports,
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
  const curvature = new Float64Array(vertexCount);
  const indices = new Uint32Array(indexCount);

  let vertexOffset = 0;
  let indexOffset = 0;
  for (const mesh of meshes) {
    positions.set(mesh.positions, vertexOffset * 3);
    normals.set(mesh.normals, vertexOffset * 3);
    colors.set(mesh.colors, vertexOffset * 3);
    chart.set(mesh.chart, vertexOffset * 2);
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
    curvature,
    indices,
    vertexCount,
    triangleCount: indexCount / 3,
    droppedVertices,
    droppedTriangles,
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
