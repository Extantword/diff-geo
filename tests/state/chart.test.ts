import { describe, expect, it } from "vitest";
import { createDocument, type RowId } from "../../src/state/graph.ts";
import { buildScene, type DomainRange } from "../../src/state/scene.ts";
import {
  chartGrid,
  chartLift,
  GRID_DIVISIONS,
  surfaceGridLines,
} from "../../src/state/chart.ts";
import { marchingSquares } from "../../src/core/mesh/contour.ts";
import type { Vec3 } from "../../src/core/geom/types.ts";

const closeRel = (a: number, b: number, rel = 1e-6) =>
  expect(Math.abs(a - b)).toBeLessThan(rel * Math.max(1, Math.abs(a), Math.abs(b)));

function sceneWithChart(
  sources: readonly string[],
  chartRows: number[] = [],
  extra: { translations?: Map<RowId, Vec3>; domains?: Map<RowId, DomainRange[]> } = {},
) {
  const document = createDocument(sources);
  const resolved = document.resolution();
  const items = [...resolved.items.values()];
  const rows = document.rows();
  const inChart = new Set<RowId>(chartRows.map((index) => rows[index]!.id));
  const scene = buildScene({
    items,
    parameters: new Map(),
    declaredParameters: resolved.declaredParameters,
    domains: extra.domains ?? new Map<RowId, DomainRange[]>(),
    resolution: 24,
    inChart,
    translations: extra.translations,
  });
  return { document, scene, rows };
}

describe("the chart inset", () => {
  it("reports the first surface's domain", () => {
    const { scene } = sceneWithChart(["X(u,v) = (u, v, 0)"]);
    expect(scene.chartBounds).not.toBeNull();
    closeRel(scene.chartBounds!.u[1], 2 * Math.PI, 1e-9);
    closeRel(scene.chartBounds!.v[1], 2 * Math.PI, 1e-9);
  });

  it("has no chart when the document holds no surface", () => {
    const { scene } = sceneWithChart(["alpha(t) = (cos t, sin t, t)"]);
    expect(scene.chartBounds).toBeNull();
    expect(scene.chartLines).toHaveLength(0);
  });

  it("draws a grid and a closed border", () => {
    const grid = chartGrid({ u: [0, 1], v: [0, 2] }, 4);
    const border = grid.at(-1)!.polylines[0]!;
    // Five points, so the rectangle closes back on itself.
    expect(border.count).toBe(5);
    expect(border.points[0]).toBe(border.points[12]);
    expect(border.points[1]).toBe(border.points[13]);
  });
});

