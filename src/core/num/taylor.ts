import type { Expr } from "../expr/ast.ts";

/**
 * Truncated-Taylor-series arithmetic, as an independent check on symbolic differentiation.
 *
 * ## What it is
 *
 * Instead of carrying one number through a computation, carry the first `order + 1` coefficients of
 * a function's Taylor expansion:
 *
 *     f(x₀ + h) = a₀ + a₁h + a₂h² + … + aₙhⁿ + O(hⁿ⁺¹)
 *
 * and define +, ×, ÷ and every elementary function to operate on whole coefficient vectors. Since
 * `aₖ = f⁽ᵏ⁾(x₀)/k!`, the vector *is* the derivative tower — a jet, arrived at numerically instead
 * of symbolically.
 *
 * ## Why the elementary functions need no derivative formulas
 *
 * This is the part that makes it a genuine second opinion rather than a restatement of the first.
 * Every elementary function satisfies an ODE, and the ODE becomes a recurrence on coefficients: for
 * `y = eᵘ`, from `y′ = y·u′`, comparing coefficients of hᵏ gives `y_{k+1} = (y ⊛ u′)ₖ / (k+1)`,
 * where ⊛ is the discrete convolution. So `exp` of a series costs one convolution per order and
 * **nothing here reads `fns.ts`'s `partial` table**. A wrong entry in that table cannot hide in
 * this file, which is the entire point.
 *
 * `tan`, `sinh`, `powReal` and friends follow the same pattern; the reciprocal functions are simply
 * composed (`sec = 1/cos`), which is fewer rules and no less independent.
 *
 * ## Why not finite differences
 *
 * A third derivative by differencing suffers catastrophic cancellation, lands near 1e-5 relative,
 * and needs a step size tuned per expression — so tests built on it are flaky, and flaky tolerances
 * get loosened until they catch nothing. Taylor arithmetic is exact to machine precision and has no
 * step size to tune.
 *
 * ## Directional, and what that means for mixed partials
 *
 * The core here is univariate: giving each variable the series `[x₀ᵢ, vᵢ, 0, …]` makes the result's
 * coefficients the **directional** derivatives, `aₘ = D_v^m f / m!`. That is enough to verify every
 * mixed partial, because
 *
 *     D_v^m f = Σ_{|α| = m} (m!/α!) v^α ∂^α f
 *
 * is linear in the partials — so agreement across enough directions pins each one individually.
 * Recovering the partials *separately* would need polarization on top of this, which is the piece
 * still missing before this could serve as the numeric fallback for jets past the node budget.
 *
 * ## The non-finite contract
 *
 * Nothing here throws. A division by a series with zero constant term, `log` of a negative, or
 * `abs` at zero all yield non-finite coefficients, and callers branch explicitly.
 */

/** Taylor coefficients aₖ, so that f(x₀+h) = Σ aₖ hᵏ. Length is `order + 1`. */
export type Series = Float64Array;

export function constantSeries(value: number, order: number): Series {
  const s = new Float64Array(order + 1);
  s[0] = value;
  return s;
}

/**
 * The series of a variable moving at rate `slope`: `x₀ + slope·h`.
 *
 * With one variable given slope 1 and the rest 0, the result holds that variable's pure partials.
 * With slopes set to a direction's components, it holds the directional derivatives along it.
 */
export function variableSeries(value: number, slope: number, order: number): Series {
  const s = new Float64Array(order + 1);
  s[0] = value;
  if (order >= 1) s[1] = slope;
  return s;
}

/** Coefficient k of the product, `Σⱼ aⱼ·b_{k−j}` — the product rule, at every order at once. */
function convolve(a: Series, b: Series, k: number): number {
  let total = 0;
  for (let j = 0; j <= k; j++) total += a[j]! * b[k - j]!;
  return total;
}

function add(a: Series, b: Series): Series {
  const out = new Float64Array(a.length);
  for (let k = 0; k < a.length; k++) out[k] = a[k]! + b[k]!;
  return out;
}

function scale(a: Series, factor: number): Series {
  const out = new Float64Array(a.length);
  for (let k = 0; k < a.length; k++) out[k] = a[k]! * factor;
  return out;
}

function shift(a: Series, offset: number): Series {
  const out = new Float64Array(a.length);
  out.set(a);
  out[0] = a[0]! + offset;
  return out;
}

function multiply(a: Series, b: Series): Series {
  const out = new Float64Array(a.length);
  for (let k = 0; k < a.length; k++) out[k] = convolve(a, b, k);
  return out;
}

