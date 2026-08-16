import { describe, expect, it } from "vitest";
import { Ctx, nodeCount, freeVars, type Expr } from "../../src/core/expr/ast.ts";
import { parse, parseRow, splitHost } from "../../src/core/expr/parse.ts";
import { toSource, toPython } from "../../src/core/expr/print.ts";

/** Parse, asserting success, and return the printed source. */
function src(input: string): string {
  const { expr, diags } = parse(input);
  const errors = diags.filter((d) => d.severity === "error");
  expect(errors, `unexpected errors parsing ${JSON.stringify(input)}`).toEqual([]);
  expect(expr).not.toBeNull();
  return toSource(expr!);
}

function parseOk(input: string): Expr {
  const { expr, diags } = parse(input);
  expect(diags.filter((d) => d.severity === "error")).toEqual([]);
  expect(expr).not.toBeNull();
  return expr!;
}

function codesOf(input: string): string[] {
  return parse(input).diags.map((d) => d.code);
}

describe("precedence", () => {
  it("gives multiplication tighter binding than addition", () => {
    expect(src("1 + 2 * x")).toBe("1 + 2 * x");
    expect(src("(1 + 2) * x")).toBe("3 * x");
  });

  it("makes ^ bind tighter than unary minus", () => {
    // -x^2 is -(x^2), never (-x)^2
    expect(src("-x^2")).toBe("-x^2");
    // (−x)² is *not* folded to x² here: distributing a power over a product is only
    // valid for even integer exponents, so it is a simplify-level rewrite, not
    // something a constructor may do unconditionally.
    expect(src("(-x)^2")).toBe("(-x)^2");
  });

  it("allows a unary minus in an exponent", () => {
    expect(src("2^-x")).toBe("2^(-x)");
  });

  it("makes ^ right-associative", () => {
    // 2^(3^2) = 2^9 = 512, not (2^3)^2 = 64. Both operands are numeric, so the
    // constructors fold it — the value is the assertion.
    expect(src("2^3^2")).toBe("512");
    expect(src("(2^3)^2")).toBe("64");
  });

  it("subtracts left-associatively", () => {
    expect(src("10 - 3 - 2")).toBe("5");
    expect(src("a - b - c")).toBe("a - b - c");
  });
});

describe("implicit multiplication", () => {
  it("handles a coefficient before a variable", () => {
    expect(src("2u")).toBe("2 * u");
  });

  it("handles adjacent variables", () => {
    expect(src("uv")).toBe("u * v");
  });

  it("handles a variable before a function", () => {
    expect(src("R cos v")).toBe("R * cos(v)");
    expect(src("Rcos v")).toBe("R * cos(v)");
  });

  it("handles a group before a function", () => {
    expect(src("(2 + cos u)cos v")).toBe("(2 + cos(u)) * cos(v)");
  });

  it("handles adjacent groups", () => {
    // Term order follows the input — the constructors are order-preserving so that the
    // live typeset echo mirrors what was typed. Canonical ordering is simplify's job.
    expect(src("(u+1)(v+1)")).toBe("(u + 1) * (v + 1)");
  });

  it("binds tighter than division, and says so", () => {
    // 1/2u reads as 1/(2u). This is the convention on paper but it surprises
    // programmers, so it must come with a warning rather than silently.
    expect(src("1/2u")).toBe("1 / (2 * u)");
    expect(codesOf("1/2u")).toContain("W_AMBIGUOUS_IMPLICIT_MUL");
  });

  it("does not warn when the denominator is unambiguous", () => {
    expect(codesOf("1/(2u)")).not.toContain("W_AMBIGUOUS_IMPLICIT_MUL");
    expect(codesOf("1/2*u")).not.toContain("W_AMBIGUOUS_IMPLICIT_MUL");
  });
});

