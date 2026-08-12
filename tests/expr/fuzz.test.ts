import { describe, expect, it } from "vitest";
import { freeVars, nodeCount, type Expr } from "../../src/core/expr/ast.ts";
import { diff, diffMulti } from "../../src/core/expr/diff.ts";
import { compileMany, compileScalar } from "../../src/core/expr/eval.ts";
import { parse, parseRow } from "../../src/core/expr/parse.ts";
import { toPython, toSource } from "../../src/core/expr/print.ts";
import { toLatex } from "../../src/core/expr/latex.ts";
import { simplify } from "../../src/core/expr/simplify.ts";
import { createDocument } from "../../src/state/graph.ts";

/**
 * Fuzzing.
 *
 * Everything here is **seeded**, so a failure is reproducible from the printed seed rather
 * than being a one-off that vanishes on rerun. That property is the whole point: a flaky
 * fuzz test gets ignored, and an ignored test is worse than none.
 *
 * The properties asserted are the ones that must hold for *every* input, not just for the
 * curated corpus — no throw on garbage, round-tripping, idempotent simplification,
 * bit-identical backends, and no unflagged NaN reaching a consumer.
 */

const SEED = 20260812;

function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

const pick = <T>(random: () => number, list: readonly T[]): T =>
  list[Math.floor(random() * list.length)]!;

const TOKENS = [
  "u", "v", "a", "1", "2", "0.5", "pi", "theta", "k_1",
  "+", "-", "*", "/", "^", "(", ")", ",", "=",
  "sin", "cos", "tan", "sqrt", "log", "exp", "atan2", "abs", "sech",
  " ", "  ", "_", "{", "}", "e", "1e-3", "@", "#", "\\", "'",
];

/** Random token soup, for the "must never throw" property. */
function randomGarbage(random: () => number): string {
  const length = 1 + Math.floor(random() * 14);
  let out = "";
  for (let i = 0; i < length; i++) out += pick(random, TOKENS);
  return out;
}

/** Grammar-directed generator, for the properties that need a valid expression. */
function randomExpression(random: () => number, depth: number): string {
  if (depth <= 0) return pick(random, ["u", "v", "a", "1", "2", "3", "0.5"]);
  const roll = random();
  const next = () => randomExpression(random, depth - 1);
  if (roll < 0.2) return `(${next()} + ${next()})`;
  if (roll < 0.36) return `(${next()} - ${next()})`;
  if (roll < 0.54) return `(${next()} * ${next()})`;
  if (roll < 0.64) return `(${next()})^${pick(random, [2, 3, -1, -2])}`;
  if (roll < 0.74) return `(${next()} / (2 + ${next()}^2))`;
  return `${pick(random, ["sin", "cos", "tan", "sinh", "cosh", "tanh", "exp"])}(${next()})`;
}

describe("the parser never throws", () => {
  it("survives 4000 pieces of token soup", () => {
    const random = makeRandom(SEED);
    for (let i = 0; i < 4000; i++) {
      const source = randomGarbage(random);
      // Either an AST or diagnostics — never an exception, because a half-typed row must
      // not unwind the render loop.
      expect(() => parse(source), `seed ${SEED}, input ${JSON.stringify(source)}`).not.toThrow();
      expect(() => parseRow(source), `seed ${SEED}, input ${JSON.stringify(source)}`).not.toThrow();
    }
  });

  it("always returns either an expression or an error diagnostic", () => {
    const random = makeRandom(SEED + 1);
    for (let i = 0; i < 2000; i++) {
      const source = randomGarbage(random);
      const { expr, diags } = parse(source);
      if (expr === null) {
        expect(
          diags.some((d) => d.severity === "error"),
          `silent failure on ${JSON.stringify(source)}`,
        ).toBe(true);
      }
    }
  });
});

