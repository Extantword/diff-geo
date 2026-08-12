import { freeVars, type Expr } from "../core/expr/ast.ts";
import { error, hint, type Diagnostic } from "../core/expr/diagnostics.ts";
import { lookupFn } from "../core/expr/fns.ts";
import { parseRow, type ParsedRow } from "../core/expr/parse.ts";
import {
  inlineDefinitions,
  type InlineFailure,
  type UserFunction,
} from "../core/expr/substitute.ts";
import { computed, signal, type Signal, type WritableSignal } from "./signal.ts";

/**
 * The document: a list of rows that may refer to one another.
 *
 * ## One computed owns resolution
 *
 * Rows never read each other's signals. A single document-level `computed` reads every
 * row's text, builds the symbol table, finds cycles, and produces a topological order;
 * rows then read *that*.
 *
 * This is a correctness requirement, not tidiness. If row A's derived value read row B's,
 * then `a = b` / `b = a` in the user's document would become a cycle in the *reactive*
 * graph — an infinite recomputation, not a diagnostic. Routing everything through one
 * computed makes a user-level cycle into **data**: a `Resolution` carrying an `E_CYCLE`.
 *
 * ## Classification
 *
 * Conventions taken from do Carmo and hard-coded: `t` parametrizes curves, `u, v`
 * parametrize surfaces, `x, y, z` are ambient coordinates. A row's shape plus its
 * remaining free variables determine what it *is*, and therefore how it renders.
 */

export type RowId = number;

export interface Row {
  readonly id: RowId;
  readonly source: WritableSignal<string>;
}

export type ItemKind =
  | "scalar"
  | "planeCurve"
  | "spaceCurve"
  | "parametricSurface"
  | "graphSurface"
  | "implicitSurface"
  | "implicitPlaneCurve"
  | "point"
  | "vectorField"
  | "functionDefinition"
  /** a row declaring a plain number: becomes a compiled slot, not an inlined literal */
  | "parameter"
  | "unknown";

export interface Item {
  readonly rowId: RowId;
  readonly kind: ItemKind;
  /** name if the row declared one */
  readonly name: string | null;
  /** the parametrization variables, in order: [] for a scalar, ["t"], ["u","v"], … */
  readonly vars: readonly string[];
  /** fully inlined components, ready for buildDiffMap */
  readonly comps: readonly Expr[];
  /** free names that are neither vars nor defined elsewhere — candidate sliders */
  readonly params: readonly string[];
}

export interface Resolution {
  /** row ids in dependency order */
  readonly order: readonly RowId[];
  readonly diagnostics: ReadonlyMap<RowId, readonly Diagnostic[]>;
  readonly items: ReadonlyMap<RowId, Item>;
  /** every symbol needing a slider, sorted — undefined ones and declared numbers alike */
  readonly freeParameters: readonly string[];
  /**
   * Rows that declare a plain number, as name → declared value.
   *
   * These stay **symbolic** in the rows that use them rather than being inlined, so they
   * compile to a slot. That is what lets a slider move without changing a single expression:
   * inlining the literal instead would build a whole new interned tree per frame and force
   * re-differentiation of everything downstream.
   */
  readonly declaredParameters: ReadonlyMap<string, number>;
}

export interface DocumentStore {
  readonly rows: Signal<readonly Row[]>;
  readonly resolution: Signal<Resolution>;
  /** Slider values, keyed by name. Changing one recompiles nothing. */
  readonly parameters: WritableSignal<ReadonlyMap<string, number>>;
  addRow(source?: string): Row;
  removeRow(id: RowId): void;
  /** Replace every row at once, for loading a template. */
  setRows(sources: readonly string[]): Row[];
  /** Per-row diagnostics, as a stable signal so a row can render its own errors. */
  diagnosticsFor(id: RowId): Signal<readonly Diagnostic[]>;
  itemFor(id: RowId): Signal<Item | null>;
  setParameter(name: string, value: number): void;
}

