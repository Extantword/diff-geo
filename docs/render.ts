/**
 * The reference page's markdown, rendered.
 *
 * A markdown renderer is not something a project should write for itself, and this one is allowed
 * to exist on one condition: it **fails closed**. It accepts a deliberately small subset —
 * headings, paragraphs, fenced code, lists, pipe tables, blockquotes, rules, and four inline forms
 * — and it *throws* on anything outside it, naming the file, the line and the construct. A parser
 * that silently half-renders is a liability, because the failure is a paragraph quietly missing
 * from a published page and nobody looks. One that refuses is a tool: the build stops and says
 * where.
 *
 * There is one parse and two outputs, and only the HTML one is a render. The plain-text twin —
 * what an agent fetches — is the **source itself**, with links made absolute, because the source
 * is already markdown and anything else would be a second rendering of the same content that could
 * disagree with the first. The parse still runs over it, so the text form is only ever emitted for
 * a document that passed the subset.
 *
 * ## No node imports, deliberately
 *
 * This module is imported by the test suite, and `tsconfig.app.json` restricts `types` to
 * vitest and vite — so `node:fs` does not even typecheck there. Reading files is `plugin.ts`'s
 * job; everything here is a pure function of a string.
 */

/** Fenced code languages this page may use. `dg` blocks are checked by the suite. */
const FENCE_LANGUAGES: ReadonlySet<string> = new Set(["", "dg", "text"]);

/** `dg-error E_ARITY` — an example that is *supposed* to fail, with the code it must produce. */
const ERROR_FENCE = /^dg-error\s+([A-Z_]+)$/;

/** Anything that looks like a tag or a comment. Prose may still say `a < b`. */
const RAW_HTML = /<[a-zA-Z/!?]/;

export interface Heading {
  readonly level: number;
  readonly text: string;
  readonly id: string;
}

export interface CodeBlock {
  /** `dg`, `text`, `""`, or `dg-error` */
  readonly language: string;
  /** the diagnostic code a `dg-error` block must produce, else null */
  readonly expects: string | null;
  readonly code: string;
  /** 1-based line of the opening fence, for a test failure that can be found */
  readonly line: number;
}

export interface RenderOptions {
  /** shown in error messages */
  readonly file?: string;
  /**
   * Where this page lives, for the text twin's links.
   *
   * A `.md` fetched on its own has no base to resolve against, so every relative link in it is
   * useless. The HTML keeps its relative links — that is what makes the site work under any
   * project path — and only the text form is rewritten.
   */
  readonly linkBase?: string;
}

export interface Rendered {
  /** the body of the page: everything inside `<body>`, with no scripts and no external requests */
  readonly html: string;
  /** the same document as markdown, links absolute */
  readonly text: string;
  readonly headings: readonly Heading[];
  readonly blocks: readonly CodeBlock[];
  /** the page's `<h1>`, for the title */
  readonly title: string;
}

type Block =
  | { readonly kind: "heading"; readonly level: number; readonly text: string; readonly id: string }
  | { readonly kind: "paragraph"; readonly text: string }
  | { readonly kind: "code"; readonly info: string; readonly code: string; readonly line: number }
  | { readonly kind: "list"; readonly ordered: boolean; readonly items: readonly string[] }
  | { readonly kind: "table"; readonly head: readonly string[]; readonly rows: readonly string[][] }
  | { readonly kind: "quote"; readonly text: string }
  | { readonly kind: "rule" };

/** A refusal that names where it happened. */
export class MarkdownError extends Error {
  constructor(file: string, line: number, message: string) {
    super(`${file}:${line}: ${message}`);
    this.name = "MarkdownError";
  }
}

/**
 * Render the page.
 *
 * Throws `MarkdownError` on anything outside the subset — which, since this runs inside the Vite
 * build, means a malformed table stops a deploy rather than shipping a mangled page.
 */
