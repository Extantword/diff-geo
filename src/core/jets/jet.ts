/**
 * Jets: the value and all partial derivatives of a map R^n → R^m up to order k.
 *
 * This is the single primitive the whole geometry layer is built on. Everything in do
 * Carmo is a map R^n → R^m with n ∈ {1,2} and m ∈ {2,3}, or a level set of one, and
 * every quantity is read off a jet of low order:
 *
 *   order 1   tangent vectors, the first fundamental form
 *   order 2   the second fundamental form (X_uu), curvature of a level set (Hess F),
 *             Christoffel symbols (first derivatives of E, F, G are still order 2 of X)
 *   order 3   torsion (α‴), ∇K, the Codazzi–Mainardi residual
 *
 * ## Layout
 *
 * Partials are indexed by multi-index α with |α| ≤ k, in graded lexicographic order.
 * For n = 2, k = 2 that is (0,0), (1,0), (0,1), (2,0), (1,1), (0,2) — so X, X_u, X_v,
 * X_uu, X_uv, X_vv, which is the order the textbook introduces them in.
 *
 * Storage is one flat Float64Array of `slotCount × m` doubles. Flat rather than nested
 * arrays because the mesh loop evaluates this tens of thousands of times per
 * retessellation and per-call allocation would dominate. Readability is recovered by
 * `surfaceJetOffsets`, which resolves the named offsets once per surface so that the
 * geometry code can still read like the book.
 */

import type { Vec3 } from "../geom/types.ts";

/** All multi-indices of exactly degree `d` over `n` variables, in lexicographic order. */
function compositions(n: number, d: number): number[][] {
  if (n === 1) return [[d]];
  const out: number[][] = [];
  for (let i = d; i >= 0; i--) {
    for (const rest of compositions(n - 1, d - i)) out.push([i, ...rest]);
  }
  return out;
}

export interface JetLayout {
  /** number of input variables */
  readonly n: number;
  /** number of output components */
  readonly m: number;
  /** highest derivative order included */
  readonly order: number;
  /** slot → multi-index, graded lexicographic */
  readonly indices: ReadonlyArray<readonly number[]>;
  readonly slotCount: number;
  /** total doubles in the buffer */
  readonly size: number;
  /** multi-index → slot, or -1 if outside the layout */
  slotOf(alpha: readonly number[]): number;
}

const layoutCache = new Map<string, JetLayout>();

export function jetLayout(n: number, m: number, order: number): JetLayout {
  const key = `${n},${m},${order}`;
  const cached = layoutCache.get(key);
  if (cached) return cached;

  const indices: number[][] = [];
  for (let d = 0; d <= order; d++) indices.push(...compositions(n, d));

  const bySignature = new Map<string, number>();
  indices.forEach((alpha, slot) => bySignature.set(alpha.join(","), slot));

  const layout: JetLayout = {
    n,
    m,
    order,
    indices,
    slotCount: indices.length,
    size: indices.length * m,
    slotOf: (alpha) => bySignature.get(alpha.join(",")) ?? -1,
  };
  layoutCache.set(key, layout);
  return layout;
}

/**
 * The variables to differentiate by, for a multi-index. `[2,1]` over `["u","v"]` gives
 * `["u","u","v"]` — the argument `diffMulti` wants.
 */
export function differentiationOrder(
  alpha: readonly number[],
  vars: readonly string[],
): string[] {
  const out: string[] = [];
  alpha.forEach((power, i) => {
    for (let k = 0; k < power; k++) out.push(vars[i]!);
  });
  return out;
}

/** Offset into a jet buffer for one partial's component. */
export function offsetOf(layout: JetLayout, alpha: readonly number[], component: number): number {
  const slot = layout.slotOf(alpha);
  if (slot < 0) throw new Error(`multi-index [${alpha}] is outside this jet layout`);
  return slot * layout.m + component;
}

/**
 * Precomputed offsets for a surface jet — a map R² → R³ of order ≥ 2.
 *
 * Resolved once per surface so the hot loop indexes the flat buffer directly, while the
 * geometry code still names X_uu rather than counting slots.
 */
export interface SurfaceJetOffsets {
  readonly X: number;
  readonly Xu: number;
  readonly Xv: number;
  readonly Xuu: number;
  readonly Xuv: number;
  readonly Xvv: number;
}

export function surfaceJetOffsets(layout: JetLayout): SurfaceJetOffsets {
  if (layout.n !== 2 || layout.m !== 3) {
    throw new Error(`expected a map R² → R³, got R^${layout.n} → R^${layout.m}`);
  }
  if (layout.order < 2) {
    throw new Error(`the second fundamental form needs order ≥ 2, got ${layout.order}`);
  }
  return {
    X: offsetOf(layout, [0, 0], 0),
    Xu: offsetOf(layout, [1, 0], 0),
    Xv: offsetOf(layout, [0, 1], 0),
    Xuu: offsetOf(layout, [2, 0], 0),
    Xuv: offsetOf(layout, [1, 1], 0),
    Xvv: offsetOf(layout, [0, 2], 0),
  };
}

/** Precomputed offsets for a curve jet — a map R → R³ of order ≥ 3. */
export interface CurveJetOffsets {
  readonly a: number;
  readonly a1: number;
  readonly a2: number;
  readonly a3: number;
}

export function curveJetOffsets(layout: JetLayout): CurveJetOffsets {
  if (layout.n !== 1) {
    throw new Error(`expected a map of one variable, got R^${layout.n}`);
  }
  if (layout.order < 3) {
    throw new Error(`torsion needs order ≥ 3, got ${layout.order}`);
  }
  return {
    a: offsetOf(layout, [0], 0),
    a1: offsetOf(layout, [1], 0),
    a2: offsetOf(layout, [2], 0),
    a3: offsetOf(layout, [3], 0),
  };
}

/** Read three consecutive components starting at `offset` into `out`. */
export function readVec3(data: Float64Array, offset: number, out: Vec3): Vec3 {
  out[0] = data[offset]!;
  out[1] = data[offset + 1]!;
  out[2] = data[offset + 2]!;
  return out;
}

/** True when every component of the jet is finite — the non-finite contract's gate. */
export function jetIsFinite(data: Float64Array, upTo = data.length): boolean {
  for (let i = 0; i < upTo; i++) {
    if (!Number.isFinite(data[i]!)) return false;
  }
  return true;
}
