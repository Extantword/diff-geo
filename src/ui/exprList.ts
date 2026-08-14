import type { Diagnostic } from "../core/expr/diagnostics.ts";
import type { Vec3 } from "../core/geom/types.ts";
import {
  COLORMAP_LABEL,
  COLORMAP_NAMES,
  type ColormapName,
} from "../core/geom/colormaps.ts";
import { toLatex } from "../core/expr/latex.ts";
import { parse, parseRow } from "../core/expr/parse.ts";
import { toSource } from "../core/expr/print.ts";
import { ctx, type Expr } from "../core/expr/ast.ts";
import type { DocumentStore, Item, RowId } from "../state/graph.ts";
import {
  DEFAULT_DOMAIN,
  type DomainRange,
  type FrameRequest,
  type RowReport,
  type SurfaceOverlay,
} from "../state/scene.ts";
import type { Animator } from "./animate.ts";
import { el, formatValue, replace } from "./dom.ts";
import { tex } from "./tex.ts";

/**
 * The expression list: a Desmos-style stack of rows, plus sliders that appear on their own.
 *
 * ## The two rules this file exists to obey
 *
 * **A row's `<input>` is created once and never replaced.** Everything else in the row —
 * the typeset echo, the kind badge, the diagnostics, the readout — is refreshed in place
 * around it. Replacing the input would destroy focus and the caret on every keystroke.
 *
 * **Auto-sliders are the affordance that makes formula entry feel alive.** Typing `a u`
 * with no definition for `a` should produce a slider immediately, not an error telling you
 * to go and declare something. The document reports every undefined symbol as a free
 * parameter; this file materializes one slider per name and never asks.
 */

/** Short decimal for a slider-written literal; a full-precision float is unreadable in a row. */
function format(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toFixed(4)));
}

const KIND_LABEL: Readonly<Record<string, string>> = {
  scalar: "scalar",
  planeCurve: "plane curve",
  spaceCurve: "space curve",
  parametricSurface: "surface",
  graphSurface: "graph",
  implicitSurface: "implicit surface",
  implicitPlaneCurve: "implicit curve",
  point: "point",
  vectorField: "vector field",
  functionDefinition: "definition",
  chartGraph: "chart graph",
  chartRelation: "chart relation",
  unknown: "?",
};

/** Not yet drawn by the renderer; the badge says so rather than failing silently. */
const NOT_YET_DRAWN = new Set(["implicitSurface", "implicitPlaneCurve", "vectorField"]);

export interface SliderSpec {
  value: number;
  min: number;
  max: number;
  step: number;
}

export interface ExprListOptions {
  readonly document: DocumentStore;
  /**
   * A row's text changed. Debounced by the caller: a half-typed formula should not render.
   */
  readonly onEdit: (refit: boolean) => void;
  /**
   * Only a parameter value changed — no text, no structure.
   *
   * Kept separate because it wants *throttling*, not debouncing. A slider must give
   * continuous feedback while it moves, whereas a debounce would show nothing until the drag
   * stopped and then jump.
   */
  readonly onParameterChange: () => void;
  /** Per-row domain ranges, mutated in place by the domain inputs. */
  readonly domains: Map<RowId, DomainRange[]>;
  /** Slider state, mutated in place. */
  readonly sliders: Map<string, SliderSpec>;
  /** Which curve rows show a moving frame, and where along the curve. */
  readonly frames: Map<RowId, FrameRequest>;
  /** Slider bounds for rows that define a plain number, keyed by row. */
  readonly rowSliders: Map<RowId, SliderSpec>;
  /** Plane-curve rows to read as curves in the chart rather than in the z = 0 plane. */
  readonly inChart: Set<RowId>;
  /** Drives play / pause / rewind on any slider. */
  readonly animator: Animator;
  /** Per-surface overlays: geodesic sprays, lines of curvature, the Gauss map. */
  readonly overlays: Map<RowId, SurfaceOverlay>;
  /** Per-row colour, for every part of the scene that row draws. */
  readonly colors: Map<RowId, Vec3>;
}

export interface ExprList {
  readonly root: HTMLElement;
  /** The floating properties card, for the caller to mount over the scene. */
  readonly card: HTMLElement;
  /** Show a row's properties, or `null` to close the card. Also driven by picking in 3D. */
  select(id: RowId | null): void;
  selected(): RowId | null;
  /**
   * Where the properties live: the strip along the top, or a window at the pointer.
   *
   * Both are kept. They are the same DOM with a different class — no reparenting, which would
   * detach whatever control had focus — so switching between them costs nothing and neither
   * implementation has to be deleted to try the other.
   */
  setPlacement(mode: "bar" | "cursor"): void;
  /** Remember where to open the window, for the cursor placement. */
  placeAt(x: number, y: number): void;
  /** Full refresh: echoes, badges, controls, diagnostics. For structural changes. */
  refresh(reports: readonly RowReport[]): void;
  /**
   * Update only the per-row readouts.
   *
   * Used on the throttled parameter path. Nothing structural can have changed there, so this
   * skips reparsing and re-typesetting every row — which is what a slider drag was paying for
   * on each frame.
   */
  refreshReports(reports: readonly RowReport[]): void;
  /**
   * Force the sliders to be rebuilt on the next refresh.
   *
   * The rebuild guard keys off the parameter *names*, which is what keeps a refresh from
   * replacing a range input mid-drag. Loading a template re-seeds the specs behind those same
   * names with different bounds, so it has to say so explicitly rather than relying on the
   * name list to have changed.
   */
  invalidateSliders(): void;
}

interface RowView {
  readonly id: RowId;
  readonly root: HTMLElement;
  readonly input: HTMLTextAreaElement;
  readonly echo: HTMLElement;
  readonly badge: HTMLElement;
  readonly notes: HTMLElement;
  readonly domainHost: HTMLElement;
  readonly frameHost: HTMLElement;
  /** the variables the domain fields were built for, so they are not rebuilt needlessly */
  domainVars: string;
  /** host for the inline slider a numeric row gets */
  readonly valueHost: HTMLElement;
  /** host for the chart toggle a plane-curve row gets */
  readonly chartHost: HTMLElement;
  /** host for the geodesic and curvature-line controls a surface row gets */
  readonly overlayHost: HTMLElement;
  /**
   * This row's properties, shown in the floating card when the row is selected.
   *
   * Every row's details block lives in the card the whole time; selection only toggles which one
   * is VISIBLE. Nothing is ever reparented, which matters because moving a DOM node detaches and
   * reinserts it — blurring any focused descendant — and because the sync functions can then go
   * on updating a row's controls whether or not it happens to be on screen.
   */
  readonly details: HTMLElement;
  readonly colorSwatch: HTMLInputElement;
  /** this row's colour-map menu, once its surface controls exist */
  colormapSelect: HTMLSelectElement | null;
  readonly detailsTitle: HTMLElement;
  /** sliders for the free parameters THIS row uses */
  readonly paramHost: HTMLElement;
  /** the parameter names those sliders were built for */
  paramNames: string;
  overlayBuilt: boolean;
  /** the name the inline slider was built for, or "" if there is none */
  valueName: string;
}

