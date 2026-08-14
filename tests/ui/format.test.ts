import { describe, expect, it } from "vitest";
import { parseRow } from "../../src/core/expr/parse.ts";
import { formatSurfaceSource } from "../../src/ui/exprList.ts";

/**
 * Reformatting is presentation, so the one property that matters is that it changes NOTHING about
 * what the row means. A formatter that quietly alters a formula is far worse than none.
 */

const compsOf = (source: string) => {
  const { row } = parseRow(source);
  return (row as { comps?: readonly unknown[] } | null)?.comps ?? null;
};

describe("formatting a surface over several lines", () => {
  it("preserves the expression exactly", () => {
    const source = "X(u,v) = ((R + r cos u) cos v, (R + r cos u) sin v, r sin u)";
    const formatted = formatSurfaceSource(source)!;
    expect(formatted).not.toBeNull();
    // Interned trees: equal structure is equal identity, so this is exact rather than approximate.
    expect(compsOf(formatted)).toEqual(compsOf(source));
  });

  it("names the coordinates and puts each on its own line", () => {
    const formatted = formatSurfaceSource("X(u,v) = (cos u, sin u, v)")!;
    expect(formatted.split("\n")).toHaveLength(5);
    expect(formatted).toContain("x = ");
    expect(formatted).toContain("y = ");
    expect(formatted).toContain("z = ");
  });

  it("is idempotent, so leaving a cell twice does not keep rewriting it", () => {
    const once = formatSurfaceSource("X(u,v) = (cos u, sin u, v)")!;
    expect(formatSurfaceSource(once)).toBe(once);
  });

  it("leaves everything that is not a surface alone", () => {
    // A curve, a scalar, an equation and an empty cell all keep whatever the user typed.
    for (const source of [
      "alpha(t) = (cos t, sin t, t)",
      "R = 2",
      "x^2 + y^2 + z^2 = 1",
      "",
      "  ",
    ]) {
      expect(formatSurfaceSource(source), source).toBeNull();
    }
  });

  it("leaves a broken formula alone rather than mangling it", () => {
    // Mid-edit text must survive: reformatting something unparseable could only destroy it.
    expect(formatSurfaceSource("X(u,v) = (cos u, sin u")).toBeNull();
  });
});
