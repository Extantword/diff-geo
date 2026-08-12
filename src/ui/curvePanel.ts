import {
  buildSpaceCurve,
  CURVE_CATALOG,
  curveParamsWith,
  defaultCurveParams,
  type CurveSpec,
} from "../core/catalog/curves.ts";
import { toLatex } from "../core/expr/latex.ts";
import { parse } from "../core/expr/parse.ts";
import type { Diagnostic } from "../core/expr/diagnostics.ts";
import {
  bishopFrames,
  makeFrenetFrame,
  type SpaceCurve,
} from "../core/geom/curve.ts";
import { sampleBounds, type Vec3 } from "../core/geom/types.ts";
import type { LineGroup, Polyline } from "../gl/passes/lines.ts";
import { el, formatValue, replace } from "./dom.ts";
import { tex } from "./tex.ts";

/**
 * The curve section: a space curve drawn as a thick line, with its Frenet trihedron at a
 * movable parameter value and live κ, τ.
 *
 * The trihedron is the point of the section. It is also the honest demonstration of the
 * degeneracy policy: on the straight line and at the cusp, N and B simply are not drawn,
 * and the readout says why rather than showing a plausible wrong arrow.
 */

/** Colour language shared with the surface legend and style.css. */
const CURVE_COLOR: Vec3 = [0.45, 0.78, 1.0];
const T_COLOR: Vec3 = [0.42, 1.0, 0.58];
const N_COLOR: Vec3 = [1.0, 0.88, 0.4];
const B_COLOR: Vec3 = [1.0, 0.42, 0.42];

const SAMPLES = 900;

export interface CurveSectionOptions {
  readonly setLines: (groups: readonly LineGroup[]) => void;
  readonly frame: (center: Vec3, radius: number) => void;
}

export interface CurveSection {
  readonly root: HTMLElement;
  /**
   * Show or hide this view. The section draws nothing at all while inactive — building
   * the controls must not put geometry on screen, or the curve and the surface both
   * render at once and fight over the camera framing.
   */
  setActive: (active: boolean, refit?: boolean) => void;
}

/** A two-point polyline, for one frame vector. */
function arrow(from: Vec3, direction: Vec3, length: number, color: Vec3): Polyline {
  const points = new Float64Array([
    from[0],
    from[1],
    from[2],
    from[0] + direction[0] * length,
    from[1] + direction[1] * length,
    from[2] + direction[2] * length,
  ]);
  return { points, count: 2, color, arcLength: new Float64Array([0, length]) };
}