export function createExprList(options: ExprListOptions): ExprList {
  const { document: store } = options;

  const rowHost = el("div", { class: "rows" });

  /**
   * The floating properties card.
   *
   * Lives over the scene rather than in the panel, so the expression list stays what it says it
   * is — a list of inputs — and so properties appear next to the object they describe when it is
   * selected by clicking it in the scene.
   */
  const cardTitle = el("span", { class: "props__title", text: "properties" });
  const cardBody = el("div", { class: "props__slot" });
  /**
   * Shown when nothing is selected, so the strip keeps its height.
   *
   * The strip must never appear and disappear: doing so resizes the stage, which changes the
   * canvas aspect and shifts the camera — so clicking a surface to inspect it nudged the very
   * thing being inspected. Its height is reserved always, and this is what occupies it.
   */
  const cardPlaceholder = el("span", {
    class: "props__placeholder",
    text: "select an object to edit it",
  });
  const card = el("div", { class: "props props--empty" }, [
    el("div", { class: "props__head" }, [
      cardTitle,
      cardPlaceholder,
      el("button", {
        class: "props__close",
        title: "close",
        text: "\u00d7",
        onClick: () => select(null),
      }),
    ]),
    cardBody,
  ]);

  let selectedId: RowId | null = null;
  let placement: "bar" | "cursor" = "bar";
  let cursorX = 0;
  let cursorY = 0;

  /**
   * Keep the window on screen.
   *
   * Opening flush against the pointer puts it off the right or bottom edge whenever the click is
   * near one, which is exactly where a surface tends to be clicked when it fills the view.
   */
  const positionAtCursor = () => {
    if (placement !== "cursor") return;
    const margin = 8;
    const width = card.offsetWidth || 320;
    const height = card.offsetHeight || 220;
    const maxX = globalThis.innerWidth - width - margin;
    const maxY = globalThis.innerHeight - height - margin;
    card.style.left = `${Math.max(margin, Math.min(maxX, cursorX + 12))}px`;
    card.style.top = `${Math.max(margin, Math.min(maxY, cursorY + 12))}px`;
  };

  /**
   * Show one row's properties, or none.
   *
   * Selection is a property of the LIST rather than of a row so that the scene and the list can
   * drive it interchangeably: clicking a surface in 3D and clicking its row are the same act, and
   * both have to land in one place or the highlight and the card can disagree.
   */
  const select = (id: RowId | null) => {
    selectedId = id;
    for (const [rowId, view] of views) {
      const chosen = rowId === id;
      view.details.classList.toggle("props__body--hidden", !chosen);
      view.root.classList.toggle("row--selected", chosen);
      if (chosen) cardTitle.textContent = view.detailsTitle.textContent ?? "properties";
    }
    // The strip stays in the layout either way; only its CONTENTS change. See the placeholder.
    card.classList.toggle("props--empty", id === null || !views.has(id));
    positionAtCursor();
  };

  const views = new Map<RowId, RowView>();
  /** the parameter list the sliders were built for */
  let renderedSliders = "\u0000";
  /** Rows whose chart default has already been applied, so a later edit does not re-apply it. */
  const seenChartRows = new Set<RowId>();


  /**
   * Create and destroy row elements to match the document, leaving existing rows' DOM
   * untouched. This is the keyed-list reconciliation the design notes insisted on writing
   * before any feature UI: without it, editing row 1 rebuilds row 2 and steals its focus.
   */
  /**
   * Keep exactly one empty cell at the end.
   *
   * Typing into the last cell immediately opens another below it, so there is always somewhere to
   * write and never an "add" button to find. Trailing empties beyond the first are collapsed, so
   * the bar cannot grow a tail of blanks.
   */
  const ensureTrailingCell = () => {
    const rows = store.rows();
    const trailing: RowId[] = [];
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i]!.source().trim() !== "") break;
      trailing.push(rows[i]!.id);
    }
    if (trailing.length === 0) {
      store.addRow("");
      return true;
    }
    let changed = false;
    // Keep the LAST empty cell rather than the first, so the one the user is looking at survives.
    for (const id of trailing.slice(1)) {
      /**
       * Never collapse the cell the caret is in.
       *
       * Without this, CLEARING a cell just above the trailing blank makes it a trailing blank
       * too — and it would be deleted mid-keystroke, out from under the user. Emptying a cell
       * has to be a survivable state, because it is on the way to retyping it.
       */
      if (views.get(id)?.input === globalThis.document.activeElement) continue;
      store.removeRow(id);
      views.get(id)?.root.remove();
      views.get(id)?.details.remove();
      views.delete(id);
      if (selectedId === id) select(null);
      changed = true;
    }
    return changed;
  };

  const syncRows = () => {
    // Before laying anything out, so the new blank cell is created in the same pass and the list
    // is only walked once.
    ensureTrailingCell();
    const rows = store.rows();
    const seen = new Set<RowId>();

    for (const row of rows) {
      seen.add(row.id);
      if (!views.has(row.id)) {
        const view = createRowView(row.id);
        views.set(row.id, view);
        // Every row's details block joins the card immediately and stays there; only visibility
        // changes with selection, so nothing is ever reparented out from under a focused field.
        view.details.classList.add("props__body--hidden");
        cardBody.append(view.details);
      }
    }
    for (const [id, view] of views) {
      if (!seen.has(id)) {
        view.root.remove();
        view.details.remove();
        views.delete(id);
        if (selectedId === id) select(null);
      }
    }
    /**
     * Reorder only when the order is actually wrong.
     *
     * `append` on an element that is already a child is a **move**: the browser detaches and
     * reinserts it, which blurs any focused descendant. Doing that unconditionally on every
     * refresh meant the formula input lost focus after each keystroke — the same class of bug
     * as replacing the input outright, arriving by a different route. So the DOM is only
     * touched when the desired order genuinely differs from the current one, which is almost
     * never.
     */
    const desired = rows.map((row) => views.get(row.id)).filter((view) => view !== undefined);
    const current = Array.from(rowHost.children);
    const alreadyOrdered =
      desired.length === current.length &&
      desired.every((view, index) => view!.root === current[index]);

    if (!alreadyOrdered) {
      for (const view of desired) rowHost.append(view!.root);
    }
  };

  function createRowView(id: RowId): RowView {
    const row = store.rows().find((candidate) => candidate.id === id)!;

    /**
     * A textarea, not an input, so a formula can be laid out over several lines.
     *
     * The lexer already skips newlines, so multi-line text was always parseable — the only thing
     * standing in the way was a single-line field to type it into. Enter therefore inserts a line
     * break rather than committing; Escape leaves the cell.
     */
    const input = el("textarea", {
      class: "field field--mono row__input",
      value: row.source(),
      spellcheck: "false",
      rows: 1,
      placeholder: "X(u,v) = (…, …, …)",
      onInput: () => {
        row.source.set(input.value);
        // Only this row's echo can have changed, so only this row's echo is re-typeset.
        // Re-rendering every row's KaTeX on each keystroke was a measurable cost for text
        // that did not move.
        refreshEcho(views.get(id));
        // Typing into the last cell opens the next one. `syncRows` is only called when that
        // actually changed something, so an ordinary keystroke costs nothing extra.
        if (ensureTrailingCell()) syncRows();
        autoSize(input);
        options.onEdit(false);
      },
    }) as HTMLTextAreaElement;

    const echo = el("div", { class: "formula__echo" });
    const badge = el("span", { class: "row__badge" });
    const notes = el("div", { class: "row__notes" });
    const domainHost = el("div", { class: "row__domain" });
    const frameHost = el("div", { class: "row__frame" });
    const valueHost = el("div", { class: "row__value" });
    const chartHost = el("div", { class: "row__chart" });
    const overlayHost = el("div", { class: "row__overlay" });

    const remove = el("button", {
      class: "row__remove",
      title: "remove this expression",
      text: "×",
      onClick: (event: Event) => {
        // Removing is not selecting: without this the click would also open the card for a row
        // that is about to stop existing.
        event.stopPropagation();
        store.removeRow(id);
        views.get(id)?.root.remove();
        views.get(id)?.details.remove();
        views.delete(id);
        if (selectedId === id) select(null);
        options.onEdit(false);
      },
    });

    /**
     * Duplicate this cell, right below itself.
     *
     * A surface is usually explored by variation — the same map with one component changed — and
     * retyping a parametrization to compare two of them is the slowest thing in the tool. The copy
     * carries the row's TEXT only; its colour, domain and overlays start fresh, because a
     * duplicate is a new object rather than a second view of the same one.
     */
    const duplicate = el("button", {
      class: "row__move",
      title: "duplicate this expression",
      text: "\u29c9",
      onClick: (event: Event) => {
        event.stopPropagation();
        const source = store.rows().find((candidate) => candidate.id === id)?.source() ?? "";
        const copy = store.addRow(source);
        // Straight below the original rather than at the end, so a comparison stays side by side.
        const index = store.rows().findIndex((candidate) => candidate.id === id);
        store.moveRow(copy.id, index + 1 - (store.rows().length - 1));
        syncRows();
        options.onEdit(false);
        select(copy.id);
      },
    });

    const shift = (delta: number, label: string, title: string) =>
      el("button", {
        class: "row__move",
        title,
        text: label,
        onClick: (event: Event) => {
          event.stopPropagation();
          store.moveRow(id, delta);
          syncRows();
          options.onEdit(false);
        },
      });

    /**
     * A cell is the input and its typeset echo, nothing else.
     *
     * The kind label and the diagnostics used to sit here; both moved to the card, so the bar
     * reads as a column of cells rather than as a stack of little reports. The echo stays,
     * because it is the only thing that shows how a formula was PARSED — implicit multiplication
     * and precedence stop being frightening exactly when you can see them resolved.
     *
     * The row tools appear on hover, so the resting state of the bar has no chrome at all.
     */
    /**
     * A cell shows its TYPESET form, and swaps to the raw text only while being edited.
     *
     * Showing both at once said everything twice. Which one is visible is driven by an explicit
     * class rather than by `:focus-within`, because CSS alone cannot work here: an input hidden
     * with `display: none` cannot be focused, so the click handler has to reveal it *before*
     * calling focus.
     */
    const paramHost = el("div", { class: "row__params" });

    const enterEdit = () => {
      /**
       * Lay a surface out before showing it, so the text being edited matches the shape of the
       * typeset form above it.
       *
       * Formatting only on blur left a gap: anything that arrived already written on one line —
       * a template, a pasted formula, a cell never yet edited — opened as a single dense line
       * even though its preview was the multi-line map. Doing it on the way IN as well means the
       * two views always agree, and since the formatter is idempotent this costs nothing for a
       * cell that has been edited before.
       */
      const formatted = formatSurfaceSource(input.value);
      if (formatted !== null && formatted !== input.value) {
        input.value = formatted;
        row.source.set(formatted);
      }
      root.classList.add("row--editing");
      autoSize(input);
      input.focus();
    };

    /**
     * Does this click belong to a control rather than to the cell?
     *
     * A cell contains sliders, transport buttons, number fields and toggles, and a click on any
     * of them was reaching the row's own handler and calling `enterEdit` — which focuses the text
     * input and takes the click with it. Pressing pause moved the caret instead of pausing, and
     * dragging a slider would have been stolen the same way.
     *
     * Checked with `closest` rather than by comparing against the target directly, because the
     * clickable thing is often a child: the glyph inside a button, the text inside a label.
     */
    const isControl = (target: EventTarget | null) =>
      target instanceof Element &&
      target.closest("input, button, select, textarea, label, .slider, .transport") !== null;
    input.addEventListener("keydown", (event: KeyboardEvent) => {
      /**
       * Shift+Enter runs the cell; plain Enter inserts a line break.
       *
       * That way round because a cell is now multi-line and laying a surface out over several
       * lines is the ordinary case — if Enter committed, writing the thing the format exists for
       * would need a modifier. Blur does the work: it reformats, re-renders and drops back to the
       * typeset view, so "run" is exactly "leave the cell".
       */
      if (event.key === "Enter" && event.shiftKey) {
        event.preventDefault();
        input.blur();
        return;
      }
      if (event.key === "Escape") input.blur();
    });

    input.addEventListener("blur", () => {
      root.classList.remove("row--editing");
      /**
       * Reformat on leaving the cell, never while typing.
       *
       * Rewriting the text under a caret would be hostile — the same reason the smart
       * constructors preserve term order rather than sorting. Blur is the moment the user has
       * finished saying what they meant, so it is the only safe place to say it back to them.
       */
      const formatted = formatSurfaceSource(input.value);
      if (formatted !== null && formatted !== input.value) {
        input.value = formatted;
        row.source.set(formatted);
        refreshEcho(views.get(id));
        options.onEdit(false);
      }
      autoSize(input);
      // An empty cell has no typeset form to fall back to, so it keeps showing its input.
      syncEditing(views.get(id));
    });

    const root = el("div", {
      class: "row row--editing",
      onClick: (event: Event) => {
        // Selecting is always right — clicking a row's slider is still a statement about which
        // object you are working on. Entering edit mode is not.
        select(id);
        if (isControl(event.target)) return;
        if (!root.classList.contains("row--editing")) enterEdit();
      },
    }, [
      input,
      echo,
      el("div", { class: "row__tools" }, [
        duplicate,
        shift(-1, "\u2191", "move up"),
        shift(1, "\u2193", "move down"),
        remove,
      ]),
      // Sliders belong to the cell that introduced them, directly beneath it.
      valueHost,
      paramHost,
    ]);

    /**
     * The colour every drawn part of this row takes.
     *
     * A native colour input rather than a palette: it costs one element, it is keyboard and
     * screen-reader accessible for free, and it does not constrain the user to swatches we
     * happened to choose.
     */
    const colorSwatch = el("input", {
      type: "color",
      class: "props__color",
      title: "this object's colour; choosing one paints the surface solid",
      value: toHex(options.colors.get(id) ?? defaultColorFor(id)),
      onInput: () => {
        options.colors.set(id, fromHex(colorSwatch.value));

        /**
         * Choosing a colour also switches the surface to the solid map.
         *
         * Otherwise the swatch appears broken: a surface is painted with its curvature by
         * default, and that colour is drawn OVER the object's own, so picking one changed
         * something completely hidden. Asking for a colour is a statement that you want to see
         * that colour, and the map menu is right there to go back to K.
         */
        const select = views.get(id)?.colormapSelect;
        if (select && select.value !== "solid") {
          /**
           * Driven through the menu rather than written to the overlay directly.
           *
           * The overlay controls hold their state in closure locals and write ALL of them on
           * every commit, so setting the map behind the menu's back would leave that local stale
           * and the next slider drag would quietly put the old map back — the same staleness that
           * already cost the picked start point and the aimed shots.
           */
          select.value = "solid";
          select.dispatchEvent(new Event("change"));
          return;
        }
        options.onParameterChange();
      },
    }) as HTMLInputElement;

    const detailsTitle = el("span", { class: "props__kind", text: "expression" });

    const details = el("div", { class: "props__body" }, [
      notes,
      colorSwatch,
      chartHost,
      domainHost,
      overlayHost,
      frameHost,
    ]);

    return {
      id,
      root,
      input,
      echo,
      badge,
      notes,
      domainHost,
      frameHost,
      valueHost,
      chartHost,
      overlayHost,
      details,
      colorSwatch,
      colormapSelect: null,
      detailsTitle,
      paramHost,
      overlayBuilt: false,
      paramNames: "\u0000",
      domainVars: "",
      valueName: "",
    };
  }

  /**
   * Play, pause and rewind for one slider.
   *
   * The play button's label is the only state here that must be kept in step, and it is read
   * back from the animator rather than tracked separately — two copies of "is this playing" is
   * exactly the kind of thing that drifts apart.
   */
  /**
   * Every transport's speed menu, so setting one sets them all.
   *
   * The animator runs a single clock — two sweeps playing together keep their relative rates —
   * but the control has to appear beside each play button, because that is where anyone looks
   * for it. One value, several views of it, kept in step here.
   */
  const speedSelects = new Set<HTMLSelectElement>();
  const SPEEDS: readonly number[] = [0.25, 0.5, 1, 2, 4];

  /**
   * A toolbar chip: a short symbol that toggles, with its meaning in the tooltip.
   *
   * The audience reads mathematics, so the symbols ARE the labels — γ is a geodesic, s is arc
   * length, k₁k₂ are the lines of curvature, N is the Gauss map. Each is a few pixels where the
   * spelled-out phrase was a hundred, and none of them is a guess the reader has to make: the
   * full description is one hover away.
   */
  const chip = (
    symbol: string,
    title: string,
    pressed: boolean,
    onToggle: (next: boolean) => void,
  ): HTMLButtonElement => {
    const button = el("button", {
      class: `chip${pressed ? " chip--on" : ""}`,
      title,
      html: symbol,
    }) as HTMLButtonElement;
    button.addEventListener("click", () => {
      const next = !button.classList.contains("chip--on");
      button.classList.toggle("chip--on", next);
      onToggle(next);
    });
    return button;
  };

  const transport = (key: string): HTMLElement => {
    const play = el("button", {
      class: "transport__button",
      title: "play / pause",
      text: options.animator.playing(key) ? "\u275a\u275a" : "\u25b6",
    });
    const paint = () => {
      const active = options.animator.playing(key);
      play.textContent = active ? "\u275a\u275a" : "\u25b6";
      play.classList.toggle("transport__button--active", active);
    };
    play.addEventListener("click", () => {
      options.animator.toggle(key);
      paint();
    });
    paint();

    const rewind = el("button", {
      class: "transport__button",
      title: "back to the start of the range",
      text: "\u25c0\u25c0",
      onClick: () => options.animator.rewind(key),
    });

    const speed = el("select", {
      class: "transport__speed",
      title: "animation speed",
    }) as HTMLSelectElement;
    for (const value of SPEEDS) {
      speed.append(
        el("option", {
          value: String(value),
          text: `${value}\u00d7`,
          selected: value === options.animator.speed(),
        }),
      );
    }
    speed.addEventListener("change", () => {
      options.animator.setSpeed(Number(speed.value));
      for (const other of speedSelects) other.value = speed.value;
    });
    speedSelects.add(speed);

    return el("div", { class: "transport" }, [speed, rewind, play]);
  };

  /**
   * One slider per undefined symbol.
   *
   * Names *declared* by a numeric row are excluded: those already have a slider on the row
   * that declares them, and showing a second one for the same name would be two controls
   * fighting over one value.
   */
  const syncSliders = (names: readonly string[]) => {
    for (const name of names) {
      if (!options.sliders.has(name)) {
        // A fresh parameter starts at 1 over a symmetric range — usable for a radius, a
        // pitch or a coefficient without asking the user to specify bounds first.
        options.sliders.set(name, { value: 1, min: -5, max: 5, step: 0.01 });
      }
    }
    for (const name of [...options.sliders.keys()]) {
      if (!names.includes(name)) {
        options.sliders.delete(name);
        options.animator.unregister(`param:${name}`);
      }
    }

    // Rebuilt only when the set of parameters changes. Otherwise a refresh mid-drag would
    // replace the very range input being dragged.
    const signature = names.join(",");
    if (signature === renderedSliders) return;
    renderedSliders = signature;

  };

  /**
   * The sliders for the parameters ONE row uses, in that row's card.
   *
   * A parameter shared by two rows appears in both cards and drives the same value, which is the
   * honest presentation: it really is one number, and seeing it from either object that depends
   * on it is more useful than hiding it in a list far from both.
   */
  const syncRowParams = (view: RowView, item: Item | null) => {
    const names = item
      ? [...item.params].filter((name) => options.sliders.has(name)).sort()
      : [];
    const signature = names.join(",");
    // Rebuilt only when the set changes, or a refresh mid-drag would replace the very range
    // input being dragged.
    if (signature === view.paramNames) return;
    view.paramNames = signature;
    replace(view.paramHost, names.map((name) => sliderRow(name, options.sliders.get(name)!)));
  };

  interface MovingSliderOptions {
    readonly min: number;
    readonly max: number;
    readonly step: number;
    readonly value: number;
    /** How the bubble renders the number. */
    readonly format?: (value: number) => string;
    readonly title?: string;
    /** Continuous, while dragging. */
    readonly onInput: (value: number) => void;
  }

  interface MovingSlider {
    readonly root: HTMLElement;
    readonly input: HTMLInputElement;
    /** Push a value in from outside — the animator, or a reformat. */
    set(value: number): void;
  }

  /**
   * A slider whose value rides above the thumb, with no number box beside it.
   *
   * Two things bought at once. The readout used to sit in a fixed column and the exact-value box
   * in another, so on a toolbar the TRACK — the only part you actually manipulate — got whatever
   * was left, which was almost nothing. Putting the number on the thumb and dropping the box
   * gives the track the full width.
   *
   * Exact entry survives as double-click: the bubble becomes a field, and a value outside the
   * current range WIDENS it rather than being refused, which is what the bounds boxes were for.
   */
  const movingSlider = (config: MovingSliderOptions): MovingSlider => {
    const format = config.format ?? ((value: number) => formatValue(value));
    let min = config.min;
    let max = config.max;

    const bubble = el("span", { class: "vslider__bubble", text: format(config.value) });
    const input = el("input", {
      type: "range",
      class: "vslider__input",
      min,
      max,
      step: config.step,
      value: config.value,
      title: config.title,
    }) as HTMLInputElement;

    /**
     * Where the label sits.
     *
     * At rest it rides the thumb, so a glance reads the value. While the pointer is on the
     * control it follows the POINTER instead — it is a tag on the cursor, which is where the
     * eye already is during a drag, and the thumb can lag the cursor at the ends of the track
     * where a value is most often being aimed at precisely.
     *
     * The correction term is for the thumb case: a thumb's centre travels from half a
     * thumb-width in to half a thumb-width from the end, so a straight percentage drifts off it,
     * worst at exactly those extremes.
     */
    const THUMB = 15;
    const atThumb = (value: number) => {
      const span = max - min;
      const fraction = span > 0 ? (value - min) / span : 0.5;
      const clamped = Math.min(1, Math.max(0, fraction));
      return `calc(${clamped * 100}% + ${(0.5 - clamped) * THUMB}px)`;
    };
    let pointerAt: number | null = null;
    const place = (value: number) => {
      bubble.style.left = pointerAt === null ? atThumb(value) : `${pointerAt}px`;
    };
    place(config.value);

    const followPointer = (event: PointerEvent) => {
      const box = input.getBoundingClientRect();
      // Clamped to the track: past its ends the value has stopped changing, so a label that kept
      // travelling would point at nothing.
      pointerAt = Math.min(box.width, Math.max(0, event.clientX - box.left));
      place(Number(input.value));
    };
    input.addEventListener("pointermove", followPointer);
    input.addEventListener("pointerdown", followPointer);
    input.addEventListener("pointerleave", () => {
      pointerAt = null;
      place(Number(input.value));
    });

    input.addEventListener("input", () => {
      const value = Number(input.value);
      bubble.textContent = format(value);
      place(value);
      config.onInput(value);
    });

    const root = el("div", { class: "vslider" }, [bubble, input]);

    /** Double-click to type an exact value, in place of the box this replaced. */
    root.addEventListener("dblclick", (event: Event) => {
      event.preventDefault();
      const field = el("input", {
        type: "number",
        class: "vslider__exact",
        value: Number(input.value),
        step: "any",
      }) as HTMLInputElement;
      field.style.left = bubble.style.left;
      bubble.replaceWith(field);
      field.focus();
      field.select();

      const finish = (accept: boolean) => {
        const typed = Number(field.value);
        field.replaceWith(bubble);
        if (!accept || !Number.isFinite(typed)) return;
        // Typing past an end WIDENS the track. Refusing a value the user asked for is exactly
        // what the removed bounds boxes existed to prevent.
        if (typed < min) min = typed - Math.abs(typed) * 0.2 - 1e-9;
        if (typed > max) max = typed + Math.abs(typed) * 0.2 + 1e-9;
        input.min = String(min);
        input.max = String(max);
        input.value = String(typed);
        bubble.textContent = format(typed);
        place(typed);
        config.onInput(typed);
      };
      field.addEventListener("blur", () => finish(true));
      field.addEventListener("keydown", (keyEvent: KeyboardEvent) => {
        if (keyEvent.key === "Enter") finish(true);
        else if (keyEvent.key === "Escape") finish(false);
      });
    });

    return {
      root,
      input,
      set(value) {
        input.value = String(value);
        bubble.textContent = format(value);
        place(value);
      },
    };
  };
  function sliderRow(name: string, spec: SliderSpec): HTMLElement {
    const slider = movingSlider({
      min: spec.min,
      max: spec.max,
      step: spec.step,
      value: spec.value,
      title: `${name} \u2014 drag, or double-click to type an exact value`,
      onInput: (value) => {
        spec.value = value;
        // A track widened by typing has to be recorded, or the next rebuild narrows it back.
        spec.min = Math.min(spec.min, Number(slider.input.min));
        spec.max = Math.max(spec.max, Number(slider.input.max));
        store.setParameter(name, value);
        // Parameters are compiled as slots, so this recompiles nothing.
        options.onParameterChange();
      },
    });

    store.setParameter(name, spec.value);

    // Registered so the animator can drive this slider's DOM directly.
    options.animator.register(`param:${name}`, spec, (value) => {
      slider.set(value);
      store.setParameter(name, value);
    });

    return el("div", { class: "slider" }, [
      el("span", { class: "slider__name" }, [
        tex(name.length === 1 ? name : `\\mathrm{${name}}`),
      ]),
      slider.root,
      transport(`param:${name}`),
    ]);
  }

  /** Editable sampling range per parametrization variable. */
  const syncDomain = (view: RowView, item: Item | null) => {
    const vars = item?.vars ?? [];
    const drawable =
      item !== null &&
      (item.kind === "parametricSurface" ||
        item.kind === "graphSurface" ||
        item.kind === "spaceCurve" ||
        item.kind === "planeCurve");

    // Same rule as the row list: the number inputs are only rebuilt when the variables
    // change, so typing a domain bound is not interrupted by the next refresh.
    const signature = drawable ? vars.join(",") : "";
    if (view.domainVars === signature) return;
    view.domainVars = signature;

    if (!drawable || vars.length === 0) {
      replace(view.domainHost, []);
      return;
    }

    let ranges = options.domains.get(view.id);
    if (!ranges || ranges.length !== vars.length) {
      ranges = vars.map((name) => {
        const fallback = DEFAULT_DOMAIN[name] ?? [0, 2 * Math.PI];
        return { min: fallback[0], max: fallback[1] };
      });
      options.domains.set(view.id, ranges);
    }
    const stored = ranges;

    replace(
      view.domainHost,
      vars.map((name, index) => {
        const entry = stored[index]!;

        /**
         * Slider bounds, derived from the interval the row starts with.
         *
         * A domain bound has no natural range of its own — it could be anything — so the track
         * spans twice the current width either side of it. Wide enough to explore, and
         * double-clicking types a value past the ends when that is not enough.
         */
        const span = Math.abs(entry.max - entry.min) || 1;
        const centre = (entry.min + entry.max) / 2;
        const lo = centre - span * 2;
        const hi = centre + span * 2;

        /**
         * Committed through the PARAMETER path, not the edit path.
         *
         * A domain bound changes nothing about the formula — no reparse, no recompile, only a
         * different sampling interval — so it belongs on the throttled route that renders once
         * per animation frame and upgrades to full resolution when the drag settles. `onEdit`
         * debounces, and a debounce waits for quiet: a held slider produced nothing at all until
         * release and then jumped.
         */
        const track = (which: "min" | "max") =>
          movingSlider({
            min: lo,
            max: hi,
            step: (hi - lo) / 400,
            value: entry[which],
            title: `${name} ${which} \u2014 drag, or double-click to type an exact value`,
            onInput: (value) => {
              entry[which] = value;
              options.onParameterChange();
            },
          }).root;

        return el("div", { class: "domain" }, [
          el("span", { class: "domain__var" }, [tex(name)]),
          track("min"),
          track("max"),
        ]);
      }),
    );
  };

  /**
   * The moving frame control, on curve rows only.
   *
   * Built once per row and then left alone, like the text input: rebuilding it on every
   * refresh would fight the user mid-drag. The `t` slider redraws immediately rather than
   * on the debounce, since only the three glyphs move.
   */
  /**
   * On a plane-curve row: read its two components as (u, v) instead of as a curve in z = 0.
   *
   * `(cos t, sin t)` is a circle in the plane and also a circle in the chart, and those are
   * completely different objects — the second one wraps around whatever surface the chart
   * belongs to. Only the user knows which they meant, so this is a choice rather than an
   * inference.
   */
  const syncChartToggle = (view: RowView, item: Item | null) => {
    const eligible = item?.kind === "planeCurve";
    if (!eligible) {
      if (view.chartHost.childElementCount > 0) replace(view.chartHost, []);
      options.inChart.delete(view.id);
      seenChartRows.delete(view.id);
      return;
    }
    if (view.chartHost.childElementCount > 0) return;

    // Honour the classifier's reading of intent the first time this row is seen. A curve
    // written in u or v was meant for the chart; one written in t was not.
    if (!seenChartRows.has(view.id)) {
      seenChartRows.add(view.id);
      if (item.chartByDefault) options.inChart.add(view.id);
    }

    const toggle = el("input", {
      type: "checkbox",
      checked: options.inChart.has(view.id),
      onChange: () => {
        if (toggle.checked) options.inChart.add(view.id);
        else options.inChart.delete(view.id);
        options.onEdit(false);
      },
    }) as HTMLInputElement;

    replace(view.chartHost, [
      el("label", { class: "toggle toggle--tight" }, [
        toggle,
        el("span", { text: "read as (u, v) — draw in the chart and on the surface" }),
      ]),
    ]);
  };

  /**
   * Geodesics, lines of curvature and the Gauss map, on surface rows.
   *
   * The curves shoot from `start` when a click has set one, and from the centre of the domain
   * otherwise. The centre is a defined, reproducible place to start from, and
   * moving to click-to-shoot later changes only where the start comes from.
   */
  const syncOverlayControl = (view: RowView, item: Item | null) => {
    const isSurface = item?.kind === "parametricSurface" || item?.kind === "graphSurface";
    if (!isSurface) {
      if (view.overlayBuilt) {
        replace(view.overlayHost, []);
        view.overlayBuilt = false;
      }
      options.overlays.delete(view.id);
      return;
    }
    if (view.overlayBuilt) return;
    view.overlayBuilt = true;

    const state: SurfaceOverlay = options.overlays.get(view.id) ?? {
      geodesics: 0,
      geodesicLength: 1.5,
      curvatureLines: false,
    };
    let geodesics = state.geodesics;
    let geodesicLength = state.geodesicLength;
    let curvatureLines = state.curvatureLines;
    let gaussMap = state.gaussMap ?? false;
    let aiming = state.aiming ?? false;
    let colormap: ColormapName = state.colormap ?? "curvature";

    const commit = () => {
      if (
        geodesics === 0 &&
        !curvatureLines &&
        !gaussMap &&
        !aiming &&
        colormap === "curvature" &&
        shotCount() === 0
      ) {
        // Nothing is drawn, so there is no start point to remember either.
        options.overlays.delete(view.id);
      } else {
        /**
         * `start` is read back from the map rather than captured in a local.
         *
         * It is owned by the click handler on the canvas, not by these controls, so building a
         * fresh object from the local state alone would silently reset the picked point to the
         * domain centre the next time any slider here moved.
         */
        const start = options.overlays.get(view.id)?.start;
        options.overlays.set(view.id, {
          geodesics,
          geodesicLength,
          curvatureLines,
          gaussMap,
          aiming,
          colormap,
          start,
          // Owned by the canvas, like `start`, so read back rather than captured.
          shots: options.overlays.get(view.id)?.shots,
        });
      }
      /**
       * Also the throttled path: an overlay change re-integrates curves and re-tessellates, but
       * it never reparses, so the spray-count and arc-length sliders should give continuous
       * feedback rather than waiting for the drag to stop.
       */
      options.onParameterChange();
    };

    const count = el("input", {
      type: "range",
      class: "slider__input",
      min: 0,
      max: 24,
      step: 1,
      value: geodesics,
    }) as HTMLInputElement;
    const countReadout = el("span", { class: "slider__value", text: String(geodesics) });
    count.addEventListener("input", () => {
      geodesics = Number(count.value);
      countReadout.textContent = String(geodesics);
      commit();
    });

    /**
     * The ceiling matters more than it looks: a great circle on a sphere of radius R has length
     * 2πR, and the extent this multiplies is R — so a maximum of 6 stopped every geodesic just
     * short of closing up, which is the one length worth being able to reach.
     */
    const length = el("input", {
      type: "range",
      class: "slider__input",
      min: 0.2,
      max: 40,
      step: 0.1,
      value: geodesicLength,
    }) as HTMLInputElement;
    const lengthReadout = el("span", {
      class: "slider__value",
      text: geodesicLength.toFixed(1),
    });
    length.addEventListener("input", () => {
      geodesicLength = Number(length.value);
      lengthReadout.textContent = geodesicLength.toFixed(1);
      commit();
    });

    const curvature = chip(
      "k<sub>1</sub>k<sub>2</sub>",
      "lines of curvature through the start point",
      curvatureLines,
      (next) => {
        curvatureLines = next;
        commit();
      },
    );

    const gauss = chip(
      "N",
      "Gauss map: N: S \u2192 S\u00b2 drawn beside the surface, in the same colours \u2014 " +
        "its image folds where K = 0",
      gaussMap,
      (next) => {
        gaussMap = next;
        commit();
      },
    );

    const shotCount = () => options.overlays.get(view.id)?.shots?.length ?? 0;

    /**
     * Which colour map paints K on this surface.
     *
     * Per surface rather than global, because two surfaces in one scene can be asked different
     * questions — one showing the sign of K, another its magnitude — while still sharing the one
     * robust scale that makes their colours comparable.
     */
    const colormapSelect = el("select", { class: "props__select" }) as HTMLSelectElement;
    for (const name of COLORMAP_NAMES) {
      colormapSelect.append(
        el("option", { value: name, text: COLORMAP_LABEL[name], selected: name === colormap }),
      );
    }
    view.colormapSelect = colormapSelect;
    colormapSelect.addEventListener("change", () => {
      colormap = colormapSelect.value as ColormapName;
      commit();
    });

    /**
     * The aim tool.
     *
     * While armed, a drag on THIS surface shoots a geodesic along the direction dragged instead
     * of orbiting. Armed per surface rather than globally so the gesture is only taken on the
     * object the user pointed at — dragging anywhere else still moves the camera, which is what
     * keeps this from being a mode you get stuck in.
     */
    const aim = chip(
      "\u2197",
      "aim: drag on this surface to shoot a geodesic in the direction dragged",
      aiming,
      (next) => {
        aiming = next;
        commit();
      },
    );

    const clearShots = el("button", {
      class: "chip",
      text: "\u232b",
      title: "remove every aimed geodesic",
      onClick: () => {
        const overlay = options.overlays.get(view.id);
        if (!overlay?.shots?.length) return;
        options.overlays.set(view.id, { ...overlay, shots: [] });
        options.onEdit(false);
      },
    });

    replace(view.overlayHost, [
      colormapSelect,
      el("div", { class: "slider" }, [
        el("label", { class: "slider__label" }, [
          el("span", { text: "\u03b3", title: "geodesics fanned from the start point" }),
          countReadout,
        ]),
        count,
      ]),
      el("div", {
        class: "overlay__hint",
        text: "click the surface to move where these start",
      }),
      el("div", { class: "slider" }, [
        el("label", { class: "slider__label" }, [
          el("span", { text: "s", title: "arc length of each geodesic" }),
          lengthReadout,
        ]),
        length,
      ]),
      curvature,
      aim,
      clearShots,
      gauss,
    ]);
  };

  const syncFrameControl = (view: RowView, item: Item | null) => {
    const isCurve = item?.kind === "spaceCurve" || item?.kind === "planeCurve";
    if (!isCurve) {
      if (view.frameHost.childElementCount > 0) replace(view.frameHost, []);
      options.frames.delete(view.id);
      return;
    }
    if (view.frameHost.childElementCount > 0) return;

    const state: FrameRequest = options.frames.get(view.id) ?? { show: false, at: 0.5 };
    let show = state.show;
    let at = state.at;
    const commit = () => options.frames.set(view.id, { show, at });
    commit();

    const readout = el("span", { class: "slider__value", text: at.toFixed(2) });

    const position = el("input", {
      type: "range",
      class: "slider__input",
      min: 0,
      max: 1,
      step: 0.002,
      value: at,
      onInput: () => {
        at = Number(position.value);
        readout.textContent = at.toFixed(2);
        commit();
        options.onParameterChange();
      },
    }) as HTMLInputElement;

    const toggle = el("input", {
      type: "checkbox",
      checked: show,
      onChange: () => {
        show = toggle.checked;
        commit();
        position.disabled = !show;
        options.onParameterChange();
      },
    }) as HTMLInputElement;
    position.disabled = !show;

    replace(view.frameHost, [
      el("label", { class: "toggle toggle--tight" }, [
        toggle,
        el("span", { text: "moving frame" }),
        el("span", { class: "frame-key" }, [
          el("span", { class: "frame-key__t", text: "T" }),
          el("span", { class: "frame-key__n", text: "N" }),
          el("span", { class: "frame-key__b", text: "B" }),
        ]),
      ]),
      el("div", { class: "frame-position" }, [position, readout]),
    ]);
  };


  /**
   * A slider on any row that defines a plain number.
   *
   * This is the Desmos model, and it is what makes `R = 2` immediately adjustable rather than
   * something you have to retype. Dragging rewrites the row's own text, so the document stays
   * the single source of truth — the row still says exactly what it means, and undo, sharing
   * and reloading all keep working without a parallel store of "current values".
   *
   * Built once per row and only rebuilt when the declared name changes, for the same reason
   * everything else here is: replacing an input the user is holding is what steals focus.
   */
  const syncValueSlider = (view: RowView, item: Item | null) => {
    /**
     * A plain number gets a slider under its cell.
     *
     * The kind to test is `parameter`, not `scalar`: `R = 2` is classified as a parameter
     * precisely BECAUSE it is a bare number the user will want to drag — keeping it symbolic
     * downstream is what makes dragging it free. Testing for `scalar` here meant the one kind of
     * row that exists to be dragged was the one kind that never got a slider.
     */
    const numeric =
      item !== null &&
      item.kind === "parameter" &&
      item.name !== null &&
      item.comps[0]?.kind === "num";

    const name = numeric ? item.name! : "";
    if (view.valueName === name) return;
    view.valueName = name;

    if (!numeric) {
      replace(view.valueHost, []);
      options.rowSliders.delete(view.id);
      options.animator.unregister(`row:${view.id}`);
      return;
    }

    const current = (item.comps[0] as { value: number }).value;
    let spec = options.rowSliders.get(view.id);
    if (!spec) {
      // A symmetric range around twice the declared magnitude covers a radius, a pitch or a
      // coefficient without asking for bounds up front; both ends stay editable.
      const reach = Math.max(1, Math.abs(current) * 2);
      spec = {
        value: current,
        min: -reach,
        max: reach,
        step: Math.abs(current) > 10 ? 0.1 : 0.01,
      };
      options.rowSliders.set(view.id, spec);
    }
    spec.value = current;
    store.setParameter(name, current);

    let lastTypeset = format(current);

    const slider = movingSlider({
      min: spec.min,
      max: spec.max,
      step: spec.step,
      value: spec.value,
      format,
      title: `${name} \u2014 drag, or double-click to type an exact value`,
      /**
       * While dragging, only the parameter *value* moves — never the row's text.
       *
       * The row declares a number, and that number compiles to a **slot**, so changing it leaves
       * every expression in the document byte-identical and the compiled jet is reused straight
       * from cache. Rewriting `R = 2` to `R = 2.01` on each frame would build a whole new
       * interned tree and re-differentiate the surface sixty times a second, which is exactly
       * the jank this replaced. The text is reconciled once, when the drag ends.
       */
      onInput: (next) => {
        spec!.value = next;
        spec!.min = Math.min(spec!.min, Number(slider.input.min));
        spec!.max = Math.max(spec!.max, Number(slider.input.max));
        store.setParameter(name, next);
        const shown = format(next);
        // Keep the typeset view honest while dragging: without this the cell reads `R = 2`
        // while its slider reads 1.95. Guarded on the displayed string, so a move within one
        // rounding step costs no typesetting.
        if (shown !== lastTypeset) {
          lastTypeset = shown;
          refreshEcho(views.get(view.id));
        }
        options.onParameterChange();
      },
    });

    slider.input.addEventListener("change", () => {
      // On release, reconcile the row's text with where the slider ended up, so the document
      // still says what it means. Once per drag, not once per frame.
      const next = Number(slider.input.value);
      const row = store.rows().find((candidate) => candidate.id === view.id);
      if (!row) return;
      row.source.set(`${name} = ${format(next)}`);
      refreshEcho(views.get(view.id));
      options.onEdit(false);
    });

    options.animator.register(
      `row:${view.id}`,
      spec,
      (value) => {
        slider.set(value);
        store.setParameter(name, value);
      },
      (value) => {
        const row = store.rows().find((candidate) => candidate.id === view.id);
        if (row) row.source.set(`${name} = ${format(value)}`);
        options.onEdit(false);
      },
    );

    replace(view.valueHost, [
      el("div", { class: "slider" }, [
        el("span", { class: "slider__name" }, [tex(name.length === 1 ? name : `\\mathrm{${name}}`)]),
        slider.root,
        transport(`row:${view.id}`),
      ]),
    ]);

  };

  /** Re-typeset one row's echo. KaTeX is the expensive part, so this is called sparingly. */
  /**
   * Decide whether a cell shows its typeset form or its raw text.
   *
   * An empty or unparseable cell has no typeset form worth showing, so it stays in edit mode —
   * otherwise a mistyped formula would vanish behind a dash with no way to see what was typed.
   */
  const syncEditing = (view: RowView | undefined) => {
    if (!view) return;
    if (globalThis.document.activeElement === view.input) return;
    const source = store.rows().find((row) => row.id === view.id)?.source() ?? "";
    // parseRow, not parse: a declaration like `X(u,v) = (…)` is not a bare expression, and
    // testing it with the wrong parser would leave every surface cell stuck in edit mode.
    const typeset = source.trim() !== "" && parseRow(source).row !== null;
    view.root.classList.toggle("row--editing", !typeset);
  };

  const refreshEcho = (view: RowView | undefined) => {
    if (!view) return;
    const row = store.rows().find((candidate) => candidate.id === view.id);
    if (!row) return;
    replace(view.echo, [echoFor(row.source(), liveValueOf(view.id), currentValues())]);
  };

  /**
   * What a numeric cell is worth RIGHT NOW, if it is being dragged away from what it says.
   *
   * A row like `R = 2` is a definition and a control at once, and dragging its slider deliberately
   * does not rewrite the text — rebuilding the interned tree on every frame is what made the whole
   * thing janky once. The consequence is that the cell can read `R = 2` while its slider reads
   * 1.95, which is the definition disagreeing with the object on screen. The typeset view shows
   * the live number instead; the text is reconciled when the drag ends.
   */
  /**
   * Every parameter's current value, for the typeset view.
   *
   * Read from the document's own parameter store rather than from the sliders, because both kinds
   * of slider — a free parameter's and a numeric row's — write there, so one lookup covers them
   * uniformly and cannot fall out of step with a second copy.
   */
  const currentValues = (): ReadonlyMap<string, number> => new Map(store.parameters());

  const liveValueOf = (id: RowId): number | null => {
    const spec = options.rowSliders.get(id);
    return spec ? spec.value : null;
  };

  /** The per-row notes: diagnostics, compile errors, readouts. Cheap; no typesetting. */
  const renderNotes = (view: RowView, report: RowReport | undefined) => {
    const resolution = store.resolution();
    const diagnostics = resolution.diagnostics.get(view.id) ?? [];
    const item = resolution.items.get(view.id) ?? null;
    const notes: HTMLElement[] = [];

    for (const diagnostic of diagnostics) notes.push(diagnosticNode(diagnostic));
    // Every line, not just the last: a surface reports its curvature and, separately, how its
    // geodesic spray ended.
    for (const message of report?.errors ?? []) {
      notes.push(el("div", { class: "diag diag--error", text: message }));
    }
    for (const message of report?.warnings ?? []) {
      notes.push(el("div", { class: "diag diag--warning", text: message }));
    }
    for (const message of report?.info ?? []) {
      /**
       * A readout is only useful if its symbols can be looked up.
       *
       * `K = -1.190  H = 0.476` is opaque unless you already know the convention, and the panel
       * has no room to spell it out — so the definition rides along as a tooltip on the line that
       * shows it. K is the one that survives bending the surface without stretching it, which is
       * the fact worth knowing about it.
       */
      notes.push(
        el("div", {
          class: "row__info",
          text: message,
          title: message.startsWith("K =") ? CURVATURE_TOOLTIP : undefined,
        }),
      );
    }
    if (item && NOT_YET_DRAWN.has(item.kind)) {
      notes.push(
        el("div", {
          class: "diag diag--hint",
          text: `recognized as a ${KIND_LABEL[item.kind] ?? item.kind}, but drawing these is not implemented yet`,
        }),
      );
    }
    replace(view.notes, notes);
  };

  const refreshReports = (reports: readonly RowReport[]) => {
    const reportById = new Map(reports.map((report) => [report.rowId, report]));
    for (const [id, view] of views) renderNotes(view, reportById.get(id));
  };

  const refresh = (reports: readonly RowReport[]) => {
    syncRows();
    const resolution = store.resolution();
    const reportById = new Map(reports.map((report) => [report.rowId, report]));

    for (const [id, view] of views) {
      const row = store.rows().find((candidate) => candidate.id === id);
      if (!row) continue;

      // Through the same helper as a live update, so a full refresh and a drag cannot disagree
      // about whether parameters are shown by name or by value.
      refreshEcho(view);

      const item = resolution.items.get(id) ?? null;
      const label = item ? (KIND_LABEL[item.kind] ?? item.kind) : "";
      view.badge.textContent = label;
      // The card's heading names the same thing the row's badge does, so a selected object is
      // identifiable from the card alone once the list scrolls away from it.
      view.detailsTitle.textContent = label === "" ? "expression" : label;
      if (selectedId === id) cardTitle.textContent = view.detailsTitle.textContent;
      view.badge.className =
        "row__badge" +
        (item && NOT_YET_DRAWN.has(item.kind) ? " row__badge--pending" : "") +
        (label === "" ? " row__badge--empty" : "");

      syncValueSlider(view, item);
      syncChartToggle(view, item);
      syncOverlayControl(view, item);
      syncDomain(view, item);
      syncFrameControl(view, item);
      syncRowParams(view, item);
      syncEditing(view);

      renderNotes(view, reportById.get(id));
    }

    syncSliders(
      resolution.freeParameters.filter((name) => !resolution.declaredParameters.has(name)),
    );
  };

  /**
   * The bar is nothing but cells.
   *
   * No headings, no add button, no parameter section — a new cell appears as soon as the last one
   * is used, and everything about an object lives in its card. What is left is the one thing the
   * bar is for.
   */
  /**
   * Make a new slider: a numeric cell, which renders its own slider directly beneath itself.
   *
   * A slider IS a row here — `a = 1` is a definition and a control at once — so this needs no
   * separate concept, only an unused name. Walking the alphabet skips anything the document
   * already uses, so pressing it twice gives two independent sliders rather than a collision.
   */
  const createSlider = el("button", {
    class: "cells__action",
    text: "+ slider",
    title: "add a named value with a slider",
    onClick: () => {
      const used = new Set<string>();
      for (const row of store.rows()) {
        const parsed = parseRow(row.source());
        if (parsed.row && "name" in parsed.row) used.add(parsed.row.name);
      }
      // u, v, t, x, y and z name coordinates rather than values, so they are never offered.
      const candidates = "abcdefghijklmnopqrsw".split("").filter((name) => !used.has(name));
      const name = candidates[0] ?? `a${store.rows().length}`;
      const row = store.addRow(`${name} = 1`);
      syncRows();
      options.onEdit(false);
      select(row.id);
    },
  });

  const root = el("div", { class: "cells" }, [rowHost, createSlider]);

  syncRows();

  return {
    root,
    card,
    select,
    selected: () => selectedId,
    setPlacement(mode) {
      placement = mode;
      card.classList.toggle("props--at-cursor", mode === "cursor");
      if (mode === "bar") {
        card.style.left = "";
        card.style.top = "";
      }
      positionAtCursor();
    },
    placeAt(x, y) {
      cursorX = x;
      cursorY = y;
      positionAtCursor();
    },
    refresh,
    refreshReports,
    invalidateSliders: () => {
      renderedSliders = "\u0000";
    },
  };
}