export function renderDocs(source: string, options: RenderOptions = {}): Rendered {
  const file = options.file ?? "docs/index.md";
  const blocks = parse(source, file);

  const headings: Heading[] = [];
  for (const block of blocks) {
    if (block.kind === "heading") headings.push(block);
  }
  const codes: CodeBlock[] = [];
  for (const block of blocks) {
    if (block.kind !== "code") continue;
    const matched = ERROR_FENCE.exec(block.info);
    codes.push({
      language: matched ? "dg-error" : block.info,
      expects: matched ? matched[1]! : null,
      code: block.code,
      line: block.line,
    });
  }

  return {
    html: toHtml(blocks, file),
    text: absolutize(source, options.linkBase ?? ""),
    headings,
    blocks: codes,
    title: headings.find((heading) => heading.level === 1)?.text ?? "DiffGeo",
  };
}

/** The code blocks alone, for a suite that wants to run every example. */
export function collectCodeBlocks(source: string, file = "docs/index.md"): readonly CodeBlock[] {
  return renderDocs(source, { file }).blocks;
}

// --------------------------------------------------------------------------- //
// the block parser
// --------------------------------------------------------------------------- //

function parse(source: string, file: string): Block[] {
  const lines = source.split("\n");
  const blocks: Block[] = [];
  const seenIds = new Set<string>();
  let i = 0;

  const fail = (line: number, message: string): never => {
    throw new MarkdownError(file, line + 1, message);
  };

  while (i < lines.length) {
    const line = lines[i]!;

    if (line.trim() === "") {
      i++;
      continue;
    }

    // ---- fenced code ----
    if (line.startsWith("```")) {
      const info = line.slice(3).trim();
      if (!FENCE_LANGUAGES.has(info) && !ERROR_FENCE.test(info)) {
        fail(
          i,
          `unknown code fence "${info}" — use one of ${[...FENCE_LANGUAGES]
            .map((name) => `"${name}"`)
            .join(", ")} or "dg-error E_CODE"`,
        );
      }
      const start = i;
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith("```")) {
        body.push(lines[i]!);
        i++;
      }
      if (i >= lines.length) fail(start, "this code fence is never closed");
      i++;
      blocks.push({ kind: "code", info, code: body.join("\n"), line: start + 1 });
      continue;
    }

    // ---- heading ----
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      const text = heading[2]!.trim();
      guardInline(text, i, file);
      const id = slug(text);
      if (seenIds.has(id)) fail(i, `two headings slug to "${id}"; make one of them different`);
      seenIds.add(id);
      blocks.push({ kind: "heading", level, text, id });
      i++;
      continue;
    }

    // ---- thematic break ----
    if (/^---+$/.test(line.trim())) {
      blocks.push({ kind: "rule" });
      i++;
      continue;
    }

    // ---- table ----
    if (line.trimStart().startsWith("|")) {
      const start = i;
      const raw: string[] = [];
      while (i < lines.length && lines[i]!.trimStart().startsWith("|")) {
        raw.push(lines[i]!);
        i++;
      }
      if (raw.length < 2) fail(start, "a table needs a header row and a --- rule under it");
      const head = cells(raw[0]!);
      if (!raw[1]!.split("|").every((cell) => cell.trim() === "" || /^:?-{2,}:?$/.test(cell.trim()))) {
        fail(start + 1, "the second row of a table must be the --- rule");
      }
      const rows: string[][] = [];
      for (let r = 2; r < raw.length; r++) {
        const row = cells(raw[r]!);
        if (row.length !== head.length) {
          fail(
            start + r,
            `this row has ${row.length} cells but the header has ${head.length} — a ragged ` +
              `table renders as a wrong table rather than as no table`,
          );
        }
        for (const cell of row) guardInline(cell, start + r, file);
        rows.push(row);
      }
      for (const cell of head) guardInline(cell, start, file);
      blocks.push({ kind: "table", head, rows });
      continue;
    }

    // ---- list ----
    const bullet = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(line);
    if (bullet) {
      if (bullet[1] !== "") fail(i, "nested lists are not supported; use a table or a heading");
      const ordered = !/^[-*]$/.test(bullet[2]!);
      const items: string[] = [];
      while (i < lines.length) {
        const next = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(lines[i]!);
        if (!next) break;
        if (next[1] !== "") fail(i, "nested lists are not supported");
        if (!/^[-*]$/.test(next[2]!) !== ordered) {
          fail(i, "a list cannot change between bulleted and numbered halfway through");
        }
        let text = next[3]!;
        i++;
        // A continuation line is one that is indented and is not itself an item.
        while (i < lines.length && /^\s+\S/.test(lines[i]!) && !/^\s*([-*]|\d+\.)\s/.test(lines[i]!)) {
          text += ` ${lines[i]!.trim()}`;
          i++;
        }
        guardInline(text, i - 1, file);
        items.push(text);
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }

    // ---- blockquote ----
    if (line.startsWith("> ")) {
      const start = i;
      const body: string[] = [];
      while (i < lines.length && lines[i]!.startsWith("> ")) {
        body.push(lines[i]!.slice(2).trim());
        i++;
      }
      const text = body.join(" ");
      guardInline(text, start, file);
      blocks.push({ kind: "quote", text });
      continue;
    }

    // ---- paragraph ----
    const start = i;
    const body: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() !== "" &&
      !lines[i]!.startsWith("```") &&
      !lines[i]!.startsWith("#") &&
      !lines[i]!.trimStart().startsWith("|") &&
      !lines[i]!.startsWith("> ") &&
      !/^(\s*)([-*]|\d+\.)\s+/.test(lines[i]!) &&
      !/^---+$/.test(lines[i]!.trim())
    ) {
      body.push(lines[i]!.trim());
      i++;
    }
    const text = body.join(" ");
    guardInline(text, start, file);
    blocks.push({ kind: "paragraph", text });
  }

  return blocks;
}

