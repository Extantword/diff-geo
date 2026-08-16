import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { renderDocs } from "./render.ts";
import { expand, SITE } from "./tables.ts";

/**
 * The reference page, emitted as part of the bundle.
 *
 * A plugin rather than a script run after `vite build`, because `vite build` **empties `dist`**:
 * anything written afterwards is one forgotten command away from a deploy with no documentation,
 * and the deploy workflow uploads whatever is in `dist` without looking. Emitting through Rollup
 * removes the ordering question by construction, leaves `package.json` untouched, and means a
 * broken table stops the build instead of shipping a broken page.
 *
 * In dev the same artifacts are served from memory, re-read on every request, so editing the
 * markdown and reloading `/docs/` shows the change.
 *
 * This is the only file here that touches the filesystem. `render.ts` and `tables.ts` are pure so
 * that the test suite — which cannot import node builtins, `tsconfig.app.json` restricts `types` —
 * can import them directly.
 */

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/** Where each artifact lands under `dist`, and therefore what its URL is. */
const PAGE = "docs/index.html";
const MARKDOWN = "docs/index.md";
const LLMS = "llms.txt";
const LLMS_FULL = "llms-full.txt";

interface Artifacts {
  readonly html: string;
  readonly markdown: string;
  readonly llms: string;
}

/**
 * The app's palette, lifted out of its stylesheet rather than copied.
 *
 * Two files declaring the same colours is two files that disagree eventually. The docs page needs
 * its own typography — `src/style.css` is a layout engine for a three-panel WebGL app and none of
 * it applies to prose — but the colours are the same colours, so they are taken from the one place
 * that defines them. Missing block throws: a page rendered without a palette is unreadable, and a
 * loud failure at build time is the cheapest possible way to find out.
 */
function palette(): string {
  const css = readFileSync(here("../src/style.css"), "utf8");
  const start = css.indexOf(":root {");
  const end = start < 0 ? -1 : css.indexOf("}", start);
  if (start < 0 || end < 0) {
    throw new Error("docs: no `:root { … }` block in src/style.css to take the palette from");
  }
  return css.slice(start, end + 1);
}

function build(): Artifacts {
  const source = expand(readFileSync(here("./index.md"), "utf8"));
  const rendered = renderDocs(source, { file: "docs/index.md", linkBase: `${SITE}/docs/` });
  const style = `${palette()}\n\n${readFileSync(here("./style.css"), "utf8")}`;

  const html = [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="UTF-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0" />',
    `<title>${rendered.title}</title>`,
    '<meta name="description" content="How to use DiffGeo: the formula language, what each row ' +
      'draws, the interface, and what the engine computes." />',
    // The plain-text twin, announced where a machine will look for it.
    `<link rel="alternate" type="text/markdown" href="./index.md" />`,
    `<style>${style}</style>`,
    "</head>",
    '<body class="docs">',
    `<main>${rendered.html}</main>`,
    "</body>",
    "</html>",
  ].join("\n");

  return { html, markdown: rendered.text, llms: index(rendered.title) };
}

/**
 * `llms.txt`: the short index an agent reads first.
 *
 * Deliberately not the documentation — it is a map to it. The convention is a title, one
 * paragraph, and links; the payload is `llms-full.txt`, which is the reference itself.
 */
function index(title: string): string {
  return [
    `# ${title}`,
    "",
    "> An interactive differential geometry engine for curves and surfaces in R³, after do Carmo.",
    "> You write formulas into cells and the objects appear: coordinate patches, curves, tangent",
    "> planes, vector fields and their flows, with curvature, geodesics and the Gauss map",
    "> computed from a real CAS rather than sampled.",
    "",
    "## Documentation",
    "",
    `- [Reference (plain text)](${SITE}/${LLMS_FULL}): the whole manual — the formula language,`,
    "  what each kind of row draws, the interface, what is computed, and the catalog.",
    `- [Reference (web page)](${SITE}/docs/): the same document, formatted.`,
    `- [The app itself](${SITE}/): runs in the browser; nothing to install.`,
    "",
    "## Source",
    "",
    "- [Repository](https://github.com/Extantword/diff-geo)",
    "- [CLAUDE.md](https://github.com/Extantword/diff-geo/blob/main/CLAUDE.md): the architecture",
    "  and the invariants, for agents changing the code rather than using it.",
    "",
  ].join("\n");
}

export function docsPlugin(): Plugin {
  return {
    name: "diffgeo-docs",

    /**
     * The reference is announced in the app's own `<head>`.
     *
     * Injected by this plugin rather than written into `index.html`, because Vite treats every
     * `<link href>` there as an **asset** to resolve and copy — and `docs/` is a directory, which
     * fails the build with `EISDIR`. Injecting after that pass keeps the tags out of it. The
     * visible anchor in `index.html` is untouched: `<a href>` is not an asset attribute.
     */
    transformIndexHtml: {
      order: "post",
      handler() {
        return [
          { tag: "link", attrs: { rel: "help", href: "docs/" }, injectTo: "head" as const },
          {
            tag: "link",
            attrs: { rel: "alternate", type: "text/markdown", href: "llms.txt" },
            injectTo: "head" as const,
          },
        ];
      },
    },

    generateBundle() {
      const artifacts = build();
      this.emitFile({ type: "asset", fileName: PAGE, source: artifacts.html });
      this.emitFile({ type: "asset", fileName: MARKDOWN, source: artifacts.markdown });
      // Byte-identical to the markdown by construction: the same string, emitted twice, so the
      // two conventions cannot come to disagree.
      this.emitFile({ type: "asset", fileName: LLMS_FULL, source: artifacts.markdown });
      this.emitFile({ type: "asset", fileName: LLMS, source: artifacts.llms });
    },

    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = (request.url ?? "").split("?")[0] ?? "";
        const routes: Record<string, { type: string; body: () => string }> = {
          "/docs": { type: "text/html", body: () => build().html },
          "/docs/": { type: "text/html", body: () => build().html },
          "/docs/index.html": { type: "text/html", body: () => build().html },
          "/docs/index.md": { type: "text/markdown", body: () => build().markdown },
          "/llms.txt": { type: "text/plain", body: () => build().llms },
          "/llms-full.txt": { type: "text/plain", body: () => build().markdown },
        };
        const route = routes[url];
        if (!route) return next();
        try {
          // Rebuilt per request rather than cached: the point of the dev server is that editing
          // the markdown and reloading shows the edit.
          const body = route.body();
          response.setHeader("Content-Type", `${route.type}; charset=utf-8`);
          response.end(body);
        } catch (thrown) {
          response.statusCode = 500;
          response.setHeader("Content-Type", "text/plain; charset=utf-8");
          response.end(thrown instanceof Error ? thrown.message : String(thrown));
        }
      });
    },
  };
}