describe("printing round-trips", () => {
  /**
   * The exact guarantee, which is narrower than "print then parse is the identity".
   *
   * The constructors preserve input order on purpose (so the typeset echo mirrors what was
   * typed), while the printer always writes a product's numeric coefficient first — it
   * emits `2 * a` for both `a * 2` and `2 * a`. Those are deliberately *different* interned
   * nodes, so structural round-tripping cannot hold for arbitrary input, and claiming it
   * did was an error in an earlier version of this test rather than a bug in the printer.
   *
   * What does hold, and is what actually matters:
   *
   *   - on a **canonical** expression, printing and reparsing is the identity;
   *   - on **any** expression, printing and reparsing preserves meaning, i.e. it agrees
   *     after canonicalization.
   */
  it("always reparses to something that evaluates identically", () => {
    // Checked NUMERICALLY, not by comparing canonical forms. `simplify` is bounded on
    // purpose and is not a decision procedure, so two expressions can be equal as functions
    // while having different canonical forms — using it as the equality oracle here would
    // report printer bugs that are really just gaps in the simplifier.
    const random = makeRandom(SEED + 2);
    let compared = 0;

    for (let i = 0; i < 1200; i++) {
      const source = randomExpression(random, 4);
      const parsed = parse(source).expr;
      if (!parsed) continue;

      const printed = toSource(parsed);
      const reparsed = parse(printed).expr;
      expect(reparsed, `seed ${SEED}, ${source} → ${printed} did not reparse`).not.toBeNull();

      const before = compileScalar(parsed, { vars: ["u", "v", "a"] });
      const after = compileScalar(reparsed!, { vars: ["u", "v", "a"] });
      for (const point of [
        [0.73, 1.31, 0.42],
        [-1.17, 0.64, 2.21],
      ]) {
        const x = before.call(point);
        const y = after.call(point);
        if (!Number.isFinite(x) && !Number.isFinite(y)) continue;
        const scale = Math.max(1, Math.abs(x), Math.abs(y));
        expect(
          Math.abs(x - y),
          `seed ${SEED}, ${source} → ${printed} at ${point.join(",")}: ${x} vs ${y}`,
        ).toBeLessThan(1e-12 * scale);
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(1500);
  });

  it("keeps the structural round-trip on the shapes that carry no denominator", () => {
    // Where the printer takes no structural liberties, identity does hold — and interning
    // makes that a reference check. Products with denominators are excluded because the
    // numerator/denominator split necessarily reorders factors.
    const corpus = [
      "2u", "u + v", "u - v", "-u", "u^2", "sin u", "cos u cos v",
      "sin^2 u", "sqrt(1 - u^2)", "u^3 - 3u v^2", "exp(-u^2)", "atan2(v, u)",
    ];
    for (const source of corpus) {
      const first = parse(source).expr!;
      expect(parse(toSource(first)).expr, `round-trip failed for ${source}`).toBe(first);
    }
  });

  it("emits LaTeX that KaTeX would accept, without throwing", () => {
    const random = makeRandom(SEED + 3);
    for (let i = 0; i < 1200; i++) {
      const expr = parse(randomExpression(random, 4)).expr;
      if (!expr) continue;
      expect(() => toLatex(expr)).not.toThrow();
      expect(() => toPython(expr)).not.toThrow();
    }
  });
});

describe("simplify", () => {
  it("is idempotent", () => {
    const random = makeRandom(SEED + 4);
    for (let i = 0; i < 1200; i++) {
      const expr = parse(randomExpression(random, 4)).expr;
      if (!expr) continue;
      const once = simplify(expr);
      // Interning makes this a reference check.
      expect(simplify(once), `seed ${SEED}, ${toSource(expr)}`).toBe(once);
    }
  });

  it("preserves semantics", () => {
    const random = makeRandom(SEED + 5);
    let compared = 0;
    for (let i = 0; i < 600; i++) {
      const source = randomExpression(random, 4);
      const expr = parse(source).expr;
      if (!expr) continue;
      const reduced = simplify(expr);
      const before = compileScalar(expr, { vars: ["u", "v", "a"] });
      const after = compileScalar(reduced, { vars: ["u", "v", "a"] });

      for (const point of [
        [0.7, 1.3, 0.4],
        [-1.1, 0.6, 2.2],
        [2.3, -0.8, 1.0],
      ]) {
        const x = before.call(point);
        const y = after.call(point);
        // Both non-finite counts as agreement: simplification may legitimately turn one
        // flavour of non-finite into another at an isolated point.
        if (!Number.isFinite(x) && !Number.isFinite(y)) continue;
        const scale = Math.max(1, Math.abs(x), Math.abs(y));
        expect(
          Math.abs(x - y),
          `seed ${SEED}, ${source} at ${point.join(",")}: ${x} vs ${y}`,
        ).toBeLessThan(1e-9 * scale);
        compared++;
      }
    }
    // Guard against the loop silently skipping everything.
    expect(compared).toBeGreaterThan(500);
  });
});

describe("the two backends stay bit-identical", () => {
  it("agrees exactly on values and derivatives across the fuzz corpus", () => {
    const random = makeRandom(SEED + 6);
    for (let i = 0; i < 400; i++) {
      const source = randomExpression(random, 4);
      const expr = parse(source).expr;
      if (!expr) continue;

      const outputs: Expr[] = [
        expr,
        simplify(diff(expr, "u")),
        simplify(diffMulti(expr, ["u", "v"])),
      ];
      if (nodeCount(outputs[2]!) > 3000) continue;

      const codegen = compileMany(outputs, { vars: ["u", "v", "a"], backend: "codegen" });
      const interpreted = compileMany(outputs, {
        vars: ["u", "v", "a"],
        backend: "interpreter",
      });

      const left = new Float64Array(outputs.length);
      const right = new Float64Array(outputs.length);
      const noParams = new Float64Array(0);

      for (const point of [
        [0.7, 1.3, 0.4],
        [-1.1, 0.6, 2.2],
      ]) {
        codegen.evaluate(point, noParams, left);
        interpreted.evaluate(point, noParams, right);
        for (let k = 0; k < outputs.length; k++) {
          expect(
            Object.is(left[k]!, right[k]!),
            `seed ${SEED}, ${source} output ${k}: ${left[k]} vs ${right[k]}`,
          ).toBe(true);
        }
      }
    }
  });
});

describe("differentiation stays finite and bounded", () => {
  it("never produces an unexpected NaN where the value itself is finite", () => {
    const random = makeRandom(SEED + 7);
    for (let i = 0; i < 600; i++) {
      const source = randomExpression(random, 3);
      const expr = parse(source).expr;
      if (!expr) continue;
      const derivative = simplify(diff(expr, "u"));
      const value = compileScalar(expr, { vars: ["u", "v", "a"] });
      const slope = compileScalar(derivative, { vars: ["u", "v", "a"] });

      for (const point of [
        [0.61, 1.27, 0.43],
        [1.9, -0.77, 1.4],
      ]) {
        const f = value.call(point);
        if (!Number.isFinite(f)) continue;
        const df = slope.call(point);
        // Where f is finite, f′ should be too — the generator only uses functions that are
        // entire, so a NaN here would mean the derivative introduced a singularity that the
        // original did not have.
        expect(
          Number.isFinite(df),
          `seed ${SEED}, d/du ${source} at ${point.join(",")} gave ${df} while f = ${f}`,
        ).toBe(true);
      }
    }
  });

  it("keeps third derivatives within the node budget", () => {
    const random = makeRandom(SEED + 8);
    let worst = 0;
    for (let i = 0; i < 200; i++) {
      const expr = parse(randomExpression(random, 3)).expr;
      if (!expr) continue;
      worst = Math.max(worst, nodeCount(simplify(diffMulti(expr, ["u", "u", "v"]))));
    }
    // Not a performance target so much as a tripwire: memoized differentiation plus
    // interning should keep this in the hundreds, and a regression to exponential blowup
    // would show up here as thousands.
    expect(worst).toBeLessThan(4000);
  });
});

describe("random documents", () => {
  it("always terminate, diagnose cycles, and respect the topological order", () => {
    const random = makeRandom(SEED + 9);
    const names = ["a", "b", "c", "d", "f", "g"];

    for (let trial = 0; trial < 300; trial++) {
      const rowCount = 2 + Math.floor(random() * 5);
      const sources: string[] = [];
      for (let i = 0; i < rowCount; i++) {
        const name = names[i % names.length]!;
        // Reference an arbitrary other name, so cycles arise naturally rather than being
        // constructed by hand.
        const other = pick(random, names);
        sources.push(random() < 0.5 ? `${name} = ${other} + 1` : `${name} = ${other} * 2`);
      }

      const document = createDocument(sources);
      let resolution;
      expect(() => {
        resolution = document.resolution();
      }, `seed ${SEED}, trial ${trial}: ${sources.join(" | ")}`).not.toThrow();

      const resolved = resolution!;
      // Every row is either ordered or diagnosed — never silently dropped.
      for (const row of document.rows()) {
        const ordered = resolved.order.includes(row.id);
        const diagnosed = (resolved.diagnostics.get(row.id) ?? []).length > 0;
        expect(
          ordered || diagnosed,
          `row ${row.id} neither ordered nor diagnosed: ${sources.join(" | ")}`,
        ).toBe(true);
      }
    }
  });

  it("never leaves an item referencing an undefined name it could have resolved", () => {
    const random = makeRandom(SEED + 10);
    for (let trial = 0; trial < 200; trial++) {
      const document = createDocument([
        "a = 2",
        `X(u,v) = (${randomExpression(random, 2)}, v, 0)`,
      ]);
      const resolution = document.resolution();
      const surface = [...resolution.items.values()].find(
        (item) => item.kind === "parametricSurface",
      );
      if (!surface) continue;
      // `a` is defined, so it must have been inlined rather than left as a parameter.
      expect(surface.params).not.toContain("a");
      for (const comp of surface.comps) {
        expect(freeVars(comp)).not.toContain("a");
      }
    }
  });
});