describe("the grid drawn on the surface", () => {
  /**
   * The grid used to be a fragment-shader overlay at a fixed (u, v) spacing. It followed the
   * facets rather than the surface, it drew the border of the domain only by coincidence, and
   * with the face turned off it thresholded its own antialiasing away. These tests are about the
   * three things that replaced it.
   */
  it("draws the interior and the four edges of every patch", () => {
    const { scene } = sceneWithChart(["X(u,v) = (u, v, 0)"]);
    const [interior, border] = scene.gridLines;
    expect(interior).toBeDefined();
    // Both families, minus the two edges of each: those are the border.
    expect(interior!.polylines).toHaveLength(2 * (GRID_DIVISIONS - 1));
    expect(border!.polylines).toHaveLength(4);
    // The border is drawn heavier than what is inside it, or a patch reads as hatching.
    expect(border!.style!.widthPx!).toBeGreaterThan(interior!.style!.widthPx!);
  });

  it("follows the surface instead of cutting across it", () => {
    /**
     * The whole complaint: "the grid looks like line-segments". The line at u = π/2 on a sphere
     * is the equator, and a polyline that really is that circle recovers its circumference in
     * chords. Two-point segments across the chart would report a diameter at most.
     */
    const document = createDocument(["X(u,v) = (sin u cos v, sin u sin v, cos u)"]);
    const resolved = document.resolution();
    const rowId = document.rows()[0]!.id;
    const scene = buildScene({
      items: [...resolved.items.values()],
      parameters: new Map(),
      declaredParameters: resolved.declaredParameters,
      domains: new Map<RowId, DomainRange[]>([
        [rowId, [{ min: 0, max: Math.PI }, { min: 0, max: 2 * Math.PI }]],
      ]),
      resolution: 24,
    });

    const interior = scene.gridLines[0]!;
    // The u-lines come first, at u = kπ/8; the fourth of them is the equator.
    const equator = interior.polylines[3]!;
    let chords = 0;
    for (let i = 1; i < equator.count; i++) {
      chords += Math.hypot(
        equator.points[i * 3]! - equator.points[(i - 1) * 3]!,
        equator.points[i * 3 + 1]! - equator.points[(i - 1) * 3 + 1]!,
        equator.points[i * 3 + 2]! - equator.points[(i - 1) * 3 + 2]!,
      );
    }
    // Within a percent of 2π at resolution 24. Falling short is the numeric signature of
    // faceting, which is what a grid drawn per fragment across flat triangles produced.
    expect(chords).toBeGreaterThan(2 * Math.PI * 0.99);
    expect(chords).toBeLessThan(2 * Math.PI * 1.01);
  });

  it("lifts the grid clear of the surface it lies on", () => {
    // Drawn at the surface exactly, the line z-fights with the triangles under it.
    const { scene } = sceneWithChart(["X(u,v) = (u, v, 0)"]);
    const line = scene.gridLines[0]!.polylines[0]!;
    expect(line.points[2]!).toBeGreaterThan(0);
  });

  it("is a patch's own choice, and drawing nothing is one of the choices", () => {
    const document = createDocument(["X(u,v) = (u, v, 0)"]);
    const resolved = document.resolution();
    const rowId = document.rows()[0]!.id;
    const scene = buildScene({
      items: [...resolved.items.values()],
      parameters: new Map(),
      declaredParameters: resolved.declaredParameters,
      domains: new Map<RowId, DomainRange[]>(),
      resolution: 24,
      overlays: new Map([[rowId, { grid: false } as never]]),
    });
    expect(scene.gridLines).toHaveLength(0);
  });

  it("breaks a line at a vertex with no tangent plane rather than drawing through it", () => {
    /**
     * The non-finite contract, as the line pass states it. A zero normal is the tessellator's
     * mark for a vertex it could not place, and nothing can be lifted off a surface that has no
     * normal there.
     */
    const positions = new Float32Array(9 * 3);
    const normals = new Float32Array(9 * 3);
    for (let k = 0; k < 9; k++) {
      positions[k * 3] = k;
      normals[k * 3 + 2] = k === 4 ? 0 : 1;
    }
    const { interior, border } = surfaceGridLines({ positions, normals }, 2, 2, 0.1, 2);
    const marks = [...interior, ...border].flatMap((line) => [...line.valid!]);
    expect(marks).toContain(0);
    expect(marks).toContain(1);
  });
});

