import { describe, expect, it } from "vitest";
import katex from "katex";
import { parse } from "../../src/core/expr/parse.ts";
import { toLatex } from "../../src/core/expr/latex.ts";

function tex(input: string): string {
  const { expr, diags } = parse(input);
  expect(diags.filter((d) => d.severity === "error")).toEqual([]);
  expect(expr).not.toBeNull();
  return toLatex(expr!);
}

describe("toLatex", () => {
  it("uses juxtaposition rather than \\cdot for products", () => {
    expect(tex("2u")).toBe("2 u");
    expect(tex("R cos v")).toBe("R \\cos v");
  });

  it("reconstructs fractions from the normalized inverse-power form", () => {
    expect(tex("1/u")).toBe("\\frac{1}{u}");
    expect(tex("u/2")).toBe("\\frac{u}{2}");
    expect(tex("u/v")).toBe("\\frac{u}{v}");
    expect(tex("1/u^3")).toBe("\\frac{1}{u^{3}}");
  });

  it("reconstructs subtraction from the normalized negated-term form", () => {
    expect(tex("u - v")).toBe("u - v");
    expect(tex("-u")).toBe("-u");
    expect(tex("u^3 - 3u v^2")).toBe("u^{3} - 3 u v^{2}");
  });

  it("writes trig powers the way they are written on paper", () => {
    expect(tex("sin^2 u")).toBe("\\sin^{2} u");
    expect(tex("cos^2 u + sin^2 u")).toBe("\\cos^{2} u + \\sin^{2} u");
  });

  it("recovers pi from the f64 literal", () => {
    // `pi` is stored as a number, so without recovery the echo would read
    // 3.141592653589793 and be unusable.
    expect(tex("pi")).toBe("\\pi");
    expect(tex("2pi")).toBe("2\\pi");
    expect(tex("pi/2")).toBe("\\frac{\\pi}{2}");
  });

  it("recovers exact rationals", () => {
    expect(tex("1/3")).toBe("\\frac{1}{3}");
    expect(tex("u/3")).toBe("\\frac{u}{3}");
    expect(tex("2u/3")).toBe("\\frac{2 u}{3}");
  });

  it("renders roots", () => {
    expect(tex("sqrt(1 - u^2)")).toBe("\\sqrt{1 - u^{2}}");
    expect(tex("cbrt u")).toBe("\\sqrt[3]{u}");
  });

  it("renders greek and subscripts", () => {
    expect(tex("theta")).toBe("\\theta");
    expect(tex("k_1 k_2")).toBe("k_{1} k_{2}");
    expect(tex("θ")).toBe("\\theta");
  });

  it("uses e^{} for exp", () => {
    expect(tex("exp(-u^2)")).toBe("e^{-u^{2}}");
  });

  it("parenthesizes only where precedence requires it", () => {
    expect(tex("(2 + cos u) cos v")).toBe("\\left(2 + \\cos u\\right) \\cos v");
    expect(tex("sin(u + v)")).toBe("\\sin\\left(u + v\\right)");
    expect(tex("sin u")).toBe("\\sin u");
  });
});

describe("KaTeX accepts every rendering", () => {
  // The strongest cheap check on the printer: KaTeX in strict mode is a complete
  // grammar validator, so this catches any malformed output without needing a golden
  // snapshot per case.
  const corpus = [
    "2u",
    "u + v",
    "u - v",
    "-u",
    "u * v / w",
    "u^2",
    "u^-2",
    "1/u",
    "1/2u",
    "(2 + cos u) cos v",
    "(2 + cos u) sin v",
    "sin u",
    "cos u cos v",
    "sin^2 u",
    "sqrt(1 - u^2)",
    "sech u cos v",
    "u - tanh u",
    "atan2(v, u)",
    "exp(-u^2)",
    "log(u^2 + v^2)",
    "log10(u)",
    "cbrt(u)",
    "abs(u)",
    "sign(u)",
    "u^3 - 3u v^2",
    "c cosh(v/c) cos u",
    "u - u^3/3 + u v^2",
    "theta + phi",
    "k_1 k_2",
    "pi/4",
    "1/tan(u)",
    "asin u + acos v + atan w",
    "asinh u + acosh v + atanh w",
    "cot u + sec v + csc w",
    "coth u + sech v + csch w",
    "a_{max} u",
  ];

  it("renders without throwing", () => {
    for (const input of corpus) {
      const latex = toLatex(parse(input).expr!);
      expect(
        () => katex.renderToString(latex, { throwOnError: true, output: "html" }),
        `KaTeX rejected ${JSON.stringify(input)} → ${latex}`,
      ).not.toThrow();
    }
  });
});
