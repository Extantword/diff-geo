import { Ctx, ctx as defaultCtx, type Expr } from "./ast.ts";
import { lookupFn } from "./fns.ts";
import {
  error,
  hint,
  warning,
  type Diagnostic,
  type Span,
} from "./diagnostics.ts";
import { lex, type Token, type TokenKind } from "./lex.ts";

/**
 * Pratt parser for the plain-text formula language.
 *
 * ## Binding powers
 *
 * ```
 *   +  -                       10   left
 *   *  /                       20   left
 *   implicit multiplication    25   left      (tighter than / — see below)
 *   unary -                    30   prefix
 *   ^                          40   right
 * ```
 *
 * `-x^2` parses as `−(x²)` and `2^-x` and `2^3^2` both work, because `^` binds tighter
 * than unary minus while `^`'s right operand is parsed down at the unary level.
 *
 * ## Implicit multiplication binds tighter than division
 *
 * So `1/2u` is `1/(2u)`, not `(1/2)u`. This follows how `1/2π` is universally read on
 * paper, but it genuinely surprises programmers, so the parser **emits a warning**
 * whenever an implicit product is absorbed into a denominator. Picking a convention
 * silently is the thing to avoid; picking one and saying so is fine.
 *
 * ## Bare function arguments, and the `cos u cos v` problem
 *
 * A function applied without parentheses takes a *maximal run of implicitly multiplied
 * atoms, stopping at the next function name*. That one rule resolves the conflict
 * between the two readings people expect:
 *
 * ```
 *   sin 2u          →  sin(2u)          not sin(2)·u
 *   cos u cos v     →  cos(u)·cos(v)    not cos(u·cos(v))
 *   (2 + cos u)cos v → (2 + cos u)·cos v
 * ```
 *
 * Both are common in do Carmo's parametrizations — the second especially, since every
 * surface of revolution looks like it — and a rule that only handles one of them would
 * silently misparse real input.
 *
 * `sin^2 u` is accepted as `(sin u)²`, the standard abuse of notation.
 */

const BP_ADD = 10;
const BP_MUL = 20;
const BP_IMPLICIT = 25;
const BP_UNARY = 30;
const BP_POW = 40;

/** Thrown internally to abort a parse; never escapes this module. */
class ParseAbort extends Error {}

export interface ParseOptions {
  /** interning context; defaults to the shared one */
  readonly ctx?: Ctx;
  /**
   * Names to treat as functions in addition to the built-ins — user-declared functions
   * from other rows, once the document layer exists.
   */
  readonly userFunctions?: ReadonlySet<string>;
  /** Multi-character names the lexer should match greedily. */
  readonly knownNames?: readonly string[];
}

export interface ParseResult {
  /** null when parsing failed; diagnostics then explain why */
  readonly expr: Expr | null;
  readonly diags: readonly Diagnostic[];
}

class Parser {
  private pos = 0;
  private readonly diags: Diagnostic[] = [];
  /**
   * Where implicit multiplications were consumed, with the parenthesis nesting depth
   * at the time. The depth matters: `1/(2u)` is unambiguous precisely because the
   * implicit product is bracketed, so only a product at the *same* depth as the
   * division is worth warning about.
   */
  private readonly implicitAt: Array<{ start: number; depth: number }> = [];
  private parenDepth = 0;

  constructor(
    private readonly tokens: readonly Token[],
    private readonly c: Ctx,
    private readonly userFunctions: ReadonlySet<string>,
  ) {}

  get diagnostics(): readonly Diagnostic[] {
    return this.diags;
  }

