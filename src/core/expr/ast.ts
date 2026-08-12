/**
 * The expression AST, with hash-consing.
 *
 * Every node is **interned**: constructing the same structure twice returns the
 * identical object, so structural equality is `===`. That single property is what
 * makes three later things nearly free —
 *
 *   - common-subexpression elimination (a `Map<Expr, tempVar>` needs no deep compare),
 *   - the compiled-artifact cache (a node's identity *is* its key),
 *   - round-trip property tests (`parse(print(parse(s))) === parse(s)`).
 *
 * ## Normalization
 *
 * There is no subtraction, division, or unary-minus node. `a − b` is
 * `add(a, mul(−1, b))`; `a / b` is `mul(a, pow(b, −1))`; `−a` is `mul(−1, a)`. Six
 * node kinds instead of nine, and the derivative rules shrink accordingly. The LaTeX
 * printer reconstructs the familiar forms for display.
 *
 * ## What the constructors do, and deliberately do not do
 *
 * The smart constructors below apply only **order-preserving** reductions: flattening
 * nested sums and products, folding numeric constants, and dropping identities. They
 * do **not** sort terms canonically.
 *
 * That is a deliberate split. The user's live typeset echo renders from this tree, so
 * `sin u + 2` must not silently become `2 + sin u` while they are still typing.
 * Canonical ordering and like-term collection belong to `simplify`, which is what the
 * math pipeline runs. Hence:
 *
 *     parse("u+v") !== parse("v+u")                       // different text
 *     simplify(parse("u+v")) === simplify(parse("v+u"))   // same mathematics
 *
 * ## Numbers
 *
 * Numeric literals are f64, not exact rationals. Exact rational arithmetic would give
 * `1/3 * 3 === 1`, which f64 does not, but it costs a whole numeric tower. The reason
 * it is affordable to skip: cancellation in this codebase is overwhelmingly structural
 * (`x/x`, `x − x`) rather than numeric, and the one place exactness visibly matters —
 * showing `½` instead of `0.5` — is handled by rational *detection* in the printer.
 */

export type ExprKind = "num" | "var" | "add" | "mul" | "pow" | "call";

interface ExprBase {
  /** unique within the owning Ctx; identity is structural */
  readonly id: number;
  /** 32-bit structural hash, computed at intern time */
  readonly hash: number;
  readonly kind: ExprKind;
}

export interface NumExpr extends ExprBase {
  readonly kind: "num";
  readonly value: number;
}

export interface VarExpr extends ExprBase {
  readonly kind: "var";
  readonly name: string;
}

export interface AddExpr extends ExprBase {
  readonly kind: "add";
  /** at least two terms; never contains a nested `add` */
  readonly terms: readonly Expr[];
}

export interface MulExpr extends ExprBase {
  readonly kind: "mul";
  /** at least two factors; never contains a nested `mul` */
  readonly factors: readonly Expr[];
}

export interface PowExpr extends ExprBase {
  readonly kind: "pow";
  readonly base: Expr;
  readonly exp: Expr;
}

export interface CallExpr extends ExprBase {
  readonly kind: "call";
  readonly fn: string;
  readonly args: readonly Expr[];
}

export type Expr = NumExpr | VarExpr | AddExpr | MulExpr | PowExpr | CallExpr;

// --------------------------------------------------------------------------- //
// hashing
// --------------------------------------------------------------------------- //

const FNV_PRIME = 0x01000193;

function mix(h: number, v: number): number {
  return (Math.imul(h ^ v, FNV_PRIME) >>> 0) >>> 0;
}

function hashString(h: number, s: string): number {
  let out = h;
  for (let i = 0; i < s.length; i++) out = mix(out, s.charCodeAt(i));
  return out;
}

const floatBuffer = new Float64Array(1);
const floatBits = new Uint32Array(floatBuffer.buffer);

function hashNumber(h: number, v: number): number {
  floatBuffer[0] = v;
  return mix(mix(h, floatBits[0]!), floatBits[1]!);
}

// --------------------------------------------------------------------------- //
// canonical ordering (used by simplify, never by the constructors)
// --------------------------------------------------------------------------- //

const KIND_RANK: Record<ExprKind, number> = {
  num: 0,
  var: 1,
  call: 2,
  pow: 3,
  mul: 4,
  add: 5,
};

