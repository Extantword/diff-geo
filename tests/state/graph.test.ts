import { describe, expect, it } from "vitest";
import { createDocument, topologicalOrder, type ItemKind } from "../../src/state/graph.ts";
import { compileScalar } from "../../src/core/expr/eval.ts";
import { toSource } from "../../src/core/expr/print.ts";

/** Build a document and return its resolution. */
function documentOf(...sources: string[]) {
  const document = createDocument(sources);
  return { document, resolution: document.resolution() };
}

function codesFor(sources: string[], index: number): string[] {
  const { document, resolution } = documentOf(...sources);
  const id = document.rows()[index]!.id;
  return (resolution.diagnostics.get(id) ?? []).map((d) => d.code);
}

function kindsOf(...sources: string[]): Array<ItemKind | undefined> {
  const { document, resolution } = documentOf(...sources);
  return document.rows().map((row) => resolution.items.get(row.id)?.kind);
}

describe("classification", () => {
  it("recognizes the shapes do Carmo actually uses", () => {
    // A row declaring a plain number is a parameter, not a constant to inline.
    expect(kindsOf("a = 2")).toEqual(["parameter"]);
    expect(kindsOf("b = 1 + 2 sin(1)")).toEqual(["scalar"]);
    expect(kindsOf("alpha(t) = (cos t, sin t, t)")).toEqual(["spaceCurve"]);
    expect(kindsOf("c(t) = (cos t, sin t)")).toEqual(["planeCurve"]);
    expect(kindsOf("X(u,v) = (u, v, u v)")).toEqual(["parametricSurface"]);
    expect(kindsOf("z = x^2 - y^2")).toEqual(["graphSurface"]);
    expect(kindsOf("f(x,y) = x^2 - y^2")).toEqual(["graphSurface"]);
    expect(kindsOf("x^2 + y^2 + z^2 = 1")).toEqual(["implicitSurface"]);
    // An equation in the ambient coordinates is a surface in R³ whichever of them it mentions:
    // `x² + y² = 1` is the cylinder, not the circle. The regular value theorem, taken at its word.
    expect(kindsOf("x^2 + y^2 = 1")).toEqual(["implicitSurface"]);
    expect(kindsOf("(1, 2, 3)")).toEqual(["point"]);
    expect(kindsOf("V(x,y,z) = (y, -x, 0)")).toEqual(["vectorField"]);
  });

  it("treats a bare tuple in t or u,v as a curve or surface", () => {
    expect(kindsOf("(cos t, sin t, 0)")).toEqual(["spaceCurve"]);
    expect(kindsOf("(u, v, u^2)")).toEqual(["parametricSurface"]);
  });

  it("reads a function of u or v as a graph in the chart", () => {
    // `f(u) = …` is the graph v = f(u) on the domain. It is ALSO still published as a
    // definition, so `r(u) = 2 + cos u` keeps working as a building block for a surface of
    // revolution while being drawn — which is what Desmos does with `f(x) = …`.
    expect(kindsOf("f(u) = sin u")).toEqual(["chartGraph"]);
    expect(kindsOf("g(v) = v^2")).toEqual(["chartGraph"]);
    // A function of anything else is a plain definition with nothing to draw.
    expect(kindsOf("h(s) = 2 + cos s")).toEqual(["functionDefinition"]);
  });

  it("still inlines a chart graph where another row uses it", () => {
    const { document, resolution } = documentOf(
      "r(u) = 2 + cos u",
      "X(u,v) = (r(u) cos v, r(u) sin v, sin u)",
    );
    expect(resolution.items.get(document.rows()[0]!.id)?.kind).toBe("chartGraph");
    const surface = resolution.items.get(document.rows()[1]!.id)!;
    expect(toSource(surface.comps[0]!)).toBe("(2 + cos(u)) * cos(v)");
  });

  it("treats u and v as coordinates, never as sliders", () => {
    // The reported bug: `v = log(u)` was a scalar with `u` offered as a slider. Offering one
    // for a coordinate is a category error — the whole point of u is that it varies.
    expect(kindsOf("v = log(u)")).toEqual(["chartGraph"]);
    const { resolution } = documentOf("v = log(u)");
    expect(resolution.freeParameters).toEqual([]);
  });

  it("reads u = c and v = c as coordinate curves", () => {
    // Checked before the numeric-parameter rule, or `v = 2` would become a slider called v.
    expect(kindsOf("v = 2")).toEqual(["chartGraph"]);
    expect(kindsOf("u = 3")).toEqual(["chartGraph"]);
    const { document, resolution } = documentOf("u = 3");
    const item = resolution.items.get(document.rows()[0]!.id)!;
    // u = 3 varies with v, so v is its parameter.
    expect(item.vars).toEqual(["v"]);
  });

  it("never offers a slider for any coordinate", () => {
    for (const source of [
      "X(u,v) = (u, v, t)",
      "w = x + y + z",
      "c(s) = (s, u, v)",
    ]) {
      const { resolution } = documentOf(source);
      for (const name of resolution.freeParameters) {
        expect(["u", "v", "x", "y", "z", "t"]).not.toContain(name);
      }
    }
  });

  it("refuses to bind a coordinate that is not u, v or z", () => {
    expect(codesFor(["t = 5"], 0)).toContain("E_RESERVED");
    expect(codesFor(["x = 5"], 0)).toContain("E_RESERVED");
  });

  it("says why a definition depending on a coordinate got no slider", () => {
    const { document, resolution } = documentOf("w = u + 1");
    const messages = (resolution.diagnostics.get(document.rows()[0]!.id) ?? [])
      .map((d) => d.message)
      .join(" ");
    expect(messages).toContain("is a coordinate");
    expect(resolution.freeParameters).toEqual([]);
  });

  it("refuses a coordinate appearing on both sides", () => {
    const { document, resolution } = documentOf("v = v + 1");
    const codes = (resolution.diagnostics.get(document.rows()[0]!.id) ?? []).map((d) => d.code);
    expect(codes.some((c) => c === "E_CLASSIFY" || c === "E_RECURSION")).toBe(true);
  });

  it("reads an equation in u and v as a relation on the chart", () => {
    // u² + v² = 1 is a circle in the DOMAIN, whose image on the surface is generally not a
    // circle at all — which is the thing worth looking at.
    expect(kindsOf("u^2 + v^2 = 1")).toEqual(["chartRelation"]);
    expect(kindsOf("sin u = cos v")).toEqual(["chartRelation"]);
    // Ambient equations are still implicit surfaces in R³.
    expect(kindsOf("x^2 + y^2 + z^2 = 1")).toEqual(["implicitSurface"]);
  });

  it("refuses a single-argument function whose body mentions the other chart variable", () => {
    // `f(u) = v + v` cannot be a graph, and treating v as a slider would be silently wrong.
    const codes = codesFor(["f(u) = v + v"], 0);
    expect(codes).toContain("E_CLASSIFY");
    const { document, resolution } = documentOf("f(u) = v + v");
    const messages = (resolution.diagnostics.get(document.rows()[0]!.id) ?? [])
      .map((d) => d.message)
      .join(" ");
    expect(messages).toContain("write it as an equation");
  });

  it("ignores a declared parameter that never appears", () => {
    // `Y(u,v) = (u, u)` is a function of u alone, so it is a curve. Counting declared
    // parameters instead rejected it as "2 parameters, 2 components", which was the bug.
    expect(kindsOf("Y(u,v) = (u, u)")).toEqual(["planeCurve"]);
    // Applied only as a fallback, so a declared signature that already classifies is left
    // alone: an extruded curve stays the surface it was written as (a degenerate one, which
    // the tessellator then reports honestly), and a vector field independent of z stays a
    // vector field.
    expect(kindsOf("X(u,v) = (cos u, sin u, 0)")).toEqual(["parametricSurface"]);
    expect(kindsOf("V(x,y,z) = (y, -x, 0)")).toEqual(["vectorField"]);
  });

  it("says so when a parameter was dropped", () => {
    const codes = codesFor(["Y(u,v) = (u, u)"], 0);
    expect(codes).not.toContain("E_CLASSIFY");
    const { document, resolution } = documentOf("Y(u,v) = (u, u)");
    const diagnostics = resolution.diagnostics.get(document.rows()[0]!.id) ?? [];
    expect(diagnostics.map((d) => d.message).join(" ")).toContain("does not appear");
  });

  it("marks a curve written in chart variables as belonging to the chart", () => {
    const { document, resolution } = documentOf("Y(u,v) = (u, u)");
    const item = resolution.items.get(document.rows()[0]!.id)!;
    expect(item.chartByDefault).toBe(true);

    // One written in t is an ordinary plane curve.
    const other = documentOf("c(t) = (cos t, sin t)");
    const plane = other.resolution.items.get(other.document.rows()[0]!.id)!;
    expect(plane.chartByDefault).toBe(false);
  });

  it("explains a two-parameter, two-component row instead of just refusing it", () => {
    // A genuine reparametrization of the chart: recognized, named, and not drawn.
    const { document, resolution } = documentOf("Y(u,v) = (v, u)");
    const diagnostics = resolution.diagnostics.get(document.rows()[0]!.id) ?? [];
    expect(diagnostics.map((d) => d.code)).toContain("E_CLASSIFY");
    expect(diagnostics.map((d) => d.message).join(" ")).toContain("reparametrization");
  });

  it("reports a shape it cannot classify", () => {
    // Four parameters and two components parses fine; it just is not any object in the
    // book, so the failure belongs to classification rather than to the parser.
    expect(codesFor(["W(u,v,w,q) = (u, w)"], 0)).toContain("E_CLASSIFY");
    expect(codesFor(["X(u,v) = (1, 2, 3, 4)"], 0)).toContain("E_CLASSIFY");
  });
});

