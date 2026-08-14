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
    expect(list.card.classList.contains("props--empty")).toBe(false);
    // And it is a sibling of the body, not inside the stage — nested there it could only overlay
    // the geometry rather than sit above it.
    expect(document.querySelector(".stage")!.contains(list.card)).toBe(false);
  });

  it("empties rather than vanishes when nothing is selected", () => {
    /**
     * A strip that appears on selection resizes the stage, which changes the canvas aspect and
     * moves the camera — clicking a surface to inspect it nudged the thing being inspected. So
     * the box stays in the layout and only its contents change, which is what `props--empty`
     * means as opposed to the `props--hidden` it replaced.
     */
    const { store, list } = makeList(["X(u,v) = (u, v, 0)"]);
    document.body.append(list.root, list.card);

    expect(list.card.classList.contains("props--empty")).toBe(true);
    list.select(store.rows()[0]!.id);
    expect(list.card.classList.contains("props--empty")).toBe(false);
    list.select(null);
    expect(list.card.classList.contains("props--empty")).toBe(true);
    // Never removed from the document, and never display:none.
    expect(list.card.isConnected).toBe(true);
    expect(list.card.classList.contains("props--hidden")).toBe(false);
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

describe("the toolbar's contents", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("puts a surface's controls in the strip, not the row", () => {
    /**
     * The division of labour the layout depends on: a cell holds its formula and the sliders for
     * the values it introduces; everything describing the OBJECT belongs to the toolbar. If a
     * control drifts back into the row the cell column grows and the toolbar empties, which is
     * exactly the shape the top bar exists to avoid.
     */
    const { store, list } = makeList(["X(u,v) = (u, v, 0)"]);
    document.body.append(list.root, list.card);
    list.refresh([]);
    list.select(store.rows()[0]!.id);

    const shown = list.card.querySelector(".props__body:not(.props__body--hidden)")!;
    expect(shown.querySelector(".props__color"), "colour").not.toBeNull();
    expect(shown.querySelector(".row__domain"), "domain").not.toBeNull();
    expect(shown.querySelector(".row__overlay"), "overlays").not.toBeNull();
    // The formula and its own sliders stay in the cell.
    expect(list.root.querySelector(".row__input")).not.toBeNull();
    expect(list.root.querySelector(".props__color")).toBeNull();
  });

  it("gives a numeric cell a slider of its own, in the cell", () => {
    // `R = 2` is classified as a parameter precisely because it is meant to be dragged; the
    // slider belongs beside the definition, not in the toolbar.
    const { store, list } = makeList(["R = 2"]);
    document.body.append(list.root, list.card);
    list.refresh([]);
    void store;
    expect(list.root.querySelector(".row__value .vslider__input")).not.toBeNull();
  });
});

describe("a numeric cell's typeset view", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("shows the live slider value, not the text it was typed with", () => {
    /**
     * `R = 2` is a definition and a control at once. Dragging deliberately does not rewrite the
     * text until release — rebuilding the interned tree every frame is what made this janky once — so
     * without a live echo the cell reads `R = 2` while its slider reads 1.95, and the definition
     * disagrees with the object on screen.
     */
    const { list } = makeList(["R = 2"]);
    document.body.append(list.root, list.card);
    list.refresh([]);

    const echo = list.root.querySelector(".formula__echo")!;
    expect(echo.textContent).toContain("2");

    const range = list.root.querySelector<HTMLInputElement>(".row__value .vslider__input")!;
    range.value = "3.5";
    range.dispatchEvent(new Event("input"));

    expect(echo.textContent).toContain("3.5");
  });
});