const CURVE_VAR = "t";
const SURFACE_VARS = ["u", "v"] as const;
const AMBIENT_VARS = ["x", "y", "z"] as const;

export function createDocument(initial: readonly string[] = []): DocumentStore {
  let nextId = 1;
  const rowsSignal = signal<readonly Row[]>(
    initial.map((source) => ({ id: nextId++, source: signal(source) })),
  );
  const parameters = signal<ReadonlyMap<string, number>>(new Map());

  const resolution = computed<Resolution>(() => resolve(rowsSignal()));

  /**
   * Per-row views onto the single resolution.
   *
   * These are memoized so that a row's editor subscribes to a stable signal, and the
   * `eq` on the item view stops a re-render when a row's own meaning did not change even
   * though a sibling's did.
   */
  const diagnosticCache = new Map<RowId, Signal<readonly Diagnostic[]>>();
  const itemCache = new Map<RowId, Signal<Item | null>>();

  const store: DocumentStore = {
    rows: rowsSignal,
    resolution,
    parameters,

    addRow(source = "") {
      const row: Row = { id: nextId++, source: signal(source) };
      rowsSignal.set([...rowsSignal(), row]);
      return row;
    },

    removeRow(id) {
      rowsSignal.set(rowsSignal().filter((row) => row.id !== id));
      diagnosticCache.delete(id);
      itemCache.delete(id);
    },

    setRows(sources) {
      // Fresh ids rather than reusing the old ones: the per-row caches key off the id, and a
      // recycled id would hand a new row its predecessor's memoized item.
      for (const row of rowsSignal()) {
        diagnosticCache.delete(row.id);
        itemCache.delete(row.id);
      }
      const rows = sources.map((source) => ({ id: nextId++, source: signal(source) }));
      rowsSignal.set(rows);
      return rows;
    },

    diagnosticsFor(id) {
      let existing = diagnosticCache.get(id);
      if (!existing) {
        existing = computed(
          () => resolution().diagnostics.get(id) ?? [],
          // Identity is too strict: an unchanged empty list should not re-render a row.
          (a, b) => a.length === 0 && b.length === 0,
        );
        diagnosticCache.set(id, existing);
      }
      return existing;
    },

    itemFor(id) {
      let existing = itemCache.get(id);
      if (!existing) {
        existing = computed(() => resolution().items.get(id) ?? null, itemsEqual);
        itemCache.set(id, existing);
      }
      return existing;
    },

    setParameter(name, value) {
      const next = new Map(parameters());
      next.set(name, value);
      parameters.set(next);
    },
  };

  return store;
}

/**
 * Two items mean the same thing if their compiled inputs are identical.
 *
 * Because expressions are interned, comparing component identity is exact and O(number of
 * components) — so editing one row does not invalidate the rendering of its siblings.
 */
function itemsEqual(a: Item | null, b: Item | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.kind !== b.kind || a.name !== b.name) return false;
  if (a.comps.length !== b.comps.length) return false;
  for (let i = 0; i < a.comps.length; i++) {
    if (a.comps[i] !== b.comps[i]) return false;
  }
  return (
    a.vars.length === b.vars.length &&
    a.vars.every((v, i) => v === b.vars[i]) &&
    a.params.length === b.params.length &&
    a.params.every((p, i) => p === b.params[i])
  );
}

interface Declaration {
  readonly rowId: RowId;
  readonly row: ParsedRow;
}

