import type { ParametricSource, Vec3 } from "../geom/types.ts";
import { sampleBounds } from "../geom/types.ts";

/**
 * A tessellated surface, ready to be uploaded as GPU buffers. Plain typed arrays —
 * `core` knows nothing about WebGL.
 */
export interface SurfaceMesh {
  /** 3 floats per vertex */
  positions: Float32Array;
  /** 3 floats per vertex, unit length (zero for degenerate vertices) */
  normals: Float32Array;
  /**
   * 2 floats per vertex: the ACTUAL chart coordinates (u, v), not normalized to
   * [0,1]. Storing the real values lets the pick pass emit (u,v) directly without
   * knowing the domain — ManifoldSandbox stored `i/resU` and had to map back
   * through the surface's ranges after a raycast.
   */
  chart: Float32Array;
  indices: Uint32Array;
  vertexCount: number;
  triangleCount: number;
  /** vertices whose embedding evaluated to a non-finite value */
  droppedVertices: number;
  /** triangles discarded because they touched a non-finite vertex */
  droppedTriangles: number;
}

export interface GridOpts {
  resU?: number;
  resV?: number;
}

/**
 * Centre and radius of a sphere enclosing the finite part of a mesh — enough to
 * frame the camera. Uses the midpoint of the AABB rather than the centroid so that
 * a dense pole does not drag the framing off centre.
 */
export function boundingSphere(mesh: SurfaceMesh): { center: Vec3; radius: number } {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  for (let k = 0; k < mesh.vertexCount; k++) {
    const x = mesh.positions[k * 3]!;
    const y = mesh.positions[k * 3 + 1]!;
    const z = mesh.positions[k * 3 + 2]!;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }

  if (!Number.isFinite(minX)) return { center: [0, 0, 0], radius: 1 };

  const center: Vec3 = [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];

  // Second pass for the radius: the distance to the AABB *corner* would also
  // enclose the mesh, but it overestimates badly for anything flat. A torus with
  // R=2, r=0.7 has a true radius of 2.7 and a half-diagonal of 3.88 — framing on
  // the latter shrinks the surface to 70% of the viewport for no reason.
  let maxDistSq = 0;
  for (let k = 0; k < mesh.vertexCount; k++) {
    const x = mesh.positions[k * 3]!;
    const y = mesh.positions[k * 3 + 1]!;
    const z = mesh.positions[k * 3 + 2]!;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    const dx = x - center[0];
    const dy = y - center[1];
    const dz = z - center[2];
    const distSq = dx * dx + dy * dy + dz * dz;
    if (distSq > maxDistSq) maxDistSq = distSq;
  }

  return { center, radius: Math.max(Math.sqrt(maxDistSq), 1e-3) };
}

/**
 * Sample X(u,v) on a uniform grid over the (inset) domain and triangulate.
 *
 * Non-finite vertices are flagged rather than fatal: any triangle touching one is
 * dropped, so a formula that blows up on part of its domain still renders correctly
 * everywhere else. This is the mesh end of the non-finite contract in geom/types.ts.
 *
 * Normals are accumulated from face normals. In M1, once jets exist, parametric
 * surfaces get exact normals from Xu × Xv and this becomes the fallback for
 * marching-cubes output.
 */
export function buildSurfaceMesh(src: ParametricSource, opts: GridOpts = {}): SurfaceMesh {
  const { resU = 110, resV = 110 } = opts;
  const [u0, u1] = sampleBounds(src.u);
  const [v0, v1] = sampleBounds(src.v);

  const nU = resU + 1;
  const nV = resV + 1;
  const vertexCount = nU * nV;
  const stride = nV;

  // Positions accumulate in double precision: face normals of a near-degenerate
  // triangle are the first thing to lose significance at float32.
  const pos = new Float64Array(vertexCount * 3);
  const chart = new Float32Array(vertexCount * 2);
  const finite = new Uint8Array(vertexCount);
  let droppedVertices = 0;

  for (let i = 0; i < nU; i++) {
    const u = u0 + ((u1 - u0) * i) / resU;
    for (let j = 0; j < nV; j++) {
      const v = v0 + ((v1 - v0) * j) / resV;
      const k = i * stride + j;
      const [x, y, z] = src.position(u, v);
      const ok = Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z);
      if (ok) {
        pos[k * 3] = x;
        pos[k * 3 + 1] = y;
        pos[k * 3 + 2] = z;
        finite[k] = 1;
      } else {
        droppedVertices++;
      }
      chart[k * 2] = u;
      chart[k * 2 + 1] = v;
    }
  }

  // Indexed reads on typed arrays are `number | undefined` under
  // noUncheckedIndexedAccess. Confine the assertions to this one accessor rather
  // than sprinkling `!` through the loops below.
  const vertexAt = (k: number): Vec3 => [pos[k * 3]!, pos[k * 3 + 1]!, pos[k * 3 + 2]!];

  const indices: number[] = [];
  const nrm = new Float64Array(vertexCount * 3);
  let droppedTriangles = 0;

  const addTriangle = (a: number, b: number, c: number) => {
    if (!finite[a] || !finite[b] || !finite[c]) {
      droppedTriangles++;
      return;
    }
    const A = vertexAt(a);
    const B = vertexAt(b);
    const C = vertexAt(c);
    const e1x = B[0] - A[0];
    const e1y = B[1] - A[1];
    const e1z = B[2] - A[2];
    const e2x = C[0] - A[0];
    const e2y = C[1] - A[1];
    const e2z = C[2] - A[2];
    // Unnormalized cross product, so larger faces carry proportionally more weight.
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    if (!Number.isFinite(nx) || !Number.isFinite(ny) || !Number.isFinite(nz)) {
      droppedTriangles++;
      return;
    }
    indices.push(a, b, c);
    for (const k of [a, b, c]) {
      const base = k * 3;
      // Written out rather than `+=`: a compound assignment counts as a read, which
      // noUncheckedIndexedAccess types as possibly undefined.
      nrm[base] = nrm[base]! + nx;
      nrm[base + 1] = nrm[base + 1]! + ny;
      nrm[base + 2] = nrm[base + 2]! + nz;
    }
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

  const normals = new Float32Array(vertexCount * 3);
  for (let k = 0; k < vertexCount; k++) {
    const x = nrm[k * 3]!;
    const y = nrm[k * 3 + 1]!;
    const z = nrm[k * 3 + 2]!;
    const len = Math.hypot(x, y, z);
    if (len > 1e-12) {
      normals[k * 3] = x / len;
      normals[k * 3 + 1] = y / len;
      normals[k * 3 + 2] = z / len;
    }
    // else: leave (0,0,0). A zero normal shades black rather than shading wrong,
    // which is the honest signal for a degenerate point (a cone tip, a pole).
  }

  const positions = new Float32Array(vertexCount * 3);
  for (let k = 0; k < positions.length; k++) positions[k] = pos[k]!;

  return {
    positions,
    normals,
    chart,
    indices: new Uint32Array(indices),
    vertexCount,
    triangleCount: indices.length / 3,
    droppedVertices,
    droppedTriangles,
  };
}