describe("cross-row references", () => {
  it("keeps a declared number symbolic, as a compiled slot", () => {
    // Inlining `a = 2` would rebuild the whole interned tree every time the value moved, and
    // re-differentiate the surface with it. Leaving it symbolic is what makes a slider free.
    const { document, resolution } = documentOf("a = 2", "X(u,v) = (a u, v, 0)");
    const surface = resolution.items.get(document.rows()[1]!.id)!;
    expect(surface.kind).toBe("parametricSurface");
    expect(surface.params).toEqual(["a"]);
    expect(toSource(surface.comps[0]!)).toBe("a * u");
    expect(resolution.declaredParameters.get("a")).toBe(2);
  });

  it("still inlines a scalar that is not a plain number", () => {
    // Only literals become slots; anything computed is substituted, since there is nothing
    // to drag and inlining keeps the expression differentiable.
    const { document, resolution } = documentOf("w = 3 sin(1)", "X(u,v) = (w u, v, 0)");
    const surface = resolution.items.get(document.rows()[1]!.id)!;
    expect(surface.params).toEqual([]);
    expect(toSource(surface.comps[0]!)).toBe("3 * sin(1) * u");
  });

  it("inlines user functions, which is what makes them differentiable at all", () => {
    const { document, resolution } = documentOf(
      "r(u) = 2 + cos u",
      "h(u) = sin u",
      "X(u,v) = (r(u) cos v, r(u) sin v, h(u))",
    );
    const surface = resolution.items.get(document.rows()[2]!.id)!;
    expect(surface.kind).toBe("parametricSurface");
    expect(toSource(surface.comps[0]!)).toBe("(2 + cos(u)) * cos(v)");
    expect(toSource(surface.comps[2]!)).toBe("sin(u)");
  });

  it("shares inlined subexpressions through interning", () => {
    const { document, resolution } = documentOf(
      "r(u) = 2 + cos u",
      "X(u,v) = (r(u) cos v, r(u) sin v, 0)",
    );
    const surface = resolution.items.get(document.rows()[1]!.id)!;
    const first = surface.comps[0]!;
    const second = surface.comps[1]!;
    // Both components multiply the *same* interned node for r(u), so the compiled program
    // evaluates 2 + cos u once.
    if (first.kind !== "mul" || second.kind !== "mul") throw new Error("expected products");
    expect(first.factors[0]).toBe(second.factors[0]);
  });

  it("resolves a chain regardless of row order", () => {
    // c depends on b depends on a, declared backwards. `a` is a slot, so the chain compiles
    // to a function of a rather than to a constant.
    const { document, resolution } = documentOf("c = b + 1", "b = a + 1", "a = 1");
    const c = resolution.items.get(document.rows()[0]!.id)!;
    expect(c.params).toEqual(["a"]);
    const compiled = compileScalar(c.comps[0]!, { vars: [], params: ["a"] });
    expect(compiled.call([], [1])).toBe(3);
    expect(compiled.call([], [10])).toBe(12);
  });

  it("evaluates a surface through its parameter slots", () => {
    const { document, resolution } = documentOf(
      "R = 2",
      "r = 0.5",
      "X(u,v) = ((R + r cos u) cos v, (R + r cos u) sin v, r sin u)",
    );
    const surface = resolution.items.get(document.rows()[2]!.id)!;
    expect(surface.params).toEqual(["R", "r"]);

    const x = compileScalar(surface.comps[0]!, { vars: ["u", "v"], params: ["R", "r"] });
    // At u = v = 0 the x-component is R + r.
    expect(x.call([0, 0], [2, 0.5])).toBeCloseTo(2.5, 12);
    // The same compiled program, different slot values — no recompilation involved.
    expect(x.call([0, 0], [3, 1])).toBeCloseTo(4, 12);
  });
});

