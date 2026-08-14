import { type Expr, type MulExpr } from "./ast.ts";
import { lookupFn } from "./fns.ts";
import { GREEK_WORDS } from "./lex.ts";

/**
 * LaTeX printer, for KaTeX.
 *
 * This is the live echo under the input box, and per the plan it is the single
 * affordance that makes a plain-text formula field tolerable: it is what shows the user
 * that `1/2u` was read as one denominator, or that `cos u cos v` became a product. So
 * it optimizes for *readability of the parse*, not for compactness.
 *
 * Four things it does that a naive printer would not:
 *
 *  - reconstructs `\frac{}{}` from the normalized `a · b⁻¹`, and subtraction from
 *    `a + (−1)·b`, since the AST has neither node kind;
 *  - renders `\sin^{2} u` for `(sin u)²`, the way it is written on paper;
 *  - recovers exact rationals and multiples of π from f64 literals, so `pi` echoes as
 *    `π` rather than `3.141592653589793` — the AST stores it as a number, and without
 *    this the echo would be unreadable;
 *  - omits `\cdot` for implicit products, so `2\cos v` looks like the input.
 */

const P_ADD = 1;
const P_MUL = 2;
const P_POW = 3;
const P_ATOM = 4;

function wrap(text: string, inner: number, outer: number): string {
  return inner < outer ? `\\left(${text}\\right)` : text;
}

const GREEK_SET = new Set<string>(GREEK_WORDS);

/** Single-codepoint Greek → the LaTeX command, for pasted formulas. */
const GREEK_CHAR_COMMANDS: ReadonlyMap<string, string> = new Map([
  ["α", "\\alpha"], ["β", "\\beta"], ["γ", "\\gamma"], ["δ", "\\delta"],
  ["ε", "\\varepsilon"], ["ζ", "\\zeta"], ["η", "\\eta"], ["θ", "\\theta"],
  ["ι", "\\iota"], ["κ", "\\kappa"], ["λ", "\\lambda"], ["μ", "\\mu"],
  ["ν", "\\nu"], ["ξ", "\\xi"], ["ο", "o"], ["ρ", "\\rho"],
  ["σ", "\\sigma"], ["τ", "\\tau"], ["υ", "\\upsilon"], ["φ", "\\varphi"],
  ["χ", "\\chi"], ["ψ", "\\psi"], ["ω", "\\omega"],
  ["Γ", "\\Gamma"], ["Δ", "\\Delta"], ["Θ", "\\Theta"], ["Λ", "\\Lambda"],
  ["Ξ", "\\Xi"], ["Π", "\\Pi"], ["Σ", "\\Sigma"], ["Φ", "\\Phi"],
  ["Ψ", "\\Psi"], ["Ω", "\\Omega"],
]);

/**
 * Recover `p/q` from a float, or null. Bounded search over denominators — a plain loop
 * beats continued fractions here because the bound is small and the intent is only to
 * catch the handful of ratios that actually show up in geometry.
 */
function asRational(v: number, maxDenominator = 64): [number, number] | null {
  if (!Number.isFinite(v)) return null;
  for (let q = 1; q <= maxDenominator; q++) {
    const p = v * q;
    const rounded = Math.round(p);
    if (Math.abs(p - rounded) < 1e-12 * Math.max(1, Math.abs(p))) {
      return [rounded, q];
    }
  }
  return null;
}

/** Render a variable name, mapping Greek and splitting a subscript. */
function variableLatex(name: string): string {
  const underscore = name.indexOf("_");
  if (underscore > 0) {
    const base = variableLatex(name.slice(0, underscore));
    let sub = name.slice(underscore + 1);
    if (sub.startsWith("{") && sub.endsWith("}")) sub = sub.slice(1, -1);
    return `${base}_{${sub}}`;
  }
  if (GREEK_SET.has(name)) return `\\${name}`;
  const command = GREEK_CHAR_COMMANDS.get(name);
  if (command) return command;
  if (name.length === 1) return name;
  return `\\mathrm{${name}}`;
}

function numberLatex(v: number): string {
  if (Number.isNaN(v)) return "\\mathrm{NaN}";
  if (v === Infinity) return "\\infty";
  if (v === -Infinity) return "-\\infty";
  if (Number.isInteger(v)) return String(v);

  // Multiples of π before plain rationals, so π/2 does not come out as 1.5707963.
  const overPi = asRational(v / Math.PI, 24);
  if (overPi) {
    const [p, q] = overPi;
    if (p !== 0) {
      const sign = p < 0 ? "-" : "";
      const magnitude = Math.abs(p);
      const numerator = magnitude === 1 ? "\\pi" : `${magnitude}\\pi`;
      return q === 1 ? `${sign}${numerator}` : `${sign}\\frac{${numerator}}{${q}}`;
    }
  }

  const rational = asRational(v);
  if (rational) {
    const [p, q] = rational;
    if (q !== 1) {
      const sign = p < 0 ? "-" : "";
      return `${sign}\\frac{${Math.abs(p)}}{${q}}`;
    }
  }

  return String(v);
}

function splitCoefficient(e: MulExpr): { coeff: number; rest: readonly Expr[] } {
  const rest: Expr[] = [];
  let coeff = 1;
  for (const f of e.factors) {
    if (f.kind === "num") coeff *= f.value;
    else rest.push(f);
  }
  return { coeff, rest };
}