describe("bare function arguments", () => {
  it("stops at the next function name, so cos u cos v is a product", () => {
    // The single most important parse in the project: every surface of revolution
    // looks like this, and the wrong rule silently yields cos(u * cos(v)).
    expect(src("cos u cos v")).toBe("cos(u) * cos(v)");
  });

  it("absorbs a numeric coefficient into the argument", () => {
    expect(src("sin 2u")).toBe("sin(2 * u)");
  });

  it("stops at an operator", () => {
    expect(src("sin u + 1")).toBe("sin(u) + 1");
    expect(src("2 sin u")).toBe("2 * sin(u)");
  });

  it("binds an exponent to the argument", () => {
    expect(src("sin u^2")).toBe("sin(u^2)");
  });

  it("accepts sin^2 u as (sin u)^2", () => {
    expect(src("sin^2 u")).toBe("sin(u)^2");
    expect(parseOk("sin^2 u")).toBe(parseOk("(sin u)^2"));
  });

  it("parses nested applications", () => {
    expect(src("sin cos u")).toBe("sin(cos(u))");
  });
});

describe("names", () => {
  it("lexes spelled-out greek as one variable", () => {
    expect(freeVars(parseOk("theta"))).toEqual(["theta"]);
    expect(freeVars(parseOk("theta + phi"))).toEqual(["phi", "theta"]);
  });

  it("lexes single-codepoint greek", () => {
    expect(freeVars(parseOk("θ + φ"))).toEqual(["θ", "φ"]);
  });

  it("treats subscripted names as single variables", () => {
    // k_1 and k_2 are the principal curvatures, so this is not an optional nicety.
    expect(freeVars(parseOk("k_1 k_2"))).toEqual(["k_1", "k_2"]);
    expect(freeVars(parseOk("a_{max}"))).toEqual(["a_{max}"]);
  });

  it("resolves pi to a number but leaves e as a variable", () => {
    // e, f, g are the coefficients of the second fundamental form in do Carmo, so `e`
    // must stay available as a name.
    expect(src("pi")).toBe(String(Math.PI));
    expect(freeVars(parseOk("e"))).toEqual(["e"]);
  });

  it("reads scientific notation but not a bare trailing e", () => {
    expect(src("1e-3")).toBe("0.001");
    expect(src("2e")).toBe("2 * e");
  });

  it("normalizes pasted unicode operators", () => {
    expect(src("u − v")).toBe("u - v");
    expect(src("u × v")).toBe("u * v");
  });

  it("accepts aliases", () => {
    expect(parseOk("ln u")).toBe(parseOk("log u"));
    expect(parseOk("arcsin u")).toBe(parseOk("asin u"));
  });
});

describe("interning", () => {
  it("returns the identical node for identical structure", () => {
    expect(parseOk("2u")).toBe(parseOk("2u"));
    expect(parseOk("cos(u) * sin(v)")).toBe(parseOk("cos u sin v"));
  });

  it("keeps differently-ordered sums distinct, so the echo can mirror the input", () => {
    // Canonical ordering belongs to simplify, not to the constructors: the live
    // typeset echo must not reorder a formula while the user is still typing it.
    expect(parseOk("u + v")).not.toBe(parseOk("v + u"));
  });

  it("shares subexpressions in the DAG node count", () => {
    // sin(u) appears twice in the text but once in the DAG.
    const shared = parseOk("sin(u) + sin(u) * v");
    expect(nodeCount(shared)).toBeLessThan(nodeCount(parseOk("sin(u) + sin(w) * v")));
  });

  it("isolates separate contexts", () => {
    const a = new Ctx();
    const b = new Ctx();
    expect(parse("2u", { ctx: a }).expr).not.toBe(parse("2u", { ctx: b }).expr);
  });
});