describe("pushing a chart curve onto the surface", () => {
  it("maps (u,v) through X and draws the curve twice", () => {
    // The surface is the plane (u, v, 0), so the image of a chart curve is the curve itself —
    // which makes the push-forward directly checkable rather than merely plausible.
    const { scene } = sceneWithChart(
      ["X(u,v) = (u, v, 0)", "c(t) = (t, t)"],
      [1],
    );

    // Once in the inset, once in 3D.
    const chartCurve = scene.chartLines.at(-1)!.polylines[0]!;
    expect(chartCurve.count).toBeGreaterThan(100);

    const onSurface = scene.lines.at(-1)!.polylines[0]!;
    expect(onSurface.count).toBe(chartCurve.count);

    for (let i = 0; i < onSurface.count; i += 37) {
      if (!onSurface.valid?.[i]) continue;
      const u = chartCurve.points[i * 3]!;
      const v = chartCurve.points[i * 3 + 1]!;
      closeRel(onSurface.points[i * 3]!, u, 1e-6);
      closeRel(onSurface.points[i * 3 + 1]!, v, 1e-6);
      // Lifted clear of the mesh along the normal, which for this plane is +z.
      expect(onSurface.points[i * 3 + 2]!).toBeGreaterThan(0);
    }
  });

  it("maps a chart circle onto the actual surface, not into z = 0", () => {
    // On a sphere, u = const is a circle of latitude. Its image must lie on the sphere.
    const { scene } = sceneWithChart(
      ["X(u,v) = (sin u cos v, sin u sin v, cos u)", "c(t) = (1, t)"],
      [1],
    );
    const onSurface = scene.lines.at(-1)!.polylines[0]!;
    let checked = 0;
    for (let i = 0; i < onSurface.count; i++) {
      if (!onSurface.valid?.[i]) continue;
      const x = onSurface.points[i * 3]!;
      const y = onSurface.points[i * 3 + 1]!;
      const z = onSurface.points[i * 3 + 2]!;
      // Radius 1 plus the lift, so slightly outside the unit sphere but not by much.
      const radius = Math.hypot(x, y, z);
      expect(radius).toBeGreaterThan(0.99);
      expect(radius).toBeLessThan(1.1);
      checked++;
    }
    expect(checked).toBeGreaterThan(100);
  });

  it("uses the same colour in the chart and on the surface", () => {
    // The two views are only legible together if a curve is recognizably the same object.
    const { scene } = sceneWithChart(["X(u,v) = (u, v, 0)", "c(t) = (t, t)"], [1]);
    const chartCurve = scene.chartLines.at(-1)!.polylines[0]!;
    const onSurface = scene.lines.at(-1)!.polylines[0]!;
    expect(onSurface.color).toEqual(chartCurve.color);
  });

  it("breaks the polyline where the curve leaves the domain, and says so", () => {
    // t runs over [0, 2π] while the chart curve is (t, 10) — far outside v ∈ [0, 2π].
    const { document, scene } = sceneWithChart(
      ["X(u,v) = (u, v, 0)", "c(t) = (t, 10)"],
      [1],
    );
    const report = scene.reports.find((r) => r.rowId === document.rows()[1]!.id);
    expect(report?.warnings.join(" ")).toContain("outside the domain");
    // Nothing was clamped onto the boundary: the curve simply has no image.
    const surfaceGroups = scene.lines.filter((group) =>
      group.polylines.some((line) => line.count > 100),
    );
    expect(surfaceGroups).toHaveLength(0);
  });

  it("leaves an unticked plane curve in the z = 0 plane", () => {
    // `(cos t, sin t)` is a circle in the plane and also a circle in the chart, and those are
    // different objects. Without the toggle it stays the former.
    const { scene } = sceneWithChart(["X(u,v) = (u, v, 0)", "c(t) = (cos t, sin t)"], []);
    // The grid contributes exactly two groups (interior lines, then the border); a chart curve
    // would append a third.
    expect(scene.chartLines).toHaveLength(2);
    const planeCurve = scene.lines[0]!.polylines[0]!;
    for (let i = 0; i < planeCurve.count; i++) {
      expect(planeCurve.points[i * 3 + 2]).toBe(0);
    }
  });

  it("follows its sliders", () => {
    const document = createDocument(["X(u,v) = (u, v, 0)", "c(t) = (t, a)"]);
    const resolved = document.resolution();
    const items = [...resolved.items.values()];
    const inChart = new Set<RowId>([document.rows()[1]!.id]);

    const at = (a: number) => {
      const scene = buildScene({
        items,
        parameters: new Map([["a", a]]),
        declaredParameters: resolved.declaredParameters,
        domains: new Map(),
        resolution: 8,
        inChart,
      });
      return scene.chartLines.at(-1)!.polylines[0]!.points[1]!;
    };
    closeRel(at(1), 1, 1e-9);
    closeRel(at(2.5), 2.5, 1e-9);
  });
});

describe("chartLift", () => {
  it("scales with the scene rather than being a constant", () => {
    // A fixed offset is simultaneously too small for a large surface and too large for a
    // small one; this is the property that makes it scale-independent.
    const small = chartLift(0.01, 128, 10000);
    const large = chartLift(100, 128, 1e-4);
    expect(small).toBeLessThan(large);
    expect(small).toBeGreaterThan(0);
  });

  it("grows with curvature at fixed size", () => {
    // More curvature means a bigger gap between the surface and its chords.
    expect(chartLift(1, 32, 100)).toBeGreaterThan(chartLift(1, 32, 1));
  });

  it("shrinks as the mesh gets finer", () => {
    // The sagitta goes as h², so a denser mesh needs less clearance.
    expect(chartLift(1, 256, 100)).toBeLessThan(chartLift(1, 32, 100));
  });
});

