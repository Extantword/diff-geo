import type { SurfaceSpec } from "../core/catalog/surfaces.ts";
import { toLatex } from "../core/expr/latex.ts";
import { parse } from "../core/expr/parse.ts";
import type { Diagnostic } from "../core/expr/diagnostics.ts";
import { makeChartData, makeSurfacePoint } from "../core/geom/types.ts";
import type { TessellatedSurface } from "../core/mesh/tessellate.ts";
import type { ParametricSurface } from "../core/geom/parametric.ts";
import { el, replace } from "./dom.ts";
import { tex } from "./tex.ts";

/**
 * The side panel: pick a surface, edit its formula, watch the geometry follow.
 *
 * The live typeset echo under each field is the load-bearing affordance here. A
 * plain-text formula box is a worse interface than a menu *unless* the user can see how
 * their text was parsed — it is what makes implicit multiplication and `1/2u` legible
 * rather than mysterious. Everything else in this panel is secondary to that.
 */

export interface PanelOptions {
  readonly catalog: readonly SurfaceSpec[];
  readonly legendGradient: string;
  readonly defaultParams: (spec: SurfaceSpec) => Float64Array;
  readonly show: (
    spec: SurfaceSpec,
    params: Float64Array,
    refit: boolean,
  ) => { built: { surface: ParametricSurface }; mesh: TessellatedSurface };
  readonly onCurvatureToggle: (on: boolean) => void;
}

const COMPONENT_LABELS = ["x", "y", "z"] as const;