describe("errors", () => {
  it("reports an unclosed parenthesis with a span", () => {
    const { expr, diags } = parse("(u + v");
    expect(expr).toBeNull();
    expect(diags[0]?.code).toBe("E_UNCLOSED");
    expect(diags[0]?.span).toBeDefined();
  });

  it("reports a function used without an argument", () => {
    expect(codesOf("sin")).toContain("E_BAD_ARGUMENT");
  });

  it("reports the wrong number of arguments", () => {
    expect(codesOf("atan2(1)")).toContain("E_ARITY");
    expect(codesOf("sin(1, 2)")).toContain("E_ARITY");
  });

  it("requires parentheses for a multi-argument function", () => {
    expect(codesOf("atan2 u")).toContain("E_ARITY");
  });

  it("rejects a tuple inside an expression", () => {
    expect(codesOf("1 + (2, 3)")).toContain("E_NESTED_TUPLE");
  });

  it("reports trailing input", () => {
    expect(codesOf("u v )")).toContain("E_UNEXPECTED");
  });

  it("reports an empty formula", () => {
    expect(codesOf("   ")).toContain("E_EMPTY");
  });

  it("never throws, whatever it is handed", () => {
    const nasty = ["", "(", ")", "^", "*", "1+", "sin(", "((((", "u_", "a_{", "1e", "///"];
    for (const input of nasty) {
      expect(() => parse(input)).not.toThrow();
    }
  });
});

describe("round-trip", () => {
  const corpus = [
    "2u",
    "u + v",
    "u - v",
    "-u",
    "u * v / w",
    "u^2",
    "u^-2",
    "1 / u",
    "1 / u^3",
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
    "cbrt(u)",
    "abs(u)",
    "u^3 - 3u v^2",
    "c cosh(v / c) cos u",
    "u - u^3/3 + u v^2",
  ];

  it("parses its own output back to the identical node", () => {
    // Interning makes this a reference-equality check rather than a deep compare.
    for (const input of corpus) {
      const first = parseOk(input);
      const printed = toSource(first);
      const again = parseOk(printed);
      expect(again, `round-trip failed for ${JSON.stringify(input)} → ${printed}`).toBe(
        first,
      );
    }
  });

  it("emits python-compatible power syntax for the sympy oracle", () => {
    expect(toPython(parseOk("u^2"))).toBe("u**2");
    expect(toPython(parseOk("2^3^2"))).toBe("512");
    expect(toPython(parseOk("sqrt(u) ^ 3"))).toBe("sqrt(u)**3");
  });
});

describe("rows", () => {
  it("parses a parametric surface declaration", () => {
    const { row, diags } = parseRow("X(u,v) = ((2 + cos u)cos v, (2 + cos u)sin v, sin u)");
    expect(diags.filter((d) => d.severity === "error")).toEqual([]);
    expect(row?.kind).toBe("vectorFunction");
    if (row?.kind !== "vectorFunction") throw new Error("wrong kind");
    expect(row.name).toBe("X");
    expect(row.args).toEqual(["u", "v"]);
    expect(row.comps).toHaveLength(3);
    expect(toSource(row.comps[2]!)).toBe("sin(u)");
  });

  it("parses a space curve declaration", () => {
    const { row } = parseRow("alpha(t) = (cos t, sin t, t/3)");
    expect(row?.kind).toBe("vectorFunction");
    if (row?.kind !== "vectorFunction") throw new Error("wrong kind");
    expect(row.args).toEqual(["t"]);
    expect(row.comps).toHaveLength(3);
  });

  it("parses a scalar value", () => {
    const { row } = parseRow("a = 2");
    expect(row).toEqual({ kind: "value", name: "a", body: expect.anything() });
  });

  it("parses a graph as a value whose body has free coordinates", () => {
    // Classification into a graph surface happens a layer up; syntactically this is
    // just a value declaration.
    const { row } = parseRow("z = x^2 - y^2");
    expect(row?.kind).toBe("value");
    if (row?.kind !== "value") throw new Error("wrong kind");
    expect(freeVars(row.body)).toEqual(["x", "y"]);
  });

  it("parses a scalar function", () => {
    const { row } = parseRow("f(x,y) = x^2 - y^2");
    expect(row?.kind).toBe("function");
    if (row?.kind !== "function") throw new Error("wrong kind");
    expect(row.args).toEqual(["x", "y"]);
  });

  it("parses an implicit surface as an equation", () => {
    const { row } = parseRow("x^2 + y^2 + z^2 = 1");
    expect(row?.kind).toBe("equation");
  });

  it("parses a bare point", () => {
    const { row } = parseRow("(1, 2, 3)");
    expect(row?.kind).toBe("tuple");
    if (row?.kind !== "tuple") throw new Error("wrong kind");
    expect(row.comps).toHaveLength(3);
  });

  it("refuses to redefine a built-in function", () => {
    const { row, diags } = parseRow("sin = 2");
    expect(row).toBeNull();
    expect(diags.map((d) => d.code)).toContain("E_RESERVED");
  });

  it("never throws on a malformed row", () => {
    for (const input of ["=", "a =", "= 2", "X(=1", "f() = 1", "(1,2"]) {
      expect(() => parseRow(input)).not.toThrow();
    }
  });
});