  private peek(offset = 0): Token {
    const t = this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)];
    // The token stream always ends with `eof`, so this is total.
    return t!;
  }

  private next(): Token {
    const t = this.peek();
    if (t.kind !== "eof") this.pos++;
    return t;
  }

  private at(kind: TokenKind): boolean {
    return this.peek().kind === kind;
  }

  private expect(kind: TokenKind, what: string): Token {
    if (!this.at(kind)) {
      const t = this.peek();
      this.fail(
        error(
          kind === "rparen" ? "E_UNCLOSED" : "E_UNEXPECTED",
          `expected ${what}${t.kind === "eof" ? " but the formula ended" : ` but found "${t.text}"`}`,
          [t.start, t.end],
        ),
      );
    }
    return this.next();
  }

  private fail(diag: Diagnostic): never {
    this.diags.push(diag);
    throw new ParseAbort(diag.message);
  }

  private isFunctionName(name: string): boolean {
    return lookupFn(name) !== undefined || this.userFunctions.has(name);
  }

  /** True when the current token could begin an atom — the implicit-product test. */
  private startsAtom(): boolean {
    switch (this.peek().kind) {
      case "num":
      case "name":
      case "lparen":
        return true;
      default:
        return false;
    }
  }

  private nextIsFunctionName(): boolean {
    const t = this.peek();
    return t.kind === "name" && this.isFunctionName(t.text);
  }

  parseExpression(minBp: number): Expr {
    let left = this.parsePrefix();

    for (;;) {
      const t = this.peek();

      // Explicit infix operators.
      if (t.kind === "plus" && BP_ADD >= minBp) {
        this.next();
        left = this.c.add(left, this.parseExpression(BP_ADD + 1));
        continue;
      }
      if (t.kind === "minus" && BP_ADD >= minBp) {
        this.next();
        left = this.c.sub(left, this.parseExpression(BP_ADD + 1));
        continue;
      }
      if (t.kind === "star" && BP_MUL >= minBp) {
        this.next();
        left = this.c.mul(left, this.parseExpression(BP_MUL + 1));
        continue;
      }
      if (t.kind === "slash" && BP_MUL >= minBp) {
        this.next();
        const before = this.implicitAt.length;
        const depth = this.parenDepth;
        const denominator = this.parseExpression(BP_MUL + 1);
        // Warn only for an unbracketed implicit product directly in the denominator:
        // `1/2u` is the ambiguous reading, `1/(2u)` is the user being explicit.
        const swallowed = this.implicitAt
          .slice(before)
          .find((entry) => entry.depth === depth);
        if (swallowed) {
          this.diags.push(
            warning(
              "W_AMBIGUOUS_IMPLICIT_MUL",
              "implicit multiplication binds tighter than division, so this reads as " +
                "a single denominator — add parentheses to be explicit",
              [t.start, swallowed.start],
            ),
          );
        }
        left = this.c.div(left, denominator);
        continue;
      }
      if (t.kind === "caret" && BP_POW >= minBp) {
        this.next();
        // Right operand at the unary level: makes `^` right-associative and lets
        // `2^-x` parse.
        left = this.c.pow(left, this.parseExpression(BP_UNARY));
        continue;
      }

      // Implicit multiplication.
      if (BP_IMPLICIT >= minBp && this.startsAtom()) {
        this.implicitAt.push({ start: t.start, depth: this.parenDepth });
        left = this.c.mul(left, this.parseExpression(BP_IMPLICIT + 1));
        continue;
      }

      return left;
    }
  }

  private parsePrefix(): Expr {
    const t = this.peek();
    if (t.kind === "minus") {
      this.next();
      return this.c.neg(this.parseExpression(BP_UNARY));
    }
    if (t.kind === "plus") {
      this.next();
      return this.parseExpression(BP_UNARY);
    }
    return this.parseAtom();
  }

  /** An atom, plus any `^` exponent bound directly to it. */
  private parseTightFactor(): Expr {
    let base = this.parseAtom();
    if (this.at("caret")) {
      this.next();
      base = this.c.pow(base, this.parseExpression(BP_UNARY));
    }
    return base;
  }

  private parseAtom(): Expr {
    const t = this.peek();

    switch (t.kind) {
      case "num":
        this.next();
        return this.c.num(t.value ?? Number(t.text));

      case "lparen": {
        this.next();
        this.parenDepth++;
        const inner = this.parseExpression(0);
        if (this.at("comma")) {
          const comma = this.peek();
          this.fail(
            error(
              "E_NESTED_TUPLE",
              "a tuple can only appear as the whole right-hand side, not inside an expression",
              [comma.start, comma.end],
            ),
          );
        }
        this.expect("rparen", "a closing parenthesis");
        this.parenDepth--;
        return inner;
      }

      case "name": {
        this.next();
        if (this.isFunctionName(t.text)) return this.parseCall(t);
        return this.c.variable(t.text);
      }

      default:
        this.fail(
          error(
            t.kind === "eof" ? "E_PARSE" : "E_UNEXPECTED",
            t.kind === "eof"
              ? "the formula is incomplete"
              : `"${t.text}" cannot start a term here`,
            [t.start, t.end],
          ),
        );
    }
  }

  /** A function application; `head` is the already-consumed name token. */
  private parseCall(head: Token): Expr {
    const def = lookupFn(head.text);
    const arity = def?.arity ?? 1;

    // `sin^2 u` — the exponent is written on the function, applied to the result.
    let outerExponent: Expr | null = null;
    if (this.at("caret")) {
      this.next();
      outerExponent = this.parseExpression(BP_UNARY);
    }

    let args: Expr[];
    if (this.at("lparen")) {
      this.next();
      this.parenDepth++;
      args = [];
      if (!this.at("rparen")) {
        args.push(this.parseExpression(0));
        while (this.at("comma")) {
          this.next();
          args.push(this.parseExpression(0));
        }
      }
      this.expect("rparen", "a closing parenthesis");
      this.parenDepth--;
    } else {
      // Bare application: the maximal run of implicitly multiplied atoms, stopping at
      // the next function name so that `cos u cos v` is a product of two cosines.
      if (!this.startsAtom()) {
        this.fail(
          error(
            "E_BAD_ARGUMENT",
            `${head.text} needs an argument`,
            [head.start, this.peek().end],
          ),
        );
      }
      const factors: Expr[] = [this.parseTightFactor()];
      while (this.startsAtom() && !this.nextIsFunctionName()) {
        factors.push(this.parseTightFactor());
      }
      args = [this.c.mul(...factors)];
      if (arity > 1) {
        this.fail(
          error(
            "E_ARITY",
            `${head.text} takes ${arity} arguments, so it needs parentheses: ` +
              `${head.text}(…, …)`,
            [head.start, this.peek().end],
          ),
        );
      }
    }

    if (def && args.length !== def.arity) {
      this.fail(
        error(
          "E_ARITY",
          `${head.text} takes ${def.arity} argument${def.arity === 1 ? "" : "s"}, ` +
            `but ${args.length} were given`,
          [head.start, this.peek().end],
        ),
      );
    }

    const applied = this.c.call(def?.name ?? head.text, ...args);
    return outerExponent ? this.c.pow(applied, outerExponent) : applied;
  }

  atEnd(): boolean {
    return this.at("eof");
  }

  currentToken(): Token {
    return this.peek();
  }

  /**
   * Consume a comma-separated list of expressions, for a tuple right-hand side.
   *
   * A component may carry a **label**: `X(u,v) = (x = R cos u, y = R sin u, z = v)`. The label is
   * the coordinate the component defines, which is information the reader already has from the
   * position — so it is dropped rather than stored. It exists because a three-line surface with
   * its coordinates named is far easier to read and edit than three anonymous expressions
   * separated by commas, and because that is how such a map is written on paper.
   */
  parseCommaList(): Expr[] {
    const parts: Expr[] = [this.parseComponent()];
    while (this.at("comma")) {
      this.next();
      parts.push(this.parseComponent());
    }
    return parts;
  }

  /** One tuple component, with an optional `name =` label in front of it. */
  private parseComponent(): Expr {
    // Only `identifier =` counts as a label. Anything else beginning with an identifier is an
    // ordinary expression, and `x == y` is not a thing here, so one token of lookahead is enough.
    if (this.peek().kind === "name" && this.tokens[this.pos + 1]?.kind === "equals") {
      this.next();
      this.next();
    }
    return this.parseExpression(0);
  }

  /** Index of the `)` matching the `(` at `open`, or −1 if unbalanced. */
  private matchingRparen(open: number): number {
    let depth = 0;
    for (let i = open; i < this.tokens.length; i++) {
      const kind = this.tokens[i]!.kind;
      if (kind === "lparen") depth++;
      else if (kind === "rparen") {
        depth--;
        if (depth === 0) return i;
      }
    }
    return -1;
  }

  /** True if a comma sits at the outermost depth between `from` and `to`. */
  private hasTopLevelComma(from: number, to: number): boolean {
    let depth = 0;
    for (let i = from; i < to; i++) {
      const kind = this.tokens[i]!.kind;
      if (kind === "lparen") depth++;
      else if (kind === "rparen") depth--;
      else if (kind === "comma" && depth === 0) return true;
    }
    return false;
  }

  /**
   * A row body: either a bare expression or a tuple.
   *
   * A tuple is normally written with enclosing parentheses — `(cos t, sin t, t/3)` —
   * so those are unwrapped to expose the comma list. The unwrap is guarded on the
   * parenthesis enclosing the *whole* body and actually containing a top-level comma,
   * which is what keeps `(u+1)(v+1)` from being mistaken for a tuple.
   */
  parseRowBody(): Expr[] {
    if (this.at("lparen")) {
      const close = this.matchingRparen(this.pos);
      if (
        close >= 0 &&
        this.tokens[close + 1]?.kind === "eof" &&
        this.hasTopLevelComma(this.pos + 1, close)
      ) {
        this.next();
        this.parenDepth++;
        const parts = this.parseCommaList();
        this.expect("rparen", "a closing parenthesis");
        this.parenDepth--;
        return parts;
      }
    }
    return this.parseCommaList();
  }
}

