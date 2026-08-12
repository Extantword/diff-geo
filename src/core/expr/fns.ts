import { type Ctx, type Expr } from "./ast.ts";

/**
 * The one function table.
 *
 * Every built-in function is defined exactly once, carrying everything the four
 * consumers need: numeric evaluation, the partial derivative with respect to each
 * argument, a LaTeX rendering, and a GLSL name. Adding a function means adding one
 * entry here and nothing else — which is the property that keeps `diff`, the printer
 * and the shader emitter from drifting apart.
 *
 * ## Scope: the set is closed under differentiation
 *
 * `min`, `max`, `floor`, `ceil` and `mod` are deliberately **absent**. Their
 * derivatives are indicator functions, which would force conditionals into the AST and
 * a branch into every consumer — for functions that appear nowhere in do Carmo. `abs`
 * is kept because |α′| is everywhere in Chapter 1 and its derivative, `sign`, is
 * already expressible.
 *
 * `sign` has derivative 0, which is correct away from the origin and wrong exactly at
 * it. That is the standard convention and the honest one available without
 * distributions.
 */
export interface FnDef {
  readonly name: string;
  readonly arity: number;
  /** alternative spellings the parser accepts, e.g. `ln` for `log` */
  readonly aliases?: readonly string[];
  /** numeric evaluation; may return non-finite values, per the non-finite contract */
  readonly evaluate: (args: readonly number[]) => number;
  /** ∂f/∂argᵢ as an expression. The chain rule is applied by `diff`, not here. */
  readonly partial: (c: Ctx, args: readonly Expr[], i: number) => Expr;
  /** LaTeX head, e.g. `\sin`, or a full renderer when the shape is unusual */
  readonly latex: string | ((args: readonly string[]) => string);
  /**
   * Inline JavaScript for the code generator. Omitted when `Math.<name>` is exactly
   * right, which covers all but the six reciprocal trigonometric functions — keeping
   * the table free of two dozen identical `Math.sin(x)` lines.
   */
  readonly js?: (args: readonly string[]) => string;
  /** GLSL ES 3.00 name — a builtin, or a helper from the shader prelude */
  readonly glsl: string;
  /** true when `glsl` names a prelude helper rather than a GLSL builtin */
  readonly glslPrelude?: boolean;
  /**
   * Exact values worth folding, as [input, output] pairs. Applied by `simplify`, not
   * by the constructors — `sin(1)` must stay symbolic so the user's own text can be
   * echoed back, while `sin(0)` collapsing to `0` genuinely shrinks derivatives.
   */
  readonly exact?: ReadonlyArray<readonly [number, number]>;
}

const defs: FnDef[] = [];

function define(def: FnDef): void {
  defs.push(def);
}

// --------------------------------------------------------------------------- //
// trigonometric
// --------------------------------------------------------------------------- //

define({
  name: "sin",
  arity: 1,
  evaluate: (a) => Math.sin(a[0]!),
  // (sin u)′ = cos u
  partial: (c, a) => c.call("cos", a[0]!),
  latex: "\\sin",
  glsl: "sin",
  exact: [[0, 0]],
});

define({
  name: "cos",
  arity: 1,
  evaluate: (a) => Math.cos(a[0]!),
  // (cos u)′ = −sin u
  partial: (c, a) => c.neg(c.call("sin", a[0]!)),
  latex: "\\cos",
  glsl: "cos",
  exact: [[0, 1]],
});

define({
  name: "tan",
  arity: 1,
  evaluate: (a) => Math.tan(a[0]!),
  // (tan u)′ = sec²u = 1/cos²u — written as cos^(−2) to avoid depending on `sec`
  partial: (c, a) => c.pow(c.call("cos", a[0]!), c.num(-2)),
  latex: "\\tan",
  glsl: "tan",
  exact: [[0, 0]],
});

