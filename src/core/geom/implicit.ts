import type { DiffMap } from "../jets/compile.ts";
import { offsetOf, type JetLayout } from "../jets/jet.ts";
import { markDegenerate, resolveShape } from "./shape.ts";
import { interval, type Interval, type SurfacePoint, type Vec3 } from "./types.ts";

/**
 * Surfaces given as a level set: `{ p ∈ R³ : F(p) = 0 }`.
 *
 * The second of the two representations, and the reason `SurfacePoint` states everything in
 * ambient R³ rather than in chart components — a level set has no chart to state them in. What
 * comes out of `at` here is the same record a parametric surface produces, so curvature colouring,
 * the legend, readouts and the picking pass work on both with no branching.
 *
 * ## The shape operator, without a parametrization
 *
 * With N = ∇F/|∇F| the differential of the Gauss map is the Hessian of F, projected onto the
 * tangent plane and scaled:
 *
 *     dN|T = P·Hess(F)·P / |∇F|,   P = 1 − N Nᵀ,   A = −dN
 *
 * so in any orthonormal tangent basis (t₁, t₂),
 *
 *     A₂ᵢⱼ = −⟨tᵢ, Hess(F) tⱼ⟩ / |∇F|
 *
 * which is symmetric, and is exactly the matrix `resolveShape` takes. Nothing here re-derives
 * eigenvalues: the same solver produces k₁, k₂, K, H and the principal directions for both
 * representations, so a sign error could not hide in one of them.
 *
 * ## The sign, which is the whole point of the exercise
 *
 * `∇F` points the way F increases, so for `F = x² + y² + z² − R²` it points **outward**, and the
 * unit sphere comes out with K = 1/R² and **H = −1/R** — the same numbers the parametric sphere
 * gives with N = X_u × X_v / |X_u × X_v|. That agreement is not automatic and it is not decorative:
 * H, k₁ and k₂ all flip with the choice of normal, so two representations that disagree about it
 * would report the same surface as two different objects. The cross-representation test exists to
 * force the agreement, and if it ever fails the convention is wrong at the source rather than
 * downstream (see do Carmo §3-2).
 *
 * ## Where the level set stops being a surface
 *
 * At a critical point of F — `∇F = 0` — the level set has no tangent plane and generally is not a
 * manifold at all: `x² + y² − z² = 0` is a cone whose apex is exactly such a point. Those are
 * marked degenerate rather than answered with a plausible number, which is the non-finite contract
 * as this file states it.
 */

/** Offsets of F and its first and second partials in an order-2 jet of a map R³ → R. */
export interface ImplicitJetOffsets {
  readonly F: number;
  readonly Fx: number;
  readonly Fy: number;
  readonly Fz: number;
  readonly Fxx: number;
  readonly Fxy: number;
  readonly Fxz: number;
  readonly Fyy: number;
  readonly Fyz: number;
  readonly Fzz: number;
}

export function implicitJetOffsets(layout: JetLayout): ImplicitJetOffsets {
  if (layout.n !== 3 || layout.m !== 1) {
    throw new Error(`expected a map R³ → R, got R^${layout.n} → R^${layout.m}`);
  }
  if (layout.order < 2) {
    throw new Error(`the shape operator needs order ≥ 2, got ${layout.order}`);
  }
  return {
    F: offsetOf(layout, [0, 0, 0], 0),
    Fx: offsetOf(layout, [1, 0, 0], 0),
    Fy: offsetOf(layout, [0, 1, 0], 0),
    Fz: offsetOf(layout, [0, 0, 1], 0),
    Fxx: offsetOf(layout, [2, 0, 0], 0),
    Fxy: offsetOf(layout, [1, 1, 0], 0),
    Fxz: offsetOf(layout, [1, 0, 1], 0),
    Fyy: offsetOf(layout, [0, 2, 0], 0),
    Fyz: offsetOf(layout, [0, 1, 1], 0),
    Fzz: offsetOf(layout, [0, 0, 2], 0),
  };
}

