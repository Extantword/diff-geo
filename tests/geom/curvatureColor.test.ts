import { describe, expect, it } from "vitest";
import {
  buildSurface,
  CATALOG_BY_ID,
  paramsWith,
} from "../../src/core/catalog/surfaces.ts";
import {
  divergingColor,
  INVALID_COLOR,
  robustScale,
  sampleCurvatureRange,
} from "../../src/core/geom/curvatureColor.ts";
import { tessellate } from "../../src/core/mesh/tessellate.ts";

const closeRel = (a: number, b: number, rel = 1e-9) =>
  expect(Math.abs(a - b)).toBeLessThan(rel * Math.max(1, Math.abs(a), Math.abs(b)));

describe("robustScale", () => {
  it("is not dominated by a single outlier", () => {
    // The regression test for the bug inherited from ManifoldSandbox: using max() here
    // means one sample near a chart singularity sets the scale to 1e12 and the whole
    // surface paints uniform grey.
    const ordinary = Array.from({ length: 200 }, (_, i) => 0.5 + i / 400);
    const withSpike = [...ordinary, 1e12];

    const scale = robustScale(withSpike);
    expect(scale).toBeLessThan(2);
    expect(scale).toBeGreaterThan(0.5);
    // And it barely moved compared to the clean data.
    expect(Math.abs(scale - robustScale(ordinary))).toBeLessThan(0.1);
  });

  it("ignores non-finite values", () => {
    expect(robustScale([1, 2, NaN, Infinity, -Infinity, 3])).toBeGreaterThan(0);
    expect(Number.isFinite(robustScale([NaN, Infinity]))).toBe(true);
  });

  it("never returns zero, so division by the scale is safe", () => {
    expect(robustScale([])).toBeGreaterThan(0);
    expect(robustScale([0, 0, 0])).toBeGreaterThan(0);
  });

  it("recovers the maximum when asked for quantile 1", () => {
    expect(robustScale([1, 2, 10], 1)).toBe(10);
  });
});

describe("divergingColor", () => {
  it("maps negative, zero and positive to distinct colours", () => {
    const negative = divergingColor(-1);
    const zero = divergingColor(0);
    const positive = divergingColor(1);
    // Blue for K < 0, red for K > 0.
    expect(negative[2]).toBeGreaterThan(negative[0]);
    expect(positive[0]).toBeGreaterThan(positive[2]);
    // Near-white at zero.
    expect(Math.min(...zero)).toBeGreaterThan(0.85);
  });

  it("saturates rather than extrapolating past the ends", () => {
    expect(divergingColor(50)).toEqual(divergingColor(1));
    expect(divergingColor(-50)).toEqual(divergingColor(-1));
  });

  it("marks non-finite input as invalid rather than flat", () => {
    // "undefined" and "flat" are completely different facts about a surface.
    expect(divergingColor(NaN)).toEqual(INVALID_COLOR);
    expect(divergingColor(NaN)).not.toEqual(divergingColor(0));
  });
});

describe("sampleCurvatureRange", () => {
  it("brackets the known curvature of a sphere", () => {
    const spec = CATALOG_BY_ID["sphere"]!;
    const { surface } = buildSurface(spec);
    const range = sampleCurvatureRange(surface, paramsWith(spec, { R: 2 }));
    closeRel(range.minK, 0.25, 1e-6);
    closeRel(range.maxK, 0.25, 1e-6);
    closeRel(range.scale, 0.25, 1e-6);
  });

  it("reports the fraction of samples with no tangent plane", () => {
    const spec = CATALOG_BY_ID["sphere"]!;
    const { surface } = buildSurface(spec);
    const range = sampleCurvatureRange(surface, paramsWith(spec, {}));
    // The sphere's chart is inset off both poles, so nothing should be degenerate.
    expect(range.invalidFraction).toBe(0);
  });
});

describe("tessellate", () => {
  const spec = CATALOG_BY_ID["torus"]!;
  const { surface } = buildSurface(spec);
  const params = paramsWith(spec, { R: 2, r: 0.7 });
  const mesh = tessellate(surface, params, { resU: 32, resV: 40 });

  it("produces a complete mesh with analytic normals", () => {
    expect(mesh.vertexCount).toBe(33 * 41);
    expect(mesh.triangleCount).toBe(32 * 40 * 2);
    expect(mesh.droppedTriangles).toBe(0);
    for (let k = 0; k < mesh.vertexCount; k++) {
      const length = Math.hypot(
        mesh.normals[k * 3]!,
        mesh.normals[k * 3 + 1]!,
        mesh.normals[k * 3 + 2]!,
      );
      closeRel(length, 1, 1e-5);
    }
  });

  it("bakes curvature matching the closed form", () => {
    const R = 2;
    const r = 0.7;
    for (let k = 0; k < mesh.vertexCount; k += 37) {
      const u = mesh.chart[k * 2]!;
      const expected = Math.cos(u) / (r * (R + r * Math.cos(u)));
      closeRel(mesh.curvature[k]!, expected, 1e-6);
    }
  });

  it("welds shading across both periodic seams", () => {
    const stride = 41;
    for (let j = 0; j <= 40; j++) {
      const first = 0 * stride + j;
      const last = 32 * stride + j;
      for (let c = 0; c < 3; c++) {
        expect(mesh.normals[first * 3 + c]!).toBe(mesh.normals[last * 3 + c]!);
        expect(mesh.colors[first * 3 + c]!).toBe(mesh.colors[last * 3 + c]!);
      }
    }
  });

  it("emits no non-finite value into any GPU buffer", () => {
    // A single NaN vertex smears a triangle across the whole scene.
    for (const value of mesh.positions) expect(Number.isFinite(value)).toBe(true);
    for (const value of mesh.normals) expect(Number.isFinite(value)).toBe(true);
    for (const value of mesh.colors) expect(Number.isFinite(value)).toBe(true);
    for (const value of mesh.chart) expect(Number.isFinite(value)).toBe(true);
  });

  it("keeps every index inside the vertex range", () => {
    for (const index of mesh.indices) {
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(mesh.vertexCount);
    }
  });

  it("drops triangles at a chart pole rather than shading it wrongly", () => {
    // Force the sphere's domain right onto the poles by removing the inset.
    const sphereSpec = CATALOG_BY_ID["sphere"]!;
    const bare = { ...sphereSpec, u: { ...sphereSpec.u, inset: 0 } };
    const built = buildSurface(bare);
    const polar = tessellate(built.surface, paramsWith(bare, {}), { resU: 16, resV: 16 });
    expect(polar.droppedVertices).toBeGreaterThan(0);
    expect(polar.droppedTriangles).toBeGreaterThan(0);
    // The rest of the sphere still renders.
    expect(polar.triangleCount).toBeGreaterThan(0);
    for (const value of polar.normals) expect(Number.isFinite(value)).toBe(true);
  });
});