describe("marching squares", () => {
  it("finds a circle of the right radius", () => {
    const contour = marchingSquares(
      (u, v) => u * u + v * v - 1,
      { u: [-2, 2], v: [-2, 2] },
      { resU: 200, resV: 200 },
    );
    expect(contour.segmentCount).toBeGreaterThan(200);
    // Every point of the contour must sit on the unit circle, to within a cell.
    for (let i = 0; i < contour.segmentCount; i++) {
      for (const offset of [0, 2]) {
        const u = contour.segments[i * 4 + offset]!;
        const v = contour.segments[i * 4 + offset + 1]!;
        expect(Math.abs(Math.hypot(u, v) - 1)).toBeLessThan(0.02);
      }
    }
  });

  it("has total length close to the true circumference", () => {
    // A stronger check than pointwise membership: it also catches missing or duplicated cells.
    const contour = marchingSquares(
      (u, v) => u * u + v * v - 1,
      { u: [-2, 2], v: [-2, 2] },
      { resU: 400, resV: 400 },
    );
    let total = 0;
    for (let i = 0; i < contour.segmentCount; i++) {
      total += Math.hypot(
        contour.segments[i * 4 + 2]! - contour.segments[i * 4]!,
        contour.segments[i * 4 + 3]! - contour.segments[i * 4 + 1]!,
      );
    }
    closeRel(total, 2 * Math.PI, 0.01);
  });

  it("finds nothing where the relation has no solution", () => {
    const contour = marchingSquares(
      (u, v) => u * u + v * v + 1,
      { u: [-2, 2], v: [-2, 2] },
      { resU: 40, resV: 40 },
    );
    expect(contour.segmentCount).toBe(0);
  });

  it("finds both branches of a hyperbola", () => {
    const contour = marchingSquares(
      (u, v) => u * u - v * v - 1,
      { u: [-3, 3], v: [-3, 3] },
      { resU: 200, resV: 200 },
    );
    let left = 0;
    let right = 0;
    for (let i = 0; i < contour.segmentCount; i++) {
      if (contour.segments[i * 4]! < 0) left++;
      else right++;
    }
    expect(left).toBeGreaterThan(50);
    expect(right).toBeGreaterThan(50);
  });

  it("skips cells touching a non-finite sample rather than drawing through them", () => {
    // `1/u` blows up on the v axis; the contour must simply not exist there.
    const contour = marchingSquares(
      (u, v) => 1 / u - v,
      { u: [-1, 1], v: [-1, 1] },
      { resU: 60, resV: 60 },
    );
    for (let i = 0; i < contour.segmentCount * 4; i++) {
      expect(Number.isFinite(contour.segments[i]!)).toBe(true);
    }
  });
});

