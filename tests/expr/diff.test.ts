import { describe, expect, it } from "vitest";
import { nodeCount } from "../../src/core/expr/ast.ts";
import { diff, diffMulti } from "../../src/core/expr/diff.ts";
import { compileScalar, compileMany } from "../../src/core/expr/eval.ts";
import { parse } from "../../src/core/expr/parse.ts";
import { simplify } from "../../src/core/expr/simplify.ts";
import { FN_DEFS } from "../../src/core/expr/fns.ts";

const closeRel = (a: number, b: number, rel = 1e-9) =>
  expect(Math.abs(a - b)).toBeLessThan(rel * Math.max(1, Math.abs(a), Math.abs(b)));

/** Compile `expr` as a function of the single variable `name`. */
function fnOf(source: string, name = "x"): (x: number) => number {
  const { expr, diags } = parse(source);
  expect(diags.filter((d) => d.severity === "error")).toEqual([]);
  const compiled = compileScalar(expr!, { vars: [name] });
  return (x: number) => compiled.call([x]);
}

/** Compile ∂ⁿ(source)/∂nameⁿ. */
function derivativeOf(source: string, order = 1, name = "x"): (x: number) => number {
  const { expr } = parse(source);
  const d = simplify(diffMulti(expr!, new Array(order).fill(name)));
  const compiled = compileScalar(d, { vars: [name] });
  return (x: number) => compiled.call([x]);
}

// --------------------------------------------------------------------------- //
// Richardson-extrapolated central differences.
//
// Used only to validate the *structural* rules (product, chain, power). Tolerances are
// stated honestly per order — differencing loses roughly two decimal digits per
// derivative, which is exactly why finite differences are not the primary oracle for
// the derivative table itself. That table is checked against independently written
// closed forms below, and will be checked symbolically by the sympy oracle.
// --------------------------------------------------------------------------- //

function centralFirst(f: (x: number) => number, x: number, h: number): number {
  return (f(x + h) - f(x - h)) / (2 * h);
}

function centralSecond(f: (x: number) => number, x: number, h: number): number {
  return (f(x + h) - 2 * f(x) + f(x - h)) / (h * h);
}

function centralThird(f: (x: number) => number, x: number, h: number): number {
  return (f(x + 2 * h) - 2 * f(x + h) + 2 * f(x - h) - f(x - 2 * h)) / (2 * h * h * h);
}

/** One Richardson step, cancelling the leading O(h²) error term. */
function richardson(
  stencil: (f: (x: number) => number, x: number, h: number) => number,
  f: (x: number) => number,
  x: number,
  h: number,
): number {
  const coarse = stencil(f, x, h);
  const fine = stencil(f, x, h / 2);
  return (4 * fine - coarse) / 3;
}