/**
 * Split `| a | b |` into its cells, honouring `\|`.
 *
 * The escape is not a nicety: the catalog's own blurbs contain `|α′(0)|`, and a generated table
 * that split on every pipe would come back ragged — which this renderer then refuses, so a comma
 * in a catalog entry would break the build.
 */
function cells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

/**
 * Reject raw HTML before it reaches the page.
 *
 * Not because HTML would break anything, but because the plain-text twin is the same string: a
 * `<div>` in the source is a `<div>` in what an agent reads. Prose may still say `a < b`, so the
 * test is for something that looks like a tag rather than for the character.
 */
function guardInline(text: string, line: number, file: string): void {
  if (RAW_HTML.test(text)) {
    throw new MarkdownError(
      file,
      line + 1,
      `raw HTML is not allowed here ("${text.slice(Math.max(0, text.search(RAW_HTML)), 40)}") — ` +
        `the plain-text twin of this page is the source itself, tags and all`,
    );
  }
  const unbalanced = (text.match(/`/g) ?? []).length % 2;
  if (unbalanced) {
    throw new MarkdownError(file, line + 1, "an odd number of backticks on this line");
  }
}

/** GitHub-style anchor: lowercase, spaces to dashes, punctuation dropped. */
export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

// --------------------------------------------------------------------------- //
// HTML
// --------------------------------------------------------------------------- //

function toHtml(blocks: readonly Block[], file: string): string {
  const out: string[] = [];
  let contentsPending = true;
  for (const block of blocks) {
    /**
     * The contents, straight after the title.
     *
     * Built from the headings the parser found rather than written in the markdown: a hand-kept
     * table of contents on a page this long is a list of links that goes stale the first time a
     * section is renamed, and the anchors here cannot be wrong because they are the anchors.
     * The plain-text twin gets none — an agent reads the whole thing, and a list of links to
     * itself is noise in the middle of it.
     */
    if (contentsPending && block.kind === "heading" && block.level > 1) {
      contentsPending = false;
      const sections = blocks.filter(
        (candidate): candidate is Extract<Block, { kind: "heading" }> =>
          candidate.kind === "heading" && candidate.level === 2,
      );
      if (sections.length > 2) {
        const items = sections
          .map((section) => `<li><a href="#${section.id}">${inline(section.text, file)}</a></li>`)
          .join("");
        out.push(`<nav class="toc"><p class="toc__title">Contents</p><ul>${items}</ul></nav>`);
      }
    }

    switch (block.kind) {
      case "heading":
        // The anchor is on the heading itself, so a link into the page lands on the right line
        // and the browser's own "copy link" gets something meaningful.
        out.push(
          `<h${block.level} id="${block.id}">` +
            `<a class="anchor" href="#${block.id}">${inline(block.text, file)}</a>` +
            `</h${block.level}>`,
        );
        break;
      case "paragraph":
        out.push(`<p>${inline(block.text, file)}</p>`);
        break;
      case "quote":
        out.push(`<blockquote>${inline(block.text, file)}</blockquote>`);
        break;
      case "rule":
        out.push("<hr>");
        break;
      case "list": {
        const tag = block.ordered ? "ol" : "ul";
        const items = block.items.map((item) => `<li>${inline(item, file)}</li>`).join("");
        out.push(`<${tag}>${items}</${tag}>`);
        break;
      }
      case "table": {
        const head = block.head.map((cell) => `<th>${inline(cell, file)}</th>`).join("");
        const rows = block.rows
          .map((row) => `<tr>${row.map((cell) => `<td>${inline(cell, file)}</td>`).join("")}</tr>`)
          .join("");
        out.push(`<table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`);
        break;
      }
      case "code": {
        const failing = ERROR_FENCE.exec(block.info);
        const language = failing ? "dg-error" : block.info;
        const label = failing
          ? `<p class="example__note">this one is wrong on purpose: ${escapeHtml(failing[1]!)}</p>`
          : "";
        out.push(
          `<figure class="example example--${language || "plain"}">` +
            `<pre><code>${escapeHtml(block.code)}</code></pre>${label}</figure>`,
        );
        break;
      }
    }
  }
  return out.join("\n");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The four inline forms: `code`, **strong**, *em*, [text](url).
 *
 * Code spans are taken out first and put back last, so a backtick span containing an asterisk is
 * not emphasised — which matters here, where the prose is full of formulas.
 */
function inline(text: string, file: string): string {
  const spans: string[] = [];
  // The placeholder is NUL-delimited because the obvious one — a bare number between spaces —
  // collides with the prose: "the 3 arrows" would come back as somebody's code span.
  let work = text.replace(/`([^`]+)`/g, (_match, code: string) => {
    spans.push(`<code>${escapeHtml(code)}</code>`);
    return `\u0000${spans.length - 1}\u0000`;
  });

  work = escapeHtml(work);
  work = work.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_match, label: string, href: string) => {
    if (RAW_HTML.test(href) || href.startsWith("javascript:")) {
      throw new MarkdownError(file, 0, `link "${href}" is not a plain URL`);
    }
    return `<a href="${href}">${label}</a>`;
  });
  work = work.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  work = work.replace(/\*([^*]+)\*/g, "<em>$1</em>");

  return work.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => spans[Number(index)]!);
}

// --------------------------------------------------------------------------- //
// the plain-text twin
// --------------------------------------------------------------------------- //

/**
 * The same markdown with every relative link resolved against `base`.
 *
 * A `.md` fetched on its own has no base to resolve against, so `[the app](../)` is useless in it
 * while being exactly right in the page. This is the single place the site's own URL is written
 * into the output; everything else stays path-independent, which is what `base: "./"` is for.
 */
export function absolutize(source: string, base: string): string {
  if (base === "") return source;
  const root = base.replace(/\/+$/, "");
  return source.replace(/\]\((\.{1,2}\/[^)\s]*|#[^)\s]*)\)/g, (_match, href: string) => {
    if (href.startsWith("#")) return `](${root}/${href})`;
    if (href.startsWith("./")) return `](${root}/${href.slice(2)})`;
    // `../` — one level up from the docs directory is the site root.
    const parent = root.replace(/\/[^/]*$/, "");
    return `](${parent}/${href.slice(3)})`;
  });
}