// --------------------------------------------------------------------------- //
// public entry points
// --------------------------------------------------------------------------- //

function build(source: string, options: ParseOptions) {
  const c = options.ctx ?? defaultCtx;
  const { tokens, errors } = lex(source, { knownNames: options.knownNames });
  const parser = new Parser(tokens, c, options.userFunctions ?? new Set());
  const lexDiags: Diagnostic[] = errors.map((e) =>
    error("E_PARSE", e.message, [e.start, e.end]),
  );
  return { c, parser, lexDiags };
}

/** Parse a single expression. Returns `expr: null` with diagnostics on failure. */
export function parse(source: string, options: ParseOptions = {}): ParseResult {
  const { parser, lexDiags } = build(source, options);

  if (source.trim() === "") {
    return { expr: null, diags: [...lexDiags, error("E_EMPTY", "the formula is empty")] };
  }

  try {
    const expr = parser.parseExpression(0);
    const diags = [...lexDiags, ...parser.diagnostics];
    if (!parser.atEnd()) {
      const t = parser.currentToken();
      return {
        expr: null,
        diags: [
          ...diags,
          error("E_UNEXPECTED", `unexpected "${t.text}" after a complete formula`, [
            t.start,
            t.end,
          ]),
        ],
      };
    }
    return { expr, diags };
  } catch (e) {
    if (e instanceof ParseAbort) {
      return { expr: null, diags: [...lexDiags, ...parser.diagnostics] };
    }
    throw e;
  }
}

