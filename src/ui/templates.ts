import { CURVE_CATALOG, type CurveSpec } from "../core/catalog/curves.ts";
import { CATALOG, type ParamDef, type SurfaceSpec } from "../core/catalog/surfaces.ts";
import { sampleBounds } from "../core/geom/types.ts";
import type { DocumentStore, RowId } from "../state/graph.ts";
import type { DomainRange } from "../state/scene.ts";
import { el } from "./dom.ts";
import type { SliderSpec } from "./exprList.ts";

/**
 * Templates: the do Carmo catalog, loaded into the row list.
 *
 * These are the same nine surfaces and six curves the ground-truth suite verifies, stored as
 * **source text** — so a template is not a special hard-coded object, it is exactly what the
 * user could have typed. Loading the sphere and then editing one component is a supported
 * path, not a hack.
 *
 * Loading a template brings three things across, and the last two are what make it actually
 * usable rather than just a formula:
 *
 *  - the parametrization itself, as one row;
 *  - its **parameters**, seeded into the auto-slider machinery with the catalog's own ranges,
 *    so `R` on a sphere gets a radius-shaped slider rather than the generic −5…5;
 *  - its **domain**, with the inset applied. This is not cosmetic: the sphere's chart is
 *    singular at both poles, where `X_u × X_v` vanishes, so sampling the closed interval
 *    [0, π] produces a ring of degenerate vertices. The catalog already records the inset
 *    that pulls sampling inside; dropping it on the floor would make the flagship template
 *    render with holes.
 */

export interface TemplateOptions {
  readonly document: DocumentStore;
  readonly sliders: Map<string, SliderSpec>;
  readonly domains: Map<RowId, DomainRange[]>;
  readonly requestRender: (refit: boolean) => void;
  /** Tell the list its slider specs were replaced, so it rebuilds them. */
  readonly invalidateSliders: () => void;
}

function sliderFor(definition: ParamDef): SliderSpec {
  return {
    value: definition.default,
    min: definition.min,
    max: definition.max,
    step: definition.step,
  };
}

/** `X(u,v) = (a, b, c)` from a surface spec's components. */
function surfaceRow(spec: SurfaceSpec): string {
  return `X(u,v) = (${spec.components.join(", ")})`;
}

function curveRow(spec: CurveSpec): string {
  return `alpha(t) = (${spec.components.join(", ")})`;
}

export function createTemplatePicker(options: TemplateOptions): HTMLElement {
  const { document: store } = options;

  const picker = el("select", { class: "field" }) as HTMLSelectElement;
  picker.append(el("option", { value: "", text: "load a template…" }));

  const surfaceGroup = el("optgroup", { label: "Surfaces" });
  for (const spec of CATALOG) {
    surfaceGroup.append(el("option", { value: `surface:${spec.id}`, text: spec.name }));
  }
  const curveGroup = el("optgroup", { label: "Curves" });
  for (const spec of CURVE_CATALOG) {
    curveGroup.append(el("option", { value: `curve:${spec.id}`, text: spec.name }));
  }
  picker.append(surfaceGroup, curveGroup);

  const blurb = el("p", { class: "blurb" });

  const loadSurface = (spec: SurfaceSpec) => {
    const rows = store.setRows([surfaceRow(spec)]);
    const rowId = rows[0]!.id;

    // Parameters stay symbolic and become sliders, seeded with the catalog's ranges.
    options.sliders.clear();
    for (const definition of spec.params) {
      options.sliders.set(definition.key, sliderFor(definition));
      store.setParameter(definition.key, definition.default);
    }

    // The inset is applied here: `sampleBounds` is what keeps the sphere off its poles.
    const [u0, u1] = sampleBounds(spec.u);
    const [v0, v1] = sampleBounds(spec.v);
    options.domains.clear();
    options.domains.set(rowId, [
      { min: u0, max: u1 },
      { min: v0, max: v1 },
    ]);

    blurb.textContent = spec.blurb;
    options.invalidateSliders();
    options.requestRender(true);
  };

  const loadCurve = (spec: CurveSpec) => {
    const rows = store.setRows([curveRow(spec)]);
    const rowId = rows[0]!.id;

    options.sliders.clear();
    for (const definition of spec.params) {
      options.sliders.set(definition.key, sliderFor(definition));
      store.setParameter(definition.key, definition.default);
    }

    const [t0, t1] = sampleBounds(spec.t);
    options.domains.clear();
    options.domains.set(rowId, [{ min: t0, max: t1 }]);

    blurb.textContent = spec.blurb;
    options.invalidateSliders();
    options.requestRender(true);
  };

  picker.addEventListener("change", () => {
    const value = picker.value;
    if (value === "") return;
    const [kind, id] = value.split(":");

    if (kind === "surface") {
      const spec = CATALOG.find((entry) => entry.id === id);
      if (spec) loadSurface(spec);
    } else if (kind === "curve") {
      const spec = CURVE_CATALOG.find((entry) => entry.id === id);
      if (spec) loadCurve(spec);
    }

    // Back to the prompt, so choosing the same template twice reloads it — useful after
    // editing a row into something broken.
    picker.value = "";
  });

  return el("section", { class: "panel-section panel-section--first" }, [
    el("h2", { class: "section-title", text: "Templates" }),
    picker,
    blurb,
  ]);
}