/** Resolve the whole document in one pass. */
export function resolve(rows: readonly Row[]): Resolution {
  const diagnostics = new Map<RowId, Diagnostic[]>();
  const parsedRows = new Map<RowId, ParsedRow>();

  const push = (id: RowId, diag: Diagnostic) => {
    const list = diagnostics.get(id);
    if (list) list.push(diag);
    else diagnostics.set(id, [diag]);
  };

  // ---- pass 1: parse every row ----
  const userFunctionNames = new Set<string>();
  for (const row of rows) {
    const text = row.source();
    if (text.trim() === "") {
      diagnostics.set(row.id, []);
      continue;
    }
    const { row: parsed, diags } = parseRow(text);
    diagnostics.set(row.id, [...diags]);
    if (parsed) {
      parsedRows.set(row.id, parsed);
      if (
        (parsed.kind === "function" || parsed.kind === "vectorFunction") &&
        parsed.args.length > 0
      ) {
        userFunctionNames.add(parsed.name);
      }
    }
  }

  // Rows that declare a function must be re-parsed once the function names are known, so
  // that `f(u) g(u)` reads as a product of two calls rather than as implicit multiplication
  // against a parenthesised group.
  if (userFunctionNames.size > 0) {
    for (const row of rows) {
      const text = row.source();
      if (text.trim() === "") continue;
      const { row: parsed, diags } = parseRow(text, { userFunctions: userFunctionNames });
      diagnostics.set(row.id, [...diags]);
      if (parsed) parsedRows.set(row.id, parsed);
      else parsedRows.delete(row.id);
    }
  }

  // ---- pass 2: symbol table, rejecting duplicates and reserved names ----
  const declarations = new Map<string, Declaration>();
  const duplicated = new Set<string>();

  for (const row of rows) {
    const parsed = parsedRows.get(row.id);
    if (!parsed) continue;
    const name = declaredName(parsed);
    if (name === null) continue;

    if (lookupFn(name)) {
      push(row.id, error("E_RESERVED", `"${name}" is a built-in function`));
      continue;
    }
    const existing = declarations.get(name);
    if (existing) {
      // Fail closed: the name resolves to *neither* row. Resolving to "the first one"
      // would make editing order silently significant.
      duplicated.add(name);
      push(row.id, error("E_DUPLICATE", `"${name}" is defined more than once`));
      push(existing.rowId, error("E_DUPLICATE", `"${name}" is defined more than once`));
      continue;
    }
    declarations.set(name, { rowId: row.id, row: parsed });
  }
  for (const name of duplicated) declarations.delete(name);

  // ---- pass 3: dependency edges and cycle detection ----
  const dependencies = new Map<RowId, Set<RowId>>();
  for (const row of rows) {
    const parsed = parsedRows.get(row.id);
    const edges = new Set<RowId>();
    dependencies.set(row.id, edges);
    if (!parsed) continue;

    const locals = new Set(localNames(parsed));
    for (const name of referencedNames(parsed)) {
      if (locals.has(name)) continue;
      const declaration = declarations.get(name);
      if (declaration && declaration.rowId !== row.id) edges.add(declaration.rowId);
      // Self-reference is genuine recursion, which the CAS cannot differentiate.
      if (declaration && declaration.rowId === row.id) {
        push(row.id, error("E_RECURSION", `"${name}" refers to itself`));
      }
    }
  }

  const { order, cyclic } = topologicalOrder(rows.map((r) => r.id), dependencies);
  for (const id of cyclic) {
    push(
      id,
      error(
        "E_CYCLE",
        "this row is part of a circular definition, so it cannot be evaluated",
      ),
    );
  }

  // ---- pass 4: inline and classify, in dependency order ----
  const values = new Map<string, Expr>();
  const functions = new Map<string, UserFunction>();
  const items = new Map<RowId, Item>();
  const freeParameters = new Set<string>();
  const declaredParameters = new Map<string, number>();

  for (const id of order) {
    if (cyclic.has(id)) continue;
    const parsed = parsedRows.get(id);
    if (!parsed) continue;
    const rowDiagnostics = diagnostics.get(id) ?? [];
    if (rowDiagnostics.some((d) => d.severity === "error")) continue;

    const item = classify(id, parsed, values, functions, push);
    if (!item) continue;

    items.set(id, item);
    for (const name of item.params) freeParameters.add(name);

    // Publish this row's definition for the rows that depend on it.
    if (item.kind === "parameter" && item.name && item.comps[0]?.kind === "num") {
      // Deliberately NOT added to `values`: leaving it symbolic is what makes it a slot.
      declaredParameters.set(item.name, item.comps[0].value);
      freeParameters.add(item.name);
    } else if (item.kind === "scalar" && item.name && item.comps[0]) {
      values.set(item.name, item.comps[0]);
    } else if (item.kind === "functionDefinition" && item.name) {
      functions.set(item.name, {
        name: item.name,
        args: item.vars,
        body: item.comps[0]!,
      });
    }
  }

  for (const name of freeParameters) {
    // Only for genuinely undefined symbols: a declared number already has its own slider on
    // the row that declares it, so hinting there would be noise.
    if (declaredParameters.has(name)) continue;
    const owner = [...items.values()].find((item) => item.params.includes(name));
    if (owner) {
      push(owner.rowId, hint("H_ADD_SLIDER", `add a slider for "${name}"`));
    }
  }

  return {
    order,
    diagnostics,
    items,
    freeParameters: [...freeParameters].sort(),
    declaredParameters,
  };
}

