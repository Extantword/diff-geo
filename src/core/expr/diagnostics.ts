/**
 * Diagnostics for user input.
 *
 * `src/core` never throws on anything the user typed. Parsing, resolution and
 * compilation all return values plus diagnostics, so a half-typed formula can never
 * unwind through the render loop. Internal invariant violations may still throw —
 * those are bugs, not input.
 */

export type Severity = "error" | "warning" | "hint";

export type DiagCode =
  // parse
  | "E_PARSE"
  | "E_UNEXPECTED"
  | "E_UNCLOSED"
  | "E_ARITY"
  | "E_RESERVED"
  | "E_EMPTY"
  | "E_BAD_ARGUMENT"
  | "E_NESTED_TUPLE"
  // resolution (M2)
  | "E_UNDEF_SYMBOL"
  | "E_CYCLE"
  | "E_DUPLICATE"
  | "E_RECURSION"
  // compilation
  | "E_TOO_COMPLEX"
  | "E_CLASSIFY"
  // advisory
  | "W_AMBIGUOUS_IMPLICIT_MUL"
  | "W_DOMAIN"
  | "H_PARENTHESIZE"
  | "H_ADD_SLIDER";

/** Half-open offsets into the row's source text. */
export type Span = readonly [number, number];

export interface Diagnostic {
  readonly severity: Severity;
  readonly code: DiagCode;
  readonly message: string;
  readonly span?: Span;
}

export function error(code: DiagCode, message: string, span?: Span): Diagnostic {
  return { severity: "error", code, message, span };
}

export function warning(code: DiagCode, message: string, span?: Span): Diagnostic {
  return { severity: "warning", code, message, span };
}

export function hint(code: DiagCode, message: string, span?: Span): Diagnostic {
  return { severity: "hint", code, message, span };
}

export function hasErrors(diags: readonly Diagnostic[]): boolean {
  return diags.some((d) => d.severity === "error");
}
