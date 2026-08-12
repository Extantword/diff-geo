import type { SurfaceSpec } from "../core/catalog/surfaces.ts";
import { toLatex } from "../core/expr/latex.ts";
import { parse } from "../core/expr/parse.ts";
import type { Diagnostic } from "../core/expr/diagnostics.ts";
import { makeChartData, makeSurfacePoint } from "../core/geom/types.ts";
import type { ParametricSurface } from "../core/geom/parametric.ts";
import type { TessellatedSurface } from "../core/mesh/tessellate.ts";
import { createCurveSection } from "./curvePanel.ts";
import type { LineGroup } from "../gl/passes/lines.ts";
import type { Vec3 } from "../core/geom/types.ts";
import { el, formatValue, replace } from "./dom.ts";
import { tex } from "./tex.ts";

/**
 * The side panel: pick a surface, edit its formula, watch the geometry follow.
 *
 * ## Two rules, both learned the hard way
 *
 * **1. An element the user might be typing in is created once and never replaced.**
 * Rebuilding the inputs on each keystroke destroys the focused element and the caret
 * goes with it, which reads as the UI refusing input. So the fields are built once per
 * surface selection, and editing only ever *updates* their echo and diagnostics.
 *
 * **2. The cheap path and the expensive path are separated.** Parsing and typesetting a
 * formula takes microseconds and runs on every keystroke, so the echo is always live.
 * Recompiling the jet and retessellating ~25k vertices takes long enough to stutter, so
 * it is debounced — first at draft resolution for responsiveness, then at full
 * resolution once typing stops. A transiently broken formula leaves the last good
 * surface on screen rather than blanking it.
 */

export interface PanelOptions {
  readonly catalog: readonly SurfaceSpec[];
  readonly legendGradient: string;
  readonly defaultParams: (spec: SurfaceSpec) => Float64Array;
  /** Parse, differentiate and compile. Throws with a readable message on failure. */
  readonly compile: (spec: SurfaceSpec) => ParametricSurface;
  /** Tessellate an already-compiled surface and upload it. */
  readonly render: (
    surface: ParametricSurface,
    params: Float64Array,
    resolution: number,
    refit: boolean,
  ) => TessellatedSurface;
  readonly onCurvatureToggle: (on: boolean) => void;
  readonly setLines: (groups: readonly LineGroup[]) => void;
  readonly setSurfaceVisible: (visible: boolean) => void;
  readonly frameCamera: (center: Vec3, radius: number) => void;
}

const COMPONENT_LABELS = ["x", "y", "z"] as const;

/** Coarse mesh while the user is still typing or dragging. */
const DRAFT_RESOLUTION = 72;
/** Full mesh once things settle. */
const FULL_RESOLUTION = 160;

const DRAFT_DELAY_MS = 90;
const FULL_DELAY_MS = 320;

interface FormulaField {
  readonly root: HTMLElement;
  readonly input: HTMLInputElement;
  readonly echo: HTMLElement;
}