function declaredName(parsed: ParsedRow): string | null {
  switch (parsed.kind) {
    case "value":
    case "function":
    case "vectorFunction":
      return parsed.name;
    default:
      return null;
  }
}

/** Names bound locally by a declaration's parameter list. */
function localNames(parsed: ParsedRow): readonly string[] {
  if (parsed.kind === "function" || parsed.kind === "vectorFunction") return parsed.args;
  return [];
}

function bodyExpressions(parsed: ParsedRow): readonly Expr[] {
  switch (parsed.kind) {
    case "value":
    case "function":
    case "expr":
      return [parsed.body];
    case "vectorFunction":
    case "tuple":
      return parsed.comps;
    case "equation":
      return [parsed.lhs, parsed.rhs];
  }
}

function referencedNames(parsed: ParsedRow): readonly string[] {
  const names = new Set<string>();
  for (const e of bodyExpressions(parsed)) {
    for (const name of freeVars(e)) names.add(name);
    collectCalls(e, names);
  }
  return [...names];
}

function collectCalls(e: Expr, into: Set<string>): void {
  if (e.kind === "call") {
    // Only user functions matter here; built-ins are never document references.
    if (!lookupFn(e.fn)) into.add(e.fn);
    for (const a of e.args) collectCalls(a, into);
    return;
  }
  switch (e.kind) {
    case "add":
      for (const t of e.terms) collectCalls(t, into);
      break;
    case "mul":
      for (const f of e.factors) collectCalls(f, into);
      break;
    case "pow":
      collectCalls(e.base, into);
      collectCalls(e.exp, into);
      break;
    default:
      break;
  }
}

/**
 * Kahn's algorithm, with everything left over reported as cyclic.
 *
 * A cycle is data, not an exception: the rows involved get a diagnostic and the rest of
 * the document keeps working.
 */
export function topologicalOrder(
  ids: readonly RowId[],
  dependencies: ReadonlyMap<RowId, ReadonlySet<RowId>>,
): { order: RowId[]; cyclic: Set<RowId> } {
  const remaining = new Map<RowId, Set<RowId>>();
  for (const id of ids) {
    remaining.set(id, new Set(dependencies.get(id) ?? []));
  }

  const order: RowId[] = [];
  let progress = true;
  while (progress) {
    progress = false;
    for (const id of ids) {
      const pending = remaining.get(id);
      if (!pending) continue;
      if (pending.size > 0) continue;
      order.push(id);
      remaining.delete(id);
      for (const other of remaining.values()) other.delete(id);
      progress = true;
    }
  }

  return { order, cyclic: new Set(remaining.keys()) };
}

type PushDiagnostic = (id: RowId, diag: Diagnostic) => void;

/**
 * Decide what a row is, and inline it.
 *
 * The rules follow do Carmo's variable conventions. Inference is a default rather than a
 * cage — an explicit per-row type override belongs in the UI — but these cover the shapes
 * the book actually uses.
 */
