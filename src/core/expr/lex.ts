/**
 * Tokenizer.
 *
 * ## The central tension
 *
 * Users expect `uv` to mean u·v (implicit multiplication) *and* `theta` to mean one
 * variable, not θ·h·e·t·a. Those two expectations are in direct conflict, and every
 * plain-text math parser has to pick a rule.
 *
 * The rule here: an identifier is **one character**, unless it greedily matches a name
 * from a known set — the built-in functions, the spelled-out Greek letters, and the
 * constants. So `uv` lexes as two variables, `theta` as one, and `Rcos v` as
 * `R · cos(v)`. This is the same compromise Desmos makes, and it is what lets surface
 * parametrizations be typed the way they are written in do Carmo.
 *
 * Subscripts are part of a name: `k_1` and `k_2` are single variables, which matters
 * because the principal curvatures are called exactly that.
 *
 * ## Deliberate omissions
 *
 * `e` is **not** reserved for Euler's number. In do Carmo, `e, f, g` are the
 * coefficients of the second fundamental form, and shadowing `e` would be a constant
 * irritation for the sake of a constant that `exp(1)` already expresses.
 *
 * `tau` is **not** reserved for 2π either — τ is torsion throughout Chapter 1.
 *
 * `|x|` bars are not supported; `abs(x)` is. Bars are genuinely ambiguous to parse
 * (there is no distinct open and close form) and the payoff is small.
 */

import { FN_NAMES } from "./fns.ts";

export type TokenKind =
  | "num"
  | "name"
  | "plus"
  | "minus"
  | "star"
  | "slash"
  | "caret"
  | "lparen"
  | "rparen"
  | "comma"
  | "equals"
  | "eof";

export interface Token {
  readonly kind: TokenKind;
  /** source text of the token; for `num`, the literal as written */
  readonly text: string;
  /** parsed value, `num` tokens only */
  readonly value?: number;
  /** byte offsets into the source, half-open, for diagnostic spans */
  readonly start: number;
  readonly end: number;
}

/** Spelled-out Greek letters, lexed as single variables. */
const GREEK_WORDS = [
  "alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota",
  "kappa", "lambda", "mu", "nu", "xi", "omicron", "rho", "sigma", "tau", "upsilon",
  "phi", "chi", "psi", "omega",
  "Gamma", "Delta", "Theta", "Lambda", "Xi", "Pi", "Sigma", "Phi", "Psi", "Omega",
] as const;

/** Single-codepoint Greek, accepted directly so pasted formulas work. */
const GREEK_CHARS = "αβγδεζηθικλμνξορστυφχψωΓΔΘΛΞΠΣΦΨΩ";

/** Names that lex as numeric literals rather than variables. */
const CONSTANTS = new Map<string, number>([
  ["pi", Math.PI],
  ["π", Math.PI],
]);

export interface LexOptions {
  /**
   * Multi-character names to match greedily. Defaults to the built-in function table;
   * the document layer extends it with user-declared function and variable names so
   * that `radius` can be one variable once the user has declared it.
   */
  readonly knownNames?: readonly string[];
}

export interface LexResult {
  readonly tokens: readonly Token[];
  /** offsets where an unrecognized character was skipped */
  readonly errors: ReadonlyArray<{ start: number; end: number; message: string }>;
}

const SIMPLE: ReadonlyMap<string, TokenKind> = new Map([
  ["+", "plus"],
  ["-", "minus"],
  ["*", "star"],
  ["/", "slash"],
  ["^", "caret"],
  ["(", "lparen"],
  [")", "rparen"],
  [",", "comma"],
  ["=", "equals"],
]);