export function mountPanel(options: PanelOptions): void {
  const panel = document.querySelector<HTMLElement>(".panel");
  if (!panel) return;

  let spec: SurfaceSpec = options.catalog[0]!;
  let components: [string, string, string] = [...spec.components];
  let params = options.defaultParams(spec);

  /** The compiled surface, plus the key it was compiled from. */
  let compiled: ParametricSurface | null = null;
  let compiledKey = "";
  let fields: FormulaField[] = [];

  let draftTimer = 0;
  let fullTimer = 0;

  const picker = el("select", { class: "field" });
  for (const entry of options.catalog) {
    picker.append(el("option", { value: entry.id, text: entry.name }));
  }
  const blurb = el("p", { class: "blurb" });
  const formulaHost = el("div", { class: "formulas" });
  const errors = el("div", { class: "errors" });
  /** Runtime notices (compile failure, mostly-degenerate domain). Cleared per render,
   *  unlike `errors`, which is owned by the per-keystroke parse pass. */
  const warnings = el("div", { class: "errors" });
  const sliders = el("div", { class: "sliders" });
  const forms = el("div", { class: "forms" });
  const readout = el("div", { class: "readout" });
  const legendLabels = el("div", { class: "legend-labels" });

  // ---- the cheap path: parse, typeset, diagnose. Runs on every keystroke. ----

  const refreshEchoes = (): boolean => {
    const diagnostics: Diagnostic[] = [];
    let allParsed = true;

    components.forEach((source, index) => {
      const { expr, diags } = parse(source);
      for (const d of diags) {
        diagnostics.push({ ...d, message: `${COMPONENT_LABELS[index]}: ${d.message}` });
      }
      const field = fields[index];
      if (field) {
        // Only the echo is replaced. The input itself is untouched, so focus and the
        // caret survive.
        replace(field.echo, [expr ? tex(toLatex(expr)) : el("span", { text: "—" })]);
      }
      if (!expr) allParsed = false;
    });

    replace(
      errors,
      diagnostics.map((d) =>
        el("div", { class: `diag diag--${d.severity}`, text: d.message }),
      ),
    );
    return allParsed;
  };

  // ---- the expensive path: compile and tessellate. Debounced. ----

  const compileIfNeeded = (): boolean => {
    const key = `${spec.id}|${components.join("|")}`;
    if (compiled && key === compiledKey) return true;
    try {
      compiled = options.compile({ ...spec, components });
      compiledKey = key;
      return true;
    } catch (error) {
      replace(warnings, [
        el("div", {
          class: "diag diag--error",
          text: error instanceof Error ? error.message : String(error),
        }),
      ]);
      return false;
    }
  };

  const renderAt = (resolution: number, refit: boolean) => {
    if (!compiled) return;
    const mesh = options.render(compiled, params, resolution, refit);
    replace(warnings, []);
    updateForms(compiled);
    updateMeshReadout(mesh);
  };

  const scheduleHeavy = (refit: boolean, paramsOnly = false) => {
    window.clearTimeout(draftTimer);
    window.clearTimeout(fullTimer);

    draftTimer = window.setTimeout(() => {
      if (!paramsOnly && !compileIfNeeded()) return;
      renderAt(DRAFT_RESOLUTION, refit);
    }, paramsOnly ? 0 : DRAFT_DELAY_MS);

    fullTimer = window.setTimeout(() => {
      if (!compiled) return;
      renderAt(FULL_RESOLUTION, false);
    }, FULL_DELAY_MS);
  };

  const onEdit = () => {
    const allParsed = refreshEchoes();
    // A half-typed formula leaves the previous surface on screen rather than blanking
    // the canvas, so the view stays stable while editing.
    if (allParsed) scheduleHeavy(false);
  };

  // ---- rendering the derived panels ----


  const updateForms = (surface: ParametricSurface) => {
    const point = makeSurfacePoint();
    const chart = makeChartData();
    const uMid = (surface.u.min + surface.u.max) / 2;
    const vMid = (surface.v.min + surface.v.max) / 2;
    surface.at(uMid, vMid, params, point, chart);

    replace(forms, [
      el("div", {
        class: "forms__at",
        text: `at u = ${uMid.toFixed(3)}, v = ${vMid.toFixed(3)}`,
      }),
      tex(
        `\\mathrm{I} = \\begin{pmatrix} ${formatValue(chart.I[0][0])} & ${formatValue(chart.I[0][1])} \\\\ ` +
          `${formatValue(chart.I[1][0])} & ${formatValue(chart.I[1][1])} \\end{pmatrix}`,
        true,
      ),
      tex(
        `\\mathrm{II} = \\begin{pmatrix} ${formatValue(chart.II[0][0])} & ${formatValue(chart.II[0][1])} \\\\ ` +
          `${formatValue(chart.II[1][0])} & ${formatValue(chart.II[1][1])} \\end{pmatrix}`,
        true,
      ),
      tex(`K = ${formatValue(point.K)} \\qquad H = ${formatValue(point.H)}`, true),
      tex(`k_1 = ${formatValue(point.k1)} \\qquad k_2 = ${formatValue(point.k2)}`, true),
      point.umbilic
        ? el("div", {
            class: "note",
            text: point.planar ? "planar point" : "umbilic point",
          })
        : null,
      point.degenerate
        ? el("div", { class: "note", text: "degenerate: no tangent plane here" })
        : null,
    ]);
  };

  const updateMeshReadout = (mesh: TessellatedSurface) => {
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
      el("div", { text: `K range     ${formatValue(mesh.range.minK)} … ${formatValue(mesh.range.maxK)}` }),
      el("div", { text: `scale       ±${mesh.range.scale.toPrecision(3)}` }),
      el("div", { text: `triangles   ${mesh.triangleCount.toLocaleString()}` }),
      el("div", { text: `dropped     ${dropped}` }),
    ]);

    if (mesh.range.invalidFraction > 0.5) {
      warnings.append(
        el("div", {
          class: "diag diag--warning",
          text:
            `${Math.round(mesh.range.invalidFraction * 100)}% of sampled points have no ` +
            `tangent plane — check the domain or the formula`,
        }),
      );
    }
  };

  // ---- built once per surface selection ----

  const buildFields = () => {
    fields = components.map((source, index) => {
      const input = el("input", {
        class: "field field--mono",
        value: source,
        spellcheck: "false",
        onInput: () => {
          components[index] = input.value;
          onEdit();
        },
      }) as HTMLInputElement;
      const echo = el("div", { class: "formula__echo" });
      const root = el("div", { class: "formula" }, [
        el("label", { class: "formula__label", text: `${COMPONENT_LABELS[index]} =` }),
        input,
        echo,
      ]);
      return { root, input, echo };
    });
    replace(formulaHost, fields.map((field) => field.root));
  };

  const buildSliders = () => {
    replace(
      sliders,
      spec.params.map((definition, index) => {
        const value = el("span", {
          class: "slider__value",
          text: params[index]!.toFixed(2),
        });
        const input = el("input", {
          type: "range",
          class: "slider__input",
          min: definition.min,
          max: definition.max,
          step: definition.step,
          value: params[index]!,
          onInput: () => {
            params[index] = Number((input as HTMLInputElement).value);
            value.textContent = params[index]!.toFixed(2);
            // Parameters are compiled as slots, so nothing recompiles here — only the
            // sampling and upload repeat.
            scheduleHeavy(false, true);
          },
        }) as HTMLInputElement;
        return el("div", { class: "slider" }, [
          el("label", { class: "slider__label" }, [
            el("span", { text: definition.label }),
            value,
          ]),
          input,
        ]);
      }),
    );
  };

  const selectSpec = (id: string) => {
    spec = options.catalog.find((entry) => entry.id === id) ?? spec;
    components = [...spec.components];
    params = options.defaultParams(spec);
    compiled = null;
    compiledKey = "";
    blurb.textContent = spec.blurb;
    buildFields();
    buildSliders();
    refreshEchoes();
    // Fresh surface: compile and fit immediately rather than waiting out the debounce.
    if (compileIfNeeded()) renderAt(FULL_RESOLUTION, true);
  };

  picker.addEventListener("change", () => selectSpec(picker.value));

  const curvatureToggle = el("input", {
    type: "checkbox",
    checked: true,
    onChange: (event: Event) =>
      options.onCurvatureToggle((event.target as HTMLInputElement).checked),
  });


  const curveSection = createCurveSection({
    setLines: options.setLines,
    frame: options.frameCamera,
  });

  const surfaceSections = el("div", {}, [
    el("section", { class: "panel-section" }, [
      el("h2", { class: "section-title", text: "Surface" }),
      picker,
      blurb,
      formulaHost,
      errors,
      warnings,
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

  const setMode = (mode: "surface" | "curve") => {
    const surfaceMode = mode === "surface";
    surfaceSections.hidden = !surfaceMode;
    curveSection.root.hidden = surfaceMode;
    options.setSurfaceVisible(surfaceMode);
    curveSection.setActive(!surfaceMode);
    if (surfaceMode) {
      // Clear the lines explicitly: the surface view owns the whole scene.
      options.setLines([]);
      if (compileIfNeeded()) renderAt(FULL_RESOLUTION, true);
    }
  };

  const modeSwitch = el("div", { class: "modes" }, [
    el("button", {
      class: "mode mode--active",
      text: "Surfaces",
      onClick: (event: Event) => {
        setActive(event.target as HTMLElement);
        setMode("surface");
      },
    }),
    el("button", {
      class: "mode",
      text: "Curves",
      onClick: (event: Event) => {
        setActive(event.target as HTMLElement);
        setMode("curve");
      },
    }),
  ]);

  function setActive(button: HTMLElement) {
    for (const child of Array.from(modeSwitch.children)) {
      child.classList.toggle("mode--active", child === button);
    }
  }

  replace(panel, [
    el("header", { class: "panel-header" }, [
      el("h1", { text: "DiffGeo" }),
      el("p", { text: "Curves and surfaces in R\u00b3, after do Carmo." }),
    ]),
    modeSwitch,
    surfaceSections,
    curveSection.root,
  ]);

  curveSection.root.hidden = true;
  selectSpec(spec.id);
}