describe("the derivative table", () => {
  /**
   * Each built-in's derivative, written independently here in plain `Math` calls. This
   * is the check that matters most: it validates every entry in `fns.ts` against a
   * separate transcription of the same fact, catching the copy errors and sign slips
   * that would otherwise silently corrupt every curvature downstream.
   */
  const expected: Record<string, { at: number; d: (x: number) => number }> = {
    sin: { at: 0.7, d: (x) => Math.cos(x) },
    cos: { at: 0.7, d: (x) => -Math.sin(x) },
    tan: { at: 0.7, d: (x) => 1 / Math.cos(x) ** 2 },
    cot: { at: 0.7, d: (x) => -1 / Math.sin(x) ** 2 },
    sec: { at: 0.7, d: (x) => (1 / Math.cos(x)) * Math.tan(x) },
    csc: { at: 0.7, d: (x) => -(1 / Math.sin(x)) * (1 / Math.tan(x)) },
    asin: { at: 0.7, d: (x) => 1 / Math.sqrt(1 - x * x) },
    acos: { at: 0.7, d: (x) => -1 / Math.sqrt(1 - x * x) },
    atan: { at: 0.7, d: (x) => 1 / (1 + x * x) },
    sinh: { at: 0.7, d: (x) => Math.cosh(x) },
    cosh: { at: 0.7, d: (x) => Math.sinh(x) },
    tanh: { at: 0.7, d: (x) => 1 / Math.cosh(x) ** 2 },
    coth: { at: 0.7, d: (x) => -1 / Math.sinh(x) ** 2 },
    sech: { at: 0.7, d: (x) => -(1 / Math.cosh(x)) * Math.tanh(x) },
    csch: { at: 0.7, d: (x) => -(1 / Math.sinh(x)) * (1 / Math.tanh(x)) },
    asinh: { at: 0.7, d: (x) => 1 / Math.sqrt(x * x + 1) },
    acosh: { at: 1.7, d: (x) => 1 / Math.sqrt(x * x - 1) },
    atanh: { at: 0.7, d: (x) => 1 / (1 - x * x) },
    exp: { at: 0.7, d: (x) => Math.exp(x) },
    log: { at: 0.7, d: (x) => 1 / x },
    log10: { at: 0.7, d: (x) => 1 / (x * Math.LN10) },
    log2: { at: 0.7, d: (x) => 1 / (x * Math.LN2) },
    sqrt: { at: 0.7, d: (x) => 1 / (2 * Math.sqrt(x)) },
    cbrt: { at: 0.7, d: (x) => 1 / (3 * Math.cbrt(x) ** 2) },
    abs: { at: 0.7, d: () => 1 },
    sign: { at: 0.7, d: () => 0 },
  };

  it("covers every single-argument function in the table", () => {
    // Guards against adding a function and forgetting to check its derivative. The
    // multi-argument ones (atan2) get their own test below, since a single closed form
    // per function does not fit them.
    const unary = FN_DEFS.filter((d) => d.arity === 1).map((d) => d.name);
    expect(Object.keys(expected).sort()).toEqual(unary.sort());
  });

  for (const [name, { at, d }] of Object.entries(expected)) {
    it(`differentiates ${name} correctly`, () => {
      const symbolic = derivativeOf(`${name}(x)`);
      closeRel(symbolic(at), d(at), 1e-12);
    });
  }

  it("differentiates atan2 in both arguments", () => {
    const y = 0.7;
    const x = 1.3;
    const denom = x * x + y * y;
    const dy = compileScalar(simplify(diff(parse("atan2(y, x)").expr!, "y")), {
      vars: ["y", "x"],
    });
    const dx = compileScalar(simplify(diff(parse("atan2(y, x)").expr!, "x")), {
      vars: ["y", "x"],
    });
    closeRel(dy.call([y, x]), x / denom, 1e-12);
    closeRel(dx.call([y, x]), -y / denom, 1e-12);
  });
});

describe("structural rules", () => {
  const cases = [
    { source: "x^3", at: 1.3 },
    { source: "x^-2", at: 1.3 },
    { source: "3x^2 + 2x + 1", at: 0.8 },
    { source: "sin(x) cos(x)", at: 0.6 },
    { source: "sin(x^2 + 1)", at: 0.9 },
    { source: "exp(-x^2)", at: 0.7 },
    { source: "sqrt(1 + x^2)", at: 1.1 },
    { source: "log(x^2 + 3)", at: 0.9 },
    { source: "x sin(x) / (1 + x^2)", at: 0.8 },
    { source: "tanh(2x)", at: 0.4 },
    { source: "sech(x) cos(x)", at: 0.5 },
    { source: "(1 + x^2)^3", at: 0.7 },
    { source: "x^x", at: 1.4 },
    { source: "2^x", at: 0.9 },
  ];

  for (const { source, at } of cases) {
    it(`matches finite differences for ${source}`, () => {
      const f = fnOf(source);
      closeRel(derivativeOf(source, 1)(at), richardson(centralFirst, f, at, 1e-4), 1e-7);
      closeRel(derivativeOf(source, 2)(at), richardson(centralSecond, f, at, 1e-3), 1e-5);
      closeRel(derivativeOf(source, 3)(at), richardson(centralThird, f, at, 1e-2), 1e-3);
    });
  }

  it("handles a non-constant exponent via the general power rule", () => {
    // (x^x)' = x^x (ln x + 1)
    const at = 1.4;
    closeRel(derivativeOf("x^x")(at), Math.pow(at, at) * (Math.log(at) + 1), 1e-12);
  });

  it("gives zero for a variable it does not contain", () => {
    const d = simplify(diff(parse("sin(u) cos(v)").expr!, "w"));
    expect(d.kind).toBe("num");
    expect((d as { value: number }).value).toBe(0);
  });

  it("commutes mixed partials", () => {
    const e = parse("sin(u v) exp(u^2 + v)").expr!;
    const uv = compileScalar(simplify(diffMulti(e, ["u", "v"])), { vars: ["u", "v"] });
    const vu = compileScalar(simplify(diffMulti(e, ["v", "u"])), { vars: ["u", "v"] });
    closeRel(uv.call([0.6, 0.9]), vu.call([0.6, 0.9]), 1e-12);
  });
});