describe("cycles are data, not control flow", () => {
  it("diagnoses a two-row cycle without hanging", () => {
    // The property the single-resolution-computed design exists to guarantee: if rows read
    // each other's signals directly, this would be an infinite recomputation instead.
    const { document, resolution } = documentOf("a = b", "b = a");
    for (const row of document.rows()) {
      const codes = (resolution.diagnostics.get(row.id) ?? []).map((d) => d.code);
      expect(codes).toContain("E_CYCLE");
      expect(resolution.items.has(row.id)).toBe(false);
    }
  });

  it("diagnoses a longer cycle", () => {
    const { resolution } = documentOf("a = c", "b = a", "c = b");
    expect(resolution.order).toHaveLength(0);
    for (const diags of resolution.diagnostics.values()) {
      expect(diags.map((d) => d.code)).toContain("E_CYCLE");
    }
  });

  it("keeps unrelated rows working alongside a cycle", () => {
    const { document, resolution } = documentOf("a = b", "b = a", "X(u,v) = (u, v, 0)");
    const surface = resolution.items.get(document.rows()[2]!.id);
    expect(surface?.kind).toBe("parametricSurface");
  });

  it("rejects self-reference as recursion", () => {
    expect(codesFor(["f(u) = f(u) + 1"], 0)).toContain("E_RECURSION");
  });
});

