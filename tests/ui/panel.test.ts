// @vitest-environment happy-dom
import { describe, expect, it, beforeEach } from "vitest";
import { createDocument, type RowId } from "../../src/state/graph.ts";
import type { Vec3 } from "../../src/core/geom/types.ts";
import type { DomainRange, SurfaceOverlay } from "../../src/state/scene.ts";
import { createExprList, type SliderSpec } from "../../src/ui/exprList.ts";
import { createAnimator, type Animator } from "../../src/ui/animate.ts";

/**
 * Wiring tests for the panel, in a DOM.
 *
 * Every UI regression in this project so far has been a wiring fault invisible to the geometry
 * suite — a focused input replaced, a node reparented, a parent stealing a child's click, a
 * `value` attribute silently ignored on a textarea. None of them could fail a test, because there
 * were no tests that touched a DOM. These check the claims that keep being broken: that a control
 * exists, that it is attached where it is supposed to be, and that selecting a row reveals it.
 */

function makeList(
  sources: readonly string[],
  shared: {
    domains?: Map<RowId, DomainRange[]>;
    overlays?: Map<RowId, SurfaceOverlay>;
    inChart?: Set<RowId>;
    sliders?: Map<string, SliderSpec>;
    colors?: Map<RowId, Vec3>;
    animator?: Animator;
    onFlowTick?: (rowId: RowId, seconds: number) => void;
    onFlowRewind?: (rowId: RowId) => void;
    onFlowToggle?: (rowId: RowId) => void;
    onEnterSpace?: (rowId: RowId) => void;
  } = {},
) {
  const store = createDocument(sources);
  const list = createExprList({
    document: store,
    onEdit: () => {},
    onParameterChange: () => {},
    onFlowTick: shared.onFlowTick,
    onFlowRewind: shared.onFlowRewind,
    onFlowToggle: shared.onFlowToggle,
    onEnterSpace: shared.onEnterSpace,
    domains: shared.domains ?? new Map(),
    sliders: shared.sliders ?? new Map(),
    frames: new Map(),
    rowSliders: new Map(),
    inChart: shared.inChart ?? new Set(),
    animator: shared.animator ?? createAnimator(),
    overlays: shared.overlays ?? new Map(),
    colors: shared.colors ?? new Map(),
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

describe("the ends of a track", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("types a range onto a slider, both narrower and wider", () => {
    /**
     * A drag moves the value and never the range, so the range has to be sayable somewhere.
     * These are the boxes at the ends of the track: what they set is the scale, not the value.
     */
    const { list } = makeList(["R = 2"]);
    document.body.append(list.root, list.card);
    list.refresh([]);

    const cell = list.root.querySelector<HTMLElement>(".row__value")!;
    const [min, max] = [...cell.querySelectorAll<HTMLInputElement>(".slider__limit")];
    const range = cell.querySelector<HTMLInputElement>(".vslider__input")!;
    expect(min).toBeDefined();
    expect(Number(min!.value)).toBe(-4);
    expect(Number(max!.value)).toBe(4);

    max!.value = "3";
    max!.dispatchEvent(new Event("change"));
    expect(Number(range.max)).toBe(3);
    // The step follows the width, or a narrow range is dragged in jumps of the whole track.
    expect(Number(range.step)).toBeCloseTo(7 / 200, 12);

    min!.value = "100";
    min!.dispatchEvent(new Event("change"));
    // Ends given in the wrong order are still an interval; the boxes show which way it read.
    expect(Number(range.min)).toBe(3);
    expect(Number(range.max)).toBe(100);
    expect(Number(min!.value)).toBe(3);
    expect(Number(max!.value)).toBe(100);
  });

  it("carries the value into a range that no longer holds it", () => {
    /**
     * `R = 2` with the track moved to 10…20 must not leave the parameter at 2 while the thumb
     * sits at 10 — the row would then say one thing and the object show another.
     */
    const { store, list } = makeList(["R = 2"]);
    document.body.append(list.root, list.card);
    list.refresh([]);

    const cell = list.root.querySelector<HTMLElement>(".row__value")!;
    const [min, max] = [...cell.querySelectorAll<HTMLInputElement>(".slider__limit")];
    max!.value = "20";
    max!.dispatchEvent(new Event("change"));
    min!.value = "10";
    min!.dispatchEvent(new Event("change"));

    expect(store.parameters().get("R")).toBe(10);
    // The row is rewritten too, the same reconciliation a released drag does.
    expect(store.rows()[0]!.source()).toBe("R = 10");
  });

  it("refuses a range with no width, and keeps the number it had", () => {
    const { list } = makeList(["R = 2"]);
    document.body.append(list.root, list.card);
    list.refresh([]);

    const cell = list.root.querySelector<HTMLElement>(".row__value")!;
    const [min, max] = [...cell.querySelectorAll<HTMLInputElement>(".slider__limit")];
    const range = cell.querySelector<HTMLInputElement>(".vslider__input")!;

    max!.value = String(Number(min!.value));
    max!.dispatchEvent(new Event("change"));
    expect(Number(range.max)).toBe(4);
    expect(Number(max!.value)).toBe(4);

    max!.value = "not a number";
    max!.dispatchEvent(new Event("change"));
    expect(Number(range.max)).toBe(4);
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

    /**
     * Matched on "Gauss map", not "Gauss": the curvature chip is titled "paint Gaussian
     * curvature", so the looser match found that one instead and the test silently exercised the
     * wrong control.
     */
    const gauss = [...list.card.querySelectorAll<HTMLElement>(".chip")].find((chip) =>
      chip.title.startsWith("Gauss map"),
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

  it("keeps the readout off the track, and both bounds typable at its ends", () => {
    /**
     * The readout and the exact-value box each held a fixed column, so on a toolbar the track —
     * the only part you actually manipulate — got what was left. The value rides the thumb now.
     *
     * What each variable does have is one hairline box at each END of its track. That is not the
     * field-and-stepper form that was tried and rejected: the thumbs are still how a bound is
     * explored, and the boxes are how one is *said* — including the bound whose thumb is sitting
     * underneath the other one, which double-clicking cannot reach.
     */
    const { store, list } = makeList(["X(u,v) = (u, v, 0)"]);
    document.body.append(list.root, list.card);
    list.refresh([]);
    list.select(store.rows()[0]!.id);

    const domain = list.card.querySelector(".row__domain")!;
    // Two variables, each with a thumb at both ends of one shared track.
    expect(domain.querySelectorAll(".vslider__input")).toHaveLength(4);
    expect(domain.querySelectorAll(".slider__limit")).toHaveLength(4);
    // No readout field, and nothing to click a value up and down with.
    expect(domain.querySelectorAll('input[type="number"]:not(.slider__limit)')).toHaveLength(0);
    for (const row of domain.querySelectorAll(".domain")) {
      const boxes = [...row.querySelectorAll<HTMLInputElement>(".slider__limit")];
      expect(boxes).toHaveLength(2);
      // The lower bound at the left end and the upper at the right, in the order the thumbs
      // they belong to are read: where a box sits is what says which bound it is.
      expect(boxes[0]!.nextElementSibling!.classList.contains("domain__range")).toBe(true);
      expect(boxes[1]!.previousElementSibling!.classList.contains("domain__range")).toBe(true);
    }
  });

  it("types the ends of a domain track, and leaves them alone while a thumb moves", () => {
    /**
     * The boxes are the SCALE, not the bounds. A box that followed a thumb would change every
     * time the thumb was dragged — a second readout of what the bubble already says — and there
     * would be nowhere to state the one thing a drag deliberately cannot: how far the track
     * reaches.
     */
    const domains = new Map<RowId, DomainRange[]>();
    const { store, list } = makeList(["X(u,v) = (u, v, 0)"], { domains });
    document.body.append(list.root, list.card);
    list.refresh([]);
    const id = store.rows()[0]!.id;
    list.select(id);

    const row = list.card.querySelector(".row__domain .domain")!;
    const [min, max] = [...row.querySelectorAll<HTMLInputElement>(".slider__limit")];
    const [minThumb, maxThumb] = [...row.querySelectorAll<HTMLInputElement>(".vslider__input")];

    // Twice the interval either side of it, to start with: [0, 2π] centred on π.
    expect(Number(min!.value)).toBeCloseTo(-3 * Math.PI, 2);
    expect(Number(max!.value)).toBeCloseTo(5 * Math.PI, 2);

    // Dragging a bound moves the bound and nothing else.
    maxThumb!.value = "5";
    maxThumb!.dispatchEvent(new Event("input"));
    expect(domains.get(id)![0]!.max).toBe(5);

    // Typing an end rescales the track — both thumbs ride one, so both take it.
    max!.value = "8";
    max!.dispatchEvent(new Event("change"));
    expect(Number(maxThumb!.max)).toBe(8);
    expect(Number(minThumb!.max)).toBe(8);
    min!.value = "1";
    min!.dispatchEvent(new Event("change"));
    expect(Number(minThumb!.min)).toBe(1);
    // A bound left outside the new track would be a thumb off its own scale, so it comes along.
    expect(domains.get(id)![0]!.min).toBe(1);

    // An emptied box is not an end at the origin.
    max!.value = "";
    max!.dispatchEvent(new Event("change"));
    expect(Number(maxThumb!.max)).toBe(8);
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

  it("shows a parameter's value under its symbol, keeping both", () => {
    /**
     * Replacing `R` by 2 showed the value and destroyed the structure: `(R cos u, R sin u, v)`
     * says what the surface IS, and `(2 cos u, 2 sin u, v)` says what one instance measures. Both
     * are wanted, and they do not compete for the same space — the symbol keeps its place and the
     * number sits beneath it.
     */
    const { list } = makeList(["R = 2", "X(u,v) = (R cos u, R sin u, v)"]);
    document.body.append(list.root, list.card);
    list.refresh([]);

    const surface = [...list.root.querySelectorAll(".formula__echo")][1]!;
    expect(surface.textContent).toContain("2");
    expect(surface.textContent).toContain("R");
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

  it("copies the surface under a name of its own", () => {
    /**
     * A copy that kept its name would look like a copy and behave like a typo: two rows declaring
     * `X` is one definition overwritten, not two objects.
     */
    const { store, list } = makeList(["X(u,v) = (u, v, 0)"]);
    document.body.append(list.root, list.card);
    list.refresh([]);

    const button = list.root.querySelector<HTMLElement>('.row__move[title*="duplicate"]')!;
    expect(button).not.toBeNull();
    button.click();

    const sources = store.rows().map((row) => row.source());
    expect(sources[0]).toBe("X(u,v) = (u, v, 0)");
    expect(sources[1]!.startsWith("Y(")).toBe(true);
    // Same surface, different name.
    expect(sources[1]).toContain("u, v, 0");
  });

  it("copies the object, not the line of text", () => {
    /**
     * A copy that came back on the default domain, in another colour, with its face turned back
     * on is not the surface that was copied — those settings are half of what the user built.
     */
    const domains = new Map<RowId, DomainRange[]>();
    const colors = new Map<RowId, Vec3>();
    const overlays = new Map<RowId, SurfaceOverlay>();
    const { store, list } = makeList(["X(u,v) = (u, v, 0)"], { domains, colors, overlays });
    document.body.append(list.root, list.card);
    list.refresh([]);
    const original = store.rows()[0]!.id;
    domains.set(original, [{ min: 0, max: 1 }, { min: -2, max: 2 }]);
    colors.set(original, [0.2, 0.4, 0.6]);
    overlays.set(original, { fill: false, grid: true } as SurfaceOverlay);

    list.root.querySelector<HTMLElement>('.row__move[title*="duplicate"]')!.click();

    const copy = store.rows()[1]!.id;
    expect(domains.get(copy)).toEqual([{ min: 0, max: 1 }, { min: -2, max: 2 }]);
    expect(colors.get(copy)).toEqual([0.2, 0.4, 0.6]);
    expect(overlays.get(copy)?.fill).toBe(false);
    // Deep copies: dragging one object's domain must not drag the other's.
    domains.get(copy)![0]!.max = 9;
    expect(domains.get(original)![0]!.max).toBe(1);
  });

  it("copies what is drawn on the surface, re-pointed at the copy", () => {
    /**
     * A curve on a patch is part of that patch's picture. Copying the surface and leaving its
     * curves behind gives you a bare formula to re-decorate by hand, which is the work the copy
     * exists to avoid — and the re-pointing is the whole test, since a copied curve still naming
     * the original would draw two curves on one surface and none on the other.
     */
    const { store, list } = makeList([
      "X(u,v) = (u, v, 0)",
      "X: (u - a)^2 + (v - b)^2 = 1",
      "X: beta(t) = (t, 2 t)",
    ]);
    document.body.append(list.root, list.card);
    list.refresh([]);

    list.root.querySelector<HTMLElement>('.row__move[title*="duplicate"]')!.click();

    const sources = store.rows().map((row) => row.source());
    // The copy and its curves land together, straight below the original's own block.
    expect(sources[0]).toBe("X(u,v) = (u, v, 0)");
    expect(sources[1]!.startsWith("Y(")).toBe(true);
    expect(sources[2]).toBe("Y: (u - a)^2 + (v - b)^2 = 1");
    // A copied declaration gets a name of its own; the chart it names is the copy's.
    expect(sources[3]!.startsWith("Y: ")).toBe(true);
    expect(sources[3]).toContain("(t, 2 * t)");
    expect(sources[3]!.includes("beta(")).toBe(false);
    // And the originals still say X.
    expect(sources.filter((text) => text.startsWith("X: "))).toHaveLength(2);
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

  it("gives each domain variable one row with both ends on it", () => {
    // An interval is a single thing, so its two ends share a row — but side by side rather than
    // stacked on one track, which read as one control sitting on top of another.
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

  it("moves a bound by dragging its thumb, without moving the track's end", () => {
    const domains = new Map<RowId, DomainRange[]>();
    const { store, list } = makeList(["X(u,v) = (u, v, 0)"], { domains });
    document.body.append(list.root, list.card);
    list.refresh([]);
    const id = store.rows()[0]!.id;
    list.select(id);

    const track = list.card.querySelector(".domain__range")!;
    const max = track.querySelectorAll<HTMLInputElement>(".vslider__input")[1]!;
    const end = Number(max.max);

    max.value = String(Number(max.value) - 1);
    max.dispatchEvent(new Event("input", { bubbles: true }));
    expect(domains.get(id)![0]!.max).toBeCloseTo(2 * Math.PI - 1, 6);
    // The track it lives on is unchanged: a drag moves the bound, never the end.
    expect(Number(max.max)).toBeCloseTo(end, 9);
  });

  it("puts a bound changed from elsewhere back on its thumb", () => {
    // Undo, an opened file and a placed piece all rewrite a domain without touching the control.
    const domains = new Map<RowId, DomainRange[]>();
    const { store, list } = makeList(["X(u,v) = (u, v, 0)"], { domains });
    document.body.append(list.root, list.card);
    list.refresh([]);
    const id = store.rows()[0]!.id;
    list.select(id);

    domains.get(id)![0]!.min = 1;
    list.refresh([]);
    const min = list.card.querySelector<HTMLInputElement>(".domain__range .vslider__input")!;
    expect(Number(min.value)).toBeCloseTo(1, 6);
  });

  it("rebuilds a domain control when the new bound is off its track", () => {
    // Clamping silently would leave the control disagreeing with the domain it is supposed to
    // show, which is worse than the flicker of a rebuild.
    const domains = new Map<RowId, DomainRange[]>();
    const { store, list } = makeList(["X(u,v) = (u, v, 0)"], { domains });
    document.body.append(list.root, list.card);
    list.refresh([]);
    const id = store.rows()[0]!.id;
    list.select(id);

    domains.get(id)![0]!.max = 500;
    list.refresh([]);
    list.refresh([]);
    const max = list.card.querySelectorAll<HTMLInputElement>(".domain__range .vslider__input")[1]!;
    expect(Number(max.value)).toBeCloseTo(500, 6);
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
    // The panel holds what you reach for while looking at an object: its domain, its colour, and
    // whether curvature is painted on it.
    expect(panel.querySelector(".row__domain")).not.toBeNull();
    expect(panel.querySelector(".props__color")).not.toBeNull();
    // K, what of this patch is drawn — its face and its grid — the three things a patch can be
    // given (a curve in its chart, a tangent plane, a field along it), and the level set's own
    // "show all of it", which is hidden on a patch.
    expect(panel.querySelectorAll(".chip")).toHaveLength(7);
    // The occasional tools stay in the tray, which the floating form hides.
    expect(tray.querySelectorAll(".chip").length).toBeGreaterThan(1);
  });
});

describe("only the selected row's panel is on screen", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("shows exactly one body, however many rows exist", () => {
    /**
     * Every row's details live in the card at once and only the selected one is shown, so a
     * layout rule with higher specificity than the hiding rule reveals ALL of them — which is
     * precisely what happened: two surfaces stacked their sliders on top of each other. The
     * property is worth pinning because the failure looks like a rendering glitch rather than a
     * cascade problem.
     */
    const { store, list } = makeList([
      "X(u,v) = (u, v, 0)",
      "Y(u,v) = (v, u, 1)",
      "Z(u,v) = (u, u, v)",
    ]);
    document.body.append(list.root, list.card);
    list.refresh([]);
    list.setPlacement("cursor");

    for (const row of store.rows()) {
      list.select(row.id, true);
      const visible = list.card.querySelectorAll(".props__body:not(.props__body--hidden)");
      expect(visible, `row ${row.id}`).toHaveLength(1);
    }
  });
});

describe("dragging past a slider's end", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  /** happy-dom has no layout, so the track is given a box to measure against. */
  function withTrack(input: HTMLInputElement, width = 200) {
    input.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width, height: 16, right: width, bottom: 16, x: 0, y: 0 }) as DOMRect;
  }

  const move = (input: HTMLInputElement, type: string, clientX: number) =>
    input.dispatchEvent(new MouseEvent(type, { clientX, bubbles: true }));

  it("stops at the end of the track instead of moving it", () => {
    /**
     * The ends used to travel with the pointer, so a drag that overshot silently redefined what
     * the whole track meant and undid a range that had been set on purpose. A range is changed
     * deliberately now — by typing one — and never as a side effect of a drag.
     */
    const { list } = makeList(["R = 2"]);
    document.body.append(list.root);
    list.refresh([]);

    const input = list.root.querySelector<HTMLInputElement>(".row__value .vslider__input")!;
    withTrack(input);
    const before = { min: Number(input.min), max: Number(input.max) };
    input.value = input.max;

    move(input, "pointerdown", 200);
    move(input, "pointermove", 400);
    expect(Number(input.max)).toBeCloseTo(before.max, 9);

    input.value = input.min;
    move(input, "pointerdown", 0);
    move(input, "pointermove", -200);
    expect(Number(input.min)).toBeCloseTo(before.min, 9);
  });

  it("still lets a typed value past the end widen the track", () => {
    // The deliberate path, and now the only one.
    const { list } = makeList(["R = 2"]);
    document.body.append(list.root);
    list.refresh([]);

    const slider = list.root.querySelector<HTMLElement>(".row__value .vslider")!;
    const input = slider.querySelector<HTMLInputElement>(".vslider__input")!;
    const before = Number(input.max);

    slider.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    const field = slider.querySelector<HTMLInputElement>(".vslider__exact")!;
    field.value = String(before + 40);
    field.dispatchEvent(new FocusEvent("blur"));

    expect(Number(input.max)).toBeGreaterThan(before);
    expect(Number(input.value)).toBeCloseTo(before + 40, 6);
  });
});

describe("what the floating form actually shows", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("puts real domain sliders on screen when a surface is revealed", () => {
    /**
     * Reported as "I click the surface and see no sliders". The pointer path cannot be exercised
     * here — it needs a GPU pick — so this pins the half that can be: once a row is revealed in
     * the cursor placement, the sliders are present, visible, and in the visible body rather than
     * a hidden one.
     */
    const { store, list } = makeList(["X(u,v) = (u, v, 0)"]);
    document.body.append(list.root, list.card);
    list.refresh([]);
    list.setPlacement("cursor");
    list.placeAt(600, 300);
    list.select(store.rows()[0]!.id, true);

    expect(list.card.classList.contains("props--empty")).toBe(false);
    const body = list.card.querySelector(".props__body:not(.props__body--hidden)")!;
    expect(body).not.toBeNull();
    expect(body.querySelectorAll(".domain")).toHaveLength(2);
    expect(body.querySelectorAll(".vslider__input").length).toBe(4);
    // And the colour control travelled with them.
    expect(body.querySelector(".props__color")).not.toBeNull();
  });
});

describe("typing in a cell", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("keeps the caret when a new trailing cell appears", () => {
    /**
     * The bug: typing the first letter into the trailing cell creates the next empty cell, which
     * made the row order differ from the DOM's — and the reconciler answered that by re-appending
     * every view. `append` on an element that is already a child is a MOVE, so the browser
     * detached the very input being typed in and the cell defocused on the first keystroke.
     */
    const { store, list } = makeList(["X(u,v) = (u, v, 0)"]);
    document.body.append(list.root, list.card);
    list.refresh([]);

    // The trailing blank the list keeps at the end, focused as if being typed into.
    const inputs = [...list.root.querySelectorAll("textarea")];
    const trailing = inputs.at(-1)!;
    trailing.focus();
    expect(document.activeElement).toBe(trailing);

    trailing.value = "Y";
    store.rows().at(-1)!.source.set("Y");
    list.refresh([]);

    // A cell was added below it, and the one being typed in never moved.
    expect(store.rows().length).toBe(3);
    expect(document.activeElement).toBe(trailing);
    expect(trailing.isConnected).toBe(true);
  });

  it("puts the model's text back into a cell nobody is typing in", () => {
    // What undo needs: a row rewritten from outside has to show its new text.
    const { store, list } = makeList(["X(u,v) = (u, v, 0)"]);
    document.body.append(list.root, list.card);
    list.refresh([]);

    store.rows()[0]!.source.set("X(u,v) = (u, v, 7)");
    list.refresh([]);
    const first = list.root.querySelector("textarea")!;
    expect(first.value).toBe("X(u,v) = (u, v, 7)");
  });
});

describe("what of a patch is drawn", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("keeps what is drawn on its own row, below the colour and K", () => {
    /**
     * Two rows because they answer different questions: the colour and the curvature map are how
     * this object *looks*, the face and the grid are what there is to look at. Side by side they
     * also grow a wide bar under the pointer, which is the one place a floating panel must not.
     */
    const { store, list } = makeList(["X(u,v) = (u, v, 0)"]);
    document.body.append(list.root, list.card);
    list.refresh([]);
    list.select(store.rows()[0]!.id);

    const body = list.card.querySelector(".props__body:not(.props__body--hidden)")!;
    const groups = [...body.querySelectorAll(".props__chips > .props__swatches")];
    expect(groups).toHaveLength(2);
    expect(groups[0]!.querySelector(".props__color")).not.toBeNull();
    const tools = groups[1]!;
    expect(tools.classList.contains("props__tools")).toBe(true);
    // Glyphs for the two switches, each explained on hover; the word stays where a word is
    // needed, on the button that writes something.
    expect([...tools.querySelectorAll(".chip")].map((chip) => chip.textContent)).toEqual([
      "\u25fc",
      "\u25a6",
      "+ relation",
      "+ tangent",
      "+ field",
      // The fit switch is an icon, so it contributes no text — and it is hidden on a patch.
      "",
    ]);
    expect(tools.querySelector<HTMLButtonElement>(".chip")!.title).toContain("the face");
  });

  it("turns this patch's face off without touching any other", () => {
    /**
     * Per patch, not per scene: hiding one tube's face is how you see the geodesic running inside
     * it while everything around it stays solid.
     */
    const overlays = new Map<RowId, SurfaceOverlay>();
    const { store, list } = makeList(
      ["X(u,v) = (u, v, 0)", "Y(u,v) = (u, v, 1)"],
      { overlays },
    );
    document.body.append(list.root, list.card);
    list.refresh([]);
    const [first, second] = store.rows().map((row) => row.id);
    list.select(first!);

    const chips = [...list.card.querySelectorAll<HTMLButtonElement>(".props__body:not(.props__body--hidden) .props__chips .chip")];
    const face = chips.find((chip) => chip.title.startsWith("the face"))!;
    expect(face.classList.contains("chip--on")).toBe(true);

    face.click();
    expect(overlays.get(first!)?.fill).toBe(false);
    expect(face.classList.contains("chip--on")).toBe(false);
    // The other patch is untouched.
    expect(overlays.get(second!)).toBeUndefined();

    face.click();
    expect(overlays.get(first!)?.fill).toBe(true);
  });

  it("keeps a hidden face hidden when another overlay control commits", () => {
    // The overlay controls rewrite their whole record on every commit, so anything they do not
    // own has to be read back — or a patch would light up again the next time a spray slider
    // moved.
    const overlays = new Map<RowId, SurfaceOverlay>();
    const { store, list } = makeList(["X(u,v) = (u, v, 0)"], { overlays });
    document.body.append(list.root, list.card);
    list.refresh([]);
    const id = store.rows()[0]!.id;
    list.select(id);

    const face = [...list.card.querySelectorAll<HTMLButtonElement>(".chip")]
      .find((chip) => chip.title.startsWith("the face"))!;
    face.click();
    expect(overlays.get(id)?.fill).toBe(false);

    // Any overlay control committing: the colour-map menu is the simplest to drive.
    const select = list.card.querySelector<HTMLSelectElement>(".props__tray select");
    if (select) {
      select.value = "solid";
      select.dispatchEvent(new Event("change"));
    }
    expect(overlays.get(id)?.fill).toBe(false);
  });
});

describe("a cell that has to be typed in", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("never records a height measured while it was hidden", () => {
    /**
     * The collapsed cell. A row showing its typeset form has its field hidden, a hidden field
     * reports `scrollHeight` 0, and writing that back pins an inline `height: 0px` that beats the
     * stylesheet forever after — so the next time the row has no typeset form to fall back on,
     * the field it falls back to is a sliver.
     */
    const { store, list } = makeList(["X(u,v) = (u, v, 0)"]);
    document.body.append(list.root, list.card);
    list.refresh([]);

    const input = list.root.querySelector<HTMLTextAreaElement>("textarea")!;
    // jsdom lays nothing out, so every field reports 0 — which is precisely the hidden case.
    expect(input.style.height).not.toBe("0px");

    // And a row that stops parsing falls back to a field with a height of its own.
    store.rows()[0]!.source.set("X(u,v) = (");
    list.refresh([]);
    expect(input.style.height).not.toBe("0px");
  });
});

describe("one parameter, however many rows use it", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  /** Two surfaces with a relation apiece, both stated in terms of the same `k`. */
  const shared = () =>
    makeList([
      "X(u,v) = (u, v, 0)",
      "Y(u,v) = (u, v, 1)",
      "X: u + v = k",
      "Y: u + v = k",
    ]);

  it("moves every slider for a name when one of them moves", () => {
    /**
     * `k` belongs to the document, not to a row: it is one number, and the scene draws that one
     * number. Two cards showing 5.65 and 8.06 for the same `k` means at least one of them is
     * lying about what is on screen.
     */
    const { store, list } = shared();
    document.body.append(list.root, list.card);
    // One refresh is enough: the specs are created before the rows' controls are built, or a
    // brand-new parameter would have no slider until something else was edited.
    list.refresh([]);

    const tracks = [...list.root.querySelectorAll<HTMLInputElement>(".row__params .vslider__input")];
    expect(tracks.length).toBe(2);
    tracks[0]!.value = "3";
    tracks[0]!.dispatchEvent(new Event("input"));

    expect(store.parameters().get("k")).toBe(3);
    expect(Number(tracks[1]!.value)).toBe(3);
  });

  it("moves every track's ends too, so the two are read against one scale", () => {
    const { list } = shared();
    document.body.append(list.root, list.card);
    list.refresh([]);

    const rows = [...list.root.querySelectorAll<HTMLElement>(".row__params .slider")];
    const endsOf = (row: HTMLElement) =>
      [...row.querySelectorAll<HTMLInputElement>(".slider__limit")].map((box) => box.value);
    const [first, second] = rows;
    const max = [...first!.querySelectorAll<HTMLInputElement>(".slider__limit")][1]!;

    max.value = "2";
    max.dispatchEvent(new Event("change"));
    expect(endsOf(second!)).toEqual(endsOf(first!));
    const track = second!.querySelector<HTMLInputElement>(".vslider__input")!;
    expect(Number(track.max)).toBe(2);
  });
});

describe("the chart a row says it is in", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("typesets the prefix as a colon, not as the word", () => {
    /**
     * `\colon` in the KaTeX string, which means `\\colon` in the template literal it is written
     * in — a single backslash there is an unknown JS escape that silently becomes the letter, and
     * the cell read "Xcolon u + v = 2".
     */
    const { store, list } = makeList(["X(u,v) = (u, v, 0)", "X: u + v = 2"]);
    document.body.append(list.root, list.card);
    list.refresh([]);

    const echo = [...list.root.querySelectorAll(".formula__echo")][1]!;
    expect(echo.textContent).not.toContain("colon");
    expect(echo.textContent).toContain(":");
    void store;
  });

  it("shows the prefix even before the formula is written", () => {
    // What the "+ relation" button opens: the patch is named, the relation is not there yet.
    const { list } = makeList(["X(u,v) = (u, v, 0)", "X: "]);
    document.body.append(list.root, list.card);
    list.refresh([]);
    const echo = [...list.root.querySelectorAll(".formula__echo")][1]!;
    expect(echo.querySelector(".echo-empty")).not.toBeNull();
    expect(echo.textContent).toContain(":");
  });
});

describe("a relation in a patch's own chart", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("opens a cell that already names the patch, ready to type in", () => {
    /**
     * A relation between u and v is a curve in *someone's* chart, and the formula cannot say
     * whose. So the row says it: `X:` is the whole binding, and the button's job is to write that
     * part and get out of the way — visible in the document, saved with it, undone with it.
     */
    const { store, list } = makeList(["X(u,v) = (u, v, 0)", "Y(u,v) = (u, v, 1)"]);
    document.body.append(list.root, list.card);
    list.refresh([]);
    const second = store.rows()[1]!.id;
    list.select(second);

    // Scoped to the visible block: every row's details live in the card at once, so an
    // unscoped query finds the first row's button rather than the selected row's.
    const body = list.card.querySelector(".props__body:not(.props__body--hidden)")!;
    const button = [...body.querySelectorAll<HTMLButtonElement>(".chip")]
      .find((chip) => chip.textContent?.includes("relation"))!;
    expect(button).toBeDefined();
    button.click();

    // The patch it was made from, not the first one in the document.
    const added = store.rows().find((row) => row.source().startsWith("Y:"))!;
    expect(added).toBeDefined();
    expect(added.source()).toBe("Y: ");

    // In edit mode, focused, with the caret after the prefix rather than over it.
    const cell = [...list.root.querySelectorAll<HTMLElement>(".row")].find(
      (candidate) =>
        candidate.querySelector<HTMLTextAreaElement>("textarea")?.value === "Y: ",
    )!;
    expect(cell.classList.contains("row--editing")).toBe(true);
    const input = cell.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(globalThis.document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(3);
  });

  it("seeds the constants of a hosted relation over that patch's own domain", () => {
    /**
     * ±5 is the wrong track twice over for a constant living in a chart: it hides most of a
     * domain running to 2π and wastes most of one running to 1. The reach past each end is the
     * size of a curve that fits the patch, which is about where such a curve leaves the chart
     * and there is nothing more to see.
     */
    const domains = new Map<RowId, DomainRange[]>();
    const sliders = new Map<string, SliderSpec>();
    const { store, list } = makeList(["X(u,v) = (u, v, 0)"], { domains, sliders });
    document.body.append(list.root, list.card);
    domains.set(store.rows()[0]!.id, [{ min: 0, max: 2 }, { min: -1, max: 1 }]);

    store.addRow("X: (u - a)^2 + (v - b)^2 = 0.25");
    list.refresh([]);

    // Both sides are 2 wide, so a curve that fits the patch has radius 2/3.
    const reach = 2 / 3;
    expect(sliders.get("a")!.value).toBe(1);
    expect(sliders.get("a")!.min).toBeCloseTo(0 - reach, 12);
    expect(sliders.get("a")!.max).toBeCloseTo(2 + reach, 12);
    expect(sliders.get("b")!.value).toBe(0);
    expect(sliders.get("b")!.min).toBeCloseTo(-1 - reach, 12);
    expect(sliders.get("b")!.max).toBeCloseTo(1 + reach, 12);
    expect(store.parameters().get("a")).toBe(1);
  });

  it("leaves an unhosted parameter on the symmetric default", () => {
    const sliders = new Map<string, SliderSpec>();
    const { store, list } = makeList(["alpha(t) = (t, k t, 0)"], { sliders });
    document.body.append(list.root, list.card);
    void store;
    list.refresh([]);
    expect(sliders.get("k")).toEqual({ value: 1, min: -5, max: 5, step: 0.01 });
  });

  it("offers the button on patches only", () => {
    const { store, list } = makeList(["X(u,v) = (u, v, 0)", "R = 2"]);
    document.body.append(list.root, list.card);
    list.refresh([]);

    const buttonFor = (id: number) => {
      list.select(id);
      list.refresh([]);
      const body = list.card.querySelector(".props__body:not(.props__body--hidden)")!;
      return [...body.querySelectorAll<HTMLButtonElement>(".chip")]
        .find((chip) => chip.textContent?.includes("relation"));
    };
    expect(buttonFor(store.rows()[0]!.id)?.hidden).toBe(false);
    expect(buttonFor(store.rows()[1]!.id)?.hidden).toBe(true);
  });
});

describe("a tangent plane in the row list", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("typesets the point as a subscript, the way T_p is written", () => {
    const { list } = makeList(["X(u,v) = (u, v, 0)", "T_(1, 2) X"]);
    document.body.append(list.root, list.card);
    list.refresh([]);

    const echo = [...list.root.querySelectorAll(".formula__echo")][1]!;
    // Typeset, not fallen through to the dash a row that parses as nothing shows.
    expect(echo.querySelector(".katex")).not.toBeNull();
    expect(echo.textContent).toContain("1");
    expect(echo.textContent).toContain("2");
    expect(echo.textContent).toContain("X");
  });

  it("names it a tangent plane rather than leaving it unrecognized", () => {
    // The card's heading names what the selected row IS, so a row the classifier did not
    // recognize would read "expression" here.
    const { store, list } = makeList(["X(u,v) = (u, v, 0)", "T_(1, 2) X"]);
    document.body.append(list.root, list.card);
    list.refresh([]);
    list.select(store.rows()[1]!.id);
    expect(list.card.querySelector(".props__title")!.textContent).toBe("tangent plane");
  });

  it("opens a row at the centre of the patch's own domain", () => {
    /**
     * The same default the geodesic spray takes, for the same reason: a control that needs a
     * point picked before it shows anything shows nothing. The centre needs no interaction and
     * is reproducible from the document alone — and it is written into the row as two numbers,
     * so it can be edited or given a parameter afterwards.
     */
    const domains = new Map<RowId, DomainRange[]>();
    const { store, list } = makeList(["X(u,v) = (u, v, 0)"], { domains });
    document.body.append(list.root, list.card);
    list.refresh([]);
    const id = store.rows()[0]!.id;
    domains.set(id, [{ min: 0, max: 2 }, { min: -1, max: 1 }]);
    list.select(id);

    const body = list.card.querySelector(".props__body:not(.props__body--hidden)")!;
    [...body.querySelectorAll<HTMLButtonElement>(".chip")]
      .find((chip) => chip.textContent?.includes("tangent"))!
      .click();

    /**
     * Written with the prefix spelling, because that is the one that can carry an address: a
     * patch named after the parenthesis is a single identifier, and a patch inside a space is
     * `A:sigma`. Both spellings mean the same row.
     */
    const added = store.rows().find((row) => row.source().includes("T_"))!;
    expect(added.source()).toBe("X: T_(1, 0)");

    // In edit mode, focused, with the caret after it, like the relation button.
    const cell = [...list.root.querySelectorAll<HTMLElement>(".row")].find(
      (candidate) =>
        candidate.querySelector<HTMLTextAreaElement>("textarea")?.value === added.source(),
    )!;
    expect(cell.classList.contains("row--editing")).toBe(true);
    const input = cell.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(input.selectionStart).toBe(added.source().length);
  });

  it("comes along when its patch is copied, pointing at the copy", () => {
    /**
     * The tangent plane names its patch AFTER the point, so re-pointing it is a rewrite in place
     * rather than a prefix. Given a prefix instead, the copy would read `Y: T_(1,2) X` and go on
     * being drawn on the original.
     */
    const { store, list } = makeList(["X(u,v) = (u, v, 0)", "T_(1, 2) X"]);
    document.body.append(list.root, list.card);
    list.refresh([]);

    list.root.querySelector<HTMLElement>('.row__move[title*="duplicate"]')!.click();

    const sources = store.rows().map((row) => row.source());
    expect(sources[1]!.startsWith("Y(")).toBe(true);
    expect(sources[2]).toBe("T_(1, 2) Y");
    expect(sources[3]).toBe("T_(1, 2) X");
  });
});

describe("a vector field in the row list", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("opens a row holding the patch's own coordinate field ∂X/∂v", () => {
    /**
     * No generic default is tangent to an arbitrary patch — the only vectors that are come from
     * its own derivatives. So the button differentiates the row's formula through the CAS the
     * geometry runs on, and writes the result as ambient components: tangent by construction,
     * and ordinary text to edit afterwards.
     */
    const { store, list } = makeList(["X(u,v) = (sin u cos v, sin u sin v, cos u)"]);
    document.body.append(list.root, list.card);
    list.refresh([]);
    list.select(store.rows()[0]!.id);

    const body = list.card.querySelector(".props__body:not(.props__body--hidden)")!;
    [...body.querySelectorAll<HTMLButtonElement>(".chip")]
      .find((chip) => chip.textContent?.includes("field"))!
      .click();

    const added = store.rows().find((row) => row.source().includes("VectorField"))!;
    expect(added.source().startsWith("X: VectorField(")).toBe(true);
    // ∂/∂v of (sin u cos v, sin u sin v, cos u) = (−sin u sin v, sin u cos v, 0).
    const item = store.resolution().items.get(added.id);
    expect(item?.kind).toBe("surfaceField");
    expect(item?.host).toBe("X");
    expect(added.source()).toContain("0)");
  });

  it("typesets the components as a vector", () => {
    const { list } = makeList(["X(u,v) = (u, v, 0)", "X: VectorField(1, 0, 0)"]);
    document.body.append(list.root, list.card);
    list.refresh([]);
    const echo = [...list.root.querySelectorAll(".formula__echo")][1]!;
    expect(echo.querySelector(".katex")).not.toBeNull();
    // The patch it is stated in is still shown, since the row still says it.
    expect(echo.textContent).toContain(":");
  });

  it("names it a vector field", () => {
    const { store, list } = makeList(["X(u,v) = (u, v, 0)", "X: VectorField(1, 0, 0)"]);
    document.body.append(list.root, list.card);
    list.refresh([]);
    list.select(store.rows()[1]!.id);
    expect(list.card.querySelector(".props__title")!.textContent).toBe("vector field");
  });

  it("offers the field button only on a parametric patch", () => {
    // The seed is ∂X/∂v, read off a formula a graph patch does not have in that form.
    const { store, list } = makeList(["z = x^2 - y^2"]);
    document.body.append(list.root, list.card);
    list.refresh([]);
    list.select(store.rows()[0]!.id);
    const body = list.card.querySelector(".props__body:not(.props__body--hidden)")!;
    const field = [...body.querySelectorAll<HTMLButtonElement>(".chip")]
      .find((chip) => chip.textContent?.includes("field"))!;
    expect(field.hidden).toBe(true);
  });
});

describe("playing a field's flow", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("puts the transport on the field's own cell, not in the card", () => {
    /**
     * The bug this exists to catch, twice over. The transport was built into the properties
     * tray, and the floating placement hides the tray on purpose — so a field row had a play
     * button nobody could ever see. Even in the top bar it was in the wrong place: a field's
     * flow is to its row what a slider is to a numeric one, and it is reached for while looking
     * at the row. One copy only, or two play buttons paint their own state and disagree.
     */
    const { store, list } = makeList(["X(u,v) = (u, v, 0)", "X: VectorField(1, 0, 0)"]);
    document.body.append(list.root, list.card);
    list.refresh([]);
    list.setPlacement("cursor");
    list.select(store.rows()[1]!.id);

    const cells = [...list.root.querySelectorAll<HTMLElement>(".row")];
    expect(cells[1]!.querySelector(".flow .transport")).not.toBeNull();
    // Not in the card at all — in either placement.
    expect(list.card.querySelector(".flow")).toBeNull();
  });

  it("gives a field row a transport, and a surface row none", () => {
    const { list } = makeList(["X(u,v) = (u, v, 0)", "X: VectorField(1, 0, 0)"]);
    document.body.append(list.root, list.card);
    list.refresh([]);

    const cells = [...list.root.querySelectorAll<HTMLElement>(".row")];
    expect(cells[1]!.querySelector(".flow .transport")).not.toBeNull();
    expect(cells[0]!.querySelector(".flow")).toBeNull();
  });

  it("advances the row's flow, and nothing else, once played", () => {
    /**
     * The transport is the animator's, so a flow shares one clock and one speed with every
     * parameter sweep on screen — but what it drives is a callback the app answers by moving
     * particles and painting them, never a rebuild of the document.
     */
    const animator = createAnimator();
    const ticked: Array<[RowId, number]> = [];
    const { store, list } = makeList(["X(u,v) = (u, v, 0)", "X: VectorField(1, 0, 0)"], {
      animator,
      onFlowTick: (rowId, seconds) => ticked.push([rowId, seconds]),
    });
    document.body.append(list.root, list.card);
    list.refresh([]);
    const fieldRow = store.rows()[1]!.id;
    const cell = [...list.root.querySelectorAll<HTMLElement>(".row")][1]!;
    const play = [...cell.querySelectorAll<HTMLButtonElement>(".flow .transport__button")].at(-1)!;

    animator.step(0.02);
    expect(ticked).toEqual([]);

    play.click();
    expect(animator.playing(`flow:${fieldRow}`)).toBe(true);
    // A flow reports no movement: rebuilding the scene per frame is what this must not do.
    expect(animator.step(0.02)).toBe(false);
    expect(ticked).toEqual([[fieldRow, 0.02]]);

    play.click();
    animator.step(0.02);
    expect(ticked).toHaveLength(1);
  });

  it("reseeds on rewind rather than sweeping back", () => {
    const animator = createAnimator();
    const rewound: RowId[] = [];
    const { store, list } = makeList(["X(u,v) = (u, v, 0)", "X: VectorField(1, 0, 0)"], {
      animator,
      onFlowRewind: (rowId) => rewound.push(rowId),
    });
    document.body.append(list.root, list.card);
    list.refresh([]);
    const fieldRow = store.rows()[1]!.id;
    const cell = [...list.root.querySelectorAll<HTMLElement>(".row")][1]!;
    const buttons = [...cell.querySelectorAll<HTMLButtonElement>(".flow .transport__button")];
    buttons[0]!.click();
    expect(rewound).toEqual([fieldRow]);
  });

  it("keeps playing while the row list refreshes under it", () => {
    // A refresh rebuilds the row's controls; the particles are not in the DOM, and the animator
    // preserves play state across re-registration precisely so a rebuild is invisible.
    const animator = createAnimator();
    const ticked: number[] = [];
    const { store, list } = makeList(["X(u,v) = (u, v, 0)", "X: VectorField(1, 0, 0)"], {
      animator,
      onFlowTick: (_rowId, seconds) => ticked.push(seconds),
    });
    document.body.append(list.root, list.card);
    list.refresh([]);
    const fieldRow = store.rows()[1]!.id;
    animator.play(`flow:${fieldRow}`);

    list.refresh([]);
    list.refresh([]);
    animator.step(0.02);
    expect(animator.playing(`flow:${fieldRow}`)).toBe(true);
    // Once per step, however many times the controls were rebuilt.
    expect(ticked).toEqual([0.02]);
  });

  it("stops asking for frames once the row is deleted", () => {
    /**
     * The animator outlives the row list, so a ticker left behind goes on asking for frames for a
     * row that no longer exists — which keeps the frame loop running for nothing.
     */
    const animator = createAnimator();
    const ticked: number[] = [];
    const { store, list } = makeList(["X(u,v) = (u, v, 0)", "X: VectorField(1, 0, 0)"], {
      animator,
      onFlowTick: (_rowId, seconds) => ticked.push(seconds),
    });
    document.body.append(list.root, list.card);
    list.refresh([]);
    const fieldRow = store.rows()[1]!.id;
    animator.play(`flow:${fieldRow}`);

    const remove = [...list.root.querySelectorAll<HTMLElement>(".row")][1]!
      .querySelector<HTMLElement>('.row__move[title*="remove"], button[title*="remove"]')!;
    remove.click();
    animator.step(0.02);
    expect(ticked).toEqual([]);
    expect(animator.playing(`flow:${fieldRow}`)).toBe(false);
  });

  it("drops the flow when the row stops being a field", () => {
    const animator = createAnimator();
    const ticked: number[] = [];
    const { store, list } = makeList(["X(u,v) = (u, v, 0)", "X: VectorField(1, 0, 0)"], {
      animator,
      onFlowTick: (_rowId, seconds) => ticked.push(seconds),
    });
    document.body.append(list.root, list.card);
    list.refresh([]);
    const fieldRow = store.rows()[1]!.id;
    animator.play(`flow:${fieldRow}`);

    store.rows()[1]!.source.set("X: u + v = 1");
    list.refresh([]);
    animator.step(0.02);
    expect(ticked).toEqual([]);
  });
});

