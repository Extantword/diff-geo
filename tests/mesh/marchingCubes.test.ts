import { describe, expect, it } from "vitest";
import { parse } from "../../src/core/expr/parse.ts";
import { createImplicitSurface } from "../../src/core/geom/implicit.ts";
import { interval } from "../../src/core/geom/types.ts";
import { buildDiffMap } from "../../src/core/jets/compile.ts";
import { marchImplicit } from "../../src/core/mesh/marchingCubes.ts";
import { meshArea } from "../../src/core/mesh/gaussMap.ts";

/**
 * The mesher, against the surface it is meshing.
 *
 * A mesh is an approximation, so the assertions are about how close it is and about what it must
 * never do. Two of them carry most of the weight: every vertex lies **on** the level set, which is
 * the whole job; and the area of the sphere's mesh converges to 4πR², which no amount of
 * plausible-looking triangles can fake.
 */

const close = (a: number, b: number, tol: number) =>
  expect(Math.abs(a - b), `${a} vs ${b}`).toBeLessThan(tol);

/**
 * How close a *mesh* gets, which is not how close the geometry gets.
 *
 * Everything in `implicit.test.ts` is exact to 1e-9 because it is evaluated at a point. Here the
 * point itself is a construction: linear interpolation along a grid edge, then one Newton step.
 * Newton is quadratic, so an O(h²) interpolation error becomes O(h⁴) — about 1e-6 at these
 * resolutions. These tolerances are that, with room; they are far tighter than the ~2e-3 the
 * interpolation alone would give, so they still fail loudly if the refinement is ever dropped.
 */
const ON_SURFACE = 1e-4;

