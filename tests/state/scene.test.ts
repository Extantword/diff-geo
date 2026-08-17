import { describe, expect, it } from "vitest";
import { createDocument } from "../../src/state/graph.ts";
import type { Vec3 } from "../../src/core/geom/types.ts";
import { quatFromAxisAngle, type Quat } from "../../src/core/num/quat.ts";
import {
  buildScene,
  type DomainRange,
  type FrameRequest,
  type Scene,
  type SurfaceOverlay,
} from "../../src/state/scene.ts";
import { divergingColor } from "../../src/core/geom/curvatureColor.ts";
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

describe("a colour scale per surface", () => {
  /** A sphere on a domain that avoids both poles, so no vertex is degenerate. */
  const sphere = (radius: string, name: string) =>
    `${name}(u,v) = (${radius} sin u cos v, ${radius} sin u sin v, ${radius} cos u)`;

  function scene(sources: readonly string[], chartRow: number | null = null) {
    const document = createDocument(sources);
    const rows = document.rows();
    const domains = new Map<RowId, DomainRange[]>(
      rows.map((row) => [row.id, [{ min: 0.3, max: 2.8 }, { min: 0, max: 6.28 }]]),
    );
    return {
      rows,
      scene: buildScene({
        items: [...document.resolution().items.values()],
        parameters: new Map(),
        domains,
        resolution: 16,
        chartRow,
      }),
    };
  }

  it("leaves a surface's colours alone when a more curved one joins the scene", () => {
    /**
     * Pooled across the scene, one object decides how every other one looks: a sphere of radius
     * 0.2 has K = 25, which drives the shared scale up 25-fold and leaves the unit sphere beside
     * it a uniform grey — indistinguishable from a plane, which reads as a rendering failure
     * rather than as a comparison.
     *
     * The trade this makes is real and is why it was the other way round first: identical colours
     * on two surfaces no longer mean identical curvature. That is paid for by the legend, which
     * labels the scale of the patch you have selected rather than one number for the scene.
     */
    const alone = scene([sphere("1", "A")]).scene;
    const together = scene([sphere("1", "A"), sphere("0.2", "B")]).scene;

    const neutral: [number, number, number] = [0, 0, 0];
    divergingColor(0, neutral);
    const distanceToNeutral = (mesh: NonNullable<typeof alone.mesh>) =>
      Math.hypot(
        mesh.colors[0]! - neutral[0],
        mesh.colors[1]! - neutral[1],
        mesh.colors[2]! - neutral[2],
      );

    // Vertex 0 belongs to the unit sphere in both scenes, and is painted the same either way.
    expect(distanceToNeutral(together.mesh!)).toBeCloseTo(distanceToNeutral(alone.mesh!), 6);
  });

  it("reports the scale each patch is painted through", () => {
    const { rows, scene: built } = scene([sphere("1", "A"), sphere("0.2", "B")]);
    // K = 1/R²: 1 for the unit sphere, 25 for the small one.
    expect(built.curvatureScales.get(rows[0]!.id)).toBeCloseTo(1, 3);
    expect(built.curvatureScales.get(rows[1]!.id)).toBeCloseTo(25, 1);
  });

  it("labels the legend with the selected patch's scale", () => {
    // Otherwise the legend states a number that nothing on screen is drawn through.
    const { rows, scene: first } = scene([sphere("1", "A"), sphere("0.2", "B")]);
    expect(first.curvatureScale).toBeCloseTo(1, 3);
    const second = scene([sphere("1", "A"), sphere("0.2", "B")], rows[1]!.id).scene;
    expect(second.curvatureScale).toBeCloseTo(25, 1);
  });

  it("gives both surfaces the same colour where their curvature agrees", () => {
    // Two unit spheres: same K and the same scale, so the same colour, whichever buffer half a
    // vertex lands in.
    const both = scene([sphere("1", "A"), sphere("1", "B")]).scene;
    const mesh = both.mesh!;
    const half = mesh.vertexCount / 2;
    for (let k = 0; k < 3; k++) {
      expect(mesh.colors[k]).toBeCloseTo(mesh.colors[half * 3 + k]!, 6);
    }
  });
});

describe("geodesics across a chart seam", () => {
  /**
   * The bug this pins: a sphere's v runs 0 → 2π and closes up, so a geodesic crossing that seam
   * has gone around rather than left the surface. The integrator always knew how to wrap — it
   * checks `surface.periodicV` — but nothing set the flag for a compiled row, so every great
   * circle stopped dead at the seam. Loading the sphere TEMPLATE did not help: a template is
   * inserted as source text, so its declared periodicity never reached the surface.
   */
  function sphereSpray(start: readonly [number, number]) {
    const document = createDocument([
      "X(u,v) = (sin u cos v, sin u sin v, cos u)",
    ]);
    const rowId = document.rows()[0]!.id;
    const scene = buildScene({
      items: [...document.resolution().items.values()],
      parameters: new Map(),
      domains: new Map([
        [rowId, [{ min: 0.01, max: Math.PI - 0.01 }, { min: 0, max: 2 * Math.PI }]],
      ]),
      resolution: 32,
      overlays: new Map([
        [rowId, { geodesics: 6, geodesicLength: 1.5, curvatureLines: false, start }],
      ]),
    });
    const lengths = (scene.lines[0]?.polylines ?? []).map((p) => {
      let total = 0;
      for (let k = 1; k < p.count; k++) {
        total += Math.hypot(
          p.points[k * 3]! - p.points[(k - 1) * 3]!,
          p.points[k * 3 + 1]! - p.points[(k - 1) * 3 + 1]!,
          p.points[k * 3 + 2]! - p.points[(k - 1) * 3 + 2]!,
        );
      }
      return total;
    });
    return { scene, lengths };
  }

  it("runs every ray to full length from a point on the seam", () => {
    // v = 0 IS the seam. Before periodicity was detected, the two rays heading across it were
    // dropped entirely and the spray came back with four arms instead of six.
    const { lengths } = sphereSpray([Math.PI / 2, 0]);
    expect(lengths).toHaveLength(6);
    for (const length of lengths) expect(length).toBeGreaterThan(1.4);
  });

  it("gives the same spray on either side of the seam", () => {
    // The seam is not a place on the surface, so shooting from v = 0 and from v = 2π must be
    // indistinguishable. This is the invariant the flag exists to preserve.
    const near = sphereSpray([Math.PI / 2, 0.0]).lengths.slice().sort();
    const far = sphereSpray([Math.PI / 2, 2 * Math.PI]).lengths.slice().sort();
    expect(near).toHaveLength(far.length);
    for (const [i, value] of near.entries()) expect(value).toBeCloseTo(far[i]!, 6);
  });

  it("completes every ray of a spray shot from right beside a pole", () => {
    /**
     * u = 0.02 is a hair from the north pole, so before poles were recognised the ray heading
     * that way was cut off within 0.02 of arc and the spray came back visibly lopsided. A pole is
     * not an edge of the surface — the boundary collapses to a point and the parametrization runs
     * through it — so every ray should now reach its requested length.
     */
    const { scene, lengths } = sphereSpray([0.02, Math.PI]);
    expect(lengths).toHaveLength(6);
    for (const length of lengths) expect(length).toBeGreaterThan(1.4);
    expect(scene.reports.flatMap((r) => r.info).join(" ")).toContain("6 length");
  });

  it("keeps every point of a wrapped geodesic on the sphere", () => {
    // Wrapping must continue the curve, not teleport it. Every point still at radius 1 is the
    // check that a ray crossing the seam stayed on the surface the whole way.
    const { scene } = sphereSpray([Math.PI / 2, 0]);
    for (const polyline of scene.lines[0]!.polylines) {
      for (let k = 0; k < polyline.count; k++) {
        const r = Math.hypot(
          polyline.points[k * 3]!,
          polyline.points[k * 3 + 1]!,
          polyline.points[k * 3 + 2]!,
        );
        // The overlay lift holds the curve just off the surface, hence the loose tolerance.
        expect(Math.abs(r - 1)).toBeLessThan(0.02);
      }
    }
  });
});