export type ParsedRow =
  /** `a = 2` */
  | { readonly kind: "value"; readonly name: string; readonly body: Expr }
  /** `f(x, y) = …` with a scalar body */
  | {
      readonly kind: "function";
      readonly name: string;
      readonly args: readonly string[];
      readonly body: Expr;
    }
  /** `X(u, v) = (…, …, …)` */
  | {
      readonly kind: "vectorFunction";
      readonly name: string;
      readonly args: readonly string[];
      readonly comps: readonly Expr[];
    }
  /** `x² + y² + z² = 1` — becomes an implicit surface as `lhs − rhs` */
  | { readonly kind: "equation"; readonly lhs: Expr; readonly rhs: Expr }
  /**
   * `X: VectorField(a, b, c)` — a vector field along a patch, in ambient components.
   *
   * The components are functions of the patch's u and v; whether the vector they make is tangent
   * to the surface is measured rather than assumed.
   */
  | {
      readonly kind: "surfaceField";
      readonly comps: readonly Expr[];
      /** the patch it lives on, or null when the row names none */
      readonly surface: string | null;
    }
  /** `T_(u₀, v₀) X` — the tangent plane to X at a point of X's chart */
  | {
      readonly kind: "tangentPlane";
      /**
       * Where, in **chart** coordinates, as expressions rather than numbers.
       *
       * `T_(a, 0) X` then slides the plane along the surface as `a` is dragged, for free: the
       * coordinates go through the same parameter slots everything else does.
       */
      readonly at: readonly [Expr, Expr];
      /** the patch it is tangent to, or null when the row names none */
      readonly surface: string | null;
    }
  /**
   * `A = AmbientSpace` — a copy of R³ to build things in.
   *
   * Recognized **before lexing**, like every other row form, because `AmbientSpace` on the right
   * of an `=` would otherwise lex as a product of twelve single-letter variables. A space declares
   * nothing but its name, which is the point of it: what it holds is every row whose scope names
   * it, and that is written in those rows rather than listed here.
   */
  | { readonly kind: "ambientSpace"; readonly name: string }
  /** a bare `(1, 2, 3)` */
  | { readonly kind: "tuple"; readonly comps: readonly Expr[] }
  /** a bare expression */
  | { readonly kind: "expr"; readonly body: Expr };

export interface ParseRowResult {
  readonly row: ParsedRow | null;
  readonly diags: readonly Diagnostic[];
  /**
   * The chart this row is stated in, from a `X:` prefix.
   *
   * `X: (u − a)² + (v − b)² = 1` is a curve in **X's** chart. Nothing in a relation between u and
   * v can say which patch's u and v those are, and with several patches on screen the first one is
   * a bad guess — so the document says it, in the row itself, where it is visible, saved with the
   * text and undone with it.
   */
  readonly host?: string;
  /**
   * The whole scope chain the row was written in, outermost first.
   *
   * `host` is its innermost segment — the chart — while this is the address: `A:sigma: u + v = 1`
   * is stated in sigma's chart **and** in A's space, and a name it mentions may be declared in
   * either. Empty for a row written at the top level.
   */
  readonly scope?: readonly string[];
}