describe("the symbol table", () => {
  it("fails closed on a duplicate name", () => {
    // Resolving to "the first one" would make editing order silently significant.
    const { document, resolution } = documentOf("a = 1", "a = 2", "b = a");
    for (const index of [0, 1]) {
      const id = document.rows()[index]!.id;
      expect((resolution.diagnostics.get(id) ?? []).map((d) => d.code)).toContain(
        "E_DUPLICATE",
      );
    }
    // `a` resolves to neither, so it survives as a free parameter rather than picking one.
    const b = resolution.items.get(document.rows()[2]!.id)!;
    expect(b.params).toEqual(["a"]);
  });

  it("refuses to shadow a built-in", () => {
    expect(codesFor(["sin = 2"], 0)).toContain("E_RESERVED");
  });
});

describe("free parameters become slider candidates", () => {
  it("collects undefined symbols across the document", () => {
    const { resolution } = documentOf("X(u,v) = (a u, b v, 0)");
    expect(resolution.freeParameters).toEqual(["a", "b"]);
  });

  it("includes declared numbers, and records their values", () => {
    // They need sliders too — that is the point of them being slots.
    const { resolution } = documentOf("a = 2", "X(u,v) = (a u, v, 0)");
    expect(resolution.freeParameters).toEqual(["a"]);
    expect(resolution.declaredParameters.get("a")).toBe(2);
  });

  it("does not count bound variables or inlined definitions", () => {
    const { resolution } = documentOf("w = 3 sin(1)", "X(u,v) = (w u, v, 0)");
    expect(resolution.freeParameters).toEqual([]);
  });

  it("offers a hint rather than an error", () => {
    // An undefined single letter is usually a parameter the user wants a slider for.
    const codes = codesFor(["X(u,v) = (a u, v, 0)"], 0);
    expect(codes).toContain("H_ADD_SLIDER");
    expect(codes).not.toContain("E_UNDEF_SYMBOL");
  });
});

