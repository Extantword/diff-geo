// @vitest-environment happy-dom
import { describe, expect, it, beforeEach } from "vitest";
import { createDocument } from "../../src/state/graph.ts";
import { createExprList } from "../../src/ui/exprList.ts";
import { createAnimator } from "../../src/ui/animate.ts";

/**
 * Wiring tests for the panel, in a DOM.
 *
 * Every UI regression in this project so far has been a wiring fault invisible to the geometry
 * suite — a focused input replaced, a node reparented, a parent stealing a child's click, a
 * `value` attribute silently ignored on a textarea. None of them could fail a test, because there
 * were no tests that touched a DOM. These check the claims that keep being broken: that a control
 * exists, that it is attached where it is supposed to be, and that selecting a row reveals it.
 */

function makeList(sources: readonly string[]) {
  const store = createDocument(sources);
  const list = createExprList({
    document: store,
    onEdit: () => {},
    onParameterChange: () => {},
    domains: new Map(),
    sliders: new Map(),
    frames: new Map(),
    rowSliders: new Map(),
    inChart: new Set(),
    animator: createAnimator(),
    overlays: new Map(),
    colors: new Map(),
  });
  list.refresh(store.resolution() ? [] : []);
  return { store, list };
}

describe("the properties card", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("mounts into the strip that index.html reserves for it", () => {
    /**
     * The bug this exists to catch: the card was placed by a grid rule, and when the rule and the
     * element failed to line up it landed wherever auto-placement put it — nowhere visible. Its
     * position is structural now, so what has to be checked is that the container is still there
     * and still the thing main.ts mounts into.
     */
    document.body.innerHTML =
      '<div class="app"><div class="app__props"></div>' +
      '<div class="app__body"><aside class="panel"></aside>' +
      '<main class="stage"></main></div></div>';
    const { store, list } = makeList(["X(u,v) = (u, v, 0)"]);
    const host = document.querySelector(".app__props");
    expect(host).not.toBeNull();
    host!.append(list.card);
    document.querySelector(".panel")!.append(list.root);

    list.select(store.rows()[0]!.id);
    expect(list.card.parentElement).toBe(host);
    expect(list.card.classList.contains("props--hidden")).toBe(false);
    // And it is a sibling of the body, not inside the stage — nested there it could only overlay
    // the geometry rather than sit above it.
    expect(document.querySelector(".stage")!.contains(list.card)).toBe(false);
  });

  it("is hidden until a row is selected, and shown after", () => {
    const { store, list } = makeList(["X(u,v) = (u, v, 0)"]);
    document.body.append(list.root, list.card);

    expect(list.card.classList.contains("props--hidden")).toBe(true);
    list.select(store.rows()[0]!.id);
    expect(list.card.classList.contains("props--hidden")).toBe(false);
    list.select(null);
    expect(list.card.classList.contains("props--hidden")).toBe(true);
  });

  it("puts the selected row's details inside the card, not inside the row", () => {
    // The property the whole design rests on: details live in the card the entire time, and only
    // their visibility changes. If one ever ends up back in the row, selection silently does
    // nothing and the card shows an empty shell.
    const { store, list } = makeList(["X(u,v) = (u, v, 0)"]);
    document.body.append(list.root, list.card);
    const id = store.rows()[0]!.id;
    list.select(id);

    const shown = list.card.querySelectorAll(".props__body:not(.props__body--hidden)");
    expect(shown).toHaveLength(1);
    // And it is not also sitting in the expression list.
    expect(list.root.querySelector(".props__body")).toBeNull();
  });

  it("keeps one empty trailing cell so there is always somewhere to type", () => {
    const { store, list } = makeList(["X(u,v) = (u, v, 0)"]);
    document.body.append(list.root);
    expect(store.rows()).toHaveLength(2);
    expect(store.rows()[1]!.source()).toBe("");
    expect(list.root.querySelectorAll(".row")).toHaveLength(2);
  });

  it("fills each cell's textarea with its source", () => {
    /**
     * The regression that made every cell open blank: `el()` sets attributes, and a textarea's
     * text is a child node, so `setAttribute("value", …)` is silently ignored. Invisible in the
     * markup, which showed the attribute exactly as expected.
     */
    const { list } = makeList(["X(u,v) = (u, v, 0)"]);
    document.body.append(list.root);
    const field = list.root.querySelector<HTMLTextAreaElement>(".row__input")!;
    expect(field.value).toBe("X(u,v) = (u, v, 0)");
  });
});