export interface ImplicitSurface {
  readonly id: string;
  /** F as a map R³ → R of order ≥ 2 */
  readonly map: DiffMap;
  /** the box the level set is looked for in */
  readonly x: Interval;
  readonly y: Interval;
  readonly z: Interval;
  /** reverse N, flipping the sign of H, k₁ and k₂ but not K */
  flipped: boolean;
  /** F(p) alone — what the mesher samples, and the only thing it needs per grid point */
  value(x: number, y: number, z: number, params: ArrayLike<number>): number;
  /**
   * F(p), with ∇F written into `out` — **unnormalised**.
   *
   * For the mesher's Newton step, `p ← p − F ∇F/|∇F|²`, which needs the length as well as the
   * direction. Kept apart from `normal` for that reason alone.
   */
  gradient(x: number, y: number, z: number, params: ArrayLike<number>, out: Vec3): number;
  /**
   * The unit normal, and the gradient's length with it.
   *
   * Separate from `at` because meshing needs a normal at every vertex and curvature only where a
   * readout asks: the Hessian is six more partials and an eigendecomposition, and a mesh has tens
   * of thousands of vertices. Returns false where there is no normal to give.
   */
  normal(x: number, y: number, z: number, params: ArrayLike<number>, out: Vec3): boolean;
  /** everything Chapter 3 needs at a point of the level set */
  at(x: number, y: number, z: number, params: ArrayLike<number>, out: SurfacePoint): void;
}

export interface ImplicitSurfaceOptions {
  readonly id: string;
  readonly map: DiffMap;
  readonly x: Interval;
  readonly y: Interval;
  readonly z: Interval;
  readonly flipped?: boolean;
}

/** Below this, relative to the field's own scale, ∇F is zero and there is no tangent plane. */
const DEGENERATE_EPS = 1e-12;