describe("chart graphs and relations", () => {
  it("draws v = f(u) at the right height", () => {
    const { scene } = sceneWithChart(["X(u,v) = (u, v, 0)", "f(u) = 1 + sin u"]);
    const graph = scene.chartLines.at(-1)!.polylines[0]!;
    for (let i = 0; i < graph.count; i += 31) {
      if (!graph.valid?.[i]) continue;
      const u = graph.points[i * 3]!;
      const v = graph.points[i * 3 + 1]!;
      closeRel(v, 1 + Math.sin(u), 1e-6);
    }
  });

  it("pushes a chart graph onto the surface", () => {
    // Over the plane (u,v,0) the image is the graph itself, so this is directly checkable.
    const { scene } = sceneWithChart(["X(u,v) = (u, v, 0)", "f(u) = 1 + sin u"]);
    const onSurface = scene.lines.at(-1)!.polylines[0]!;
    let checked = 0;
    for (let i = 0; i < onSurface.count; i += 31) {
      if (!onSurface.valid?.[i]) continue;
      const x = onSurface.points[i * 3]!;
      const y = onSurface.points[i * 3 + 1]!;
      closeRel(y, 1 + Math.sin(x), 1e-6);
      checked++;
    }
    expect(checked).toBeGreaterThan(5);
  });

  it("marks the part of a graph that leaves the domain", () => {
    // v = 10 is far above v ∈ [0, 2π], so the whole graph is off the chart.
    const { document, scene } = sceneWithChart(["X(u,v) = (u, v, 0)", "f(u) = 10"]);
    const report = scene.reports.find((r) => r.rowId === document.rows()[1]!.id);
    expect(report?.warnings.join(" ")).toContain("leaves the domain");
  });

  it("draws a relation's level set in the chart and on the surface", () => {
    const { document, scene } = sceneWithChart([
      "X(u,v) = (u, v, 0)",
      "(u - 3)^2 + (v - 3)^2 = 1",
    ]);
    const report = scene.reports.find((r) => r.rowId === document.rows()[1]!.id);
    expect(report?.info.join(" ")).toContain("contour segments");

    // The contour lies on the circle of radius 1 about (3, 3), in both views.
    const chartSegments = scene.chartLines.at(-1)!.polylines;
    expect(chartSegments.length).toBeGreaterThan(50);
    for (const segment of chartSegments.slice(0, 40)) {
      const u = segment.points[0]!;
      const v = segment.points[1]!;
      expect(Math.abs(Math.hypot(u - 3, v - 3) - 1)).toBeLessThan(0.05);
    }

    const onSurface = scene.lines.at(-1)!.polylines;
    expect(onSurface.length).toBeGreaterThan(50);
    for (const segment of onSurface.slice(0, 40)) {
      const x = segment.points[0]!;
      const y = segment.points[1]!;
      expect(Math.abs(Math.hypot(x - 3, y - 3) - 1)).toBeLessThan(0.05);
    }
  });

  it("says so when a relation has no solutions in the domain", () => {
    const { document, scene } = sceneWithChart([
      "X(u,v) = (u, v, 0)",
      "u^2 + v^2 = -1",
    ]);
    const report = scene.reports.find((r) => r.rowId === document.rows()[1]!.id);
    expect(report?.info.join(" ")).toContain("no solutions");
  });

  it("follows sliders in a relation", () => {
    const document = createDocument(["X(u,v) = (u, v, 0)", "(u-3)^2 + (v-3)^2 = R^2"]);
    const resolved = document.resolution();
    const items = [...resolved.items.values()];
    const radiusOf = (R: number) => {
      const scene = buildScene({
        items,
        parameters: new Map([["R", R]]),
        declaredParameters: resolved.declaredParameters,
        domains: new Map(),
        resolution: 120,
      });
      const segment = scene.chartLines.at(-1)!.polylines[0]!;
      return Math.hypot(segment.points[0]! - 3, segment.points[1]! - 3);
    };
    closeRel(radiusOf(1), 1, 0.05);
    closeRel(radiusOf(2), 2, 0.05);
  });
});