define({
  name: "cot",
  arity: 1,
  evaluate: (a) => 1 / Math.tan(a[0]!),
  // (cot u)′ = −csc²u = −1/sin²u.  This is the function that makes chart poles
  // singular: the sphere's Γᵛᵤᵥ is cot u, infinite at u = 0 and π.
  partial: (c, a) => c.neg(c.pow(c.call("sin", a[0]!), c.num(-2))),
  latex: "\\cot",
  js: (a) => `(1 / Math.tan(${a[0]}))`,
  glsl: "cot_",
  glslPrelude: true,
});

define({
  name: "sec",
  arity: 1,
  evaluate: (a) => 1 / Math.cos(a[0]!),
  // (sec u)′ = sec u · tan u
  partial: (c, a) => c.mul(c.call("sec", a[0]!), c.call("tan", a[0]!)),
  latex: "\\sec",
  js: (a) => `(1 / Math.cos(${a[0]}))`,
  glsl: "sec_",
  glslPrelude: true,
  exact: [[0, 1]],
});

define({
  name: "csc",
  arity: 1,
  evaluate: (a) => 1 / Math.sin(a[0]!),
  // (csc u)′ = −csc u · cot u
  partial: (c, a) => c.neg(c.mul(c.call("csc", a[0]!), c.call("cot", a[0]!))),
  latex: "\\csc",
  js: (a) => `(1 / Math.sin(${a[0]}))`,
  glsl: "csc_",
  glslPrelude: true,
});

// --------------------------------------------------------------------------- //
// inverse trigonometric
// --------------------------------------------------------------------------- //

/** 1 − u², the recurring radicand of the inverse trigonometric derivatives. */
function oneMinusSquare(c: Ctx, u: Expr): Expr {
  return c.sub(c.one, c.pow(u, c.num(2)));
}

define({
  name: "asin",
  arity: 1,
  aliases: ["arcsin"],
  evaluate: (a) => Math.asin(a[0]!),
  // (asin u)′ = 1/√(1 − u²)
  partial: (c, a) => c.pow(c.call("sqrt", oneMinusSquare(c, a[0]!)), c.negOne),
  latex: "\\arcsin",
  glsl: "asin",
  exact: [[0, 0]],
});

define({
  name: "acos",
  arity: 1,
  aliases: ["arccos"],
  evaluate: (a) => Math.acos(a[0]!),
  // (acos u)′ = −1/√(1 − u²)
  partial: (c, a) => c.neg(c.pow(c.call("sqrt", oneMinusSquare(c, a[0]!)), c.negOne)),
  latex: "\\arccos",
  glsl: "acos",
});

define({
  name: "atan",
  arity: 1,
  aliases: ["arctan"],
  evaluate: (a) => Math.atan(a[0]!),
  // (atan u)′ = 1/(1 + u²)
  partial: (c, a) => c.pow(c.add(c.one, c.pow(a[0]!, c.num(2))), c.negOne),
  latex: "\\arctan",
  glsl: "atan",
  exact: [[0, 0]],
});

define({
  name: "atan2",
  arity: 2,
  evaluate: (a) => Math.atan2(a[0]!, a[1]!),
  // ∂/∂y = x/(x²+y²),  ∂/∂x = −y/(x²+y²)   for atan2(y, x)
  partial: (c, a, i) => {
    const y = a[0]!;
    const x = a[1]!;
    const denom = c.add(c.pow(x, c.num(2)), c.pow(y, c.num(2)));
    return i === 0 ? c.div(x, denom) : c.neg(c.div(y, denom));
  },
  latex: (a) => `\\operatorname{atan2}\\left(${a[0]}, ${a[1]}\\right)`,
  glsl: "atan",
});

// --------------------------------------------------------------------------- //
// hyperbolic — the pseudosphere and the catenoid live here
// --------------------------------------------------------------------------- //

define({
  name: "sinh",
  arity: 1,
  evaluate: (a) => Math.sinh(a[0]!),
  partial: (c, a) => c.call("cosh", a[0]!),
  latex: "\\sinh",
  glsl: "sinh",
  exact: [[0, 0]],
});

