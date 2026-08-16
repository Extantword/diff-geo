import { describe, expect, it } from "vitest";
import source from "../../docs/index.md?raw";
import stylesheet from "../../docs/style.css?raw";
import appStylesheet from "../../src/style.css?raw";
import { MarkdownError, absolutize, renderDocs, slug } from "../../docs/render.ts";
import { BLOCK_NAMES, SITE, expand } from "../../docs/tables.ts";
import { CATALOG, CATALOG_FIELDS } from "../../src/core/catalog/surfaces.ts";
import { CURVE_CATALOG } from "../../src/core/catalog/curves.ts";
import { PIECES } from "../../src/core/catalog/pieces.ts";
import { FN_NAMES } from "../../src/core/expr/fns.ts";
import { CONSTANTS } from "../../src/core/expr/lex.ts";
import { createDocument } from "../../src/state/graph.ts";

/**
 * The reference page, checked against the thing it describes.
 *
 * Documentation that can go quietly out of date is worse than none, because it is believed. Every
 * claim on that page that a machine can check is checked here: every example is run through the
 * real document layer, every list that mirrors a table in the code is compared against it, and
 * every promise the page makes about itself — that it is one static file, that its links resolve —
 * is verified on the rendered output rather than trusted.
 *
 * What cannot be checked this way is generated instead (`docs/tables.ts`) or made a type error
 * (the `Record<ItemKind, …>` tables). This file is for the remainder.
 */

const rendered = renderDocs(expand(source), {
  file: "docs/index.md",
  linkBase: `${SITE}/docs/`,
});

/** Every example, as the document the reader would have typed. */
const examples = rendered.blocks.filter((block) => block.language === "dg");
const failures = rendered.blocks.filter((block) => block.language === "dg-error");

/** Resolve a block exactly as the app does: parse, inline definitions, classify. */
function resolveExample(code: string) {
  const store = createDocument(code.split("\n").filter((line) => line.trim() !== ""));
  const resolution = store.resolution();
  const diagnostics = [...resolution.diagnostics.values()].flat();
  return { store, resolution, diagnostics };
}

describe("every example on the page is a document that works", () => {
  it("has examples at all", () => {
    // A guard against the whole suite passing vacuously because a refactor broke the fence
    // language and every block silently stopped being collected.
    expect(examples.length).toBeGreaterThan(8);
  });

  for (const [index, block] of examples.entries()) {
    it(`example ${index + 1} (docs/index.md:${block.line}) resolves without errors`, () => {
      const { diagnostics } = resolveExample(block.code);
      const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
      expect(
        errors.map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`),
        `docs/index.md:${block.line}\n${block.code}`,
      ).toEqual([]);
    });
  }

  for (const [index, block] of failures.entries()) {
    it(`the wrong example ${index + 1} (docs/index.md:${block.line}) still fails, as ${block.expects}`, () => {
      /**
       * An example printed as a mistake has to *be* the mistake it is printed as. Otherwise the
       * page teaches a diagnostic the engine no longer raises — the most confusing kind of stale
       * documentation, because the reader will go looking for what they did wrong.
       */
      const { diagnostics } = resolveExample(block.code);
      expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain(block.expects);
    });
  }
});

describe("the tables mirror the code", () => {
  const text = rendered.text;

  it("lists exactly the names the lexer accepts as functions", () => {
    /**
     * Both columns: the canonical name and the aliases beside it. `FN_NAMES` holds every spelling
     * — `ln` as well as `log` — so a table that listed only the canonical ones would be missing
     * names a reader can legitimately type.
     */
    const rows = [...text.matchAll(/^\| `([a-z0-9]+)` \| (\d) \| (.+) \|$/gm)];
    const listed = new Set<string>();
    for (const [, name, , aliases] of rows) {
      listed.add(name!);
      for (const alias of aliases!.matchAll(/`([a-z0-9]+)`/g)) listed.add(alias[1]!);
    }
    expect([...listed].sort()).toEqual([...FN_NAMES].sort());
  });

  it("does not promise a function the engine refuses to have", () => {
    // `min`, `max`, `floor`, `ceil` and `mod` are absent on purpose — their derivatives are
    // indicator functions. If one is ever added, the sentence saying so becomes a lie here.
    for (const name of ["min", "max", "floor", "ceil", "mod"]) {
      expect(FN_NAMES).not.toContain(name);
      expect(text).toContain(`\`${name}\``);
    }
  });

  it("lists exactly the constants the lexer resolves", () => {
    expect(text).toContain("`pi`");
    expect([...CONSTANTS.keys()]).toEqual(["pi", "π"]);
    // The two names deliberately NOT taken, which the page explains: e is a coefficient of the
    // second fundamental form and tau is torsion.
    expect(CONSTANTS.has("e")).toBe(false);
    expect(CONSTANTS.has("tau")).toBe(false);
  });

  it("names every catalog entry", () => {
    for (const spec of CATALOG) expect(text, `surface ${spec.id}`).toContain(spec.name);
    for (const spec of CURVE_CATALOG) expect(text, `curve ${spec.id}`).toContain(spec.name);
    for (const piece of PIECES) expect(text, `piece ${piece.id}`).toContain(piece.name);
    for (const { field } of CATALOG_FIELDS) {
      expect(text, `field ${field.id}`).toContain(field.label);
    }
  });

  it("uses every generated block, and no others", () => {
    // A block that exists and is never asked for is a table nobody reads; a directive naming a
    // block that does not exist already throws in `expand`.
    for (const name of BLOCK_NAMES) {
      expect(source, `generated: ${name}`).toContain(`<!-- generated: ${name} -->`);
    }
  });
});

