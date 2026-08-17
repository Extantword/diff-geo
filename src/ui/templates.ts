import { CURVE_CATALOG, type CurveSpec } from "../core/catalog/curves.ts";
import {
  CATALOG,
  CATALOG_FIELDS,
  IMPLICIT_CATALOG,
  type FieldSpec,
  type ImplicitSpec,
  type ParamDef,
  type SurfaceSpec,
} from "../core/catalog/surfaces.ts";
import { sampleBounds } from "../core/geom/types.ts";
import type { DocumentStore, RowId } from "../state/graph.ts";
import type { DomainRange } from "../state/scene.ts";
import { CURVE_NAMES, SURFACE_NAMES, nextName, usedNames } from "../state/naming.ts";
import { el } from "./dom.ts";
import type { SliderSpec } from "./exprList.ts";

/**
 * Templates: the do Carmo catalog, loaded into the row list.
 *
 * These are the same surfaces, level sets and curves the ground-truth suite verifies, stored as
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

/** One catalog entry, for callers that want to build their own picker. */
export interface TemplateEntry {
  readonly name: string;
  readonly blurb: string;
  readonly load: () => void;
}

export interface TemplateOptions {
  readonly document: DocumentStore;
  /**
   * What to put in front of a row the gallery creates.
   *
   * Inside an ambient space every expression belongs to that space, and a template is an
   * expression like any other — loading one there and having it appear somewhere else, or
   * nowhere, is the same bug as typing one and watching it vanish. Empty outside a space.
   */
  readonly prefix?: () => string;
  readonly sliders: Map<string, SliderSpec>;
  readonly domains: Map<RowId, DomainRange[]>;
  readonly requestRender: (refit: boolean) => void;
  /** Tell the list its slider specs were replaced, so it rebuilds them. */
  readonly invalidateSliders: () => void;
  /**
   * Called with a newly created row, so the caller can put it somewhere.
   *
   * The catalog knows what a surface IS; only the app knows where there is room for it.
   */
  readonly onCreated?: (rowId: RowId) => void;
}

function sliderFor(definition: ParamDef): SliderSpec {
  return {
    value: definition.default,
    min: definition.min,
    max: definition.max,
    step: definition.step,
  };
}

/** `X(u,v) = (a, b, c)` from a surface spec's components, under a name nobody is using. */
function surfaceRow(spec: SurfaceSpec, name: string): string {
  return `${name}(u,v) = (${spec.components.join(", ")})`;
}

function curveRow(spec: CurveSpec, name: string): string {
  return `${name}(t) = (${spec.components.join(", ")})`;
}

/**
 * Filled in when the picker is built, so other UI can offer the same catalog.
 *
 * A module-level list rather than a return value because the picker is created once and the
 * right-click menu is built later from somewhere else entirely; threading it through would mean
 * passing the picker to things that have no other use for it.
 */
export let TEMPLATE_ENTRIES: readonly TemplateEntry[] = [];

