import { ctx, type Expr } from "../core/expr/ast.ts";
import { buildDiffMap } from "../core/jets/compile.ts";
import { bishopFrames, createSpaceCurve, makeFrenetFrame } from "../core/geom/curve.ts";
import { createParametricSurface } from "../core/geom/parametric.ts";
import { robustScale, sampleCurvatureRange } from "../core/geom/curvatureColor.ts";
import { interval, makeSurfacePoint, type Vec3 } from "../core/geom/types.ts";
import { tessellate, type TessellatedSurface } from "../core/mesh/tessellate.ts";
import type { LineGroup, Polyline } from "../gl/passes/lines.ts";
import type { Item, RowId } from "./graph.ts";

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

export interface SceneRequest {
  readonly items: readonly Item[];
  /** slider values by name */
  readonly parameters: ReadonlyMap<string, number>;
  /** per-row, per-variable sampling ranges */
  readonly domains: ReadonlyMap<RowId, readonly DomainRange[]>;
  readonly resolution: number;
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

export function buildScene(request: SceneRequest): Scene {
  const { items, parameters, domains, resolution } = request;

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
      const map = buildDiffMap({
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
      const params = packParameters(paramNames, parameters);
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
    try {
      // A plane curve is drawn in the z = 0 plane. Its signed curvature remains a
      // separate quantity computed from the genuine two-component map — see curve.ts on
      // why the 3D kappa is not a substitute.
      const comps = [...item.comps];
      if (item.kind === "planeCurve") comps.push(ctx.zero);
      const paramNames = [...item.params];
      const map = buildDiffMap({
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
      const params = packParameters(paramNames, parameters);
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

      const frame = makeFrenetFrame();
      curve.frenet((curve.t.min + curve.t.max) / 2, params, frame);
      reports.push({
        rowId: item.rowId,
        info:
          frame.status === "regular"
            ? `κ = ${frame.kappa.toFixed(3)}` +
              (frame.tauValid ? `   τ = ${frame.tau.toFixed(3)}` : "   τ undefined")
            : frame.status === "inflection"
              ? "κ = 0 at the midpoint — N and B undefined there"
              : "singular parametrization at the midpoint",
      });
    } catch (thrown) {
      reports.push({ rowId: item.rowId, error: messageOf(thrown) });
    }
  }

  const mesh = meshes.length === 0 ? null : concatenate(meshes);
  const bounds = computeBounds(mesh, lines);

  return {
    mesh,
    lines,
    reports,
    bounds,
    curvatureScale,
  };
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
): Float64Array {
  return Float64Array.from(names.map((name) => values.get(name) ?? 1));
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