describe("simplify", () => {
  it("collects like terms", () => {
    expect(simplify(parse("2u + 3u").expr!)).toBe(parse("5u").expr!);
    expect(simplify(parse("u - u").expr!).kind).toBe("num");
  });

  it("collects like bases, cancelling inverse pairs", () => {
    expect(simplify(parse("u u").expr!)).toBe(parse("u^2").expr!);
    expect(simplify(parse("u / u").expr!)).toBe(parse("1").expr!);
    expect(simplify(parse("u^2 u^3").expr!)).toBe(parse("u^5").expr!);
  });

  it("puts sums and products into a canonical order", () => {
    // The property the constructors deliberately do NOT have.
    expect(simplify(parse("u + v").expr!)).toBe(simplify(parse("v + u").expr!));
    expect(simplify(parse("u v").expr!)).toBe(simplify(parse("v u").expr!));
    expect(simplify(parse("1 + u").expr!)).toBe(simplify(parse("u + 1").expr!));
  });

  it("refuses to merge non-integer exponents", () => {
    // x^(1/2) · x^(1/2) is |x|, not x, so merging would be unsound on negative input.
    const merged = simplify(parse("x^0.5 x^0.5").expr!);
    expect(merged).not.toBe(parse("x").expr!);
  });

  it("applies only exact function folds", () => {
    expect(simplify(parse("sin(0)").expr!)).toBe(parse("0").expr!);
    expect(simplify(parse("sqrt(9)").expr!)).toBe(parse("3").expr!);
    expect(simplify(parse("log(1)").expr!)).toBe(parse("0").expr!);
    // sin(1) stays symbolic: folding it would destroy the user's notation in the echo.
    expect(simplify(parse("sin(1)").expr!).kind).toBe("call");
  });

  it("is idempotent", () => {
    const corpus = [
      "2u + 3u",
      "u u v",
      "sin(u)^2 + cos(u)^2",
      "(2 + cos u) cos v",
      "u^3 - 3u v^2",
      "sech u cos v",
      "1/2u",
    ];
    for (const source of corpus) {
      const once = simplify(parse(source).expr!);
      // Interning makes this a reference check.
      expect(simplify(once), `not idempotent for ${source}`).toBe(once);
    }
  });

  it("preserves semantics", () => {
    const corpus = [
      "2u + 3u - u",
      "u u / u",
      "(2 + cos u) cos v",
      "sin(u v) exp(u)",
      "u^2 v^-1",
      "sech u cos v - tanh u",
    ];
    for (const source of corpus) {
      const original = parse(source).expr!;
      const reduced = simplify(original);
      const a = compileScalar(original, { vars: ["u", "v"] });
      const b = compileScalar(reduced, { vars: ["u", "v"] });
      for (const [u, v] of [
        [0.6, 1.1],
        [1.7, 0.3],
        [-0.4, 2.2],
      ]) {
        closeRel(a.call([u!, v!]), b.call([u!, v!]), 1e-12);
      }
    }
  });
});

