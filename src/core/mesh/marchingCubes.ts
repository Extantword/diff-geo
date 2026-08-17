import { colormapColor, type ColormapName } from "../geom/colormaps.ts";
import { INVALID_COLOR, robustScale, type CurvatureRange } from "../geom/curvatureColor.ts";
import type { ImplicitSurface } from "../geom/implicit.ts";
import { makeSurfacePoint, sampleBounds, type Vec3 } from "../geom/types.ts";
import { DEFAULT_BASE_COLOR, styleCode, type TessellatedSurface } from "./tessellate.ts";

/**
 * A mesh for a level set: `{ p : F(p) = 0 }` inside a box.
 *
 * The output is the same `TessellatedSurface` a parametrization produces, so the surface pass,
 * the picking pass, the curvature colours and the legend take it without a single branch. That
 * is the whole reason this file exists rather than a raymarching shader: a second way of getting
 * pixels on screen would need its own lighting, its own picking and its own colour scale, and
 * would still not be a mesh anything else could measure.
 *
 * ## Marching **tetrahedra**, not cubes
 *
 * Each cube is split into six tetrahedra (Kuhn's subdivision, every tet sharing the main
 * diagonal) and each tet is cut independently. The reasons, in order:
 *
 *  - **There is no ambiguous case.** A cube face whose diagonal corners share a sign can be cut
 *    two ways, and guessing produces surfaces that visibly connect wrongly near a saddle —
 *    `contour.ts` resolves the same thing one dimension down by sampling the cell centre. A
 *    tetrahedron has no such freedom: four corners admit exactly one cut per sign pattern.
 *  - **There is no 256-entry table.** Marching cubes needs one, and a table nobody can read is a
 *    table nobody can check. Sixteen cases fit on a screen.
 *  - **It is watertight by construction.** Kuhn's subdivision with one global corner ordering
 *    induces the same diagonal on a shared face from both sides, so neighbouring cubes agree.
 *
 * The cost is about twice as many triangles for a given grid, and slightly worse triangle shapes.
 * Neither shows, because the normals do not come from the triangles.
 *
 * ## The normals are exact
 *
 * A mesher normally averages face normals, which is an approximation that looks like faceting on
 * a coarse grid. Here the surface is a level set, so `N = ∇F/|∇F|` is available at every vertex
 * exactly — as is the curvature, through the same Hessian. The mesh is a set of sample points on
 * a surface whose geometry is known analytically, and it is shaded as such.
 *
 * Each vertex also takes **one Newton step**, `p ← p − F ∇F/|∇F|²`, after the linear interpolation
 * along its edge. Linear interpolation is exact only where F is linear, and the step costs one
 * evaluation to remove most of the error where it is not — visible on a coarse grid as a sphere
 * that is round rather than slightly polygonal.
 */

export interface MarchOptions {
  /** cells per axis; vertices are the (res + 1)³ grid points */
  readonly res?: number;
  /** reuse a scale computed earlier, so colours hold still while a slider moves */
  readonly range?: CurvatureRange;
  /** stamped on every vertex so a pick can name the row it landed on */
  readonly objectId?: number;
  readonly baseColor?: Vec3;
  readonly colormap?: ColormapName;
  /** draw the shaded face at all */
  readonly fill?: boolean;
}

/**
 * The six tetrahedra of a cube, as corner indices.
 *
 * A corner is numbered by its offsets: `c = dx + 2·dy + 4·dz`, so 0 is the low corner and 7 is
 * the high one. Every tet contains both, which is what makes the subdivision conform across
 * faces — the diagonal a neighbour sees is the one this ordering already fixed.
 */
const TETRAHEDRA: readonly (readonly [number, number, number, number])[] = [
  [0, 1, 3, 7],
  [0, 1, 5, 7],
  [0, 4, 5, 7],
  [0, 4, 6, 7],
  [0, 2, 6, 7],
  [0, 2, 3, 7],
];