/**
 * A distinct starting colour per row, walked around the hue circle.
 *
 * Golden-ratio spacing rather than even division, because the number of rows is not known in
 * advance: each new row lands in the largest remaining gap, so any prefix of the sequence is
 * well separated instead of only a full set being so.
 */
function defaultColorFor(id: RowId): Vec3 {
  const hue = (id * 0.61803398875) % 1;
  return hslToRgb(hue, 0.62, 0.42);
}

function hslToRgb(h: number, s: number, l: number): Vec3 {
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const sector = h * 6;
  const second = chroma * (1 - Math.abs((sector % 2) - 1));
  const base = l - chroma / 2;
  const table: ReadonlyArray<readonly [number, number, number]> = [
    [chroma, second, 0],
    [second, chroma, 0],
    [0, chroma, second],
    [0, second, chroma],
    [second, 0, chroma],
    [chroma, 0, second],
  ];
  const picked = table[Math.min(5, Math.floor(sector))]!;
  return [picked[0] + base, picked[1] + base, picked[2] + base];
}

const channel = (value: number) =>
  Math.max(0, Math.min(255, Math.round(value * 255)))
    .toString(16)
    .padStart(2, "0");

/** Vec3 in [0,1] to the `#rrggbb` a colour input needs. */
export function toHex(color: Vec3): string {
  return `#${channel(color[0])}${channel(color[1])}${channel(color[2])}`;
}

