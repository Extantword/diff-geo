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
 * Everything do Carmo's Chapter 3 needs at a point, stated **chart-free**.
 *
 * This is the interface every representation reduces to — parametric surfaces, graphs
 * and (from M4) implicit surfaces. Curvature colouring, the legend, readout panels and
 * principal-direction glyphs depend on this and nothing else, so they work identically
 * for all three with no branching.
 *
 * Principal directions are given in **ambient R³**, not chart components, precisely so
 * that a level set — which has no chart — can satisfy the same interface.
 *
 * ## Orientation
 *
 * K is orientation-independent. **H, k₁ and k₂ all flip sign with the choice of unit
 * normal.** Parametric surfaces take N = X_u × X_v / |X_u × X_v|; level sets will take
 * N = ∇F/|∇F|. Those disagree in general, which is why every object carries a `flipped`
 * toggle and why the UI must draw the normal whenever it shows H — the sign is then
 * visually explained rather than mysterious.
 */
export interface SurfacePoint {
  /** the point itself */
  p: Vec3;
  /** unit normal; the Gauss map image */
  N: Vec3;
  /** Gaussian curvature, det of the shape operator */
  K: number;
  /** mean curvature, ½ tr of the shape operator */
  H: number;
  /** principal curvatures, k1 ≥ k2 */
  k1: number;
  k2: number;
  /** principal directions in R³: unit, tangent, orthogonal; e1 pairs with k1 */
  e1: Vec3;
  e2: Vec3;
  /** k1 ≈ k2 — the principal directions are arbitrary, so lines of curvature must
   *  not be drawn through here */
  umbilic: boolean;
  /** k1 ≈ k2 ≈ 0, e.g. the origin of the monkey saddle */
  planar: boolean;
  /** |X_u × X_v| ≈ 0 or a non-finite jet: nothing here is meaningful */
  degenerate: boolean;
}

export function makeSurfacePoint(): SurfacePoint {
  return {
    p: [0, 0, 0],
    N: [0, 0, 0],
    K: Number.NaN,
    H: Number.NaN,
    k1: Number.NaN,
    k2: Number.NaN,
    e1: [0, 0, 0],
    e2: [0, 0, 0],
    umbilic: false,
    planar: false,
    degenerate: true,
  };
}

/** Christoffel symbols Γᵏᵢⱼ as `Gamma[k][i][j]`, symmetric in i, j. */
export type Christoffel2 = [
  [[number, number], [number, number]],
  [[number, number], [number, number]],
];

/**
 * Chart-dependent quantities, available only where a chart exists. Geodesics, the
 * lines-of-curvature ODE and parallel transport need these; a level set cannot supply
 * them, which is why they live apart from `SurfacePoint` rather than being faked.
 */
export interface ChartData {
  uv: Vec2;
  /** first fundamental form, [[E, F], [F, G]] */
  I: Mat2;
  /** second fundamental form, [[e, f], [f, g]] */
  II: Mat2;
  Xu: Vec3;
  Xv: Vec3;
  /** Levi-Civita connection of I */
  Gamma: Christoffel2;
  /** principal directions in chart components (du, dv), for the ODE */
  e1uv: Vec2;
  e2uv: Vec2;
}

export function makeChartData(): ChartData {
  return {
    uv: [0, 0],
    I: [
      [0, 0],
      [0, 0],
    ],
    II: [
      [0, 0],
      [0, 0],
    ],
    Xu: [0, 0, 0],
    Xv: [0, 0, 0],
    Gamma: [
      [
        [0, 0],
        [0, 0],
      ],
      [
        [0, 0],
        [0, 0],
      ],
    ],
    e1uv: [0, 0],
    e2uv: [0, 0],
  };
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