function classify(
  rowId: RowId,
  parsed: ParsedRow,
  values: ReadonlyMap<string, Expr>,
  functions: ReadonlyMap<string, UserFunction>,
  push: PushDiagnostic,
): Item | null {
  const locals = new Set(localNames(parsed));

  // A function declaration is published for other rows rather than drawn itself.
  if (parsed.kind === "function" && parsed.args.length > 0) {
    const keep = new Set(parsed.args);
    const inlined = inlineDefinitions(parsed.body, { values, functions, keep });
    if (!inlined.expr) {
      push(rowId, inlineError(inlined.failure));
      return null;
    }
    // z = f(x,y) style graphs are `function` rows too; distinguish by the argument names.
    const isGraph =
      parsed.args.length === 2 &&
      parsed.args.every((a) => (AMBIENT_VARS as readonly string[]).includes(a));
    if (isGraph) {
      return graphItem(rowId, parsed.name, parsed.args, inlined.expr, keep);
    }
    return {
      rowId,
      kind: "functionDefinition",
      name: parsed.name,
      vars: parsed.args,
      comps: [inlined.expr],
      params: remainingParams(inlined.expr, keep, values, functions),
    };
  }

  const keepBase = new Set<string>(locals);
  const inlineAll = (exprs: readonly Expr[]): Expr[] | null => {
    const out: Expr[] = [];
    for (const e of exprs) {
      const inlined = inlineDefinitions(e, { values, functions, keep: keepBase });
      if (!inlined.expr) {
        push(rowId, inlineError(inlined.failure));
        return null;
      }
      out.push(inlined.expr);
    }
    return out;
  };

  switch (parsed.kind) {
    case "value": {
      const comps = inlineAll([parsed.body]);
      if (!comps) return null;
      const free = freeVars(comps[0]!);

      // `z = x² − y²` declares a name but is really a graph surface.
      if (parsed.name === "z" && free.every((n) => n === "x" || n === "y")) {
        return graphItem(rowId, parsed.name, ["x", "y"], comps[0]!, new Set(["x", "y"]));
      }
      // A plain number becomes a parameter rather than a constant to inline. `R = 2` is
      // something the user will want to drag, and keeping it symbolic downstream is what
      // makes dragging it cost nothing.
      if (comps[0]!.kind === "num") {
        return {
          rowId,
          kind: "parameter",
          name: parsed.name,
          vars: [],
          comps,
          params: [],
        };
      }
      return {
        rowId,
        kind: "scalar",
        name: parsed.name,
        vars: [],
        comps,
        params: remainingParams(comps[0]!, new Set(), values, functions),
      };
    }

    case "vectorFunction": {
      const comps = inlineAll(parsed.comps);
      if (!comps) return null;
      const vars = parsed.args;
      const keep = new Set(vars);
      const params = paramsOf(comps, keep, values, functions);

      if (vars.length === 1 && comps.length === 3) {
        return { rowId, kind: "spaceCurve", name: parsed.name, vars, comps, params };
      }
      if (vars.length === 1 && comps.length === 2) {
        return { rowId, kind: "planeCurve", name: parsed.name, vars, comps, params };
      }
      if (vars.length === 2 && comps.length === 3) {
        return {
          rowId,
          kind: "parametricSurface",
          name: parsed.name,
          vars,
          comps,
          params,
        };
      }
      if (vars.length === 3 && comps.length === 3) {
        return { rowId, kind: "vectorField", name: parsed.name, vars, comps, params };
      }
      push(
        rowId,
        error(
          "E_CLASSIFY",
          `${parsed.name} has ${vars.length} parameter(s) and ${comps.length} ` +
            `component(s), which is not a curve, surface or field`,
        ),
      );
      return null;
    }

    case "equation": {
      // Move everything to one side: F = lhs − rhs, whose zero set is the object.
      const comps = inlineAll([parsed.lhs, parsed.rhs]);
      if (!comps) return null;
      const free = new Set([...freeVars(comps[0]!), ...freeVars(comps[1]!)]);
      const ambient = [...free].filter((n) =>
        (AMBIENT_VARS as readonly string[]).includes(n),
      );
      const keep = new Set(ambient);
      const kind: ItemKind = ambient.includes("z")
        ? "implicitSurface"
        : "implicitPlaneCurve";
      return {
        rowId,
        kind,
        name: null,
        vars: ambient.sort(),
        comps,
        params: paramsOf(comps, keep, values, functions),
      };
    }

    case "tuple": {
      const comps = inlineAll(parsed.comps);
      if (!comps) return null;
      const free = new Set(comps.flatMap((c) => freeVars(c)));
      if (free.has(CURVE_VAR)) {
        return {
          rowId,
          kind: comps.length === 2 ? "planeCurve" : "spaceCurve",
          name: null,
          vars: [CURVE_VAR],
          comps,
          params: paramsOf(comps, new Set([CURVE_VAR]), values, functions),
        };
      }
      if (SURFACE_VARS.some((v) => free.has(v))) {
        return {
          rowId,
          kind: "parametricSurface",
          name: null,
          vars: [...SURFACE_VARS],
          comps,
          params: paramsOf(comps, new Set(SURFACE_VARS), values, functions),
        };
      }
      return {
        rowId,
        kind: "point",
        name: null,
        vars: [],
        comps,
        params: paramsOf(comps, new Set(), values, functions),
      };
    }

    case "expr": {
      const comps = inlineAll([parsed.body]);
      if (!comps) return null;
      return {
        rowId,
        kind: "scalar",
        name: null,
        vars: [],
        comps,
        params: remainingParams(comps[0]!, new Set(), values, functions),
      };
    }

    case "function":
      // Unreachable in practice: the parser rejects an empty parameter list, so a
      // `function` row always has at least one argument and was handled above. Stated
      // explicitly rather than left to a default, so that adding a ParsedRow variant is a
      // type error here instead of a silent fall-through.
      push(rowId, error("E_CLASSIFY", `${parsed.name} needs at least one parameter`));
      return null;
  }
}

