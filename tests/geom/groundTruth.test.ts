import { describe, expect, it } from "vitest";
import {
  buildSurface,
  CATALOG,
  CATALOG_BY_ID,
  paramsWith,
} from "../../src/core/catalog/surfaces.ts";
import {
  makeChartData,
  makeSurfacePoint,
  sampleBounds,
  type SurfacePoint,
  type Vec3,
} from "../../src/core/geom/types.ts";

/**
 * Analytic ground truth, from do Carmo. Never weakened to make a test pass — a failure
 * here means the mathematics is wrong, not that the tolerance was optimistic.
 *
 * Everything is driven through the real pipeline: the catalog stores the surfaces as
 * source text, so each assertion exercises parse → diff → simplify → compile → jets →
 * fundamental forms → shape operator.
 */

const closeRel = (a: number, b: number, rel = 1e-9) =>
  expect(Math.abs(a - b)).toBeLessThan(rel * Math.max(1, Math.abs(a), Math.abs(b)));

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function surfaceOf(id: string, overrides: Readonly<Record<string, number>> = {}) {
  const spec = CATALOG_BY_ID[id]!;
  const built = buildSurface(spec);
  return { spec, surface: built.surface, params: paramsWith(spec, overrides) };
}

/**
 * H, k₁ and k₂ flip with the choice of unit normal, so a test that hard-codes their
 * sign is really testing which way X_u × X_v happens to point for one component
 * ordering. Instead: compare the computed N against an independently known outward
 * direction, and assert the magnitude with the sign that orientation implies.
 *
 * The reference convention is the sphere's — with the **outward** normal, a sphere of
 * radius R has H = −1/R. So for a surface that is convex outward with positive principal
 * curvature magnitudes `m`, the expected H is `−orientation · m`.
 */
function expectMeanCurvature(
  point: SurfacePoint,
  outward: Vec3,
  convexMagnitude: number,
  rel = 1e-8,
): void {
  const orientation = Math.sign(dot(point.N, outward));
  expect(Math.abs(orientation)).toBe(1);
  closeRel(point.H, -orientation * convexMagnitude, rel);
}

describe("sphere", () => {
  it("has K = 1/R² and H = −1/R with the outward normal", () => {
    for (const R of [0.5, 1, 2.5]) {
      const { surface, params } = surfaceOf("sphere", { R });
      const point = makeSurfacePoint();
      for (const [u, v] of [
        [0.4, 0.7],
        [1.2, 3.1],
        [2.6, 5.5],
        [Math.PI / 2, 0],
      ]) {
        surface.at(u!, v!, params, point);
        expect(point.degenerate).toBe(false);
        closeRel(point.K, 1 / (R * R), 1e-9);
        // The outward direction is the position vector itself.
        const outward: Vec3 = [point.p[0], point.p[1], point.p[2]];
        expectMeanCurvature(point, outward, 1 / R, 1e-9);
      }
    }
  });

  it("is umbilic at every point, with k₁ = k₂", () => {
    const { surface, params } = surfaceOf("sphere", { R: 1.4 });
    const point = makeSurfacePoint();
    for (const [u, v] of [
      [0.4, 0.7],
      [1.9, 2.2],
      [2.9, 4.4],
    ]) {
      surface.at(u!, v!, params, point);
      expect(point.umbilic).toBe(true);
      expect(point.planar).toBe(false);
      closeRel(point.k1, point.k2, 1e-9);
    }
  });

  it("is degenerate exactly at the poles", () => {
    const { surface, params } = surfaceOf("sphere");
    const point = makeSurfacePoint();
    surface.at(0, 1, params, point);
    expect(point.degenerate).toBe(true);
    surface.at(Math.PI, 1, params, point);
    expect(point.degenerate).toBe(true);
  });
});

