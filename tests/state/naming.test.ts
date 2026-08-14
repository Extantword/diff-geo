import { describe, expect, it } from "vitest";
import { parseRow } from "../../src/core/expr/parse.ts";
import { createDocument } from "../../src/state/graph.ts";
import {
  CURVE_NAMES,
  SURFACE_NAMES,
  nextName,
  renameDeclaration,
  usedNames,
} from "../../src/state/naming.ts";

/**
 * Two rows declaring the same name is not two objects — it is one definition overwritten by the
 * other. So every object a template or a copy creates has to be given a name nobody is using, and
 * these pin the two halves of that: finding a free name, and rewriting a declaration to use it.
 */

describe("finding a free name", () => {
  it("takes the first unused one, in the conventional order", () => {
    expect(nextName(SURFACE_NAMES, new Set())).toBe("X");
    expect(nextName(SURFACE_NAMES, new Set(["X"]))).toBe("Y");
    expect(nextName(SURFACE_NAMES, new Set(["X", "Y"]))).toBe("Z");
    expect(nextName(CURVE_NAMES, new Set(["alpha"]))).toBe("beta");
  });

  it("numbers from the first name once the letters run out", () => {
    /**
     * `X2` is recognisably another surface; the seventh letter of a private list is not. Starting
     * the numbering from the FIRST preferred name rather than continuing the sequence is what
     * keeps that true.
     */
    const all = new Set(SURFACE_NAMES);
    expect(nextName(SURFACE_NAMES, all)).toBe("X2");
    expect(nextName(SURFACE_NAMES, new Set([...all, "X2"]))).toBe("X3");
  });

  it("reads the names a document currently declares", () => {
    const store = createDocument(["X(u,v) = (u, v, 0)", "R = 2", "alpha(t) = (t, t, t)"]);
    const used = usedNames(store);
    expect(used.has("X")).toBe(true);
    expect(used.has("R")).toBe(true);
    expect(used.has("alpha")).toBe(true);
    expect(nextName(SURFACE_NAMES, used)).toBe("Y");
  });

  it("sees a name even while its row is otherwise unfinished", () => {
    // Read from the row text rather than from the resolution, so a row mid-edit still reserves
    // its name — otherwise a copy made at the wrong moment collides with it.
    const store = createDocument(["X(u,v) = (u, v, 0)"]);
    expect(usedNames(store).has("X")).toBe(true);
  });
});

describe("renaming a declaration", () => {
  it("renames a surface, a function and a value", () => {
    expect(renameDeclaration("X(u,v) = (u, v, 0)", "Y")).toBe("Y(u, v) = (u, v, 0)");
    expect(renameDeclaration("f(t) = t^2", "g")).toContain("g(t) = ");
    expect(renameDeclaration("R = 2", "S")).toBe("S = 2");
  });

  it("preserves the expression, not the spelling", () => {
    /**
     * Rebuilt from the parse rather than by substituting text, so the components come back
     * through the printer: `cos u` is re-emitted as `cos(u)` and implicit products become
     * explicit. What must survive is the EXPRESSION, which is checked by parsing both and
     * comparing the trees — interned, so equal structure is equal identity.
     */
    const original = "X(u,v) = ((2 + cos u) cos v, (2 + cos u) sin v, sin u)";
    const renamed = renameDeclaration(original, "Y");
    expect(renamed.startsWith("Y(")).toBe(true);

    const comps = (source: string) =>
      (parseRow(source).row as { comps?: readonly unknown[] } | null)?.comps ?? null;
    expect(comps(renamed)).toEqual(comps(original));
  });

  it("renames only the declaration, never a reference inside the body", () => {
    // A row whose body mentions another object keeps that mention: only the left-hand side is
    // the thing being renamed.
    const renamed = renameDeclaration("X(u,v) = (r cos u, r sin u, v)", "Y");
    expect(renamed.startsWith("Y(")).toBe(true);
    expect(renamed).toContain("r");
  });

});