const isDigit = (ch: string) => ch >= "0" && ch <= "9";
const isAsciiLetter = (ch: string) =>
  (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z");
const isGreekChar = (ch: string) => GREEK_CHARS.includes(ch);
const isLetter = (ch: string) => isAsciiLetter(ch) || isGreekChar(ch);

/**
 * Unicode minus signs and multiplication crosses that arrive from copy-pasted text.
 * Normalizing them is a one-line courtesy that removes a baffling class of error.
 */
const NORMALIZE: ReadonlyMap<string, string> = new Map([
  ["−", "-"], // minus sign
  ["–", "-"], // en dash
  ["—", "-"], // em dash
  ["×", "*"], // multiplication sign
  ["·", "*"], // middle dot
  ["⋅", "*"], // dot operator
  ["∗", "*"], // asterisk operator
  ["⁄", "/"], // fraction slash
  ["÷", "/"], // division sign
  ["（", "("],
  ["）", ")"],
]);

export function lex(source: string, options: LexOptions = {}): LexResult {
  const tokens: Token[] = [];
  const errors: Array<{ start: number; end: number; message: string }> = [];

  // Longest match first, so `sinh` wins over `sin` and `theta` over `t`.
  const names = [
    ...(options.knownNames ?? FN_NAMES),
    ...GREEK_WORDS,
    ...CONSTANTS.keys(),
  ].sort((a, b) => b.length - a.length || a.localeCompare(b));

  let i = 0;
  const n = source.length;

  while (i < n) {
    const raw = source[i]!;
    const ch = NORMALIZE.get(raw) ?? raw;

    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i++;
      continue;
    }

    const simple = SIMPLE.get(ch);
    if (simple) {
      tokens.push({ kind: simple, text: ch, start: i, end: i + 1 });
      i++;
      continue;
    }

    if (isDigit(ch) || (ch === "." && isDigit(source[i + 1] ?? ""))) {
      const start = i;
      while (i < n && isDigit(source[i]!)) i++;
      if (source[i] === ".") {
        i++;
        while (i < n && isDigit(source[i]!)) i++;
      }
      // Scientific notation only when digits genuinely follow, so that `2e` stays
      // `2 · e` — `e` being an ordinary variable here (see the header).
      if (source[i] === "e" || source[i] === "E") {
        const afterE = source[i + 1] ?? "";
        const afterSign = source[i + 2] ?? "";
        if (isDigit(afterE) || ((afterE === "+" || afterE === "-") && isDigit(afterSign))) {
          i += afterE === "+" || afterE === "-" ? 2 : 1;
          while (i < n && isDigit(source[i]!)) i++;
        }
      }
      const text = source.slice(start, i);
      tokens.push({ kind: "num", text, value: Number(text), start, end: i });
      continue;
    }

    if (isLetter(ch)) {
      const start = i;
      let matched = "";
      for (const candidate of names) {
        if (source.startsWith(candidate, i)) {
          matched = candidate;
          break;
        }
      }
      if (matched === "") matched = ch;
      i += matched.length;

      // A subscript binds into the name: `k_1`, `k_2`, `a_{max}`.
      if (source[i] === "_") {
        const subStart = i;
        i++;
        if (source[i] === "{") {
          const close = source.indexOf("}", i);
          if (close < 0) {
            errors.push({ start: subStart, end: i, message: "unclosed subscript brace" });
            i = n;
          } else {
            matched += source.slice(subStart, close + 1);
            i = close + 1;
          }
        } else {
          const runStart = i;
          while (i < n && (isDigit(source[i]!) || isAsciiLetter(source[i]!))) i++;
          if (i === runStart) {
            errors.push({ start: subStart, end: i, message: "subscript is empty" });
          } else {
            matched += source.slice(subStart, i);
          }
        }
      }

      const constant = CONSTANTS.get(matched);
      if (constant !== undefined) {
        tokens.push({ kind: "num", text: matched, value: constant, start, end: i });
      } else {
        tokens.push({ kind: "name", text: matched, start, end: i });
      }
      continue;
    }

    errors.push({ start: i, end: i + 1, message: `unexpected character ${JSON.stringify(raw)}` });
    i++;
  }

  tokens.push({ kind: "eof", text: "", start: n, end: n });
  return { tokens, errors };
}

export { GREEK_WORDS, CONSTANTS };