describe("extending geodesics over the whole surface", () => {
  function sprayScene(
    source: string,
    u: DomainRange,
    v: DomainRange,
    start: readonly [number, number],
    direction: { geodesics: number; geodesicLength: number },
  ) {
    const document = createDocument([source]);
    const rowId = document.rows()[0]!.id;
    const scene = buildScene({
      items: [...document.resolution().items.values()],
      parameters: new Map(),
      domains: new Map([[rowId, [u, v]]]),
      resolution: 32,
      overlays: new Map([[rowId, { ...direction, curvatureLines: false, start }]]),
    });
    const polylines = scene.lines[0]?.polylines ?? [];
    return {
      scene,
      polylines,
      points: polylines.reduce((n, p) => n + p.count, 0),
      info: scene.reports.flatMap((r) => r.info).join(" "),
    };
  }

  const SPHERE = "X(u,v) = (sin u cos v, sin u sin v, cos u)";
  const sphereU: DomainRange = { min: 0.002, max: Math.PI - 0.002 };
  const sphereV: DomainRange = { min: 0, max: 2 * Math.PI };

  it("carries a meridian past the pole instead of stopping short of it", () => {
    /**
     * The sphere's u = 0 is not an edge: the whole boundary collapses to one point and the
     * parametrization runs straight through, X(-u, v) landing back on the same sphere. A meridian
     * reaching it has left nothing, so stopping there shows the user an invisible wall.
     *
     * Evidence of the crossing is a point at the pole itself — |z| = R, which no geodesic confined
     * to the open chart can reach.
     */
    const { polylines } = sprayScene(SPHERE, sphereU, sphereV, [Math.PI / 2, 1], {
      geodesics: 4,
      geodesicLength: 8,
    });
    let maxAbsZ = 0;
    for (const p of polylines) {
      for (let k = 0; k < p.count; k++) maxAbsZ = Math.max(maxAbsZ, Math.abs(p.points[k * 3 + 2]!));
    }
    // The overlay lift puts the curve just outside the unit sphere, hence 0.999 rather than 1.
    expect(maxAbsZ).toBeGreaterThan(0.999);

    /**
     * Reaching the pole is not the same as passing it, and only the arc length distinguishes them.
     * A meridian confined to the chart covers at most π/2 from the equator before it runs out;
     * getting past that means it went through.
     */
    const longest = Math.max(
      ...polylines.map((p) => {
        let total = 0;
        for (let k = 1; k < p.count; k++) {
          total += Math.hypot(
            p.points[k * 3]! - p.points[(k - 1) * 3]!,
            p.points[k * 3 + 1]! - p.points[(k - 1) * 3 + 1]!,
            p.points[k * 3 + 2]! - p.points[(k - 1) * 3 + 2]!,
          );
        }
        return total;
      }),
    );
    expect(longest).toBeGreaterThan(Math.PI);
  });

  it("keeps a geodesic on the surface after it crosses a pole", () => {
    // Crossing must CONTINUE the curve, not teleport it. Every point still at radius 1 is the
    // check that the continuation past u = 0 landed back on the same sphere.
    const { polylines } = sprayScene(SPHERE, sphereU, sphereV, [Math.PI / 2, 1], {
      geodesics: 4,
      geodesicLength: 8,
    });
    for (const p of polylines) {
      for (let k = 0; k < p.count; k++) {
        const r = Math.hypot(p.points[k * 3]!, p.points[k * 3 + 1]!, p.points[k * 3 + 2]!);
        expect(Math.abs(r - 1)).toBeLessThan(0.02);
      }
    }
  });

  it("still stops a geodesic at a cylinder's rim, which is a real edge", () => {
    /**
     * The rule must not over-reach. A cylinder's u boundary is regular — the surface genuinely
     * ends — so extending past it would run the curve off the drawn shape into the analytic
     * continuation of the formula. This is the test that keeps pole-crossing from becoming
     * "never stop anywhere".
     */
    const { polylines, info } = sprayScene(
      "X(u,v) = (cos v, sin v, u)",
      { min: 0, max: 2 },
      { min: 0, max: 2 * Math.PI },
      [1, 1],
      { geodesics: 4, geodesicLength: 20 },
    );
    expect(info).toContain("outOfDomain");
    for (const p of polylines) {
      for (let k = 0; k < p.count; k++) {
        const z = p.points[k * 3 + 2]!;
        // Slightly outside [0, 2] is the last accepted step overshooting; far outside would mean
        // the geodesic escaped up the infinite cylinder.
        expect(z).toBeGreaterThan(-0.3);
        expect(z).toBeLessThan(2.3);
      }
    }
  });

  /**
   * Density is measured on a TORUS, not a sphere.
   *
   * A torus is periodic in both coordinates and has no poles, so a geodesic runs as far as it is
   * asked to and nothing else can truncate it. On a sphere the single ray of a one-ray spray leaves
   * along u — a meridian, straight at a pole — so the measurement would be of pole handling rather
   * than of sampling density.
   */
  const TORUS = "X(u,v) = ((2 + cos u) cos v, (2 + cos u) sin v, sin u)";
  const full: DomainRange = { min: 0, max: 2 * Math.PI };

  it("samples a long geodesic as densely per unit arc as a short one", () => {
    /**
     * The faceting bug. `minSamples` divides the REQUESTED length, so it pins a sample count and
     * lets the spacing grow without limit: a geodesic wrapping the surface nine times came back
     * with the same 242 points as one crossing it once, and was drawn as a visible polygon.
     */
    const short = sprayScene(TORUS, full, full, [1, 1], {
      geodesics: 1,
      geodesicLength: 2,
    });
    const long = sprayScene(TORUS, full, full, [1, 1], {
      geodesics: 1,
      geodesicLength: 20,
    });
    expect(long.points / 20).toBeGreaterThan((short.points / 2) * 0.8);
  });

  it("draws a long geodesic smoothly enough that its chords recover its arc length", () => {
    // The measurable form of "not faceted": summing the drawn chords must reproduce the true arc
    // length. A coarse polygon inscribed in a circle visibly falls short — at length 60 the old
    // fixed sample count lost 0.26% of the arc, which is the faceting made numeric.
    const { polylines } = sprayScene(TORUS, full, full, [1, 1], {
      geodesics: 1,
      geodesicLength: 20,
    });
    const p = polylines[0]!;
    let chords = 0;
    for (let k = 1; k < p.count; k++) {
      chords += Math.hypot(
        p.points[k * 3]! - p.points[(k - 1) * 3]!,
        p.points[k * 3 + 1]! - p.points[(k - 1) * 3 + 1]!,
        p.points[k * 3 + 2]! - p.points[(k - 1) * 3 + 2]!,
      );
    }
    expect(chords).toBeGreaterThan(20 * 0.999);
  });

  it("holds the whole spray under a segment budget at extreme settings", () => {
    // Density is bounded twice: once for smoothness, once so turning both the length and the ray
    // count up cannot freeze the UI. Without the second, this costs 89k points and ~0.9s.
    const { points } = sprayScene(SPHERE, sphereU, sphereV, [Math.PI / 2, 1], {
      geodesics: 24,
      geodesicLength: 40,
    });
    expect(points).toBeLessThan(40000);
  });
});

describe("the Gauss map beside the surface", () => {
  function gaussScene(source: string, u: DomainRange, v: DomainRange) {
    const document = createDocument([source]);
    const rowId = document.rows()[0]!.id;
    const withMap = (gaussMap: boolean) =>
      buildScene({
        items: [...document.resolution().items.values()],
        parameters: new Map(),
        domains: new Map([[rowId, [u, v]]]),
        resolution: 40,
        overlays: new Map([
          [rowId, { geodesics: 0, geodesicLength: 1, curvatureLines: false, gaussMap }],
        ]),
      });
    return { off: withMap(false), on: withMap(true), rowId };
  }

  const SPHERE = "X(u,v) = (sin u cos v, sin u sin v, cos u)";
  const sphereU: DomainRange = { min: 0.01, max: Math.PI - 0.01 };
  const sphereV: DomainRange = { min: 0, max: 2 * Math.PI };

  it("adds a second body to the scene only when asked", () => {
    const { off, on } = gaussScene(SPHERE, sphereU, sphereV);
    expect(on.mesh!.vertexCount).toBeGreaterThan(off.mesh!.vertexCount);
    // Same source mesh twice over, so exactly double.
    expect(on.mesh!.vertexCount).toBe(off.mesh!.vertexCount * 2);
  });

  it("places the image clear of the surface rather than inside it", () => {
    /**
     * The whole point of drawing it beside rather than in its own viewport is that one camera frames
     * both, so the two must not overlap. Checked as a gap in x between the surface's vertices and
     * the image's.
     */
    const { off, on } = gaussScene(SPHERE, sphereU, sphereV);
    const half = off.mesh!.vertexCount;
    let surfaceMaxX = -Infinity;
    for (let k = 0; k < half; k++) {
      surfaceMaxX = Math.max(surfaceMaxX, on.mesh!.positions[k * 3]!);
    }
    let imageMinX = Infinity;
    for (let k = half; k < on.mesh!.vertexCount; k++) {
      const x = on.mesh!.positions[k * 3]!;
      const y = on.mesh!.positions[k * 3 + 1]!;
      const z = on.mesh!.positions[k * 3 + 2]!;
      // Degenerate vertices carry no normal and sit at the sphere's centre; they are unreferenced.
      if (x === 0 && y === 0 && z === 0) continue;
      imageMinX = Math.min(imageMinX, x);
    }
    expect(imageMinX).toBeGreaterThan(surfaceMaxX);
  });

  it("reports the image's area, which is the total curvature", () => {
    // ∫|K| dA = 4π for a sphere, so the readout is a statement the user can check against the
    // theorem rather than an unlabelled number.
    const { on } = gaussScene(SPHERE, sphereU, sphereV);
    const info = on.reports.flatMap((r) => r.info).join(" ");
    expect(info).toContain("Gauss image area");
    const match = /Gauss image area ([0-9.]+)/.exec(info);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeCloseTo(4 * Math.PI, 0);
  });

  it("names the source row on the image's vertices, so a click on it reports the preimage", () => {
    /**
     * A happy consequence of sharing the source's id and chart arrays: picking on the Gauss sphere
     * comes back with the row and the (u, v) whose normal lands there. Clicking the image is
     * therefore a way to ask "which point of the surface points this way".
     */
    const { off, on, rowId } = gaussScene(SPHERE, sphereU, sphereV);
    for (let k = off.mesh!.vertexCount; k < on.mesh!.vertexCount; k++) {
      expect(on.mesh!.ids[k]).toBe(rowId);
    }
  });

  it("flattens a cylinder's image to a circle", () => {
    // K = 0 means the image has no area. Visible directly: every image vertex shares one z.
    const { off, on } = gaussScene(
      "X(u,v) = (cos v, sin v, u)",
      { min: 0, max: 2 },
      { min: 0, max: 2 * Math.PI },
    );
    const half = off.mesh!.vertexCount;
    const zs: number[] = [];
    for (let k = half; k < on.mesh!.vertexCount; k++) {
      const x = on.mesh!.positions[k * 3]!;
      const y = on.mesh!.positions[k * 3 + 1]!;
      const z = on.mesh!.positions[k * 3 + 2]!;
      if (x === 0 && y === 0 && z === 0) continue;
      zs.push(z);
    }
    expect(zs.length).toBeGreaterThan(100);
    expect(Math.max(...zs) - Math.min(...zs)).toBeLessThan(1e-4);
  });
});