describe("labelled tuple components", () => {
  /**
   * `X(u,v) = (x = …, y = …, z = …)` names each coordinate. The label restates what the position
   * already says, so it is dropped — which means the labelled and unlabelled forms must parse to
   * exactly the same tree, or the two ways of writing a surface would be different surfaces.
   */
  it("parses to the same tree as the unlabelled form", () => {
    const labelled = parseRow("X(u,v) = (x = cos u, y = sin u, z = v)");
    const plain = parseRow("X(u,v) = (cos u, sin u, v)");
    expect(labelled.row?.kind).toBe("vectorFunction");
    expect(plain.row?.kind).toBe("vectorFunction");
    const a = labelled.row as { comps: readonly unknown[] };
    const b = plain.row as { comps: readonly unknown[] };
    // Interned nodes, so identical structure is identical identity.
    expect(a.comps).toEqual(b.comps);
  });

  it("accepts newlines anywhere, so a formula can be laid out over several lines", () => {
    const multi = parseRow("X(u,v) = (\n  x = cos u,\n  y = sin u,\n  z = v\n)");
    const single = parseRow("X(u,v) = (cos u, sin u, v)");
    expect((multi.row as { comps: readonly unknown[] }).comps).toEqual(
      (single.row as { comps: readonly unknown[] }).comps,
    );
    expect(multi.diags.filter((d) => d.severity === "error")).toEqual([]);
  });

  it("still reads an unlabelled component that begins with a name", () => {
    // `u` alone must not be mistaken for a label waiting for its `=`.
    const row = parseRow("X(u,v) = (u, v, u v)");
    expect(row.row?.kind).toBe("vectorFunction");
    expect((row.row as { comps: readonly unknown[] }).comps).toHaveLength(3);
    expect(row.diags.filter((d) => d.severity === "error")).toEqual([]);
  });
});

