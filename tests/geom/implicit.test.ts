import { describe, expect, it } from "vitest";
import { buildSurface, CATALOG_BY_ID, paramsWith } from "../../src/core/catalog/surfaces.ts";
import { parse } from "../../src/core/expr/parse.ts";
import {
  boundLevelSet,
  createImplicitSurface,
  tangentBasis,
} from "../../src/core/geom/implicit.ts";
import { interval, makeSurfacePoint, type Vec3 } from "../../src/core/geom/types.ts";
import { buildDiffMap } from "../../src/core/jets/compile.ts";

/**
 * Level sets, against the closed forms — and against the parametric path.
 *
 * The second check is the one that matters most. K is convention-independent, but H, k₁ and k₂ all
 * flip with the choice of unit normal, and the two representations choose it differently:
 * X_u × X_v / |X_u × X_v| upstairs, ∇F/|∇F| downstairs. Two representations that disagreed about
 * it would report one surface as two different objects, so the sphere is computed both ways here
 * and the numbers have to be the same numbers.
 */

const close = (a: number, b: number, tol = 1e-9) =>
  expect(Math.abs(a - b), `${a} vs ${b}`).toBeLessThan(tol);

/** `F(x, y, z) = 0` from source text, over a box, through the real CAS. */
function implicit(source: string, params: readonly string[] = []) {
  const { expr, diags } = parse(source);
  expect(diags.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
  const map = buildDiffMap({
    id: `implicit-${source}`,
    comps: [expr!],
    vars: ["x", "y", "z"],
    params: [...params],
    order: 2,
  });
  return createImplicitSurface({
    id: `implicit-${source}`,
    map,
    x: interval(-2, 2),
    y: interval(-2, 2),
    z: interval(-2, 2),
  });
}

describe("the sphere as a level set", () => {
  const R = 1.7;
  const surface = implicit("x^2 + y^2 + z^2 - R^2", ["R"]);
  const params = Float64Array.from([R]);

  /** A point of the sphere, from its two angles. */
  const at = (u: number, v: number) => {
    const out = makeSurfacePoint();
    surface.at(R * Math.sin(u) * Math.cos(v), R * Math.sin(u) * Math.sin(v), R * Math.cos(u),
      params, out);
    return out;
  };

  it("has K = 1/R² and H = −1/R", () => {
    /**
     * The sign is the whole exercise. ∇F points the way F increases, which for `|p|² − R²` is
     * outward — the same normal `X_u × X_v` gives on the parametric sphere — so H is negative.
     */
    for (const [u, v] of [[1, 0], [0.4, 2.2], [2.7, 5]] as const) {
      const point = at(u, v);
      expect(point.degenerate).toBe(false);
      close(point.K, 1 / (R * R));
      close(point.H, -1 / R);
      close(point.k1, -1 / R);
      close(point.k2, -1 / R);
    }
  });

  it("has an outward unit normal", () => {
    const point = at(1.2, 0.7);
    close(Math.hypot(...point.N), 1);
    // Outward means N points along p, which on a sphere centred at the origin is p/R.
    for (let i = 0; i < 3; i++) close(point.N[i]!, point.p[i]! / R);
  });

  it("is umbilic everywhere, and says so", () => {
    // Every point of a sphere is umbilic, so the principal directions are arbitrary and the lines
    // of curvature must not be drawn through them.
    expect(at(0.9, 3).umbilic).toBe(true);
    expect(at(0.9, 3).planar).toBe(false);
  });

  it("agrees with the parametric sphere, sign for sign", () => {
    /**
     * The cross-representation test CLAUDE.md asks for. Both paths are run at the same point of
     * the same sphere and must produce the same K, the same H **and** the same normal.
     */
    const built = buildSurface(CATALOG_BY_ID["sphere"]!);
    const parametricParams = paramsWith(built.spec, { R });
    const level = implicit("x^2 + y^2 + z^2 - R^2", ["R"]);

    for (const [u, v] of [[0.8, 1.1], [2.0, 4.4], [1.57, 0]] as const) {
      const upstairs = makeSurfacePoint();
      built.surface.at(u, v, parametricParams, upstairs);

      const downstairs = makeSurfacePoint();
      level.at(upstairs.p[0], upstairs.p[1], upstairs.p[2], params, downstairs);

      close(downstairs.K, upstairs.K, 1e-9);
      close(downstairs.H, upstairs.H, 1e-9);
      for (let i = 0; i < 3; i++) close(downstairs.N[i]!, upstairs.N[i]!, 1e-9);
    }
  });
});

describe("other closed forms", () => {
  it("gives a cylinder K = 0 and H = −1/2r", () => {
    // Flat, and not a plane: the Theorema Egregium example, seen from the other representation.
    const r = 0.8;
    const surface = implicit("x^2 + y^2 - r^2", ["r"]);
    const params = Float64Array.from([r]);
    const out = makeSurfacePoint();
    for (const [theta, z] of [[0.3, 1], [2.2, -0.5]] as const) {
      surface.at(r * Math.cos(theta), r * Math.sin(theta), z, params, out);
      close(out.K, 0);
      close(out.H, -1 / (2 * r));
      // One principal curvature is the circle's, the other is the ruling's, which is straight.
      close(Math.min(out.k1, out.k2), -1 / r);
      close(Math.max(out.k1, out.k2), 0);
    }
  });

  it("gives a plane K = H = 0, and calls it planar", () => {
    const surface = implicit("z");
    const out = makeSurfacePoint();
    surface.at(0.3, -1.2, 0, new Float64Array(0), out);
    close(out.K, 0);
    close(out.H, 0);
    expect(out.planar).toBe(true);
    close(out.N[2]!, 1);
  });

  it("gives the torus its own curvature", () => {
    /**
     * K = cos u / (r(R + r cos u)) — positive outside, negative inside, zero on the top and
     * bottom circles. The same formula the parametric torus is checked against, computed here
     * from `(√(x² + y²) − R)² + z² − r²` without a parametrization anywhere in sight.
     */
    const R = 2;
    const r = 0.6;
    const surface = implicit("(sqrt(x^2 + y^2) - R)^2 + z^2 - r^2", ["R", "r"]);
    const params = Float64Array.from([R, r]);
    const out = makeSurfacePoint();

    for (const u of [0, 0.7, Math.PI / 2, 2.5, Math.PI]) {
      const v = 1.1;
      const rho = R + r * Math.cos(u);
      surface.at(rho * Math.cos(v), rho * Math.sin(v), r * Math.sin(u), params, out);
      close(out.K, Math.cos(u) / (r * (R + r * Math.cos(u))), 1e-8);
    }
  });

  it("flips H and the principal curvatures, but not K, when the normal is reversed", () => {
    const surface = implicit("x^2 + y^2 + z^2 - 1");
    const params = new Float64Array(0);
    const outward = makeSurfacePoint();
    surface.at(1, 0, 0, params, outward);

    surface.flipped = true;
    const inward = makeSurfacePoint();
    surface.at(1, 0, 0, params, inward);

    close(inward.K, outward.K);
    close(inward.H, -outward.H);
    close(inward.N[0]!, -outward.N[0]!);
  });
});

describe("where a level set stops being a surface", () => {
  it("marks a critical point of F degenerate rather than answering", () => {
    // The apex of the cone `x² + y² − z² = 0`: ∇F vanishes there, the level set has no tangent
    // plane, and it is not a manifold either. A plausible number would be worse than none.
    const surface = implicit("x^2 + y^2 - z^2");
    const out = makeSurfacePoint();
    surface.at(0, 0, 0, new Float64Array(0), out);
    expect(out.degenerate).toBe(true);
    expect(Number.isNaN(out.K)).toBe(true);
    expect(surface.normal(0, 0, 0, new Float64Array(0), [0, 0, 0])).toBe(false);
  });

  it("marks a non-finite field degenerate", () => {
    // The non-finite contract: `log` of a negative is not an error, it is a value nothing can be
    // read off — so it is reported rather than propagated into a buffer.
    const surface = implicit("log(z) - x");
    const out = makeSurfacePoint();
    surface.at(0, 0, -1, new Float64Array(0), out);
    expect(out.degenerate).toBe(true);
  });
});

describe("the tangent basis", () => {
  it("is orthonormal and perpendicular to the normal, for any direction", () => {
    /**
     * Crossing with a fixed axis collapses when the normal happens to be that axis, so the axis is
     * the one the normal leans on least. These are the three cases that would break a fixed choice.
     */
    const t1: Vec3 = [0, 0, 0];
    const t2: Vec3 = [0, 0, 0];
    const directions: Vec3[] = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
      [0.577, 0.577, 0.577],
      [-0.6, 0.8, 0],
    ];
    for (const N of directions) {
      const length = Math.hypot(...N);
      const unit: Vec3 = [N[0] / length, N[1] / length, N[2] / length];
      tangentBasis(unit, t1, t2);
      close(Math.hypot(...t1), 1, 1e-12);
      close(Math.hypot(...t2), 1, 1e-12);
      close(t1[0] * t2[0] + t1[1] * t2[1] + t1[2] * t2[2], 0, 1e-12);
      close(unit[0] * t1[0] + unit[1] * t1[1] + unit[2] * t1[2], 0, 1e-12);
      close(unit[0] * t2[0] + unit[1] * t2[1] + unit[2] * t2[2], 0, 1e-12);
    }
  });
});

