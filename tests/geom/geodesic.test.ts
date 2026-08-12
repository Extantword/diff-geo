import { describe, expect, it } from "vitest";
import { buildSurface, CATALOG_BY_ID, paramsWith } from "../../src/core/catalog/surfaces.ts";
import {
  integrateCurvatureLine,
  integrateGeodesic,
  metricNorm,
  orthonormalFrame,
  sprayDirections,
} from "../../src/core/geom/geodesic.ts";
import { makeChartData, makeSurfacePoint, type Vec3 } from "../../src/core/geom/types.ts";

/**
 * Ground truth for geodesics.
 *
 * These are the assertions that decide whether the integrator and the connection are right, and
 * they are chosen so that "the picture looks plausible" cannot pass them. Clairaut's relation in
 * particular is a conserved quantity along any geodesic on a surface of revolution — an
 * independent constraint the code knows nothing about, so agreeing with it is real evidence.
 */

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

function surfaceOf(id: string, overrides: Readonly<Record<string, number>> = {}) {
  const spec = CATALOG_BY_ID[id]!;
  return { surface: buildSurface(spec).surface, params: paramsWith(spec, overrides) };
}

describe("geodesics on the sphere are great circles", () => {
  it("keeps every sample in one plane through the centre", () => {
    // The defining property, and one an integrator with a wrong Christoffel symbol cannot fake:
    // a great circle is the intersection of the sphere with a plane through the origin.
    const { surface, params } = surfaceOf("sphere", { R: 1 });
    const result = integrateGeodesic(surface, params, [Math.PI / 2, 0], [0.6, 1], 2.2);

    expect(result.path.length).toBeGreaterThan(150);
    const a = result.path[0]!;
    const b = result.path[Math.floor(result.path.length / 2)]!;
    const normal = cross(a, b);
    const length = Math.hypot(...normal) || 1;
    const unit: Vec3 = [normal[0] / length, normal[1] / length, normal[2] / length];

    for (const point of result.path) {
      expect(Math.abs(dot(point, unit))).toBeLessThan(1e-3);
    }
  });

  it("leaves the equator alone", () => {
    // Shooting along v from the equator must stay at u = π/2 exactly; any spurious term in
    // Γᵘᵥᵥ would push it off.
    const { surface, params } = surfaceOf("sphere", { R: 1 });
    const result = integrateGeodesic(surface, params, [Math.PI / 2, 0], [0, 1], 3);
    for (const [u] of result.chart) {
      expect(Math.abs(u - Math.PI / 2)).toBeLessThan(1e-6);
    }
  });

  it("stays on the sphere", () => {
    const { surface, params } = surfaceOf("sphere", { R: 1.7 });
    const result = integrateGeodesic(surface, params, [1.1, 0.4], [1, 0.7], 2);
    for (const point of result.path) {
      expect(Math.abs(Math.hypot(...point) - 1.7)).toBeLessThan(1e-6);
    }
  });
});

describe("arc-length parametrization", () => {
  it("holds unit metric speed on every catalog surface", () => {
    // The direction is normalized to unit metric speed, so the integration parameter IS arc
    // length and the speed must not drift. This is a joint check on the connection and the
    // integrator: an error in either shows up as the speed wandering.
    for (const id of ["sphere", "torus", "hyperbolic-paraboloid", "catenoid"]) {
      const { surface, params } = surfaceOf(id);
      const [u0, u1] = [surface.u.min, surface.u.max];
      const [v0, v1] = [surface.v.min, surface.v.max];
      const start: [number, number] = [
        u0 + (u1 - u0) * 0.5,
        v0 + (v1 - v0) * 0.35,
      ];
      const result = integrateGeodesic(surface, params, start, [1, 0.6], 1.2);

      expect(result.speeds.length).toBeGreaterThan(150);
      for (const speed of result.speeds) {
        expect(Math.abs(speed - 1), `${id} speed drifted to ${speed}`).toBeLessThan(1e-6);
      }
    }
  });
});

