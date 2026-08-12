import { Ctx, ctx as defaultCtx, nodeCount, type Expr } from "../expr/ast.ts";
import type { Diagnostic } from "../expr/diagnostics.ts";
import { diff } from "../expr/diff.ts";
import { compileMany, type Backend } from "../expr/eval.ts";
import { simplify, simplifyAll } from "../expr/simplify.ts";
import { differentiationOrder, jetLayout, type JetLayout } from "./jet.ts";

/**
 * Compiling a symbolic map into a jet evaluator.
 *
 * Two decisions make this cheap enough to run on every keystroke:
 *
 *  1. **Partials are built incrementally.** Slots are visited in graded order, so every
 *     partial is one differentiation of an already-computed lower-order partial — never
 *     a fresh `diffMulti` from the original. `X_uv` differentiates `X_u`, which already
 *     exists. Each step is also simplified before the next differentiates it, which is
 *     what keeps third-order expressions from compounding.
 *
 *  2. **The whole jet compiles to one program.** All `slotCount × m` outputs share a
 *     single lowering, so `cos u` computed for the value is reused by every derivative
 *     that needs it. On a torus component this collapses six outputs into barely more
 *     instructions than one.
 */

export interface DiffMap {
  readonly id: string;
  readonly layout: JetLayout;
  readonly vars: readonly string[];
  /** slider slots; changing their values never triggers recompilation */
  readonly params: readonly string[];
  /** the symbolic components, simplified */
  readonly comps: readonly Expr[];
  /** symbolic partials, slot-major then component — `slot * m + c` */
  readonly partials: readonly Expr[];
  readonly diags: readonly Diagnostic[];
  /** instruction count of the compiled program — the budget metric */
  readonly opCount: number;
  /** largest DAG node count among the partials, for diagnostics */
  readonly maxNodeCount: number;
  /** Fill `out` (length `layout.size`) with the jet at `x`. */
  evaluate(x: ArrayLike<number>, params: ArrayLike<number>, out: Float64Array): void;
  /** A correctly sized buffer for `evaluate`. */
  makeJet(): Float64Array;
}

export interface BuildDiffMapOptions {
  readonly id: string;
  /** one expression per output component */
  readonly comps: readonly Expr[];
  /** input variable names, in positional order */
  readonly vars: readonly string[];
  readonly params?: readonly string[];
  readonly order: number;
  readonly ctx?: Ctx;
  readonly backend?: Backend;
  readonly maxOps?: number;
}

export function buildDiffMap(options: BuildDiffMapOptions): DiffMap {
  const {
    id,
    comps,
    vars,
    params = [],
    order,
    ctx: c = defaultCtx,
    backend,
    maxOps,
  } = options;

  const layout = jetLayout(vars.length, comps.length, order);
  const m = comps.length;

  // Partials indexed by "signature|component", filled in graded order so that each is
  // one differentiation away from an entry already present.
  const table = new Map<string, Expr>();
  const simplifiedComps = simplifyAll(comps, { ctx: c });

  for (const alpha of layout.indices) {
    const signature = alpha.join(",");
    const degree = alpha.reduce((a, b) => a + b, 0);

    if (degree === 0) {
      simplifiedComps.forEach((comp, component) => {
        table.set(`${signature}|${component}`, comp);
      });
      continue;
    }

    // Differentiate the predecessor obtained by lowering the first nonzero index.
    const axis = alpha.findIndex((power) => power > 0);
    const predecessor = [...alpha];
    predecessor[axis] = predecessor[axis]! - 1;
    const predecessorSignature = predecessor.join(",");
    const variable = vars[axis]!;

    for (let component = 0; component < m; component++) {
      const previous = table.get(`${predecessorSignature}|${component}`);
      if (previous === undefined) {
        throw new Error(
          `internal: predecessor [${predecessor}] missing while building [${alpha}]`,
        );
      }
      table.set(
        `${signature}|${component}`,
        simplify(diff(previous, variable, { ctx: c }), { ctx: c }),
      );
    }
  }

  // Flatten in slot-major order to match the layout's storage.
  const partials: Expr[] = [];
  for (const alpha of layout.indices) {
    const signature = alpha.join(",");
    for (let component = 0; component < m; component++) {
      partials.push(table.get(`${signature}|${component}`)!);
    }
  }

  const compiled = compileMany(partials, { vars, params, backend, maxOps });

  let maxNodeCount = 0;
  for (const partial of partials) {
    maxNodeCount = Math.max(maxNodeCount, nodeCount(partial));
  }

  return {
    id,
    layout,
    vars,
    params,
    comps: simplifiedComps,
    partials,
    diags: compiled.diags,
    opCount: compiled.program.ops.length,
    maxNodeCount,
    evaluate: compiled.evaluate,
    makeJet: () => new Float64Array(layout.size),
  };
}

/**
 * Verify a jet against repeated `diffMulti` from the original expressions.
 *
 * The incremental construction above is a real optimization with a real failure mode —
 * an off-by-one in the predecessor walk would produce a wrong mixed partial that still
 * looks plausible. This checks the shortcut against the naive route, and is used by the
 * test suite rather than at runtime.
 */
export function partialsMatchDirect(map: DiffMap, ctx: Ctx = defaultCtx): boolean {
  const m = map.comps.length;
  return map.layout.indices.every((alpha, slot) => {
    const names = differentiationOrder(alpha, map.vars);
    return map.comps.every((comp, component) => {
      let direct = comp;
      for (const name of names) direct = diff(direct, name, { ctx });
      // Compare canonical forms; interning then makes this reference equality.
      return simplify(direct, { ctx }) === map.partials[slot * m + component]!;
    });
  });
}