describe("torus of revolution", () => {
  it("has K = cos u / (r(R + r cos u))", () => {
    for (const [R, r] of [
      [2, 0.7],
      [3, 1],
      [1.5, 0.4],
    ]) {
      const { surface, params } = surfaceOf("torus", { R: R!, r: r! });
      const point = makeSurfacePoint();
      for (const u of [0, 0.6, Math.PI / 2, 2.2, Math.PI, 4.7]) {
        for (const v of [0, 1.3, 5.0]) {
          surface.at(u, v, params, point);
          const expected = Math.cos(u) / (r! * (R! + r! * Math.cos(u)));
          closeRel(point.K, expected, 1e-8);
        }
      }
    }
  });

  it("has K = 0 exactly on the top and bottom circles", () => {
    const { surface, params } = surfaceOf("torus");
    const point = makeSurfacePoint();
    for (const v of [0, 2.1, 4.9]) {
      surface.at(Math.PI / 2, v, params, point);
      expect(Math.abs(point.K)).toBeLessThan(1e-12);
      surface.at((3 * Math.PI) / 2, v, params, point);
      expect(Math.abs(point.K)).toBeLessThan(1e-12);
    }
  });

  it("has H = (R + 2r cos u) / (2r(R + r cos u)) up to orientation", () => {
    const R = 2;
    const r = 0.7;
    const { surface, params } = surfaceOf("torus", { R, r });
    const point = makeSurfacePoint();
    for (const u of [0, 0.9, 2.4, 4.1]) {
      for (const v of [0.3, 3.7]) {
        surface.at(u, v, params, point);
        // Outward from the centre of the tube, known independently of the code.
        const outward: Vec3 = [
          Math.cos(u) * Math.cos(v),
          Math.cos(u) * Math.sin(v),
          Math.sin(u),
        ];
        const magnitude = (R + 2 * r * Math.cos(u)) / (2 * r * (R + r * Math.cos(u)));
        expectMeanCurvature(point, outward, magnitude, 1e-8);
      }
    }
  });
});

describe("cylinder", () => {
  it("is flat: K = 0, with one vanishing principal curvature", () => {
    for (const r of [0.5, 1, 1.8]) {
      const { surface, params } = surfaceOf("cylinder", { r });
      const point = makeSurfacePoint();
      for (const [u, v] of [
        [0.3, -1],
        [2.2, 0.5],
        [5.1, 1.7],
      ]) {
        surface.at(u!, v!, params, point);
        expect(Math.abs(point.K)).toBeLessThan(1e-12);
        // k₁ ≥ k₂, and exactly one of them is zero: the rulings are asymptotic.
        const magnitudes = [Math.abs(point.k1), Math.abs(point.k2)].sort((a, b) => a - b);
        expect(magnitudes[0]!).toBeLessThan(1e-12);
        closeRel(magnitudes[1]!, 1 / r, 1e-9);
        closeRel(Math.abs(point.H), 1 / (2 * r), 1e-9);
      }
    }
  });
});