describe("the two backends agree bit for bit", () => {
  // Both walk the same op list in the same order, so their floating-point association
  // is identical and equality must be exact — not approximate. This exercises the whole
  // lowering, CSE and codegen pipeline in one assertion.
  const corpus = [
    "(2 + cos u) cos v",
    "sin(u v) exp(u^2 + v)",
    "u^3 - 3u v^2",
    "sech u cos v",
    "sqrt(1 + u^2 + v^2)",
    "atan2(v, u)",
    "cot u + sec v + csc u",
    "coth u + sech v + csch u",
    "log10(u^2 + 1) + cbrt(v)",
    "u^v",
  ];

  it("produces identical doubles for values and derivatives", () => {
    for (const source of corpus) {
      const e = parse(source).expr!;
      const outputs = [
        e,
        simplify(diff(e, "u")),
        simplify(diff(e, "v")),
        simplify(diffMulti(e, ["u", "u"])),
        simplify(diffMulti(e, ["u", "v"])),
      ];
      const codegen = compileMany(outputs, { vars: ["u", "v"], backend: "codegen" });
      const interpreted = compileMany(outputs, {
        vars: ["u", "v"],
        backend: "interpreter",
      });

      const a = new Float64Array(outputs.length);
      const b = new Float64Array(outputs.length);
      const noParams = new Float64Array(0);

      for (const [u, v] of [
        [0.6, 1.1],
        [1.7, 0.3],
        [-0.4, 2.2],
        [3.3, -1.9],
      ]) {
        codegen.evaluate([u!, v!], noParams, a);
        interpreted.evaluate([u!, v!], noParams, b);
        for (let i = 0; i < outputs.length; i++) {
          expect(
            Object.is(a[i]!, b[i]!),
            `${source} output ${i} at (${u}, ${v}): ${a[i]} vs ${b[i]}`,
          ).toBe(true);
        }
      }
    }
  });
});

describe("parameters are inputs, not baked constants", () => {
  it("evaluates the same compiled program at different parameter values", () => {
    // This is what makes dragging a slider free: nothing reparses, nothing recompiles.
    const e = parse("(R + a cos u) cos v").expr!;
    const compiled = compileMany([e], { vars: ["u", "v"], params: ["R", "a"] });
    const out = new Float64Array(1);

    compiled.evaluate([0, 0], [2, 0.5], out);
    closeRel(out[0]!, 2.5, 1e-12);
    compiled.evaluate([0, 0], [3, 1], out);
    closeRel(out[0]!, 4, 1e-12);
  });

  it("reports an undefined symbol without throwing", () => {
    const e = parse("q + 1").expr!;
    const compiled = compileMany([e], { vars: ["u"] });
    expect(compiled.diags.map((d) => d.code)).toContain("E_UNDEF_SYMBOL");
    const out = new Float64Array(1);
    compiled.evaluate([1], new Float64Array(0), out);
    expect(Number.isNaN(out[0]!)).toBe(true);
  });
});

describe("derivative size stays bounded", () => {
  it("keeps third derivatives of a real parametrization small", () => {
    // The blowup risk the plan flags. Memoized differentiation plus interning keeps the
    // DAG shared; this is the early-warning metric.
    const torusX = parse("(2 + 0.7 cos u) cos v").expr!;
    const third = simplify(diffMulti(torusX, ["u", "u", "v"]));
    expect(nodeCount(third)).toBeLessThan(40);

    const enneper = parse("u - u^3/3 + u v^2").expr!;
    expect(nodeCount(simplify(diffMulti(enneper, ["u", "u", "u"])))).toBeLessThan(20);
  });

  it("shares subexpressions across a whole jet in one program", () => {
    const e = parse("(2 + 0.7 cos u) cos v").expr!;
    const jet = [
      e,
      simplify(diff(e, "u")),
      simplify(diff(e, "v")),
      simplify(diffMulti(e, ["u", "u"])),
      simplify(diffMulti(e, ["u", "v"])),
      simplify(diffMulti(e, ["v", "v"])),
    ];
    const together = compileMany(jet, { vars: ["u", "v"] });
    const separately = jet.reduce(
      (total, one) => total + compileMany([one], { vars: ["u", "v"] }).program.ops.length,
      0,
    );
    // Six outputs sharing cos u, cos v, sin u, sin v and the ring factor.
    expect(together.program.ops.length).toBeLessThan(separately);
  });
});