describe("a row stated in someone's chart", () => {
  /**
   * `X: (u − a)² + (v − b)² = 1` is a curve in **X's** chart. Nothing in a relation between u and
   * v can say whose u and v those are, so the row says it — in the text, where it is visible,
   * saved and undone along with the formula.
   */
  it("reads the name before the colon and parses the rest as a row", () => {
    const row = parseRow("X: (u - a)^2 + (v - b)^2 = 1");
    expect(row.host).toBe("X");
    expect(row.row?.kind).toBe("equation");
    expect(row.diags.filter((d) => d.severity === "error")).toEqual([]);
  });

  it("takes a subscripted patch name, since that is what new patches are called", () => {
    expect(parseRow("X_2: v = sin u").host).toBe("X_2");
    // `v = sin u` declares v, which is what makes it the chart graph v = f(u) a layer up.
    expect(parseRow("X_2: v = sin u").row?.kind).toBe("value");
  });

  it("leaves an ordinary row alone", () => {
    expect(parseRow("X(u,v) = (u, v, 0)").host).toBeUndefined();
    expect(parseRow("a = 2").host).toBeUndefined();
  });

  it("blanks the prefix instead of removing it, so diagnostics still point at the right place", () => {
    /**
     * Every diagnostic carries character offsets into the text the user typed. Shortening the
     * string would slide every one of them left by the length of the prefix, and the squiggle
     * would land on the character before the mistake.
     */
    const { body } = splitHost("X: 1 + ");
    expect(body).toHaveLength("X: 1 + ".length);
    const prefixed = parseRow("X: 1 + ");
    const plain = parseRow("   1 + ");
    expect(prefixed.diags.map((d) => d.span)).toEqual(plain.diags.map((d) => d.span));
  });

  it("treats a bare prefix as a row still being written", () => {
    // What the "+ relation" button opens: the patch is named, the formula is not there yet.
    const { host, body } = splitHost("X: ");
    expect(host).toBe("X");
    expect(body.trim()).toBe("");
  });
});

describe("the tangent plane at a point of a chart", () => {
  it("reads T_(u, v) X as a point in the chart and the patch it belongs to", () => {
    const { row, host, diags } = parseRow("T_(1, 2) X");
    expect(diags.filter((d) => d.severity === "error")).toEqual([]);
    expect(row?.kind).toBe("tangentPlane");
    if (row?.kind !== "tangentPlane") throw new Error("not a tangent plane");
    expect(toSource(row.at[0])).toBe("1");
    expect(toSource(row.at[1])).toBe("2");
    expect(row.surface).toBe("X");
    // The patch named after the point IS the host, so everything that reads `host` — the chart
    // inset, the copy machinery, the placement — needs no second field to consult.
    expect(host).toBe("X");
  });

  it("takes expressions for the point, so a slider can carry the plane along the surface", () => {
    const { row, diags } = parseRow("T_(a + 1, pi/2) X");
    expect(diags.filter((d) => d.severity === "error")).toEqual([]);
    if (row?.kind !== "tangentPlane") throw new Error("not a tangent plane");
    expect(freeVars(row.at[0])).toEqual(["a"]);
  });

  it("splits at the comma between the coordinates, not one inside a call", () => {
    const { row, diags } = parseRow("T_(atan2(1, 2), 0) X");
    expect(diags.filter((d) => d.severity === "error")).toEqual([]);
    if (row?.kind !== "tangentPlane") throw new Error("not a tangent plane");
    expect(toSource(row.at[0])).toBe("atan2(1, 2)");
    expect(toSource(row.at[1])).toBe("0");
  });

  it("accepts a row that names no patch, which then falls back to the first surface", () => {
    const { row, host } = parseRow("T_(1, 2)");
    if (row?.kind !== "tangentPlane") throw new Error("not a tangent plane");
    expect(row.surface).toBeNull();
    expect(host).toBeUndefined();
  });

  it("reads the prefix form as the same row", () => {
    // `X: T_(1,2)` and `T_(1,2) X` are one row said two ways; both have to end up hosted by X.
    const { row, host } = parseRow("X: T_(1, 2)");
    expect(row?.kind).toBe("tangentPlane");
    expect(host).toBe("X");
  });

  it("says so when the row names two different patches", () => {
    const { host, diags } = parseRow("Y: T_(1, 2) X");
    expect(host).toBe("X");
    expect(diags.some((d) => d.code === "W_TWO_HOSTS")).toBe(true);
  });

  it("keeps the coordinates' offsets, so a diagnostic lands where the mistake is", () => {
    /**
     * The pieces are blanked out of the row rather than cut out of it — the same reason the `X:`
     * prefix is. A squiggle under the second coordinate has to appear under the second
     * coordinate, and its offsets are into the text the user typed.
     */
    const source = "T_(1, 2 @ 3) X";
    const { diags } = parseRow(source);
    const span = diags.find((d) => d.severity === "error")?.span;
    expect(span).toBeDefined();
    expect(source.slice(span![0], span![1])).toBe("@");
  });

  it("asks for two coordinates when it is given some other number", () => {
    for (const source of ["T_(1) X", "T_(1, 2, 3) X"]) {
      const { row, diags } = parseRow(source);
      expect(row).toBeNull();
      expect(diags.some((d) => d.code === "E_ARITY")).toBe(true);
    }
  });

  it("reports an unclosed point rather than handing the row to the lexer", () => {
    /**
     * `T_(` has already committed to the form, so it is answered in its own terms. Left to the
     * ordinary path it would come back as "subscript is empty" pointing at a parenthesis, which
     * is a fact about tokens rather than about the row being written.
     */
    const { row, diags } = parseRow("T_(1, 2 X");
    expect(row).toBeNull();
    expect(diags.some((d) => d.code === "E_UNCLOSED")).toBe(true);
    expect(diags.some((d) => d.message.includes("subscript"))).toBe(false);
  });

  it("rejects anything but a patch name after the point", () => {
    const { row, diags } = parseRow("T_(1, 2) X + Y");
    expect(row).toBeNull();
    expect(diags.some((d) => d.code === "E_UNEXPECTED")).toBe(true);
  });

  it("leaves an ordinary subscripted name alone", () => {
    // `T_1` is a variable, and `T_1 u` is a product. Only `T_(` starts a tangent plane.
    expect(parseRow("T_1 u").row?.kind).toBe("expr");
  });
});