describe("reactivity", () => {
  it("re-resolves when a row's text changes", () => {
    const document = createDocument(["a = 1", "b = a + 1"]);
    const bId = document.rows()[1]!.id;
    const b = document.itemFor(bId);

    const evaluate = () =>
      compileScalar(b()!.comps[0]!, { vars: [], params: ["a"] }).call(
        [],
        [document.resolution().declaredParameters.get("a") ?? 0],
      );

    expect(evaluate()).toBe(2);
    document.rows()[0]!.source.set("a = 10");
    expect(evaluate()).toBe(11);
  });

  it("leaves a row's item identical when an unrelated row changes", () => {
    // The granularity that keeps one edit from invalidating the whole document.
    const document = createDocument(["X(u,v) = (u, v, 0)", "unrelated = 1"]);
    const xId = document.rows()[0]!.id;
    const item = document.itemFor(xId);

    const before = item();
    document.rows()[1]!.source.set("unrelated = 2");
    // Same object: `itemsEqual` compared interned components and stopped propagation.
    expect(item()).toBe(before);
  });

  it("tracks rows being added and removed", () => {
    const document = createDocument(["a = 1"]);
    expect(document.resolution().items.size).toBe(1);

    const added = document.addRow("b = a + 1");
    expect(document.resolution().items.size).toBe(2);

    document.removeRow(added.id);
    expect(document.resolution().items.size).toBe(1);
  });

  it("keeps a dependent row resolvable after its dependency is removed", () => {
    const document = createDocument(["a = 1", "b = a + 1"]);
    const aId = document.rows()[0]!.id;
    document.removeRow(aId);
    const b = document.resolution().items.get(document.rows()[0]!.id)!;
    // `a` was already a slot; removing its declaration only drops the recorded value.
    expect(b.params).toEqual(["a"]);
    expect(document.resolution().declaredParameters.has("a")).toBe(false);
  });
});

describe("topologicalOrder", () => {
  it("orders dependencies first", () => {
    const dependencies = new Map([
      [1, new Set([2])],
      [2, new Set([3])],
      [3, new Set<number>()],
    ]);
    const { order, cyclic } = topologicalOrder([1, 2, 3], dependencies);
    expect(order).toEqual([3, 2, 1]);
    expect(cyclic.size).toBe(0);
  });

  it("reports every member of a cycle and still orders the rest", () => {
    const dependencies = new Map([
      [1, new Set([2])],
      [2, new Set([1])],
      [3, new Set<number>()],
    ]);
    const { order, cyclic } = topologicalOrder([1, 2, 3], dependencies);
    expect(order).toEqual([3]);
    expect([...cyclic].sort()).toEqual([1, 2]);
  });

  it("respects every edge it emits", () => {
    const dependencies = new Map([
      [1, new Set([2, 3])],
      [2, new Set([4])],
      [3, new Set([4])],
      [4, new Set<number>()],
    ]);
    const { order } = topologicalOrder([1, 2, 3, 4], dependencies);
    for (const [id, deps] of dependencies) {
      for (const dep of deps) {
        expect(order.indexOf(dep)).toBeLessThan(order.indexOf(id));
      }
    }
  });
});