export function createCurveSection(options: CurveSectionOptions): CurveSection {
  let spec: CurveSpec = CURVE_CATALOG[0]!;
  let components: string[] = [...spec.components];
  let params = defaultCurveParams(spec);
  let tFraction = 0.5;

  let curve: SpaceCurve | null = null;
  let compiledKey = "";
  /** Nothing is drawn until the view is selected. */
  let active = false;

  const picker = el("select", { class: "field" });
  for (const entry of CURVE_CATALOG) {
    picker.append(el("option", { value: entry.id, text: entry.name }));
  }
  const blurb = el("p", { class: "blurb" });
  const formulaHost = el("div", { class: "formulas" });
  const errors = el("div", { class: "errors" });
  const sliders = el("div", { class: "sliders" });
  const tHost = el("div", { class: "slider" });
  const frenetOut = el("div", { class: "forms" });

  let fields: Array<{ input: HTMLInputElement; echo: HTMLElement }> = [];
  let heavyTimer = 0;

  const refreshEchoes = (): boolean => {
    const diagnostics: Diagnostic[] = [];
    let ok = true;
    const labels = ["x", "y", "z"];
    components.forEach((source, index) => {
      const { expr, diags } = parse(source);
      for (const d of diags) {
        diagnostics.push({ ...d, message: `${labels[index]}: ${d.message}` });
      }
      const field = fields[index];
      if (field) {
        replace(field.echo, [expr ? tex(toLatex(expr)) : el("span", { text: "—" })]);
      }
      if (!expr) ok = false;
    });
    replace(
      errors,
      diagnostics.map((d) =>
        el("div", { class: `diag diag--${d.severity}`, text: d.message }),
      ),
    );
    return ok;
  };

  const compileIfNeeded = (): boolean => {
    const key = `${spec.id}|${components.join("|")}`;
    if (curve && key === compiledKey) return true;
    try {
      curve = buildSpaceCurve({ ...spec, components });
      compiledKey = key;
      return true;
    } catch (error) {
      errors.append(
        el("div", {
          class: "diag diag--error",
          text: error instanceof Error ? error.message : String(error),
        }),
      );
      return false;
    }
  };

  const draw = (refit: boolean) => {
    if (!curve || !active) return;
    const frames = bishopFrames(curve, params, SAMPLES);

    // Extent drives both the camera and the glyph length, so the trihedron stays legible
    // on a curve of any scale.
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < frames.count; i++) {
      if (!frames.valid[i]) continue;
      const x = frames.points[i * 3]!;
      const y = frames.points[i * 3 + 1]!;
      const z = frames.points[i * 3 + 2]!;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
    }
    const finite = Number.isFinite(minX);
    const center: Vec3 = finite
      ? [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2]
      : [0, 0, 0];
    const radius = finite
      ? Math.max(Math.hypot(maxX - center[0], maxY - center[1], maxZ - center[2]), 0.1)
      : 1;

    const [t0, t1] = sampleBounds(curve.t);
    const t = t0 + (t1 - t0) * tFraction;
    const frame = makeFrenetFrame();
    curve.frenet(t, params, frame);

    const glyphLength = radius * 0.28;
    const glyphs: Polyline[] = [];
    if (frame.status !== "singular") {
      glyphs.push(arrow(frame.p, frame.T, glyphLength, T_COLOR));
    }
    // N and B exist only where the osculating plane does. Not drawing them is the whole
    // point of tracking `status`.
    if (frame.status === "regular") {
      glyphs.push(arrow(frame.p, frame.N, glyphLength, N_COLOR));
      glyphs.push(arrow(frame.p, frame.B, glyphLength, B_COLOR));
    }

    options.setLines([
      {
        polylines: [
          {
            points: frames.points,
            count: frames.count,
            valid: frames.valid,
            arcLength: frames.arcLength,
            color: CURVE_COLOR,
          },
        ],
        style: { widthPx: 3.5 },
      },
      { polylines: glyphs, style: { widthPx: 5 } },
    ]);

    if (refit) options.frame(center, radius);

    replace(frenetOut, [
      el("div", { class: "forms__at", text: `at t = ${t.toFixed(3)}` }),
      tex(`\\kappa = ${formatValue(frame.kappa)}`, true),
      tex(frame.tauValid ? `\\tau = ${formatValue(frame.tau)}` : `\\tau = \\text{—}`, true),
      el("div", { class: "note", text: statusNote(frame.status, frame.tauValid) }),
      el("div", { class: "legend-labels" }, [
        el("span", { text: "T" }),
        el("span", { text: "N" }),
        el("span", { text: "B" }),
      ]),
    ]);
  };

  const scheduleHeavy = (refit: boolean, paramsOnly = false) => {
    window.clearTimeout(heavyTimer);
    heavyTimer = window.setTimeout(
      () => {
        if (!paramsOnly && !compileIfNeeded()) return;
        draw(refit);
      },
      paramsOnly ? 0 : 90,
    );
  };

  const buildFields = () => {
    const labels = ["x", "y", "z"];
    fields = components.map((source, index) => {
      const input = el("input", {
        class: "field field--mono",
        value: source,
        spellcheck: "false",
        onInput: () => {
          components[index] = input.value;
          if (refreshEchoes()) scheduleHeavy(false);
        },
      }) as HTMLInputElement;
      const echo = el("div", { class: "formula__echo" });
      formulaHost.append(
        el("div", { class: "formula" }, [
          el("label", { class: "formula__label", text: `${labels[index]} =` }),
          input,
          echo,
        ]),
      );
      return { input, echo };
    });
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
            params[index] = Number(input.value);
            value.textContent = params[index]!.toFixed(2);
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

    const tValue = el("span", { class: "slider__value", text: tFraction.toFixed(2) });
    const tInput = el("input", {
      type: "range",
      class: "slider__input",
      min: 0,
      max: 1,
      step: 0.002,
      value: tFraction,
      onInput: () => {
        tFraction = Number(tInput.value);
        tValue.textContent = tFraction.toFixed(2);
        // Only the trihedron moves, so this is cheap enough to run immediately.
        draw(false);
      },
    }) as HTMLInputElement;
    replace(tHost, [
      el("label", { class: "slider__label" }, [
        el("span", { text: "frame position t" }),
        tValue,
      ]),
      tInput,
    ]);
  };

  const selectSpec = (id: string) => {
    spec = CURVE_CATALOG.find((entry) => entry.id === id) ?? spec;
    components = [...spec.components];
    params = curveParamsWith(spec, {});
    curve = null;
    compiledKey = "";
    blurb.textContent = spec.blurb;
    replace(formulaHost, []);
    buildFields();
    buildSliders();
    refreshEchoes();
    if (compileIfNeeded()) draw(true);
  };

  picker.addEventListener("change", () => selectSpec(picker.value));

  const root = el("div", {}, [
    el("section", { class: "panel-section" }, [
      el("h2", { class: "section-title", text: "Curve" }),
      picker,
      blurb,
      formulaHost,
      errors,
    ]),
    el("section", { class: "panel-section" }, [
      el("h2", { class: "section-title", text: "Parameters" }),
      sliders,
      tHost,
    ]),
    el("section", { class: "panel-section" }, [
      el("h2", { class: "section-title", text: "Frenet apparatus" }),
      frenetOut,
    ]),
  ]);

  // Build the controls and the typeset echo, but draw nothing yet.
  selectSpec(spec.id);

  return {
    root,
    setActive: (next, refit = true) => {
      active = next;
      if (!next) return;
      if (compileIfNeeded()) draw(refit);
    },
  };
}

function statusNote(status: string, tauValid: boolean): string {
  if (status === "singular") {
    return "|α′| = 0 — the parametrization is singular here, so no frame exists";
  }
  if (status === "inflection") {
    return "κ = 0 — the osculating plane is undefined, so N and B are not drawn";
  }
  if (!tauValid) return "κ is too small for τ to be meaningful";
  return "T tangent · N principal normal · B binormal";
}