function compareList(a: readonly Expr[], b: readonly Expr[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const c = compareExpr(a[i]!, b[i]!);
    if (c !== 0) return c;
  }
  return a.length - b.length;
}

/**
 * A total order on expressions, deterministic and **content-based**.
 *
 * Deliberately not based on `id`: ids depend on allocation order, so an id-based
 * comparison would make canonical forms — and therefore printed LaTeX and golden
 * test output — depend on what the user happened to type earlier in the session.
 */
export function compareExpr(a: Expr, b: Expr): number {
  if (a === b) return 0;
  const ra = KIND_RANK[a.kind];
  const rb = KIND_RANK[b.kind];
  if (ra !== rb) return ra - rb;

  switch (a.kind) {
    case "num":
      // NaN would make this non-transitive and corrupt any sort using it.
      return compareNumeric(a.value, (b as NumExpr).value);
    case "var":
      return a.name < (b as VarExpr).name ? -1 : a.name > (b as VarExpr).name ? 1 : 0;
    case "call": {
      const other = b as CallExpr;
      if (a.fn !== other.fn) return a.fn < other.fn ? -1 : 1;
      return compareList(a.args, other.args);
    }
    case "pow": {
      const other = b as PowExpr;
      const c = compareExpr(a.base, other.base);
      return c !== 0 ? c : compareExpr(a.exp, other.exp);
    }
    case "mul":
      return compareList(a.factors, (b as MulExpr).factors);
    case "add":
      return compareList(a.terms, (b as AddExpr).terms);
  }
}

function compareNumeric(x: number, y: number): number {
  if (Number.isNaN(x)) return Number.isNaN(y) ? 0 : 1;
  if (Number.isNaN(y)) return -1;
  return x < y ? -1 : x > y ? 1 : 0;
}

// --------------------------------------------------------------------------- //
// children
// --------------------------------------------------------------------------- //

const NO_CHILDREN: readonly Expr[] = [];

/** Direct subexpressions, in structural order. */
export function children(e: Expr): readonly Expr[] {
  switch (e.kind) {
    case "num":
    case "var":
      return NO_CHILDREN;
    case "add":
      return e.terms;
    case "mul":
      return e.factors;
    case "pow":
      return [e.base, e.exp];
    case "call":
      return e.args;
  }
}

// --------------------------------------------------------------------------- //
// the interning context
// --------------------------------------------------------------------------- //

/**
 * Owns one intern table. Tests construct isolated contexts; the app uses the shared
 * `ctx` below so that `parse` need not thread a context through every call.
 */
export class Ctx {
  private readonly table = new Map<string, Expr>();
  private nextId = 1;

  readonly zero: Expr;
  readonly one: Expr;
  readonly negOne: Expr;

  constructor() {
    this.zero = this.num(0);
    this.one = this.num(1);
    this.negOne = this.num(-1);
  }

  /** Number of distinct interned nodes — the node-budget metric. */
  get size(): number {
    return this.table.size;
  }

  private intern<T extends Expr>(key: string, build: (id: number) => T): T {
    const found = this.table.get(key);
    if (found) return found as T;
    const made = build(this.nextId++);
    this.table.set(key, made);
    return made;
  }

  num(value: number): Expr {
    // `-0` and `0` are `===` but print differently and would collide in the table;
    // normalize to `+0` so `x + (-0)` and `x + 0` cannot diverge.
    const v = value === 0 ? 0 : value;
    return this.intern(`n${v}`, (id) => ({
      kind: "num",
      id,
      hash: hashNumber(0x811c9dc5, v),
      value: v,
    }));
  }

  variable(name: string): Expr {
    return this.intern(
      `v${name}`,
      (id): VarExpr => ({
        kind: "var",
        id,
        hash: hashString(0x811c9dc5 ^ 1, name),
        name,
      }),
    );
  }