describe("the colour of an object, on its own cell", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  const gutters = (list: ReturnType<typeof makeList>["list"]) =>
    [...list.root.querySelectorAll<HTMLElement>(".row__gutter")];

  it("shows a dot for everything that draws, and none for what does not", () => {
    const { list } = makeList(["a = 2", "X(u,v) = (u, v, 0)", "X: VectorField(1, 0, 0)"]);
    document.body.append(list.root, list.card);
    list.refresh([]);

    const rows = [...list.root.querySelectorAll<HTMLElement>(".row")];
    // A parameter draws nothing: a swatch beside it would offer to paint something that is not
    // on screen.
    expect(rows[0]!.querySelector<HTMLElement>(".row__gutter")!.hidden).toBe(true);
    expect(rows[1]!.querySelector<HTMLElement>(".row__gutter")!.hidden).toBe(false);
    expect(rows[2]!.querySelector<HTMLElement>(".row__gutter")!.hidden).toBe(false);
  });

  it("reports the colour the scene actually drew, not a guess", () => {
    /**
     * The defaults are not one rule — a curve takes a palette entry by document order, a patch
     * the shade under its curvature map — so the scene says which colour it used and the dot
     * shows that. A dot inventing its own would be a swatch that lies about the object beside it.
     */
    const { store, list } = makeList(["alpha(t) = (cos t, sin t, t)"]);
    document.body.append(list.root, list.card);
    const rowId = store.rows()[0]!.id;
    list.refresh([], new Map([[rowId, [1, 0, 0] as Vec3]]));

    const dot = list.root.querySelector<HTMLElement>(".gutter__dot")!;
    expect(dot.style.background).toBe("#ff0000");
  });

  it("lets the chosen colour win over the drawn one", () => {
    const colors = new Map<RowId, Vec3>();
    const { store, list } = makeList(["alpha(t) = (cos t, sin t, t)"], { colors });
    document.body.append(list.root, list.card);
    const rowId = store.rows()[0]!.id;
    colors.set(rowId, [0, 0, 1]);
    list.refresh([], new Map([[rowId, [1, 0, 0] as Vec3]]));

    expect(list.root.querySelector<HTMLElement>(".gutter__dot")!.style.background).toBe("#0000ff");
  });

  it("hides an object from the eye on its cell, and says which state it is in", () => {
    /**
     * The eye is the blunt switch: closed, the row draws nothing at all, whatever kind of thing
     * it is. That is what separates it from the dot, which for a patch takes the face off and
     * leaves the grid. It writes `hidden` into the overlays record, which undo snapshots and the
     * file keeps, so being switched off is part of the figure.
     */
    const overlays = new Map<RowId, SurfaceOverlay>();
    const { store, list } = makeList(["X(u,v) = (u, v, 0)"], { overlays });
    document.body.append(list.root, list.card);
    list.refresh([]);
    const rowId = store.rows()[0]!.id;

    const eye = () => list.root.querySelector<HTMLButtonElement>(".gutter__eye")!;
    expect(eye().title).toBe("hide this object");
    eye().click();
    expect(overlays.get(rowId)?.hidden).toBe(true);

    list.refresh([]);
    expect(eye().title).toBe("draw this object");
    expect(eye().classList.contains("gutter__eye--off")).toBe(true);

    eye().click();
    expect(overlays.get(rowId)?.hidden).toBe(false);
  });

  it("opens the colour input from the pencil", () => {
    // The input is off screen and exists for no other reason than to be opened by this click.
    const { list } = makeList(["X(u,v) = (u, v, 0)"]);
    document.body.append(list.root, list.card);
    list.refresh([]);

    let opened = 0;
    const field = list.root.querySelector<HTMLInputElement>(".gutter__input")!;
    field.addEventListener("click", () => opened++);
    list.root.querySelector<HTMLButtonElement>(".gutter__pencil")!.click();
    expect(opened).toBe(1);
  });

  it("paints the object, and keeps the card's swatch in step", () => {
    /**
     * One value, two controls — the pencil on the cell and the swatch in the card — so it is
     * written in one place and pushed back to both. Two controls that each held their own copy
     * would disagree the moment either was used, which is the bug the play buttons already had.
     */
    const colors = new Map<RowId, Vec3>();
    const { store, list } = makeList(["X(u,v) = (u, v, 0)"], { colors });
    document.body.append(list.root, list.card);
    list.refresh([]);
    const rowId = store.rows()[0]!.id;
    list.select(rowId);

    const field = list.root.querySelector<HTMLInputElement>(".gutter__input")!;
    field.value = "#00ff00";
    field.dispatchEvent(new Event("input"));

    expect(colors.get(rowId)![1]).toBeCloseTo(1, 5);
    expect(colors.get(rowId)![0]).toBeCloseTo(0, 5);
    expect(list.card.querySelector<HTMLInputElement>(".props__color")!.value).toBe("#00ff00");
    expect(list.root.querySelector<HTMLElement>(".gutter__dot")!.style.background).toBe("#00ff00");
  });

  it("takes a colour chosen in the card back to the dot", () => {
    const colors = new Map<RowId, Vec3>();
    const { store, list } = makeList(["X(u,v) = (u, v, 0)"], { colors });
    document.body.append(list.root, list.card);
    list.refresh([]);
    list.select(store.rows()[0]!.id);

    const swatch = list.card.querySelector<HTMLInputElement>(".props__color")!;
    swatch.value = "#123456";
    swatch.dispatchEvent(new Event("input"));

    expect(list.root.querySelector<HTMLElement>(".gutter__dot")!.style.background).toBe("#123456");
    expect(list.root.querySelector<HTMLInputElement>(".gutter__input")!.value).toBe("#123456");
  });

  it("does not overwrite the input while it is open", () => {
    // The same rule every other control in the file follows: the field wins while it has focus.
    const { store, list } = makeList(["X(u,v) = (u, v, 0)"]);
    document.body.append(list.root, list.card);
    list.refresh([]);
    const field = list.root.querySelector<HTMLInputElement>(".gutter__input")!;
    field.focus();
    field.value = "#abcdef";
    list.refresh([], new Map([[store.rows()[0]!.id, [1, 0, 0] as Vec3]]));
    expect(field.value).toBe("#abcdef");
    void gutters;
  });
});

