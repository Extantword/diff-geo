import { Ctx, ctx as defaultCtx, type Expr } from "./ast.ts";

/**
 * Substitution, and inlining of user-defined functions.
 *
 * ## Why inlining is a necessity, not an optimization
 *
 * The CAS has no notion of a user-defined function: `diff` knows the built-in table and
 * the four structural rules, and nothing else. So for a document like
 *
 *     r(u) = 2 + cos u
 *     h(u) = sin u
 *     X(u,v) = (r(u) cos v, r(u) sin v, h(u))
 *
 * to be differentiable at all, the calls to `r` and `h` have to be replaced by their
 * bodies *before* differentiation. Inlining is what makes user-defined functions work.
 *
 * Interning keeps the cost down: two calls to `r(u)` inline to the identical node, so the
 * DAG stays shared and the compiled program still evaluates `cos u` once.
 */

export interface SubstituteOptions {
  readonly ctx?: Ctx;
}

/** Replace free variables by expressions, bottom-up. */
export function substitute(
  e: Expr,
  bindings: ReadonlyMap<string, Expr>,
  options: SubstituteOptions = {},
): Expr {
  const c = options.ctx ?? defaultCtx;
  if (bindings.size === 0) return e;

  const memo = new Map<number, Expr>();

  const walk = (node: Expr): Expr => {
    const cached = memo.get(node.id);
    if (cached) return cached;

    let out: Expr;
    switch (node.kind) {
      case "num":
        out = node;
        break;
      case "var":
        out = bindings.get(node.name) ?? node;
        break;
      case "add":
        out = c.add(...node.terms.map(walk));
        break;
      case "mul":
        out = c.mul(...node.factors.map(walk));
        break;
      case "pow":
        out = c.pow(walk(node.base), walk(node.exp));
        break;
      case "call":
        out = c.call(node.fn, ...node.args.map(walk));
        break;
    }

    memo.set(node.id, out);
    return out;
  };

  return walk(e);
}

/** A user-declared function: named parameters and a body. */
export interface UserFunction {
  readonly name: string;
  readonly args: readonly string[];
  readonly body: Expr;
}

export type InlineFailure =
  | { readonly kind: "depth"; readonly name: string }
  | { readonly kind: "arity"; readonly name: string; readonly expected: number; readonly got: number }
  | { readonly kind: "size"; readonly nodes: number };

export interface InlineResult {
  readonly expr: Expr | null;
  readonly failure: InlineFailure | null;
}

export interface InlineOptions {
  readonly ctx?: Ctx;
  /** named scalar definitions, e.g. `a = 2` — substituted unless the name is a parameter */
  readonly values?: ReadonlyMap<string, Expr>;
  /** user-declared functions, substituted at their call sites */
  readonly functions?: ReadonlyMap<string, UserFunction>;
  /** names that must stay symbolic: the map's own variables and its slider slots */
  readonly keep?: ReadonlySet<string>;
  /** guard against a definition chain that expands exponentially */
  readonly maxDepth?: number;
  readonly maxNodes?: number;
}

const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_NODES = 100_000;

/**
 * Expand every reference to a user value or function, leaving only variables in `keep`.
 *
 * Recursion is rejected by a depth cap rather than detected: the document layer already
 * refuses cyclic rows, so hitting the cap here means a definition chain deeper than any
 * legitimate one, and reporting it beats expanding until the tab dies.
 */
export function inlineDefinitions(e: Expr, options: InlineOptions = {}): InlineResult {
  const c = options.ctx ?? defaultCtx;
  const values = options.values ?? new Map<string, Expr>();
  const functions = options.functions ?? new Map<string, UserFunction>();
  const keep = options.keep ?? new Set<string>();
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;

  let failure: InlineFailure | null = null;

  const walk = (node: Expr, depth: number): Expr => {
    if (failure) return node;
    if (depth > maxDepth) {
      failure = { kind: "depth", name: describe(node) };
      return node;
    }

    switch (node.kind) {
      case "num":
        return node;

      case "var": {
        if (keep.has(node.name)) return node;
        const definition = values.get(node.name);
        if (!definition) return node;
        // Expand, then keep walking: a value may itself reference other values.
        return walk(definition, depth + 1);
      }

      case "add":
        return c.add(...node.terms.map((t) => walk(t, depth)));

      case "mul":
        return c.mul(...node.factors.map((f) => walk(f, depth)));

      case "pow":
        return c.pow(walk(node.base, depth), walk(node.exp, depth));

      case "call": {
        const args = node.args.map((a) => walk(a, depth));
        const fn = functions.get(node.fn);
        if (!fn) return c.call(node.fn, ...args);

        if (fn.args.length !== args.length) {
          failure = {
            kind: "arity",
            name: fn.name,
            expected: fn.args.length,
            got: args.length,
          };
          return node;
        }

        // Bind the parameters to the already-inlined arguments, then continue expanding
        // the body — which may call further user functions.
        const bindings = new Map<string, Expr>();
        fn.args.forEach((parameter, i) => bindings.set(parameter, args[i]!));
        const substituted = substitute(fn.body, bindings, { ctx: c });
        return walk(substituted, depth + 1);
      }
    }
  };

  const out = walk(e, 0);
  if (failure) return { expr: null, failure };

  // Cheap size guard: the interned table only grows, so a runaway expansion shows up here
  // rather than as a hung tab downstream in diff.
  if (c.size > maxNodes) {
    return { expr: null, failure: { kind: "size", nodes: c.size } };
  }

  return { expr: out, failure: null };
}

function describe(node: Expr): string {
  if (node.kind === "var") return node.name;
  if (node.kind === "call") return node.fn;
  return node.kind;
}