describe("the surface's own parameters reach the push-forward", () => {
  /**
   * Every other test here uses `X(u,v) = (u, v, 0)`, which has NO parameters — and that is
   * exactly what let this bug through. The chart samplers were handing the *curve's* packed
   * parameter array to `surface.at`, so a relation with no parameters gave a sphere that needs
   * R an empty array: every point evaluated to NaN, every point read as degenerate, and the
   * entire push-forward vanished with no diagnostic at all.
   *
   * Both arrays are `Float64Array`, so nothing about it was a type error. These cases exist
   * specifically because a surface with a parameter is the only thing that catches it.
   */
  function sphereScene(extra: readonly string[]) {
    const document = createDocument([
      "X(u,v) = (R sin u cos v, R sin u sin v, R cos u)",
      ...extra,
    ]);
    const resolved = document.resolution();
    const rows = document.rows();
    const domains = new Map<RowId, DomainRange[]>([
      [rows[0]!.id, [{ min: 0.01, max: 3.13 }, { min: 0, max: 6.28 }]],
    ]);
    return buildScene({
      items: [...resolved.items.values()],
      parameters: new Map([["R", 2]]),
      declaredParameters: resolved.declaredParameters,
      domains,
      resolution: 120,
    });
  }

  /** Largest deviation of any pushed point from the sphere of radius R. */
  function radialError(scene: ReturnType<typeof sphereScene>, radius: number) {
    let worst = 0;
    let checked = 0;
    for (const group of scene.lines) {
      for (const line of group.polylines) {
        for (let i = 0; i < line.count; i++) {
          if (line.valid && !line.valid[i]) continue;
          const r = Math.hypot(
            line.points[i * 3]!,
            line.points[i * 3 + 1]!,
            line.points[i * 3 + 2]!,
          );
          worst = Math.max(worst, Math.abs(r - radius));
          checked++;
        }
      }
    }
    return { worst, checked };
  }

  it("pushes a relation onto a parametrized sphere", () => {
    const scene = sphereScene(["u^2 + v^2 = 1"]);
    const { worst, checked } = radialError(scene, 2);
    expect(checked).toBeGreaterThan(50);
    // On the sphere of radius R = 2, plus only the lift.
    expect(worst).toBeLessThan(0.02);
  });

  it("pushes a chart graph onto a parametrized sphere", () => {
    const scene = sphereScene(["f(u) = 1 + sin u"]);
    const { worst, checked } = radialError(scene, 2);
    expect(checked).toBeGreaterThan(50);
    expect(worst).toBeLessThan(0.02);
  });

  it("follows the surface's slider, not the curve's", () => {
    // Doubling R must move the pushed curve, which it cannot do if the surface is being
    // evaluated with the wrong parameter array.
    const one = radialError(sphereScene(["u^2 + v^2 = 1"]), 2);
    expect(one.worst).toBeLessThan(0.02);

    const document = createDocument([
      "X(u,v) = (R sin u cos v, R sin u sin v, R cos u)",
      "u^2 + v^2 = 1",
    ]);
    const resolved = document.resolution();
    const rows = document.rows();
    const domains = new Map<RowId, DomainRange[]>([
      [rows[0]!.id, [{ min: 0.01, max: 3.13 }, { min: 0, max: 6.28 }]],
    ]);
    const scene = buildScene({
      items: [...resolved.items.values()],
      parameters: new Map([["R", 5]]),
      declaredParameters: resolved.declaredParameters,
      domains,
      resolution: 120,
    });
    const five = radialError(scene, 5);
    expect(five.checked).toBeGreaterThan(50);
    expect(five.worst).toBeLessThan(0.05);
  });
});