describe("a field's arrows", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("gets a switch on the field's cell, and nowhere else", () => {
    const { list } = makeList(["X(u,v) = (u, v, 0)", "X: VectorField(1, 0, 0)"]);
    document.body.append(list.root, list.card);
    list.refresh([]);

    const rows = [...list.root.querySelectorAll<HTMLElement>(".row")];
    expect(rows[1]!.querySelector('.flow .chip[title*="arrows"]')).not.toBeNull();
    expect(rows[0]!.querySelector('.chip[title*="arrows"]')).toBeNull();
  });

  it("records the choice where undo and the file can see it", () => {
    /**
     * In the overlays record, which is the same kind of thing — what of an object is drawn — and
     * is already snapshotted, saved and keyed by row.
     */
    const overlays = new Map<RowId, SurfaceOverlay>();
    const { store, list } = makeList(["X(u,v) = (u, v, 0)", "X: VectorField(1, 0, 0)"], {
      overlays,
    });
    document.body.append(list.root, list.card);
    list.refresh([]);
    const fieldRow = store.rows()[1]!.id;

    const chip = [...list.root.querySelectorAll<HTMLButtonElement>(".flow .chip")][0]!;
    expect(chip.classList.contains("chip--on")).toBe(true);
    chip.click();
    expect(overlays.get(fieldRow)?.arrows).toBe(false);
    expect(chip.classList.contains("chip--on")).toBe(false);
    chip.click();
    expect(overlays.get(fieldRow)?.arrows).toBe(true);
  });

  it("asks for a repaint whenever the transport is pressed", () => {
    // Play hides the arrows and pause brings them back, and neither is a rebuild — so the press
    // has to say that the frame changed.
    const toggled: RowId[] = [];
    const { store, list } = makeList(["X(u,v) = (u, v, 0)", "X: VectorField(1, 0, 0)"], {
      onFlowToggle: (rowId) => toggled.push(rowId),
    });
    document.body.append(list.root, list.card);
    list.refresh([]);
    const cell = [...list.root.querySelectorAll<HTMLElement>(".row")][1]!;
    [...cell.querySelectorAll<HTMLButtonElement>(".flow .transport__button")].at(-1)!.click();
    expect(toggled).toEqual([store.rows()[1]!.id]);
  });
});