describe("the page keeps its own promises", () => {
  it("is one static file: no scripts, no external requests", () => {
    /**
     * The reason this page is not built out of the app: an agent fetching it gets the text, and a
     * reader with the file on a stick gets the page. Both stop being true the moment a `<script>`
     * or a remote font appears.
     */
    expect(rendered.html).not.toContain("<script");
    expect(rendered.html).not.toMatch(/src=/);
    expect(rendered.html).not.toMatch(/href="https?:\/\/(?!github\.com)/);
  });

  it("resolves every link into itself", () => {
    const ids = new Set(rendered.headings.map((heading) => heading.id));
    const anchors = [...rendered.html.matchAll(/href="#([^"]+)"/g)].map((match) => match[1]!);
    for (const anchor of anchors) expect(ids, `#${anchor}`).toContain(anchor);
    // And the ids are unique, or two sections answer to one link.
    expect(new Set(rendered.headings.map((heading) => heading.id)).size).toBe(
      rendered.headings.length,
    );
  });

  it("hands agents a document whose links work without a base", () => {
    // A `.md` fetched on its own has nothing to resolve `../` against.
    expect(rendered.text).not.toMatch(/\]\(\.{1,2}\//);
    expect(rendered.text).not.toMatch(/\]\(#/);
    expect(rendered.text).toContain(SITE);
  });

  it("keeps the markdown free of tags", () => {
    expect(rendered.text).not.toMatch(/<[a-zA-Z/]/);
  });

  it("takes its palette from the app rather than forking it", () => {
    const declared = new Set(
      [...appStylesheet.matchAll(/^\s*(--[a-z-]+):/gm)].map((match) => match[1]!),
    );
    const used = new Set([...stylesheet.matchAll(/var\((--[a-z-]+)\)/g)].map((match) => match[1]!));
    for (const name of used) expect(declared, name).toContain(name);
  });
});

describe("the renderer refuses what it cannot render", () => {
  /**
   * The condition on which a hand-written markdown renderer is allowed to exist. A parser that
   * silently half-renders publishes a page with a paragraph missing and nobody notices; one that
   * throws stops the build and says which line.
   */
  const bad = (markdown: string) => () => renderDocs(markdown, { file: "fixture.md" });

  it("refuses raw HTML", () => {
    expect(bad("# ok\n\n<div>hello</div>\n")).toThrow(MarkdownError);
  });

  it("refuses an unknown code fence", () => {
    expect(bad("```python\nprint(1)\n```\n")).toThrow(/unknown code fence/);
  });

  it("refuses a fence that is never closed", () => {
    expect(bad("```dg\nX(u,v) = (u, v, 0)\n")).toThrow(/never closed/);
  });

  it("refuses a ragged table", () => {
    expect(bad("| a | b |\n| --- | --- |\n| 1 |\n")).toThrow(/ragged/);
  });

  it("refuses a table with no rule under its header", () => {
    expect(bad("| a | b |\n| 1 | 2 |\n")).toThrow(/--- rule/);
  });

  it("refuses two headings that would answer to one link", () => {
    expect(bad("# The chart\n\n## The chart\n")).toThrow(/slug/);
  });

  it("refuses a nested list", () => {
    expect(bad("- one\n  - two\n")).toThrow(/nested/);
  });

  it("says where the trouble is", () => {
    // The point of failing closed is the diagnosis, so the message has to carry the file and the
    // line rather than only the fact of a refusal.
    expect(bad("# fine\n\ntext\n\n<b>no</b>\n")).toThrow(/fixture\.md:5/);
  });
});

describe("the renderer's small parts", () => {
  it("slugs a heading the way a link into it expects", () => {
    expect(slug("What each row draws")).toBe("what-each-row-draws");
    expect(slug("`X:` and the chart")).toBe("x-and-the-chart");
  });

  it("leaves absolute links alone and resolves the rest", () => {
    const base = "https://example.org/diff-geo/docs/";
    expect(absolutize("[a](https://x.test/y)", base)).toBe("[a](https://x.test/y)");
    expect(absolutize("[a](../)", base)).toBe("[a](https://example.org/diff-geo/)");
    expect(absolutize("[a](./index.md)", base)).toBe(
      "[a](https://example.org/diff-geo/docs/index.md)",
    );
    expect(absolutize("[a](#rows)", base)).toBe("[a](https://example.org/diff-geo/docs/#rows)");
  });

  it("does not mistake prose for a code span", () => {
    // The placeholder used to be a bare number between spaces, which "the 3 arrows" collided with.
    const html = renderDocs("the 3 arrows and `sin u`", { file: "f.md" }).html;
    expect(html).toContain("the 3 arrows");
    expect(html).toContain("<code>sin u</code>");
  });
});
