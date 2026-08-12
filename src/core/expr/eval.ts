import { type Expr } from "./ast.ts";
import { type Diagnostic } from "./diagnostics.ts";
import { lookupFn } from "./fns.ts";
import { lower, type Op, type Program } from "./program.ts";

/**
 * The two numeric backends.
 *
 * ## Why there are two
 *
 * `new Function` codegen is an order of magnitude faster than interpreting, and it is
 * what the mesh loop uses — a 128×128 grid evaluating an order-2 jet is ~16k calls per
 * retessellation. But keeping the interpreter is worth far more than its ~50 lines:
 *
 *  - it is the fallback if the page ever runs under a Content-Security-Policy that
 *    forbids `new Function` (GitHub Pages sets no CSP, so this is insurance, not a
 *    current need);
 *  - it is a **free differential oracle**. Both backends walk the same op list in the
 *    same order, so their results must agree *bit for bit*, not approximately. That
 *    `Object.is` check exercises the entire lowering, CSE and codegen pipeline on every
 *    fuzz case, which is the strongest cheap test available here.
 *
 * An unexercised fallback rots, so the geometry suite runs against both.
 */

export type Backend = "codegen" | "interpreter";

/** Writes one value per output expression into `out`. */
export type EvalFn = (
  args: ArrayLike<number>,
  params: ArrayLike<number>,
  out: Float64Array,
) => void;

export interface Compiled {
  readonly evaluate: EvalFn;
  readonly program: Program;
  readonly diags: readonly Diagnostic[];
  readonly outputCount: number;
  /** generated JavaScript, or "" for the interpreter — useful in golden tests */
  readonly source: string;
  readonly backend: Backend;
}

export interface CompileOptions {
  readonly vars: readonly string[];
  readonly params?: readonly string[];
  readonly backend?: Backend;
  /**
   * Refuse to compile beyond this instruction count, reporting `E_TOO_COMPLEX` instead
   * of hanging the tab. Third derivatives of a nested formula are what this guards.
   */
  readonly maxOps?: number;
}

const DEFAULT_MAX_OPS = 200_000;

/** The JavaScript expression for one op, given the names of its operand temporaries. */
function opSource(op: Op, name: (slot: number) => string): string {
  switch (op.k) {
    case "num":
      return numberSource(op.value);
    case "arg":
      return `a[${op.index}]`;
    case "param":
      return `p[${op.index}]`;
    case "add":
      return op.args.map(name).join(" + ");
    case "mul":
      return op.args.map(name).join(" * ");
    case "recip":
      return `1 / ${name(op.arg)}`;
    case "pow":
      return `Math.pow(${name(op.base)}, ${name(op.exp)})`;
    case "call": {
      const def = lookupFn(op.fn);
      const args = op.args.map(name);
      if (def?.js) return def.js(args);
      // Everything else is exactly a Math.* function of the same name.
      return `Math.${def?.name ?? op.fn}(${args.join(", ")})`;
    }
  }
}

function numberSource(v: number): string {
  if (Number.isNaN(v)) return "NaN";
  if (v === Infinity) return "Infinity";
  if (v === -Infinity) return "-Infinity";
  // Parenthesized so a negative literal cannot fuse with a preceding operator.
  return v < 0 ? `(${v})` : String(v);
}

function generateSource(program: Program): string {
  const name = (slot: number) => `t${slot}`;
  const lines: string[] = [];

  program.ops.forEach((op, slot) => {
    // One statement per op. Because the AST is interned, each distinct subexpression
    // is one op — so this single loop is the common-subexpression elimination.
    lines.push(`const ${name(slot)} = ${opSource(op, name)};`);
  });

  program.outputs.forEach((slot, i) => {
    lines.push(`out[${i}] = ${name(slot)};`);
  });

  return lines.join("\n");
}

function compileCodegen(program: Program): { evaluate: EvalFn; source: string } {
  const source = generateSource(program);
  // eslint-disable-next-line no-new-func -- see the module header: this is the fast
  // path, and `interpret` is the CSP fallback and differential oracle.
  const evaluate = new Function("a", "p", "out", source) as EvalFn;
  return { evaluate, source };
}