/**
 * `A:sigma: …` — the scope a row is written in, and the rest of the row.
 *
 * `:` is this language's `.`: it names the thing a row is *inside*, and it chains as deep as the
 * document is built. `A` is an ambient space, `sigma` a chart in it, and `A:sigma: u + v = 1` is a
 * relation stated in sigma's chart, in A's space — the whole address, visible in the row, saved
 * with it and undone with it. A repeated colon is tolerated (`A:sigma::k`) because it is a natural
 * thing to type for "one level further in" and it means exactly the same path.
 *
 * The body is **blanked** rather than removed: every diagnostic carries character offsets into
 * the source the user typed, and shortening the string would slide every one of them left by the
 * length of the prefix.
 */
export function splitScope(source: string): {
  /** the segments of the prefix, outermost first: `["A", "sigma"]` */
  readonly path: readonly string[];
  /** the innermost segment — the chart a row is stated in, when there is one */
  readonly host: string | null;
  readonly body: string;
} {
  const segment = /^(\s*)([A-Za-z][A-Za-z0-9_]*)(\s*):+/;
  const path: string[] = [];
  let consumed = 0;
  for (;;) {
    const match = segment.exec(source.slice(consumed));
    if (!match) break;
    path.push(match[2]!);
    consumed += match[0].length;
  }
  if (path.length === 0) return { path, host: null, body: source };
  return {
    path,
    host: path[path.length - 1]!,
    body: " ".repeat(consumed) + source.slice(consumed),
  };
}

/**
 * The innermost scope segment alone: what most of the app means by "which chart is this in".
 *
 * Kept as its own function because that question is asked in a dozen places and none of them
 * care about the rest of the address.
 */
export function splitHost(source: string): { host: string | null; body: string } {
  const { host, body } = splitScope(source);
  return { host, body };
}

/**
 * ## Row forms: `T_(u₀, v₀) X` and `X: VectorField(a, b, c)`
 *
 * Both are peeled off the row **before lexing**, exactly like the `X:` prefix, and for a related
 * reason: neither is something the expression language can say. A subscript binds into a name in
 * the lexer (`k_1`, `a_{max}`), so `T_(1,2)` lexes as an empty subscript and reports a character
 * error pointing at a parenthesis; `VectorField(a, b, c)` lexes as a product of nine single-letter
 * variables against a tuple, which is a nested-tuple error. Both diagnostics are about tokens, for
 * rows whose *form* is the thing being written. Recognizing the forms here means each can be
 * answered in its own terms — and once a row has committed to one by opening its parenthesis, it
 * is never handed back to the expression parser to fail somewhere unrelated.
 *
 * Each names its patch **after** the closing parenthesis, `T_(1,2) X`, or with the prefix,
 * `X: T_(1,2)`. Both spellings mean one thing and both end up in `ParseRowResult.host`.
 */

/** One row form, split into its arguments and the patch it names. */
export interface RowForm {
  /**
   * The arguments as source, **blanked** outside their own slice.
   *
   * Same trick as `splitHost`: every diagnostic carries offsets into the text the user typed, so
   * the pieces keep their positions instead of being cut out and re-indexed from zero.
   */
  readonly args: readonly string[];
  /** the patch named after the closing parenthesis, or null when the row names none */
  readonly surface: string | null;
  /** where that name sits, so it can be rewritten when a patch is copied */
  readonly surfaceSpan: Span | null;
}

/** A row that begins a form but does not go on to say one. */
export interface RowFormError {
  readonly diag: Diagnostic;
}

/**
 * `A = AmbientSpace`, `A_1 = ambient space`, `A = AmbientSpace()`.
 *
 * The name may carry a subscript, because spaces are handed out as A_1, A_2, … as they are made.
 * Tested before the lexer sees the row for the reason every row form is: the right-hand side is a
 * *word*, not an expression, and letting the expression parser have it produces a diagnostic about
 * implicit multiplication for a row whose form is the thing being written.
 */
const AMBIENT_ROW =
  /^\s*([A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+|_\{[^}]*\})?)\s*=\s*ambient\s*space\s*(?:\(\s*\))?\s*$/i;

