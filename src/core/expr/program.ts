import { type Expr } from "./ast.ts";
import { error, type Diagnostic } from "./diagnostics.ts";

/**
 * Lowering from the expression DAG to a flat instruction list.
 *
 * ## Why an intermediate program at all
 *
 * Three backends consume it — JavaScript codegen, a closure-free interpreter, and (from
 * M4) GLSL. Sharing one lowering gives two properties that are hard to get otherwise:
 *
 *  1. **Common-subexpression elimination comes for free.** Because the AST is interned,
 *     each distinct node appears exactly once in the op list. Emitting one instruction
 *     per node *is* the CSE — no value numbering, no hashing pass. This is the payoff
 *     the plan trades aggressive algebraic simplification for.
 *  2. **The backends must agree bit-for-bit.** They walk the same ops in the same order,
 *     so floating-point association is identical. `Object.is` equality between the
 *     codegen and interpreter results is therefore a devastatingly strong test of the
 *     whole pipeline, and it costs nothing to run.
 *
 * Integer powers are expanded *here*, not in a backend, so that both backends see the
 * same multiplications rather than one using `Math.pow` and the other `x * x`.
 */

export type Op =
  | { readonly k: "num"; readonly value: number }
  /** positional input, e.g. u or v */
  | { readonly k: "arg"; readonly index: number }
  /** slider slot; changing one of these never triggers recompilation */
  | { readonly k: "param"; readonly index: number }
  | { readonly k: "add"; readonly args: readonly number[] }
  | { readonly k: "mul"; readonly args: readonly number[] }
  | { readonly k: "recip"; readonly arg: number }
  | { readonly k: "pow"; readonly base: number; readonly exp: number }
  | { readonly k: "call"; readonly fn: string; readonly args: readonly number[] };

export interface Program {
  readonly ops: readonly Op[];
  /** op index producing each output, in order */
  readonly outputs: readonly number[];
  readonly vars: readonly string[];
  readonly params: readonly string[];
  readonly diags: readonly Diagnostic[];
}

/** Powers up to this magnitude expand to repeated multiplication. */
const MAX_EXPANDED_POWER = 4;

export interface LowerOptions {
  /** positional inputs, in order */
  readonly vars: readonly string[];
  /** named slider slots, in order */
  readonly params?: readonly string[];
}

export function lower(exprs: readonly Expr[], options: LowerOptions): Program {
  const vars = options.vars;
  const params = options.params ?? [];

  const varIndex = new Map<string, number>();
  vars.forEach((name, i) => varIndex.set(name, i));
  const paramIndex = new Map<string, number>();
  params.forEach((name, i) => paramIndex.set(name, i));

  const ops: Op[] = [];
  const slotOf = new Map<number, number>();
  const diags: Diagnostic[] = [];
  const undefined_ = new Set<string>();

  const emit = (op: Op): number => {
    ops.push(op);
    return ops.length - 1;
  };

  /** Emit `base` raised to an integer power, as multiplications. */
  const emitIntegerPower = (baseSlot: number, exponent: number): number => {
    const magnitude = Math.abs(exponent);
    let slot: number;
    if (magnitude === 1) {
      slot = baseSlot;
    } else {
      slot = emit({ k: "mul", args: new Array(magnitude).fill(baseSlot) });
    }
    return exponent < 0 ? emit({ k: "recip", arg: slot }) : slot;
  };

  const visit = (node: Expr): number => {
    const existing = slotOf.get(node.id);
    if (existing !== undefined) return existing;

    let slot: number;
    switch (node.kind) {
      case "num":
        slot = emit({ k: "num", value: node.value });
        break;

      case "var": {
        const asVar = varIndex.get(node.name);
        if (asVar !== undefined) {
          slot = emit({ k: "arg", index: asVar });
          break;
        }
        const asParam = paramIndex.get(node.name);
        if (asParam !== undefined) {
          slot = emit({ k: "param", index: asParam });
          break;
        }
        // Unresolved names become NaN rather than a thrown error, so a half-typed
        // formula degrades to "—" in the readout instead of unwinding the render loop.
        if (!undefined_.has(node.name)) {
          undefined_.add(node.name);
          diags.push(
            error("E_UNDEF_SYMBOL", `"${node.name}" is not defined`),
          );
        }
        slot = emit({ k: "num", value: Number.NaN });
        break;
      }

      case "add":
        slot = emit({ k: "add", args: node.terms.map(visit) });
        break;

      case "mul":
        slot = emit({ k: "mul", args: node.factors.map(visit) });
        break;

      case "pow": {
        const baseSlot = visit(node.base);
        if (
          node.exp.kind === "num" &&
          Number.isInteger(node.exp.value) &&
          node.exp.value !== 0 &&
          Math.abs(node.exp.value) <= MAX_EXPANDED_POWER
        ) {
          slot = emitIntegerPower(baseSlot, node.exp.value);
          break;
        }
        slot = emit({ k: "pow", base: baseSlot, exp: visit(node.exp) });
        break;
      }

      case "call":
        slot = emit({ k: "call", fn: node.fn, args: node.args.map(visit) });
        break;
    }

    slotOf.set(node.id, slot);
    return slot;
  };

  const outputs = exprs.map(visit);
  return { ops, outputs, vars, params, diags };
}

/** Total instruction count — the compiled-size metric the node budget guards. */
export function programSize(program: Program): number {
  return program.ops.length;
}

/** Every function name the program calls, for GLSL prelude selection. */
export function calledFunctions(program: Program): Set<string> {
  const names = new Set<string>();
  for (const op of program.ops) if (op.k === "call") names.add(op.fn);
  return names;
}