describe("arranging objects in space", () => {
  /**
   * A translation is ARRANGEMENT, not geometry. The whole reason it is applied to the drawn
   * positions rather than folded into the map is that every curvature is a derivative of X, and a
   * constant offset differentiates away — so moving a surface must leave K, H and the principal
   * directions untouched. That is the property worth testing; where the vertices land is the easy
   * half.
   */
  function turned(rotation: Quat | null) {
    const document = createDocument(["X(u,v) = (sin u cos v, sin u sin v, cos u)"]);
    const rowId = document.rows()[0]!.id;
    return buildScene({
      items: [...document.resolution().items.values()],
      parameters: new Map(),
      domains: new Map([
        [rowId, [{ min: 0.01, max: Math.PI - 0.01 }, { min: 0, max: 2 * Math.PI }]],
      ]),
      resolution: 32,
      rotations: rotation ? new Map([[rowId, rotation]]) : undefined,
      overlays: new Map([
        [rowId, { geodesics: 4, geodesicLength: 1, curvatureLines: false }],
      ]),
    });
  }

  it("turns an object without changing a single curvature", () => {
    /**
     * The justification for applying arrangement to the drawn mesh rather than folding it into
     * the map: a rotation is an isometry, so every derivative keeps its length and every pair its
     * angle — and K and H are built from exactly those. A rotated unit sphere still has K = 1.
     */
    const still = turned(null);
    const spun = turned(quatFromAxisAngle([0.3, 1, -0.5], 1.1));
    for (let k = 0; k < still.mesh!.vertexCount; k += 53) {
      expect(spun.mesh!.curvature[k]!).toBeCloseTo(still.mesh!.curvature[k]!, 12);
    }
  });

  it("keeps a rotated sphere a sphere, with unit normals", () => {
    // Positions move but the shape does not: every vertex is still at radius 1 from the centre,
    // and every normal is still unit — which is what the shader's degenerate test relies on.
    const spun = turned(quatFromAxisAngle([1, 0.2, 0.4], 2.3));
    for (let k = 0; k < spun.mesh!.vertexCount; k += 37) {
      const r = Math.hypot(
        spun.mesh!.positions[k * 3]!,
        spun.mesh!.positions[k * 3 + 1]!,
        spun.mesh!.positions[k * 3 + 2]!,
      );
      expect(r).toBeCloseTo(1, 4);
      const n = Math.hypot(
        spun.mesh!.normals[k * 3]!,
        spun.mesh!.normals[k * 3 + 1]!,
        spun.mesh!.normals[k * 3 + 2]!,
      );
      // Zero marks a degenerate vertex and must stay exactly zero rather than being normalised.
      expect(n === 0 || Math.abs(n - 1) < 1e-4).toBe(true);
    }
  });

  it("carries an object's curves through the rotation with it", () => {
    // A surface that turned while its geodesics stayed behind would be worse than one that did
    // not turn at all.
    const spun = turned(quatFromAxisAngle([0, 1, 0], 0.9));
    for (const polyline of spun.lines[0]!.polylines) {
      for (let k = 0; k < polyline.count; k += 17) {
        const r = Math.hypot(
          polyline.points[k * 3]!,
          polyline.points[k * 3 + 1]!,
          polyline.points[k * 3 + 2]!,
        );
        // Still on the sphere, allowing for the overlay lift.
        expect(Math.abs(r - 1)).toBeLessThan(0.02);
      }
    }
  });

  function placed(offset: readonly [number, number, number] | null) {
    const document = createDocument(["X(u,v) = (sin u cos v, sin u sin v, cos u)"]);
    const rowId = document.rows()[0]!.id;
    return buildScene({
      items: [...document.resolution().items.values()],
      parameters: new Map(),
      domains: new Map([
        [rowId, [{ min: 0.01, max: Math.PI - 0.01 }, { min: 0, max: 2 * Math.PI }]],
      ]),
      resolution: 32,
      translations: offset ? new Map([[rowId, [...offset] as Vec3]]) : undefined,
      overlays: new Map([
        [rowId, { geodesics: 4, geodesicLength: 1, curvatureLines: false }],
      ]),
    });
  }

  it("moves every vertex by the offset and nothing else", () => {
    const here = placed(null);
    const there = placed([10, -3, 4]);
    expect(there.mesh!.vertexCount).toBe(here.mesh!.vertexCount);
    for (let k = 0; k < here.mesh!.vertexCount; k += 37) {
      expect(there.mesh!.positions[k * 3]! - here.mesh!.positions[k * 3]!).toBeCloseTo(10, 4);
      expect(there.mesh!.positions[k * 3 + 1]! - here.mesh!.positions[k * 3 + 1]!).toBeCloseTo(-3, 4);
      expect(there.mesh!.positions[k * 3 + 2]! - here.mesh!.positions[k * 3 + 2]!).toBeCloseTo(4, 4);
    }
  });

  it("leaves the curvature identical", () => {
    // The claim that makes this safe: a unit sphere still has K = 1 wherever you put it.
    const here = placed(null);
    const there = placed([10, -3, 4]);
    for (let k = 0; k < here.mesh!.vertexCount; k += 53) {
      expect(there.mesh!.curvature[k]!).toBeCloseTo(here.mesh!.curvature[k]!, 12);
    }
    expect(there.curvatureScale).toBeCloseTo(here.curvatureScale, 12);
  });

  it("carries the object's curves along with it", () => {
    // Geodesics, lines of curvature and frame glyphs all belong to the object; a surface that
    // moved while its geodesics stayed behind would be worse than one that did not move at all.
    const here = placed(null);
    const there = placed([10, -3, 4]);
    const first = (scene: typeof here) => scene.lines[0]!.polylines[0]!;
    expect(first(there).points[0]! - first(here).points[0]!).toBeCloseTo(10, 4);
    expect(first(there).points[1]! - first(here).points[1]!).toBeCloseTo(-3, 4);
    expect(first(there).points[2]! - first(here).points[2]!).toBeCloseTo(4, 4);
  });

  it("moves the bounding sphere so the camera still frames it", () => {
    const here = placed(null);
    const there = placed([10, -3, 4]);
    expect(there.bounds!.center[0] - here.bounds!.center[0]).toBeCloseTo(10, 3);
    expect(there.bounds!.radius).toBeCloseTo(here.bounds!.radius, 3);
  });
});

describe("the tangent plane at a point of a chart", () => {
  const SPHERE = "X(u,v) = (sin u cos v, sin u sin v, cos u)";

  function tangentScene(
    rows: readonly string[],
    translations?: Map<RowId, Vec3>,
  ) {
    const document = createDocument(rows);
    const rowId = document.rows()[0]!.id;
    const resolved = document.resolution();
    const scene = buildScene({
      items: [...resolved.items.values()],
      parameters: new Map(),
      declaredParameters: resolved.declaredParameters,
      // Off both poles: the chart is singular there, and the surface's own reports would
      // otherwise be about a degenerate centre rather than about the tangent plane.
      domains: new Map([
        [rowId, [{ min: 0.01, max: Math.PI - 0.01 }, { min: 0, max: 2 * Math.PI }]],
      ]),
      resolution: 24,
      translations,
    });
    return { document, scene, rowId };
  }

  /** Every polyline the tangent plane drew on the surface's behalf, in the order pushed. */
  const drawnBy = (scene: ReturnType<typeof buildScene>, rowId: RowId) =>
    scene.lines.filter((group) => group.rowId === rowId);

  it("draws a plane that is actually tangent: every point has the same height along N", () => {
    /**
     * The whole claim, as one number. At (π/2, 0) the unit sphere has p = (1, 0, 0) and N = p,
     * so a plane tangent there is exactly the set of points with x constant — and the constant is
     * 1 plus the lift that keeps it off the triangles it touches. A plane built from the wrong
     * basis, or attached at the wrong point, fails this immediately.
     */
    const { scene, rowId } = tangentScene([SPHERE, `T_(${Math.PI / 2}, 0) X`]);
    const groups = drawnBy(scene, rowId);
    expect(groups).toHaveLength(3);

    const heights: number[] = [];
    // The ruling and the border; the frame group holds the normal, which is tested below.
    for (const group of groups.slice(0, 2)) {
      for (const line of group.polylines) {
        for (let i = 0; i < line.count; i++) {
          heights.push(line.points[i * 3]!);
          // Tangent at the equator means the plane runs along z and y.
          expect(Math.abs(line.points[i * 3 + 1]!)).toBeLessThanOrEqual(1);
        }
      }
    }
    expect(heights.length).toBeGreaterThan(20);
    for (const x of heights) closeRel(x, heights[0]!, 1e-9);
    // Lifted clear of the surface, but only just: a plane standing off its point is not tangent.
    expect(heights[0]!).toBeGreaterThan(1);
    expect(heights[0]!).toBeLessThan(1.05);
  });

  it("draws X_u and X_v in the plane, and N out of it", () => {
    const { scene, rowId } = tangentScene([SPHERE, `T_(${Math.PI / 2}, 0) X`]);
    const frame = drawnBy(scene, rowId)[2]!;
    expect(frame.polylines).toHaveLength(3);

    const tip = (index: number): Vec3 => {
      const line = frame.polylines[index]!;
      return [line.points[3]!, line.points[4]!, line.points[5]!];
    };
    const base = tip(0);
    // X_u = (cos u cos v, cos u sin v, −sin u) = (0, 0, −1) and X_v = (0, sin u, 0) = (0, 1, 0):
    // both tangent, so both arrows stay at the plane's own height.
    closeRel(tip(0)[0], tip(1)[0], 1e-9);
    expect(Math.abs(tip(0)[2])).toBeGreaterThan(0.1);
    expect(Math.abs(tip(1)[1])).toBeGreaterThan(0.1);
    // The normal is the one that leaves: it points along +x, away from the sphere.
    expect(tip(2)[0]).toBeGreaterThan(base[0] + 0.1);
  });

  it("reports where it is attached, with the curvature and the first fundamental form there", () => {
    const { document, scene } = tangentScene([SPHERE, `T_(${Math.PI / 2}, 0) X`]);
    const report = scene.reports.find((r) => r.rowId === document.rows()[1]!.id);
    // At the equator of the unit sphere: K = 1, H = −1 with the outward normal, and the chart is
    // orthonormal there — E = G = 1, F = 0.
    expect(report!.info.join(" ")).toContain("K = 1.000   H = -1.000");
    expect(report!.info.join(" ")).toContain("E = 1.000   F = 0.000   G = 1.000");
  });

  it("marks the point in the chart inset", () => {
    const { scene } = tangentScene([SPHERE, "T_(1, 2) X"]);
    // Its own group: a dot drawn at the width of a stroke is invisible.
    const marks = scene.chartLines.find((group) => group.style?.widthPx === 9)!;
    expect(marks.polylines).toHaveLength(1);
    // A dot: a zero-length segment, drawn with round caps.
    expect([...marks.polylines[0]!.points]).toEqual([1, 2, 0, 1, 2, 0]);
  });

  it("moves with the surface it is tangent to", () => {
    /**
     * It is built by evaluating X, which knows nothing of arrangement, so it is owned by the
     * SURFACE's row. Owned by its own row instead, moving the sphere would leave its tangent
     * plane behind where the formula alone would have put it.
     */
    const still = tangentScene([SPHERE, `T_(${Math.PI / 2}, 0) X`]);
    const moved = tangentScene(
      [SPHERE, `T_(${Math.PI / 2}, 0) X`],
      new Map([[1, [3, 0, 0] as Vec3]]),
    );
    const a = drawnBy(still.scene, still.rowId)[1]!.polylines[0]!;
    const b = drawnBy(moved.scene, moved.rowId)[1]!.polylines[0]!;
    for (let i = 0; i < a.count; i++) {
      closeRel(b.points[i * 3]! - a.points[i * 3]!, 3, 1e-9);
      closeRel(b.points[i * 3 + 1]!, a.points[i * 3 + 1]!, 1e-9);
    }
  });

  it("says there is no tangent plane at a pole instead of drawing one", () => {
    // The sphere's u = 0 collapses to a point: X_u × X_v vanishes and the plane genuinely does
    // not exist there. A plausible square drawn through the pole would be a picture of nothing.
    const { document, scene, rowId } = tangentScene([SPHERE, "T_(0, 0) X"]);
    expect(drawnBy(scene, rowId)).toHaveLength(0);
    const report = scene.reports.find((r) => r.rowId === document.rows()[1]!.id);
    expect(report!.warnings.join(" ")).toContain("no tangent plane");
  });

  it("draws it on the patch it names, out of several", () => {
    const { scene, document } = tangentScene([
      SPHERE,
      "Y(u,v) = (u, v, 0)",
      "T_(1, 1) Y",
    ]);
    const yRow = document.rows()[1]!.id;
    expect(drawnBy(scene, yRow)).toHaveLength(3);
    expect(drawnBy(scene, document.rows()[0]!.id)).toHaveLength(0);
    // A plane's tangent plane is the plane: z = 0 everywhere it was drawn.
    for (const group of drawnBy(scene, yRow).slice(0, 2)) {
      for (const line of group.polylines) {
        for (let i = 0; i < line.count; i++) {
          expect(Math.abs(line.points[i * 3 + 2]!)).toBeLessThan(0.05);
        }
      }
    }
  });

  it("follows the parameter that moves it", () => {
    const document = createDocument([SPHERE, "T_(a, 0) X"]);
    const resolved = document.resolution();
    const at = (a: number) =>
      buildScene({
        items: [...resolved.items.values()],
        parameters: new Map([["a", a]]),
        declaredParameters: resolved.declaredParameters,
        domains: new Map(),
        resolution: 16,
      });
    const first = at(Math.PI / 2).lines.find((g) => g.style?.widthPx === 2.2)!;
    const second = at(1).lines.find((g) => g.style?.widthPx === 2.2)!;
    // Attached somewhere else on the sphere, so the square is somewhere else in space.
    expect(Math.abs(first.polylines[0]!.points[0]! - second.polylines[0]!.points[0]!))
      .toBeGreaterThan(0.1);
  });
});

