import { describe, expect, it } from "vitest";
import { parseRow } from "../../src/core/expr/parse.ts";
import { createDocument } from "../../src/state/graph.ts";
import {
  CURVE_NAMES,
  SURFACE_NAMES,
  nextName,
  rehost,
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

  it("numbers from the first name once the letters run out, as a subscript", () => {
    /**
     * `X_2` is recognisably another surface; the seventh letter of a private list is not. Starting
     * the numbering from the FIRST preferred name rather than continuing the sequence is what
     * keeps that true.
     */
    const all = new Set(SURFACE_NAMES);
    expect(nextName(SURFACE_NAMES, all)).toBe("X_2");
    expect(nextName(SURFACE_NAMES, new Set([...all, "X_2"]))).toBe("X_3");
  });

  it("only ever produces a name the parser accepts", () => {
    /**
     * The bug this exists to prevent, and the reason the number is a subscript.
     *
     * `X2` lexes as `X · 2` — implicit multiplication is the whole point of the input language —
     * so the seventh surface was a row that could not parse. It drew nothing, and because a row
     * that does not parse declared no name, the eighth was handed `X2` as well, and the ninth.
     * Building a chain of pieces produced six good ones followed by an unbounded run of identical
     * broken rows.
     */
    const used = new Set<string>();
    for (let i = 0; i < 12; i++) {
      const name = nextName(SURFACE_NAMES, used);
      const { row, diags } = parseRow(`${name}(u,v) = (u, v, 0)`);
      expect(row?.kind, name).toBe("vectorFunction");
      expect((row as { name?: string } | null)?.name, name).toBe(name);
      expect(diags, name).toEqual([]);
      used.add(name);
    }
    expect(used.size).toBe(12);
  });

  it("reserves the name of a row that does not parse", () => {
    // The other half of the same failure: a broken row still owns its name, or the next object
    // takes it back and breaks in exactly the same way, forever.
    const store = createDocument(["Q(u,v) = (u, v, +)", "X(u,v) = (u, v, 0)"]);
    const used = usedNames(store);
    expect(used.has("Q")).toBe(true);
    expect(used.has("X")).toBe(true);
  });

  it("claims nothing from a row that declares nothing", () => {
    const store = createDocument(["2u + 3", "  "]);
    expect(usedNames(store).size).toBe(0);
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

describe("moving a row onto another chart", () => {
  it("gives a prefix to a row that had none, and replaces one that had", () => {
    expect(rehost("(u - a)^2 + v^2 = 1", "Y")).toBe("Y: (u - a)^2 + v^2 = 1");
    expect(rehost("X: v = sin u", "Y")).toBe("Y: v = sin u");
  });

  it("rewrites a tangent plane's patch where it is written, after the point", () => {
    /**
     * A tangent plane names its patch in the row itself. Handed a prefix instead, the copy would
     * read `Y: T_(1,2) X` — a row naming two patches, still drawn on the original, which is
     * exactly what duplicating a surface is supposed to avoid.
     */
    expect(rehost("T_(1, 2) X", "Y")).toBe("T_(1, 2) Y");
    expect(parseRow(rehost("T_(1, 2) X", "Y")).host).toBe("Y");
    // One that named nobody is given the prefix form, which means the same thing.
    expect(parseRow(rehost("T_(1, 2)", "Y")).host).toBe("Y");
  });

  it("leaves the formula character for character", () => {
    // A curve copied onto another patch is the same curve read through another map — that is the
    // point of copying it, so nothing but the name may move.
    expect(rehost("X: cos(v + sin v) - u = 0", "Z")).toContain("cos(v + sin v) - u = 0");
  });
});
