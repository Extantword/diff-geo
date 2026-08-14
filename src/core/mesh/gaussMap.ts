import type { TessellatedSurface } from "./tessellate.ts";
import type { Vec3 } from "../geom/types.ts";

/**
 * The Gauss map, as a mesh.
 *
 * do Carmo §3-2. N: S → S² sends each point of an oriented surface to its unit normal, regarded as
 * a point of the unit sphere. It is the object the second fundamental form is *defined* from — II
 * is −dN — so seeing where a patch of surface lands on the sphere is seeing the shape operator
 * directly rather than as a number.
 *
 * ## Why this needs almost no code
 *
 * The tessellated mesh already carries the unit normal at every vertex, and the Gauss image of that
 * vertex *is* that normal. So the image mesh is the same mesh with **positions and normals
 * swapped** — and the swap is self-consistent, because the outward normal of a unit sphere at the
 * point N happens to be N itself. Nothing needs re-evaluating, no jets are recomputed, and the
 * correspondence between a point and its image is exact rather than resampled: vertex k of the
 * image is the image of vertex k.
 *
 * Colours, curvature and chart coordinates are carried across untouched, which is what makes the
 * two meshes readable side by side — a patch and its image are painted the same, so you can see
 * which region went where, and see it fold where K changes sign.
 *
 * ## What the image looks like, and why that is the point
 *
 * The area distortion of the Gauss map is exactly |K| (do Carmo §3-3): a triangle of area A maps to
 * one of area |K|·A. So a sphere's image is the whole sphere, a plane's collapses to a single
 * point, and a cylinder's collapses to a *circle* — one-dimensional, which is what K = 0 looks
 * like geometrically. That identity is what `tests/mesh/gaussMap.test.ts` checks, and it verifies
 * the normals and the curvatures against each other in one line.
 */

export interface GaussImageOptions {
  /** radius of the sphere the image is drawn on; 1 is the true Gauss map */
  readonly radius?: number;
  /** where to put the sphere's centre, so the image can sit beside the surface */
  readonly center?: Vec3;
}

/**
 * Build the mesh of the Gauss image: `p ↦ center + radius · N(p)`.
 *
 * Shares the source mesh's index buffer, so triangles already dropped for touching a non-finite or
 * degenerate vertex stay dropped. That matters here more than usual: a degenerate vertex has no
 * normal, and without the source's culling its image would collapse onto the sphere's centre and
 * draw a spike from the middle of the ball to its surface.
 */
export function gaussImage(
  mesh: TessellatedSurface,
  options: GaussImageOptions = {},
): TessellatedSurface {
  const { radius = 1, center = [0, 0, 0] } = options;
  const count = mesh.vertexCount;
  const positions = new Float32Array(count * 3);

  for (let k = 0; k < count; k++) {
    const nx = mesh.normals[k * 3]!;
    const ny = mesh.normals[k * 3 + 1]!;
    const nz = mesh.normals[k * 3 + 2]!;
    positions[k * 3] = center[0] + radius * nx;
    positions[k * 3 + 1] = center[1] + radius * ny;
    positions[k * 3 + 2] = center[2] + radius * nz;
  }

  return {
    positions,
    // The outward normal of a sphere at N is N, so the source normals serve unchanged and the
    // image is lit as the ball it is.
    normals: mesh.normals,
    chart: mesh.chart,
    ids: mesh.ids,
    colors: mesh.colors,
    baseColors: mesh.baseColors,
    curvature: mesh.curvature,
    indices: mesh.indices,
    vertexCount: count,
    triangleCount: mesh.triangleCount,
    droppedVertices: mesh.droppedVertices,
    droppedTriangles: mesh.droppedTriangles,
    range: mesh.range,
  };
}

/**
 * Total area of a mesh's triangles.
 *
 * Exists to verify the Gauss map rather than to be drawn: comparing the image's area against
 * ∫|K| dA over the source turns the area-distortion identity into a test.
 */
export function meshArea(mesh: TessellatedSurface): number {
  let total = 0;
  for (let t = 0; t + 2 < mesh.indices.length; t += 3) {
    const a = mesh.indices[t]!;
    const b = mesh.indices[t + 1]!;
    const c = mesh.indices[t + 2]!;
    const ax = mesh.positions[a * 3]!;
    const ay = mesh.positions[a * 3 + 1]!;
    const az = mesh.positions[a * 3 + 2]!;
    const ux = mesh.positions[b * 3]! - ax;
    const uy = mesh.positions[b * 3 + 1]! - ay;
    const uz = mesh.positions[b * 3 + 2]! - az;
    const vx = mesh.positions[c * 3]! - ax;
    const vy = mesh.positions[c * 3 + 1]! - ay;
    const vz = mesh.positions[c * 3 + 2]! - az;
    total += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
  }
  return total;
}

/**
 * ∫|K| dA over a mesh, as the sum over triangles of |K| at the centroid times the triangle's area.
 *
 * The quantity the Gauss image's area must equal, since |K| is precisely the map's area
 * distortion. Triangles with a non-finite K at any corner are skipped rather than counted as zero,
 * so a surface with a singular patch reports the total over the part where it is defined.
 */
export function totalAbsoluteCurvature(mesh: TessellatedSurface): number {
  let total = 0;
  for (let t = 0; t + 2 < mesh.indices.length; t += 3) {
    const a = mesh.indices[t]!;
    const b = mesh.indices[t + 1]!;
    const c = mesh.indices[t + 2]!;
    const ka = mesh.curvature[a]!;
    const kb = mesh.curvature[b]!;
    const kc = mesh.curvature[c]!;
    if (!Number.isFinite(ka) || !Number.isFinite(kb) || !Number.isFinite(kc)) continue;

    const ax = mesh.positions[a * 3]!;
    const ay = mesh.positions[a * 3 + 1]!;
    const az = mesh.positions[a * 3 + 2]!;
    const ux = mesh.positions[b * 3]! - ax;
    const uy = mesh.positions[b * 3 + 1]! - ay;
    const uz = mesh.positions[b * 3 + 2]! - az;
    const vx = mesh.positions[c * 3]! - ax;
    const vy = mesh.positions[c * 3 + 1]! - ay;
    const vz = mesh.positions[c * 3 + 2]! - az;
    const area = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    total += (Math.abs(ka) + Math.abs(kb) + Math.abs(kc)) / 3 * area;
  }
  return total;
}