describe("a vector field along a patch", () => {
  const SPHERE = "X(u,v) = (sin u cos v, sin u sin v, cos u)";

  function fieldScene(rows: readonly string[], translations?: Map<RowId, Vec3>) {
    const document = createDocument(rows);
    const rowId = document.rows()[0]!.id;
    const resolved = document.resolution();
    const scene = buildScene({
      items: [...resolved.items.values()],
      parameters: new Map(),
      declaredParameters: resolved.declaredParameters,
      domains: new Map([
        [rowId, [{ min: 0.01, max: Math.PI - 0.01 }, { min: 0, max: 2 * Math.PI }]],
      ]),
      resolution: 24,
      translations,
    });
    return { document, scene, rowId };
  }

  /** The one group of arrows, owned by the surface the field is drawn on. */
  const arrowsOf = (scene: ReturnType<typeof buildScene>, rowId: RowId) =>
    scene.lines.find((group) => group.rowId === rowId)!;

  it("draws an arrow per cell, standing on the surface and tangent to it", () => {
    /**
     * ∂/∂v on the unit sphere is the rotation field (−y, x, 0). Two claims in one: every arrow
     * starts ON the sphere (radius 1, up to the lift that keeps it off the triangles), and every
     * shaft is perpendicular to the normal there — which for the sphere is the point itself.
     */
    const { scene, rowId } = fieldScene([
      SPHERE,
      "X: VectorField(-sin u sin v, sin u cos v, 0)",
    ]);
    const arrows = arrowsOf(scene, rowId);
    expect(arrows.polylines.length).toBeGreaterThan(100);

    for (const arrow of arrows.polylines) {
      const base: Vec3 = [arrow.points[0]!, arrow.points[1]!, arrow.points[2]!];
      const tip: Vec3 = [arrow.points[3]!, arrow.points[4]!, arrow.points[5]!];
      const radius = Math.hypot(...base);
      expect(Math.abs(radius - 1)).toBeLessThan(0.05);
      const shaft = [tip[0] - base[0], tip[1] - base[1], tip[2] - base[2]] as const;
      const along = (shaft[0] * base[0] + shaft[1] * base[1] + shaft[2] * base[2]) / radius;
      // Perpendicular to the normal: the arrow lies in the tangent plane it is drawn on.
      expect(Math.abs(along)).toBeLessThan(1e-9);
    }
  });

  it("says how far a field leans off the tangent plane, in degrees", () => {
    /**
     * `(0, 0, 1)` is a perfectly good field on R³ and a perfectly bad one on a sphere. It is
     * drawn — seeing it lean off the surface is how the failure is understood — and it is named,
     * because a field that is not tangent is not a field ON the surface and nothing intrinsic can
     * be read off it.
     */
    const { document, scene } = fieldScene([SPHERE, "X: VectorField(0, 0, 1)"]);
    const report = scene.reports.find((r) => r.rowId === document.rows()[1]!.id)!;
    expect(report.warnings.join(" ")).toContain("not tangent to X");
    expect(report.warnings.join(" ")).toMatch(/8\d\.\d°/);
  });

  it("says nothing about tangency when the field is tangent", () => {
    const { document, scene } = fieldScene([
      SPHERE,
      "X: VectorField(-sin u sin v, sin u cos v, 0)",
    ]);
    const report = scene.reports.find((r) => r.rowId === document.rows()[1]!.id)!;
    expect(report.warnings).toEqual([]);
    expect(report.info.join(" ")).toContain("arrows on X");
  });

  it("scales the arrows by a robust quantile, so one wild sample cannot flatten the rest", () => {
    /**
     * The same failure `robustScale` exists to prevent for colour. `1/sin u` blows up toward the
     * pole; scaled by the maximum, every other arrow would be a dot. Past the 98th percentile the
     * arrows saturate instead, which is why the longest is bounded rather than the shortest being
     * invisible.
     */
    const { scene, rowId } = fieldScene([
      SPHERE,
      "X: VectorField(-sin v / sin u, cos v / sin u, 0)",
    ]);
    const lengths = arrowsOf(scene, rowId).polylines.map((arrow) =>
      Math.hypot(
        arrow.points[3]! - arrow.points[0]!,
        arrow.points[4]! - arrow.points[1]!,
        arrow.points[5]! - arrow.points[2]!,
      ),
    );
    const longest = Math.max(...lengths);
    const median = [...lengths].sort((a, b) => a - b)[Math.floor(lengths.length / 2)]!;
    expect(longest).toBeLessThan(median * 12);
    expect(median).toBeGreaterThan(0.02);
  });

  it("moves with the surface it lies along", () => {
    const still = fieldScene([SPHERE, "X: VectorField(-sin u sin v, sin u cos v, 0)"]);
    const moved = fieldScene(
      [SPHERE, "X: VectorField(-sin u sin v, sin u cos v, 0)"],
      new Map([[1, [0, 4, 0] as Vec3]]),
    );
    const a = arrowsOf(still.scene, still.rowId).polylines[0]!;
    const b = arrowsOf(moved.scene, moved.rowId).polylines[0]!;
    closeRel(b.points[1]! - a.points[1]!, 4, 1e-9);
    closeRel(b.points[0]!, a.points[0]!, 1e-9);
  });

  it("draws nothing, and says why, when the field vanishes everywhere", () => {
    const { document, scene, rowId } = fieldScene([SPHERE, "X: VectorField(0, 0, 0)"]);
    expect(scene.lines.filter((group) => group.rowId === rowId)).toHaveLength(0);
    const report = scene.reports.find((r) => r.rowId === document.rows()[1]!.id)!;
    expect(report.warnings.join(" ")).toContain("zero or undefined");
  });

  it("is drawn on the patch it names, out of several", () => {
    const { scene, document } = fieldScene([
      SPHERE,
      "Y(u,v) = (u, v, 0)",
      "Y: VectorField(0, 0, 1)",
    ]);
    // Tangent to nothing on a plane: the check is per host, so this one is reported against Y.
    expect(scene.lines.filter((g) => g.rowId === document.rows()[1]!.id)).toHaveLength(1);
    expect(scene.lines.filter((g) => g.rowId === document.rows()[0]!.id)).toHaveLength(0);
    const report = scene.reports.find((r) => r.rowId === document.rows()[2]!.id)!;
    expect(report.warnings.join(" ")).toContain("not tangent to Y");
  });
});