function compileInterpreter(program: Program): { evaluate: EvalFn; source: string } {
  const ops = program.ops;
  const outputs = program.outputs;
  // Reused across calls; the evaluator is single-threaded and non-reentrant by design.
  const temps = new Float64Array(ops.length);

  const evaluate: EvalFn = (a, p, out) => {
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i]!;
      switch (op.k) {
        case "num":
          temps[i] = op.value;
          break;
        case "arg":
          temps[i] = a[op.index]!;
          break;
        case "param":
          temps[i] = p[op.index]!;
          break;
        case "add": {
          // Left-to-right, matching the `t0 + t1 + t2` the generator emits, so that
          // floating-point association is identical between the backends.
          let sum = temps[op.args[0]!]!;
          for (let k = 1; k < op.args.length; k++) sum += temps[op.args[k]!]!;
          temps[i] = sum;
          break;
        }
        case "mul": {
          let product = temps[op.args[0]!]!;
          for (let k = 1; k < op.args.length; k++) product *= temps[op.args[k]!]!;
          temps[i] = product;
          break;
        }
        case "recip":
          temps[i] = 1 / temps[op.arg]!;
          break;
        case "pow":
          temps[i] = Math.pow(temps[op.base]!, temps[op.exp]!);
          break;
        case "call": {
          const def = lookupFn(op.fn);
          if (!def) {
            temps[i] = Number.NaN;
            break;
          }
          // `evaluate` takes an array; allocating one per call is why this backend is
          // the slow path. Correctness and agreement are its jobs, not throughput.
          const values: number[] = [];
          for (const slot of op.args) values.push(temps[slot]!);
          temps[i] = def.evaluate(values);
          break;
        }
      }
    }
    for (let i = 0; i < outputs.length; i++) out[i] = temps[outputs[i]!]!;
  };

  return { evaluate, source: "" };
}

/** Compile several expressions sharing one program, and therefore one CSE pass. */
export function compileMany(
  exprs: readonly Expr[],
  options: CompileOptions,
): Compiled {
  const program = lower(exprs, { vars: options.vars, params: options.params });
  const maxOps = options.maxOps ?? DEFAULT_MAX_OPS;
  const backend = options.backend ?? "codegen";

  if (program.ops.length > maxOps) {
    const diags: Diagnostic[] = [
      ...program.diags,
      {
        severity: "error",
        code: "E_TOO_COMPLEX",
        message:
          `this expression compiles to ${program.ops.length} operations, past the ` +
          `limit of ${maxOps} — try simplifying it or reducing nesting`,
      },
    ];
    return {
      evaluate: (_a, _p, out) => out.fill(Number.NaN),
      program,
      diags,
      outputCount: exprs.length,
      source: "",
      backend,
    };
  }

  const compiled =
    backend === "interpreter" ? compileInterpreter(program) : compileCodegen(program);

  return {
    evaluate: compiled.evaluate,
    program,
    diags: program.diags,
    outputCount: exprs.length,
    source: compiled.source,
    backend,
  };
}

/** Compile one expression to a plain scalar function. */
export function compileScalar(
  e: Expr,
  options: CompileOptions,
): {
  readonly call: (args: ArrayLike<number>, params?: ArrayLike<number>) => number;
  readonly diags: readonly Diagnostic[];
  readonly program: Program;
  readonly source: string;
} {
  const compiled = compileMany([e], options);
  const out = new Float64Array(1);
  const noParams = new Float64Array(0);
  return {
    call: (args, params) => {
      compiled.evaluate(args, params ?? noParams, out);
      return out[0]!;
    },
    diags: compiled.diags,
    program: compiled.program,
    source: compiled.source,
  };
}

/**
 * Evaluate an expression at named values. Convenience for tests and readouts — the hot
 * paths compile once and call many times instead.
 */
export function evaluateAt(e: Expr, bindings: Readonly<Record<string, number>>): number {
  const vars = Object.keys(bindings);
  const compiled = compileScalar(e, { vars });
  return compiled.call(vars.map((name) => bindings[name]!));
}