export function createTemplatePicker(options: TemplateOptions): HTMLElement {
  const { document: store } = options;
  const scope = () => options.prefix?.() ?? "";

  const blurb = el("p", { class: "blurb" });

  const loadSurface = (spec: SurfaceSpec): { rowId: RowId; name: string } => {
    /**
     * ADDED to the document, not substituted for it.
     *
     * Loading a template used to replace every row, which made the catalog a way of starting
     * over rather than a way of building a scene — and silently discarded whatever was already
     * there. Comparing a sphere with a pseudosphere is the ordinary thing to want.
     */
    // A name nobody is using: two rows declaring `X` is not two surfaces, it is one definition
    // overwritten by the other.
    const name = nextName(SURFACE_NAMES, usedNames(store));
    const rowId = store.addRow(`${scope()}${surfaceRow(spec, name)}`).id;

    // Parameters stay symbolic and become sliders, seeded with the catalog's ranges. Existing
    // ones are left alone: another surface may be using them, and a template must not reach into
    // objects it did not create.
    for (const definition of spec.params) {
      if (!options.sliders.has(definition.key)) {
        options.sliders.set(definition.key, sliderFor(definition));
        store.setParameter(definition.key, definition.default);
      }
    }

    // The inset is applied here: `sampleBounds` is what keeps the sphere off its poles.
    const [u0, u1] = sampleBounds(spec.u);
    const [v0, v1] = sampleBounds(spec.v);
    options.domains.set(rowId, [
      { min: u0, max: u1 },
      { min: v0, max: v1 },
    ]);

    blurb.textContent = spec.blurb;
    options.invalidateSliders();
    options.onCreated?.(rowId);
    options.requestRender(true);
    return { rowId, name };
  };

  /**
   * A surface **and** a field on it, as one entry.
   *
   * A vector field has nowhere to live without a patch — it is written in that patch's u and v
   * and is drawn along it — so loading one alone would be loading half an object. Loading the
   * pair is also how the examples teach the notation: the patch's name appears in front of the
   * field, which is the whole binding, and both rows are ordinary text to edit afterwards.
   */
  const loadField = (spec: SurfaceSpec, field: FieldSpec) => {
    const { name } = loadSurface(spec);
    /**
     * Addressed through the space, when there is one: `A: X: VectorField(…)`.
     *
     * The field is stated on the patch, so the patch's name is the prefix that matters — but the
     * patch is *in* a space, and a row that named it without saying where would resolve only
     * while the document has one X anywhere. The address is the whole chain.
     */
    store.addRow(`${scope()}${name}: VectorField(${field.components.join(", ")})`);
    blurb.textContent = field.blurb;
    options.requestRender(true);
  };

  /**
   * A surface given as an equation.
   *
   * Nothing is named: a level set is not a map, so there is no `X(u,v) =` to write and nothing
   * for another row to refer to. What it does need is its **box**, which is not a domain the
   * surface is defined on but a window to look for it in — so the catalog carries one, and a
   * template that arrived without it would search the default ±2 and often find nothing.
   */
  const loadImplicit = (spec: ImplicitSpec) => {
    const rowId = store.addRow(`${scope()}${spec.equation}`).id;

    for (const definition of spec.params) {
      if (!options.sliders.has(definition.key)) {
        options.sliders.set(definition.key, sliderFor(definition));
        store.setParameter(definition.key, definition.default);
      }
    }

    options.domains.set(rowId, [
      { min: spec.box[0], max: spec.box[1] },
      { min: spec.box[0], max: spec.box[1] },
      { min: spec.box[0], max: spec.box[1] },
    ]);

    blurb.textContent = spec.blurb;
    options.invalidateSliders();
    options.onCreated?.(rowId);
    options.requestRender(true);
  };

  const loadCurve = (spec: CurveSpec) => {
    const rowId = store.addRow(
      `${scope()}${curveRow(spec, nextName(CURVE_NAMES, usedNames(store)))}`,
    ).id;

    for (const definition of spec.params) {
      if (!options.sliders.has(definition.key)) {
        options.sliders.set(definition.key, sliderFor(definition));
        store.setParameter(definition.key, definition.default);
      }
    }

    const [t0, t1] = sampleBounds(spec.t);
    options.domains.set(rowId, [{ min: t0, max: t1 }]);

    blurb.textContent = spec.blurb;
    options.invalidateSliders();
    options.onCreated?.(rowId);
    options.requestRender(true);
  };


  /**
   * Every template listed at once, rather than behind a menu.
   *
   * The gallery exists so nobody faces an empty formula box, and a dropdown inside a popover put
   * two clicks and a hidden list between the user and that. Fifteen entries fit comfortably in a
   * column, so showing them is both simpler and faster than any menu could be.
   */
  const entry = (name: string, blurbText: string, load: () => void) =>
    el("button", {
      class: "template",
      title: blurbText,
      onClick: () => {
        load();
        blurb.textContent = blurbText;
      },
    }, [
      el("span", { class: "template__name", text: name }),
    ]);

  /**
   * The catalog as data, so a second picker — the right-click menu — can present the same
   * entries without duplicating what loading one means. Loading is the subtle part: source text,
   * the catalog's parameter ranges, AND the domain with its inset, which is what keeps the sphere
   * off its poles.
   */
  TEMPLATE_ENTRIES = [
    ...CATALOG.map((spec) => ({
      name: spec.name,
      blurb: spec.blurb,
      load: () => loadSurface(spec),
    })),
    ...CURVE_CATALOG.map((spec) => ({
      name: spec.name,
      blurb: spec.blurb,
      load: () => loadCurve(spec),
    })),
    ...IMPLICIT_CATALOG.map((spec) => ({
      name: spec.name,
      blurb: spec.blurb,
      load: () => loadImplicit(spec),
    })),
    ...CATALOG_FIELDS.map(({ spec, field }) => ({
      name: `${spec.name} · ${field.label}`,
      blurb: field.blurb,
      load: () => loadField(spec, field),
    })),
  ];

  return el("div", { class: "templates" }, [
    el("h2", { class: "section-title", text: "Coordinate patches" }),
    el("div", { class: "templates__grid" },
      CATALOG.map((spec) => entry(spec.name, spec.blurb, () => loadSurface(spec)))),
    /**
     * Level sets get their own section, not a place among the patches.
     *
     * They are a different kind of object — an equation rather than a map, with a box rather than
     * a domain, and no chart at all — and half of them are here precisely because they *cannot*
     * be written as a patch.
     */
    el("h2", { class: "section-title", text: "Level sets" }),
    el("div", { class: "templates__grid" },
      IMPLICIT_CATALOG.map((spec) => entry(spec.name, spec.blurb, () => loadImplicit(spec)))),
    el("h2", { class: "section-title", text: "Curves" }),
    el("div", { class: "templates__grid" },
      CURVE_CATALOG.map((spec) => entry(spec.name, spec.blurb, () => loadCurve(spec)))),
    /**
     * Fields come with their surface, so each entry loads a patch and a row stated in its chart.
     * Listed apart from the patches because that is what they are: a second object, drawn ON one.
     */
    el("h2", { class: "section-title", text: "Vector fields" }),
    el("div", { class: "templates__grid" },
      CATALOG_FIELDS.map(({ spec, field }) =>
        entry(`${spec.name} · ${field.label}`, field.blurb, () => loadField(spec, field)))),
    blurb,
  ]);
}