describe("playing a field's flow", () => {
  const SPHERE = "X(u,v) = (sin u cos v, sin u sin v, cos u)";

  function sceneWith(rows: readonly string[], translations?: Map<RowId, Vec3>) {
    const document = createDocument(rows);
    const rowId = document.rows()[0]!.id;
    const resolved = document.resolution();
    const scene = buildScene({
      items: [...resolved.items.values()],
      parameters: new Map(),
      declaredParameters: resolved.declaredParameters,
      domains: new Map([
        [rowId, [{ min: 0.01, max: Math.PI - 0.01 }, { min: 0, max: 2 * Math.PI }]],
      ]),
      resolution: 24,
      translations,
    });
    return { document, scene };
  }

  it("offers a flow for a field row and for nothing else", () => {
    const { document, scene } = sceneWith([
      SPHERE,
      "X: VectorField(-sin u sin v, sin u cos v, 0)",
    ]);
    const [surface, field] = document.rows();
    expect(scene.flowFor(field!.id)).not.toBeNull();
    // A surface is not a flow, and neither is a row that does not exist.
    expect(scene.flowFor(surface!.id)).toBeNull();
    expect(scene.flowFor(9999)).toBeNull();
    expect(scene.flowFor(field!.id)!.hostRow).toBe(surface!.id);
  });

  it("draws streaks that lie on the surface and follow the field", () => {
    const { document, scene } = sceneWith([
      SPHERE,
      "X: VectorField(-sin u sin v, sin u cos v, 0)",
    ]);
    const flow = scene.flowFor(document.rows()[1]!.id)!;
    const state = flow.seed(30, 5);
    for (let i = 0; i < 20; i++) flow.advance(state, 1 / 60);

    // Three layered bands: the whole streak, its newer half, its head — which is how the tail
    // fades when the line pass takes one opacity per group.
    const groups = flow.lines(state);
    expect(groups.length).toBe(3);
    expect(groups[0]!.style!.opacity).toBeLessThan(groups[2]!.style!.opacity!);
    expect(groups[0]!.style!.widthPx).toBeLessThan(groups[2]!.style!.widthPx!);
    expect(groups[0]!.polylines.length).toBeGreaterThan(20);
    for (const streak of groups[0]!.polylines) {
      expect(streak.count).toBeGreaterThan(1);
      for (let i = 0; i < streak.count; i++) {
        const r = Math.hypot(
          streak.points[i * 3]!,
          streak.points[i * 3 + 1]!,
          streak.points[i * 3 + 2]!,
        );
        // On the sphere, up to the lift that keeps a curve off the triangles under it.
        expect(Math.abs(r - 1)).toBeLessThan(0.05);
      }
    }
  });

  it("is drawn where its surface is, not where the formula puts it", () => {
    const still = sceneWith([SPHERE, "X: VectorField(-sin u sin v, sin u cos v, 0)"]);
    const moved = sceneWith(
      [SPHERE, "X: VectorField(-sin u sin v, sin u cos v, 0)"],
      new Map([[1, [0, 0, 5] as Vec3]]),
    );
    const seeded = (built: ReturnType<typeof sceneWith>) => {
      const flow = built.scene.flowFor(built.document.rows()[1]!.id)!;
      const state = flow.seed(8, 3);
      flow.advance(state, 1 / 60);
      return flow.lines(state)[0]!.polylines[0]!;
    };
    const a = seeded(still);
    const b = seeded(moved);
    closeRel(b.points[2]! - a.points[2]!, 5, 1e-9);
    closeRel(b.points[0]!, a.points[0]!, 1e-9);
  });

  it("animates at the same rate however the field is scaled", () => {
    /**
     * The tempo is a property of the picture, not of the formula: doubling every vector is a
     * reparametrization of time, and a flow that ran twice as fast for it would make the speed
     * on screen mean nothing. The relative speeds WITHIN one field are what carry meaning, and
     * those are untouched — the scale divides out through the same robust quantile the arrow
     * lengths use.
     */
    const advanced = (field: string) => {
      const { document, scene } = sceneWith([SPHERE, `X: VectorField(${field})`]);
      const flow = scene.flowFor(document.rows()[1]!.id)!;
      const state = flow.seed(1, 17);
      const before = state.chart[1]!;
      for (let i = 0; i < 10; i++) flow.advance(state, 1 / 60);
      return state.chart[1]! - before;
    };
    const single = advanced("-sin u sin v, sin u cos v, 0");
    const doubled = advanced("-2 sin u sin v, 2 sin u cos v, 0");
    closeRel(doubled, single, 1e-9);
  });

  it("flows a field that is not tangent along the part of it that is", () => {
    // Reported as untangent, and still played: the projection is a perfectly good field on the
    // surface, and refusing to animate would leave the row with a warning and nothing to look at.
    const { document, scene } = sceneWith([SPHERE, "X: VectorField(0, 0, 1)"]);
    const flow = scene.flowFor(document.rows()[1]!.id)!;
    const state = flow.seed(6, 8);
    const before = [...state.chart];
    const ageBefore = [...state.age];
    const elapsed = 10 / 60;
    for (let i = 0; i < 10; i++) flow.advance(state, 1 / 60);

    // u̇ = −sin u, v̇ = 0: a particle climbs toward the north pole and none goes round. A particle
    // whose lifetime ran out in those ten frames is somewhere else entirely, by design — its age
    // is what says so, since a reseeded one starts counting again from zero.
    let followed = 0;
    for (let k = 0; k < state.count; k++) {
      if (Math.abs(state.age[k]! - (ageBefore[k]! + elapsed)) > 1e-9) continue;
      followed++;
      expect(state.chart[k * 2]!).toBeLessThan(before[k * 2]!);
      closeRel(state.chart[k * 2 + 1]!, before[k * 2 + 1]!, 1e-9);
    }
    expect(followed).toBeGreaterThan(0);
  });
});

describe("what colour each row was drawn in", () => {
  /**
   * Reported rather than left to be guessed, because the defaults are not one rule: a curve takes
   * the next entry of a palette by document order, a field its own blue, a patch the shade under
   * its curvature map. The dot on a row's cell shows this, and a swatch that showed anything else
   * would be a swatch that lies about the object beside it.
   */
  it("names a colour for everything that draws one", () => {
    const { document, scene } = sceneOf([
      "X(u,v) = (sin u cos v, sin u sin v, cos u)",
      "alpha(t) = (cos t, sin t, t)",
      "X: VectorField(-sin u sin v, sin u cos v, 0)",
      "(1, 2, 3)",
    ]);
    for (const row of document.rows()) {
      const color = scene.usedColors.get(row.id);
      expect(color, `row ${row.id} reported no colour`).toBeDefined();
      for (const channel of color!) {
        expect(channel).toBeGreaterThanOrEqual(0);
        expect(channel).toBeLessThanOrEqual(1);
      }
    }
    // Two curves in a row take different palette entries, which is exactly what a dot has to
    // show and what no rule in the UI could have worked out on its own.
    const { document: pair, scene: two } = sceneOf([
      "alpha(t) = (cos t, sin t, t)",
      "beta(t) = (cos t, sin t, -t)",
    ]);
    const [a, b] = pair.rows();
    expect(two.usedColors.get(a!.id)).not.toEqual(two.usedColors.get(b!.id));
  });

  it("reports the colour a row was given, when it was given one", () => {
    const document = createDocument(["alpha(t) = (cos t, sin t, t)"]);
    const rowId = document.rows()[0]!.id;
    const scene = buildScene({
      items: [...document.resolution().items.values()],
      parameters: new Map(),
      domains: new Map(),
      resolution: 16,
      colors: new Map([[rowId, [0.25, 0.5, 0.75] as Vec3]]),
    });
    expect(scene.usedColors.get(rowId)).toEqual([0.25, 0.5, 0.75]);
  });
});

describe("a field's arrows, as a group of their own", () => {
  it("hands them out by identity, still in the lines they belong to", () => {
    /**
     * The app leaves the arrows out of a frame while the flow plays, or when the row's switch
     * says so — decisions about the frame, not about the document. Handing back the very group
     * that is also in `lines` is what makes that a filter rather than a rebuild, and keeping it
     * in `lines` is what keeps it moving with its surface.
     */
    const document = createDocument([
      "X(u,v) = (sin u cos v, sin u sin v, cos u)",
      "X: VectorField(-sin u sin v, sin u cos v, 0)",
    ]);
    const resolved = document.resolution();
    const scene = buildScene({
      items: [...resolved.items.values()],
      parameters: new Map(),
      domains: new Map(),
      resolution: 16,
    });
    const [surface, field] = document.rows();

    const group = scene.fieldArrows.get(field!.id);
    expect(group).toBeDefined();
    expect(scene.lines).toContain(group!);
    // Owned by the surface, like everything else built by evaluating X.
    expect(group!.rowId).toBe(surface!.id);
    expect(scene.fieldArrows.get(surface!.id)).toBeUndefined();
  });
});

const hiddenOverlay: SurfaceOverlay =
  ({ geodesics: 0, geodesicLength: 1.5, curvatureLines: false, hidden: true }) as SurfaceOverlay;

describe("a row switched off", () => {
  /**
   * The dot on a row's cell. A patch answers it through `fill` — its grid stays, which is the
   * half of a surface you want left behind — and everything else stops being drawn entirely.
   */
  const overlayOf = (hidden: boolean): SurfaceOverlay =>
    ({ geodesics: 0, geodesicLength: 1.5, curvatureLines: false, hidden }) as SurfaceOverlay;

  function scene(sources: readonly string[], hiddenRow: number | null) {
    const document = createDocument(sources);
    const rows = document.rows();
    const resolved = document.resolution();
    return {
      rows,
      scene: buildScene({
        items: [...resolved.items.values()],
        parameters: new Map(),
        declaredParameters: resolved.declaredParameters,
        domains: new Map(),
        resolution: 16,
        overlays:
          hiddenRow === null
            ? new Map()
            : new Map([[rows[hiddenRow]!.id, overlayOf(true)]]),
      }),
    };
  }

  it("draws nothing for a hidden curve, and everything else as before", () => {
    const shown = scene(["X(u,v) = (u, v, 0)", "alpha(t) = (cos t, sin t, t)"], null);
    const hidden = scene(["X(u,v) = (u, v, 0)", "alpha(t) = (cos t, sin t, t)"], 1);
    const curveRow = shown.rows[1]!.id;
    expect(shown.scene.lines.some((group) => group.rowId === curveRow)).toBe(true);
    expect(hidden.scene.lines.some((group) => group.rowId === curveRow)).toBe(false);
    // The surface is untouched: switching one row off is not a scene-wide mode.
    expect(hidden.scene.mesh!.triangleCount).toBe(shown.scene.mesh!.triangleCount);
  });

  it("hides a point, a tangent plane and a field alike", () => {
    for (const [rows, index] of [
      [["(1, 2, 3)"], 0],
      [["X(u,v) = (u, v, 0)", "T_(0.5, 0.5) X"], 1],
      [["X(u,v) = (u, v, 0)", "X: VectorField(0, 1, 0)"], 1],
    ] as const) {
      const shown = scene(rows, null);
      const hidden = scene(rows, index);
      expect(hidden.scene.lines.length).toBeLessThan(shown.scene.lines.length);
    }
  });
});