describe("finding where a level set is", () => {
  /**
   * A level set has no domain: the box it is drawn in is a window, a choice about where to look.
   * So "show me the whole surface" can only be answered by searching, which is what `boundLevelSet`
   * does — a coarse sweep keeping every cell edge where F changes sign.
   */
  it("frames a sphere on the sphere", () => {
    const surface = implicit("x^2 + y^2 + z^2 - 4");
    const box = boundLevelSet(surface, new Float64Array(0))!;
    expect(box).not.toBeNull();
    for (const side of [box.x, box.y, box.z]) {
      // Radius 2, plus at most the pad of one scan cell either side.
      expect(side.min).toBeLessThan(-2);
      expect(side.min).toBeGreaterThan(-3.2);
      expect(side.max).toBeGreaterThan(2);
      expect(side.max).toBeLessThan(3.2);
    }
  });

  it("frames an off-centre surface where it actually is", () => {
    // The point of searching rather than scaling: a sphere at (5, 0, 0) is invisible in any box
    // centred on the origin, however wide, until the box is moved.
    const surface = implicit("(x - 5)^2 + y^2 + z^2 - 1");
    const box = boundLevelSet(surface, new Float64Array(0))!;
    // The sphere spans [4, 6]; the box holds it, plus at most a scan cell of padding either side.
    expect(box.x.min).toBeGreaterThanOrEqual(3);
    expect(box.x.min).toBeLessThanOrEqual(4);
    expect(box.x.max).toBeGreaterThanOrEqual(6);
    expect(box.x.max).toBeLessThanOrEqual(8);
    expect(Math.abs(box.y.min + box.y.max)).toBeLessThan(1);
  });

  it("follows the surface as its parameters move", () => {
    const surface = implicit("x^2 + y^2 + z^2 - R^2", ["R"]);
    const small = boundLevelSet(surface, Float64Array.from([1]))!;
    const large = boundLevelSet(surface, Float64Array.from([6]))!;
    expect(large.x.max).toBeGreaterThan(small.x.max * 2.5);
  });

  it("says nothing when the equation has no solutions in reach", () => {
    // Honest rather than helpful: an equation with no solutions gets no box invented for it, and
    // the caller keeps whatever window it had.
    expect(boundLevelSet(implicit("x^2 + y^2 + z^2 + 1"), new Float64Array(0))).toBeNull();
  });

  it("does not collapse on a surface that is flat in one direction", () => {
    // The plane z = 0 has no extent in z at all; a box of zero width has nothing to march, so the
    // search keeps a floor of one cell.
    const box = boundLevelSet(implicit("z"), new Float64Array(0))!;
    expect(box.z.max - box.z.min).toBeGreaterThan(0);
  });
});