describe("Clairaut's relation on surfaces of revolution", () => {
  /**
   * For X(u,v) = (f(u) cos v, f(u) sin v, g(u)) the quantity f(u)² v̇ is conserved along a
   * geodesic — the angular-momentum integral, equivalently r sin θ = const.
   *
   * The code has no notion of this, so it is genuine independent evidence rather than a
   * restatement of what the integrator computes.
   */
  function clairautSpread(id: string, radius: (u: number, params: Float64Array) => number) {
    const { surface, params } = surfaceOf(id);
    const start: [number, number] = [
      surface.u.min + (surface.u.max - surface.u.min) * 0.45,
      surface.v.min + (surface.v.max - surface.v.min) * 0.3,
    ];
    const result = integrateGeodesic(surface, params, start, [0.7, 1], 1.5);

    // v̇ is recovered from consecutive chart samples, which is why the tolerance is a difference
    // quotient's rather than the integrator's.
    const values: number[] = [];
    for (let i = 1; i < result.chart.length; i++) {
      const [uPrev, vPrev] = result.chart[i - 1]!;
      const [u, v] = result.chart[i]!;
      const point = makeSurfacePoint();
      const chart = makeChartData();
      const uMid = (u + uPrev) / 2;
      const vMid = (v + vPrev) / 2;
      surface.at(uMid, vMid, params, point, chart);

      const du = u - uPrev;
      const dv = v - vPrev;
      const ds = metricNorm(chart.I, du, dv);
      if (!(ds > 1e-9)) continue;
      const f = radius(uMid, params);
      values.push(f * f * (dv / ds));
    }

    expect(values.length).toBeGreaterThan(150);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    let spread = 0;
    for (const value of values) spread = Math.max(spread, Math.abs(value - mean));
    return { spread, mean };
  }

  it("conserves f²v̇ on the sphere", () => {
    // f(u) = R sin u.
    const { spread, mean } = clairautSpread("sphere", (u, params) => params[0]! * Math.sin(u));
    expect(Math.abs(mean)).toBeGreaterThan(1e-3);
    expect(spread).toBeLessThan(1e-4 * Math.max(1, Math.abs(mean)) + 1e-4);
  });

  it("conserves f²v̇ on the torus", () => {
    // f(u) = R + r cos u.
    const { spread, mean } = clairautSpread(
      "torus",
      (u, params) => params[0]! + params[1]! * Math.cos(u),
    );
    expect(Math.abs(mean)).toBeGreaterThan(1e-3);
    expect(spread).toBeLessThan(1e-3 * Math.max(1, Math.abs(mean)) + 1e-3);
  });
});

describe("the cylinder is flat, so its geodesics are straight in the chart", () => {
  it("keeps a constant chart slope", () => {
    // On a flat surface with this parametrization every Γ vanishes, so the chart path is a
    // straight line. A single spurious Christoffel term would bend it.
    const { surface, params } = surfaceOf("cylinder", { r: 1 });
    const result = integrateGeodesic(surface, params, [1, 0], [1, 0.8], 2);

    const slopes: number[] = [];
    for (let i = 1; i < result.chart.length; i++) {
      const du = result.chart[i]![0] - result.chart[i - 1]![0];
      const dv = result.chart[i]![1] - result.chart[i - 1]![1];
      if (Math.abs(du) > 1e-9) slopes.push(dv / du);
    }
    expect(slopes.length).toBeGreaterThan(150);
    const first = slopes[0]!;
    for (const slope of slopes) {
      expect(Math.abs(slope - first)).toBeLessThan(1e-6);
    }
  });
});

describe("stopping reasons are reported, never a NaN-tailed path", () => {
  it("reports leaving the chart", () => {
    // The cylinder is not periodic in v, so a geodesic climbing it must run out of domain.
    const { surface, params } = surfaceOf("cylinder");
    const result = integrateGeodesic(surface, params, [0.5, 0], [0, 1], 50);
    expect(result.stop).toBe("outOfDomain");
    expect(result.length).toBeLessThan(50);
  });

  it("reaches the requested length when it can", () => {
    const { surface, params } = surfaceOf("torus");
    const result = integrateGeodesic(surface, params, [1, 1], [1, 0.5], 2);
    expect(result.stop).toBe("length");
    expect(result.length).toBeCloseTo(2, 3);
  });

  it("emits only finite values whatever the outcome", () => {
    for (const id of Object.keys(CATALOG_BY_ID)) {
      const { surface, params } = surfaceOf(id);
      const start: [number, number] = [
        surface.u.min + (surface.u.max - surface.u.min) * 0.5,
        surface.v.min + (surface.v.max - surface.v.min) * 0.5,
      ];
      const result = integrateGeodesic(surface, params, start, [1, 1], 3);
      for (const [u, v] of result.chart) {
        expect(Number.isFinite(u), `${id}`).toBe(true);
        expect(Number.isFinite(v), `${id}`).toBe(true);
      }
      for (const point of result.path) {
        for (const value of point) expect(Number.isFinite(value), `${id}`).toBe(true);
      }
    }
  });
});