/**
 * Series division, by inverting the convolution: `qₖ = (aₖ − Σ_{j<k} qⱼ·b_{k−j}) / b₀`.
 *
 * A zero constant term in the divisor makes every coefficient non-finite rather than throwing —
 * `1/tan(u)` at a chart pole is an ordinary event, not an error.
 */
function divide(a: Series, b: Series): Series {
  const out = new Float64Array(a.length);
  const b0 = b[0]!;
  for (let k = 0; k < a.length; k++) {
    let acc = a[k]!;
    for (let j = 0; j < k; j++) acc -= out[j]! * b[k - j]!;
    out[k] = acc / b0;
  }
  return out;
}

/** d/dh of a series: `(u′)ₘ = (m+1)·u_{m+1}`. The last coefficient is lost to truncation. */
function differentiate(u: Series): Series {
  const out = new Float64Array(u.length);
  for (let m = 0; m + 1 < u.length; m++) out[m] = (m + 1) * u[m + 1]!;
  return out;
}

/**
 * Build a series from its defining ODE, one order at a time.
 *
 * `derivativeCoefficient(y, k)` returns coefficient k of dy/dh, and may read `y[0..k]` — which is
 * exactly what is already known when `y[k+1]` is about to be written. That is what lets an implicit
 * rule like `y′ = y·u′` be solved by nothing more than a forward loop.
 */
function fromOde(
  order: number,
  y0: number,
  derivativeCoefficient: (y: Series, k: number) => number,
): Series {
  const y = new Float64Array(order + 1);
  y[0] = y0;
  for (let k = 0; k < order; k++) {
    y[k + 1] = derivativeCoefficient(y, k) / (k + 1);
  }
  return y;
}

/** A series whose every coefficient is non-finite, for arguments outside a function's domain. */
function nonFinite(order: number, value = Number.NaN): Series {
  return new Float64Array(order + 1).fill(value);
}

// --------------------------------------------------------------------------- //
// elementary functions, each from its own ODE
// --------------------------------------------------------------------------- //

function sExp(u: Series): Series {
  const du = differentiate(u);
  // y′ = y·u′
  return fromOde(u.length - 1, Math.exp(u[0]!), (y, k) => convolve(y, du, k));
}

function sLog(u: Series): Series {
  // y′ = u′/u, which depends on u alone, so one division does it.
  const q = divide(differentiate(u), u);
  const y = fromOde(u.length - 1, Math.log(u[0]!), (_y, k) => q[k]!);
  return y;
}

/** sin and cos together, since each one's ODE names the other. */
function sSinCos(u: Series): { sin: Series; cos: Series } {
  const order = u.length - 1;
  const du = differentiate(u);
  const sin = new Float64Array(order + 1);
  const cos = new Float64Array(order + 1);
  sin[0] = Math.sin(u[0]!);
  cos[0] = Math.cos(u[0]!);
  for (let k = 0; k < order; k++) {
    // s′ = c·u′ and c′ = −s·u′; both new coefficients come from the old ones.
    sin[k + 1] = convolve(cos, du, k) / (k + 1);
    cos[k + 1] = -convolve(sin, du, k) / (k + 1);
  }
  return { sin, cos };
}

function sSinhCosh(u: Series): { sinh: Series; cosh: Series } {
  const order = u.length - 1;
  const du = differentiate(u);
  const sinh = new Float64Array(order + 1);
  const cosh = new Float64Array(order + 1);
  sinh[0] = Math.sinh(u[0]!);
  cosh[0] = Math.cosh(u[0]!);
  for (let k = 0; k < order; k++) {
    sinh[k + 1] = convolve(cosh, du, k) / (k + 1);
    cosh[k + 1] = convolve(sinh, du, k) / (k + 1);
  }
  return { sinh, cosh };
}

function sTan(u: Series): Series {
  const du = differentiate(u);
  // y′ = (1 + y²)·u′
  return fromOde(u.length - 1, Math.tan(u[0]!), (y, k) =>
    convolve(shift(multiply(y, y), 1), du, k),
  );
}

function sTanh(u: Series): Series {
  const du = differentiate(u);
  // y′ = (1 − y²)·u′
  return fromOde(u.length - 1, Math.tanh(u[0]!), (y, k) =>
    convolve(shift(scale(multiply(y, y), -1), 1), du, k),
  );
}