describe("the dot switches the object off", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  /** A list whose onEdit refreshes, which is what the app does and where the bugs live. */
  function livingList(sources: readonly string[], overlays: Map<RowId, SurfaceOverlay>) {
    const store = createDocument(sources);
    const list = createExprList({
      document: store,
      onEdit: () => list.refresh([]),
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
    return { store, list };
  }

  const dots = (list: { root: HTMLElement }) =>
    [...list.root.querySelectorAll<HTMLButtonElement>(".gutter__dot")];

  it("takes a patch's face off and leaves its grid", () => {
    // A surface with its face off still has its outline, which is the half you want left behind
    // while looking at whatever the face was covering.
    const overlays = new Map<RowId, SurfaceOverlay>();
    const { store, list } = livingList(["X(u,v) = (u, v, 0)"], overlays);
    const rowId = store.rows()[0]!.id;

    dots(list)[0]!.click();
    expect(overlays.get(rowId)?.fill).toBe(false);
    expect(overlays.get(rowId)?.grid ?? true).toBe(true);
    expect(dots(list)[0]!.classList.contains("gutter__dot--off")).toBe(true);

    dots(list)[0]!.click();
    expect(overlays.get(rowId)?.fill).toBe(true);
    expect(dots(list)[0]!.classList.contains("gutter__dot--off")).toBe(false);
  });

  it("stops a curve being drawn at all", () => {
    // Nothing to keep: a curve with its colour taken away is a curve that is not there.
    const overlays = new Map<RowId, SurfaceOverlay>();
    const { store, list } = livingList(["alpha(t) = (cos t, sin t, t)"], overlays);
    const rowId = store.rows()[0]!.id;

    dots(list)[0]!.click();
    expect(overlays.get(rowId)?.hidden).toBe(true);
    dots(list)[0]!.click();
    expect(overlays.get(rowId)?.hidden).toBe(false);
  });

  it("takes a field's arrows off, through the same switch the chip holds", () => {
    const overlays = new Map<RowId, SurfaceOverlay>();
    const { store, list } = livingList(
      ["X(u,v) = (u, v, 0)", "X: VectorField(1, 0, 0)"],
      overlays,
    );
    const fieldRow = store.rows()[1]!.id;

    dots(list)[1]!.click();
    expect(overlays.get(fieldRow)?.arrows).toBe(false);
    // One value, two controls: the chip has to say the same thing after the dot was used.
    const chip = list.root.querySelectorAll<HTMLButtonElement>(".flow .chip")[0]!;
    expect(chip.classList.contains("chip--on")).toBe(false);
  });

  it("keeps the switch through a refresh, which is what erased it before", () => {
    /**
     * The bug: `syncOverlayControl` deleted the whole overlay record for any row that is not a
     * patch, because the record used to describe only patches. A field's arrows and any row's
     * dot now live there too, so a refresh erased them — the chip turned itself back on and the
     * arrows never went away.
     */
    const overlays = new Map<RowId, SurfaceOverlay>();
    const { store, list } = livingList(
      ["X(u,v) = (u, v, 0)", "X: VectorField(1, 0, 0)", "alpha(t) = (t, t, t)"],
      overlays,
    );
    const [, field, curve] = store.rows();

    const chip = list.root.querySelectorAll<HTMLButtonElement>(".flow .chip")[0]!;
    chip.click();
    dots(list)[2]!.click();
    list.refresh([]);
    list.refresh([]);

    expect(overlays.get(field!.id)?.arrows).toBe(false);
    expect(overlays.get(curve!.id)?.hidden).toBe(true);
    expect(chip.classList.contains("chip--on")).toBe(false);

    // And clicking a second time really does turn it back on.
    chip.click();
    expect(overlays.get(field!.id)?.arrows).toBe(true);
    expect(chip.classList.contains("chip--on")).toBe(true);
  });

  it("keeps a level set in grid view across a rebuild", () => {
    /**
     * The bug this exists to catch. `syncOverlayControl` rewrites the overlay record for any row
     * that is not a *parametric* patch, and it only carried across the flags it knew about — so a
     * level set switched to grid view lost its `fill: false` on the very next refresh, and the
     * face came back the next time anything rebuilt the scene. Turning an object off is not
     * chart business; `fill`, `grid` and the colour map belong to anything that is drawn.
     */
    const overlays = new Map<RowId, SurfaceOverlay>();
    const { store, list } = livingList(["x^2 + y^2 + z^2 = 1"], overlays);
    const rowId = store.rows()[0]!.id;
    expect(store.resolution().items.get(rowId)?.kind).toBe("implicitSurface");

    dots(list)[0]!.click();
    expect(overlays.get(rowId)?.fill).toBe(false);

    // What rotating the object does: rebuild, refresh, rebuild again.
    list.refresh([]);
    list.refresh([]);
    expect(overlays.get(rowId)?.fill).toBe(false);
    expect(dots(list)[0]!.classList.contains("gutter__dot--off")).toBe(true);
  });

  it("gives a level set a switch for showing all of it", () => {
    /**
     * Its sliders are a window, not a domain — so the one request they cannot express is "as far
     * as it goes, in every direction". The switch says that, and while it is on the sliders are
     * visibly inert rather than silently ignored.
     */
    const overlays = new Map<RowId, SurfaceOverlay>();
    const { store, list } = livingList(["x^2 + y^2 + z^2 = 1"], overlays);
    const rowId = store.rows()[0]!.id;
    list.select(rowId);

    const body = list.card.querySelector(".props__body:not(.props__body--hidden)")!;
    const fit = [...body.querySelectorAll<HTMLButtonElement>(".chip")].find((chip) =>
      chip.title.includes("every direction"),
    )!;
    expect(fit.hidden).toBe(false);
    fit.click();
    expect(overlays.get(rowId)?.autoBox).toBe(true);
    expect(body.querySelector(".row__domain")!.classList.contains("row__domain--ignored")).toBe(
      true,
    );

    // And it survives the rebuild, like every other flag about what is drawn.
    list.refresh([]);
    list.refresh([]);
    expect(overlays.get(rowId)?.autoBox).toBe(true);

    fit.click();
    expect(overlays.get(rowId)?.autoBox).toBe(false);
  });

  it("hides that switch on a patch, whose domain IS part of the surface", () => {
    const { store, list } = livingList(["X(u,v) = (u, v, 0)"], new Map());
    list.select(store.rows()[0]!.id);
    const body = list.card.querySelector(".props__body:not(.props__body--hidden)")!;
    const fit = [...body.querySelectorAll<HTMLButtonElement>(".chip")].find((chip) =>
      chip.title.includes("every direction"),
    )!;
    expect(fit.hidden).toBe(true);
  });

  it("gives a level set the face and grid chips, and no chart tools", () => {
    // A level set has a face and a grid — its grid is where the ambient coordinates cut it — and
    // no chart, so nothing can be stated in a (u, v) it does not have.
    const overlays = new Map<RowId, SurfaceOverlay>();
    const { store, list } = livingList(["x^2 + y^2 + z^2 = 1"], overlays);
    list.select(store.rows()[0]!.id);

    const body = list.card.querySelector(".props__body:not(.props__body--hidden)")!;
    const chips = [...body.querySelectorAll<HTMLButtonElement>(".chip")].filter(
      (chip) => !chip.hidden,
    );
    const labels = chips.map((chip) => chip.textContent);
    expect(labels).toContain("\u25fc");
    expect(labels).toContain("\u25a6");
    expect(labels).not.toContain("+ relation");
    expect(labels).not.toContain("+ tangent");
  });

  it("keeps a patch's own settings when the dot is used on it", () => {
    // The surface controls rewrite the record from their closure locals on every commit, so the
    // dot's answer has to be carried across the same way `start` is.
    const overlays = new Map<RowId, SurfaceOverlay>();
    const { store, list } = livingList(["X(u,v) = (u, v, 0)"], overlays);
    const rowId = store.rows()[0]!.id;
    list.select(rowId);

    dots(list)[0]!.click();
    list.refresh([]);
    expect(overlays.get(rowId)?.fill).toBe(false);
  });
});

describe("focusing an object and opening its controls are two acts", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("selects without opening the window, and opens when asked", () => {
    /**
     * What splits a single click on a surface from a double click. Selecting decides what the
     * inset charts and which cell is highlighted; opening puts a panel of sliders under the
     * pointer, over the object just pointed at. A glance should do the first and not the second.
     */
    const { store, list } = makeList(["X(u,v) = (u, v, 0)"]);
    document.body.append(list.root, list.card);
    list.refresh([]);
    list.setPlacement("cursor");
    const rowId = store.rows()[0]!.id;

    list.select(rowId, false);
    expect(list.selected()).toBe(rowId);
    // Selected, highlighted, and no window.
    expect(list.root.querySelector(".row--selected")).not.toBeNull();
    expect(list.card.classList.contains("props--empty")).toBe(true);

    list.select(rowId, true);
    expect(list.card.classList.contains("props--empty")).toBe(false);
    // And the sliders are what opening it is for.
    const body = list.card.querySelector(".props__body:not(.props__body--hidden)")!;
    expect(body.querySelector(".row__domain .vslider")).not.toBeNull();
  });

  it("reports the selection either way, so the chart follows a plain click", () => {
    // The inset shows the selected patch, and it is `onSelect` that tells the app so. A focus
    // that did not report would leave the corner showing another surface's chart.
    const selected: Array<RowId | null> = [];
    const store = createDocument(["X(u,v) = (u, v, 0)", "Y(u,v) = (u, v, 1)"]);
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
      onSelect: (id) => selected.push(id),
    });
    document.body.append(list.root, list.card);
    list.refresh([]);

    list.select(store.rows()[1]!.id, false);
    expect(selected).toEqual([store.rows()[1]!.id]);
  });
});