describe("the metric-orthonormal frame", () => {
  it("is orthonormal in the metric, not in the chart", () => {
    // Gram–Schmidt with I, so a spray fans out at angles that mean something on the surface
    // rather than in coordinates.
    const { surface, params } = surfaceOf("torus");
    const point = makeSurfacePoint();
    const chart = makeChartData();
    surface.at(1.3, 0.7, params, point, chart);

    const { e1, e2 } = orthonormalFrame(chart.I);
    expect(metricNorm(chart.I, e1[0], e1[1])).toBeCloseTo(1, 9);
    expect(metricNorm(chart.I, e2[0], e2[1])).toBeCloseTo(1, 9);
    const inner =
      chart.I[0][0] * e1[0] * e2[0] +
      chart.I[0][1] * (e1[0] * e2[1] + e1[1] * e2[0]) +
      chart.I[1][1] * e1[1] * e2[1];
    expect(Math.abs(inner)).toBeLessThan(1e-9);
  });

  it("sprays evenly-angled unit directions", () => {
    const { surface, params } = surfaceOf("sphere");
    const point = makeSurfacePoint();
    const chart = makeChartData();
    surface.at(1.2, 0.5, params, point, chart);

    const directions = sprayDirections(chart.I, 12);
    expect(directions).toHaveLength(12);
    for (const [du, dv] of directions) {
      expect(metricNorm(chart.I, du, dv)).toBeCloseTo(1, 9);
    }
  });
});

describe("lines of curvature", () => {
  it("follows a coordinate curve on the torus", () => {
    /**
     * For the standard torus F = f = 0, so I and II are both diagonal and the principal
     * directions ARE the coordinate directions. A line of curvature therefore holds either u or
     * v fixed — which pins the eigenvector extraction, the chart-component conversion, and the
     * sign-continuity rule all at once.
     */
    const { surface, params } = surfaceOf("torus");
    for (const which of [1, 2] as const) {
      const result = integrateCurvatureLine(surface, params, [1.1, 0.6], which, 1.5);
      expect(result.chart.length).toBeGreaterThan(50);

      let uSpread = 0;
      let vSpread = 0;
      for (const [u, v] of result.chart) {
        uSpread = Math.max(uSpread, Math.abs(u - 1.1));
        vSpread = Math.max(vSpread, Math.abs(v - 0.6));
      }
      // One coordinate moves, the other must not.
      expect(Math.min(uSpread, vSpread)).toBeLessThan(1e-6);
      expect(Math.max(uSpread, vSpread)).toBeGreaterThan(0.1);
    }
  });

  it("does not double back on itself", () => {
    // resolveShape returns e1 only up to sign, so without the sign-continuity rule the
    // integrator reverses on some step and retraces the curve it just drew.
    const { surface, params } = surfaceOf("torus");
    const result = integrateCurvatureLine(surface, params, [1.1, 0.6], 1, 2);
    const steps: number[] = [];
    for (let i = 1; i < result.chart.length; i++) {
      steps.push(result.chart[i]![0] - result.chart[i - 1]![0]);
    }
    const forward = steps.filter((s) => s > 1e-12).length;
    const backward = steps.filter((s) => s < -1e-12).length;
    // Monotone in u: all steps go the same way.
    expect(Math.min(forward, backward)).toBe(0);
    expect(Math.max(forward, backward)).toBeGreaterThan(50);
  });

  it("stops at an umbilic instead of drawing an arbitrary choice", () => {
    // Every point of a sphere is umbilic, so the principal directions are genuinely arbitrary
    // and lines of curvature branch everywhere. Stopping is correct behaviour, not a shortfall.
    const { surface, params } = surfaceOf("sphere");
    const result = integrateCurvatureLine(surface, params, [1.2, 0.5], 1, 1);
    expect(result.stop).toBe("umbilic");
  });

  it("emits only finite chart coordinates", () => {
    for (const id of ["torus", "catenoid", "hyperbolic-paraboloid", "monkey-saddle"]) {
      const { surface, params } = surfaceOf(id);
      const start: [number, number] = [
        surface.u.min + (surface.u.max - surface.u.min) * 0.45,
        surface.v.min + (surface.v.max - surface.v.min) * 0.55,
      ];
      const result = integrateCurvatureLine(surface, params, start, 1, 1);
      for (const [u, v] of result.chart) {
        expect(Number.isFinite(u), `${id}`).toBe(true);
        expect(Number.isFinite(v), `${id}`).toBe(true);
      }
    }
  });
});