function graphItem(
  rowId: RowId,
  name: string | null,
  args: readonly string[],
  body: Expr,
  keep: ReadonlySet<string>,
): Item {
  return {
    rowId,
    kind: "graphSurface",
    name,
    vars: args,
    comps: [body],
    params: remainingParams(body, keep, new Map(), new Map()),
  };
}

/** Free names that are neither bound variables nor defined elsewhere. */
function remainingParams(
  e: Expr,
  keep: ReadonlySet<string>,
  values: ReadonlyMap<string, Expr>,
  functions: ReadonlyMap<string, UserFunction>,
): string[] {
  return freeVars(e).filter(
    (name) => !keep.has(name) && !values.has(name) && !functions.has(name),
  );
}

function paramsOf(
  exprs: readonly Expr[],
  keep: ReadonlySet<string>,
  values: ReadonlyMap<string, Expr>,
  functions: ReadonlyMap<string, UserFunction>,
): string[] {
  const names = new Set<string>();
  for (const e of exprs) {
    for (const name of remainingParams(e, keep, values, functions)) names.add(name);
  }
  return [...names].sort();
}

function inlineError(failure: InlineFailure | null): Diagnostic {
  if (!failure) return error("E_TOO_COMPLEX", "this row could not be expanded");
  switch (failure.kind) {
    case "depth":
      return error(
        "E_TOO_COMPLEX",
        `definitions nest too deeply around "${failure.name}"`,
      );
    case "arity":
      return error(
        "E_ARITY",
        `${failure.name} takes ${failure.expected} argument(s), but ${failure.got} were given`,
      );
    case "size":
      return error(
        "E_TOO_COMPLEX",
        `this expands to more than ${failure.nodes} terms — try simplifying it`,
      );
  }
}