describe("nothing in a cell is clipped away", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("keeps a parameter's transport in its row, beside the track", () => {
    /**
     * The bug this exists to catch: the colour gutter made the cell body narrower, and the row
     * had `overflow: hidden` so its rounded corners would clip the gutter — which silently cut
     * the play button off the end of every slider. A control that is in the DOM and not on the
     * screen is the worst of both, so the structure is asserted here and the CSS keeps the row
     * unclipped.
     */
    const { list } = makeList(["f(u) = k u"]);
    document.body.append(list.root, list.card);
    list.refresh([]);

    const slider = list.root.querySelector<HTMLElement>(".row__body .slider")!;
    expect(slider.querySelector(".vslider")).not.toBeNull();
    // The transport is the last thing in the row, after both typed ends.
    expect(slider.lastElementChild!.classList.contains("transport")).toBe(true);
    expect(slider.querySelectorAll(".transport__button")).toHaveLength(2);
  });
});

describe("every transport sets its own rate", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("leaves the other transports alone", () => {
    /**
     * They moved together first, on the reasoning that two things playing at once are being
     * compared. A document usually has several animations about different questions — a radius
     * creeping while a flow runs — and one dial made every choice a compromise between them.
     */
    const animator = createAnimator();
    const { list } = makeList(["f(u) = k u", "g(u) = m u"], { animator });
    document.body.append(list.root, list.card);
    list.refresh([]);

    const speeds = [...list.root.querySelectorAll<HTMLSelectElement>(".transport__speed")];
    expect(speeds.length).toBeGreaterThanOrEqual(2);
    speeds[0]!.value = "4";
    speeds[0]!.dispatchEvent(new Event("change"));

    expect(animator.speed("param:k")).toBe(4);
    expect(animator.speed("param:m")).toBe(1);
    // And the other control still shows its own rate rather than following along.
    expect(speeds[1]!.value).toBe("1");
  });
});

