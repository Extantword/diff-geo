import { describe, expect, it } from "vitest";
import { createDocument, type RowId } from "../../src/state/graph.ts";
import { buildScene, type DomainRange } from "../../src/state/scene.ts";
import { chartGrid, chartLift } from "../../src/state/chart.ts";
import { marchingSquares } from "../../src/core/mesh/contour.ts";

const closeRel = (a: number, b: number, rel = 1e-6) =>
  expect(Math.abs(a - b)).toBeLessThan(rel * Math.max(1, Math.abs(a), Math.abs(b)));

function sceneWithChart(sources: readonly string[], chartRows: number[] = []) {
  const document = createDocument(sources);
  const resolved = document.resolution();
  const items = [...resolved.items.values()];
  const rows = document.rows();
  const inChart = new Set<RowId>(chartRows.map((index) => rows[index]!.id));
  const scene = buildScene({
    items,
    parameters: new Map(),
    declaredParameters: resolved.declaredParameters,
    domains: new Map<RowId, DomainRange[]>(),
    resolution: 24,
    inChart,
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
    expect(report?.warning).toContain("outside the domain");
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
    expect(report?.warning).toContain("leaves the domain");
  });

  it("draws a relation's level set in the chart and on the surface", () => {
    const { document, scene } = sceneWithChart([
      "X(u,v) = (u, v, 0)",
      "(u - 3)^2 + (v - 3)^2 = 1",
    ]);
    const report = scene.reports.find((r) => r.rowId === document.rows()[1]!.id);
    expect(report?.info).toContain("contour segments");

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
    expect(report?.info).toContain("no solutions");
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