export function createImplicitSurface(options: ImplicitSurfaceOptions): ImplicitSurface {
  const { id, map } = options;
  const offsets = implicitJetOffsets(map.layout);

  // Scratch reused across calls: the mesher evaluates this hundreds of thousands of times, so a
  // per-call allocation would dominate the arithmetic it is there to do.
  const jet = map.makeJet();
  const argument: [number, number, number] = [0, 0, 0];
  const t1: Vec3 = [0, 0, 0];
  const t2: Vec3 = [0, 0, 0];
  const point: Vec3 = [0, 0, 0];
  const hessianT1: Vec3 = [0, 0, 0];
  const hessianT2: Vec3 = [0, 0, 0];

  const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

  const surface: ImplicitSurface = {
    id,
    map,
    x: options.x,
    y: options.y,
    z: options.z,
    flipped: options.flipped ?? false,

    value(x, y, z, params) {
      argument[0] = x;
      argument[1] = y;
      argument[2] = z;
      map.evaluate(argument, params, jet);
      return jet[offsets.F] ?? Number.NaN;
    },

    gradient(x, y, z, params, out) {
      argument[0] = x;
      argument[1] = y;
      argument[2] = z;
      map.evaluate(argument, params, jet);
      out[0] = jet[offsets.Fx] ?? Number.NaN;
      out[1] = jet[offsets.Fy] ?? Number.NaN;
      out[2] = jet[offsets.Fz] ?? Number.NaN;
      return jet[offsets.F] ?? Number.NaN;
    },

    normal(x, y, z, params, out) {
      argument[0] = x;
      argument[1] = y;
      argument[2] = z;
      map.evaluate(argument, params, jet);
      const gx = jet[offsets.Fx] ?? Number.NaN;
      const gy = jet[offsets.Fy] ?? Number.NaN;
      const gz = jet[offsets.Fz] ?? Number.NaN;
      const length = Math.hypot(gx, gy, gz);
      if (!Number.isFinite(jet[offsets.F] ?? Number.NaN)) return false;
      if (!Number.isFinite(length) || length <= DEGENERATE_EPS) return false;
      const sign = surface.flipped ? -1 : 1;
      out[0] = (sign * gx) / length;
      out[1] = (sign * gy) / length;
      out[2] = (sign * gz) / length;
      return true;
    },

    at(x, y, z, params, out) {
      argument[0] = x;
      argument[1] = y;
      argument[2] = z;
      map.evaluate(argument, params, jet);

      point[0] = x;
      point[1] = y;
      point[2] = z;
      out.p[0] = x;
      out.p[1] = y;
      out.p[2] = z;

      const gx = jet[offsets.Fx] ?? Number.NaN;
      const gy = jet[offsets.Fy] ?? Number.NaN;
      const gz = jet[offsets.Fz] ?? Number.NaN;
      const length = Math.hypot(gx, gy, gz);
      /**
       * Two ways to be nowhere: F itself is not a number here — `log(z)` below the plane — so the
       * point is on no level set at all; or ∇F vanishes, a critical point, where the level set has
       * no tangent plane and generally is not a surface either. The apex of a cone is the second.
       *
       * The first has to be tested explicitly, because the *derivatives* of a formula can be
       * perfectly finite where the formula is not, and a shape operator built from them would be a
       * plausible number about a point that does not exist.
       */
      if (
        !Number.isFinite(jet[offsets.F] ?? Number.NaN) ||
        !Number.isFinite(length) ||
        length <= DEGENERATE_EPS
      ) {
        out.N[0] = 0;
        out.N[1] = 0;
        out.N[2] = 0;
        markDegenerate(out);
        return;
      }

      const sign = surface.flipped ? -1 : 1;
      const N: Vec3 = [(sign * gx) / length, (sign * gy) / length, (sign * gz) / length];
      tangentBasis(N, t1, t2);

      const fxx = jet[offsets.Fxx] ?? Number.NaN;
      const fxy = jet[offsets.Fxy] ?? Number.NaN;
      const fxz = jet[offsets.Fxz] ?? Number.NaN;
      const fyy = jet[offsets.Fyy] ?? Number.NaN;
      const fyz = jet[offsets.Fyz] ?? Number.NaN;
      const fzz = jet[offsets.Fzz] ?? Number.NaN;

      applyHessian(fxx, fxy, fxz, fyy, fyz, fzz, t1, hessianT1);
      applyHessian(fxx, fxy, fxz, fyy, fyz, fzz, t2, hessianT2);

      /**
       * A = −P·Hess(F)·P / |∇F|, read off in the basis (t₁, t₂).
       *
       * The projection P is free here: t₁ and t₂ are already tangent, so ⟨tᵢ, P H P tⱼ⟩ is just
       * ⟨tᵢ, H tⱼ⟩. The sign carries the whole convention — it is what makes the sphere's H
       * negative with an outward normal, agreeing with the parametric path.
       */
      const scale = sign / length;
      const a = -scale * dot(t1, hessianT1);
      const b = -scale * dot(t2, hessianT1);
      const c = -scale * dot(t2, hessianT2);

      resolveShape(a, b, c, t1, t2, N, point, out);
    },
  };

  return surface;
}

/** How far out `boundLevelSet` looks, and how coarsely. */
const SCAN_REACH = 12;
const SCAN_STEPS = 32;

/**
 * Where the level set actually is: the box that contains it, found by looking.
 *
 * A level set has no domain — the box it is drawn in is a **window**, a choice about what to look
 * at — so "show me the whole surface" is a question that can only be answered by searching. This
 * sweeps a coarse grid over a generous reach and keeps the corners of every cell edge where F
 * changes sign, which is where the surface crosses. Sign change rather than a small |F|, because
 * the size of F says nothing: `1000(x² + y² + z² − 1)` is the same sphere.
 *
 * Returns null when nothing crosses, which is the honest answer for an equation with no solutions
 * anywhere near — the caller then keeps whatever box it had and says so.
 *
 * A coarse scan can miss a feature thinner than a cell. That is the trade for a search that costs
 * ~33k evaluations rather than a million, and the result is only ever a *window*: a missed sliver
 * shifts the view, it does not change the surface.
 */