describe("the panel inside an ambient space", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  const visible = (list: { root: HTMLElement }) =>
    [...list.root.querySelectorAll<HTMLElement>(".row")].filter(
      (row) => !row.classList.contains("row--out-of-scope"),
    ).length;

  it("shows the object, what is stated on it, and what it is built from", () => {
    /**
     * Everything else belongs to a scene that is not on screen, and showing it would make the
     * panel a list of things the stage refuses to draw. But a torus whose R and r were hidden
     * would be a torus with half its controls missing, so the rows it is *built from* stay.
     */
    const { store, list } = makeList([
      "R = 2",
      "X(u,v) = (R sin u cos v, R sin u sin v, R cos u)",
      "Y(u,v) = (u, v, 3)",
      "X: (1, 2, 3)",
    ]);
    document.body.append(list.root, list.card);
    list.refresh([]);
    const before = visible(list);

    list.setScope({ name: "X", rowId: store.rows()[1]!.id });
    list.refresh([]);

    const rows = [...list.root.querySelectorAll<HTMLElement>(".row")];
    const out = (index: number) => rows[index]!.classList.contains("row--out-of-scope");
    expect(out(0), "R is what X is built from").toBe(false);
    expect(out(1), "X itself").toBe(false);
    expect(out(2), "Y belongs to another space").toBe(true);
    expect(out(3), "the point is stated on X").toBe(false);

    // And leaving puts everything back, without rebuilding a thing.
    list.setScope(null);
    list.refresh([]);
    expect(visible(list)).toBe(before);
  });

  it("keeps the cell you are writing in visible", () => {
    /**
     * The bug this exists to catch: membership was read off the resolution, and a row being typed
     * has no item — `X: ` alone resolves to nothing, and neither does half a formula. So the cell
     * vanished at the exact moment somebody wrote in it, which made ambient space impossible to
     * type into. The prefix is text, so the text is what decides.
     */
    const { store, list } = makeList(["X(u,v) = (u, v, 0)"]);
    document.body.append(list.root, list.card);
    list.refresh([]);
    list.setScope({ name: "X", rowId: store.rows()[0]!.id });
    list.refresh([]);

    const cell = () =>
      [...list.root.querySelectorAll<HTMLElement>(".row")].find(
        (row) => row.querySelector("textarea")?.value.startsWith("X: "),
      )!;
    expect(cell().classList.contains("row--out-of-scope")).toBe(false);

    // Half-written, and still on screen.
    const input = cell().querySelector("textarea")!;
    input.value = "X: alpha(t) = (cos t,";
    store.rows().at(-1)!.source.set(input.value);
    list.refresh([]);
    expect(cell().classList.contains("row--out-of-scope")).toBe(false);

    // Finished, and still on screen — now as a row of the space.
    store.rows().at(-1)!.source.set("X: alpha(t) = (cos t, sin t, t)");
    list.refresh([]);
    const finished = [...list.root.querySelectorAll<HTMLElement>(".row")].find(
      (row) => row.querySelector("textarea")?.value.includes("alpha"),
    )!;
    expect(finished.classList.contains("row--out-of-scope")).toBe(false);
  });

  it("makes a space from the panel, and offers the way into it there", () => {
    /**
     * A space draws nothing of itself, so it is the one object that cannot be entered by
     * double-clicking it on the stage: the arrow lives on its cell. Spaces are numbered A_1,
     * A_2, … as they are made, which is how anyone refers to them.
     */
    const opened: RowId[] = [];
    const { store, list } = makeList([], { onEnterSpace: (id: RowId) => opened.push(id) });
    document.body.append(list.root, list.card);
    list.refresh([]);

    const add = [...list.root.querySelectorAll<HTMLButtonElement>(".cells__action")].find(
      (button) => button.textContent === "+ space",
    )!;
    const spaces = () => store.rows().filter((row) => row.source().includes("AmbientSpace"));
    add.click();
    expect(spaces().map((row) => row.source())).toEqual(["A_1 = AmbientSpace"]);
    add.click();
    expect(spaces().map((row) => row.source())).toEqual([
      "A_1 = AmbientSpace",
      "A_2 = AmbientSpace",
    ]);

    list.refresh([]);
    const arrows = [...list.root.querySelectorAll<HTMLButtonElement>(".row__enter")];
    const shown = arrows.filter((arrow) => !arrow.hidden);
    expect(shown, "one per space, and none on anything else").toHaveLength(2);
    shown[0]!.click();
    expect(opened).toEqual([spaces()[0]!.id]);
  });

  it("scopes the panel to a space, and to the rows addressed inside it", () => {
    const { store, list } = makeList([
      "A = AmbientSpace",
      "B = AmbientSpace",
      "A: sigma(u,v) = (u, v, 0)",
      "A:sigma: u + v = 1",
      "B: tau(u,v) = (u, v, 1)",
    ]);
    document.body.append(list.root, list.card);
    list.refresh([]);
    list.setScope({ name: "A", rowId: store.rows()[0]!.id });
    list.refresh([]);

    const rows = [...list.root.querySelectorAll<HTMLElement>(".row")];
    const out = (index: number) => rows[index]!.classList.contains("row--out-of-scope");
    expect(out(0), "A itself").toBe(false);
    expect(out(2), "the chart written in A").toBe(false);
    expect(out(3), "the relation addressed A:sigma:").toBe(false);
    expect(out(1), "the other space").toBe(true);
    expect(out(4), "and what is in it").toBe(true);

    // A new cell in A already says so, which is what makes anything typed there land in A.
    expect(store.rows().at(-1)!.source()).toBe("A: ");
  });

  it("keeps a surface written in the space, and what is stated on that surface", () => {
    /**
     * A space you cannot build in is a viewer. Writing a second surface inside X's space puts it
     * there, and a field stated on *that* surface is stated on something in the space, so it is in
     * the space too — one level of host would show the new patch and hide everything drawn on it.
     * A slider stays whatever happens: a number belongs to the document, not to any one object.
     */
    const { store, list } = makeList([
      "X(u,v) = (u, v, 0)",
      "X: Y(u,v) = (u, v, 2)",
      "Y: VectorField(1, 0, 0)",
      "k = 3",
      "Z(u,v) = (u, v, 5)",
    ]);
    document.body.append(list.root, list.card);
    list.refresh([]);
    list.setScope({ name: "X", rowId: store.rows()[0]!.id });
    list.refresh([]);

    const rows = [...list.root.querySelectorAll<HTMLElement>(".row")];
    const out = (index: number) => rows[index]!.classList.contains("row--out-of-scope");
    expect(out(0), "X itself").toBe(false);
    expect(out(1), "Y is written in X's space").toBe(false);
    expect(out(2), "the field is stated on Y").toBe(false);
    expect(out(3), "a number belongs to the document").toBe(false);
    expect(out(4), "Z is another object entirely").toBe(true);
  });

  it("starts a new cell in the space it is written in", () => {
    // Everything typed inside an ambient space belongs to it, so the empty cell says so before
    // you type — the same thing the "+ relation" button does, applied to the cell that is always
    // there.
    const { store, list } = makeList(["X(u,v) = (u, v, 0)"]);
    document.body.append(list.root, list.card);
    list.refresh([]);

    list.setScope({ name: "X", rowId: store.rows()[0]!.id });
    list.refresh([]);
    expect(store.rows().at(-1)!.source()).toBe("X: ");

    // And a bare prefix still counts as empty, so trailing cells collapse as they always did.
    list.refresh([]);
    list.refresh([]);
    expect(store.rows().filter((row) => row.source() === "X: ")).toHaveLength(1);

    list.setScope(null);
    expect(store.rows().at(-1)!.source()).toBe("");
  });
});
