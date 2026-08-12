import { hasErrors, type Diagnostic } from "../expr/diagnostics.ts";
import { parse } from "../expr/parse.ts";
import { buildDiffMap } from "../jets/compile.ts";
import { createParametricSurface, type ParametricSurface } from "../geom/parametric.ts";
import { interval, type Interval } from "../geom/types.ts";

/**
 * The do Carmo catalog, defined as **source text**.
 *
 * These are written the way the book writes them and then pushed through the real
 * pipeline — parse → differentiate → simplify → compile → jets → fundamental forms. So
 * the ground-truth suite is testing the whole engine end to end rather than a
 * hand-coded shortcut, and every surface here doubles as a preset the user could have
 * typed themselves.
 */

export interface ParamDef {
  readonly key: string;
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly default: number;
}

export interface SurfaceSpec {
  readonly id: string;
  readonly name: string;
  readonly blurb: string;
  /** the three components of X, as source text */
  readonly components: readonly [string, string, string];
  readonly params: readonly ParamDef[];
  readonly u: Interval;
  readonly v: Interval;
  readonly periodicU?: boolean;
  readonly periodicV?: boolean;
}

/** Inset used wherever the chart is singular at the boundary. */
const POLE_INSET = 0.002;

export const CATALOG: readonly SurfaceSpec[] = [
  {
    id: "sphere",
    name: "Sphere",
    blurb: "Constant positive curvature; every point umbilic. K = 1/R², H = −1/R.",
    components: ["R sin u cos v", "R sin u sin v", "R cos u"],
    params: [{ key: "R", label: "radius R", min: 0.3, max: 3, step: 0.05, default: 1 }],
    // The chart degenerates at both poles, where X_u × X_v vanishes.
    u: interval(0, Math.PI, POLE_INSET),
    v: interval(0, 2 * Math.PI),
    periodicV: true,
  },
  {
    id: "torus",
    name: "Torus of revolution",
    blurb: "Curvature of both signs: K > 0 outside, K < 0 inside, K = 0 on u = ±π/2.",
    components: [
      "(R + r cos u) cos v",
      "(R + r cos u) sin v",
      "r sin u",
    ],
    params: [
      { key: "R", label: "R", min: 1, max: 4, step: 0.05, default: 2 },
      { key: "r", label: "r", min: 0.1, max: 1.5, step: 0.05, default: 0.7 },
    ],
    u: interval(0, 2 * Math.PI),
    v: interval(0, 2 * Math.PI),
    periodicU: true,
    periodicV: true,
  },
  {
    id: "cylinder",
    name: "Cylinder",
    blurb: "Flat: K = 0 everywhere, though it is not a plane. Theorema Egregium.",
    components: ["r cos u", "r sin u", "v"],
    params: [{ key: "r", label: "radius r", min: 0.2, max: 2, step: 0.05, default: 1 }],
    u: interval(0, 2 * Math.PI),
    v: interval(-2, 2),
    periodicU: true,
  },
  {
    id: "catenoid",
    name: "Catenoid",
    blurb: "Minimal (H = 0), and the only minimal surface of revolution.",
    components: ["c cosh(v/c) cos u", "c cosh(v/c) sin u", "v"],
    params: [{ key: "c", label: "waist c", min: 0.3, max: 2, step: 0.05, default: 1 }],
    u: interval(0, 2 * Math.PI),
    v: interval(-1.6, 1.6),
    periodicU: true,
  },
  {
    id: "helicoid",
    name: "Helicoid",
    blurb: "Minimal (H = 0), and locally isometric to the catenoid.",
    components: ["u cos v", "u sin v", "c v"],
    params: [{ key: "c", label: "pitch c", min: 0.1, max: 1.5, step: 0.05, default: 0.5 }],
    u: interval(-1.8, 1.8),
    v: interval(0, 4 * Math.PI),
  },
  {
    id: "pseudosphere",
    name: "Pseudosphere",
    blurb: "Constant negative curvature, K = −1. A tractricoid.",
    components: ["sech u cos v", "sech u sin v", "u - tanh u"],
    params: [],
    u: interval(0.05, 3),
    v: interval(0, 2 * Math.PI),
    periodicV: true,
  },
  {
    id: "monkey-saddle",
    name: "Monkey saddle",
    blurb: "z = u³ − 3uv². The origin is a planar point: K = H = 0 with k₁ = k₂ = 0.",
    components: ["u", "v", "u^3 - 3u v^2"],
    params: [],
    u: interval(-1.2, 1.2),
    v: interval(-1.2, 1.2),
  },
  {
    id: "enneper",
    name: "Enneper surface",
    blurb: "Minimal, with E = G = (1+u²+v²)², F = 0 and K = −4/(1+u²+v²)⁴.",
    components: [
      "u - u^3/3 + u v^2",
      "v - v^3/3 + v u^2",
      "u^2 - v^2",
    ],
    params: [],
    u: interval(-1.3, 1.3),
    v: interval(-1.3, 1.3),
  },
  {
    id: "hyperbolic-paraboloid",
    name: "Hyperbolic paraboloid",
    blurb: "The saddle z = a(u² − v²). At the origin K = −4a², H = 0.",
    components: ["u", "v", "a(u^2 - v^2)"],
    params: [{ key: "a", label: "a", min: 0.2, max: 2, step: 0.05, default: 1 }],
    u: interval(-1.3, 1.3),
    v: interval(-1.3, 1.3),
  },
];

export const CATALOG_BY_ID: Readonly<Record<string, SurfaceSpec>> = Object.fromEntries(
  CATALOG.map((spec) => [spec.id, spec]),
);

export interface BuiltSurface {
  readonly spec: SurfaceSpec;
  readonly surface: ParametricSurface;
  readonly diags: readonly Diagnostic[];
  /** parameter values in the order the compiled program expects */
  readonly params: Float64Array;
}

/**
 * Parse, differentiate and compile a spec into a usable surface.
 *
 * Order 2 is the default: the second fundamental form needs `X_uu`, and the Christoffel
 * symbols need only first derivatives of E, F, G — which are still order 2 of X. Order 3
 * is opt-in, for ∇K and the Codazzi residual.
 */
export function buildSurface(spec: SurfaceSpec, order = 2): BuiltSurface {
  const diags: Diagnostic[] = [];
  const paramKeys = spec.params.map((p) => p.key);

  const comps = spec.components.map((source) => {
    const { expr, diags: parseDiags } = parse(source);
    diags.push(...parseDiags);
    if (!expr) throw new Error(`catalog surface "${spec.id}": cannot parse ${source}`);
    return expr;
  });

  const map = buildDiffMap({
    id: spec.id,
    comps,
    vars: ["u", "v"],
    params: paramKeys,
    order,
  });
  diags.push(...map.diags);

  if (hasErrors(diags)) {
    throw new Error(
      `catalog surface "${spec.id}" failed to compile: ` +
        diags.map((d) => d.message).join("; "),
    );
  }

  const surface = createParametricSurface({
    id: spec.id,
    map,
    u: spec.u,
    v: spec.v,
    periodicU: spec.periodicU ?? false,
    periodicV: spec.periodicV ?? false,
  });

  return { spec, surface, diags, params: defaultParams(spec) };
}

export function defaultParams(spec: SurfaceSpec): Float64Array {
  return Float64Array.from(spec.params.map((p) => p.default));
}

/** Override named parameters, leaving the rest at their defaults. */
export function paramsWith(
  spec: SurfaceSpec,
  overrides: Readonly<Record<string, number>>,
): Float64Array {
  return Float64Array.from(
    spec.params.map((p) => overrides[p.key] ?? p.default),
  );
}
