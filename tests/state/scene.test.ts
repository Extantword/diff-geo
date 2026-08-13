import { describe, expect, it } from "vitest";
import { createDocument } from "../../src/state/graph.ts";
import { buildScene, type DomainRange, type FrameRequest } from "../../src/state/scene.ts";
import type { RowId } from "../../src/state/graph.ts";

const closeRel = (a: number, b: number, rel = 1e-6) =>
  expect(Math.abs(a - b)).toBeLessThan(rel * Math.max(1, Math.abs(a), Math.abs(b)));

function sceneOf(
  sources: readonly string[],
  parameters: Record<string, number> = {},
  domains: Map<RowId, DomainRange[]> = new Map(),
  frames: Map<RowId, FrameRequest> = new Map(),
) {
  const document = createDocument(sources);
  const resolved = document.resolution();
  const items = [...resolved.items.values()];
  const scene = buildScene({
    items,
    parameters: new Map(Object.entries(parameters)),
    // Numeric rows compile to slots, so their declared values have to be supplied.
    declaredParameters: resolved.declaredParameters,
    domains,
    resolution: 24,
    frames,
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
    expect(report?.info.join(" ")).toContain("K = 0.000");
    expect(report?.errors ?? []).toEqual([]);
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

describe("the moving frame", () => {
  it("is absent until a row asks for it", () => {
    const { scene } = sceneOf(["alpha(t) = (cos t, sin t, t/4)"]);
    expect(scene.lines).toHaveLength(1);
  });

  it("adds T, N and B on a regular curve", () => {
    const document = createDocument(["alpha(t) = (cos t, sin t, t/4)"]);
    const items = [...document.resolution().items.values()];
    const scene = buildScene({
      items,
      parameters: new Map(),
      domains: new Map(),
      resolution: 8,
      frames: new Map([[items[0]!.rowId, { show: true, at: 0.5 }]]),
    });
    // The curve, plus one group holding three glyph segments.
    expect(scene.lines).toHaveLength(2);
    expect(scene.lines[1]!.polylines).toHaveLength(3);
    const report = scene.reports.find((r) => r.rowId === items[0]!.rowId);
    expect(report?.info.join(" ")).toMatch(/κ = /);
    expect(report?.info.join(" ")).toMatch(/τ = /);
  });

  it("draws only T on a straight line, refusing to invent N and B", () => {
    // The visible half of the degeneracy policy: at κ = 0 the osculating plane does not
    // exist, so two of the three glyphs must be missing rather than arbitrary.
    const document = createDocument(["L(t) = (t, 2t, 3t)"]);
    const items = [...document.resolution().items.values()];
    const scene = buildScene({
      items,
      parameters: new Map(),
      domains: new Map(),
      resolution: 8,
      frames: new Map([[items[0]!.rowId, { show: true, at: 0.5 }]]),
    });
    expect(scene.lines[1]!.polylines).toHaveLength(1);
    const report = scene.reports.find((r) => r.rowId === items[0]!.rowId);
    expect(report?.info.join(" ")).toContain("N and B undefined here");
  });

  it("follows the requested position along the curve", () => {
    const document = createDocument(["alpha(t) = (cos t, sin t, 0)"]);
    const items = [...document.resolution().items.values()];
    const at = (fraction: number) => {
      const scene = buildScene({
        items,
        parameters: new Map(),
        domains: new Map(),
        resolution: 8,
        frames: new Map([[items[0]!.rowId, { show: true, at: fraction }]]),
      });
      const glyph = scene.lines[1]!.polylines[0]!;
      return [glyph.points[0]!, glyph.points[1]!] as const;
    };
    // t runs over [0, 2π], so fraction 0 sits at (1,0) and 0.25 at (0,1).
    const start = at(0);
    const quarter = at(0.25);
    closeRel(start[0], 1, 1e-6);
    expect(Math.abs(start[1])).toBeLessThan(1e-6);
    expect(Math.abs(quarter[0])).toBeLessThan(1e-6);
    closeRel(quarter[1], 1, 1e-6);
  });
  });

describe("points", () => {
  it("draws a point as a zero-length segment, which the round caps render as a disc", () => {
    const { scene } = sceneOf(["(1, 2, 3)"]);
    expect(scene.mesh).toBeNull();
    const dot = scene.lines.at(-1)!.polylines[0]!;
    expect(dot.count).toBe(2);
    // Both endpoints coincide; the fragment shader's distance-to-segment then measures
    // distance to a single position.
    expect([...dot.points]).toEqual([1, 2, 3, 1, 2, 3]);
  });

  it("evaluates a point through its sliders", () => {
    const document = createDocument(["(a, 0, 0)"]);
    const items = [...document.resolution().items.values()];
    const scene = buildScene({
      items,
      parameters: new Map([["a", 4]]),
      domains: new Map(),
      resolution: 8,
    });
    expect(scene.lines.at(-1)!.polylines[0]!.points[0]).toBe(4);
  });

  it("reports a non-finite point rather than emitting it", () => {
    const { document, scene } = sceneOf(["(1/0, 0, 0)"]);
    const report = scene.reports.find((r) => r.rowId === document.rows()[0]!.id);
    expect((report?.errors ?? []).join(" ")).toContain("not finite");
    expect(scene.lines).toHaveLength(0);
  });
  });

describe("surface overlays", () => {
  function overlayScene(sources: readonly string[], overlay: Record<string, unknown>) {
    const document = createDocument(sources);
    const resolved = document.resolution();
    const items = [...resolved.items.values()];
    const surfaceRow = items.find(
      (item) => item.kind === "parametricSurface" || item.kind === "graphSurface",
    )!;
    return {
      document,
      surfaceRow,
      scene: buildScene({
        items,
        parameters: new Map(),
        declaredParameters: resolved.declaredParameters,
        domains: new Map(),
        resolution: 40,
        overlays: new Map([[surfaceRow.rowId, overlay as never]]),
      }),
    };
  }

  it("draws nothing unless a row asks", () => {
    const { scene } = sceneOf(["X(u,v) = (u, v, u v)"]);
    expect(scene.lines).toHaveLength(0);
  });

  it("shoots a geodesic spray from the domain centre", () => {
    const { scene } = overlayScene(["X(u,v) = (u, v, 0.3 u v)"], {
      geodesics: 8,
      geodesicLength: 1,
      curvatureLines: false,
    });
    const group = scene.lines.at(-1)!;
    expect(group.polylines).toHaveLength(8);
    // Each ray is densely sampled, not a five-point polyline.
    for (const line of group.polylines) {
      expect(line.count).toBeGreaterThan(100);
      for (const value of line.points) expect(Number.isFinite(value)).toBe(true);
    }
  });

  it("reports why each ray stopped", () => {
    // A picture of a truncated geodesic is ambiguous; the reason is the diagnosis.
    const { document, scene } = overlayScene(["X(u,v) = (u, v, 0)"], {
      geodesics: 4,
      geodesicLength: 4,
      curvatureLines: false,
    });
    const report = scene.reports.find((r) => r.rowId === document.rows()[0]!.id);
    expect(report?.info.join(" ")).toContain("geodesics");
    // On a bounded plane patch a long geodesic must leave the chart.
    expect(report?.info.join(" ")).toContain("outOfDomain");
  });

  it("puts every geodesic on the surface it came from", () => {
    // The strongest check available without a picture: on a sphere every point of every ray must
    // lie at radius R, plus only the lift.
    const document = createDocument([
      "X(u,v) = (2 sin u cos v, 2 sin u sin v, 2 cos u)",
    ]);
    const resolved = document.resolution();
    const items = [...resolved.items.values()];
    const scene = buildScene({
      items,
      parameters: new Map(),
      declaredParameters: resolved.declaredParameters,
      domains: new Map([[items[0]!.rowId, [{ min: 0.2, max: 2.9 }, { min: 0, max: 6.28 }]]]),
      resolution: 40,
      overlays: new Map([
        [items[0]!.rowId, { geodesics: 6, geodesicLength: 0.5, curvatureLines: false }],
      ]),
    });

    let checked = 0;
    for (const line of scene.lines.at(-1)!.polylines) {
      for (let i = 0; i < line.count; i++) {
        if (!line.valid?.[i]) continue;
        const r = Math.hypot(line.points[i * 3]!, line.points[i * 3 + 1]!, line.points[i * 3 + 2]!);
        expect(Math.abs(r - 2)).toBeLessThan(0.05);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(200);
  });

  it("draws both lines of curvature, in both directions", () => {
    const { scene } = overlayScene(["X(u,v) = (u, v, 0.4 (u^2 - v^2))"], {
      geodesics: 0,
      geodesicLength: 1,
      curvatureLines: true,
    });
    // k1 and k2, each run forward and backward from the centre.
    expect(scene.lines.at(-1)!.polylines).toHaveLength(4);
  });

  it("refuses lines of curvature at an umbilic and says why", () => {
    // Every point of a sphere is umbilic, so the principal directions are genuinely arbitrary
    // there and drawing one would present a choice as though it meant something.
    const document = createDocument(["X(u,v) = (sin u cos v, sin u sin v, cos u)"]);
    const resolved = document.resolution();
    const items = [...resolved.items.values()];
    const scene = buildScene({
      items,
      parameters: new Map(),
      declaredParameters: resolved.declaredParameters,
      // An explicit domain, so the centre is an ordinary point rather than a pole — the pole
      // case is covered separately below.
      domains: new Map([[items[0]!.rowId, [{ min: 0.4, max: 2.2 }, { min: 0, max: 6.28 }]]]),
      resolution: 40,
      overlays: new Map([
        [items[0]!.rowId, { geodesics: 0, geodesicLength: 1, curvatureLines: true }],
      ]),
    });
    const report = scene.reports.find((r) => r.rowId === document.rows()[0]!.id);
    expect(report?.warnings.join(" ")).toContain("umbilic");
    expect(scene.lines).toHaveLength(0);
  });

  it("says so when the domain centre has no tangent plane", () => {
    // The sphere's default domain centres on u = π, which is the south pole. Checking only for
    // umbilic left this drawing nothing and reporting nothing.
    const { scene, document } = overlayScene(
      ["X(u,v) = (sin u cos v, sin u sin v, cos u)"],
      { geodesics: 4, geodesicLength: 1, curvatureLines: true },
    );
    const report = scene.reports.find((r) => r.rowId === document.rows()[0]!.id);
    expect(report?.warnings.join(" ")).toContain("no tangent plane");
  });
});

describe("picking: the mesh side", () => {
  /**
   * The pick pass itself needs a GPU, so what is verified here is everything it depends on:
   * that each vertex carries the row that owns it and the chart coordinates that belong to it,
   * and that concatenating several surfaces into one buffer keeps those two aligned.
   *
   * That alignment is the whole correctness claim of id-buffer picking. If it holds, reading a
   * pixel yields a real (row, u, v); if it silently drifts, a click on one surface reports a
   * point on another, and no amount of shader review would show it.
   */

  it("stamps every vertex with the row that owns it", () => {
    const { document, scene } = sceneOf(["X(u,v) = (u, v, 0)"]);
    const rowId = document.rows()[0]!.id;
    expect(scene.mesh!.ids).toHaveLength(scene.mesh!.vertexCount);
    for (let k = 0; k < scene.mesh!.vertexCount; k++) {
      expect(scene.mesh!.ids[k]).toBe(rowId);
    }
  });

  it("keeps ids and chart coordinates aligned across concatenation", () => {
    // Two surfaces in one buffer, deliberately given DIFFERENT parametrizations so a mix-up
    // cannot pass: reading vertex k's id, then evaluating that row's own formula at vertex k's
    // (u, v), must land back on vertex k's position.
    const { document, scene } = sceneOf([
      "X(u,v) = (u, v, 0)",
      "Y(u,v) = (2 v, u, 5)",
    ]);
    const rows = document.rows();
    const mesh = scene.mesh!;
    expect(new Set(mesh.ids)).toEqual(new Set([rows[0]!.id, rows[1]!.id]));

    for (let k = 0; k < mesh.vertexCount; k += 37) {
      const id = mesh.ids[k]!;
      const u = mesh.chart[k * 2]!;
      const v = mesh.chart[k * 2 + 1]!;
      const x = mesh.positions[k * 3]!;
      const y = mesh.positions[k * 3 + 1]!;
      const z = mesh.positions[k * 3 + 2]!;

      if (id === rows[0]!.id) {
        closeRel(x, u, 1e-5);
        closeRel(y, v, 1e-5);
        expect(z).toBeCloseTo(0, 5);
      } else {
        closeRel(x, 2 * v, 1e-5);
        closeRel(y, u, 1e-5);
        expect(z).toBeCloseTo(5, 5);
      }
    }
  });

  it("carries real (u, v), not normalized coordinates", () => {
    // The improvement over the precedent, which baked chart coords into `uv` in [0,1] and had to
    // un-normalize a hit afterwards. On a domain of [1, 3] a normalized attribute would show 0
    // and 1 at the ends.
    const document = createDocument(["X(u,v) = (u, v, 0)"]);
    const rowId = document.rows()[0]!.id;
    const scene = buildScene({
      items: [...document.resolution().items.values()],
      parameters: new Map(),
      domains: new Map([[rowId, [{ min: 1, max: 3 }, { min: -2, max: 2 }]]]),
      resolution: 8,
    });
    let minU = Infinity;
    let maxU = -Infinity;
    for (let k = 0; k < scene.mesh!.vertexCount; k++) {
      const u = scene.mesh!.chart[k * 2]!;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
    }
    closeRel(minU, 1, 1e-5);
    closeRel(maxU, 3, 1e-5);
  });
});

describe("a picked start point", () => {
  function sprayFrom(start: readonly [number, number] | undefined) {
    const document = createDocument(["X(u,v) = (u, v, 0)"]);
    const rowId = document.rows()[0]!.id;
    const scene = buildScene({
      items: [...document.resolution().items.values()],
      parameters: new Map(),
      domains: new Map([[rowId, [{ min: 0, max: 4 }, { min: 0, max: 4 }]]]),
      resolution: 16,
      overlays: new Map([
        [rowId, { geodesics: 4, geodesicLength: 0.5, curvatureLines: false, start }],
      ]),
    });
    // The plane's geodesics are straight lines, so every ray begins at the start point.
    const first = scene.lines[0]!.polylines[0]!;
    return { x: first.points[0]!, y: first.points[1]! };
  }

  it("defaults to the centre of the domain", () => {
    const { x, y } = sprayFrom(undefined);
    closeRel(x, 2, 1e-4);
    closeRel(y, 2, 1e-4);
  });

  it("moves the origin of the spray", () => {
    const { x, y } = sprayFrom([1, 3]);
    closeRel(x, 1, 1e-4);
    closeRel(y, 3, 1e-4);
  });

  it("clamps a start point outside the domain instead of producing nothing", () => {
    // A pick lands on a triangle, and the interpolated (u, v) at its edge can sit a hair past
    // the last sample row. Rejecting that would make the surface's own boundary unclickable.
    const { x, y } = sprayFrom([-10, 99]);
    closeRel(x, 0, 1e-4);
    closeRel(y, 4, 1e-4);
  });
});