describe("a curve in the chart stays on the surface it charts", () => {
  it("takes the surface's placement, not its own row's", () => {
    /**
     * The push-forward evaluates X, which knows nothing about arrangement — so its image has to
     * be moved by whatever moved the SURFACE. Owned by the curve's row instead, the image of a
     * moved surface's curve was drawn where the formula alone would have put it: a curve of
     * exactly the right shape, hanging in space beside the object it belongs to.
     */
    const document = createDocument(["X(u,v) = (u, v, 0)", "c(t) = (t, t)"]);
    const rows = document.rows();
    const translations = new Map<RowId, Vec3>([[rows[0]!.id, [10, 0, 5]]]);
    const resolved = document.resolution();
    const scene = buildScene({
      items: [...resolved.items.values()],
      parameters: new Map(),
      declaredParameters: resolved.declaredParameters,
      domains: new Map<RowId, DomainRange[]>(),
      resolution: 24,
      inChart: new Set<RowId>([rows[1]!.id]),
      translations,
    });

    const onSurface = scene.lines.at(-1)!.polylines[0]!;
    let checked = 0;
    for (let i = 0; i < onSurface.count; i += 31) {
      if (!onSurface.valid?.[i]) continue;
      const x = onSurface.points[i * 3]!;
      const y = onSurface.points[i * 3 + 1]!;
      const z = onSurface.points[i * 3 + 2]!;
      // The plane is at (u + 10, v, 5), and the curve is u = v = t on it — lifted clear of the
      // mesh along the normal, which for this plane is z, so z sits a sagitta above 5.
      closeRel(y, x - 10, 1e-6);
      expect(Math.abs(z - 5)).toBeLessThan(0.05);
      checked++;
    }
    expect(checked).toBeGreaterThan(5);
  });

  it("draws the part outside the domain in the chart, and nowhere else", () => {
    /**
     * The chart is the whole (u, v) plane; the domain is only the part of it the parametrization
     * has been given. So a line that leaves the rectangle keeps being drawn flat — dashed, in the
     * inset — and simply stops having an image on the surface.
     */
    const { scene } = sceneWithChart(["X(u,v) = (u, v, 0)", "f(u) = 4 + u"]);

    // Two curve groups in the inset now: the part over the domain, and the part beyond it.
    const groups = scene.chartLines.slice(-2);
    const inside = groups[0]!.polylines[0]!;
    const beyond = groups[1]!.polylines[0]!;
    expect(groups[1]!.style?.dashPeriod).toBeGreaterThan(0);

    const usable = (line: typeof inside) => {
      let n = 0;
      for (let i = 0; i < line.count; i++) if (line.valid?.[i]) n++;
      return n;
    };
    expect(usable(inside)).toBeGreaterThan(0);
    expect(usable(beyond)).toBeGreaterThan(0);
    // Every sample is in exactly one of the two.
    for (let i = 0; i < inside.count; i++) {
      expect(Boolean(inside.valid?.[i]) === Boolean(beyond.valid?.[i]), `sample ${i}`).toBe(false);
    }

    // v = 4 + u over u ∈ [0, 2π] leaves v ∈ [0, 2π] partway along, and only what is left of it
    // reaches the surface.
    const onSurface = scene.lines.at(-1)!.polylines[0]!;
    for (let i = 0; i < onSurface.count; i++) {
      if (!onSurface.valid?.[i]) continue;
      expect(onSurface.points[i * 3 + 1]!).toBeLessThanOrEqual(2 * Math.PI + 1e-9);
    }
  });

  it("widens the inset to hold the curve, without shrinking the domain out of sight", () => {
    const { scene } = sceneWithChart(["X(u,v) = (u, v, 0)", "f(u) = 4 + u"]);
    // The domain still reads as the domain: the view contains it whole.
    expect(scene.chartView!.v[0]).toBeLessThanOrEqual(scene.chartBounds!.v[0]);
    expect(scene.chartView!.v[1]).toBeGreaterThan(scene.chartBounds!.v[1]);

    // And a curve that runs away does not shrink it to a dot.
    const wild = sceneWithChart(["X(u,v) = (u, v, 0)", "f(u) = 10000 u"]).scene;
    const domainSpan = wild.chartBounds!.v[1] - wild.chartBounds!.v[0];
    const viewSpan = wild.chartView!.v[1] - wild.chartView!.v[0];
    expect(viewSpan / domainSpan).toBeLessThanOrEqual(7);
  });
});