describe("a field in the chart", () => {
  const SPHERE = "X(u,v) = (sin u cos v, sin u sin v, cos u)";

  function chartScene(rows: readonly string[], chartRow?: number) {
    const document = createDocument(rows);
    const rows_ = document.rows();
    const resolved = document.resolution();
    const scene = buildScene({
      items: [...resolved.items.values()],
      parameters: new Map(),
      declaredParameters: resolved.declaredParameters,
      domains: new Map([
        [rows_[0]!.id, [{ min: 0.01, max: Math.PI - 0.01 }, { min: 0, max: 2 * Math.PI }]],
      ]),
      resolution: 16,
      chartRow: chartRow === undefined ? undefined : rows_[chartRow]!.id,
    });
    return { rows: rows_, scene };
  }

  it("draws the field's arrows in the inset, in chart coordinates", () => {
    /**
     * A field written in ambient components has a chart representation — the (u̇, v̇) solving
     * `[E F; F G](u̇,v̇)ᵀ = (⟨V,X_u⟩, ⟨V,X_v⟩)ᵀ` — and that is what an arrow downstairs means:
     * components in the basis {∂/∂u, ∂/∂v}.
     */
    const { rows, scene } = chartScene([SPHERE, "X: VectorField(-sin u sin v, sin u cos v, 0)"]);
    const group = scene.fieldChartArrows.get(rows[1]!.id);
    expect(group).toBeDefined();
    expect(scene.chartLines).toContain(group!);
    expect(group!.polylines.length).toBeGreaterThan(100);

    // ∂/∂v has (u̇, v̇) = (0, 1): every arrow points along v and none of them leaves its own u.
    for (const arrow of group!.polylines) {
      const u0 = arrow.points[0]!;
      const tipU = arrow.points[3]!;
      const tipV = arrow.points[4]!;
      expect(Math.abs(tipU - u0)).toBeLessThan(1e-9);
      expect(tipV).toBeGreaterThan(arrow.points[1]!);
    }
  });

  it("draws only the shown patch's field, not every patch's", () => {
    // Two patches have two different (u, v) planes, and drawing both in one square would be a
    // picture of neither — the rule every chart curve already follows.
    const rows = [SPHERE, "Y(u,v) = (u, v, 0)", "Y: VectorField(0, 1, 0)"];
    const onX = chartScene(rows);
    expect(onX.scene.fieldChartArrows.size).toBe(0);
    const onY = chartScene(rows, 1);
    expect(onY.scene.fieldChartArrows.size).toBe(1);
  });

  it("gives the flow a chart streak beside its own", () => {
    const { rows, scene } = chartScene([SPHERE, "X: VectorField(-sin u sin v, sin u cos v, 0)"]);
    const flow = scene.flowFor(rows[1]!.id)!;
    const state = flow.seed(20, 4);
    for (let i = 0; i < 10; i++) flow.advance(state, 1 / 60);

    const groups = flow.chartLines(state);
    expect(groups).toHaveLength(1);
    const streaks = groups[0]!.polylines;
    expect(streaks.length).toBeGreaterThan(10);
    for (const streak of streaks) {
      for (let i = 0; i < streak.count; i++) {
        // Inside the domain it was seeded over, and flat: the inset draws (u, v, 0).
        expect(streak.points[i * 3]!).toBeGreaterThanOrEqual(0);
        expect(streak.points[i * 3]!).toBeLessThanOrEqual(Math.PI);
        expect(streak.points[i * 3 + 2]!).toBe(0);
      }
    }
    // The chart trail and the one in space are the same particles, so they have the same lengths.
    expect(streaks.length).toBe(flow.lines(state)[0]!.polylines.length);
  });

  it("says nothing in the chart when the inset is showing another patch", () => {
    const rows = [SPHERE, "Y(u,v) = (u, v, 0)", "X: VectorField(-sin u sin v, sin u cos v, 0)"];
    const elsewhere = chartScene(rows, 1);
    const flow = elsewhere.scene.flowFor(elsewhere.rows[2]!.id)!;
    const state = flow.seed(8, 2);
    flow.advance(state, 1 / 60);
    expect(flow.chartLines(state)).toEqual([]);
    // and it is still drawn in space, which is the point of the check.
    expect(flow.lines(state).length).toBeGreaterThan(0);
  });
});

describe("level sets", () => {
  /**
   * The second representation, end to end: an equation in x, y and z becomes a mesh through
   * marching tetrahedra, with N = ∇F/|∇F| and the curvature computed from the Hessian — and it
   * lands in the same buffers a parametrization produces, which is what lets the surface pass,
   * the picking pass and the colour scale take it without a branch.
   */
  function implicitScene(rows: readonly string[], domains = new Map<RowId, DomainRange[]>()) {
    const document = createDocument(rows);
    const resolved = document.resolution();
    const scene = buildScene({
      items: [...resolved.items.values()],
      parameters: new Map(),
      declaredParameters: resolved.declaredParameters,
      domains,
      resolution: 64,
    });
    return { document, scene };
  }

  it("draws a sphere written as an equation, with the curvature of a sphere", () => {
    const { document, scene } = implicitScene(["x^2 + y^2 + z^2 = 1"]);
    expect(scene.mesh).not.toBeNull();
    expect(scene.mesh!.triangleCount).toBeGreaterThan(500);

    // K = 1/R² = 1 everywhere, and the mesh carries it per vertex like any other surface.
    for (let v = 0; v < scene.mesh!.vertexCount; v += 13) {
      closeRel(scene.mesh!.curvature[v]!, 1, 1e-4);
    }
    // And the row says so, rather than the stage being the only readout.
    const report = scene.reports.find((entry) => entry.rowId === document.rows()[0]!.id)!;
    expect(report.info.join(" ")).toContain("triangles");
    expect(report.errors).toEqual([]);
  });

  it("says when the box holds no surface instead of drawing nothing silently", () => {
    // The commonest way an implicit surface looks broken, and it is not broken: the level set is
    // somewhere else. A blank stage is not a diagnosis.
    const { document, scene } = implicitScene(["x^2 + y^2 + z^2 = 100"]);
    const report = scene.reports.find((entry) => entry.rowId === document.rows()[0]!.id)!;
    expect(report.info.join(" ")).toContain("no surface inside this box");
    expect(report.warnings.join(" ")).toContain("widen the domain");
  });

  it("searches the box the row was given", () => {
    // Three sides always, whichever coordinates the formula mentions — the box is a window onto
    // R³, not a domain the surface is a map from.
    const document = createDocument(["x^2 + y^2 + z^2 = 1"]);
    const rowId = document.rows()[0]!.id;
    const item = document.resolution().items.get(rowId)!;
    expect(item.vars).toEqual(["x", "y", "z"]);

    const tight = buildScene({
      items: [item],
      parameters: new Map(),
      domains: new Map([
        [rowId, [{ min: 0, max: 2 }, { min: -2, max: 2 }, { min: -2, max: 2 }]],
      ]),
      resolution: 64,
    });
    // Half the sphere, so every vertex is on the half the box kept.
    for (let v = 0; v < tight.mesh!.vertexCount; v++) {
      expect(tight.mesh!.positions[v * 3]!).toBeGreaterThanOrEqual(-1e-6);
    }
  });

  it("moves with the hand like any other object", () => {
    const document = createDocument(["x^2 + y^2 + z^2 = 1"]);
    const rowId = document.rows()[0]!.id;
    const items = [...document.resolution().items.values()];
    const scene = buildScene({
      items,
      parameters: new Map(),
      domains: new Map(),
      resolution: 48,
      translations: new Map([[rowId, [4, 0, 0] as Vec3]]),
    });
    for (let v = 0; v < scene.mesh!.vertexCount; v += 17) {
      const dx = scene.mesh!.positions[v * 3]! - 4;
      const dy = scene.mesh!.positions[v * 3 + 1]!;
      const dz = scene.mesh!.positions[v * 3 + 2]!;
      closeRel(Math.hypot(dx, dy, dz), 1, 1e-3);
    }
  });

  it("reads an equation in x and y as the cylinder it defines", () => {
    /**
     * The regular value theorem taken at its word: `x² + y² = 1` is a level set of F: R³ → R, and
     * that is a cylinder. The circle is what the cylinder cuts on a plane — a different object,
     * and the row can ask for it, but it is not what the equation says.
     */
    const { document, scene } = implicitScene(["x^2 + y^2 = 1"]);
    expect(document.resolution().items.get(document.rows()[0]!.id)?.kind).toBe("implicitSurface");
    expect(scene.mesh).not.toBeNull();
    expect(scene.mesh!.triangleCount).toBeGreaterThan(100);
    for (let v = 0; v < scene.mesh!.vertexCount; v += 11) {
      // Every vertex on the unit cylinder, at whatever height the box reaches.
      closeRel(
        Math.hypot(scene.mesh!.positions[v * 3]!, scene.mesh!.positions[v * 3 + 1]!),
        1,
        1e-3,
      );
    }
  });

  it("draws it flat when the row asks", () => {
    const document = createDocument(["x^2 + y^2 = 1"]);
    const rowId = document.rows()[0]!.id;
    const scene = buildScene({
      items: [...document.resolution().items.values()],
      parameters: new Map(),
      domains: new Map(),
      resolution: 64,
      overlays: new Map([
        [rowId, { geodesics: 0, geodesicLength: 1.5, curvatureLines: false, inPlane: true }],
      ]),
    });
    const group = scene.lines.find((entry) => entry.rowId === rowId);
    expect(group).toBeDefined();
    expect(group!.polylines.length).toBeGreaterThan(50);
    // The unit circle, flat in z = 0 — and no mesh, because nothing asked for the surface.
    for (const segment of group!.polylines) {
      for (let i = 0; i < segment.count; i++) {
        closeRel(Math.hypot(segment.points[i * 3]!, segment.points[i * 3 + 1]!), 1, 2e-3);
        expect(segment.points[i * 3 + 2]!).toBe(0);
      }
    }
    expect(scene.mesh).toBeNull();
  });

  it("reports a colour for a level set, so its cell can show a dot", () => {
    const { document, scene } = implicitScene(["x^2 + y^2 + z^2 = 1"]);
    expect(scene.usedColors.get(document.rows()[0]!.id)).toBeDefined();
    expect(scene.curvatureScales.get(document.rows()[0]!.id)).toBeGreaterThan(0);
  });
});

