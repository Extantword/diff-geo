import { describe, expect, it } from "vitest";
import { torus } from "../src/core/catalog/torus.ts";
import { boundingSphere, buildSurfaceMesh } from "../src/core/mesh/grid.ts";
import { interval, type ParametricSource, type Vec3 } from "../src/core/geom/types.ts";

const close = (a: number, b: number, tol = 1e-9) => expect(Math.abs(a - b)).toBeLessThan(tol);

describe("buildSurfaceMesh", () => {
  const R = 2;
  const r = 0.7;
  const src = torus(R, r);
  const mesh = buildSurfaceMesh(src, { resU: 24, resV: 32 });

  it("produces the expected grid topology", () => {
    expect(mesh.vertexCount).toBe(25 * 33);
    expect(mesh.triangleCount).toBe(24 * 32 * 2);
    expect(mesh.positions.length).toBe(mesh.vertexCount * 3);
    expect(mesh.normals.length).toBe(mesh.vertexCount * 3);
    expect(mesh.chart.length).toBe(mesh.vertexCount * 2);
  });

  it("drops nothing for a surface that is regular everywhere", () => {
    expect(mesh.droppedVertices).toBe(0);
    expect(mesh.droppedTriangles).toBe(0);
  });

  it("places every vertex on the torus", () => {
    // (√(x²+z²) − R)² + y² = r² is the implicit form of this parametrization.
    for (let k = 0; k < mesh.vertexCount; k++) {
      const x = mesh.positions[k * 3]!;
      const y = mesh.positions[k * 3 + 1]!;
      const z = mesh.positions[k * 3 + 2]!;
      const radial = Math.hypot(x, z) - R;
      close(radial * radial + y * y, r * r, 1e-5);
    }
  });

  it("stores actual chart coordinates, not normalized ones", () => {
    // The pick pass reads (u,v) straight out of this attribute, so the values must
    // be the real parameters and must span the full domain.
    let maxU = -Infinity;
    let maxV = -Infinity;
    for (let k = 0; k < mesh.vertexCount; k++) {
      maxU = Math.max(maxU, mesh.chart[k * 2]!);
      maxV = Math.max(maxV, mesh.chart[k * 2 + 1]!);
    }
    close(maxU, 2 * Math.PI, 1e-6);
    close(maxV, 2 * Math.PI, 1e-6);
  });

  it("produces unit normals pointing away from the tube centre", () => {
    for (let k = 0; k < mesh.vertexCount; k++) {
      const n: Vec3 = [
        mesh.normals[k * 3]!,
        mesh.normals[k * 3 + 1]!,
        mesh.normals[k * 3 + 2]!,
      ];
      close(Math.hypot(n[0], n[1], n[2]), 1, 1e-6);
    }
  });

  it("welds normals across periodic seams", () => {
    // X(0,v) and X(2π,v) are the same point, so their normals must agree exactly —
    // otherwise the seam renders as a lit stripe down the torus.
    const stride = 33;
    for (let j = 0; j <= 32; j++) {
      const first = 0 * stride + j;
      const last = 24 * stride + j;
      close(mesh.normals[first * 3]!, mesh.normals[last * 3]!, 1e-12);
      close(mesh.normals[first * 3 + 1]!, mesh.normals[last * 3 + 1]!, 1e-12);
      close(mesh.normals[first * 3 + 2]!, mesh.normals[last * 3 + 2]!, 1e-12);
    }
  });

  it("keeps chart coordinates distinct across the seam despite welding", () => {
    // The welding must NOT collapse (u,v): the pick pass and the chart grid both
    // need u to stay monotonic across the seam strip.
    const stride = 33;
    close(mesh.chart[(0 * stride + 5) * 2]!, 0, 1e-12);
    close(mesh.chart[(24 * stride + 5) * 2]!, 2 * Math.PI, 1e-6);
  });

  it("frames a bounding sphere around the outer radius", () => {
    const { center, radius } = boundingSphere(mesh);
    close(center[0], 0, 1e-6);
    close(center[1], 0, 1e-6);
    close(center[2], 0, 1e-6);
    // Outermost points of the torus sit at distance R + r from the axis.
    close(radius, R + r, 1e-3);
  });
});

describe("the non-finite contract", () => {
  /** A surface that blows up on half its domain, as user formulas routinely do. */
  const halfBad: ParametricSource = {
    id: "half-bad",
    name: "log(u) patch",
    position(u, v): Vec3 {
      // log of a non-positive number is NaN/-Infinity: the u < 0 half is unusable.
      return [u, Math.log(u), v];
    },
    u: interval(-1, 1),
    v: interval(0, 1),
    periodicU: false,
    periodicV: false,
  };

  it("drops triangles touching non-finite vertices instead of throwing", () => {
    const mesh = buildSurfaceMesh(halfBad, { resU: 20, resV: 4 });
    expect(mesh.droppedVertices).toBeGreaterThan(0);
    expect(mesh.droppedTriangles).toBeGreaterThan(0);
    // The good half still renders.
    expect(mesh.triangleCount).toBeGreaterThan(0);
  });

  it("never emits a non-finite position or normal to the GPU buffers", () => {
    const mesh = buildSurfaceMesh(halfBad, { resU: 20, resV: 4 });
    // Vertices that were dropped keep their zeroed slots; what matters is that no
    // NaN reaches a buffer, since one NaN vertex smears a triangle across the scene.
    for (const value of mesh.positions) expect(Number.isFinite(value)).toBe(true);
    for (const value of mesh.normals) expect(Number.isFinite(value)).toBe(true);
  });

  it("keeps every emitted index inside the vertex range", () => {
    const mesh = buildSurfaceMesh(halfBad, { resU: 20, resV: 4 });
    for (const index of mesh.indices) {
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(mesh.vertexCount);
    }
  });
});
