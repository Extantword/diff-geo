import type { SurfacePoint, Vec3 } from "./types.ts";

/**
 * The one place curvature is computed, for every representation.
 *
 * ## Why the input is II in an *orthonormal* tangent basis
 *
 * The obvious move is to build the Weingarten matrix `W = I⁻¹ · II` in the chart basis
 * {X_u, X_v} and eigendecompose it. That is **wrong**: `W` is not symmetric whenever
 * F ≠ 0, so a symmetric eigensolver gives nonsense and a general one gives complex
 * arithmetic for a problem that is genuinely real and orthogonal.
 *
 * Instead the caller Gram–Schmidts to an orthonormal tangent basis (t₁, t₂) and passes
 * `II₂ = Qᵀ · II · Q`, which *is* symmetric. The invariants survive the change of basis:
 * with `Qᵀ I Q = 1` one gets `I⁻¹ = Q Qᵀ`, hence
 *
 *     tr(II₂) = tr(II Q Qᵀ) = tr(I⁻¹ II) = tr(W) = 2H
 *     det(II₂) = det(Q)² det(II) = (eg − f²)/(EG − F²) = K
 *
 * so the eigenvalues of II₂ are exactly the principal curvatures.
 *
 * ## Why eigendecomposition rather than the closed forms
 *
 * `K = det`, `H = ½ tr`, `k = H ± √(H² − K)` is the textbook route, but the square root
 * of a discriminant that is zero in exact arithmetic goes slightly negative in floating
 * point at umbilics — and every point of a sphere is umbilic. The 2×2 symmetric
 * eigendecomposition has no such failure, yields the principal *directions* in the same
 * breath, and makes `k₁k₂ = K` and `k₁ + k₂ = 2H` true by construction rather than by
 * hope. The closed forms become tests instead of implementation.
 */

/** Relative tolerance for declaring a point umbilic or planar. */
const UMBILIC_EPS = 1e-9;

/**
 * The Jacobi rotation angle carrying an orthonormal tangent basis onto the principal
 * directions: θ = ½ atan2(2b, a − c).
 *
 * `atan2(0, 0)` is 0, so at an umbilic this returns 0 and leaves e₁ = t₁ — an arbitrary
 * choice, which is correct, since the principal directions genuinely are arbitrary
 * there. Callers are told via `SurfacePoint.umbilic`.
 */
export function principalAngle(a: number, b: number, c: number): number {
  return 0.5 * Math.atan2(2 * b, a - c);
}

/**
 * Fill `out` from the second fundamental form in an orthonormal tangent basis.
 *
 * `II₂ = [[a, b], [b, c]]` with `a = II(t₁,t₁)`, `b = II(t₁,t₂)`, `c = II(t₂,t₂)`.
 */
export function resolveShape(
  a: number,
  b: number,
  c: number,
  t1: Vec3,
  t2: Vec3,
  N: Vec3,
  p: Vec3,
  out: SurfacePoint,
): void {
  out.p[0] = p[0];
  out.p[1] = p[1];
  out.p[2] = p[2];
  out.N[0] = N[0];
  out.N[1] = N[1];
  out.N[2] = N[2];

  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c)) {
    markDegenerate(out);
    return;
  }

  // Symmetric 2×2 eigendecomposition. `radius` is the half-difference of the
  // eigenvalues, always real because the matrix is symmetric.
  const mean = (a + c) / 2;
  const half = (a - c) / 2;
  const radius = Math.hypot(half, b);

  const k1 = mean + radius;
  const k2 = mean - radius;

  const theta = principalAngle(a, b, c);
  const cosTheta = Math.cos(theta);
  const sinTheta = Math.sin(theta);

  out.e1[0] = cosTheta * t1[0] + sinTheta * t2[0];
  out.e1[1] = cosTheta * t1[1] + sinTheta * t2[1];
  out.e1[2] = cosTheta * t1[2] + sinTheta * t2[2];
  out.e2[0] = -sinTheta * t1[0] + cosTheta * t2[0];
  out.e2[1] = -sinTheta * t1[1] + cosTheta * t2[1];
  out.e2[2] = -sinTheta * t1[2] + cosTheta * t2[2];

  out.k1 = k1;
  out.k2 = k2;
  out.K = k1 * k2;
  out.H = mean;

  const scale = 1 + Math.abs(k1) + Math.abs(k2);
  out.umbilic = 2 * radius < UMBILIC_EPS * scale;
  out.planar = out.umbilic && Math.abs(mean) < UMBILIC_EPS * scale;
  out.degenerate = false;
}

export function markDegenerate(out: SurfacePoint): void {
  out.K = Number.NaN;
  out.H = Number.NaN;
  out.k1 = Number.NaN;
  out.k2 = Number.NaN;
  out.e1[0] = 0;
  out.e1[1] = 0;
  out.e1[2] = 0;
  out.e2[0] = 0;
  out.e2[1] = 0;
  out.e2[2] = 0;
  out.umbilic = false;
  out.planar = false;
  out.degenerate = true;
}