  /**
   * Sum. Flattens nested sums, folds numeric terms into one constant at the position
   * of the first numeric term, and drops an additive identity. Term order is
   * otherwise preserved — see the file header.
   */
  add(...terms: readonly Expr[]): Expr {
    const flat: Expr[] = [];
    let constant = 0;
    let constantAt = -1;

    const push = (t: Expr) => {
      if (t.kind === "add") {
        for (const sub of t.terms) push(sub);
      } else if (t.kind === "num") {
        constant += t.value;
        if (constantAt < 0) constantAt = flat.length;
      } else {
        flat.push(t);
      }
    };
    for (const t of terms) push(t);

    if (constantAt >= 0 && constant !== 0) {
      flat.splice(constantAt, 0, this.num(constant));
    } else if (flat.length === 0) {
      // Everything cancelled numerically, or there was nothing but zeros.
      return this.num(constant);
    }

    if (flat.length === 1) return flat[0]!;
    return this.internNary("+", flat, (id, hash) => ({
      kind: "add",
      id,
      hash,
      terms: flat,
    }));
  }

  /**
   * Product. Flattens nested products, folds numeric factors, and drops a
   * multiplicative identity.
   *
   * Note `0 · x → 0` is applied unconditionally. That is the standard symbolic
   * convention and it is *not* faithful to IEEE-754, where `0 · Infinity` is NaN. It
   * is the right trade here: derivative rules generate `0 · f` constantly and keeping
   * those alive would balloon every expression, whereas the non-finite contract only
   * requires that evaluation report non-finite results honestly — not that symbolic
   * simplification model IEEE edge cases.
   */
  mul(...factors: readonly Expr[]): Expr {
    const flat: Expr[] = [];
    let constant = 1;
    let constantAt = -1;

    const push = (f: Expr) => {
      if (f.kind === "mul") {
        for (const sub of f.factors) push(sub);
      } else if (f.kind === "num") {
        constant *= f.value;
        if (constantAt < 0) constantAt = flat.length;
      } else {
        flat.push(f);
      }
    };
    for (const f of factors) push(f);

    if (constant === 0) return this.zero;

    if (constantAt >= 0 && constant !== 1) {
      flat.splice(constantAt, 0, this.num(constant));
    } else if (flat.length === 0) {
      return this.num(constant);
    }

    if (flat.length === 1) return flat[0]!;
    return this.internNary("*", flat, (id, hash) => ({
      kind: "mul",
      id,
      hash,
      factors: flat,
    }));
  }

  /** Difference `a − b`, as `a + (−1)·b`. */
  sub(a: Expr, b: Expr): Expr {
    return this.add(a, this.neg(b));
  }

  /** Negation, as `(−1)·a`. */
  neg(a: Expr): Expr {
    return this.mul(this.negOne, a);
  }

  /** Quotient `a / b`, as `a · b^(−1)`. */
  div(a: Expr, b: Expr): Expr {
    return this.mul(a, this.pow(b, this.negOne));
  }

  pow(base: Expr, exp: Expr): Expr {
    if (exp.kind === "num") {
      if (exp.value === 0) return this.one; // including 0^0 = 1, by convention
      if (exp.value === 1) return base;
    }
    if (base.kind === "num" && base.value === 1) return this.one;

    if (base.kind === "num" && exp.kind === "num") {
      // Folding a negative base to a fractional power would produce NaN and destroy
      // information the user may have meant (a real cube root). Leave it symbolic and
      // let the evaluator apply its own domain policy.
      const integerExponent = Number.isInteger(exp.value);
      if (base.value >= 0 || integerExponent) {
        return this.num(Math.pow(base.value, exp.value));
      }
    }

    // (a^b)^c → a^(b·c) is only valid in general for integer b, c; for real exponents
    // it fails on negative bases, e.g. ((−1)^2)^(1/2) = 1 but (−1)^(2·1/2) = −1.
    if (base.kind === "pow") {
      const innerNum = base.exp.kind === "num" ? base.exp.value : null;
      const outerNum = exp.kind === "num" ? exp.value : null;
      if (
        innerNum !== null &&
        outerNum !== null &&
        Number.isInteger(innerNum) &&
        Number.isInteger(outerNum)
      ) {
        return this.pow(base.base, this.num(innerNum * outerNum));
      }
    }

    return this.intern(`^${base.id},${exp.id}`, (id) => ({
      kind: "pow",
      id,
      hash: mix(mix(0x811c9dc5 ^ 3, base.hash), exp.hash),
      base,
      exp,
    }));
  }