describe("the square under the pointer", () => {
  /**
   * Hovering the inset picks out one grid square there and the patch of surface it maps to. That
   * is the parametrization made visible one cell at a time — which is the reason the flat picture
   * and the object are side by side at all.
   */
  function sphereScene() {
    const document = createDocument(["X(u,v) = (sin u cos v, sin u sin v, cos u)"]);
    const rowId = document.rows()[0]!.id;
    const scene = buildScene({
      items: [...document.resolution().items.values()],
      parameters: new Map(),
      domains: new Map([[rowId, [{ min: 0, max: Math.PI }, { min: 0, max: 2 * Math.PI }]]]),
      resolution: 32,
    });
    return { rowId, scene };
  }

  it("snaps to the grid the inset actually draws", () => {
    /**
     * `chartGrid` divides the domain into GRID_DIVISIONS and `surfaceGridLines` walks the mesh at
     * the same count, so a square in the corner and a square on the object are the same square.
     * Any other lattice would highlight two different things.
     */
    const { scene } = sphereScene();
    const cell = scene.chartCellAt(0.1, 0.1)!;
    expect(cell).not.toBeNull();
    const us: number[] = [];
    const vs: number[] = [];
    for (let i = 0; i < cell.chart.count; i++) {
      us.push(cell.chart.points[i * 3]!);
      vs.push(cell.chart.points[i * 3 + 1]!);
    }
    // The first cell of an 8 × 8 grid over [0, π] × [0, 2π].
    closeRel(Math.min(...us), 0, 1e-9);
    closeRel(Math.max(...us), Math.PI / 8, 1e-9);
    closeRel(Math.min(...vs), 0, 1e-9);
    closeRel(Math.max(...vs), (2 * Math.PI) / 8, 1e-9);
  });

  it("gives the same square wherever inside it the pointer is", () => {
    const { scene } = sphereScene();
    const first = scene.chartCellAt(0.05, 0.05)!;
    const again = scene.chartCellAt(0.3, 0.7)!;
    expect([...again.chart.points]).toEqual([...first.chart.points]);
    // And a different square once the pointer crosses a grid line.
    const next = scene.chartCellAt(0.5, 0.05)!;
    expect([...next.chart.points]).not.toEqual([...first.chart.points]);
  });

  it("pushes the square onto the surface it belongs to", () => {
    const { scene } = sphereScene();
    const cell = scene.chartCellAt(1.5, 3)!;
    expect(cell.surface).not.toBeNull();
    for (let i = 0; i < cell.surface!.count; i++) {
      if (!cell.surface!.valid?.[i]) continue;
      const r = Math.hypot(
        cell.surface!.points[i * 3]!,
        cell.surface!.points[i * 3 + 1]!,
        cell.surface!.points[i * 3 + 2]!,
      );
      // On the unit sphere, lifted just clear of the mesh it is drawn over.
      expect(Math.abs(r - 1)).toBeLessThan(0.05);
    }
  });

  it("moves with the surface, like everything else built from X", () => {
    const document = createDocument(["X(u,v) = (sin u cos v, sin u sin v, cos u)"]);
    const rowId = document.rows()[0]!.id;
    const scene = buildScene({
      items: [...document.resolution().items.values()],
      parameters: new Map(),
      domains: new Map([[rowId, [{ min: 0, max: Math.PI }, { min: 0, max: 2 * Math.PI }]]]),
      resolution: 32,
      translations: new Map([[rowId, [0, 6, 0] as Vec3]]),
    });
    const cell = scene.chartCellAt(1.5, 3)!;
    for (let i = 0; i < cell.surface!.count; i++) {
      if (!cell.surface!.valid?.[i]) continue;
      expect(cell.surface!.points[i * 3 + 1]!).toBeGreaterThan(4.5);
    }
  });

  it("says nothing outside the domain, where the chart is wider than the surface", () => {
    // The inset shows a margin around the domain — chart the parametrization says nothing about —
    // and there is no square out there to pick out.
    const { scene } = sphereScene();
    expect(scene.chartCellAt(-0.4, 1)).toBeNull();
    expect(scene.chartCellAt(1, 7.5)).toBeNull();
  });

  it("says nothing when no patch is charted", () => {
    const document = createDocument(["alpha(t) = (cos t, sin t, t)"]);
    const scene = buildScene({
      items: [...document.resolution().items.values()],
      parameters: new Map(),
      domains: new Map(),
      resolution: 16,
    });
    expect(scene.chartCellAt(1, 1)).toBeNull();
  });
});

describe("one object in its ambient space", () => {
  /**
   * Double-clicking an object asks "let me look at *this*", and the answer is a stage with nothing
   * else on it and the coordinate axes drawn. Filtering rather than hiding: the document is not
   * touched, so leaving the mode is one field going null rather than a list of things to switch
   * back on.
   */
  const document3 = () =>
    createDocument([
      "X(u,v) = (sin u cos v, sin u sin v, cos u)",
      "Y(u,v) = (u, v, 2)",
      "alpha(t) = (cos t, sin t, t)",
      "X: VectorField(-sin u sin v, sin u cos v, 0)",
    ]);

  function scene(isolate: RowId | null, axes = isolate !== null) {
    const store = document3();
    const rows = store.rows();
    return {
      rows,
      built: buildScene({
        items: [...store.resolution().items.values()],
        parameters: new Map(),
        domains: new Map(),
        resolution: 24,
        isolate,
        axes,
      }),
    };
  }

  it("draws everything when nothing is isolated", () => {
    const { built } = scene(null);
    // Two patches concatenated into one mesh, and the curve and the field beside them.
    expect(built.mesh!.triangleCount).toBeGreaterThan(24 * 24 * 2);
    expect(built.usedColors.size).toBe(4);
  });

  it("keeps only the object and what is stated in its chart", () => {
    const { rows, built } = scene(1);
    // X and its field; not Y, and not the curve. One patch's worth of mesh, not two — the count
    // is not 24 × 24 × 2 because the sphere's default domain covers it twice and its poles cost
    // it a ring of triangles.
    expect(built.mesh!.triangleCount).toBeGreaterThan(0);
    expect(built.mesh!.triangleCount).toBeLessThan(scene(null).built.mesh!.triangleCount);
    expect(built.usedColors.has(rows[0]!.id)).toBe(true);
    expect(built.usedColors.has(rows[3]!.id)).toBe(true);
    expect(built.usedColors.has(rows[1]!.id)).toBe(false);
    expect(built.usedColors.has(rows[2]!.id)).toBe(false);
  });

  it("takes a curve on its own, with no surface at all", () => {
    const { rows, built } = scene(3);
    expect(built.mesh).toBeNull();
    expect(built.usedColors.has(rows[2]!.id)).toBe(true);
  });

  it("draws the axes only when asked, and centres them on the origin", () => {
    const without = scene(null, false).built;
    const withAxes = scene(null, true).built;
    expect(withAxes.lines.length).toBeGreaterThan(without.lines.length);

    // Three lines through the origin, one per direction, owned by nobody: they belong to the
    // space rather than to an object, so nothing moves them.
    const axes = withAxes.lines[withAxes.lines.length - 2]!;
    expect(axes.rowId).toBeUndefined();
    expect(axes.polylines).toHaveLength(3);
    for (const [index, line] of axes.polylines.entries()) {
      for (let c = 0; c < 3; c++) {
        // Along its own direction and zero across the others.
        if (c === index) expect(Math.abs(line.points[c]!)).toBeGreaterThan(0);
        else expect(line.points[c]!).toBe(0);
      }
    }
  });

  it("sizes the axes to what is on the stage", () => {
    const small = buildScene({
      items: [...createDocument(["X(u,v) = (0.1 sin u cos v, 0.1 sin u sin v, 0.1 cos u)"])
        .resolution().items.values()],
      parameters: new Map(),
      domains: new Map(),
      resolution: 16,
      axes: true,
    });
    const large = buildScene({
      items: [...createDocument(["X(u,v) = (9 sin u cos v, 9 sin u sin v, 9 cos u)"])
        .resolution().items.values()],
      parameters: new Map(),
      domains: new Map(),
      resolution: 16,
      axes: true,
    });
    const reach = (built: ReturnType<typeof buildScene>) =>
      Math.abs(built.lines[built.lines.length - 2]!.polylines[0]!.points[3]!);
    expect(reach(large)).toBeGreaterThan(reach(small) * 10);
  });
});

describe("ambient space is faithful about where the surface is", () => {
  /**
   * The mode's whole claim: this is how the surface sits in R³. A hand translation is a
   * presentation device — it moves the drawn geometry away from where X puts it — so measuring a
   * dragged object against the axes would report a position its formula does not claim. While one
   * object is isolated it is drawn where its own parametrization places it, and the translations
   * wait in the document for the rest of the scene to come back.
   */
  const sphere = () => createDocument(["X(u,v) = (sin u cos v, sin u sin v, cos u)"]);

  it("draws the object where its formula puts it, not where it was dragged", () => {
    const store = sphere();
    const rowId = store.rows()[0]!.id;
    const items = [...store.resolution().items.values()];
    const common = { items, parameters: new Map<string, number>(), domains: new Map(), resolution: 24 };

    const arranged = buildScene({ ...common, translations: new Map([[rowId, [7, 0, 0] as Vec3]]) });
    closeRel(arranged.bounds!.center[0], 7, 1e-6);

    // The same document, isolated: the translation is ignored and the sphere is back on its axes.
    const ambient = buildScene({
      ...common,
      isolate: rowId,
      axes: true,
      translations: new Map(),
    });
    expect(Math.abs(ambient.bounds!.center[0])).toBeLessThan(1e-6);
  });

  it("runs the axes off to the horizon, cheaply", () => {
    /**
     * An axis that ended a little past the object would put a visible edge on space itself, and
     * zooming out would show three short sticks rather than a coordinate system. Past the ticked
     * stretch each axis continues in doubling steps, so it reaches a distance nothing will look
     * from for a couple of dozen segments — and is a **chain** rather than one long segment,
     * because a segment spanning the camera has an endpoint behind the eye, where the projection
     * turns inside out.
     */
    const store = sphere();
    const scene = buildScene({
      items: [...store.resolution().items.values()],
      parameters: new Map(),
      domains: new Map(),
      resolution: 24,
      isolate: store.rows()[0]!.id,
      axes: true,
    });
    const axes = scene.lines[scene.lines.length - 2]!;
    const line = axes.polylines[0]!;
    let far = 0;
    for (let i = 0; i < line.count; i++) far = Math.max(far, Math.abs(line.points[i * 3]!));
    // A thousand times the object, from a line of a few dozen points.
    expect(far).toBeGreaterThan(scene.bounds!.radius * 1000);
    expect(line.count).toBeLessThan(120);
    expect(line.count).toBeGreaterThan(20);
  });

  it("frames the object rather than its scaffolding", () => {
    /**
     * The bounds are computed before the axes are added. Axes long enough to hold the scene would
     * otherwise be what the camera framed — every object shown at the scale of its own cross,
     * shrunk into the middle of the screen.
     */
    const store = sphere();
    const scene = buildScene({
      items: [...store.resolution().items.values()],
      parameters: new Map(),
      domains: new Map(),
      resolution: 24,
      isolate: store.rows()[0]!.id,
      axes: true,
    });
    closeRel(scene.bounds!.radius, 1, 1e-3);

    // And the axes really do reach past it, or they would stop short of the view.
    const axes = scene.lines[scene.lines.length - 2]!;
    expect(Math.abs(axes.polylines[0]!.points[3]!)).toBeGreaterThan(scene.bounds!.radius);
  });
});