describe("a vector field along a patch", () => {
  it("reads VectorField(a, b, c) as three ambient components on a named patch", () => {
    const { row, host, diags } = parseRow("X: VectorField(-sin v, cos v, 0)");
    expect(diags.filter((d) => d.severity === "error")).toEqual([]);
    expect(row?.kind).toBe("surfaceField");
    if (row?.kind !== "surfaceField") throw new Error("not a field");
    expect(row.comps.map((c) => toSource(c))).toEqual(["-sin(v)", "cos(v)", "0"]);
    expect(host).toBe("X");
  });

  it("takes the trailing-name spelling too, like a tangent plane", () => {
    const { row, host } = parseRow("VectorField(0, 0, 1) X");
    expect(row?.kind).toBe("surfaceField");
    if (row?.kind !== "surfaceField") throw new Error("not a field");
    expect(row.surface).toBe("X");
    expect(host).toBe("X");
  });

  it("would otherwise lex as a product of single letters against a tuple", () => {
    /**
     * The reason this is a row form rather than a call: `VectorField` is not a known name, so the
     * lexer takes it one character at a time and `(a, b, c)` becomes a tuple inside an
     * expression — a nested-tuple error about tokens, for a row whose form is the thing being
     * written.
     */
    const { row, diags } = parseRow("W = VectorField(0, 0, 1)");
    expect(row).toBeNull();
    expect(diags.some((d) => d.code === "E_NESTED_TUPLE")).toBe(true);
  });

  it("asks for three components when given some other number", () => {
    const { row, diags } = parseRow("X: VectorField(1, 0)");
    expect(row).toBeNull();
    expect(diags.some((d) => d.code === "E_ARITY")).toBe(true);
    expect(diags[0]!.message).toContain("three components");
  });

  it("reports an unclosed field rather than handing the row to the lexer", () => {
    const { row, diags } = parseRow("X: VectorField(1, 0, 0");
    expect(row).toBeNull();
    expect(diags.some((d) => d.code === "E_UNCLOSED")).toBe(true);
  });

  it("keeps each component's offsets, so a diagnostic lands on the right one", () => {
    const source = "X: VectorField(1, 2 @ 3, 0)";
    const span = parseRow(source).diags.find((d) => d.severity === "error")?.span;
    expect(source.slice(span![0], span![1])).toBe("@");
  });
});
