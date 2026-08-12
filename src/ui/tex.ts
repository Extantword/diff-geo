import katex from "katex";
import "katex/dist/katex.min.css";
import { el } from "./dom.ts";

/**
 * KaTeX rendering.
 *
 * `throwOnError` is false on purpose: this renders *while the user types*, so it is
 * handed malformed input constantly. A thrown error would blank the panel; KaTeX's own
 * red error text is the more useful signal, and the parser's diagnostics carry the real
 * explanation anyway.
 */
export function tex(source: string, display = false): HTMLElement {
  const html = katex.renderToString(source, {
    displayMode: display,
    throwOnError: false,
    output: "html",
  });
  return el("span", { class: display ? "tex-display" : "tex-inline", html });
}