describe("expressions that belong to an ambient space", () => {
  /**
   * A row stated on a surface belongs to it in one of two ways. `X: v = sin u` is a curve *on* X
   * and has nowhere else to be, so it is drawn with X always. `X: (1, 2, 3)` is a point in X's
   * ambient **space** — written while looking at X, meaning what it means beside X — and out in
   * the whole document it would be a stray point with no visible relationship to anything. So
   * those live in their space and are drawn when it is open.
   */
  const document4 = () =>
    createDocument([
      "R = 2",
      "X(u,v) = (R sin u cos v, R sin u sin v, R cos u)",
      "Y(u,v) = (u, v, 3)",
      "X: (1, 2, 3)",
      "X: alpha(t) = (t, t, t)",
      "X: z = x^2 - y^2",
      "X: v = sin u",
    ]);

  const drawnIn = (isolate: number | null) => {
    const store = document4();
    const scene = buildScene({
      items: [...store.resolution().items.values()],
      parameters: new Map([["R", 2]]),
      declaredParameters: store.resolution().declaredParameters,
      domains: new Map(),
      resolution: 16,
      isolate,
      axes: isolate !== null,
    });
    return { rows: store.rows(), scene };
  };

  it("classifies each of the three kinds an ambient space takes", () => {
    const store = document4();
    const kinds = store.rows().map((row) => store.resolution().items.get(row.id)?.kind);
    expect(kinds).toEqual([
      "parameter",
      "parametricSurface",
      "parametricSurface",
      "point",
      "spaceCurve",
      "graphSurface",
      "chartGraph",
    ]);
    // And every one of them says whose space it is in.
    for (const row of store.rows().slice(3)) {
      expect(store.resolution().items.get(row.id)?.host).toBe("X");
    }
  });

  it("draws them outside the space as well: only the eye takes an object off the stage", () => {
    /**
     * Hiding a space's contents on the way out was the first design, and it read as the document
     * throwing the work away: you build a point, a curve and a graph inside X, step out, and they
     * are gone. Ambient space only ever **narrows** now — everything is drawn at the top level,
     * and what stops an object being drawn is the eye on its own row, one decision per object.
     */
    const { rows, scene } = drawnIn(null);
    for (const index of [1, 2, 3, 4, 5, 6]) {
      expect(scene.usedColors.has(rows[index]!.id), `row ${index} missing`).toBe(true);
    }

    // And that is the switch: hide the point and it alone leaves.
    const store = document4();
    const hiddenPoint = store.rows()[3]!.id;
    const withHidden = buildScene({
      items: [...store.resolution().items.values()],
      parameters: new Map([["R", 2]]),
      declaredParameters: store.resolution().declaredParameters,
      domains: new Map(),
      resolution: 16,
      overlays: new Map([[hiddenPoint, hiddenOverlay]]),
    });
    expect(withHidden.lines.length).toBeLessThan(scene.lines.length);
  });

  it("draws nothing of a patch whose eye is shut — face, grid and all", () => {
    // The eye is the blunt switch, which is what separates it from the dot: the dot takes a
    // patch's face off and leaves the grid, because that outline is the useful half of a surface
    // you are looking past. A hidden patch has no mesh on the stage at all, so it cannot be
    // picked either.
    const store = createDocument(["X(u,v) = (u, v, u^2 - v^2)"]);
    const rowId = store.rows()[0]!.id;
    const common = {
      items: [...store.resolution().items.values()],
      parameters: new Map<string, number>(),
      domains: new Map(),
      resolution: 16,
    };
    const shown = buildScene(common);
    const hidden = buildScene({
      ...common,
      overlays: new Map([[rowId, hiddenOverlay]]),
    });
    expect(shown.mesh).not.toBeNull();
    expect(hidden.mesh).toBeNull();
    expect(hidden.gridLines).toHaveLength(0);
    // The colour is still reported: the dot has to keep showing what it would come back as.
    expect(hidden.usedColors.has(rowId)).toBe(true);
  });

  it("draws a surface written inside a space everywhere, annotations only inside", () => {
    /**
     * A surface written inside a space **shares** it rather than owning one — that is what makes
     * the mode flat, and it is enforced where it is felt: double-click cannot open a second space
     * from the inside. But it is an object, with a shape and a place in R³ that it keeps whether
     * or not anybody is inside looking at it, so the stage draws it. Only the annotations — a
     * point, a curve, a graph — are held back, because those mean what they mean beside their
     * surface and are strays out in the whole document.
     */
    const store = createDocument([
      "X(u,v) = (sin u cos v, sin u sin v, cos u)",
      "X: Y(u,v) = (u, v, 2)",
    ]);
    const rows = store.rows();
    const items = [...store.resolution().items.values()];
    expect(store.resolution().items.get(rows[1]!.id)?.host).toBe("X");

    const common = { items, parameters: new Map<string, number>(), domains: new Map(), resolution: 16 };
    const whole = buildScene(common);
    expect(whole.usedColors.has(rows[1]!.id), "the object is on the stage").toBe(true);

    const inside = buildScene({ ...common, isolate: rows[0]!.id, axes: true });
    expect(inside.usedColors.has(rows[1]!.id), "it is drawn in the space it was written in").toBe(
      true,
    );
  });

  it("opens an ambient space and draws what was built in it", () => {
    /**
     * A space is a place rather than an object: it draws nothing of itself, and what you see on
     * entering is everything written inside it, against the axes. The closure is what makes it
     * usable — a chart in A, a relation in that chart, a field on it — and the objects of another
     * space stay out.
     */
    const store = createDocument([
      "A = AmbientSpace",
      "B = AmbientSpace",
      "A: sigma(u,v) = (u, v, u^2 - v^2)",
      "A:sigma: VectorField(1, 0, 0)",
      "B: tau(u,v) = (u, v, 3)",
    ]);
    const rows = store.rows();
    const scene = buildScene({
      items: [...store.resolution().items.values()],
      parameters: new Map(),
      domains: new Map(),
      resolution: 12,
      isolate: rows[0]!.id,
      axes: true,
    });
    expect(scene.usedColors.has(rows[2]!.id), "the chart in A").toBe(true);
    expect(scene.usedColors.has(rows[3]!.id), "the field on it").toBe(true);
    expect(scene.usedColors.has(rows[4]!.id), "B's chart is in another space").toBe(false);
    // The space itself draws nothing: it is where the axes are, not a thing on the stage.
    expect(scene.usedColors.has(rows[0]!.id)).toBe(false);
  });

  it("moves a whole space as one object", () => {
    /**
     * A point written inside X's ambient space is at (1, 2, 3) **of that space**. Drag the torus
     * and the point has to go with it, or the sentence the row states stops being true — so
     * arrangement is a property of the space and every row in it reads its host's placement.
     * The hand end of this is `movedBy` in `main.ts`, which redirects the drag itself.
     */
    const store = createDocument([
      "X(u,v) = (sin u cos v, sin u sin v, cos u)",
      "X: (1, 2, 3)",
      "X: Y(u,v) = (u, v, 2)",
    ]);
    const rows = store.rows();
    const common = {
      items: [...store.resolution().items.values()],
      parameters: new Map<string, number>(),
      domains: new Map(),
      resolution: 12,
    };
    const still = buildScene(common);
    const moved = buildScene({
      ...common,
      translations: new Map([[rows[0]!.id, [10, 0, 0] as Vec3]]),
    });

    const dotOf = (scene: Scene) =>
      scene.lines.find((group) => group.rowId === rows[1]!.id)!.polylines[0]!.points[0]!;
    expect(dotOf(still)).toBeCloseTo(1, 9);
    expect(dotOf(moved), "the point travelled with its space").toBeCloseTo(11, 9);

    // And so did the surface written in it: the whole space is one rigid thing.
    const spanOf = (scene: Scene) => {
      let max = -Infinity;
      const mesh = scene.mesh!;
      for (let v = 0; v < mesh.vertexCount; v++) max = Math.max(max, mesh.positions[v * 3]!);
      return max;
    };
    expect(spanOf(moved) - spanOf(still)).toBeCloseTo(10, 6);
  });

  it("keeps what is stated on a surface written inside a space", () => {
    /**
     * The closure, and why one level of host is not enough. Y is written inside X's space; a field
     * and a curve stated on Y are stated on something in that space, so they are in it too. Drawn
     * one level deep, the new surface would appear and everything drawn on it would vanish — which
     * reads as the space refusing half of what you type into it.
     */
    const store = createDocument([
      "X(u,v) = (sin u cos v, sin u sin v, cos u)",
      "X: Y(u,v) = (u, v, 2)",
      "Y: VectorField(1, 0, 0)",
      "Y: v = sin u",
    ]);
    const rows = store.rows();
    const scene = buildScene({
      items: [...store.resolution().items.values()],
      parameters: new Map(),
      domains: new Map(),
      resolution: 16,
      isolate: rows[0]!.id,
      axes: true,
    });
    for (const index of [1, 2, 3]) {
      expect(scene.usedColors.has(rows[index]!.id), `row ${index} missing`).toBe(true);
    }
  });

  it("draws them, and only them, inside the space they belong to", () => {
    const surfaceRow = document4().rows()[1]!.id;
    const { rows, scene } = drawnIn(surfaceRow);
    for (const index of [1, 3, 4, 5, 6]) {
      expect(scene.usedColors.has(rows[index]!.id), `row ${index} missing`).toBe(true);
    }
    // The other surface is not in this space.
    expect(scene.usedColors.has(rows[2]!.id)).toBe(false);
  });
});
