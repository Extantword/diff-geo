import {
  divergingColor,
  INVALID_COLOR,
  sampleCurvatureRange,
  type CurvatureRange,
} from "../geom/curvatureColor.ts";
import type { ParametricSurface } from "../geom/parametric.ts";
import { makeSurfacePoint, sampleBounds, type Vec3 } from "../geom/types.ts";
import { periodicCanonical } from "./grid.ts";

/**
 * Tessellate a compiled surface, with exact normals and curvature baked in.
 *
 * Two things improve on the M0 path now that jets exist:
 *
 *  - **Normals are analytic.** `X_u × X_v` comes straight from the jet, so there is no
 *    face-normal averaging and no faceting on a coarse grid. Averaging was only ever a
 *    stand-in for the derivative we now have exactly.
 *  - **Curvature is evaluated, not approximated.** Each vertex carries its own K, so the
 *    colouring is the real invariant rather than something differenced off the mesh.
 *
 * The non-finite contract is enforced here: a vertex is invalid if its jet blew up *or*
 * if the surface is degenerate there (a chart pole, a cone point), and any triangle
 * touching an invalid vertex is dropped.
 */

/** The shade a surface takes when it has not been given one — a muted slate blue. */
export const DEFAULT_BASE_COLOR: Vec3 = [0.46, 0.58, 0.70];

export interface TessellatedSurface {
  /** 3 floats per vertex */
  positions: Float32Array;
  /** 3 floats per vertex, unit length; zero at degenerate vertices */
  normals: Float32Array;
  /** 2 floats per vertex: actual (u, v), for picking and the chart grid */
  chart: Float32Array;
  /**
   * 1 float per vertex: which object this vertex belongs to, for the pick pass.
   *
   * A float rather than an integer attribute so it rides alongside the others with no separate
   * buffer format; every integer below 2^24 is exact in float32, which is far beyond any
   * plausible row count.
   */
  ids: Float32Array;
  /** 3 floats per vertex, from the diverging curvature colormap */
  colors: Float32Array;
  /**
   * 3 floats per vertex: the surface's own colour, shown when curvature painting is off.
   *
   * Per vertex rather than as a uniform because every surface is concatenated into a single draw
   * call — a uniform could only give them all the same colour. The curvature colours stay separate
   * and are never overridden: that colour is a measurement, and the legend has to keep meaning
   * what it says.
   */
  baseColors: Float32Array;
  /** Gaussian curvature per vertex, for readouts and the legend */
  curvature: Float64Array;
  indices: Uint32Array;
  vertexCount: number;
  triangleCount: number;
  droppedVertices: number;
  droppedTriangles: number;
  /** the colour scale actually used, so the legend can label its ends */
  range: CurvatureRange;
}

export interface TessellateOptions {
  resU?: number;
  resV?: number;
  /** reuse a scale computed earlier, e.g. to keep colours stable while a slider moves */
  range?: CurvatureRange;
  /** stamped on every vertex so the pick pass can name what was clicked */
  objectId?: number;
  /** the surface's own colour, for the uncoloured view */
  baseColor?: Vec3;
}