/** `A = AmbientSpace`, or null when the row is not one. */
export function splitAmbientSpace(source: string): { readonly name: string } | null {
  const match = AMBIENT_ROW.exec(source);
  return match ? { name: match[1]! } : null;
}

const TANGENT_HEAD = /^\s*T_\s*\(/;
const FIELD_HEAD = /^\s*vector\s*field\s*\(/i;
/** What may follow the arguments: one patch name, `X` or `X_2`. */
const PATCH_NAME = /^\s*([A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+|_\{[^}]*\})?)\s*$/;

/** The same text with everything outside `[start, end)` replaced by spaces. */
function blankOutside(source: string, start: number, end: number): string {
  return " ".repeat(start) + source.slice(start, end);
}

/**
 * Split `head( a, b, … ) Name`, or null when the row does not begin that head.
 *
 * `arity` is what the form needs; `shape` states the whole form in one line, for the message a
 * row gets when it has the wrong number of arguments.
 */
function splitRowForm(
  source: string,
  head: RegExp,
  arity: number,
  shape: string,
): RowForm | RowFormError | null {
  const matched = head.exec(source);
  if (!matched) return null;

  const open = matched[0].length - 1;
  let depth = 0;
  let close = -1;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close < 0) {
    return {
      diag: error("E_UNCLOSED", `this row is missing its closing parenthesis — ${shape}`, [
        open,
        source.length,
      ]),
    };
  }

  // Commas at the outermost depth only, so that `T_(f(1, 2), 0) X` splits where it is written
  // rather than inside the call.
  const cuts: number[] = [open];
  depth = 0;
  for (let i = open + 1; i < close; i++) {
    const ch = source[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) cuts.push(i);
  }
  if (cuts.length !== arity) {
    return {
      diag: error("E_ARITY", `this takes ${arity} arguments — ${shape}`, [open, close + 1]),
    };
  }
  const args = cuts.map((cut, index) =>
    blankOutside(source, cut + 1, index + 1 < cuts.length ? cuts[index + 1]! : close),
  );

  const tail = source.slice(close + 1);
  if (tail.trim() === "") return { args, surface: null, surfaceSpan: null };

  const named = PATCH_NAME.exec(tail);
  if (!named) {
    return {
      diag: error(
        "E_UNEXPECTED",
        `"${tail.trim()}" is not a patch name — ${shape}`,
        [close + 1, source.length],
      ),
    };
  }
  const start = close + 1 + tail.indexOf(named[1]!);
  return {
    args,
    surface: named[1]!,
    surfaceSpan: [start, start + named[1]!.length],
  };
}

/**
 * `T_(u₀, v₀) X` — the tangent plane to a patch at a point of its chart.
 *
 * The point is given in the chart, which is the whole content of the notation: do Carmo's tangent
 * plane is `dX_q(R²)` at `q = (u₀, v₀)`, and naming the point downstairs in the domain rather than
 * upstairs in R³ is what makes it well defined without solving anything.
 */
export function splitTangent(source: string): RowForm | RowFormError | null {
  return splitRowForm(source, TANGENT_HEAD, 2, "a tangent plane is written T_(u, v) X");
}

/**
 * `X: VectorField(a, b, c)` — a vector field along a patch, in **ambient** components.
 *
 * The three components are the vector's coordinates in the R³ the surface lives in, as functions
 * of that patch's u and v. Ambient rather than chart components because that is how a field is
 * written when it is a restriction of something defined on all of space — a rotation, a gradient,
 * a constant wind — which is most of the fields anyone wants to look at. Whether the result is
 * *tangent* is then a question with a measurable answer rather than something the notation
 * assumes, which is why the scene checks it and says so.
 */
export function splitVectorField(source: string): RowForm | RowFormError | null {
  return splitRowForm(
    source,
    FIELD_HEAD,
    3,
    "a vector field has three components in R³: VectorField(a, b, c)",
  );
}

/** Index of the first top-level `=`, or −1. */
function findTopLevelEquals(tokens: readonly Token[]): number {
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const kind = tokens[i]!.kind;
    if (kind === "lparen") depth++;
    else if (kind === "rparen") depth--;
    else if (kind === "equals" && depth === 0) return i;
  }
  return -1;
}

/**
 * Parse a whole row — a declaration, an equation, or a bare expression.
 *
 * Classification into geometric objects (curve, surface, implicit surface, …) happens
 * a layer up; this only recovers the syntactic shape.
 */