export function mountPanel(options: PanelOptions): void {
  const panel = document.querySelector<HTMLElement>(".panel");
  if (!panel) return;

  let spec: SurfaceSpec = options.catalog[0]!;
  let components: [string, string, string] = [...spec.components] as [string, string, string];
  let params = options.defaultParams(spec);

  // ---- containers, created once and refilled ----
  const picker = el("select", { class: "field" });
  const formulaFields = el("div", { class: "formulas" });
  const sliders = el("div", { class: "sliders" });
  const errors = el("div", { class: "errors" });
  const forms = el("div", { class: "forms" });
  const readout = el("div", { class: "readout" });
  const legendLabels = el("div", { class: "legend-labels" });

  for (const entry of options.catalog) {
    picker.append(el("option", { value: entry.id, text: entry.name }));
  }

  const blurb = el("p", { class: "blurb" });

  const rebuild = (refit: boolean) => {
    // Parse each component on its own so a mistake in z does not blank x and y.
    const diagnostics: Diagnostic[] = [];
    const parsed = components.map((source, index) => {
      const result = parse(source);
      for (const d of result.diags) {
        diagnostics.push({ ...d, message: `${COMPONENT_LABELS[index]}: ${d.message}` });
      }
      return result.expr;
    });

    replace(
      errors,
      diagnostics.map((d) =>
        el("div", { class: `diag diag--${d.severity}`, text: d.message }),
      ),
    );

    // The typeset echo renders whatever parsed, even if a sibling failed.
    replace(
      formulaFields,
      components.map((source, index) =>
        el("div", { class: "formula" }, [
          el("label", { class: "formula__label" }, [`${COMPONENT_LABELS[index]} =`]),
          el("input", {
            class: "field field--mono",
            value: source,
            spellcheck: "false",
            onInput: (event: Event) => {
              components[index] = (event.target as HTMLInputElement).value;
              rebuild(false);
            },
          }),
          el("div", { class: "formula__echo" }, [
            parsed[index] ? tex(toLatex(parsed[index]!)) : el("span", { text: "—" }),
          ]),
        ]),
      ),
    );

    if (parsed.some((expr) => expr === null)) {
      replace(readout, [el("div", { text: "waiting for a complete formula" })]);
      return;
    }

    const liveSpec: SurfaceSpec = { ...spec, components };
    let result;
    try {
      result = options.show(liveSpec, params, refit);
    } catch (error) {
      replace(errors, [
        el("div", {
          class: "diag diag--error",
          text: error instanceof Error ? error.message : String(error),
        }),
      ]);
      return;
    }

    const { mesh } = result;
    const surface = result.built.surface;

    // Fundamental forms at the centre of the domain — the exact quantities, live.
    const point = makeSurfacePoint();
    const chart = makeChartData();
    const uMid = (surface.u.min + surface.u.max) / 2;
    const vMid = (surface.v.min + surface.v.max) / 2;
    surface.at(uMid, vMid, params, point, chart);

    const fmt = (x: number) => (Number.isFinite(x) ? x.toFixed(4) : "—");
    replace(forms, [
      el("div", { class: "forms__at", text: `at u = ${uMid.toFixed(3)}, v = ${vMid.toFixed(3)}` }),
      tex(
        `\\mathrm{I} = \\begin{pmatrix} ${fmt(chart.I[0][0])} & ${fmt(chart.I[0][1])} \\\\ ` +
          `${fmt(chart.I[1][0])} & ${fmt(chart.I[1][1])} \\end{pmatrix}`,
        true,
      ),
      tex(
        `\\mathrm{II} = \\begin{pmatrix} ${fmt(chart.II[0][0])} & ${fmt(chart.II[0][1])} \\\\ ` +
          `${fmt(chart.II[1][0])} & ${fmt(chart.II[1][1])} \\end{pmatrix}`,
        true,
      ),
      tex(`K = ${fmt(point.K)} \\qquad H = ${fmt(point.H)}`, true),
      tex(`k_1 = ${fmt(point.k1)} \\qquad k_2 = ${fmt(point.k2)}`, true),
      point.umbilic
        ? el("div", { class: "note", text: point.planar ? "planar point" : "umbilic point" })
        : null,
      point.degenerate
        ? el("div", { class: "note", text: "degenerate: no tangent plane here" })
        : null,
    ]);

    replace(legendLabels, [
      el("span", { text: (-mesh.range.scale).toPrecision(3) }),
      el("span", { text: "K" }),
      el("span", { text: mesh.range.scale.toPrecision(3) }),
    ]);

    const dropped =
      mesh.droppedVertices === 0 && mesh.droppedTriangles === 0
        ? "none"
        : `${mesh.droppedVertices} vertices, ${mesh.droppedTriangles} triangles`;

    replace(readout, [
      el("div", { text: `K range     ${fmt(mesh.range.minK)} … ${fmt(mesh.range.maxK)}` }),
      el("div", { text: `colour scale ±${mesh.range.scale.toPrecision(3)}` }),
      el("div", { text: `triangles   ${mesh.triangleCount.toLocaleString()}` }),
      el("div", { text: `dropped     ${dropped}` }),
    ]);

    if (mesh.range.invalidFraction > 0.5) {
      errors.append(
        el("div", {
          class: "diag diag--warning",
          text:
            `${Math.round(mesh.range.invalidFraction * 100)}% of sampled points have no ` +
            `tangent plane — check the domain or the formula`,
        }),
      );
    }
  };

  const rebuildSliders = () => {
    replace(
      sliders,
      spec.params.map((definition, index) =>
        el("div", { class: "slider" }, [
          el("label", { class: "slider__label" }, [
            el("span", { text: definition.label }),
            el("span", { class: "slider__value", text: params[index]!.toFixed(2) }),
          ]),
          el("input", {
            type: "range",
            class: "slider__input",
            min: definition.min,
            max: definition.max,
            step: definition.step,
            value: params[index]!,
            onInput: (event: Event) => {
              const value = Number((event.target as HTMLInputElement).value);
              // Parameters are compiled as slots, so moving a slider recompiles nothing.
              params[index] = value;
              const label = (event.target as HTMLElement)
                .previousElementSibling?.querySelector(".slider__value");
              if (label) label.textContent = value.toFixed(2);
              rebuild(false);
            },
          }),
        ]),
      ),
    );
  };

  const selectSpec = (id: string) => {
    spec = options.catalog.find((entry) => entry.id === id) ?? spec;
    components = [...spec.components] as [string, string, string];
    params = options.defaultParams(spec);
    blurb.textContent = spec.blurb;
    rebuildSliders();
    rebuild(true);
  };

  picker.addEventListener("change", () => selectSpec(picker.value));

  const curvatureToggle = el("input", {
    type: "checkbox",
    checked: true,
    onChange: (event: Event) =>
      options.onCurvatureToggle((event.target as HTMLInputElement).checked),
  });

  replace(panel, [
    el("header", { class: "panel-header" }, [
      el("h1", { text: "DiffGeo" }),
      el("p", { text: "Curves and surfaces in R³, after do Carmo." }),
    ]),
    el("section", { class: "panel-section" }, [
      el("h2", { class: "section-title", text: "Surface" }),
      picker,
      blurb,
      formulaFields,
      errors,
    ]),
    el("section", { class: "panel-section" }, [
      el("h2", { class: "section-title", text: "Parameters" }),
      sliders,
    ]),
    el("section", { class: "panel-section" }, [
      el("h2", { class: "section-title", text: "Gaussian curvature" }),
      el("label", { class: "toggle" }, [curvatureToggle, el("span", { text: "paint K" })]),
      el("div", { class: "legend", style: `background:${options.legendGradient}` }),
      legendLabels,
    ]),
    el("section", { class: "panel-section" }, [
      el("h2", { class: "section-title", text: "Fundamental forms" }),
      forms,
    ]),
    el("section", { class: "panel-section" }, [
      el("h2", { class: "section-title", text: "Mesh" }),
      readout,
    ]),
  ]);

  blurb.textContent = spec.blurb;
  rebuildSliders();
  rebuild(true);
}