describe("minimal surfaces have H = 0", () => {
  it("holds for the catenoid, with K = −1/(c² cosh⁴(v/c))", () => {
    for (const c of [0.5, 1, 1.7]) {
      const { surface, params } = surfaceOf("catenoid", { c });
      const point = makeSurfacePoint();
      for (const [u, v] of [
        [0.4, -1.1],
        [2.7, 0],
        [5.2, 1.4],
      ]) {
        surface.at(u!, v!, params, point);
        expect(Math.abs(point.H)).toBeLessThan(1e-9);
        const cosh = Math.cosh(v! / c);
        closeRel(point.K, -1 / (c * c * cosh ** 4), 1e-8);
      }
    }
  });

  it("holds for the helicoid, with K = −c²/(c² + u²)²", () => {
    for (const c of [0.3, 0.5, 1.2]) {
      const { surface, params } = surfaceOf("helicoid", { c });
      const point = makeSurfacePoint();
      for (const [u, v] of [
        [-1.5, 0.6],
        [0, 2.2],
        [1.1, 5.9],
      ]) {
        surface.at(u!, v!, params, point);
        expect(Math.abs(point.H)).toBeLessThan(1e-9);
        closeRel(point.K, -(c * c) / (c * c + u! * u!) ** 2, 1e-8);
      }
    }
  });

  it("holds for Enneper, with K = −4/(1 + u² + v²)⁴", () => {
    const { surface, params } = surfaceOf("enneper");
    const point = makeSurfacePoint();
    for (const [u, v] of [
      [0, 0],
      [0.5, -0.7],
      [1.1, 0.9],
      [-1.2, 1.2],
    ]) {
      surface.at(u!, v!, params, point);
      expect(Math.abs(point.H)).toBeLessThan(1e-8);
      const s = 1 + u! * u! + v! * v!;
      closeRel(point.K, -4 / s ** 4, 1e-8);
    }
  });

  it("reproduces Enneper's first and second fundamental forms", () => {
    // E = G = (1+u²+v²)², F = 0, and |e| = |g| = 2 with f = 0.
    const { surface, params } = surfaceOf("enneper");
    const point = makeSurfacePoint();
    const chart = makeChartData();
    for (const [u, v] of [
      [0.3, 0.4],
      [-0.8, 1.1],
    ]) {
      surface.at(u!, v!, params, point, chart);
      const s = (1 + u! * u! + v! * v!) ** 2;
      closeRel(chart.I[0][0], s, 1e-9);
      closeRel(chart.I[1][1], s, 1e-9);
      expect(Math.abs(chart.I[0][1])).toBeLessThan(1e-9);
      expect(Math.abs(chart.II[0][1])).toBeLessThan(1e-9);
      closeRel(Math.abs(chart.II[0][0]), 2, 1e-9);
      closeRel(Math.abs(chart.II[1][1]), 2, 1e-9);
      // e and g have opposite signs, which is why H vanishes.
      expect(chart.II[0][0] * chart.II[1][1]).toBeLessThan(0);
    }
  });
});

describe("the sphere, charted stereographically", () => {
  /**
   * do Carmo §2-2, exercise 16. The point of the example is that **one** chart covers the whole
   * sphere but a single point — a compact surface cannot be covered by one chart, and this is how
   * close it is possible to come. The invariant that says the transcription is right is that the
   * image really is the sphere `x² + y² + (z − 1)² = 1`, and that K = 1 on all of it.
   */
  it("lands on the sphere of radius 1 centred at (0, 0, 1)", () => {
    const { surface, params } = surfaceOf("stereographic");
    const point = makeSurfacePoint();
    for (const u of [-5.5, -1.2, 0, 0.8, 4.9]) {
      for (const v of [-4.1, 0, 2.3]) {
        surface.at(u, v, params, point);
        const r = Math.hypot(point.p[0], point.p[1], point.p[2] - 1);
        closeRel(r, 1, 1e-12);
      }
    }
  });

  it("has K = 1 everywhere, however far out the chart runs", () => {
    // The chart distorts wildly — a bounded region of the plane maps to almost the whole sphere —
    // and the curvature does not care: K is intrinsic, and the sphere's is 1 whatever chart is
    // used to say so.
    const { surface, params } = surfaceOf("stereographic");
    const point = makeSurfacePoint();
    for (const u of [-6, -2.4, 0.1, 3.3, 6]) {
      for (const v of [-6, -0.7, 1.9, 5.2]) {
        surface.at(u, v, params, point);
        expect(point.degenerate, `(${u}, ${v})`).toBe(false);
        closeRel(point.K, 1, 1e-9);
        expect(point.umbilic, `umbilic at (${u}, ${v})`).toBe(true);
      }
    }
  });

  it("never reaches the pole it projects from", () => {
    // z → 2 only as |(u, v)| → ∞. The missing point is the whole content of the exercise.
    const { surface, params } = surfaceOf("stereographic");
    const point = makeSurfacePoint();
    surface.at(200, 200, params, point);
    expect(point.p[2]).toBeLessThan(2);
    expect(point.p[2]).toBeGreaterThan(1.99);
  });
});