describe("the toolbar is compact", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("labels the overlay tools with symbols, each explained on hover", () => {
    /**
     * The audience reads mathematics, so the symbols ARE the labels — and the reason that is
     * legitimate rather than merely terse is that every one carries its full description in a
     * tooltip. A symbol with no way to look it up would just be a smaller obstacle.
     */
    const { store, list } = makeList(["X(u,v) = (u, v, 0)"]);
    document.body.append(list.root, list.card);
    list.refresh([]);
    list.select(store.rows()[0]!.id);

    const chips = [...list.card.querySelectorAll<HTMLElement>(".chip")];
    expect(chips.length).toBeGreaterThanOrEqual(4);
    for (const chip of chips) {
      expect(chip.title.length, chip.textContent ?? "").toBeGreaterThan(10);
    }
    // No spelled-out phrases left in the strip's own labels.
    expect(list.card.textContent).not.toContain("lines of curvature");
    expect(list.card.textContent).not.toContain("drag to aim a geodesic");
  });

  it("carries a chip's pressed state through to the overlay", () => {
    const overlays = new Map();
    const store = createDocument(["X(u,v) = (u, v, 0)"]);
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
      overlays,
      colors: new Map(),
    });
    document.body.append(list.root, list.card);
    list.refresh([]);
    const id = store.rows()[0]!.id;
    list.select(id);

    const gauss = [...list.card.querySelectorAll<HTMLElement>(".chip")].find(
      (chip) => chip.title.includes("Gauss"),
    )!;
    expect(gauss).toBeDefined();
    gauss.click();
    expect(gauss.classList.contains("chip--on")).toBe(true);
    expect(overlays.get(id)?.gaussMap).toBe(true);
  });

  it("explains K and H on the readout that shows them", () => {
    // The user's own question: the bar says K and H and had no way to find out what they were.
    const { store, list } = makeList(["X(u,v) = (u, v, 0)"]);
    document.body.append(list.root, list.card);
    list.refresh([{ rowId: store.rows()[0]!.id, errors: [], warnings: [], info: ["K = 0.000   H = 0.000"] }]);

    const info = list.card.querySelector<HTMLElement>(".row__info")!;
    expect(info.title).toContain("Gaussian curvature");
    expect(info.title).toContain("mean curvature");
  });
});

describe("sliders with a moving label", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("drops the number boxes so the track gets the width", () => {
    /**
     * The whole reason for the redesign: the readout and the exact-value box each held a fixed
     * column, so on a toolbar the track — the only part you manipulate — got what was left.
     */
    const { store, list } = makeList(["X(u,v) = (u, v, 0)"]);
    document.body.append(list.root, list.card);
    list.refresh([]);
    list.select(store.rows()[0]!.id);

    const domain = list.card.querySelector(".row__domain")!;
    expect(domain.querySelectorAll(".vslider__input").length).toBeGreaterThanOrEqual(2);
    // No number inputs left beside the tracks.
    expect(domain.querySelectorAll('input[type="number"]')).toHaveLength(0);
  });

  it("shows the value on a label rather than in a field", () => {
    const { list } = makeList(["R = 2"]);
    document.body.append(list.root);
    list.refresh([]);
    const bubble = list.root.querySelector(".vslider__bubble")!;
    expect(bubble.textContent).toContain("2");
  });

  it("opens an exact-value field on double-click, and widens the track for a value past its end", () => {
    /**
     * Removing the bounds boxes must not remove the ability to reach a value outside the track.
     * Typing past an end widens it instead of clamping — refusing a number the user explicitly
     * asked for is precisely what those boxes existed to prevent.
     */
    const { list } = makeList(["R = 2"]);
    document.body.append(list.root);
    list.refresh([]);

    const slider = list.root.querySelector<HTMLElement>(".row__value .vslider")!;
    const range = slider.querySelector<HTMLInputElement>(".vslider__input")!;
    const before = Number(range.max);

    slider.dispatchEvent(new Event("dblclick", { bubbles: true }));
    const field = slider.querySelector<HTMLInputElement>(".vslider__exact")!;
    expect(field).not.toBeNull();

    field.value = String(before + 50);
    field.dispatchEvent(new Event("blur"));

    expect(Number(range.max)).toBeGreaterThan(before);
    expect(Number(range.value)).toBeCloseTo(before + 50, 6);
    // And the field is gone again, replaced by the label.
    expect(slider.querySelector(".vslider__exact")).toBeNull();
    expect(slider.querySelector(".vslider__bubble")).not.toBeNull();
  });
});

describe("parameter values in the typeset view", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("substitutes a declared parameter's value into a surface", () => {
    /**
     * The typeset view is meant to show what is ON SCREEN, and what is on screen is a torus of
     * some particular size — so a bare `R` is a promise the reader has to go elsewhere to
     * redeem. Substituting keeps the formula and the object in agreement.
     */
    const { list } = makeList(["R = 2", "X(u,v) = (R cos u, R sin u, v)"]);
    document.body.append(list.root, list.card);
    list.refresh([]);

    const echoes = [...list.root.querySelectorAll(".formula__echo")];
    const surface = echoes[1]!;
    expect(surface.textContent).toContain("2");
    expect(surface.textContent).not.toContain("R");
  });

  it("leaves the chart coordinates symbolic", () => {
    // u and v are what the map is a function OF; substituting them would not be a value, it
    // would be evaluating the surface at a point.
    const { list } = makeList(["X(u,v) = (u, v, 0)"]);
    document.body.append(list.root, list.card);
    list.refresh([]);
    const echo = list.root.querySelector(".formula__echo")!;
    expect(echo.textContent).toContain("u");
    expect(echo.textContent).toContain("v");
  });
});

