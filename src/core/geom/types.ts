/**
 * Core geometric contract. Conventions follow do Carmo, *Differential Geometry of
 * Curves and Surfaces* (see the `docarmo-conventions` skill).
 *
 * Index convention: 0 ↔ u, 1 ↔ v.
 *
 * NOT YET FROZEN. This file grows in M1 to carry the full extrinsic apparatus
 * (SurfacePoint with N, K, H, k₁, k₂ and principal directions) and is frozen at
 * the end of M1, once the CAS and jet layers have exercised it.
 *
 * ## The non-finite contract
 *
 * Arbitrary user formulas produce NaN and ±Infinity constantly — `log` of a
 * negative, `sqrt` of a negative, `1/x` at zero, `1/tan(u)` at a chart pole.
 * Nothing in `core` throws on bad numerics. Evaluators return non-finite numbers
 * and every consumer is required to branch explicitly:
 *
 *   - the mesh builder drops triangles touching non-finite vertices,
 *   - readouts render "—",
 *   - integrators stop (see the step-collapse bailout in geodesic.ts).
 *
 * A NaN reaching a GPU buffer becomes a corrupted triangle spanning the scene, so
 * culling at the mesh boundary is load-bearing, not defensive politeness.
 */

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];

/** Symmetric 2×2 matrix as m[i][j] — used for both I (E,F,G) and II (e,f,g). */
export type Mat2 = [[number, number], [number, number]];

/** A closed interval, always treated as open at singular ends. See `inset`. */
export interface Interval {
  min: number;
  max: number;
  /**
   * Fraction of the span to pull in from each end when sampling, so that chart
   * quantities singular exactly at the boundary are never evaluated there.
   *
   * This is not a nicety. ManifoldSandbox shipped the sphere as
   * `uRange: [0.001, 3.1405926535897932]` — nudged off both poles — because its
   * Christoffel symbols contain 1/tan(u), infinite at u = 0 and u = π. Any chart
   * with a coordinate singularity has the same problem, so the sampling domain is
   * open by default rather than by special case.
   */
  inset: number;
}

export function interval(min: number, max: number, inset = 0): Interval {
  return { min, max, inset };
}

/** The sampling bounds actually used, after applying `inset`. */
export function sampleBounds(iv: Interval): Vec2 {
  const pad = (iv.max - iv.min) * iv.inset;
  return [iv.min + pad, iv.max - pad];
}

/**
 * The minimum a parametric surface must provide to be tessellated and drawn.
 * In M1 this becomes a view onto a compiled jet evaluator; in M0 it is satisfied
 * by a hand-written closure so the render pipeline can be proven end to end
 * before the CAS exists.
 */
export interface ParametricSource {
  id: string;
  name: string;
  /** the embedding X(u,v) ∈ R³ */
  position(u: number, v: number): Vec3;
  u: Interval;
  v: Interval;
  periodicU: boolean;
  periodicV: boolean;
}
