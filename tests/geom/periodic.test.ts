import { describe, expect, it } from "vitest";
import { CATALOG } from "../../src/core/catalog/surfaces.ts";
import { buildDiffMap } from "../../src/core/jets/compile.ts";
import { parse } from "../../src/core/expr/parse.ts";
import { createParametricSurface } from "../../src/core/geom/parametric.ts";
import { detectPeriodicity } from "../../src/core/geom/periodic.ts";
import { interval, type Interval } from "../../src/core/geom/types.ts";

/**
 * Periodicity is measured rather than declared, so the catalog's hand-written flags become an
 * independent oracle: fifteen templates whose seams a person decided, against a routine that
 * decides from the parametrization alone. Neither was derived from the other.
 */

let nextId = 0;

function surfaceOf(components: readonly string[], u: Interval, v: Interval) {
  const map = buildDiffMap({
    // A fresh id per surface, so nothing is served from a cache keyed on it.
    id: `periodic-test-${nextId++}`,
    comps: components.map((source) => parse(source).expr!),
    vars: ["u", "v"],
    order: 2,
  });
  return createParametricSurface({ id: "t", map, u, v });
}

describe("detecting a chart seam", () => {
  for (const entry of CATALOG) {
    it(`agrees with the catalog for ${entry.id}`, () => {
      const paramNames = entry.params.map((p) => p.key);
      const map = buildDiffMap({
        id: `periodic-catalog-${entry.id}`,
        comps: entry.components.map((source) => parse(source).expr!),
        vars: ["u", "v"],
        params: paramNames,
        order: 2,
      });
      const surface = createParametricSurface({ id: entry.id, map, u: entry.u, v: entry.v });
      const params = Float64Array.from(entry.params.map((p) => p.default));

      const found = detectPeriodicity(surface, params);
      expect(found.u, `${entry.id}: u`).toBe(entry.periodicU ?? false);
      expect(found.v, `${entry.id}: v`).toBe(entry.periodicV ?? false);
    });
  }

  it("calls a plane aperiodic in both coordinates", () => {
    const plane = surfaceOf(["u", "v", "0"], interval(0, 1), interval(0, 1));
    expect(detectPeriodicity(plane, new Float64Array(0))).toEqual({ u: false, v: false });
  });

  it("finds the seam of a cylinder in the coordinate that closes", () => {
    const cylinder = surfaceOf(["cos v", "sin v", "u"], interval(0, 2), interval(0, 2 * Math.PI));
    expect(detectPeriodicity(cylinder, new Float64Array(0))).toEqual({ u: false, v: true });
  });

  it("is not fooled by a scale far from 1", () => {
    // The whole reason the comparison is relative. A sphere of radius 1e-4 has boundary points
    // millimetres apart in absolute terms; a sphere of radius 1e6 has them kilometres apart.
    for (const radius of ["0.0001", "1000000"]) {
      const sphere = surfaceOf(
        [`${radius} sin u cos v`, `${radius} sin u sin v`, `${radius} cos u`],
        interval(0, Math.PI, 0.01),
        interval(0, 2 * Math.PI),
      );
      expect(detectPeriodicity(sphere, new Float64Array(0)), `radius ${radius}`).toEqual({
        u: false,
        v: true,
      });
    }
  });

  it("does not mistake a nearly-closed chart for a closed one", () => {
    // v stops just short of 2π, so the surface genuinely has an open sliver. Reporting it
    // periodic would let a geodesic cross a gap that is really there.
    const almost = surfaceOf(
      ["cos v", "sin v", "u"],
      interval(0, 1),
      interval(0, 2 * Math.PI - 0.05),
    );
    expect(detectPeriodicity(almost, new Float64Array(0)).v).toBe(false);
  });

  it("survives a domain inset on the periodic coordinate", () => {
    // Insetting pulls sampling in from both ends, so the two edges are close but not identical.
    // A tolerance too tight here would silently turn every inset seam back into a wall.
    const cylinder = surfaceOf(
      ["cos v", "sin v", "u"],
      interval(0, 2),
      interval(0, 2 * Math.PI, 1e-9),
    );
    expect(detectPeriodicity(cylinder, new Float64Array(0)).v).toBe(true);
  });

  it("reports a wall when the boundary cannot be evaluated", () => {
    // log(u) is non-finite at u = 0, so nothing can be concluded and the safe reading is a wall.
    const bad = surfaceOf(["u", "v", "log u"], interval(0, 1), interval(0, 1));
    expect(detectPeriodicity(bad, new Float64Array(0)).u).toBe(false);
  });
});