describe("duplicating a cell", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("copies the text into a new cell directly below", () => {
    const { store, list } = makeList(["X(u,v) = (u, v, 0)"]);
    document.body.append(list.root, list.card);
    list.refresh([]);

    const button = list.root.querySelector<HTMLElement>('.row__move[title*="duplicate"]')!;
    expect(button).not.toBeNull();
    button.click();

    const sources = store.rows().map((row) => row.source());
    expect(sources[0]).toBe("X(u,v) = (u, v, 0)");
    expect(sources[1]).toBe("X(u,v) = (u, v, 0)");
  });
});

describe("the properties window", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("never opens over the cell column", () => {
    /**
     * Selecting a row opens the window at the pointer, and the pointer is IN the column — so it
     * landed on top of the very cell just clicked and made it impossible to edit the thing being
     * inspected. It is pushed clear of the panel's right edge instead.
     */
    const { store, list } = makeList(["X(u,v) = (u, v, 0)"]);
    document.body.append(list.root, list.card);
    list.refresh([]);
    list.setPlacement("cursor");

    // A click well inside where the column would be.
    list.placeAt(20, 120);
    list.select(store.rows()[0]!.id);

    const left = Number.parseFloat(list.card.style.left);
    expect(Number.isFinite(left)).toBe(true);
    expect(left).toBeGreaterThanOrEqual(list.root.getBoundingClientRect().right);
  });

  it("keeps both placements available", () => {
    // Neither implementation was deleted; they are one DOM with a different class, so switching
    // must not reparent anything — reparenting is what detaches a focused control.
    const { list } = makeList(["X(u,v) = (u, v, 0)"]);
    document.body.append(list.root, list.card);
    const parent = list.card.parentElement;

    list.setPlacement("cursor");
    expect(list.card.classList.contains("props--at-cursor")).toBe(true);
    list.setPlacement("bar");
    expect(list.card.classList.contains("props--at-cursor")).toBe(false);
    expect(list.card.parentElement).toBe(parent);
  });
});

describe("the window in cursor placement", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("stays shut when a cell is clicked, and opens when the scene is", () => {
    /**
     * Selecting and revealing are different acts. Clicking a cell says which object you are
     * working on — that is what the highlight means — but popping a window over the cell being
     * typed into makes it uneditable. Only a click in the SCENE asks to see the controls.
     */
    const { store, list } = makeList(["X(u,v) = (u, v, 0)"]);
    document.body.append(list.root, list.card);
    list.refresh([]);
    list.setPlacement("cursor");
    const id = store.rows()[0]!.id;

    list.select(id, false);
    expect(list.card.classList.contains("props--empty")).toBe(true);
    // ...and the row is still selected, so the highlight and the card agree about what is chosen.
    expect(list.selected()).toBe(id);

    list.select(id, true);
    expect(list.card.classList.contains("props--empty")).toBe(false);
  });

  it("gives each domain variable one control with two thumbs", () => {
    // An interval is a single thing; two separate sliders made it look like two unrelated
    // numbers and took twice the room.
    const { store, list } = makeList(["X(u,v) = (u, v, 0)"]);
    document.body.append(list.root, list.card);
    list.refresh([]);
    list.select(store.rows()[0]!.id);

    const ranges = list.card.querySelectorAll(".domain__range");
    expect(ranges).toHaveLength(2);
    for (const range of ranges) {
      expect(range.querySelectorAll(".vslider__input")).toHaveLength(2);
    }
  });

  it("keeps the occasional controls out of the panel", () => {
    // The panel holds what needs room; the chips already carry their own outlines, so they float
    // beside it. Keeping them out is what lets the panel be small.
    const { store, list } = makeList(["X(u,v) = (u, v, 0)"]);
    document.body.append(list.root, list.card);
    list.refresh([]);
    list.select(store.rows()[0]!.id);

    const panel = list.card.querySelector(".props__panel-body")!;
    const tray = list.card.querySelector(".props__tray")!;
    expect(panel.querySelector(".row__domain")).not.toBeNull();
    expect(panel.querySelector(".chip")).toBeNull();
    expect(tray.querySelectorAll(".chip").length).toBeGreaterThan(0);
  });
});
