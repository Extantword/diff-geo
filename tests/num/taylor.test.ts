import { describe, expect, it } from "vitest";
import { parse } from "../../src/core/expr/parse.ts";
import { diff } from "../../src/core/expr/diff.ts";
import { simplify } from "../../src/core/expr/simplify.ts";
import { compileScalar } from "../../src/core/expr/eval.ts";
import type { Expr } from "../../src/core/expr/ast.ts";
import {
  constantSeries,
  directionalDerivatives,
  pureDerivative,
  taylorEval,
  variableSeries,
} from "../../src/core/num/taylor.ts";

/**
 * Taylor arithmetic exists to disagree with `expr/diff.ts` if either is wrong, so nothing here may
 * consult the symbolic derivative table. Two halves:
 *
 *  1. series against textbook expansions, which pins the arithmetic itself;
 *  2. a differential test against symbolic derivatives, which is what the module is FOR.
 */

const closeRel = (a: number, b: number, rel = 1e-11) =>
  expect(Math.abs(a - b)).toBeLessThan(rel * Math.max(1, Math.abs(a), Math.abs(b)));

/** Series of a one-variable expression expanded about `at`. */
function seriesOf(source: string, at: number, order: number) {
  const expr = parse(source).expr!;
  return taylorEval(expr, new Map([["x", variableSeries(at, 1, order)]]), order);
}

describe("series arithmetic against textbook expansions", () => {
  it("expands exp about zero as 1/k!", () => {
    const s = seriesOf("exp(x)", 0, 8);
    let factorial = 1;
    for (let k = 0; k <= 8; k++) {
      if (k > 0) factorial *= k;
      closeRel(s[k]!, 1 / factorial, 1e-14);
    }
  });

  it("expands sin and cos about zero with the right zeros and signs", () => {
    const sin = seriesOf("sin(x)", 0, 7);
    const cos = seriesOf("cos(x)", 0, 7);
    expect(sin[0]).toBeCloseTo(0, 15);
    closeRel(sin[1]!, 1, 1e-14);
    expect(sin[2]).toBeCloseTo(0, 15);
    closeRel(sin[3]!, -1 / 6, 1e-14);
    closeRel(sin[5]!, 1 / 120, 1e-14);
    closeRel(cos[0]!, 1, 1e-14);
    closeRel(cos[2]!, -1 / 2, 1e-14);
    closeRel(cos[4]!, 1 / 24, 1e-14);
  });

  it("expands 1/(1-x) as the geometric series", () => {
    // Straight from series division, which is the inverted convolution.
    const s = seriesOf("1/(1-x)", 0, 9);
    for (let k = 0; k <= 9; k++) closeRel(s[k]!, 1, 1e-13);
  });

  it("expands log(1+x) as the alternating harmonic series", () => {
    const s = seriesOf("log(1+x)", 0, 8);
    expect(s[0]).toBeCloseTo(0, 15);
    for (let k = 1; k <= 8; k++) closeRel(s[k]!, (k % 2 === 1 ? 1 : -1) / k, 1e-13);
  });

  it("expands sqrt(1+x) with the binomial coefficients", () => {
    const s = seriesOf("sqrt(1+x)", 0, 5);
    const want = [1, 1 / 2, -1 / 8, 1 / 16, -5 / 128, 7 / 256];
    for (const [k, value] of want.entries()) closeRel(s[k]!, value, 1e-13);
  });

  it("expands tan about zero, where the pattern is not obvious", () => {
    // tan x = x + x³/3 + 2x⁵/15 + 17x⁷/315. Chosen because the recurrence y′ = (1+y²)u′ feeds on
    // its own output to produce these, so a wrong convolution shows up immediately.
    const s = seriesOf("tan(x)", 0, 7);
    closeRel(s[1]!, 1, 1e-13);
    closeRel(s[3]!, 1 / 3, 1e-13);
    closeRel(s[5]!, 2 / 15, 1e-13);
    closeRel(s[7]!, 17 / 315, 1e-12);
  });

  it("handles an integer power at zero, where the general power rule cannot", () => {
    // x² is expanded by repeated multiplication precisely so this works: the ODE form divides by u.
    const s = seriesOf("x^2", 0, 3);
    expect(s[0]).toBe(0);
    expect(s[1]).toBe(0);
    expect(s[2]).toBe(1);
    expect(s[3]).toBe(0);
  });

  it("returns non-finite coefficients rather than throwing, per the core contract", () => {
    const cases: ReadonlyArray<[string, number]> = [
      ["log(x)", 0],
      ["1/x", 0],
      ["sqrt(x-1)", 0],
      ["asin(x)", 2],
    ];
    for (const [source, at] of cases) {
      const s = seriesOf(source, at, 3);
      expect([...s].some((value) => !Number.isFinite(value)), source).toBe(true);
    }
  });

  it("gives abs a value but no derivative at the kink", () => {
    const s = seriesOf("abs(x)", 0, 2);
    expect(s[0]).toBe(0);
    expect(Number.isFinite(s[1]!)).toBe(false);
    // Away from the kink it is just ±x.
    closeRel(seriesOf("abs(x)", -3, 2)[1]!, -1, 1e-14);
  });
});

