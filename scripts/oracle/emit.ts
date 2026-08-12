import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { freeVars, nodeCount, type Expr } from "../../src/core/expr/ast.ts";
import { diffMulti } from "../../src/core/expr/diff.ts";
import { FN_DEFS } from "../../src/core/expr/fns.ts";
import { parse } from "../../src/core/expr/parse.ts";
import { toPython } from "../../src/core/expr/print.ts";
import { simplify } from "../../src/core/expr/simplify.ts";

/**
 * Emit the corpus the sympy oracle checks.
 *
 * ## Why this exists alongside the existing gates
 *
 * The test suite already pins every derivative-table entry against an independently written
 * closed form, and the structural rules against Richardson differences. Both are numeric
 * and both sample points. What neither can do is decide whether two expressions are equal
 * *as functions* — and that is exactly the question "is this derivative correct?" asks.
 *
 * sympy can answer it symbolically: `simplify(ours − sympy.diff(f)) == 0` is a proof, not a
 * sample. That is what makes this the genuinely independent check.
 *
 * ## The design decision that makes it cheap
 *
 * `toPython` already emits a strict subset of Python expression syntax — explicit `*`,
 * `**` for powers, function names sympy shares. So the interchange format is just source
 * text, and no serialization layer is needed on either side. Guaranteeing that subset was
 * nearly free when the printer was written; it pays for itself here.
 *
 * Runs offline as a dev step: `npm run oracle`. sympy never ships to the browser.
 */

const SEED = 20260812;

/** Curated do Carmo expressions — the ones the geometry actually depends on. */
const CURATED: readonly string[] = [
  // torus, sphere, catenoid, helicoid, pseudosphere, Enneper components
  "(2 + cos u) cos v",
  "(2 + cos u) sin v",
  "R sin u cos v",
  "R cos u",
  "c cosh(v/c) cos u",
  "u cos v",
  "sech u cos v",
  "u - tanh u",
  "u - u^3/3 + u v^2",
  "u^2 - v^2",
  "u^3 - 3u v^2",
  "a(u^2 - v^2)",
  // the shapes that show up in first and second fundamental forms
  "sqrt(1 + u^2 + v^2)",
  "1/(1 + u^2 + v^2)^2",
  "cos(u)^2 + sin(u)^2",
  "u^2 v^-3",
  "exp(-u^2 - v^2)",
  "log(u^2 + v^2 + 1)",
  "atan2(v, u)",
  "1/tan(u)",
  "sin(u v) exp(u^2 + v)",
  "u^v",
  "2^u",
  "(1 + u^2)^(3/2)",
  "cbrt(u^2 + 1)",
];

/** One case per built-in, so every derivative-table entry gets a symbolic proof. */
function perFunctionCases(): string[] {
  const cases: string[] = [];
  for (const def of FN_DEFS) {
    // Composed with a nontrivial argument, so the chain rule is exercised too rather than
    // only the bare table entry.
    if (def.arity === 1) {
      cases.push(`${def.name}(u)`);
      cases.push(`${def.name}(u^2 + v)`);
    } else if (def.arity === 2) {
      cases.push(`${def.name}(u, v)`);
      cases.push(`${def.name}(u^2, v + 1)`);
    }
  }
  return cases;
}

/** Deterministic generator, so a failure is reproducible from the printed seed. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    // xorshift32
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

/**
 * Functions safe to compose freely.
 *
 * The symbolic check does not care about domains, but the numeric fallback does, and a
 * corpus full of `asin(asin(...))` produces cases that are complex almost everywhere and
 * tell us nothing. Restricting the generator to entire functions keeps the fallback
 * meaningful; the per-function cases above still cover the rest symbolically.
 */
const SAFE_FUNCTIONS = ["sin", "cos", "tan", "sinh", "cosh", "tanh", "exp"] as const;

function randomSource(random: () => number, depth: number): string {
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!;

  if (depth <= 0) {
    const leaves = ["u", "v", "a", "1", "2", "3", "0.5"];
    return pick(leaves);
  }

  const roll = random();
  if (roll < 0.24) return `(${randomSource(random, depth - 1)} + ${randomSource(random, depth - 1)})`;
  if (roll < 0.42) return `(${randomSource(random, depth - 1)} - ${randomSource(random, depth - 1)})`;
  if (roll < 0.62) return `(${randomSource(random, depth - 1)} * ${randomSource(random, depth - 1)})`;
  if (roll < 0.72) {
    // Small integer powers only: a symbolic 1/f is fine, but f^g with random g makes sympy
    // very slow for no extra coverage.
    return `(${randomSource(random, depth - 1)})^${pick([2, 3, -1, -2])}`;
  }
  if (roll < 0.82) return `(${randomSource(random, depth - 1)} / (2 + ${randomSource(random, depth - 1)}^2))`;
  return `${pick(SAFE_FUNCTIONS)}(${randomSource(random, depth - 1)})`;
}

interface Case {
  readonly source: string;
  readonly python: string;
  readonly vars: readonly string[];
  /** derivative key ("u", "uv", "uuv") → our python-printed result */
  readonly derivatives: Record<string, string>;
  readonly nodes: number;
}

/** Derivative keys to check, given which variables the expression actually uses. */
function derivativeKeys(vars: readonly string[]): string[] {
  if (vars.length === 0) return [];
  if (vars.length === 1) {
    const only = vars[0]!;
    return [only, only + only, only + only + only];
  }
  const [first, second] = vars as [string, string];
  return [
    first,
    second,
    first + first,
    first + second,
    second + second,
    first + first + second,
  ];
}

function buildCase(source: string): Case | null {
  const { expr, diags } = parse(source);
  if (!expr || diags.some((d) => d.severity === "error")) return null;

  const used = freeVars(expr).filter((name) => name === "u" || name === "v");
  const vars = used.length > 0 ? used : ["u"];

  const derivatives: Record<string, string> = {};
  for (const key of derivativeKeys(vars)) {
    const order = key.split("");
    const derivative = simplify(diffMulti(expr, order));
    // Enormous derivatives make sympy's simplify hang without adding coverage.
    if (nodeCount(derivative) > 400) return null;
    derivatives[key] = toPython(derivative);
  }

  return {
    source,
    python: toPython(expr),
    vars,
    derivatives,
    nodes: nodeCount(expr),
  };
}

function main(): void {
  const random = makeRandom(SEED);
  const sources = new Set<string>([...CURATED, ...perFunctionCases()]);

  // Random cases, deduplicated by source text.
  let attempts = 0;
  while (sources.size < 200 && attempts < 2000) {
    attempts++;
    sources.add(randomSource(random, 3));
  }

  const cases: Case[] = [];
  let skipped = 0;
  for (const source of sources) {
    const built = buildCase(source);
    if (built) cases.push(built);
    else skipped++;
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const outputPath = join(here, "cases.json");
  mkdirSync(here, { recursive: true });
  writeFileSync(
    outputPath,
    JSON.stringify({ seed: SEED, cases }, null, 1) + "\n",
    "utf8",
  );

  const derivativeCount = cases.reduce(
    (total, one) => total + Object.keys(one.derivatives).length,
    0,
  );
  console.log(
    `emitted ${cases.length} cases (${derivativeCount} derivatives) to ` +
      `scripts/oracle/cases.json, seed ${SEED}` +
      (skipped > 0 ? `, skipped ${skipped}` : ""),
  );
}

main();

/** Re-exported so a test can build a case without spawning the script. */
export { buildCase, derivativeKeys, type Case, type Expr };
