import { Ctx, ctx as defaultCtx, isZero, type Expr } from "./ast.ts";
import { lookupFn } from "./fns.ts";

/**
 * Symbolic differentiation.
 *
 * A wrong entry here silently corrupts every downstream quantity — the metric, the
 * second fundamental form, the curvatures, the geodesics — while still producing
 * plausible-looking pictures. So the per-function rules live in one table (`fns.ts`),
 * this file holds only the four structural rules, and the whole thing is checked
 * against independently implemented Taylor arithmetic rather than against itself.
 *
 * ## Memoization is not an optimization here
 *
 * Results are memoized per `(node, variable)`. The AST is a DAG with heavy sharing, and
 * differentiating without memoization would expand that DAG into a tree — which is
 * precisely the third-derivative blowup the plan warns about. With it, a shared
 * subexpression is differentiated once and the derivative stays shared too.
 */

export interface DiffOptions {
  readonly ctx?: Ctx;
}

/** ∂e/∂name. */
export function diff(e: Expr, name: string, options: DiffOptions = {}): Expr {
  const c = options.ctx ?? defaultCtx;
  const memo = new Map<number, Expr>();
  return differentiate(c, e, name, memo);
}

/**
 * Repeated differentiation, e.g. `["u", "v"]` for ∂²e/∂u∂v.
 *
 * Mixed partials commute for the smooth functions in the table, so the caller may pass
 * the variables in whichever order is convenient.
 */
export function diffMulti(e: Expr, names: readonly string[], options: DiffOptions = {}): Expr {
  let out = e;
  for (const name of names) out = diff(out, name, options);
  return out;
}

function differentiate(c: Ctx, e: Expr, name: string, memo: Map<number, Expr>): Expr {
  const cached = memo.get(e.id);
  if (cached) return cached;

  const result = rule(c, e, name, memo);
  memo.set(e.id, result);
  return result;
}

function rule(c: Ctx, e: Expr, name: string, memo: Map<number, Expr>): Expr {
  switch (e.kind) {
    case "num":
      return c.zero;

    case "var":
      return e.name === name ? c.one : c.zero;

    // (Σ fᵢ)′ = Σ fᵢ′
    case "add":
      return c.add(...e.terms.map((t) => differentiate(c, t, name, memo)));

    // (Π fᵢ)′ = Σᵢ fᵢ′ · Π_{j≠i} fⱼ
    case "mul": {
      const terms: Expr[] = [];
      e.factors.forEach((factor, i) => {
        const d = differentiate(c, factor, name, memo);
        if (isZero(d)) return; // skip the whole term rather than build 0 · Π
        const others = e.factors.filter((_, j) => j !== i);
        terms.push(c.mul(d, ...others));
      });
      return c.add(...terms);
    }

    case "pow":
      return powerRule(c, e.base, e.exp, name, memo);

    // Chain rule: f(g₁,…,gₙ)′ = Σᵢ (∂f/∂gᵢ) · gᵢ′
    case "call": {
      const def = lookupFn(e.fn);
      if (!def) {
        // An unknown function cannot be differentiated. Returning NaN rather than
        // throwing keeps the non-finite contract: the row will show "—" and the mesh
        // will drop, instead of the render loop unwinding.
        return c.num(Number.NaN);
      }
      const terms: Expr[] = [];
      e.args.forEach((arg, i) => {
        const inner = differentiate(c, arg, name, memo);
        if (isZero(inner)) return;
        terms.push(c.mul(def.partial(c, e.args, i), inner));
      });
      return c.add(...terms);
    }
  }
}

/**
 * The power rule, in its two genuinely different cases.
 *
 *   constant exponent:  (fⁿ)′ = n fⁿ⁻¹ f′
 *   general:            (f^g)′ = f^g · (g′ ln f + g f′/f)
 *
 * The general form is only used when the exponent actually depends on the variable,
 * because it introduces `ln f` — which is NaN for f < 0 even where the derivative is
 * perfectly well defined. Keeping the constant-exponent case separate means `u^3` and
 * `u^-2` differentiate cleanly on the whole real line, which matters: `u^-2` appears in
 * every Christoffel symbol of a surface of revolution.
 */
function powerRule(
  c: Ctx,
  base: Expr,
  exponent: Expr,
  name: string,
  memo: Map<number, Expr>,
): Expr {
  const dBase = differentiate(c, base, name, memo);
  const dExponent = differentiate(c, exponent, name, memo);

  if (isZero(dExponent)) {
    if (isZero(dBase)) return c.zero;
    // n · fⁿ⁻¹ · f′
    return c.mul(exponent, c.pow(base, c.sub(exponent, c.one)), dBase);
  }

  if (isZero(dBase)) {
    // (aᵍ)′ = aᵍ ln a · g′
    return c.mul(c.pow(base, exponent), c.call("log", base), dExponent);
  }

  // f^g · (g′ ln f + g f′ / f)
  return c.mul(
    c.pow(base, exponent),
    c.add(
      c.mul(dExponent, c.call("log", base)),
      c.mul(exponent, dBase, c.pow(base, c.negOne)),
    ),
  );
}
