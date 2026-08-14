import { parseRow } from "../core/expr/parse.ts";
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
    if (parsed && "name" in parsed) used.add(parsed.name);
  }
  return used;
}

/**
 * The first name from `preferred` that nobody is using, or a numbered one when all are taken.
 *
 * Numbering starts from the FIRST preferred name rather than continuing the list, so a seventh
 * surface is `X2` — recognisably another X — instead of a letter with no relationship to the
 * others.
 */
export function nextName(preferred: readonly string[], used: ReadonlySet<string>): string {
  for (const name of preferred) {
    if (!used.has(name)) return name;
  }
  const base = preferred[0] ?? "f";
  for (let index = 2; ; index++) {
    const candidate = `${base}${index}`;
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
  const { row } = parseRow(source);
  if (!row) return source;

  switch (row.kind) {
    case "vectorFunction":
      return `${newName}(${row.args.join(", ")}) = (${row.comps.map((c) => toSource(c)).join(", ")})`;
    case "function":
      return `${newName}(${row.args.join(", ")}) = ${toSource(row.body)}`;
    case "value":
      return `${newName} = ${toSource(row.body)}`;
    default:
      return source;
  }
}