/**
 * The differential test: symbolic derivatives against Taylor's.
 *
 * `diff` gives each partial as an expression; combining them into a directional derivative
 *
 *     D_v^m f = Σ_{|α| = m} (m!/α!) v^α ∂^α f
 *
 * is linear in the partials, so agreement across several unrelated directions pins every mixed
 * partial individually — while the two sides share no code.
 */
function symbolicDirectional(
  source: string,
  names: readonly string[],
  point: readonly number[],
  direction: readonly number[],
  order: number,
): number {
  // Differentiating once per direction component and summing over every path IS the multinomial
  // expansion above, reached by repeated application of a single derivative.
  let terms: Array<{ expr: Expr; weight: number }> = [
    { expr: parse(source).expr!, weight: 1 },
  ];
  for (let step = 0; step < order; step++) {
    const next: typeof terms = [];
    for (const term of terms) {
      for (const [i, name] of names.entries()) {
        if (direction[i] === 0) continue;
        next.push({
          expr: simplify(diff(term.expr, name)),
          weight: term.weight * direction[i]!,
        });
      }
    }
    terms = next;
  }
  let total = 0;
  for (const term of terms) {
    const { call } = compileScalar(term.expr, { vars: [...names] });
    total += term.weight * call(point);
  }
  return total;
}

describe("symbolic derivatives against Taylor arithmetic", () => {
  const CASES: ReadonlyArray<{ source: string; names: string[]; point: number[] }> = [
    { source: "sin(u) cos(v)", names: ["u", "v"], point: [0.7, -1.3] },
    { source: "exp(u v) + log(2 + u u)", names: ["u", "v"], point: [0.4, 0.9] },
    { source: "u^3 v - 5 u v^2 + v^4", names: ["u", "v"], point: [-1.1, 2.2] },
    { source: "tan(u/3) sec(v/4)", names: ["u", "v"], point: [0.5, 0.6] },
    { source: "sqrt(3 + sin(u) sin(v))", names: ["u", "v"], point: [1.0, -0.5] },
    { source: "atan(u v) + atan2(u, 2 + v)", names: ["u", "v"], point: [0.8, 0.3] },
    { source: "sinh(u) / cosh(v)", names: ["u", "v"], point: [0.6, -0.7] },
    { source: "asin(u/4) + acos(v/5) + atanh(u/6)", names: ["u", "v"], point: [0.9, 1.4] },
    { source: "log10(2 + u) + log2(3 + v) + cbrt(u - 4)", names: ["u", "v"], point: [0.2, 1.1] },
    { source: "(2 + u)^(1.5) + (3 + v)^u", names: ["u", "v"], point: [0.3, 0.4] },
    { source: "cot(1 + u) csch(1 + v) + coth(2 + u) sech(v)", names: ["u", "v"], point: [0.4, 0.5] },
    { source: "asinh(u) + acosh(2 + v) + tanh(u v)", names: ["u", "v"], point: [0.7, 0.8] },
  ];

  const DIRECTIONS: ReadonlyArray<readonly number[]> = [
    [1, 0],
    [0, 1],
    [1, 1],
    [0.6, -1.7],
    [-2.3, 0.4],
  ];

  for (const { source, names, point } of CASES) {
    it(`agrees to third order on ${source}`, () => {
      for (const direction of DIRECTIONS) {
        const taylor = directionalDerivatives(parse(source).expr!, names, point, direction, 3);
        for (let order = 0; order <= 3; order++) {
          const symbolic = symbolicDirectional(source, names, point, direction, order);
          expect(Number.isFinite(symbolic), `${source} order ${order} symbolic`).toBe(true);
          closeRel(taylor[order]!, symbolic, 1e-9);
        }
      }
    });
  }

  it("recovers a pure high-order partial", () => {
    // ∂⁵/∂u⁵ of sin u at 0.3 is cos(0.3) — five orders past where finite differences survive.
    const value = pureDerivative(parse("sin(u)").expr!, ["u", "v"], [0.3, 0], 0, 5);
    closeRel(value, Math.cos(0.3), 1e-11);
  });

  it("would notice a wrong derivative", () => {
    /**
     * A guard on the guard. If the comparison were vacuous — one side derived from the other, or a
     * tolerance swallowing everything — this file would pass while proving nothing. Perturbing one
     * side by one part in ten thousand must break the agreement.
     */
    const taylor = directionalDerivatives(
      parse("sin(u) cos(v)").expr!,
      ["u", "v"],
      [0.7, -1.3],
      [1, 1],
      3,
    );
    const wrong =
      symbolicDirectional("sin(u) cos(v)", ["u", "v"], [0.7, -1.3], [1, 1], 3) * 1.0001;
    expect(Math.abs(taylor[3]! - wrong)).toBeGreaterThan(1e-9);
  });

  it("keeps constants and variables straight", () => {
    expect([...taylorEval(parse("7").expr!, new Map(), 3)]).toEqual([7, 0, 0, 0]);
    expect([...constantSeries(2, 2)]).toEqual([2, 0, 0]);
    // An unknown name is non-finite rather than an exception.
    expect(Number.isFinite(taylorEval(parse("q").expr!, new Map(), 1)[0]!)).toBe(false);
  });
});