function implicit(source: string, half = 2, params: readonly string[] = []) {
  const { expr, diags } = parse(source);
  expect(diags.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
  const map = buildDiffMap({
    id: source,
    comps: [expr!],
    vars: ["x", "y", "z"],
    params: [...params],
    order: 2,
  });
  return createImplicitSurface({
    id: source,
    map,
    x: interval(-half, half),
    y: interval(-half, half),
    z: interval(-half, half),
  });
}

const NO_PARAMS = new Float64Array(0);

describe("meshing a sphere", () => {
  const R = 1.2;
  const surface = implicit("x^2 + y^2 + z^2 - 1.44");
  const mesh = marchImplicit(surface, NO_PARAMS, { res: 32 });

  it("produces a mesh at all", () => {
    expect(mesh.vertexCount).toBeGreaterThan(500);
    expect(mesh.triangleCount).toBeGreaterThan(500);
    expect(mesh.indices.length).toBe(mesh.triangleCount * 3);
  });

  it("puts every vertex on the level set", () => {
    /**
     * The Newton step after the linear interpolation is what makes this tight. Without it the
     * error is second order in the cell size and a coarse sphere is visibly polygonal; with it
     * every vertex is on the surface to nearly machine precision.
     */
    for (let v = 0; v < mesh.vertexCount; v++) {
      const r = Math.hypot(
        mesh.positions[v * 3]!,
        mesh.positions[v * 3 + 1]!,
        mesh.positions[v * 3 + 2]!,
      );
      close(r, R, ON_SURFACE);
    }
  });

  it("takes its normals from the gradient, not from the triangles", () => {
    // On a sphere the outward normal is p/R exactly, so an averaged face normal would show up
    // immediately as an error of the order of the cell size.
    for (let v = 0; v < mesh.vertexCount; v += 7) {
      const nx = mesh.normals[v * 3]!;
      const ny = mesh.normals[v * 3 + 1]!;
      const nz = mesh.normals[v * 3 + 2]!;
      // Unit to machine precision — that part IS exact, it is ∇F normalised.
      close(Math.hypot(nx, ny, nz), 1, 1e-6);
      close(nx, mesh.positions[v * 3]! / R, ON_SURFACE);
      close(ny, mesh.positions[v * 3 + 1]! / R, ON_SURFACE);
      close(nz, mesh.positions[v * 3 + 2]! / R, ON_SURFACE);
    }
  });

  it("carries the sphere's curvature per vertex", () => {
    for (let v = 0; v < mesh.vertexCount; v += 11) {
      close(mesh.curvature[v]!, 1 / (R * R), ON_SURFACE);
    }
  });

  it("has the area a sphere has", () => {
    /**
     * The measurement that cannot be faked by triangles that merely look right. A marching mesh
     * inscribed in the sphere is slightly small, so it approaches 4πR² from below as the grid is
     * refined — which is what the two resolutions here assert, along with the value itself.
     */
    const exact = 4 * Math.PI * R * R;
    const coarse = meshArea(marchImplicit(surface, NO_PARAMS, { res: 16 }));
    const fine = meshArea(marchImplicit(surface, NO_PARAMS, { res: 48 }));
    expect(coarse).toBeLessThan(exact);
    expect(fine).toBeLessThan(exact);
    expect(fine).toBeGreaterThan(coarse);
    close(fine, exact, 0.02 * exact);
  });

  it("is watertight: every edge is shared by exactly two triangles", () => {
    /**
     * What Kuhn's subdivision buys. Marching cubes has to resolve an ambiguous face, and getting
     * it wrong opens holes; a tetrahedron admits exactly one cut per sign pattern, so the surface
     * closes by construction — and a closed surface is the precondition for the area above
     * meaning anything.
     */
    const seen = new Map<number, number>();
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const tri = [mesh.indices[t]!, mesh.indices[t + 1]!, mesh.indices[t + 2]!];
      for (let e = 0; e < 3; e++) {
        const a = tri[e]!;
        const b = tri[(e + 1) % 3]!;
        const key = Math.min(a, b) * mesh.vertexCount + Math.max(a, b);
        seen.set(key, (seen.get(key) ?? 0) + 1);
      }
    }
    const wrong = [...seen.values()].filter((count) => count !== 2);
    expect(wrong).toEqual([]);
  });

  it("winds every triangle the way the surface faces", () => {
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const [a, b, c] = [mesh.indices[t]!, mesh.indices[t + 1]!, mesh.indices[t + 2]!];
      const at = (v: number, i: number) => mesh.positions[v * 3 + i]!;
      const ux = at(b, 0) - at(a, 0);
      const uy = at(b, 1) - at(a, 1);
      const uz = at(b, 2) - at(a, 2);
      const vx = at(c, 0) - at(a, 0);
      const vy = at(c, 1) - at(a, 1);
      const vz = at(c, 2) - at(a, 2);
      const along =
        (uy * vz - uz * vy) * mesh.normals[a * 3]! +
        (uz * vx - ux * vz) * mesh.normals[a * 3 + 1]! +
        (ux * vy - uy * vx) * mesh.normals[a * 3 + 2]!;
      expect(along).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("what the box does and does not contain", () => {
  it("returns an empty mesh when the level set misses the box entirely", () => {
    // `|p|² = 100` has nothing inside a box of half-width 2. An empty mesh, not a crash and not a
    // stray triangle.
    const mesh = marchImplicit(implicit("x^2 + y^2 + z^2 - 100"), NO_PARAMS, { res: 12 });
    expect(mesh.vertexCount).toBe(0);
    expect(mesh.triangleCount).toBe(0);
  });

  it("cuts the surface off at the walls of the box rather than closing it", () => {
    // A cylinder runs out of the top and bottom of the box: the mesh has an open rim there, which
    // is correct — the box is a window, not a boundary of the surface.
    const mesh = marchImplicit(implicit("x^2 + y^2 - 1"), NO_PARAMS, { res: 24 });
    expect(mesh.triangleCount).toBeGreaterThan(100);
    for (let v = 0; v < mesh.vertexCount; v++) {
      close(Math.hypot(mesh.positions[v * 3]!, mesh.positions[v * 3 + 1]!), 1, ON_SURFACE);
    }
  });

  it("skips a cube touching a value that is not a number", () => {
    /**
     * `log(z)` is not a number below the plane, so half the box has no field at all. The cubes
     * that touch it are skipped rather than cut through infinity — a single NaN reaching a GPU
     * buffer is a triangle smeared across the scene.
     */
    const mesh = marchImplicit(implicit("log(z) - x"), NO_PARAMS, { res: 16 });
    for (let v = 0; v < mesh.vertexCount * 3; v++) {
      expect(Number.isFinite(mesh.positions[v]!)).toBe(true);
    }
    expect(mesh.droppedVertices).toBeGreaterThan(0);
  });
});

describe("the torus, meshed", () => {
  it("carries the torus's own curvature, both signs of it", () => {
    const R = 1.2;
    const r = 0.45;
    const surface = implicit("(sqrt(x^2 + y^2) - 1.2)^2 + z^2 - 0.2025");
    const mesh = marchImplicit(surface, NO_PARAMS, { res: 40 });
    expect(mesh.vertexCount).toBeGreaterThan(1000);

    let positive = 0;
    let negative = 0;
    for (let v = 0; v < mesh.vertexCount; v++) {
      const x = mesh.positions[v * 3]!;
      const y = mesh.positions[v * 3 + 1]!;
      const z = mesh.positions[v * 3 + 2]!;
      // Recover u from the point: cos u = (√(x²+y²) − R)/r.
      const cosU = (Math.hypot(x, y) - R) / r;
      close(mesh.curvature[v]!, cosU / (r * (R + r * cosU)), 1e-3);
      if (mesh.curvature[v]! > 0) positive++;
      if (mesh.curvature[v]! < 0) negative++;
      void z;
    }
    // Curvature of both signs is the point of the torus: outside is positive, inside negative.
    expect(positive).toBeGreaterThan(100);
    expect(negative).toBeGreaterThan(100);
  });
});