describe("a tangent plane is a row about someone else's chart", () => {
  it("classifies T_(1, 2) X, and hosts it on the patch it names", () => {
    const { document, resolution } = documentOf("X(u,v) = (u, v, u v)", "T_(1, 2) X");
    const item = resolution.items.get(document.rows()[1]!.id);
    expect(item?.kind).toBe("tangentPlane");
    expect(item?.host).toBe("X");
    // The point is data, not a parametrization: nothing varies over it.
    expect(item?.vars).toEqual([]);
    expect(item?.comps.map((c) => toSource(c))).toEqual(["1", "2"]);
  });

  it("offers a slider for a point written with a free name", () => {
    const { document, resolution } = documentOf("X(u,v) = (u, v, u v)", "T_(a, 0) X");
    expect(resolution.items.get(document.rows()[1]!.id)?.params).toEqual(["a"]);
    expect(resolution.freeParameters).toEqual(["a"]);
  });

  it("depends on the row declaring the parameter that moves it", () => {
    // `a` stays symbolic — it is a declared number, so it compiles to a slot — but the edge has
    // to exist, or a document could resolve the tangent plane before the row it reads.
    const { document, resolution } = documentOf("a = 1", "X(u,v) = (u, v, u v)", "T_(a, 0) X");
    const [declaration, , tangent] = document.rows();
    expect(resolution.order.indexOf(declaration!.id)).toBeLessThan(
      resolution.order.indexOf(tangent!.id),
    );
    expect(resolution.declaredParameters.get("a")).toBe(1);
  });

  it("refuses a point written in the coordinates it is a point of", () => {
    // `T_(u, 0) X` looks reasonable and means nothing: u is what varies over the domain.
    expect(codesFor(["X(u,v) = (u, v, u v)", "T_(u, 0) X"], 1)).toContain("E_CLASSIFY");
    expect(kindsOf("X(u,v) = (u, v, u v)", "T_(u, 0) X")[1]).toBeUndefined();
  });

  it("reads the prefix spelling into the same host", () => {
    const { document, resolution } = documentOf("X(u,v) = (u, v, u v)", "X: T_(1, 2)");
    const item = resolution.items.get(document.rows()[1]!.id);
    expect(item?.kind).toBe("tangentPlane");
    expect(item?.host).toBe("X");
  });
});

describe("a vector field along a patch", () => {
  it("classifies VectorField(a, b, c) as a field over that patch's chart", () => {
    const { document, resolution } = documentOf(
      "X(u,v) = (sin u cos v, sin u sin v, cos u)",
      "X: VectorField(-sin u sin v, sin u cos v, 0)",
    );
    const item = resolution.items.get(document.rows()[1]!.id);
    expect(item?.kind).toBe("surfaceField");
    expect(item?.host).toBe("X");
    // A function of the patch's own coordinates, with three ambient components.
    expect(item?.vars).toEqual(["u", "v"]);
    expect(item?.comps).toHaveLength(3);
  });

  it("offers sliders for the constants in it, and never for u or v", () => {
    const { document, resolution } = documentOf(
      "X(u,v) = (u, v, 0)",
      "X: VectorField(k sin u, 0, 0)",
    );
    expect(resolution.items.get(document.rows()[1]!.id)?.params).toEqual(["k"]);
    expect(resolution.freeParameters).toEqual(["k"]);
  });

  it("takes a constant field, which is a field like any other", () => {
    // `(0, 0, 1)` mentions neither u nor v and is still a field along the patch — tangent to a
    // cylinder everywhere, and to a sphere almost nowhere. Which is measured, not classified.
    const { document, resolution } = documentOf("X(u,v) = (u, v, 0)", "X: VectorField(0, 0, 1)");
    expect(resolution.items.get(document.rows()[1]!.id)?.kind).toBe("surfaceField");
  });
});