export function parseRow(source: string, options: ParseOptions = {}): ParseRowResult {
  const { path, host, body } = splitScope(source);
  const text = host === null ? source : body;
  const scope = path.length === 0 ? undefined : path;

  /**
   * A row form names its patch **after** the arguments, so the trailing name is the host and the
   * prefix is only a fallback. Both spellings mean the same thing — `T_(1,2) X` and `X: T_(1,2)`
   * are one row — which is what keeps the copy machinery, the chart inset and the placement all
   * reading a single field instead of two.
   */
  const space = splitAmbientSpace(text);
  if (space) {
    const row: ParsedRow = { kind: "ambientSpace", name: space.name };
    return host === null ? { row, diags: [], scope } : { row, diags: [], host, scope };
  }

  const form = parseTangentRow(text, options) ?? parseFieldRow(text, options);
  if (form) {
    const named =
      form.row?.kind === "tangentPlane" || form.row?.kind === "surfaceField"
        ? form.row.surface
        : null;
    const owner = named ?? host;
    // Saying it twice and differently is the one case where the two spellings disagree, so it is
    // reported rather than resolved quietly in favour of whichever the code happens to read.
    const diags =
      named !== null && host !== null && named !== host
        ? [
            ...form.diags,
            warning(
              "W_TWO_HOSTS",
              `this row names two patches — it is drawn on ${named}, and the "${host}:" prefix ` +
                `is ignored`,
            ),
          ]
        : form.diags;
    const result = { ...form, diags, scope };
    return owner === null ? result : { ...result, host: owner };
  }

  if (host === null) return parseRowBody(source, options);
  return { ...parseRowBody(body, options), host, scope };
}

/** Parse a form's arguments, keeping every diagnostic. Null if any of them failed. */
function parseFormArguments(
  form: RowForm,
  options: ParseOptions,
): { exprs: Expr[] | null; diags: Diagnostic[] } {
  const diags: Diagnostic[] = [];
  const exprs: Expr[] = [];
  let failed = false;
  for (const argument of form.args) {
    const { expr, diags: argumentDiags } = parse(argument, options);
    diags.push(...argumentDiags);
    if (expr) exprs.push(expr);
    else failed = true;
  }
  return { exprs: failed ? null : exprs, diags };
}

/** `T_(u₀, v₀) X`, or null when the row does not begin one. */
function parseTangentRow(source: string, options: ParseOptions): ParseRowResult | null {
  const head = splitTangent(source);
  if (head === null) return null;
  if ("diag" in head) return { row: null, diags: [head.diag] };

  const { exprs, diags } = parseFormArguments(head, options);
  if (!exprs) return { row: null, diags };

  return {
    row: { kind: "tangentPlane", at: [exprs[0]!, exprs[1]!], surface: head.surface },
    diags,
  };
}

/** `X: VectorField(a, b, c)`, or null when the row does not begin one. */
function parseFieldRow(source: string, options: ParseOptions): ParseRowResult | null {
  const head = splitVectorField(source);
  if (head === null) return null;
  if ("diag" in head) return { row: null, diags: [head.diag] };

  const { exprs, diags } = parseFormArguments(head, options);
  if (!exprs) return { row: null, diags };

  return { row: { kind: "surfaceField", comps: exprs, surface: head.surface }, diags };
}