describe("the minimal surfaces added later, checked the same way", () => {
  /**
   * H = 0 is what makes a surface minimal, and it is a demanding test of a transcribed formula:
   * a mistyped coefficient anywhere in three components leaves a surface that still renders and
   * still looks plausible, and whose mean curvature is not zero. Both of these came out of the
   * literature and neither is obvious by eye, so this is how they are known to be right.
   */
  it("holds for Catalan's surface", () => {
    const { surface, params } = surfaceOf("catalan");
    const point = makeSurfacePoint();
    for (const u of [0.7, 3.1, 7.4, 11.2]) {
      for (const v of [-1.1, -0.3, 0.5, 1.15]) {
        surface.at(u, v, params, point);
        expect(point.degenerate, `(${u}, ${v})`).toBe(false);
        expect(Math.abs(point.H), `H at (${u}, ${v})`).toBeLessThan(1e-9);
      }
    }
  });

  it("holds for Scherk's first surface", () => {
    // z = log(cos v / cos u), the only minimal graph over a square — and it runs to infinity at
    // the edges, which is why the domain stops just inside them.
    const { surface, params } = surfaceOf("scherk");
    const point = makeSurfacePoint();
    for (const u of [-1.4, -0.6, 0.2, 1.3]) {
      for (const v of [-1.35, 0, 1.1]) {
        surface.at(u, v, params, point);
        expect(Math.abs(point.H), `H at (${u}, ${v})`).toBeLessThan(1e-9);
      }
    }
  });
});

describe("the other surfaces of constant curvature K = −1", () => {
  /**
   * The pseudosphere is not the only one. Both of these are pseudospherical — the breather comes
   * from a breather solution of the sine-Gordon equation, and Kuen's surface is a Bäcklund
   * transform of the pseudosphere — so they share its intrinsic geometry while sitting in space
   * completely differently. K = −1 everywhere is the check, and for formulas this long it is the
   * only practical one.
   */
  it("holds for the breather surface", () => {
    const { surface, params } = surfaceOf("breather");
    const point = makeSurfacePoint();
    for (const u of [-11, -3.2, 0.5, 9.4]) {
      for (const v of [0.4, 3.1, 7.7, 11.5]) {
        surface.at(u, v, params, point);
        expect(point.degenerate, `(${u}, ${v})`).toBe(false);
        closeRel(point.K, -1, 1e-7);
      }
    }
  });

  it("holds for Kuen's surface", () => {
    const { surface, params } = surfaceOf("kuen");
    const point = makeSurfacePoint();
    for (const u of [0.2, 1.4, 3.0, 4.3]) {
      for (const v of [0.2, 1.1, 2.0, 2.8]) {
        surface.at(u, v, params, point);
        expect(point.degenerate, `(${u}, ${v})`).toBe(false);
        closeRel(point.K, -1, 1e-7);
      }
    }
  });
});

describe("ruled surfaces are ruled", () => {
  /**
   * A ruled surface has a straight line through every point, and a straight line has no normal
   * curvature — so one principal curvature is ≤ 0 and the other ≥ 0, which is to say **K ≤ 0**.
   * That is a real check on a transcription: it fails for anything that is not ruled.
   */
  for (const [id, us, vs] of [
    ["hyperboloid", [0.3, 2.2, 4.9], [-1.2, 0, 0.9]],
    ["plucker-conoid", [0.4, 2.6, 5.1], [0.3, 0.9, 1.4]],
    ["cone", [0.6, 3.3, 5.9], [0.3, 1.0, 1.5]],
    ["whitney", [-1.2, 0.4, 1.4], [-1.2, 0.6, 1.3]],
  ] as const) {
    it(`holds for ${id}`, () => {
      const { surface, params } = surfaceOf(id);
      const point = makeSurfacePoint();
      for (const u of us) {
        for (const v of vs) {
          surface.at(u, v, params, point);
          if (point.degenerate) continue;
          expect(point.K, `K at (${u}, ${v}) on ${id}`).toBeLessThanOrEqual(1e-9);
        }
      }
    });
  }

  it("gives the cone K = 0, since it is developable", () => {
    // Flat but not planar: a cone is a sheet of paper rolled up, so K vanishes identically while
    // H does not.
    const { surface, params } = surfaceOf("cone");
    const point = makeSurfacePoint();
    for (const u of [0.5, 2.5, 4.5]) {
      for (const v of [0.4, 1.1, 1.55]) {
        surface.at(u, v, params, point);
        expect(Math.abs(point.K), `K at (${u}, ${v})`).toBeLessThan(1e-9);
        expect(Math.abs(point.H)).toBeGreaterThan(1e-6);
      }
    }
  });
});