export function tessellate(
  surface: ParametricSurface,
  params: ArrayLike<number>,
  options: TessellateOptions = {},
): TessellatedSurface {
  const { resU = 128, resV = 128, objectId = 0, baseColor = DEFAULT_BASE_COLOR } = options;
  const range = options.range ?? sampleCurvatureRange(surface, params);

  const [u0, u1] = sampleBounds(surface.u);
  const [v0, v1] = sampleBounds(surface.v);

  const nU = resU + 1;
  const nV = resV + 1;
  const stride = nV;
  const vertexCount = nU * nV;

  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const chart = new Float32Array(vertexCount * 2);
  const ids = new Float32Array(vertexCount).fill(objectId);
  const baseColors = new Float32Array(vertexCount * 3);
  for (let k = 0; k < vertexCount; k++) {
    baseColors[k * 3] = baseColor[0];
    baseColors[k * 3 + 1] = baseColor[1];
    baseColors[k * 3 + 2] = baseColor[2];
  }
  const colors = new Float32Array(vertexCount * 3);
  const curvature = new Float64Array(vertexCount);
  const valid = new Uint8Array(vertexCount);

  const point = makeSurfacePoint();
  const rgb: Vec3 = [0, 0, 0];
  let droppedVertices = 0;

  const canon = periodicCanonical(resU, resV, surface.periodicU, surface.periodicV);

  for (let i = 0; i < nU; i++) {
    const u = u0 + ((u1 - u0) * i) / resU;
    for (let j = 0; j < nV; j++) {
      const v = v0 + ((v1 - v0) * j) / resV;
      const k = i * stride + j;

      chart[k * 2] = u;
      chart[k * 2 + 1] = v;

      surface.at(u, v, params, point);

      const finitePosition =
        Number.isFinite(point.p[0]) &&
        Number.isFinite(point.p[1]) &&
        Number.isFinite(point.p[2]);

      if (!finitePosition) {
        droppedVertices++;
        curvature[k] = Number.NaN;
        colors[k * 3] = INVALID_COLOR[0];
        colors[k * 3 + 1] = INVALID_COLOR[1];
        colors[k * 3 + 2] = INVALID_COLOR[2];
        continue;
      }

      positions[k * 3] = point.p[0];
      positions[k * 3 + 1] = point.p[1];
      positions[k * 3 + 2] = point.p[2];

      if (point.degenerate) {
        // The position is fine but the tangent plane is not — a pole of the chart. Keep
        // the vertex so neighbouring triangles still close up, but mark it invalid so
        // nothing reads a meaningless normal or curvature from it.
        droppedVertices++;
        curvature[k] = Number.NaN;
        colors[k * 3] = INVALID_COLOR[0];
        colors[k * 3 + 1] = INVALID_COLOR[1];
        colors[k * 3 + 2] = INVALID_COLOR[2];
        continue;
      }

      valid[k] = 1;
      normals[k * 3] = point.N[0];
      normals[k * 3 + 1] = point.N[1];
      normals[k * 3 + 2] = point.N[2];
      curvature[k] = point.K;

      divergingColor(point.K / range.scale, rgb);
      colors[k * 3] = rgb[0];
      colors[k * 3 + 1] = rgb[1];
      colors[k * 3 + 2] = rgb[2];
    }
  }

  // Seam welding: a duplicated seam vertex takes its twin's shading data, so the normal
  // and colour are continuous across the seam while (u, v) stays distinct.
  for (let k = 0; k < vertexCount; k++) {
    const c = canon[k]!;
    if (c === k) continue;
    if (!valid[c]) continue;
    valid[k] = 1;
    normals[k * 3] = normals[c * 3]!;
    normals[k * 3 + 1] = normals[c * 3 + 1]!;
    normals[k * 3 + 2] = normals[c * 3 + 2]!;
    colors[k * 3] = colors[c * 3]!;
    colors[k * 3 + 1] = colors[c * 3 + 1]!;
    colors[k * 3 + 2] = colors[c * 3 + 2]!;
    curvature[k] = curvature[c]!;
  }

  const indices: number[] = [];
  let droppedTriangles = 0;

  const addTriangle = (a: number, b: number, c: number) => {
    if (!valid[a] || !valid[b] || !valid[c]) {
      droppedTriangles++;
      return;
    }
    indices.push(a, b, c);
  };

  for (let i = 0; i < resU; i++) {
    for (let j = 0; j < resV; j++) {
      const a = i * stride + j;
      const b = a + 1;
      const c = a + stride;
      const d = c + 1;
      addTriangle(a, c, b);
      addTriangle(b, c, d);
    }
  }

  return {
    positions,
    normals,
    chart,
    ids,
    colors,
    baseColors,
    curvature,
    indices: new Uint32Array(indices),
    vertexCount,
    triangleCount: indices.length / 3,
    droppedVertices,
    droppedTriangles,
    range,
  };
}
