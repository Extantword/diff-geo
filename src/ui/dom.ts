/**
 * The two DOM helpers everything else is built from.
 *
 * Deliberately written before any feature UI. Hand-rolled DOM code is where vanilla
 * projects rot: an editable list with focus management and per-row error decorations
 * turns into imperative spaghetti faster than anything else in a project like this. The
 * rule that prevents it is simple — **feature code never touches `appendChild` or
 * `textContent` on a container directly**, it goes through these.
 */

type Attributes = Record<string, string | number | boolean | EventListener | undefined>;

/**
 * Create an element. `class` and `text` are handled specially; anything starting with
 * `on` is attached as a listener; everything else becomes an attribute.
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Attributes = {},
  children: ReadonlyArray<Node | string | null | undefined> = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === false) continue;
    if (key === "class") node.className = String(value);
    else if (key === "text") node.textContent = String(value);
    else if (key === "html") node.innerHTML = String(value);
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key === "value" && tag === "textarea") {
      /**
       * A textarea's text is its CHILD NODE, not a `value` attribute.
       *
       * `setAttribute("value", …)` is silently ignored on a textarea — the element is created
       * empty and stays empty — so the property has to be assigned instead. Set here rather than
       * left to callers because the failure is invisible: the attribute appears in the DOM
       * inspector, and the field is simply blank.
       */
      (node as HTMLTextAreaElement).value = String(value);
    } else if (value === true) node.setAttribute(key, "");
    else node.setAttribute(key, String(value));
  }

  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }

  return node;
}

/** Replace a container's contents in one go. */
export function replace(
  container: HTMLElement,
  children: ReadonlyArray<Node | string | null | undefined>,
): void {
  container.textContent = "";
  for (const child of children) {
    if (child === null || child === undefined) continue;
    container.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
}

/**
 * Four decimals, with the sign dropped when it cannot be supported.
 *
 * A quantity that vanishes analytically — F for an orthogonal parametrization, H for a
 * minimal surface — lands on a tiny negative like −1e-17 numerically, which `toFixed(4)`
 * renders as "-0.0000". That reads as a meaningful negative and it is not one: at this
 * resolution the value is zero, so only the sign character is being reported, and it is
 * noise.
 */
export function formatValue(x: number): string {
  if (!Number.isFinite(x)) return "—";
  const text = x.toFixed(4);
  return text === "-0.0000" ? "0.0000" : text;
}