function parseRowBody(source: string, options: ParseOptions = {}): ParseRowResult {
  const c = options.ctx ?? defaultCtx;
  const { tokens, errors } = lex(source, { knownNames: options.knownNames });
  const lexDiags: Diagnostic[] = errors.map((e) =>
    error("E_PARSE", e.message, [e.start, e.end]),
  );

  if (source.trim() === "") {
    return { row: null, diags: [...lexDiags, error("E_EMPTY", "the row is empty")] };
  }

  const eq = findTopLevelEquals(tokens);
  const userFunctions = options.userFunctions ?? new Set<string>();

  // No `=`: a bare expression or tuple.
  if (eq < 0) {
    const parser = new Parser(tokens, c, userFunctions);
    try {
      const comps = parser.parseRowBody();
      const diags = [...lexDiags, ...parser.diagnostics];
      if (!parser.atEnd()) {
        const t = parser.currentToken();
        return {
          row: null,
          diags: [
            ...diags,
            error("E_UNEXPECTED", `unexpected "${t.text}"`, [t.start, t.end]),
          ],
        };
      }
      return {
        row: comps.length === 1 ? { kind: "expr", body: comps[0]! } : { kind: "tuple", comps },
        diags,
      };
    } catch (e) {
      if (e instanceof ParseAbort) {
        return { row: null, diags: [...lexDiags, ...parser.diagnostics] };
      }
      throw e;
    }
  }

  const lhsTokens = tokens.slice(0, eq);
  // Re-terminate each side so the sub-parsers see a well-formed stream.
  const eofToken: Token = { kind: "eof", text: "", start: source.length, end: source.length };
  const rhsTokens = [...tokens.slice(eq + 1)];

  const declaration = matchDeclarationHead(lhsTokens, userFunctions);

  const rhsParser = new Parser(rhsTokens, c, userFunctions);
  let comps: Expr[];
  try {
    comps = rhsParser.parseRowBody();
    if (!rhsParser.atEnd()) {
      const t = rhsParser.currentToken();
      return {
        row: null,
        diags: [
          ...lexDiags,
          ...rhsParser.diagnostics,
          error("E_UNEXPECTED", `unexpected "${t.text}"`, [t.start, t.end]),
        ],
      };
    }
  } catch (e) {
    if (e instanceof ParseAbort) {
      return { row: null, diags: [...lexDiags, ...rhsParser.diagnostics] };
    }
    throw e;
  }

  const diags: Diagnostic[] = [...lexDiags, ...rhsParser.diagnostics];

  if (declaration === null) {
    // Not a declaration head, so this is an equation: move everything to one side.
    const lhsParser = new Parser([...lhsTokens, eofToken], c, userFunctions);
    try {
      const lhs = lhsParser.parseExpression(0);
      if (!lhsParser.atEnd()) {
        const t = lhsParser.currentToken();
        return {
          row: null,
          diags: [
            ...diags,
            ...lhsParser.diagnostics,
            error("E_UNEXPECTED", `unexpected "${t.text}" on the left of "="`, [
              t.start,
              t.end,
            ]),
          ],
        };
      }
      if (comps.length !== 1) {
        return {
          row: null,
          diags: [
            ...diags,
            error("E_NESTED_TUPLE", "an equation cannot have a tuple on one side"),
          ],
        };
      }
      return {
        row: { kind: "equation", lhs, rhs: comps[0]! },
        diags: [...diags, ...lhsParser.diagnostics],
      };
    } catch (e) {
      if (e instanceof ParseAbort) {
        return { row: null, diags: [...diags, ...lhsParser.diagnostics] };
      }
      throw e;
    }
  }

  if (declaration.reserved) {
    diags.push(
      error(
        "E_RESERVED",
        `"${declaration.name}" is a built-in function and cannot be redefined`,
        declaration.span,
      ),
    );
    return { row: null, diags };
  }

  if (declaration.args === null) {
    if (comps.length !== 1) {
      return {
        row: {
          kind: "vectorFunction",
          name: declaration.name,
          args: [],
          comps,
        },
        diags,
      };
    }
    return { row: { kind: "value", name: declaration.name, body: comps[0]! }, diags };
  }

  if (comps.length === 1) {
    return {
      row: {
        kind: "function",
        name: declaration.name,
        args: declaration.args,
        body: comps[0]!,
      },
      diags,
    };
  }

  return {
    row: {
      kind: "vectorFunction",
      name: declaration.name,
      args: declaration.args,
      comps,
    },
    diags,
  };
}

interface DeclarationHead {
  readonly name: string;
  /** null for a plain value declaration, otherwise the parameter names */
  readonly args: readonly string[] | null;
  readonly reserved: boolean;
  readonly span: Span;
}

/**
 * Recognize `name` or `name(a, b)` on the left of `=`. Returns null when the left side
 * is anything else, which means the row is an equation rather than a declaration.
 */
function matchDeclarationHead(
  tokens: readonly Token[],
  userFunctions: ReadonlySet<string>,
): DeclarationHead | null {
  const head = tokens[0];
  if (!head || head.kind !== "name") return null;

  const reserved = lookupFn(head.text) !== undefined;
  const span: Span = [head.start, head.end];

  if (tokens.length === 1) {
    return { name: head.text, args: null, reserved, span };
  }

  if (tokens[1]?.kind !== "lparen") return null;
  if (tokens[tokens.length - 1]?.kind !== "rparen") return null;

  const args: string[] = [];
  for (let i = 2; i < tokens.length - 1; i++) {
    const t = tokens[i]!;
    if (t.kind === "name") {
      // A parameter must be a plain name, and must not shadow a built-in function.
      if (lookupFn(t.text) !== undefined || userFunctions.has(t.text)) return null;
      args.push(t.text);
    } else if (t.kind !== "comma") {
      return null;
    }
  }
  if (args.length === 0) return null;

  return { name: head.text, args, reserved, span };
}

export { hint };