define({
  name: "cosh",
  arity: 1,
  evaluate: (a) => Math.cosh(a[0]!),
  partial: (c, a) => c.call("sinh", a[0]!),
  latex: "\\cosh",
  glsl: "cosh",
  exact: [[0, 1]],
});

define({
  name: "tanh",
  arity: 1,
  evaluate: (a) => Math.tanh(a[0]!),
  // (tanh u)′ = sech²u = 1/cosh²u
  partial: (c, a) => c.pow(c.call("cosh", a[0]!), c.num(-2)),
  latex: "\\tanh",
  glsl: "tanh",
  exact: [[0, 0]],
});

define({
  name: "coth",
  arity: 1,
  evaluate: (a) => 1 / Math.tanh(a[0]!),
  partial: (c, a) => c.neg(c.pow(c.call("sinh", a[0]!), c.num(-2))),
  latex: "\\coth",
  js: (a) => `(1 / Math.tanh(${a[0]}))`,
  glsl: "coth_",
  glslPrelude: true,
});

define({
  name: "sech",
  arity: 1,
  evaluate: (a) => 1 / Math.cosh(a[0]!),
  // (sech u)′ = −sech u · tanh u.  The pseudosphere is (sech u cos v, sech u sin v,
  // u − tanh u), so this one is load-bearing for the K = −1 ground truth.
  partial: (c, a) => c.neg(c.mul(c.call("sech", a[0]!), c.call("tanh", a[0]!))),
  latex: "\\operatorname{sech}",
  js: (a) => `(1 / Math.cosh(${a[0]}))`,
  glsl: "sech_",
  glslPrelude: true,
  exact: [[0, 1]],
});

define({
  name: "csch",
  arity: 1,
  evaluate: (a) => 1 / Math.sinh(a[0]!),
  partial: (c, a) => c.neg(c.mul(c.call("csch", a[0]!), c.call("coth", a[0]!))),
  latex: "\\operatorname{csch}",
  js: (a) => `(1 / Math.sinh(${a[0]}))`,
  glsl: "csch_",
  glslPrelude: true,
});

define({
  name: "asinh",
  arity: 1,
  evaluate: (a) => Math.asinh(a[0]!),
  // (asinh u)′ = 1/√(u² + 1)
  partial: (c, a) =>
    c.pow(c.call("sqrt", c.add(c.pow(a[0]!, c.num(2)), c.one)), c.negOne),
  latex: "\\operatorname{arcsinh}",
  glsl: "asinh",
  exact: [[0, 0]],
});

define({
  name: "acosh",
  arity: 1,
  evaluate: (a) => Math.acosh(a[0]!),
  // (acosh u)′ = 1/√(u² − 1)
  partial: (c, a) =>
    c.pow(c.call("sqrt", c.sub(c.pow(a[0]!, c.num(2)), c.one)), c.negOne),
  latex: "\\operatorname{arccosh}",
  glsl: "acosh",
});

define({
  name: "atanh",
  arity: 1,
  evaluate: (a) => Math.atanh(a[0]!),
  // (atanh u)′ = 1/(1 − u²)
  partial: (c, a) => c.pow(oneMinusSquare(c, a[0]!), c.negOne),
  latex: "\\operatorname{arctanh}",
  glsl: "atanh",
  exact: [[0, 0]],
});

// --------------------------------------------------------------------------- //
// exponential, logarithmic, roots
// --------------------------------------------------------------------------- //

define({
  name: "exp",
  arity: 1,
  evaluate: (a) => Math.exp(a[0]!),
  partial: (c, a) => c.call("exp", a[0]!),
  latex: (a) => `e^{${a[0]}}`,
  glsl: "exp",
  exact: [[0, 1]],
});

define({
  name: "log",
  arity: 1,
  aliases: ["ln"],
  evaluate: (a) => Math.log(a[0]!),
  // (log u)′ = 1/u
  partial: (c, a) => c.pow(a[0]!, c.negOne),
  latex: "\\ln",
  glsl: "log",
  exact: [[1, 0]],
});

