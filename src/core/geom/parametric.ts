import type { DiffMap } from "../jets/compile.ts";
import { readVec3, surfaceJetOffsets, type SurfaceJetOffsets } from "../jets/jet.ts";
import { markDegenerate, principalAngle, resolveShape } from "./shape.ts";
import type {
  ChartData,
  Christoffel2,
  Interval,
  SurfacePoint,
  Vec3,
} from "./types.ts";

/**
 * Parametric surfaces: the first and second fundamental forms, and everything read off
 * them. Conventions are do Carmo's throughout (§2-5, §3-2, §3-3):
 *
 *     E = ⟨X_u, X_u⟩   F = ⟨X_u, X_v⟩   G = ⟨X_v, X_v⟩
 *     N = X_u × X_v / |X_u × X_v|
 *     e = ⟨N, X_uu⟩    f = ⟨N, X_uv⟩    g = ⟨N, X_vv⟩
 *     A = −dN_p,   K = det A,   H = ½ tr A
 *
 * With that normal the sphere of radius R gives **K = 1/R² and H = −1/R**. The sign of H
 * is a consequence of N pointing outward, not a convention to be argued with: the
 * implicit path via ∇F/|∇F| must reproduce the same −1/R, and the cross-representation
 * test exists to force that agreement.
 *
 * `K = (eg − f²)/(EG − F²)` and `H = ½(eG − 2fF + gE)/(EG − F²)` are *not* used here.
 * They are the ground truth the test suite checks this implementation against; see
 * `shape.ts` for why the eigendecomposition route is the better primary path.
 */

const DEGENERATE_EPS = 1e-12;

export interface ParametricSurface {
  readonly id: string;
  readonly map: DiffMap;
  readonly u: Interval;
  readonly v: Interval;
  readonly periodicU: boolean;
  readonly periodicV: boolean;
  /** reverse N, flipping the sign of H, k₁ and k₂ but not K */
  flipped: boolean;
  /** X(u, v) alone */
  position(u: number, v: number, params: ArrayLike<number>, out: Vec3): void;
  /** the full chart-free curvature data, and optionally the chart-dependent extras */
  at(
    u: number,
    v: number,
    params: ArrayLike<number>,
    out: SurfacePoint,
    chart?: ChartData,
  ): void;
}

export interface ParametricSurfaceOptions {
  readonly id: string;
  /** a map R² → R³ of order ≥ 2 */
  readonly map: DiffMap;
  readonly u: Interval;
  readonly v: Interval;
  readonly periodicU?: boolean;
  readonly periodicV?: boolean;
  readonly flipped?: boolean;
}

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export function createParametricSurface(
  options: ParametricSurfaceOptions,
): ParametricSurface {
  const { id, map, u: uRange, v: vRange } = options;
  const offsets: SurfaceJetOffsets = surfaceJetOffsets(map.layout);

  // Scratch reused across calls. The mesh loop evaluates this tens of thousands of times
  // per retessellation, so allocating a jet buffer or six Vec3s per call would dominate.
  const jet = map.makeJet();
  const X: Vec3 = [0, 0, 0];
  const Xu: Vec3 = [0, 0, 0];
  const Xv: Vec3 = [0, 0, 0];
  const Xuu: Vec3 = [0, 0, 0];
  const Xuv: Vec3 = [0, 0, 0];
  const Xvv: Vec3 = [0, 0, 0];
  const N: Vec3 = [0, 0, 0];
  const t1: Vec3 = [0, 0, 0];
  const t2: Vec3 = [0, 0, 0];
  const argument: [number, number] = [0, 0];

  const surface: ParametricSurface = {
    id,
    map,
    u: uRange,
    v: vRange,
    periodicU: options.periodicU ?? false,
    periodicV: options.periodicV ?? false,
    flipped: options.flipped ?? false,

    position(u, v, params, out) {
      argument[0] = u;
      argument[1] = v;
      map.evaluate(argument, params, jet);
      readVec3(jet, offsets.X, out);
    },

    at(u, v, params, out, chart) {
      argument[0] = u;
      argument[1] = v;
      map.evaluate(argument, params, jet);

      readVec3(jet, offsets.X, X);
      readVec3(jet, offsets.Xu, Xu);
      readVec3(jet, offsets.Xv, Xv);
      readVec3(jet, offsets.Xuu, Xuu);
      readVec3(jet, offsets.Xuv, Xuv);
      readVec3(jet, offsets.Xvv, Xvv);

      out.p[0] = X[0];
      out.p[1] = X[1];
      out.p[2] = X[2];

      const E = dot(Xu, Xu);
      const F = dot(Xu, Xv);
      const G = dot(Xv, Xv);
      // |X_u × X_v|² = EG − F², so the discriminant and the cross product length are
      // the same quantity; one check covers both.
      const det = E * G - F * F;
      const crossLength = Math.sqrt(Math.max(det, 0));

      if (
        !Number.isFinite(det) ||
        !Number.isFinite(X[0] + X[1] + X[2]) ||
        crossLength <= DEGENERATE_EPS * Math.max(1, Math.sqrt(Math.abs(E * G)))
      ) {
        // A pole of the chart, a cone point, or a formula that blew up. Nothing here is
        // meaningful, and saying so is better than emitting a plausible wrong number.
        markDegenerate(out);
        return;
      }

      const sign = surface.flipped ? -1 : 1;
      N[0] = (sign * (Xu[1] * Xv[2] - Xu[2] * Xv[1])) / crossLength;
      N[1] = (sign * (Xu[2] * Xv[0] - Xu[0] * Xv[2])) / crossLength;
      N[2] = (sign * (Xu[0] * Xv[1] - Xu[1] * Xv[0])) / crossLength;

      const e = dot(N, Xuu);
      const f = dot(N, Xuv);
      const g = dot(N, Xvv);

      // Gram–Schmidt on (X_u, X_v). Q's columns are the chart components of (t₁, t₂):
      //   t₁ = X_u/√E
      //   t₂ = (X_v − (F/E)X_u)/w,  w = |X_v − (F/E)X_u| = √((EG − F²)/E)
      const sqrtE = Math.sqrt(E);
      const w = Math.sqrt(det / E);
      const q11 = 1 / sqrtE;
      const q12 = -F / (E * w);
      const q22 = 1 / w;

      t1[0] = q11 * Xu[0];
      t1[1] = q11 * Xu[1];
      t1[2] = q11 * Xu[2];
      t2[0] = q12 * Xu[0] + q22 * Xv[0];
      t2[1] = q12 * Xu[1] + q22 * Xv[1];
      t2[2] = q12 * Xu[2] + q22 * Xv[2];

      // II₂ = Qᵀ · II · Q, symmetric because II is.
      const a = e * q11 * q11;
      const b = q11 * (e * q12 + f * q22);
      const cc = e * q12 * q12 + 2 * f * q12 * q22 + g * q22 * q22;

      resolveShape(a, b, cc, t1, t2, N, X, out);

      if (chart) {
        chart.uv[0] = u;
        chart.uv[1] = v;
        chart.I[0][0] = E;
        chart.I[0][1] = F;
        chart.I[1][0] = F;
        chart.I[1][1] = G;
        chart.II[0][0] = e;
        chart.II[0][1] = f;
        chart.II[1][0] = f;
        chart.II[1][1] = g;
        chart.Xu[0] = Xu[0];
        chart.Xu[1] = Xu[1];
        chart.Xu[2] = Xu[2];
        chart.Xv[0] = Xv[0];
        chart.Xv[1] = Xv[1];
        chart.Xv[2] = Xv[2];

        // Principal directions in chart components: Q · (cos θ, sin θ).
        const theta = principalAngle(a, b, cc);
        const cosTheta = Math.cos(theta);
        const sinTheta = Math.sin(theta);
        chart.e1uv[0] = q11 * cosTheta + q12 * sinTheta;
        chart.e1uv[1] = q22 * sinTheta;
        chart.e2uv[0] = -q11 * sinTheta + q12 * cosTheta;
        chart.e2uv[1] = q22 * cosTheta;

        christoffel(E, F, G, Xu, Xv, Xuu, Xuv, Xvv, det, chart.Gamma);
      }
    },
  };

  return surface;
}

