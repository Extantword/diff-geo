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

/**
 * An example vector field along a surface, in **ambient** components.
 *
 * Every one of these is a combination of the patch's own coordinate fields with scalar
 * coefficients, which is the only way to be tangent to an arbitrary surface — and tangency is
 * what makes a field a field *on* the surface rather than one merely drawn near it. Written the
 * way a reader would: the positive factors that scale a coordinate field are dropped, since
 * `(-sin v, cos v, 0)` and `(R + r cos u)(-sin v, cos v, 0)` point the same way and the first is
 * legible. The suite checks each of them against ⟨V, N⟩ = 0 on its own surface.
 */
export interface FieldSpec {
  readonly id: string;
  readonly label: string;
  readonly blurb: string;
  /** the three ambient components, as functions of the patch's u and v */
  readonly components: readonly [string, string, string];
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
  /** tangent fields worth looking at on this surface */
  readonly fields?: readonly FieldSpec[];
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
    fields: [
      {
        id: "sphere-rotation",
        label: "rotation about the axis",
        blurb:
          "(−y, x, 0) restricted to the sphere: ∂/∂v, the field whose flow spins the sphere. " +
          "It vanishes at both poles, which is Poincaré–Hopf in one picture — index 1 twice, " +
          "and χ = 2.",
        components: ["-sin u sin v", "sin u cos v", "0"],
      },
      {
        id: "sphere-meridian",
        label: "along the meridians",
        blurb:
          "∂/∂u: unit-length everywhere, flowing pole to pole. Its integral curves are the " +
          "great circles through the poles, so they are geodesics.",
        components: ["cos u cos v", "cos u sin v", "-sin u"],
      },
      {
        id: "sphere-loxodrome",
        label: "a loxodrome",
        blurb:
          "The unit meridian field plus the unit parallel field, so the flow crosses every " +
          "meridian at 45°. Its integral curves are rhumb lines: they wind infinitely often " +
          "around each pole without ever reaching one, and they have finite length.",
        components: ["cos u cos v - sin v", "cos u sin v + cos v", "-sin u"],
      },
      {
        id: "sphere-height-gradient",
        label: "the gradient of height",
        blurb:
          "grad z, the steepest-ascent field of the height function, flowing out of the south " +
          "pole and into the north. A gradient field has no closed orbits at all — the height " +
          "increases along every one of them.",
        components: ["-sin u cos u cos v", "-sin u cos u sin v", "sin^2 u"],
      },
    ],
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
    fields: [
      {
        id: "torus-helical",
        label: "a helical flow",
        blurb:
          "∂/∂u + ∂/∂v, going round the tube and round the axis at once. It vanishes nowhere, " +
          "which a torus alone among the closed surfaces allows: χ = 0.",
        components: [
          "-sin u cos v - sin v",
          "-sin u sin v + cos v",
          "cos u",
        ],
      },
      {
        id: "torus-toroidal",
        label: "round the axis",
        blurb: "∂/∂v: the toroidal direction, whose integral curves are the outer circles.",
        components: ["-sin v", "cos v", "0"],
      },
      {
        id: "torus-poloidal",
        label: "round the tube",
        blurb:
          "\u2202/\u2202u: the poloidal direction, whose integral curves are the small circles " +
          "of the tube. Every orbit is closed, and every one of them bounds nothing on the torus.",
        components: ["-sin u cos v", "-sin u sin v", "cos u"],
      },
      {
        id: "torus-knot",
        label: "a (2, 3) knot flow",
        blurb:
          "2\u2202/\u2202u + 3\u2202/\u2202v exactly, so the chart velocity is constant and " +
          "every orbit closes after two turns of the tube and three of the axis: each integral " +
          "curve is a trefoil.",
        components: [
          "-2r sin u cos v - 3(R + r cos u) sin v",
          "-2r sin u sin v + 3(R + r cos u) cos v",
          "2r cos u",
        ],
      },
      {
        id: "torus-height-gradient",
        label: "the gradient of height",
        blurb:
          "grad z on the torus standing on its axis. It vanishes on the top and bottom circles " +
          "\u2014 where the height is critical \u2014 and the flow climbs between them.",
        components: ["-cos u sin u cos v", "-cos u sin u sin v", "cos^2 u"],
      },
    ],
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
    fields: [
      {
        id: "cylinder-axis",
        label: "a constant wind",
        blurb:
          "(0, 0, 1) — the same vector at every point of R³, and tangent to the cylinder " +
          "everywhere. Being ambient does not make a field untangent; being ambient makes " +
          "tangency a question, and this one answers yes.",
        components: ["0", "0", "1"],
      },
      {
        id: "cylinder-round",
        label: "round the cylinder",
        blurb:
          "\u2202/\u2202u: the parallels, which on a cylinder are geodesics as well as closed " +
          "orbits. Flat does not mean straight in space.",
        components: ["-sin u", "cos u", "0"],
      },
      {
        id: "cylinder-helix",
        label: "a helical flow",
        blurb:
          "Round and up at once. Its integral curves are helices \u2014 geodesics of the " +
          "cylinder, and the image of straight lines under the isometry that unrolls it.",
        components: ["-sin u", "cos u", "1"],
      },
      {
        id: "cylinder-twist",
        label: "a twisting flow",
        blurb:
          "v\u2202/\u2202u + \u2202/\u2202v: the higher a particle is, the faster it turns. " +
          "The orbits are not helices but spirals of growing pitch, which is what a shear looks " +
          "like on a curved surface.",
        components: ["-v sin u", "v cos u", "1"],
      },
    ],
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
    fields: [
      {
        id: "catenoid-rotation",
        label: "round the waist",
        blurb:
          "∂/∂u, tangent to the circles of revolution — and longest where the surface is " +
          "widest, since the coordinate field carries the metric with it.",
        components: ["-sin u", "cos u", "0"],
      },
      {
        id: "catenoid-profile",
        label: "up through the waist",
        blurb:
          "\u2202/\u2202v, along the catenaries the surface is swept from. It is slowest at the " +
          "waist, where the profile is steepest in the parameter and the surface narrowest.",
        components: ["sinh(v/c) cos u", "sinh(v/c) sin u", "1"],
      },
      {
        id: "catenoid-spiral",
        label: "a spiral",
        blurb:
          "The unit rotation plus \u2202/\u2202v: every orbit climbs out of the waist while " +
          "turning, and none of them closes.",
        components: [
          "-sin u + sinh(v/c) cos u",
          "cos u + sinh(v/c) sin u",
          "1",
        ],
      },
    ],
  },
  {
    id: "helicoid",
    name: "Helicoid",
    blurb: "Minimal (H = 0), and locally isometric to the catenoid.",
    components: ["u cos v", "u sin v", "c v"],
    params: [{ key: "c", label: "pitch c", min: 0.1, max: 1.5, step: 0.05, default: 0.5 }],
    u: interval(-1.8, 1.8),
    v: interval(0, 4 * Math.PI),
    fields: [
      {
        id: "helicoid-ruling",
        label: "along the rulings",
        blurb:
          "∂/∂u: a unit field along the straight lines the helicoid is made of. Its integral " +
          "curves are lines in R³ — the surface is ruled, and this is the ruling.",
        components: ["cos v", "sin v", "0"],
      },
      {
        id: "helicoid-helix",
        label: "along the helices",
        blurb:
          "\u2202/\u2202v: the curves of constant distance from the axis, which are helices " +
          "and, unlike the rulings, are not geodesics.",
        components: ["-u sin v", "u cos v", "c"],
      },
      {
        id: "helicoid-outward",
        label: "outward and around",
        blurb:
          "\u2202/\u2202u + \u2202/\u2202v: a flow that slides along each ruling while the " +
          "ruling itself turns, so the orbits climb the surface at an ever-shallower angle.",
        components: ["cos v - u sin v", "sin v + u cos v", "c"],
      },
    ],
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
    fields: [
      {
        id: "pseudosphere-rotation",
        label: "round the axis",
        blurb:
          "∂/∂v, shrinking toward the cusp as the parallels do — the field's length is the " +
          "radius, which on a surface of K = −1 falls off like sech u.",
        components: ["-sin v", "cos v", "0"],
      },
      {
        id: "pseudosphere-profile",
        label: "along the tractrix",
        blurb:
          "\u2202/\u2202u, running down the profile toward the cusp. The tractrix has infinite " +
          "length toward the cusp, so no orbit ever arrives.",
        components: [
          "-sech u tanh u cos v",
          "-sech u tanh u sin v",
          "tanh^2 u",
        ],
      },
      {
        id: "pseudosphere-spiral",
        label: "a spiral toward the cusp",
        blurb:
          "The profile field plus the unit rotation: the orbits wind ever tighter as the radius " +
          "shrinks, on a surface where K = \u22121 everywhere.",
        components: [
          "-sech u tanh u cos v - sin v",
          "-sech u tanh u sin v + cos v",
          "tanh^2 u",
        ],
      },
    ],
  },
  {
    id: "monkey-saddle",
    name: "Monkey saddle",
    blurb: "z = u³ − 3uv². The origin is a planar point: K = H = 0 with k₁ = k₂ = 0.",
    components: ["u", "v", "u^3 - 3u v^2"],
    params: [],
    u: interval(-1.2, 1.2),
    v: interval(-1.2, 1.2),
    fields: [
      {
        id: "monkey-saddle-slope",
        label: "the uphill direction",
        blurb:
          "∂/∂u on the graph: flat in x and y, and tilted by ∂z/∂u = 3(u² − v²). It leans " +
          "steeply where the three valleys fall away and lies flat along u = ±v.",
        components: ["1", "0", "3u^2 - 3v^2"],
      },
      {
        id: "monkey-saddle-across",
        label: "across the slope",
        blurb: "\u2202/\u2202v on the graph: flat in x and y, tilted by \u2202z/\u2202v = \u22126uv.",
        components: ["0", "1", "-6u v"],
      },
      {
        id: "monkey-saddle-gradient",
        label: "steepest ascent",
        blurb:
          "The gradient direction of the height, which for a graph is f_u \u2202/\u2202u + " +
          "f_v \u2202/\u2202v. Its flow runs up the three ridges and down the three valleys, " +
          "with one zero at the origin \u2014 of index \u22122, which is what makes a monkey " +
          "saddle a monkey saddle.",
        components: [
          "3u^2 - 3v^2",
          "-6u v",
          "(3u^2 - 3v^2)^2 + 36 u^2 v^2",
        ],
      },
      {
        id: "monkey-saddle-turn",
        label: "turning about the origin",
        blurb:
          "\u2212v \u2202/\u2202u + u \u2202/\u2202v: a rotation of the chart, pushed onto " +
          "the surface. Each orbit circles the origin and rides up and down the three folds as " +
          "it goes.",
        components: ["-v", "u", "3v^3 - 9u^2 v"],
      },
    ],
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
    fields: [
      {
        id: "enneper-coordinate",
        label: "a coordinate field",
        blurb:
          "∂/∂u. Enneper's chart is isothermal — E = G, F = 0 — so ∂/∂u and ∂/∂v are " +
          "everywhere orthogonal and of equal length: the arrows show a conformal grid.",
        components: ["1 - u^2 + v^2", "2u v", "2u"],
      },
      {
        id: "enneper-coordinate-v",
        label: "the other coordinate field",
        blurb:
          "\u2202/\u2202v. Together with \u2202/\u2202u it shows the chart is isothermal: the " +
          "two are everywhere orthogonal and of equal length, which is why the arrows meet at " +
          "right angles wherever you look.",
        components: ["2u v", "1 - v^2 + u^2", "-2v"],
      },
      {
        id: "enneper-turn",
        label: "turning in the chart",
        blurb:
          "\u2212v \u2202/\u2202u + u \u2202/\u2202v. The chart is conformal, so a rotation " +
          "downstairs stays a rotation upstairs \u2014 the flow turns the surface through itself " +
          "without distorting angles.",
        components: [
          "3u^2 v - v^3 - v",
          "u^3 - 3u v^2 + u",
          "-4u v",
        ],
      },
    ],
  },
  {
    id: "hyperbolic-paraboloid",
    name: "Hyperbolic paraboloid",
    blurb: "The saddle z = a(u² − v²). At the origin K = −4a², H = 0.",
    components: ["u", "v", "a(u^2 - v^2)"],
    params: [{ key: "a", label: "a", min: 0.2, max: 2, step: 0.05, default: 1 }],
    u: interval(-1.3, 1.3),
    v: interval(-1.3, 1.3),
    fields: [
      {
        id: "saddle-ruling",
        label: "along one ruling",
        blurb:
          "∂/∂u: the saddle is doubly ruled, and this field runs along one of the two " +
          "families of straight lines lying in it.",
        components: ["1", "0", "2a u"],
      },
      {
        id: "saddle-ruling-2",
        label: "along the other ruling",
        blurb:
          "\u2202/\u2202v: the second family of straight lines. Every point of the saddle has " +
          "exactly two of them through it, and they are its asymptotic curves.",
        components: ["0", "1", "-2a v"],
      },
      {
        id: "saddle-gradient",
        label: "steepest ascent",
        blurb:
          "The gradient direction of a(u\u00b2 \u2212 v\u00b2): out along the two ridges and " +
          "in along the two valleys, with a single zero at the origin of index \u22121 \u2014 " +
          "the saddle, counted.",
        components: ["2a u", "-2a v", "4a^2 u^2 + 4a^2 v^2"],
      },
      {
        id: "saddle-turn",
        label: "turning about the axis",
        blurb:
          "\u2212v \u2202/\u2202u + u \u2202/\u2202v: the orbits circle the saddle point, " +
          "rising and falling twice on each turn.",
        components: ["-v", "u", "-4a u v"],
      },
    ],
  },
];

/** Every example field in the catalog, with the surface it belongs to. */
export const CATALOG_FIELDS: readonly { spec: SurfaceSpec; field: FieldSpec }[] = CATALOG.flatMap(
  (spec) => (spec.fields ?? []).map((field) => ({ spec, field })),
);

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