define({
  name: "log10",
  arity: 1,
  evaluate: (a) => Math.log10(a[0]!),
  // (log₁₀ u)′ = 1/(u ln 10)
  partial: (c, a) => c.pow(c.mul(a[0]!, c.num(Math.LN10)), c.negOne),
  latex: (a) => `\\log_{10}\\left(${a[0]}\\right)`,
  glsl: "log10_",
  glslPrelude: true,
  exact: [[1, 0]],
});

define({
  name: "log2",
  arity: 1,
  evaluate: (a) => Math.log2(a[0]!),
  partial: (c, a) => c.pow(c.mul(a[0]!, c.num(Math.LN2)), c.negOne),
  latex: (a) => `\\log_{2}\\left(${a[0]}\\right)`,
  glsl: "log2",
  exact: [[1, 0]],
});

define({
  name: "sqrt",
  arity: 1,
  evaluate: (a) => Math.sqrt(a[0]!),
  // (√u)′ = 1/(2√u)
  partial: (c, a) => c.pow(c.mul(c.num(2), c.call("sqrt", a[0]!)), c.negOne),
  latex: (a) => `\\sqrt{${a[0]}}`,
  glsl: "sqrt",
  exact: [
    [0, 0],
    [1, 1],
    [4, 2],
    [9, 3],
    [16, 4],
    [25, 5],
  ],
});

define({
  name: "cbrt",
  arity: 1,
  evaluate: (a) => Math.cbrt(a[0]!),
  // (∛u)′ = 1/(3 ∛u²).  Written through `cbrt` rather than as u^(−2/3) so that it
  // stays real for u < 0, where pow() would produce NaN.
  partial: (c, a) =>
    c.pow(c.mul(c.num(3), c.pow(c.call("cbrt", a[0]!), c.num(2))), c.negOne),
  latex: (a) => `\\sqrt[3]{${a[0]}}`,
  glsl: "cbrt_",
  glslPrelude: true,
  exact: [
    [0, 0],
    [1, 1],
    [8, 2],
    [27, 3],
  ],
});

define({
  name: "abs",
  arity: 1,
  evaluate: (a) => Math.abs(a[0]!),
  // (|u|)′ = sgn u — correct away from 0, undefined at it
  partial: (c, a) => c.call("sign", a[0]!),
  latex: (a) => `\\left|${a[0]}\\right|`,
  glsl: "abs",
  exact: [[0, 0]],
});

define({
  name: "sign",
  arity: 1,
  aliases: ["sgn"],
  evaluate: (a) => Math.sign(a[0]!),
  // 0 away from the origin; the distributional 2δ(u) is not representable here
  partial: (c) => c.zero,
  latex: (a) => `\\operatorname{sgn}\\left(${a[0]}\\right)`,
  glsl: "sign",
  exact: [[0, 0]],
});

// --------------------------------------------------------------------------- //
// lookup
// --------------------------------------------------------------------------- //

const byName = new Map<string, FnDef>();
for (const def of defs) {
  byName.set(def.name, def);
  for (const alias of def.aliases ?? []) byName.set(alias, def);
}

/** Canonical definition for a name or alias, or undefined if unknown. */
export function lookupFn(name: string): FnDef | undefined {
  return byName.get(name);
}

/** True for any name the parser should treat as a function rather than a variable. */
export function isFnName(name: string): boolean {
  return byName.has(name);
}

/** Every accepted spelling, longest first — the parser matches greedily. */
export const FN_NAMES: readonly string[] = [...byName.keys()].sort(
  (a, b) => b.length - a.length || a.localeCompare(b),
);

/** Canonical definitions only, without aliases. */
export const FN_DEFS: readonly FnDef[] = defs;

/** Names of the prelude helpers a given set of functions requires in GLSL. */
export function requiredGlslHelpers(names: Iterable<string>): string[] {
  const needed = new Set<string>();
  for (const name of names) {
    const def = lookupFn(name);
    if (def?.glslPrelude) needed.add(def.glsl);
  }
  return [...needed].sort();
}