export function boundLevelSet(
  surface: ImplicitSurface,
  params: ArrayLike<number>,
  reach = SCAN_REACH,
  steps = SCAN_STEPS,
): { x: Interval; y: Interval; z: Interval } | null {
  const n = steps + 1;
  const values = new Float64Array(n * n * n);
  const at = (i: number) => -reach + (2 * reach * i) / steps;

  for (let k = 0; k < n; k++) {
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        values[i + n * (j + n * k)] = surface.value(at(i), at(j), at(k), params);
      }
    }
  }

  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const keep = (i: number, j: number, k: number) => {
    const p = [at(i), at(j), at(k)];
    for (let c = 0; c < 3; c++) {
      if (p[c]! < min[c]!) min[c] = p[c]!;
      if (p[c]! > max[c]!) max[c] = p[c]!;
    }
  };

  /**
   * A sign change along one edge — and an exact zero counts.
   *
   * `F = z` samples the plane exactly on a grid line, so a test that only looked for strict
   * disagreement in sign would find no crossing anywhere and conclude the plane is not there.
   * A vanishing sample is not near the surface, it **is** the surface.
   */
  const crosses = (a: number, b: number) =>
    Number.isFinite(a) &&
    Number.isFinite(b) &&
    (a === 0 || b === 0 || a > 0 !== b > 0);

  for (let k = 0; k < n; k++) {
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const here = values[i + n * (j + n * k)]!;
        if (i + 1 < n && crosses(here, values[i + 1 + n * (j + n * k)]!)) {
          keep(i, j, k);
          keep(i + 1, j, k);
        }
        if (j + 1 < n && crosses(here, values[i + n * (j + 1 + n * k)]!)) {
          keep(i, j, k);
          keep(i, j + 1, k);
        }
        if (k + 1 < n && crosses(here, values[i + n * (j + n * (k + 1))]!)) {
          keep(i, j, k);
          keep(i, j, k + 1);
        }
      }
    }
  }

  if (!Number.isFinite(min[0]!)) return null;

  /**
   * Padded by a cell and given a floor.
   *
   * The pad is because a sign change between two samples means the crossing is somewhere between
   * them, so the true extent reaches a cell further than the corners kept here. The floor is for
   * a level set that is a single point or a thin disc: a box of zero width has nothing to march.
   */
  const cell = (2 * reach) / steps;
  const span = (c: number): Interval => {
    const half = Math.max((max[c]! - min[c]!) / 2 + cell, cell);
    const centre = (max[c]! + min[c]!) / 2;
    return interval(centre - half, centre + half);
  };
  return { x: span(0), y: span(1), z: span(2) };
}

/**
 * Any orthonormal basis of the plane perpendicular to N.
 *
 * Which basis is arbitrary and does not matter: K, H and the principal curvatures are invariants
 * of the shape operator, and `resolveShape` rotates the basis onto the principal directions itself.
 * What *does* matter is that the construction is numerically stable — crossing N with a fixed axis
 * collapses when N happens to be that axis, so the axis is chosen to be the one N leans on least.
 */
export function tangentBasis(N: Vec3, t1: Vec3, t2: Vec3): void {
  const ax = Math.abs(N[0]);
  const ay = Math.abs(N[1]);
  const az = Math.abs(N[2]);
  const axis: Vec3 = ax <= ay && ax <= az ? [1, 0, 0] : ay <= az ? [0, 1, 0] : [0, 0, 1];

  // t₁ = N × axis, normalised; the cross product of two unit vectors at least 45° apart cannot be
  // short enough to lose precision.
  const cx = N[1] * axis[2] - N[2] * axis[1];
  const cy = N[2] * axis[0] - N[0] * axis[2];
  const cz = N[0] * axis[1] - N[1] * axis[0];
  const length = Math.hypot(cx, cy, cz) || 1;
  t1[0] = cx / length;
  t1[1] = cy / length;
  t1[2] = cz / length;

  // t₂ = N × t₁ completes a right-handed frame and is unit without further work.
  t2[0] = N[1] * t1[2] - N[2] * t1[1];
  t2[1] = N[2] * t1[0] - N[0] * t1[2];
  t2[2] = N[0] * t1[1] - N[1] * t1[0];
}

/** `out = Hess(F) · v`, with the Hessian given by its six distinct entries. */
function applyHessian(
  fxx: number,
  fxy: number,
  fxz: number,
  fyy: number,
  fyz: number,
  fzz: number,
  v: Vec3,
  out: Vec3,
): void {
  out[0] = fxx * v[0] + fxy * v[1] + fxz * v[2];
  out[1] = fxy * v[0] + fyy * v[1] + fyz * v[2];
  out[2] = fxz * v[0] + fyz * v[1] + fzz * v[2];
}