/**
 * A real power, from `y′ = p·y·u′/u`.
 *
 * One rule covers `sqrt`, `cbrt` and every non-integer exponent. Integer exponents are handled by
 * repeated multiplication instead — this form divides by u, and `x²` at `x = 0` is far too common
 * to answer with NaN.
 */
function sPowReal(u: Series, p: number): Series {
  const order = u.length - 1;
  const base = u[0]!;
  const y0 = Math.pow(base, p);
  if (!Number.isFinite(y0)) return nonFinite(order, y0);
  const q = divide(differentiate(u), u);
  return fromOde(order, y0, (y, k) => p * convolve(y, q, k));
}

/** An integer power by repeated multiplication, so a zero base is no obstacle. */
function sPowInt(u: Series, n: number): Series {
  const order = u.length - 1;
  if (n === 0) return constantSeries(1, order);
  let result = constantSeries(1, order);
  for (let i = 0; i < Math.abs(n); i++) result = multiply(result, u);
  return n > 0 ? result : divide(constantSeries(1, order), result);
}

/** `sqrt` and `cbrt` share the power rule but keep their own value, for a negative cube root. */
function sCbrt(u: Series): Series {
  const order = u.length - 1;
  const q = divide(differentiate(u), u);
  return fromOde(order, Math.cbrt(u[0]!), (y, k) => (1 / 3) * convolve(y, q, k));
}

/**
 * Any function whose derivative is `u′/g(u)` for a `g` built from u alone.
 *
 * Covers the whole inverse-trigonometric family: the divisor is known up front, so a single series
 * division gives every coefficient of y′ and the integration is a plain loop.
 */
function fromQuotientRule(u: Series, y0: number, divisor: Series, sign = 1): Series {
  const q = divide(differentiate(u), divisor);
  return fromOde(u.length - 1, y0, (_y, k) => sign * q[k]!);
}

function sAbs(u: Series): Series {
  const order = u.length - 1;
  const at = u[0]!;
  if (at > 0) return u.slice();
  if (at < 0) return scale(u, -1);
  // Not differentiable at zero: the value is 0 and every derivative is undefined.
  const out = nonFinite(order);
  out[0] = 0;
  return out;
}

function sSign(u: Series): Series {
  const order = u.length - 1;
  const at = u[0]!;
  // Locally constant away from zero, so every higher coefficient vanishes.
  if (at !== 0) return constantSeries(Math.sign(at), order);
  const out = nonFinite(order);
  out[0] = 0;
  return out;
}

// --------------------------------------------------------------------------- //
// evaluating an expression over series
// --------------------------------------------------------------------------- //

/**
 * Evaluate `expr` in truncated-series arithmetic, with each variable's series supplied.
 *
 * An unknown variable name yields a non-finite series rather than throwing, matching how the rest
 * of `core` treats a formula that refers to something absent.
 */
export function taylorEval(
  expr: Expr,
  vars: ReadonlyMap<string, Series>,
  order: number,
): Series {
  switch (expr.kind) {
    case "num":
      return constantSeries(expr.value, order);

    case "var": {
      const found = vars.get(expr.name);
      return found ? found.slice() : nonFinite(order);
    }

    case "add": {
      let total = constantSeries(0, order);
      for (const term of expr.terms) total = add(total, taylorEval(term, vars, order));
      return total;
    }

    case "mul": {
      let product = constantSeries(1, order);
      for (const factor of expr.factors) {
        product = multiply(product, taylorEval(factor, vars, order));
      }
      return product;
    }

    case "pow": {
      const base = taylorEval(expr.base, vars, order);
      if (expr.exp.kind === "num") {
        const p = expr.exp.value;
        return Number.isInteger(p) ? sPowInt(base, p) : sPowReal(base, p);
      }
      // A varying exponent: a^b = exp(b·log a), which is where its derivative comes from anyway.
      const exponent = taylorEval(expr.exp, vars, order);
      return sExp(multiply(exponent, sLog(base)));
    }

    case "call":
      return callSeries(expr.fn, expr.args.map((a) => taylorEval(a, vars, order)), order);
  }
}

