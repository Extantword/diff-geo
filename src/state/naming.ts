import { parseRow, splitHost, splitTangent } from "../core/expr/parse.ts";
import { toSource } from "../core/expr/print.ts";
import type { DocumentStore } from "./graph.ts";

/**
 * Naming new objects.
 *
 * Every object a template or a copy creates used to be called `X`, so a second surface silently
 * shadowed the first: two rows declaring the same name is not two objects, it is one definition
 * overwritten. The names have to differ for the document to mean what it looks like it means.
 *
 * The orders below are conventional rather than arbitrary. Surfaces are X, Y, Z because that is
 * what do Carmo calls a parametrization; curves are the Greek letters in their usual sequence.
 * Running out of letters appends a number rather than reaching for something unfamiliar — `X2` is
 * obviously another surface, whereas the ninth letter of some private list is not.
 */

/** Preferred names for a parametrized surface, in order. */
export const SURFACE_NAMES: readonly string[] = ["X", "Y", "Z", "W", "P", "Q"];

/**
 * Preferred names for an ambient space, in order.
 *
 * `A_1`, `A_2`, … — numbered rather than lettered, because spaces are made one after another and
 * "the third space" is how anyone would refer to it, while the fifth letter of an alphabet of
 * spaces is not something a reader can count.
 */
export const SPACE_NAMES: readonly string[] = ["A_1", "A_2", "A_3", "A_4", "A_5", "A_6"];

/** Preferred names for a curve, in order. */
export const CURVE_NAMES: readonly string[] = ["alpha", "beta", "gamma", "delta", "sigma", "tau"];

/**
 * Every name the document currently declares.
 *
 * Read from the rows' own text rather than from the resolution, so it is correct even while a row
 * is mid-edit and does not yet classify as anything.
 */
export function usedNames(store: DocumentStore): Set<string> {
  const used = new Set<string>();
  for (const row of store.rows()) {
    const { row: parsed } = parseRow(row.source());
    if (parsed && "name" in parsed) {
      used.add(parsed.name);
      continue;
    }
    /**
     * A row that does not parse still owns its name.
     *
     * Otherwise a broken row is invisible to this, and the next object created takes the name
     * back — then so does the one after it, and so on, because each of them breaks in the same
     * way and is equally invisible. That is not hypothetical: it is exactly how a chain of pieces
     * came to be six good ones followed by an unbounded run of identical broken rows.
     */
    const name = declaredName(row.source());
    if (name) used.add(name);
  }
  return used;
}

/**
 * The name a row is *trying* to declare, read off the text rather than the parse.
 *
 * Everything up to the first `(` or `=`, accepted only when it looks like a single token — so
 * `X_2(u,v) = …` reserves `X_2` while `2u + 3 = …` reserves nothing. Deliberately crude: this is
 * a fallback for text the real parser has already rejected, and the only thing it must never do
 * is claim a name that no row is using.
 */
function declaredName(source: string): string | null {
  const head = source.split(/[(=]/, 1)[0]?.trim() ?? "";
  if (head === "" || /[\s+\-*/^,)[\]]/.test(head)) return null;
  return head;
}

/**
 * The first name from `preferred` that nobody is using, or a numbered one when all are taken.
 *
 * Numbering starts from the FIRST preferred name rather than continuing the list, so a seventh
 * surface is `X_2` — recognisably another X — instead of a letter with no relationship to the
 * others.
 *
 * The number is a **subscript**, and that is not decoration. `X2` lexes as `X · 2`, because
 * implicit multiplication is the whole point of the input language — so a row named that way is a
 * parse error, draws nothing, and (before `usedNames` learned to read broken rows) hands its name
 * straight back to the next object. A subscript binds into the name in the lexer, which is also
 * how the notation is written in the book.
 */
export function nextName(preferred: readonly string[], used: ReadonlySet<string>): string {
  for (const name of preferred) {
    if (!used.has(name)) return name;
  }
  const base = preferred[0] ?? "f";
  for (let index = 2; ; index++) {
    const candidate = `${base}_${index}`;
    if (!used.has(candidate)) return candidate;
  }
}

/**
 * The same declaration under a different name.
 *
 * Rebuilt from the parsed row rather than by substituting text, because the name can appear in the
 * body as well — `X(u,v) = (X0 cos u, …)` is a perfectly good surface with a parameter whose name
 * starts the same way, and a blind replace would corrupt it.
 *
 * Returns the source unchanged when it declares nothing, so a bare expression or a broken row
 * survives being copied.
 */
export function renameDeclaration(source: string, newName: string): string {
  const { row, host } = parseRow(source);
  if (!row) return source;
  // The chart a row is stated in survives being renamed. Rebuilding from the AST would drop the
  // prefix, which would quietly move a copied curve onto whatever surface comes first.
  const keep = (rewritten: string) => (host === undefined ? rewritten : `${host}: ${rewritten}`);

  switch (row.kind) {
    case "vectorFunction":
      return keep(
        `${newName}(${row.args.join(", ")}) = (${row.comps.map((c) => toSource(c)).join(", ")})`,
      );
    case "function":
      return keep(`${newName}(${row.args.join(", ")}) = ${toSource(row.body)}`);
    case "value":
      return keep(`${newName} = ${toSource(row.body)}`);
    default:
      return source;
  }
}

/**
 * The same row, stated in a different chart.
 *
 * Only the prefix moves; the formula is handed back character for character, since a curve copied
 * onto another patch is the same curve read through another map — that is the whole point of
 * copying it. A row that named no chart is given one.
 */
export function rehost(source: string, newHost: string): string {
  /**
   * A tangent plane names its patch in the row itself, after the point — so it is *rewritten*
   * there rather than given a prefix. `X: T_(1,2) X` would name two patches, and the copy would
   * go on pointing at the original.
   */
  const tangent = splitTangent(source);
  if (tangent && !("diag" in tangent) && tangent.surfaceSpan) {
    const [start, end] = tangent.surfaceSpan;
    return source.slice(0, start) + newHost + source.slice(end);
  }

  const { host, body } = splitHost(source);
  return host === null ? `${newHost}: ${source}` : `${newHost}: ${body.trimStart()}`;
}
