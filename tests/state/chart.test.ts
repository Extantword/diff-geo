import { describe, expect, it } from "vitest";
import { createDocument, type RowId } from "../../src/state/graph.ts";
import { buildScene, type DomainRange } from "../../src/state/scene.ts";
import { chartGrid, chartLift } from "../../src/state/chart.ts";

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