describe("ambient spaces, and the scopes they open", () => {
  /**
   * `:` is this language's `.`. `A` is a space, `A:sigma` a chart in it, `A:sigma: u + v = 1` a
   * relation stated in that chart — and a name declared inside a scope belongs to it, so two
   * spaces may each have their own `k` while an undeclared `k` is shared by the whole document.
   */

  it("classifies a space, and gives it nothing to evaluate", () => {
    const { document, resolution } = documentOf("A_1 = AmbientSpace");
    const item = resolution.items.get(document.rows()[0]!.id);
    expect(item?.kind).toBe("ambientSpace");
    expect(item?.name).toBe("A_1");
    expect(item?.comps).toEqual([]);
    expect(item?.params).toEqual([]);
  });

  it("addresses a chart and a relation through the chain", () => {
    const { document, resolution } = documentOf(
      "A = AmbientSpace",
      "A: sigma(u,v) = (u, v, u^2 - v^2)",
      "A:sigma: u + v = 1",
    );
    const rows = document.rows();
    // The chart's identity is its address: A's sigma, not the document's.
    expect(resolution.items.get(rows[1]!.id)?.name).toBe("A:sigma");
    expect(resolution.items.get(rows[1]!.id)?.host).toBe("A");
    const relation = resolution.items.get(rows[2]!.id);
    expect(relation?.kind).toBe("chartRelation");
    expect(relation?.host, "the relation is stated in that chart").toBe("A:sigma");
  });

  it("gives each space its own k, and leaves an undeclared one shared", () => {
    /**
     * The whole point of scoping parameters. `A:k` and `B:k` are two numbers with two sliders;
     * `R`, which nobody declares, is one free name that both spaces see — which is what makes
     * sharing a parameter across spaces the default rather than a feature.
     */
    const { resolution } = documentOf(
      "A = AmbientSpace",
      "B = AmbientSpace",
      "A: k = 2",
      "B: k = 5",
      "A: X(u,v) = (u, v, k + R)",
      "B: Y(u,v) = (u, v, k + R)",
    );
    expect(resolution.declaredParameters.get("A:k")).toBe(2);
    expect(resolution.declaredParameters.get("B:k")).toBe(5);
    expect(resolution.declaredParameters.has("k")).toBe(false);

    const params = [...resolution.items.values()]
      .filter((item) => item.kind === "parametricSurface")
      .map((item) => [...item.params].sort());
    // Each surface compiles against its own space's k, and against the one shared R.
    expect(params).toEqual([["A:k", "R"], ["B:k", "R"]]);
    expect(resolution.freeParameters).toContain("R");
  });

  it("lets a row inside a space fall back to the document's number", () => {
    // Nothing declares k inside A, so `k` there means the document's k. Lexical scoping, with
    // the outer scope reached by not shadowing it.
    const { resolution } = documentOf(
      "A = AmbientSpace",
      "k = 7",
      "A: X(u,v) = (u, v, k)",
    );
    expect(resolution.declaredParameters.get("k")).toBe(7);
    const surface = [...resolution.items.values()].find((i) => i.kind === "parametricSurface");
    expect(surface?.params).toEqual(["k"]);
  });

  it("keeps two spaces' objects apart even when they are spelled the same", () => {
    // Two charts called sigma is not a duplicate: they are `A:sigma` and `B:sigma`, and each
    // relation is stated in the one it addresses.
    const { document, resolution } = documentOf(
      "A = AmbientSpace",
      "B = AmbientSpace",
      "A: sigma(u,v) = (u, v, 0)",
      "B: sigma(u,v) = (u, v, 1)",
      "B:sigma: u + v = 1",
    );
    const rows = document.rows();
    for (const row of rows) {
      const diags = resolution.diagnostics.get(row.id) ?? [];
      expect(diags.filter((d) => d.severity === "error")).toEqual([]);
    }
    expect(resolution.items.get(rows[4]!.id)?.host).toBe("B:sigma");
  });
});