function asDenominator(f: Expr): { base: Expr; exponent: number } | null {
  if (f.kind !== "pow" || f.exp.kind !== "num" || f.exp.value >= 0) return null;
  return { base: f.base, exponent: -f.exp.value };
}

interface Signed {
  readonly negative: boolean;
  readonly text: string;
}

export interface LatexOptions {
  /**
   * Override how a variable is typeset, by name.
   *
   * Exists so a caller can annotate a symbol — showing a parameter's current value beneath it —
   * without replacing the symbol in the tree. Substituting the number instead would be simpler
   * and would destroy the structure that makes a parametrization readable as a map, which is the
   * whole reason to print it symbolically.
   */
  readonly variable?: (name: string) => string | undefined;
}

export function toLatex(e: Expr, options: LatexOptions = {}): string {
  const signed = (node: Expr): Signed => {
    if (node.kind === "num") {
      return { negative: node.value < 0, text: numberLatex(Math.abs(node.value)) };
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
            ? emit(den.base, P_MUL)
            : `${emit(den.base, P_POW + 1)}^{${numberLatex(den.exponent)}}`,
        );
      } else {
        numerator.push(emit(f, P_MUL));
      }
    }

    const magnitude = Math.abs(coeff);
    const rationalCoefficient = magnitude !== 1 ? asRational(magnitude) : null;

    // A rational coefficient reads far better folded into the fraction: ⅓·u becomes
    // u/3 rather than \frac{1}{3}u.
    if (rationalCoefficient && rationalCoefficient[1] !== 1) {
      const [p, q] = rationalCoefficient;
      if (p !== 1) numerator.unshift(String(p));
      denominator.push(String(q));
    } else if (magnitude !== 1 || numerator.length === 0) {
      numerator.unshift(numberLatex(magnitude));
    }

    // No \cdot: implicit juxtaposition is how the input was written.
    const top = numerator.length === 0 ? "1" : numerator.join(" ");
    if (denominator.length === 0) return { negative: coeff < 0, text: top };
    return {
      negative: coeff < 0,
      text: `\\frac{${top}}{${denominator.join(" ")}}`,
    };
  };

  /** `(sin u)^n` → `\sin^{n} u`, the standard notation. */
  const trigPower = (node: Expr): string | null => {
    if (node.kind !== "pow") return null;
    if (node.base.kind !== "call") return null;
    if (node.exp.kind !== "num") return null;
    if (!Number.isInteger(node.exp.value) || node.exp.value <= 0) return null;
    const def = lookupFn(node.base.fn);
    // Only for functions whose LaTeX is a plain command; `\sqrt{}^2` and `e^{u}^2`
    // would both be wrong.
    if (!def || typeof def.latex !== "string" || node.base.args.length !== 1) return null;
    return applyTo(`${def.latex}^{${node.exp.value}}`, node.base.args[0]!);
  };

  /**
   * Attach an argument to a function head. A bare atom needs the separating space
   * (`\sin u`, never `\sinu`); a `\left(` group must not have one.
   */
  const applyTo = (head: string, argument: Expr): string => {
    if (argument.kind === "num" || argument.kind === "var") {
      return `${head} ${emit(argument, P_ATOM)}`;
    }
    return `${head}\\left(${emit(argument, 0)}\\right)`;
  };

  const emit = (node: Expr, outer: number): string => {
    switch (node.kind) {
      case "num": {
        const text = numberLatex(node.value);
        return node.value < 0 ? wrap(text, P_ADD, outer) : wrap(text, P_ATOM, outer);
      }

      case "var":
        return options.variable?.(node.name) ?? variableLatex(node.name);

      case "add": {
        let out = "";
        node.terms.forEach((term, index) => {
          const { negative, text } = signed(term);
          if (index === 0) out += negative ? `-${text}` : text;
          else out += negative ? ` - ${text}` : ` + ${text}`;
        });
        return wrap(out, P_ADD, outer);
      }

      case "mul": {
        const { negative, text } = product(node);
        return negative ? wrap(`-${text}`, P_ADD, outer) : wrap(text, P_MUL, outer);
      }

      case "pow": {
        const trig = trigPower(node);
        if (trig) return wrap(trig, P_MUL, outer);

        const den = asDenominator(node);
        if (den) {
          const bottom =
            den.exponent === 1
              ? emit(den.base, P_MUL)
              : `${emit(den.base, P_POW + 1)}^{${numberLatex(den.exponent)}}`;
          return wrap(`\\frac{1}{${bottom}}`, P_MUL, outer);
        }

        // A half-integer exponent is a root, and reads much better as one.
        if (node.exp.kind === "num" && node.exp.value === 0.5) {
          return `\\sqrt{${emit(node.base, 0)}}`;
        }

        return wrap(
          `${emit(node.base, P_POW + 1)}^{${emit(node.exp, 0)}}`,
          P_POW,
          outer,
        );
      }

      case "call": {
        const def = lookupFn(node.fn);
        const args = node.args.map((a) => emit(a, 0));
        if (!def) return `\\mathrm{${node.fn}}\\left(${args.join(", ")}\\right)`;
        if (typeof def.latex === "function") return def.latex(args);
        return wrap(applyTo(def.latex, node.args[0]!), P_MUL, outer);
      }
    }
  };

  return emit(e, 0);
}
