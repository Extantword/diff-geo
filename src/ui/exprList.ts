import type { Diagnostic } from "../core/expr/diagnostics.ts";
import { toLatex } from "../core/expr/latex.ts";
import { parse, parseRow } from "../core/expr/parse.ts";
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
}

export interface ExprList {
  readonly root: HTMLElement;
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
  readonly input: HTMLInputElement;
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
  overlayBuilt: boolean;
  /** the name the inline slider was built for, or "" if there is none */
  valueName: string;
}

export function createExprList(options: ExprListOptions): ExprList {
  const { document: store } = options;

  const rowHost = el("div", { class: "rows" });
  const sliderHost = el("div", { class: "sliders" });
  const sliderEmpty = el("p", {
    class: "blurb",
    text: "Any symbol you use without defining it becomes a slider here.",
  });

  const views = new Map<RowId, RowView>();
  /** the parameter list the sliders were built for */
  let renderedSliders = "\u0000";
  /** Rows whose chart default has already been applied, so a later edit does not re-apply it. */
  const seenChartRows = new Set<RowId>();

  const addButton = el("button", {
    class: "add-row",
    text: "+ add expression",
    onClick: () => {
      store.addRow("");
      syncRows();
      options.onEdit(false);
      const last = [...views.values()].at(-1);
      last?.input.focus();
    },
  });

  /**
   * Create and destroy row elements to match the document, leaving existing rows' DOM
   * untouched. This is the keyed-list reconciliation the design notes insisted on writing
   * before any feature UI: without it, editing row 1 rebuilds row 2 and steals its focus.
   */
  const syncRows = () => {
    const rows = store.rows();
    const seen = new Set<RowId>();

    for (const row of rows) {
      seen.add(row.id);
      if (!views.has(row.id)) views.set(row.id, createRowView(row.id));
    }
    for (const [id, view] of views) {
      if (!seen.has(id)) {
        view.root.remove();
        views.delete(id);
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

    const input = el("input", {
      class: "field field--mono row__input",
      value: row.source(),
      spellcheck: "false",
      placeholder: "X(u,v) = (…, …, …)",
      onInput: () => {
        row.source.set(input.value);
        // Only this row's echo can have changed, so only this row's echo is re-typeset.
        // Re-rendering every row's KaTeX on each keystroke was a measurable cost for text
        // that did not move.
        refreshEcho(views.get(id));
        options.onEdit(false);
      },
    }) as HTMLInputElement;

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
      onClick: () => {
        store.removeRow(id);
        views.get(id)?.root.remove();
        views.delete(id);
        options.onEdit(false);
      },
    });

    const root = el("div", { class: "row" }, [
      el("div", { class: "row__head" }, [badge, remove]),
      input,
      echo,
      valueHost,
      chartHost,
      domainHost,
      overlayHost,
      frameHost,
      notes,
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
      overlayBuilt: false,
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

    return el("div", { class: "transport" }, [rewind, play]);
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

    replace(
      sliderHost,
      names.length > 0
        ? names.map((name) => sliderRow(name, options.sliders.get(name)!))
        : [sliderEmpty],
    );
  };

  function sliderRow(name: string, spec: SliderSpec): HTMLElement {
    const readout = el("span", { class: "slider__value", text: spec.value.toFixed(2) });

    const range = el("input", {
      type: "range",
      class: "slider__input",
      min: spec.min,
      max: spec.max,
      step: spec.step,
      value: spec.value,
      onInput: () => {
        spec.value = Number(range.value);
        readout.textContent = spec.value.toFixed(2);
        store.setParameter(name, spec.value);
        // Parameters are compiled as slots, so this recompiles nothing.
        options.onParameterChange();
      },
    }) as HTMLInputElement;

    const bound = (which: "min" | "max") =>
      el("input", {
        type: "number",
        class: "field field--tiny",
        value: spec[which],
        step: "any",
        title: `${which} of the slider range`,
        onChange: (event: Event) => {
          const next = Number((event.target as HTMLInputElement).value);
          if (!Number.isFinite(next)) return;
          spec[which] = next;
          range.min = String(spec.min);
          range.max = String(spec.max);
        },
      });

    store.setParameter(name, spec.value);

    // Registered so the animator can drive this slider's DOM directly.
    options.animator.register(`param:${name}`, spec, (value) => {
      range.value = String(value);
      readout.textContent = formatValue(value);
      store.setParameter(name, value);
    });

    return el("div", { class: "slider" }, [
      el("label", { class: "slider__label" }, [
        tex(name.length === 1 ? name : `\\mathrm{${name}}`),
        readout,
      ]),
      range,
      el("div", { class: "slider__bounds" }, [
        bound("min"),
        el("span", { text: "…" }),
        bound("max"),
        transport(`param:${name}`),
      ]),
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
        const field = (which: "min" | "max") =>
          el("input", {
            type: "number",
            class: "field field--tiny",
            value: Number(entry[which].toFixed(4)),
            step: "any",
            onChange: (event: Event) => {
              const next = Number((event.target as HTMLInputElement).value);
              if (!Number.isFinite(next)) return;
              entry[which] = next;
              options.onEdit(false);
            },
          });
        return el("div", { class: "domain" }, [
          el("span", { class: "domain__var" }, [tex(name)]),
          el("span", { class: "domain__in", text: "∈" }),
          field("min"),
          el("span", { text: "…" }),
          field("max"),
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

    const commit = () => {
      if (geodesics === 0 && !curvatureLines && !gaussMap) {
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
          start,
        });
      }
      options.onEdit(false);
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

    const curvature = el("input", {
      type: "checkbox",
      checked: curvatureLines,
    }) as HTMLInputElement;
    curvature.addEventListener("change", () => {
      curvatureLines = curvature.checked;
      commit();
    });

    const gauss = el("input", {
      type: "checkbox",
      checked: gaussMap,
    }) as HTMLInputElement;
    gauss.addEventListener("change", () => {
      gaussMap = gauss.checked;
      commit();
    });

    replace(view.overlayHost, [
      el("div", { class: "slider" }, [
        el("label", { class: "slider__label" }, [
          el("span", { text: "geodesic spray" }),
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
          el("span", { text: "arc length" }),
          lengthReadout,
        ]),
        length,
      ]),
      el("label", { class: "toggle toggle--tight" }, [
        curvature,
        el("span", { text: "lines of curvature" }),
        el("span", { class: "frame-key" }, [
          el("span", { class: "frame-key__b", text: "k\u2081" }),
          el("span", { class: "curvature-key__2", text: "k\u2082" }),
        ]),
      ]),
      el("label", { class: "toggle toggle--tight" }, [
        gauss,
        el("span", { text: "Gauss map" }),
      ]),
      el("div", {
        class: "overlay__hint",
        text: "N: S \u2192 S\u00b2 drawn beside the surface, same colours \u2014 the image folds where K = 0",
      }),
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
    const numeric =
      item !== null &&
      item.kind === "scalar" &&
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

    const readout = el("span", { class: "slider__value", text: format(current) });
    const range = el("input", {
      type: "range",
      class: "slider__input",
      min: spec.min,
      max: spec.max,
      step: spec.step,
      value: spec.value,
      /**
       * While dragging, only the parameter *value* moves — never the row text.
       *
       * The row declares a number, and that number compiles to a **slot**, so changing it
       * leaves every expression in the document byte-identical and the compiled jet is reused
       * straight from cache. Rewriting `R = 2` to `R = 2.01` on each frame instead would build
       * a whole new interned tree and re-differentiate the surface sixty times a second, which
       * is exactly the jank this replaced.
       */
      onInput: () => {
        const next = Number(range.value);
        spec!.value = next;
        readout.textContent = format(next);
        store.setParameter(name, next);
        options.onParameterChange();
      },
      /**
       * On release, reconcile the row's text with where the slider ended up, so the document
       * still says what it means. Once per drag, not once per frame.
       */
      onChange: () => {
        const next = Number(range.value);
        const row = store.rows().find((candidate) => candidate.id === view.id);
        if (!row) return;
        const text = `${name} = ${format(next)}`;
        view.input.value = text;
        row.source.set(text);
        refreshEcho(view);
        options.onEdit(false);
      },
    }) as HTMLInputElement;

    const bound = (which: "min" | "max") =>
      el("input", {
        type: "number",
        class: "field field--tiny",
        value: Number(spec![which].toFixed(4)),
        step: "any",
        title: `${which} of the slider range`,
        onChange: (event: Event) => {
          const next = Number((event.target as HTMLInputElement).value);
          if (!Number.isFinite(next)) return;
          spec![which] = next;
          range.min = String(spec!.min);
          range.max = String(spec!.max);
        },
      });

    /**
     * The animator moves the parameter slot every frame but rewrites the row's text only on
     * pause. Rewriting it per frame would rebuild the whole interned expression tree sixty
     * times a second — the same trap that made dragging janky before parameters became slots.
     */
    options.animator.register(
      `row:${view.id}`,
      spec,
      (next) => {
        range.value = String(next);
        readout.textContent = format(next);
        store.setParameter(name, next);
      },
      (next) => {
        const row = store.rows().find((candidate) => candidate.id === view.id);
        if (!row) return;
        const text = `${name} = ${format(next)}`;
        view.input.value = text;
        row.source.set(text);
        options.onEdit(false);
      },
    );

    replace(view.valueHost, [
      el("div", { class: "slider" }, [
        el("label", { class: "slider__label" }, [
          el("span", { text: "value" }),
          readout,
        ]),
        range,
        el("div", { class: "slider__bounds" }, [
          bound("min"),
          el("span", { text: "…" }),
          bound("max"),
          transport(`row:${view.id}`),
        ]),
      ]),
    ]);
  };

  /** Re-typeset one row's echo. KaTeX is the expensive part, so this is called sparingly. */
  const refreshEcho = (view: RowView | undefined) => {
    if (!view) return;
    const row = store.rows().find((candidate) => candidate.id === view.id);
    if (!row) return;
    replace(view.echo, [echoFor(row.source())]);
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
      notes.push(el("div", { class: "row__info", text: message }));
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
      const source = row.source();

      // The echo comes from a plain expression parse where possible so that a bare formula
      // typeset as one; otherwise fall back to the declaration's right-hand side.
      replace(view.echo, [echoFor(source)]);

      const item = resolution.items.get(id) ?? null;
      const label = item ? (KIND_LABEL[item.kind] ?? item.kind) : "";
      view.badge.textContent = label;
      view.badge.className =
        "row__badge" +
        (item && NOT_YET_DRAWN.has(item.kind) ? " row__badge--pending" : "") +
        (label === "" ? " row__badge--empty" : "");

      syncValueSlider(view, item);
      syncChartToggle(view, item);
      syncOverlayControl(view, item);
      syncDomain(view, item);
      syncFrameControl(view, item);

      renderNotes(view, reportById.get(id));
    }

    syncSliders(
      resolution.freeParameters.filter((name) => !resolution.declaredParameters.has(name)),
    );
  };

  const root = el("div", {}, [
    el("section", { class: "panel-section" }, [
      el("h2", { class: "section-title", text: "Expressions" }),
      rowHost,
      addButton,
    ]),
    el("section", { class: "panel-section" }, [
      el("h2", { class: "section-title", text: "Parameters" }),
      sliderHost,
    ]),
  ]);

  syncRows();

  return {
    root,
    refresh,
    refreshReports,
    invalidateSliders: () => {
      renderedSliders = "\u0000";
    },
  };
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
function echoFor(source: string): HTMLElement {
  if (source.trim() === "") return el("span", { class: "echo-empty", text: " " });

  const { row } = parseRow(source);
  if (row) {
    switch (row.kind) {
      case "value":
        return tex(`${nameTex(row.name)} = ${toLatex(row.body)}`);
      case "function":
        return tex(
          `${nameTex(row.name)}\\left(${row.args.map(nameTex).join(", ")}\\right) = ${toLatex(row.body)}`,
        );
      case "vectorFunction":
        return tex(
          `${nameTex(row.name)}\\left(${row.args.map(nameTex).join(", ")}\\right) = ` +
            `\\left(${row.comps.map((c) => toLatex(c)).join(",\\; ")}\\right)`,
        );
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