/** `#rrggbb` back to a Vec3 in [0,1]. */
export function fromHex(hex: string): Vec3 {
  const n = Number.parseInt(hex.replace("#", ""), 16);
  if (!Number.isFinite(n)) return [0.5, 0.5, 0.5];
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/**
 * Grow a cell to fit its text.
 *
 * Height is reset to `auto` first: `scrollHeight` reports the content height only when the box is
 * not already constraining it, so measuring without the reset makes a cell that can grow but
 * never shrink.
 */
function autoSize(field: HTMLTextAreaElement): void {
  field.style.height = "auto";
  field.style.height = `${field.scrollHeight}px`;
}

/**
 * What the curvature readout means, for the tooltip.
 *
 * Both are built from the principal curvatures k₁ and k₂ — the largest and smallest amounts the
 * surface bends at a point. K is intrinsic and H is not, which is the distinction the whole of do
 * Carmo's chapter 4 rests on.
 */
const CURVATURE_TOOLTIP =
  "K = k\u2081k\u2082 is the Gaussian curvature: > 0 dome-like, < 0 saddle-like, 0 flat in one " +
  "direction. It is intrinsic \u2014 unchanged by bending the surface without stretching it.\n" +
  "H = (k\u2081 + k\u2082)/2 is the mean curvature. It depends on the choice of unit normal and " +
  "flips sign with it; H = 0 everywhere means a minimal surface.";

/**
 * Replace named parameters by their current values.
 *
 * The typeset view is meant to show what is ON SCREEN, and what is on screen is a torus of some
 * particular size — so `R` there is a promise the reader has to go and look up. Substituting keeps
 * the formula and the object in agreement.
 *
 * Only variables with a known value are touched: the chart coordinates u and v, and anything
 * undefined, stay symbolic, because those are what the map is a function OF. Rebuilt through the
 * interned constructors, so constant folding applies on the way and `1 · cos u` never appears.
 */
function substituteValues(expr: Expr, values: ReadonlyMap<string, number>): Expr {
  switch (expr.kind) {
    case "num":
      return expr;
    case "var": {
      const value = values.get(expr.name);
      return value === undefined ? expr : ctx.num(value);
    }
    case "add":
      return ctx.add(...expr.terms.map((term) => substituteValues(term, values)));
    case "mul":
      return ctx.mul(...expr.factors.map((factor) => substituteValues(factor, values)));
    case "pow":
      return ctx.pow(
        substituteValues(expr.base, values),
        substituteValues(expr.exp, values),
      );
    case "call":
      return ctx.call(expr.fn, ...expr.args.map((arg) => substituteValues(arg, values)));
  }
}

/** Coordinate names for the components of a map into R³, in order. */
const COMPONENT_NAMES = ["x", "y", "z"];

/**
 * Lay a surface definition out over several lines, one named coordinate each.
 *
 * `X(u,v) = ((R + r cos u) cos v, (R + r cos u) sin v, r sin u)` is a single line in which the
 * three components have to be told apart by counting commas through nested parentheses. Naming
 * them and putting them on their own lines is how the same map is written on paper, and it is
 * what makes the third component editable without first working out where it starts.
 *
 * Returns null when the row is not a surface, so the caller leaves everything else alone. The
 * labels are dropped again on the way back in — they restate the position — so this is purely a
 * presentation of the same expression, and reformatting an already-formatted cell is a no-op.
 */
export function formatSurfaceSource(source: string): string | null {
  if (source.trim() === "") return null;
  const { row } = parseRow(source);
  if (!row || row.kind !== "vectorFunction") return null;
  if (row.args.length !== 2 || row.comps.length !== COMPONENT_NAMES.length) return null;

  const body = row.comps
    .map((comp, index) => `  ${COMPONENT_NAMES[index]} = ${toSource(comp)}`)
    .join(",\n");
  return `${row.name}(${row.args.join(", ")}) = (\n${body}\n)`;
}

function diagnosticNode(diagnostic: Diagnostic): HTMLElement {
  return el("div", {
    class: `diag diag--${diagnostic.severity}`,
    text: diagnostic.message,
  });
}

/**
 * Typeset whatever the row currently says.
 *
 * A declaration is echoed as `name(args) = body` so the user can see their own left-hand
 * side; a bare expression is echoed directly. An unparseable row shows a dash rather than
 * clearing, so the panel does not flicker mid-word.
 */
function echoFor(
  source: string,
  liveValue: number | null = null,
  values: ReadonlyMap<string, number> = new Map(),
): HTMLElement {
  if (source.trim() === "") return el("span", { class: "echo-empty", text: " " });

  const { row } = parseRow(source);
  if (row) {
    switch (row.kind) {
      case "value":
        return tex(
          `${nameTex(row.name)} = ${
            liveValue === null ? toLatex(row.body) : formatValue(liveValue)
          }`,
        );
      case "function":
        return tex(
          `${nameTex(row.name)}\\left(${row.args.map(nameTex).join(", ")}\\right) = ${toLatex(row.body)}`,
        );
      case "vectorFunction": {
        const head = `${nameTex(row.name)}\\left(${row.args.map(nameTex).join(", ")}\\right)`;
        // The map's own arguments stay symbolic; everything with a value takes it.
        const bound = new Map(values);
        for (const arg of row.args) bound.delete(arg);
        const comps = row.comps.map((comp) => substituteValues(comp, bound));
        /**
         * A surface is typeset the way it is written: stacked, one named coordinate per line.
         *
         * The preview and the editable text are two views of one thing, so they have to agree on
         * SHAPE as well as content — reading a formula laid out over three lines and then seeing
         * it typeset as one long row means re-finding your place every time. It also fixes the
         * overflow: three components of a torus on one line simply run off the panel.
         *
         * Matched to `formatSurfaceSource` exactly — two arguments, three components — so the
         * two never disagree about which rows get the treatment.
         */
        if (row.args.length === 2 && row.comps.length === COMPONENT_NAMES.length) {
          const rows = comps
            .map((c, index) => `${COMPONENT_NAMES[index]} &= ${toLatex(c)}`)
            .join(" \\\\ ");
          return tex(`${head} = \\left(\\begin{aligned} ${rows} \\end{aligned}\\right)`);
        }
        return tex(`${head} = \\left(${comps.map((c) => toLatex(c)).join(",\\; ")}\\right)`);
      }
      case "equation":
        return tex(`${toLatex(row.lhs)} = ${toLatex(row.rhs)}`);
      case "tuple":
        return tex(`\\left(${row.comps.map((c) => toLatex(c)).join(",\\; ")}\\right)`);
      case "expr":
        return tex(toLatex(row.body));
    }
  }

  const { expr } = parse(source);
  if (expr) return tex(toLatex(expr));
  return el("span", { class: "echo-empty", text: "—" });
}

function nameTex(name: string): string {
  const underscore = name.indexOf("_");
  if (underscore > 0) {
    return `${nameTex(name.slice(0, underscore))}_{${name.slice(underscore + 1).replace(/[{}]/g, "")}}`;
  }
  return name.length === 1 ? name : `\\mathrm{${name}}`;
}