describe("pseudosphere", () => {
  it("has constant negative curvature K = −1", () => {
    const { surface, params } = surfaceOf("pseudosphere");
    const point = makeSurfacePoint();
    for (const u of [0.3, 0.9, 1.8, 2.6]) {
      for (const v of [0, 2.5, 5.8]) {
        surface.at(u, v, params, point);
        closeRel(point.K, -1, 1e-7);
      }
    }
  });
});

describe("planar and saddle points", () => {
  it("finds a planar point at the origin of the monkey saddle", () => {
    const { surface, params } = surfaceOf("monkey-saddle");
    const point = makeSurfacePoint();
    surface.at(0, 0, params, point);
    expect(point.degenerate).toBe(false);
    expect(Math.abs(point.K)).toBeLessThan(1e-12);
    expect(Math.abs(point.H)).toBeLessThan(1e-12);
    // k₁ = k₂ = 0 — umbilic *and* planar, the degenerate case that breaks naive
    // principal-direction code.
    expect(point.umbilic).toBe(true);
    expect(point.planar).toBe(true);
  });

  it("matches the closed form for the monkey saddle away from the origin", () => {
    const { surface, params } = surfaceOf("monkey-saddle");
    const point = makeSurfacePoint();
    for (const [u, v] of [
      [0.5, 0.3],
      [-0.7, 0.9],
      [1.1, -0.4],
    ]) {
      surface.at(u!, v!, params, point);
      const W2 = 1 + 9 * (u! * u! - v! * v!) ** 2 + 36 * u! * u! * v! * v!;
      closeRel(point.K, (-36 * (u! * u! + v! * v!)) / W2 ** 2, 1e-8);
    }
  });

  it("gives K = −4a² at the centre of the hyperbolic paraboloid", () => {
    for (const a of [0.5, 1, 1.75]) {
      const { surface, params } = surfaceOf("hyperbolic-paraboloid", { a });
      const point = makeSurfacePoint();
      surface.at(0, 0, params, point);
      closeRel(point.K, -4 * a * a, 1e-9);
      expect(Math.abs(point.H)).toBeLessThan(1e-12);
    }
  });
});