function callSeries(fn: string, args: readonly Series[], order: number): Series {
  const u = args[0] ?? constantSeries(Number.NaN, order);
  const one = constantSeries(1, order);

  switch (fn) {
    case "sin":
      return sSinCos(u).sin;
    case "cos":
      return sSinCos(u).cos;
    case "tan":
      return sTan(u);
    // The reciprocal family, composed rather than given rules of their own.
    case "cot":
      return divide(one, sTan(u));
    case "sec":
      return divide(one, sSinCos(u).cos);
    case "csc":
      return divide(one, sSinCos(u).sin);
    case "sinh":
      return sSinhCosh(u).sinh;
    case "cosh":
      return sSinhCosh(u).cosh;
    case "tanh":
      return sTanh(u);
    case "coth":
      return divide(one, sTanh(u));
    case "sech":
      return divide(one, sSinhCosh(u).cosh);
    case "csch":
      return divide(one, sSinhCosh(u).sinh);

    // y′ = ±u′/√(1−u²), u′/(1+u²) and so on: the divisor is built from u alone.
    case "asin":
      return fromQuotientRule(u, Math.asin(u[0]!), sPowReal(shift(scale(multiply(u, u), -1), 1), 0.5));
    case "acos":
      return fromQuotientRule(
        u,
        Math.acos(u[0]!),
        sPowReal(shift(scale(multiply(u, u), -1), 1), 0.5),
        -1,
      );
    case "atan":
      return fromQuotientRule(u, Math.atan(u[0]!), shift(multiply(u, u), 1));
    case "asinh":
      return fromQuotientRule(u, Math.asinh(u[0]!), sPowReal(shift(multiply(u, u), 1), 0.5));
    case "acosh":
      return fromQuotientRule(
        u,
        Math.acosh(u[0]!),
        sPowReal(shift(multiply(u, u), -1), 0.5),
      );
    case "atanh":
      return fromQuotientRule(u, Math.atanh(u[0]!), shift(scale(multiply(u, u), -1), 1));

    case "exp":
      return sExp(u);
    case "log":
      return sLog(u);
    case "log10":
      return scale(sLog(u), 1 / Math.LN10);
    case "log2":
      return scale(sLog(u), 1 / Math.LN2);
    case "sqrt":
      return sPowReal(u, 0.5);
    case "cbrt":
      return sCbrt(u);
    case "abs":
      return sAbs(u);
    case "sign":
      return sSign(u);

    case "atan2": {
      /**
       * `d atan2(y, x) = (x·y′ − y·x′)/(x² + y²)`.
       *
       * Written from the quotient directly rather than as `atan(y/x)`, which would be wrong across
       * the branch and would divide by zero on the y axis.
       */
      const y = args[0] ?? constantSeries(Number.NaN, order);
      const x = args[1] ?? constantSeries(Number.NaN, order);
      const numerator = add(multiply(x, differentiate(y)), scale(multiply(y, differentiate(x)), -1));
      const q = divide(numerator, add(multiply(x, x), multiply(y, y)));
      return fromOde(order, Math.atan2(y[0]!, x[0]!), (_s, k) => q[k]!);
    }

    default:
      return nonFinite(order);
  }
}

// --------------------------------------------------------------------------- //
// the interface a verifier wants
// --------------------------------------------------------------------------- //

/**
 * Directional derivatives of `expr` at `point` along `direction`, to `order`.
 *
 * Returns `[f, D_v f, D_v² f, …]` — actual derivatives, with the `1/m!` of the Taylor coefficients
 * multiplied back out, since that is the form a comparison against symbolic partials needs.
 */
export function directionalDerivatives(
  expr: Expr,
  names: readonly string[],
  point: ArrayLike<number>,
  direction: ArrayLike<number>,
  order: number,
): Float64Array {
  const vars = new Map<string, Series>();
  for (const [i, name] of names.entries()) {
    vars.set(name, variableSeries(point[i] ?? 0, direction[i] ?? 0, order));
  }
  const series = taylorEval(expr, vars, order);

  const out = new Float64Array(order + 1);
  let factorial = 1;
  for (let m = 0; m <= order; m++) {
    if (m > 0) factorial *= m;
    out[m] = series[m]! * factorial;
  }
  return out;
}

/**
 * A single pure partial `∂ⁿf/∂xᵢⁿ`, by pointing the direction along one axis.
 *
 * Mixed partials need polarization, which this deliberately does not attempt — see the note at the
 * top of the file.
 */
export function pureDerivative(
  expr: Expr,
  names: readonly string[],
  point: ArrayLike<number>,
  index: number,
  order: number,
): number {
  const direction = new Float64Array(names.length);
  direction[index] = 1;
  return directionalDerivatives(expr, names, point, direction, order)[order]!;
}