describe("which chart a curve lives in", () => {
  it("draws a curve on the patch its row names, not on the first one", () => {
    /**
     * With one surface the first-surface convention is invisible; with two it is a coin flip. A
     * curve is a curve IN A CHART, and which chart cannot be read off the formula — so the row
     * says it, with a `Y:` prefix, and the binding is the text itself.
     */
    const document = createDocument([
      "X(u,v) = (u, v, 0)",
      "Y(u,v) = (u, v, 5)",
      "Y: c(t) = (t, t)",
    ]);
    const rows = document.rows();
    const resolved = document.resolution();
    const scene = buildScene({
      items: [...resolved.items.values()],
      parameters: new Map(),
      declaredParameters: resolved.declaredParameters,
      domains: new Map<RowId, DomainRange[]>(),
      resolution: 24,
      inChart: new Set<RowId>([rows[2]!.id]),
    });

    const onSurface = scene.lines.at(-1)!.polylines[0]!;
    let checked = 0;
    for (let i = 0; i < onSurface.count; i += 31) {
      if (!onSurface.valid?.[i]) continue;
      // The second plane sits at z = 5; the first is at z = 0, so this cannot pass by accident.
      expect(Math.abs(onSurface.points[i * 3 + 2]! - 5)).toBeLessThan(0.05);
      checked++;
    }
    expect(checked).toBeGreaterThan(5);
  });

  it("draws a relation on the patch its row names", () => {
    // The same for a relation, which is the form a curve on a surface is usually written in.
    const document = createDocument([
      "X(u,v) = (u, v, 0)",
      "Y(u,v) = (u, v, 5)",
      "Y: (u - 3)^2 + (v - 3)^2 = 1",
    ]);
    const resolved = document.resolution();
    const scene = buildScene({
      items: [...resolved.items.values()],
      parameters: new Map(),
      declaredParameters: resolved.declaredParameters,
      domains: new Map<RowId, DomainRange[]>(),
      resolution: 24,
    });
    const segments = scene.lines.at(-1)!.polylines;
    expect(segments.length).toBeGreaterThan(20);
    for (const segment of segments) expect(segment.points[2]!).toBeCloseTo(5, 1);
  });

  it("says so when the named patch is not there, and still draws the curve", () => {
    /**
     * A renamed or deleted patch leaves rows pointing at a name nobody has. Dropping the curve
     * would be the harshest possible reading of a typo; drawing it on the first surface and
     * saying which one is used keeps the document readable while it is being fixed.
     */
    const document = createDocument(["X(u,v) = (u, v, 0)", "Z: (u - 3)^2 + (v - 3)^2 = 1"]);
    const resolved = document.resolution();
    const rowId = document.rows()[1]!.id;
    const scene = buildScene({
      items: [...resolved.items.values()],
      parameters: new Map(),
      declaredParameters: resolved.declaredParameters,
      domains: new Map<RowId, DomainRange[]>(),
      resolution: 24,
    });
    const report = scene.reports.find((entry) => entry.rowId === rowId)!;
    expect(report.warnings.join(" ")).toContain("no patch called Z");
    expect(scene.lines.at(-1)!.polylines.length).toBeGreaterThan(20);
  });

  it("shows the selected patch's chart, and the relations stated in it", () => {
    /**
     * Clicking a patch asks "what does *this* one look like flat", and the answer is its domain
     * with the rows stated in it drawn on top. The first-surface convention is the fallback, not
     * the rule — with several patches it would answer a question nobody asked.
     */
    const document = createDocument([
      "X(u,v) = (u, v, 0)",
      "Y(u,v) = (2 u, v, 5)",
      "Y: (u - 3)^2 + (v - 3)^2 = 1",
    ]);
    const rows = document.rows();
    const resolved = document.resolution();
    const build = (chartRow: RowId | null) =>
      buildScene({
        items: [...resolved.items.values()],
        parameters: new Map(),
        declaredParameters: resolved.declaredParameters,
        domains: new Map<RowId, DomainRange[]>([
          [rows[1]!.id, [{ min: 0, max: 3 }, { min: 0, max: 4 }]],
        ]),
        resolution: 24,
        chartRow,
      });

    // Unselected: the first surface's own domain, and nothing of Y's in the inset.
    const first = build(null);
    closeRel(first.chartBounds!.u[1], 2 * Math.PI, 1e-9);
    expect(first.chartLines).toHaveLength(2);

    // Y selected: Y's domain, and the relation stated in Y drawn flat in it.
    const second = build(rows[1]!.id);
    closeRel(second.chartBounds!.u[1], 3, 1e-9);
    closeRel(second.chartBounds!.v[1], 4, 1e-9);
    expect(second.chartLines.length).toBeGreaterThan(2);

    // A row with no chart of its own leaves the inset where it was.
    const third = build(rows[2]!.id);
    closeRel(third.chartBounds!.u[1], 2 * Math.PI, 1e-9);
  });

  it("keeps the inset showing one chart, not two at once", () => {
    // Two patches have two different (u, v) planes; drawing both in one square is a picture of
    // neither. The curve is on its own surface in 3D and simply absent from the other's inset.
    const document = createDocument([
      "X(u,v) = (u, v, 0)",
      "Y(u,v) = (u, v, 5)",
      "Y: c(t) = (t, t)",
    ]);
    const rows = document.rows();
    const resolved = document.resolution();
    const scene = buildScene({
      items: [...resolved.items.values()],
      parameters: new Map(),
      declaredParameters: resolved.declaredParameters,
      domains: new Map<RowId, DomainRange[]>(),
      resolution: 24,
      inChart: new Set<RowId>([rows[2]!.id]),
    });

    // Only the grid and the border: no curve was added to the first patch's chart.
    expect(scene.chartLines).toHaveLength(2);
  });
});
