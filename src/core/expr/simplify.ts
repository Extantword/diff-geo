import {
  compareExpr,
  Ctx,
  ctx as defaultCtx,
  type Expr,
  type MulExpr,
} from "./ast.ts";
import { lookupFn } from "./fns.ts";

/**
 * Bounded canonicalization.
 *
 * ## Where this stops, and why
 *
 * The whole rule set is: canonical ordering, like-term collection in sums, like-base
 * collection in products, and the exact function folds from the table. That is all.
 *
 * There is no trigonometric identity, no factoring, no expansion, no partial fractions,
 * no `√(x²) → |x|`. Those are where hand-rolled simplifiers acquire both correctness
 * bugs and non-termination, and the payoff would be prettier output rather than
 * anything the pipeline needs. The performance problem simplification is often reached
 * for — third derivatives producing enormous expressions — is not actually an algebraic
 * problem: it is **repeated subexpressions**, which common-subexpression elimination at
 * codegen time removes at zero mathematical risk. So that is where the effort goes.
 *
 * This function is a single bottom-up pass with no fixpoint loop, which means "just add
 * one more rewrite rule" cannot introduce non-termination by construction.
 *
 * ## Simplification assumes generic points
 *
 * `x · x⁻¹ → 1` and `x − x → 0` are applied unconditionally, though at `x = 0` and
 * `x = ±∞` the left sides evaluate to NaN. This is the standard convention and it does
 * not conflict with the non-finite contract: that contract governs how *evaluation*
 * reports bad numerics, not which symbolic identities hold. What it does mean is that
 * simplifying can turn a NaN into a number at isolated points, so the ground-truth
 * tests sample interior points rather than singularities.
 */

export interface SimplifyOptions {
  readonly ctx?: Ctx;
}

/** Canonicalize a single expression. */
export function simplify(e: Expr, options: SimplifyOptions = {}): Expr {
  const c = options.ctx ?? defaultCtx;
  return run(c, e, new Map());
}

/**
 * Canonicalize several expressions with a shared memo.
 *
 * Used for jets, where the partials of one map overlap heavily — sharing the memo keeps
 * the common subexpressions identical across outputs, which is what later lets a single
 * CSE pass serve the whole jet.
 */
export function simplifyAll(
  exprs: readonly Expr[],
  options: SimplifyOptions = {},
): Expr[] {
  const c = options.ctx ?? defaultCtx;
  const memo = new Map<number, Expr>();
  return exprs.map((e) => run(c, e, memo));
}

function run(c: Ctx, e: Expr, memo: Map<number, Expr>): Expr {
  const cached = memo.get(e.id);
  if (cached) return cached;

  let out: Expr;
  switch (e.kind) {
    case "num":
    case "var":
      out = e;
      break;
    case "add":
      out = collectSum(c, e.terms.map((t) => run(c, t, memo)));
      break;
    case "mul":
      out = collectProduct(c, e.factors.map((f) => run(c, f, memo)));
      break;
    case "pow":
      out = c.pow(run(c, e.base, memo), run(c, e.exp, memo));
      break;
    case "call":
      out = foldCall(c, e.fn, e.args.map((a) => run(c, a, memo)));
      break;
  }

  memo.set(e.id, out);
  return out;
}

/** Split a product into its numeric coefficient and the interned rest. */
function splitCoefficient(c: Ctx, e: Expr): { coeff: number; rest: Expr | null } {
  if (e.kind === "num") return { coeff: e.value, rest: null };
  if (e.kind !== "mul") return { coeff: 1, rest: e };

  const rest: Expr[] = [];
  let coeff = 1;
  for (const f of (e as MulExpr).factors) {
    if (f.kind === "num") coeff *= f.value;
    else rest.push(f);
  }
  return { coeff, rest: rest.length === 0 ? null : c.mul(...rest) };
}

/**
 * Gather like terms, then order canonically.
 *
 * `2u + 3u → 5u` and `u − u → 0` both fall out of this, as does the constant folding
 * the constructors already do. Grouping keys off the interned identity of the
 * non-numeric part, so the comparison is an integer equality rather than a deep walk.
 */