describe("catalog-wide invariants", () => {
  /** Interior sample points, avoiding the inset boundary. */
  function* samples(id: string): Generator<[number, number]> {
    const spec = CATALOG_BY_ID[id]!;
    const [u0, u1] = sampleBounds(spec.u);
    const [v0, v1] = sampleBounds(spec.v);
    for (let i = 1; i < 5; i++) {
      for (let j = 1; j < 5; j++) {
        yield [u0 + ((u1 - u0) * i) / 5, v0 + ((v1 - v0) * j) / 5];
      }
    }
  }

  for (const spec of CATALOG) {
    describe(spec.id, () => {
      const { surface, params } = surfaceOf(spec.id);

      it("has a symmetric positive-definite first fundamental form", () => {
        const point = makeSurfacePoint();
        const chart = makeChartData();
        for (const [u, v] of samples(spec.id)) {
          surface.at(u, v, params, point, chart);
          expect(chart.I[0][1]).toBe(chart.I[1][0]);
          expect(chart.I[0][0]).toBeGreaterThan(0);
          expect(chart.I[0][0] * chart.I[1][1] - chart.I[0][1] ** 2).toBeGreaterThan(0);
        }
      });

      it("has a symmetric second fundamental form", () => {
        const point = makeSurfacePoint();
        const chart = makeChartData();
        for (const [u, v] of samples(spec.id)) {
          surface.at(u, v, params, point, chart);
          expect(chart.II[0][1]).toBe(chart.II[1][0]);
        }
      });

      it("has Christoffel symbols symmetric in their lower indices", () => {
        const point = makeSurfacePoint();
        const chart = makeChartData();
        for (const [u, v] of samples(spec.id)) {
          surface.at(u, v, params, point, chart);
          for (let k = 0; k < 2; k++) {
            closeRel(chart.Gamma[k]![0]![1]!, chart.Gamma[k]![1]![0]!, 1e-12);
          }
        }
      });

      it("satisfies k₁ ≥ k₂, k₁k₂ = K and k₁ + k₂ = 2H by construction", () => {
        const point = makeSurfacePoint();
        for (const [u, v] of samples(spec.id)) {
          surface.at(u, v, params, point);
          expect(point.degenerate).toBe(false);
          expect(point.k1).toBeGreaterThanOrEqual(point.k2);
          closeRel(point.k1 * point.k2, point.K, 1e-9);
          closeRel(point.k1 + point.k2, 2 * point.H, 1e-9);
        }
      });

      it("has a unit normal and an orthonormal principal frame", () => {
        const point = makeSurfacePoint();
        for (const [u, v] of samples(spec.id)) {
          surface.at(u, v, params, point);
          closeRel(Math.hypot(...point.N), 1, 1e-9);
          closeRel(Math.hypot(...point.e1), 1, 1e-9);
          closeRel(Math.hypot(...point.e2), 1, 1e-9);
          // Principal directions are tangent and mutually orthogonal.
          expect(Math.abs(dot(point.e1, point.e2))).toBeLessThan(1e-9);
          expect(Math.abs(dot(point.e1, point.N))).toBeLessThan(1e-9);
          expect(Math.abs(dot(point.e2, point.N))).toBeLessThan(1e-9);
        }
      });

      it("agrees with do Carmo's closed forms for K and H", () => {
        // The strongest single invariant available: the eigendecomposition path must
        // reproduce K = (eg − f²)/(EG − F²) and H = ½(eG − 2fF + gE)/(EG − F²), which
        // this implementation deliberately does not use.
        const point = makeSurfacePoint();
        const chart = makeChartData();
        for (const [u, v] of samples(spec.id)) {
          surface.at(u, v, params, point, chart);
          const E = chart.I[0][0];
          const F = chart.I[0][1];
          const G = chart.I[1][1];
          const e = chart.II[0][0];
          const f = chart.II[0][1];
          const g = chart.II[1][1];
          const det = E * G - F * F;
          closeRel(point.K, (e * g - f * f) / det, 1e-8);
          closeRel(point.H, (e * G - 2 * f * F + g * E) / (2 * det), 1e-8);
        }
      });

      it("flips H, k₁ and k₂ but not K when the orientation is reversed", () => {
        const point = makeSurfacePoint();
        const flipped = makeSurfacePoint();
        for (const [u, v] of samples(spec.id)) {
          surface.flipped = false;
          surface.at(u, v, params, point);
          surface.flipped = true;
          surface.at(u, v, params, flipped);
          surface.flipped = false;

          closeRel(flipped.K, point.K, 1e-9);
          closeRel(flipped.H, -point.H, 1e-9);
          // k₁ ≥ k₂ is maintained, so the pair swaps as well as negating.
          closeRel(flipped.k1, -point.k2, 1e-9);
          closeRel(flipped.k2, -point.k1, 1e-9);
        }
      });
    });
  }
});
