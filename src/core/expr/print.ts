import { type Expr, type MulExpr } from "./ast.ts";
import { lookupFn } from "./fns.ts";

/**
 * Plain-text printer.
 *
 * Two jobs, hence the `power` option:
 *
 *  - `"^"` (default) emits text this project's own parser accepts, so output can be fed
 *    straight back in. Interning turns the round-trip check into reference equality.
 *  - `"**"` emits a strict subset of Python expression syntax that `sympy.parse_expr`
 *    accepts. Guaranteeing that subset is nearly free and it removes any need for a
 *    serialization format in the sympy oracle.
 *
 * The AST has no subtraction or division nodes, so this printer reconstructs `a − b`
 * and `a / b` from the normalized forms. Without that, output would be a wall of
 * `x^(-1)` and `(-1)*y` that neither a human nor sympy would want to read.
 *
 * ## What round-tripping actually guarantees
 *
 * A product's numeric coefficient is always written first: both `a * 2` and `2 * a` print
 * as `2 * a`. Since the constructors preserve input order — deliberately, so the typeset
 * echo mirrors what the user typed — those two are *different* interned nodes, and
 * `parse(toSource(e)) === e` therefore does **not** hold in general.
 *
 * The two guarantees that do hold, both fuzz-tested:
 *
 *     parse(toSource(e)) === e                     for canonical e (that is, e = simplify(…))
 *     simplify(parse(toSource(e))) === simplify(e)  for any e
 *
 * Meaning is preserved unconditionally; structure only once canonicalized.
 */

export interface PrintOptions {
  /** `"^"` for this parser, `"**"` for Python/sympy */
  readonly power?: "^" | "**";
}

const P_ADD = 1;
const P_MUL = 2;
const P_POW = 3;
const P_ATOM = 4;

function wrap(text: string, inner: number, outer: number): string {
  return inner < outer ? `(${text})` : text;
}

function formatNumber(v: number): string {
  if (Number.isNaN(v)) return "nan";
  if (v === Infinity) return "inf";
  if (v === -Infinity) return "-inf";
  // String() gives the shortest representation that round-trips exactly.
  return String(v);
}

/** Split a product into its numeric coefficient and its remaining factors. */
function splitCoefficient(e: MulExpr): { coeff: number; rest: readonly Expr[] } {
  const rest: Expr[] = [];
  let coeff = 1;
  for (const f of e.factors) {
    if (f.kind === "num") coeff *= f.value;
    else rest.push(f);
  }
  return { coeff, rest };
}

/**
 * A factor's contribution to a denominator: `pow(b, −n)` belongs underneath as
 * `pow(b, n)`. Returns null when the factor stays in the numerator.
 */
function asDenominator(f: Expr): { base: Expr; exponent: number } | null {
  if (f.kind !== "pow" || f.exp.kind !== "num" || f.exp.value >= 0) return null;
  return { base: f.base, exponent: -f.exp.value };
}

/** A signed rendering: the magnitude, plus whether a leading `−` belongs in front. */
interface Signed {
  readonly negative: boolean;
  /** the magnitude, with no leading sign */
  readonly text: string;
}

export function toSource(e: Expr, options: PrintOptions = {}): string {
  const powerOp = options.power ?? "^";

  /**
   * Render a term with its sign factored out, so the `add` case can turn a negative
   * term into a subtraction without rebuilding the node.
   */
  const signed = (node: Expr): Signed => {
    if (node.kind === "num") {
      return { negative: node.value < 0, text: formatNumber(Math.abs(node.value)) };
    }
    if (node.kind === "mul") return product(node);
    return { negative: false, text: emit(node, P_ADD) };
  };

  const product = (node: MulExpr): Signed => {
    const { coeff, rest } = splitCoefficient(node);

    const numerator: string[] = [];
    const denominator: string[] = [];

    for (const f of rest) {
      const den = asDenominator(f);
      if (den) {
        denominator.push(
          den.exponent === 1
            ? emit(den.base, P_POW + 1)
            : `${emit(den.base, P_POW + 1)}${powerOp}${formatNumber(den.exponent)}`,
        );
      } else {
        numerator.push(emit(f, P_MUL));
      }
    }

    const magnitude = Math.abs(coeff);
    if (magnitude !== 1 || numerator.length === 0) {
      numerator.unshift(formatNumber(magnitude));
    }

    const top = numerator.length === 0 ? "1" : numerator.join(" * ");
    if (denominator.length === 0) return { negative: coeff < 0, text: top };

    /**
     * Each denominator factor gets its own `/`, rather than being gathered into
     * `x / (a * b)`.
     *
     * Both spellings mean the same thing, but the gathered form reparses as a single
     * inverted *product* — `mul(x, (ab)⁻¹)` instead of `mul(x, a⁻¹, b⁻¹)` — and `simplify`
     * cannot reunify those, because distributing a power over a product is exactly the kind
     * of rewrite it deliberately does not do. Emitting `x / a / b` keeps the printed text
     * structurally close to the tree it came from, which matters both for round-tripping and
     * for the sympy oracle, since it leans less on sympy's own simplifier.
     */
    return {
      negative: coeff < 0,
      text: top + denominator.map((factor) => ` / ${factor}`).join(""),
    };
  };

  const emit = (node: Expr, outer: number): string => {
    switch (node.kind) {
      case "num": {
        const text = formatNumber(node.value);
        // A negative literal reads as a sum-level construct, so it needs bracketing
        // anywhere tighter than a sum: `x^(-2)`, not `x^-2`.
        return node.value < 0 ? wrap(text, P_ADD, outer) : wrap(text, P_ATOM, outer);
      }

      case "var":
        return node.name;

      case "add": {
        let out = "";
        node.terms.forEach((term, index) => {
          const { negative, text } = signed(term);
          if (index === 0) {
            out += negative ? `-${text}` : text;
          } else {
            out += negative ? ` - ${text}` : ` + ${text}`;
          }
        });
        return wrap(out, P_ADD, outer);
      }

      case "mul": {
        const { negative, text } = product(node);
        // A leading minus binds as loosely as a sum for bracketing purposes.
        return negative ? wrap(`-${text}`, P_ADD, outer) : wrap(text, P_MUL, outer);
      }

      case "pow": {
        const den = asDenominator(node);
        if (den) {
          const body =
            den.exponent === 1
              ? `1 / ${emit(den.base, P_POW + 1)}`
              : `1 / ${emit(den.base, P_POW + 1)}${powerOp}${formatNumber(den.exponent)}`;
          return wrap(body, P_MUL, outer);
        }
        // `^` is right-associative: the base needs bracketing, the exponent does not.
        return wrap(
          `${emit(node.base, P_POW + 1)}${powerOp}${emit(node.exp, P_POW)}`,
          P_POW,
          outer,
        );
      }

      case "call": {
        const def = lookupFn(node.fn);
        const name = def?.name ?? node.fn;
        return `${name}(${node.args.map((a) => emit(a, 0)).join(", ")})`;
      }
    }
  };

  return emit(e, 0);
}

/** The Python/sympy-compatible spelling, for the offline oracle. */
export function toPython(e: Expr): string {
  return toSource(e, { power: "**" });
}
