import { describe, expect, it } from "vitest";
import { CATALOG } from "../../src/core/catalog/surfaces.ts";
import { buildDiffMap } from "../../src/core/jets/compile.ts";
import { parse } from "../../src/core/expr/parse.ts";
import { createParametricSurface } from "../../src/core/geom/parametric.ts";
import { detectPeriodicity, detectPoles } from "../../src/core/geom/periodic.ts";
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

describe("telling a coordinate pole from an edge of the surface", () => {
  /**
   * The distinction decides whether a geodesic reaching a boundary has left the surface or merely
   * run out of chart, which is the difference between stopping correctly and stopping for no
   * reason the user can see.
   */

  it("finds both of the sphere's u boundaries to be poles", () => {
    const sphere = surfaceOf(
      ["sin u cos v", "sin u sin v", "cos u"],
      interval(0, Math.PI, 0.002),
      interval(0, 2 * Math.PI),
    );
    const poles = detectPoles(sphere, new Float64Array(0));
    expect(poles.uMin).toBe(true);
    expect(poles.uMax).toBe(true);
    // The seam is not a pole: v = 0 is a perfectly regular line of the surface.
    expect(poles.vMin).toBe(false);
    expect(poles.vMax).toBe(false);
  });

  it("finds no pole on a cylinder, whose rim is a real edge", () => {
    // The case the rule must NOT over-reach on: extending a geodesic past a cylinder's rim would
    // run it off the drawn surface into the analytic continuation.
    const cylinder = surfaceOf(["cos v", "sin v", "u"], interval(0, 2), interval(0, 2 * Math.PI));
    expect(detectPoles(cylinder, new Float64Array(0))).toEqual({
      uMin: false,
      uMax: false,
      vMin: false,
      vMax: false,
    });
  });

  it("finds a pole that a domain inset has already been folded into the bounds", () => {
    /**
     * The case that made this fail silently end to end. By the time a domain reaches the geometry
     * layer the inset has usually been applied, so the sphere arrives as u ∈ [0.0063, 3.1353]
     * rather than [0, π] with an inset — and 0.0063 is a perfectly regular point. Probing only
     * exactly at the boundary detects no pole, so nothing extends and every meridian still stops
     * at an invisible wall.
     */
    const inset = surfaceOf(
      ["sin u cos v", "sin u sin v", "cos u"],
      // No `inset` field: the bounds themselves are already pulled off the poles.
      interval(0.0063, Math.PI - 0.0063),
      interval(0, 2 * Math.PI),
    );
    const poles = detectPoles(inset, new Float64Array(0));
    expect(poles.uMin).toBe(true);
    expect(poles.uMax).toBe(true);
  });

  it("does not reach so far outside a boundary that an edge becomes a pole", () => {
    // The reach is bounded so an inset-sized nudge is found and nothing else is. A cylinder
    // truncated well short of anything degenerate must still read as an edge.
    const cylinder = surfaceOf(["cos v", "sin v", "u"], interval(0.5, 2), interval(0, 2 * Math.PI));
    const poles = detectPoles(cylinder, new Float64Array(0));
    expect(poles.uMin).toBe(false);
    expect(poles.uMax).toBe(false);
  });

  it("finds the apex of a cone but not its open end", () => {
    const cone = surfaceOf(["u cos v", "u sin v", "u"], interval(0, 2), interval(0, 2 * Math.PI));
    const poles = detectPoles(cone, new Float64Array(0));
    expect(poles.uMin).toBe(true);
    expect(poles.uMax).toBe(false);
  });

  it("does not call a boundary a pole when only one point of it is degenerate", () => {
    // A single degenerate sample is a pinch, not a collapsed edge, and continuing a geodesic
    // through it would not be justified. Here X_u vanishes only at v = 0.
    const pinched = surfaceOf(
      ["u v v", "v", "u"],
      interval(0, 1),
      interval(0, 1),
    );
    const poles = detectPoles(pinched, new Float64Array(0));
    expect(poles.vMin).toBe(false);
  });
});