  /**
   * Function application. Arity is *not* checked here — `ast.ts` stays free of any
   * dependency on the function table, so the parser validates arity instead and can
   * report a span-anchored diagnostic rather than throwing.
   */
  call(fn: string, ...args: readonly Expr[]): Expr {
    const ids = args.map((a) => a.id).join(",");
    return this.intern(`f${fn}(${ids})`, (id) => {
      let hash = hashString(0x811c9dc5 ^ 2, fn);
      for (const a of args) hash = mix(hash, a.hash);
      return { kind: "call", id, hash, fn, args: [...args] };
    });
  }

  private internNary<T extends Expr>(
    tag: string,
    parts: readonly Expr[],
    build: (id: number, hash: number) => T,
  ): T {
    let key = tag;
    let hash = tag === "+" ? 0x811c9dc5 ^ 4 : 0x811c9dc5 ^ 5;
    for (const p of parts) {
      key += p.id + ",";
      hash = mix(hash, p.hash);
    }
    return this.intern(key, (id) => build(id, hash));
  }

  /**
   * Rebuild `e` with new children, routing through the smart constructors so the
   * result is normalized. The workhorse of `diff`, `simplify` and inlining.
   */
  rebuild(e: Expr, kids: readonly Expr[]): Expr {
    switch (e.kind) {
      case "num":
      case "var":
        return e;
      case "add":
        return this.add(...kids);
      case "mul":
        return this.mul(...kids);
      case "pow":
        return this.pow(kids[0]!, kids[1]!);
      case "call":
        return this.call(e.fn, ...kids);
    }
  }
}

/** The context the app shares. Tests wanting isolation construct `new Ctx()`. */
export const ctx = new Ctx();

export const ZERO = ctx.zero;
export const ONE = ctx.one;
export const NEG_ONE = ctx.negOne;

export const num = (v: number): Expr => ctx.num(v);
export const variable = (name: string): Expr => ctx.variable(name);
export const add = (...t: readonly Expr[]): Expr => ctx.add(...t);
export const mul = (...f: readonly Expr[]): Expr => ctx.mul(...f);
export const sub = (a: Expr, b: Expr): Expr => ctx.sub(a, b);
export const neg = (a: Expr): Expr => ctx.neg(a);
export const div = (a: Expr, b: Expr): Expr => ctx.div(a, b);
export const pow = (b: Expr, e: Expr): Expr => ctx.pow(b, e);
export const call = (fn: string, ...a: readonly Expr[]): Expr => ctx.call(fn, ...a);

// --------------------------------------------------------------------------- //
// small queries
// --------------------------------------------------------------------------- //

export function isNum(e: Expr, value?: number): e is NumExpr {
  return e.kind === "num" && (value === undefined || e.value === value);
}

export function isZero(e: Expr): boolean {
  return e.kind === "num" && e.value === 0;
}

export function isOne(e: Expr): boolean {
  return e.kind === "num" && e.value === 1;
}

/** Every distinct variable name appearing in `e`, sorted. */
export function freeVars(e: Expr): string[] {
  const seen = new Set<string>();
  const walk = (node: Expr) => {
    if (node.kind === "var") {
      seen.add(node.name);
      return;
    }
    for (const kid of children(node)) walk(kid);
  };
  walk(e);
  return [...seen].sort();
}

/**
 * Number of distinct nodes in the DAG of `e` — the node-budget metric that guards
 * against third-derivative blowup. Counts shared subexpressions once, which is the
 * honest measure of compiled size given that codegen emits CSE'd temporaries.
 */
export function nodeCount(e: Expr): number {
  const seen = new Set<number>();
  const stack: Expr[] = [e];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    for (const kid of children(node)) stack.push(kid);
  }
  return seen.size;
}

/** Depth of the DAG, following shared nodes once. Used to cap inlining recursion. */
export function depth(e: Expr): number {
  const memo = new Map<number, number>();
  const walk = (node: Expr): number => {
    const hit = memo.get(node.id);
    if (hit !== undefined) return hit;
    let best = 0;
    for (const kid of children(node)) best = Math.max(best, walk(kid));
    const result = best + 1;
    memo.set(node.id, result);
    return result;
  };
  return walk(e);
}
