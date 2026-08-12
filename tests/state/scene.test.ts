import { describe, expect, it } from "vitest";
import { createDocument } from "../../src/state/graph.ts";
import { buildScene, type DomainRange } from "../../src/state/scene.ts";
import type { RowId } from "../../src/state/graph.ts";

const closeRel = (a: number, b: number, rel = 1e-6) =>
  expect(Math.abs(a - b)).toBeLessThan(rel * Math.max(1, Math.abs(a), Math.abs(b)));

function sceneOf(
  sources: readonly string[],
  parameters: Record<string, number> = {},
  domains: Map<RowId, DomainRange[]> = new Map(),
) {
  const document = createDocument(sources);
  const items = [...document.resolution().items.values()];
  const scene = buildScene({
    items,
    parameters: new Map(Object.entries(parameters)),
    domains,
    resolution: 24,
  });
  return { document, scene };
}

describe("buildScene", () => {
  it("draws the starter torus with the curvature of a torus", () => {
    const { scene } = sceneOf([
      "R = 2",
      "r = 0.6",
      "X(u,v) = ((R + r cos u) cos v, (R + r cos u) sin v, r sin u)",
    ]);

    expect(scene.mesh).not.toBeNull();
    expect(scene.mesh!.triangleCount).toBe(24 * 24 * 2);
    expect(scene.mesh!.droppedTriangles).toBe(0);

    // K = cos u / (r(R + r cos u)) — the values were baked per vertex, so spot-check them
    // straight out of the buffer the GPU would receive.
    const R = 2;
    const r = 0.6;
    for (let k = 0; k < scene.mesh!.vertexCount; k += 29) {
      const u = scene.mesh!.chart[k * 2]!;
      closeRel(scene.mesh!.curvature[k]!, Math.cos(u) / (r * (R + r * Math.cos(u))), 1e-5);
    }
  });

  it("frames a bounding sphere around the whole scene", () => {
    const { scene } = sceneOf([
      "R = 2",
      "r = 0.6",
      "X(u,v) = ((R + r cos u) cos v, (R + r cos u) sin v, r sin u)",
    ]);
    expect(scene.bounds).not.toBeNull();
    // Outermost points sit at R + r from the axis.
    closeRel(scene.bounds!.radius, 2.6, 1e-3);
  });

  it("uses slider values for undefined symbols", () => {
    // This is the auto-slider path end to end: `a` is never declared, so it becomes a free
    // parameter and its value arrives as a compiled slot rather than a baked constant.
    const document = createDocument(["X(u,v) = (a u, v, 0)"]);
    expect(document.resolution().freeParameters).toEqual(["a"]);

    const items = [...document.resolution().items.values()];
    const domains = new Map<RowId, DomainRange[]>([
      [items[0]!.rowId, [{ min: 0, max: 1 }, { min: 0, max: 1 }]],
    ]);

    const wide = buildScene({
      items,
      parameters: new Map([["a", 3]]),
      domains,
      resolution: 8,
    });
    const narrow = buildScene({
      items,
      parameters: new Map([["a", 1]]),
      domains,
      resolution: 8,
    });

    // x = a·u, so tripling `a` triples the extent in x.
    const spanOf = (mesh: NonNullable<typeof wide.mesh>) => {
      let min = Infinity;
      let max = -Infinity;
      for (let i = 0; i < mesh.vertexCount; i++) {
        const x = mesh.positions[i * 3]!;
        min = Math.min(min, x);
        max = Math.max(max, x);
      }
      return max - min;
    };
    closeRel(spanOf(wide.mesh!), 3 * spanOf(narrow.mesh!), 1e-5);
  });

  it("combines several surfaces into one mesh", () => {
    const { scene } = sceneOf([
      "X(u,v) = (u, v, 0)",
      "Y(u,v) = (u, v, 2)",
    ]);
    // One buffer, one draw call, indices rebased per surface.
    expect(scene.mesh!.triangleCount).toBe(2 * 24 * 24 * 2);
    for (const index of scene.mesh!.indices) {
      expect(index).toBeLessThan(scene.mesh!.vertexCount);
    }
  });

  it("shares one curvature scale across surfaces", () => {
    // Identical curvature must paint identically on different objects, so the scale is
    // computed over all of them before any is tessellated.
    const { scene } = sceneOf(["X(u,v) = (u, v, u^2)", "Y(u,v) = (u, v, 3 + u^2)"]);
    expect(scene.mesh).not.toBeNull();
    expect(scene.curvatureScale).toBeGreaterThan(0);
  });

  it("draws space curves as polylines", () => {
    const { scene } = sceneOf(["alpha(t) = (cos t, sin t, t/4)"]);
    expect(scene.mesh).toBeNull();
    expect(scene.lines).toHaveLength(1);
    const line = scene.lines[0]!.polylines[0]!;
    expect(line.count).toBeGreaterThan(100);
    for (let i = 0; i < line.count; i++) {
      if (!line.valid?.[i]) continue;
      const x = line.points[i * 3]!;
      const y = line.points[i * 3 + 1]!;
      closeRel(Math.hypot(x, y), 1, 1e-6);
    }
  });

  it("lifts a plane curve into z = 0", () => {
    const { scene } = sceneOf(["c(t) = (cos t, sin t)"]);
    const line = scene.lines[0]!.polylines[0]!;
    for (let i = 0; i < line.count; i++) {
      expect(line.points[i * 3 + 2]!).toBe(0);
    }
  });

  it("draws a graph surface as (x, y, f)", () => {
    const { scene } = sceneOf(["z = x^2 - y^2"]);
    expect(scene.mesh).not.toBeNull();
    for (let i = 0; i < scene.mesh!.vertexCount; i += 17) {
      const x = scene.mesh!.positions[i * 3]!;
      const y = scene.mesh!.positions[i * 3 + 1]!;
      const z = scene.mesh!.positions[i * 3 + 2]!;
      closeRel(z, x * x - y * y, 1e-5);
    }
  });

  it("reports curvature per row without throwing", () => {
    const { document, scene } = sceneOf(["X(u,v) = (u, v, 0)"]);
    const rowId = document.rows()[0]!.id;
    const report = scene.reports.find((r) => r.rowId === rowId);
    // A plane: K = H = 0.
    expect(report?.info).toContain("K = 0.000");
    expect(report?.error).toBeUndefined();
  });

  it("survives a row that cannot be compiled", () => {
    // A domain forcing division by zero across the whole patch must degrade to a report
    // rather than an exception escaping into the render loop.
    const { scene } = sceneOf(["X(u,v) = (1/u, v, 0)"]);
    expect(() => scene.reports).not.toThrow();
    if (scene.mesh) {
      for (const value of scene.mesh.positions) expect(Number.isFinite(value)).toBe(true);
    }
  });

  it("produces nothing for an empty document", () => {
    const { scene } = sceneOf([]);
    expect(scene.mesh).toBeNull();
    expect(scene.lines).toHaveLength(0);
    expect(scene.bounds).toBeNull();
  });

  it("ignores rows that only define building blocks", () => {
    const { scene } = sceneOf(["a = 2", "r(u) = 2 + cos u"]);
    expect(scene.mesh).toBeNull();
    expect(scene.lines).toHaveLength(0);
  });

  it("honours per-row domains", () => {
    const document = createDocument(["X(u,v) = (u, v, 0)"]);
    const items = [...document.resolution().items.values()];
    const rowId = items[0]!.rowId;
    const scene = buildScene({
      items,
      parameters: new Map(),
      domains: new Map([[rowId, [{ min: -1, max: 1 }, { min: -5, max: 5 }]]]),
      resolution: 8,
    });
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < scene.mesh!.vertexCount; i++) {
      maxX = Math.max(maxX, scene.mesh!.positions[i * 3]!);
      maxY = Math.max(maxY, scene.mesh!.positions[i * 3 + 1]!);
    }
    closeRel(maxX, 1, 1e-6);
    closeRel(maxY, 5, 1e-6);
  });
});
