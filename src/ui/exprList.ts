import type { Diagnostic } from "../core/expr/diagnostics.ts";
import { toLatex } from "../core/expr/latex.ts";
import { parse, parseRow } from "../core/expr/parse.ts";
import type { DocumentStore, Item, RowId } from "../state/graph.ts";
import {
  DEFAULT_DOMAIN,
  type DomainRange,
  type FrameRequest,
  type RowReport,
} from "../state/scene.ts";
import { el, replace } from "./dom.ts";
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
  /** Recompute and redraw. Called after any edit; the caller debounces. */
  readonly requestRender: (refit: boolean) => void;
  /** Per-row domain ranges, mutated in place by the domain inputs. */
  readonly domains: Map<RowId, DomainRange[]>;
  /** Slider state, mutated in place. */
  readonly sliders: Map<string, SliderSpec>;
  /** Which curve rows show a moving frame, and where along the curve. */
  readonly frames: Map<RowId, FrameRequest>;
  /** Slider bounds for rows that define a plain number, keyed by row. */
  readonly rowSliders: Map<RowId, SliderSpec>;
}

export interface ExprList {
  readonly root: HTMLElement;
  /** Refresh echoes, badges and diagnostics from the current resolution. */
  refresh(reports: readonly RowReport[]): void;
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

  const addButton = el("button", {
    class: "add-row",
    text: "+ add expression",
    onClick: () => {
      store.addRow("");
      syncRows();
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
        options.requestRender(false);
      },
    }) as HTMLInputElement;

    const echo = el("div", { class: "formula__echo" });
    const badge = el("span", { class: "row__badge" });
    const notes = el("div", { class: "row__notes" });
    const domainHost = el("div", { class: "row__domain" });
    const frameHost = el("div", { class: "row__frame" });
    const valueHost = el("div", { class: "row__value" });

    const remove = el("button", {
      class: "row__remove",
      title: "remove this expression",
      text: "×",
      onClick: () => {
        store.removeRow(id);
        views.get(id)?.root.remove();
        views.delete(id);
        options.requestRender(false);
      },
    });

    const root = el("div", { class: "row" }, [
      el("div", { class: "row__head" }, [badge, remove]),
      input,
      echo,
      valueHost,
      domainHost,
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
      domainVars: "",
      valueName: "",
    };
  }

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
      if (!names.includes(name)) options.sliders.delete(name);
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
        options.requestRender(false);
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

    return el("div", { class: "slider" }, [
      el("label", { class: "slider__label" }, [
        tex(name.length === 1 ? name : `\\mathrm{${name}}`),
        readout,
      ]),
      range,
      el("div", { class: "slider__bounds" }, [bound("min"), el("span", { text: "…" }), bound("max")]),
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
              options.requestRender(false);
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
        options.requestRender(false);
      },
    }) as HTMLInputElement;

    const toggle = el("input", {
      type: "checkbox",
      checked: show,
      onChange: () => {
        show = toggle.checked;
        commit();
        position.disabled = !show;
        options.requestRender(false);
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
        options.requestRender(false);
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
        options.requestRender(false);
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
        ]),
      ]),
    ]);
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
      syncDomain(view, item);
      syncFrameControl(view, item);

      const diagnostics = resolution.diagnostics.get(id) ?? [];
      const report = reportById.get(id);
      const notes: HTMLElement[] = [];
      for (const diagnostic of diagnostics) notes.push(diagnosticNode(diagnostic));
      if (report?.error) {
        notes.push(el("div", { class: "diag diag--error", text: report.error }));
      }
      if (report?.warning) {
        notes.push(el("div", { class: "diag diag--warning", text: report.warning }));
      }
      if (report?.info) {
        notes.push(el("div", { class: "row__info", text: report.info }));
      }
      if (item && NOT_YET_DRAWN.has(item.kind)) {
        notes.push(
          el("div", {
            class: "diag diag--hint",
            text: `recognized as a ${label}, but drawing these is not implemented yet`,
          }),
        );
      }
      replace(view.notes, notes);
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