function collectSum(c: Ctx, terms: readonly Expr[]): Expr {
  let constant = 0;
  const groups = new Map<number, { rest: Expr; coeff: number }>();

  for (const term of terms) {
    // Sums arrive flattened from the constructors, but a nested sum can appear here
    // when a child simplified into one.
    if (term.kind === "add") {
      const inner = collectSum(c, term.terms);
      if (inner.kind === "num") {
        constant += inner.value;
        continue;
      }
      if (inner.kind === "add") {
        for (const t of inner.terms) accumulate(t);
        continue;
      }
      accumulate(inner);
      continue;
    }
    accumulate(term);
  }

  function accumulate(term: Expr): void {
    const { coeff, rest } = splitCoefficient(c, term);
    if (rest === null) {
      constant += coeff;
      return;
    }
    const found = groups.get(rest.id);
    if (found) found.coeff += coeff;
    else groups.set(rest.id, { rest, coeff });
  }

  const parts: Expr[] = [];
  if (constant !== 0) parts.push(c.num(constant));
  for (const { rest, coeff } of groups.values()) {
    if (coeff === 0) continue;
    parts.push(coeff === 1 ? rest : c.mul(c.num(coeff), rest));
  }

  if (parts.length === 0) return c.zero;
  parts.sort(compareExpr);
  return c.add(...parts);
}

/**
 * A factor as base and integer exponent.
 *
 * Only **integer** exponents are merged. `x^a · x^b = x^{a+b}` needs `x > 0` for real
 * exponents — `x^{1/2} · x^{1/2}` is `|x|`, not `x` — and silently assuming positivity
 * on arbitrary user formulas is exactly the kind of unsound rewrite this module exists
 * to avoid. Identical non-integer factors still merge into a squared power, which is
 * always valid.
 */
function splitPower(f: Expr): { base: Expr; exponent: number } {
  if (f.kind === "pow" && f.exp.kind === "num" && Number.isInteger(f.exp.value)) {
    return { base: f.base, exponent: f.exp.value };
  }
  return { base: f, exponent: 1 };
}

/** Gather like bases, then order canonically. `x · x → x²`, `x · x⁻¹ → 1`. */
function collectProduct(c: Ctx, factors: readonly Expr[]): Expr {
  let constant = 1;
  const groups = new Map<number, { base: Expr; exponent: number }>();

  const accumulate = (factor: Expr): void => {
    if (factor.kind === "num") {
      constant *= factor.value;
      return;
    }
    if (factor.kind === "mul") {
      for (const f of factor.factors) accumulate(f);
      return;
    }
    const { base, exponent } = splitPower(factor);
    const found = groups.get(base.id);
    if (found) found.exponent += exponent;
    else groups.set(base.id, { base, exponent });
  };

  for (const factor of factors) accumulate(factor);

  if (constant === 0) return c.zero;

  const parts: Expr[] = [];
  if (constant !== 1) parts.push(c.num(constant));
  for (const { base, exponent } of groups.values()) {
    if (exponent === 0) continue; // x · x⁻¹
    parts.push(exponent === 1 ? base : c.pow(base, c.num(exponent)));
  }

  if (parts.length === 0) return c.num(constant);
  parts.sort(compareExpr);
  return c.mul(...parts);
}

/**
 * Apply the exact folds from the function table: `sin 0 → 0`, `√4 → 2`, `log 1 → 0`.
 *
 * Only exact values fold. `sin(1)` stays symbolic on purpose — collapsing it to
 * 0.8414709848078965 would destroy the user's own notation in the typeset echo, and
 * buys nothing, since the compiled program folds it once at codegen anyway.
 */
function foldCall(c: Ctx, fn: string, args: readonly Expr[]): Expr {
  const def = lookupFn(fn);
  if (def && args.length === 1) {
    const arg = args[0]!;
    if (arg.kind === "num" && def.exact) {
      for (const [input, output] of def.exact) {
        if (arg.value === input) return c.num(output);
      }
    }
  }
  return c.call(fn, ...args);
}
