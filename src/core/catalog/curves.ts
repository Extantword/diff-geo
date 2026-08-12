import { hasErrors, type Diagnostic } from "../expr/diagnostics.ts";
import { parse } from "../expr/parse.ts";
import { buildDiffMap } from "../jets/compile.ts";
import {
  createPlaneCurve,
  createSpaceCurve,
  type PlaneCurve,
  type SpaceCurve,
} from "../geom/curve.ts";
import { interval, type Interval } from "../geom/types.ts";
import type { ParamDef } from "./surfaces.ts";

/**
 * Curves from do Carmo Chapter 1, stored as source text like the surfaces.
 *
 * The degenerate entries are as important as the classical ones: a straight line, an
 * inflection and a cusp are what a user's typing will produce, and they are the cases
 * where a naive Frenet implementation emits NaN and poisons the renderer.
 */

export interface CurveSpec {
  readonly id: string;
  readonly name: string;
  readonly blurb: string;
  /** components of α, as source text; 3 for a space curve, 2 for a plane curve */
  readonly components: readonly string[];
  readonly params: readonly ParamDef[];
  readonly t: Interval;
  readonly periodic?: boolean;
}

export const CURVE_CATALOG: readonly CurveSpec[] = [
  {
    id: "helix",
    name: "Circular helix",
    blurb: "κ = a/(a²+b²) and τ = b/(a²+b²), both constant — the only such curve.",
    components: ["a cos t", "a sin t", "b t"],
    params: [
      { key: "a", label: "radius a", min: 0.2, max: 2, step: 0.05, default: 1 },
      { key: "b", label: "pitch b", min: -1, max: 1, step: 0.05, default: 0.3 },
    ],
    t: interval(-3 * Math.PI, 3 * Math.PI),
  },
  {
    id: "circle",
    name: "Circle",
    blurb: "κ = 1/a, τ = 0. A plane curve seen in space.",
    components: ["a cos t", "a sin t", "0"],
    params: [{ key: "a", label: "radius a", min: 0.2, max: 2, step: 0.05, default: 1 }],
    t: interval(0, 2 * Math.PI),
    periodic: true,
  },
  {
    id: "trefoil",
    name: "Trefoil knot",
    blurb: "Closed, knotted, and nowhere straight — κ and τ both vary.",
    components: [
      "(2 + cos 3t) cos 2t",
      "(2 + cos 3t) sin 2t",
      "sin 3t",
    ],
    params: [],
    t: interval(0, 2 * Math.PI),
    periodic: true,
  },
  {
    id: "line",
    name: "Straight line",
    blurb: "κ = 0 everywhere, so N and B are undefined. Must not produce NaN.",
    components: ["t", "2t", "3t"],
    params: [],
    t: interval(-1.5, 1.5),
  },
  {
    id: "twisted-cubic",
    name: "Twisted cubic",
    blurb: "(t, t², t³) — the standard example of a curve with an inflection at t = 0.",
    components: ["t", "t^2", "t^3"],
    params: [],
    t: interval(-1.2, 1.2),
  },
  {
    id: "cusp",
    name: "Cusp",
    blurb: "(t², t³) has |α′(0)| = 0: the parametrization is singular at the origin.",
    components: ["t^2", "t^3", "0"],
    params: [],
    t: interval(-1.2, 1.2),
  },
];

export const CURVE_BY_ID: Readonly<Record<string, CurveSpec>> = Object.fromEntries(
  CURVE_CATALOG.map((spec) => [spec.id, spec]),
);

function compileMap(spec: CurveSpec, order: number) {
  const diags: Diagnostic[] = [];
  const comps = spec.components.map((source) => {
    const { expr, diags: parseDiags } = parse(source);
    diags.push(...parseDiags);
    if (!expr) throw new Error(`catalog curve "${spec.id}": cannot parse ${source}`);
    return expr;
  });

  const map = buildDiffMap({
    id: spec.id,
    comps,
    vars: ["t"],
    params: spec.params.map((p) => p.key),
    order,
  });
  diags.push(...map.diags);

  if (hasErrors(diags)) {
    throw new Error(
      `catalog curve "${spec.id}" failed to compile: ` +
        diags.map((d) => d.message).join("; "),
    );
  }
  return map;
}

/**
 * Build a space curve. Order 3 is the default and not negotiable: torsion needs α‴.
 *
 * Compiling curves at order 3 from M1 onward is deliberate — it puts real numbers through
 * the order-3 jet machinery early, rather than discovering a multi-index bug at M5 when
 * ∇K and the Codazzi residual first need it.
 */
export function buildSpaceCurve(spec: CurveSpec, order = 3): SpaceCurve {
  if (spec.components.length !== 3) {
    throw new Error(`"${spec.id}" has ${spec.components.length} components, expected 3`);
  }
  return createSpaceCurve({
    id: spec.id,
    map: compileMap(spec, order),
    t: spec.t,
    periodic: spec.periodic ?? false,
  });
}

/** Build a plane curve. Order 2 suffices — signed curvature needs only α″. */
export function buildPlaneCurve(spec: CurveSpec, order = 2): PlaneCurve {
  if (spec.components.length !== 2) {
    throw new Error(`"${spec.id}" has ${spec.components.length} components, expected 2`);
  }
  return createPlaneCurve({
    id: spec.id,
    map: compileMap(spec, order),
    t: spec.t,
    periodic: spec.periodic ?? false,
  });
}

export function defaultCurveParams(spec: CurveSpec): Float64Array {
  return Float64Array.from(spec.params.map((p) => p.default));
}

export function curveParamsWith(
  spec: CurveSpec,
  overrides: Readonly<Record<string, number>>,
): Float64Array {
  return Float64Array.from(spec.params.map((p) => overrides[p.key] ?? p.default));
}