/**
 * Levi-Civita connection of the first fundamental form:
 *
 *     Γᵏᵢⱼ = ½ gᵏˡ (∂ᵢ gⱼˡ + ∂ⱼ gᵢˡ − ∂ˡ gᵢⱼ)
 *
 * The metric derivatives come straight out of the order-2 jet — differentiating
 * `E = ⟨X_u, X_u⟩` needs only `X_uu`, so no third-order data is required:
 *
 *     E_u = 2⟨X_uu, X_u⟩          E_v = 2⟨X_uv, X_u⟩
 *     F_u = ⟨X_uu, X_v⟩ + ⟨X_u, X_uv⟩   F_v = ⟨X_uv, X_v⟩ + ⟨X_u, X_vv⟩
 *     G_u = 2⟨X_uv, X_v⟩          G_v = 2⟨X_vv, X_v⟩
 *
 * This is the intrinsic half of the picture, and it is what the geodesic integrator
 * consumes: γ̈ᵏ = −Γᵏᵢⱼ γ̇ⁱ γ̇ʲ.
 */
function christoffel(
  E: number,
  F: number,
  G: number,
  Xu: Vec3,
  Xv: Vec3,
  Xuu: Vec3,
  Xuv: Vec3,
  Xvv: Vec3,
  det: number,
  out: Christoffel2,
): void {
  const Eu = 2 * dot(Xuu, Xu);
  const Ev = 2 * dot(Xuv, Xu);
  const Fu = dot(Xuu, Xv) + dot(Xu, Xuv);
  const Fv = dot(Xuv, Xv) + dot(Xu, Xvv);
  const Gu = 2 * dot(Xuv, Xv);
  const Gv = 2 * dot(Xvv, Xv);

  // ∂ₖ gᵢⱼ, with 0 ↔ u and 1 ↔ v.
  const dg = [
    [
      [Eu, Ev],
      [Fu, Fv],
    ],
    [
      [Fu, Fv],
      [Gu, Gv],
    ],
  ];

  // g⁻¹ = (1/det) [[G, −F], [−F, E]]
  const gi00 = G / det;
  const gi01 = -F / det;
  const gi11 = E / det;
  const ginv = [
    [gi00, gi01],
    [gi01, gi11],
  ];

  for (let k = 0; k < 2; k++) {
    for (let i = 0; i < 2; i++) {
      for (let j = 0; j < 2; j++) {
        let sum = 0;
        for (let l = 0; l < 2; l++) {
          sum +=
            ginv[k]![l]! *
            (dg[j]![l]![i]! + dg[i]![l]![j]! - dg[i]![j]![l]!);
        }
        out[k]![i]![j] = sum / 2;
      }
    }
  }
}