/** The six edges of a tetrahedron, as pairs of its own corner indices 0…3. */
const TET_EDGES: readonly (readonly [number, number])[] = [
  [0, 1],
  [1, 2],
  [2, 0],
  [0, 3],
  [1, 3],
  [2, 3],
];

/**
 * Which edges are cut, per sign pattern, as triangles.
 *
 * Bit `i` is set when corner `i` is **inside** (F < 0). Cases 0 and 15 cut nothing; a single
 * corner on one side gives one triangle; two and two gives a quad, written as two triangles.
 * Complementary cases cut the same edges — only the orientation differs, and orientation is
 * fixed against ∇F afterwards rather than trusted to this table.
 */
const TET_CASES: readonly (readonly number[])[] = [
  [], // 0000
  [0, 2, 3], // 0001  v0
  [0, 1, 4], // 0010  v1
  [2, 3, 4, 2, 4, 1], // 0011  v0 v1
  [1, 2, 5], // 0100  v2
  [0, 3, 5, 0, 5, 1], // 0101  v0 v2
  [0, 4, 5, 0, 5, 2], // 0110  v1 v2
  [3, 4, 5], // 0111  v0 v1 v2 → the cut around v3
  [3, 4, 5], // 1000  v3
  [0, 2, 5, 0, 5, 4], // 1001  v0 v3
  [0, 1, 5, 0, 5, 3], // 1010  v1 v3
  [1, 2, 5], // 1011  → the cut around v2
  [2, 1, 4, 2, 4, 3], // 1100  v2 v3
  [0, 1, 4], // 1101  → the cut around v1
  [0, 2, 3], // 1110  → the cut around v0
  [], // 1111
];

/** Newton is only trusted to move a vertex a fraction of a cell; past that, the linear guess wins. */
const MAX_REFINE = 0.75;

