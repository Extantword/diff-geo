import { describe, expect, it } from "vitest";
import { createDocument } from "../../src/state/graph.ts";
import { buildScene, type DomainRange, type FrameRequest } from "../../src/state/scene.ts";
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

describe("one colour scale for the whole scene", () => {
  /** A sphere on a domain that avoids both poles, so no vertex is degenerate. */
  const sphere = (radius: string, name: string) =>
    `${name}(u,v) = (${radius} sin u cos v, ${radius} sin u sin v, ${radius} cos u)`;

  function scene(sources: readonly string[]) {
    const document = createDocument(sources);
    const rows = document.rows();
    const domains = new Map<RowId, DomainRange[]>(
      rows.map((row) => [row.id, [{ min: 0.3, max: 2.8 }, { min: 0, max: 6.28 }]]),
    );
    return buildScene({
      items: [...document.resolution().items.values()],
      parameters: new Map(),
      domains,
      resolution: 16,
    });
  }

  it("repaints an existing surface when a more curved one joins the scene", () => {
    /**
     * The legend labels one scale, so every surface must be painted against that scale — and the
     * consequence, which is what this asserts, is that adding a surface CHANGES the colour of the
     * ones already there. If each surface were normalized to its own curvature range instead,
     * every shape would look equally saturated and identical colours would mean different
     * curvatures: a figure that lies about the one thing it exists to show.
     */
    const alone = scene([sphere("1", "A")]);
    // K = 1 for the unit sphere and 25 for this one, so the pooled scale jumps by 25x.
    const together = scene([sphere("1", "A"), sphere("0.2", "B")]);

    expect(alone.curvatureScale).toBeCloseTo(1, 3);
    expect(together.curvatureScale).toBeCloseTo(25, 1);

    // Vertex 0 belongs to the unit sphere in both scenes. On its own it sits at the saturated
    // end of the scale; sharing with a far more curved surface pushes it toward neutral.
    const neutral: [number, number, number] = [0, 0, 0];
    divergingColor(0, neutral);
    const distanceToNeutral = (mesh: NonNullable<typeof alone.mesh>) =>
      Math.hypot(
        mesh.colors[0]! - neutral[0],
        mesh.colors[1]! - neutral[1],
        mesh.colors[2]! - neutral[2],
      );

    expect(distanceToNeutral(together.mesh!)).toBeLessThan(distanceToNeutral(alone.mesh!));
  });

  it("gives both surfaces the same colour where their curvature agrees", () => {
    // Two unit spheres: same K, so same colour, whichever buffer half a vertex lands in.
    const both = scene([sphere("1", "A"), sphere("1", "B")]);
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
