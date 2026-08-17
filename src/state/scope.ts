/**
 * Scopes: what `:` means between two names.
 *
 * `:` is this language's `.`. A row's prefix is its address — `A:sigma: u + v = 1` is a relation
 * stated in the chart sigma, which lives in the ambient space A — and a name declared inside a
 * scope belongs to it: `A:k` is A's own k, `k` alone is the document's.
 *
 * Two rules, and everything else follows from them:
 *
 *  - a declaration's **qualified name** is its path and its name joined by `:`, so two spaces may
 *    each have a `k` and they are two numbers;
 *  - a reference resolves **innermost first** — a row in `A:sigma` mentioning `k` takes
 *    `A:sigma:k` if there is one, then `A:k`, then the global `k`. That is the ordinary lexical
 *    rule, and it is what makes a parameter shared across spaces the *default*: nothing declares
 *    it anywhere, so every scope sees the same free name.
 */

/** `["A", "sigma"]` and `k` → `"A:sigma:k"`; an empty path leaves the name alone. */
export function qualify(path: readonly string[], name: string): string {
  return path.length === 0 ? name : `${path.join(":")}:${name}`;
}

/**
 * The qualified name a bare reference resolves to, or null when nothing declares it.
 *
 * Innermost first, then outward one segment at a time, ending at the document. `has` is asked
 * rather than given a map so the caller can answer from whatever it has — the declaration table
 * during one pass, the value table during another.
 */
export function resolveScoped(
  path: readonly string[],
  name: string,
  has: (qualified: string) => boolean,
): string | null {
  for (let depth = path.length; depth >= 0; depth--) {
    const candidate = qualify(path.slice(0, depth), name);
    if (has(candidate)) return candidate;
  }
  return null;
}

/** Whether `path` is inside `outer` — `["A","sigma"]` is inside `["A"]` and inside `[]`. */
export function within(path: readonly string[], outer: readonly string[]): boolean {
  if (outer.length > path.length) return false;
  for (let i = 0; i < outer.length; i++) if (path[i] !== outer[i]) return false;
  return true;
}