export function marchImplicit(
  surface: ImplicitSurface,
  params: ArrayLike<number>,
  options: MarchOptions = {},
): TessellatedSurface {
  const res = Math.max(2, Math.floor(options.res ?? 48));
  const objectId = options.objectId ?? 0;
  const baseColor = options.baseColor ?? DEFAULT_BASE_COLOR;
  const colormap = options.colormap ?? "curvature";
  const fill = options.fill ?? true;

  const [x0, x1] = sampleBounds(surface.x);
  const [y0, y1] = sampleBounds(surface.y);
  const [z0, z1] = sampleBounds(surface.z);
  const n = res + 1;
  const dx = (x1 - x0) / res;
  const dy = (y1 - y0) / res;
  const dz = (z1 - z0) / res;
  const cell = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz));

  // ---- sample F on the grid ----
  const values = new Float64Array(n * n * n);
  let invalidSamples = 0;
  for (let k = 0; k < n; k++) {
    const z = z0 + dz * k;
    for (let j = 0; j < n; j++) {
      const y = y0 + dy * j;
      for (let i = 0; i < n; i++) {
        const value = surface.value(x0 + dx * i, y, z, params);
        values[i + n * (j + n * k)] = value;
        if (!Number.isFinite(value)) invalidSamples++;
      }
    }
  }

  const positions: number[] = [];
  const indices: number[] = [];
  /** grid-edge key → vertex index, so a shared edge yields one shared vertex */
  const byEdge = new Map<number, number>();
  const total = n * n * n;
  const gradient: Vec3 = [0, 0, 0];

  const cornerAt = (base: number, corner: number): number =>
    base + (corner & 1) + n * ((corner >> 1) & 1) + n * n * ((corner >> 2) & 1);

  /** The vertex on the grid edge between two corners, made once and then reused. */
  const vertexOn = (a: number, b: number): number => {
    const low = Math.min(a, b);
    const high = Math.max(a, b);
    const key = low * total + high;
    const existing = byEdge.get(key);
    if (existing !== undefined) return existing;

    const fa = values[low]!;
    const fb = values[high]!;
    const denominator = fa - fb;
    const t = Math.abs(denominator) < 1e-300 ? 0.5 : fa / denominator;

    const ax = x0 + dx * (low % n);
    const ay = y0 + dy * (Math.floor(low / n) % n);
    const az = z0 + dz * Math.floor(low / (n * n));
    const bx = x0 + dx * (high % n);
    const by = y0 + dy * (Math.floor(high / n) % n);
    const bz = z0 + dz * Math.floor(high / (n * n));

    let px = ax + (bx - ax) * t;
    let py = ay + (by - ay) * t;
    let pz = az + (bz - az) * t;

    /**
     * One Newton step onto the level set.
     *
     * Guarded twice: a vanishing gradient would divide by nothing, and a step longer than a
     * fraction of a cell means the linear model was wrong enough that Newton is not to be
     * trusted either — a thin feature between two grid points, say. Both leave the interpolated
     * point, which is never worse than what marching cubes would have produced.
     */
    const value = surface.gradient(px, py, pz, params, gradient);
    const squared =
      gradient[0] * gradient[0] + gradient[1] * gradient[1] + gradient[2] * gradient[2];
    if (Number.isFinite(value) && squared > 0) {
      const step = value / squared;
      if (Math.abs(step) * Math.sqrt(squared) < MAX_REFINE * cell) {
        px -= step * gradient[0];
        py -= step * gradient[1];
        pz -= step * gradient[2];
      }
    }

    const index = positions.length / 3;
    positions.push(px, py, pz);
    byEdge.set(key, index);
    return index;
  };

  // ---- cut every tetrahedron of every cube ----
  const corners = new Array<number>(8);
  const cut = new Array<number>(6);
  for (let k = 0; k < res; k++) {
    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        const base = i + n * (j + n * k);
        let usable = true;
        for (let corner = 0; corner < 8; corner++) {
          const at = cornerAt(base, corner);
          corners[corner] = at;
          // A cube touching a non-finite sample is skipped rather than cut through infinity:
          // the non-finite contract, at the mesh boundary where it is load-bearing.
          if (!Number.isFinite(values[at]!)) usable = false;
        }
        if (!usable) continue;

        for (const tet of TETRAHEDRA) {
          let mask = 0;
          for (let c = 0; c < 4; c++) {
            if (values[corners[tet[c]!]!]! < 0) mask |= 1 << c;
          }
          const pattern = TET_CASES[mask]!;
          if (pattern.length === 0) continue;

          for (let e = 0; e < 6; e++) cut[e] = -1;
          for (const edge of pattern) {
            if (cut[edge]! >= 0) continue;
            const [a, b] = TET_EDGES[edge]!;
            cut[edge] = vertexOn(corners[tet[a]!]!, corners[tet[b]!]!);
          }
          for (let t = 0; t < pattern.length; t += 3) {
            indices.push(cut[pattern[t]!]!, cut[pattern[t + 1]!]!, cut[pattern[t + 2]!]!);
          }
        }
      }
    }
  }

  // ---- shade every vertex from the surface itself ----
  const vertexCount = positions.length / 3;
  const positionArray = Float32Array.from(positions);
  const normals = new Float32Array(vertexCount * 3);
  const curvature = new Float64Array(vertexCount);
  const colors = new Float32Array(vertexCount * 3);
  const baseColors = new Float32Array(vertexCount * 3);
  const ids = new Float32Array(vertexCount).fill(objectId);
  // No chart grid on a level set — there is no chart — so only the face bit is ever set.
  const style = new Float32Array(vertexCount).fill(styleCode(fill, false));
  /**
   * A level set has no (u, v), and this says so rather than inventing one.
   *
   * The pick pass reports these two floats beside the row id, so anything reading them off an
   * implicit surface is asking a question the object cannot answer; leaving them zero is the
   * honest reply, and the row's kind is what tells a caller not to ask.
   */
  const chart = new Float32Array(vertexCount * 2);

  const point = makeSurfacePoint();
  const rgb: Vec3 = [0, 0, 0];
  const valid = new Uint8Array(vertexCount);
  let droppedVertices = 0;

  for (let v = 0; v < vertexCount; v++) {
    baseColors[v * 3] = baseColor[0];
    baseColors[v * 3 + 1] = baseColor[1];
    baseColors[v * 3 + 2] = baseColor[2];

    surface.at(
      positionArray[v * 3]!,
      positionArray[v * 3 + 1]!,
      positionArray[v * 3 + 2]!,
      params,
      point,
    );
    if (point.degenerate) {
      // A critical point of F. The vertex stays so its triangles still close up, and its zero
      // normal is what the shader and the grid tracer both read as "nothing here to shade".
      droppedVertices++;
      curvature[v] = Number.NaN;
      colors[v * 3] = INVALID_COLOR[0];
      colors[v * 3 + 1] = INVALID_COLOR[1];
      colors[v * 3 + 2] = INVALID_COLOR[2];
      continue;
    }
    valid[v] = 1;
    normals[v * 3] = point.N[0];
    normals[v * 3 + 1] = point.N[1];
    normals[v * 3 + 2] = point.N[2];
    curvature[v] = point.K;
  }

  /**
   * The colour scale comes from the mesh's own curvatures.
   *
   * A level set has no domain to sample independently of the mesh — the surface *is* wherever F
   * vanishes — so the vertices are the sample. A robust quantile rather than the maximum, for the
   * reason it always is: one vertex near a critical point can carry K ≈ 10¹², and scaling by that
   * paints everything a uniform grey.
   */
  const finite = curvature.length === 0 ? [] : [...curvature].filter((k) => Number.isFinite(k));
  const range: CurvatureRange = options.range ?? {
    scale: robustScale(finite, 0.98),
    minK: finite.length === 0 ? Number.NaN : Math.min(...finite),
    maxK: finite.length === 0 ? Number.NaN : Math.max(...finite),
    invalidFraction: vertexCount === 0 ? 0 : droppedVertices / vertexCount,
  };

  for (let v = 0; v < vertexCount; v++) {
    if (!valid[v]) continue;
    colormapColor(colormap, curvature[v]! / range.scale, rgb, baseColor);
    colors[v * 3] = rgb[0];
    colors[v * 3 + 1] = rgb[1];
    colors[v * 3 + 2] = rgb[2];
  }

  /**
   * Triangles are wound to agree with ∇F, and the ones touching a bad vertex are dropped.
   *
   * The winding is fixed here rather than in the case table because it is checkable here: the
   * surface's own normal says which way is out, so a table entry in the wrong order cannot
   * produce an inside-out triangle. Nothing culls back faces, so this is for anything that later
   * measures the mesh rather than for the shading.
   */
  const kept: number[] = [];
  let droppedTriangles = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t]!;
    const b = indices[t + 1]!;
    const c = indices[t + 2]!;
    if (a === b || b === c || a === c) {
      droppedTriangles++;
      continue;
    }
    if (!valid[a] || !valid[b] || !valid[c]) {
      droppedTriangles++;
      continue;
    }
    const ux = positionArray[b * 3]! - positionArray[a * 3]!;
    const uy = positionArray[b * 3 + 1]! - positionArray[a * 3 + 1]!;
    const uz = positionArray[b * 3 + 2]! - positionArray[a * 3 + 2]!;
    const vx = positionArray[c * 3]! - positionArray[a * 3]!;
    const vy = positionArray[c * 3 + 1]! - positionArray[a * 3 + 1]!;
    const vz = positionArray[c * 3 + 2]! - positionArray[a * 3 + 2]!;
    const cx = uy * vz - uz * vy;
    const cy = uz * vx - ux * vz;
    const cz = ux * vy - uy * vx;
    const along =
      cx * normals[a * 3]! + cy * normals[a * 3 + 1]! + cz * normals[a * 3 + 2]!;
    if (along < 0) kept.push(a, c, b);
    else kept.push(a, b, c);
  }

  return {
    positions: positionArray,
    normals,
    chart,
    ids,
    style,
    colors,
    baseColors,
    curvature,
    indices: Uint32Array.from(kept),
    vertexCount,
    triangleCount: kept.length / 3,
    droppedVertices: droppedVertices + invalidSamples,
    droppedTriangles,
    range,
  };
}
