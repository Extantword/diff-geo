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
  /**
   * This surface has points where it is not an immersion, and that is what it is for.
   *
   * A Whitney umbrella's pinch point, a Roman surface's six of them, the apex of a cone: X_u × X_v
   * vanishes there, so the mesh drops the triangles around it and the readouts say "no tangent
   * plane". Marked rather than avoided, because avoiding them would mean leaving out the standard
   * examples of exactly that phenomenon — and so the suite knows not to demand a whole mesh.
   */
  readonly singularPoints?: boolean;
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

  {
    id: "stereographic",
    name: "Sphere, stereographically",
    blurb:
      "do Carmo §2-2 ex. 16: the inverse of the projection from the north pole, so one chart " +
      "covers the whole sphere x² + y² + (z − 1)² = 1 except that single point. K = 1 everywhere, " +
      "and no compact surface can do better than all-but-a-point with one chart.",
    components: [
      "4u / (u^2 + v^2 + 4)",
      "4v / (u^2 + v^2 + 4)",
      "2(u^2 + v^2) / (u^2 + v^2 + 4)",
    ],
    params: [],
    // The plane, as far out as is worth drawing: at |(u,v)| = 6 the image is already at z = 1.8,
    // and the missing pole sits at z = 2 however far the domain is pushed.
    u: interval(-6, 6),
    v: interval(-6, 6),
  },

  // ---- minimal surfaces ----
  {
    id: "catalan",
    name: "Catalan's minimal surface",
    blurb:
      "Minimal, and it contains a cycloid as a geodesic — the curve a point on a rolling wheel " +
      "traces, sitting inside a soap film.",
    components: [
      "u - sin u cosh v",
      "1 - cos u cosh v",
      "4 sin(u/2) sinh(v/2)",
    ],
    params: [],
    u: interval(0, 4 * Math.PI),
    v: interval(-1.2, 1.2),
    // Three branch points sit on v = 0, at u = 0, 2π and 4π: X_u and X_v are parallel there.
    singularPoints: true,
  },
  {
    id: "scherk",
    name: "Scherk's first surface",
    blurb:
      "z = log(cos v / cos u): the only minimal surface that is a graph over a square, doubly " +
      "periodic, and it runs to infinity at the edges of each square.",
    components: ["u", "v", "log(cos v) - log(cos u)"],
    params: [],
    u: interval(-1.45, 1.45),
    v: interval(-1.45, 1.45),
  },

  // ---- ruled surfaces ----
  {
    id: "hyperboloid",
    name: "Hyperboloid of one sheet",
    blurb:
      "x² + y² − z² = a², and **doubly ruled**: two straight lines lie in it through every " +
      "point, which is why a saddle-shaped tower can be built out of straight beams. K < 0.",
    components: ["a cosh v cos u", "a cosh v sin u", "c sinh v"],
    params: [
      { key: "a", label: "waist a", min: 0.3, max: 2, step: 0.05, default: 1 },
      { key: "c", label: "rise c", min: 0.3, max: 2, step: 0.05, default: 1 },
    ],
    u: interval(0, 2 * Math.PI),
    v: interval(-1.3, 1.3),
    periodicU: true,
  },
  {
    id: "plucker-conoid",
    name: "Plücker's conoid",
    blurb:
      "z = 2xy/(x² + y²), a right conoid: every ruling meets the axis at a right angle. The " +
      "axis itself is a double line, so the domain starts away from it.",
    components: ["v cos u", "v sin u", "sin(2u)"],
    params: [],
    u: interval(0, 2 * Math.PI),
    v: interval(0.2, 1.5),
    periodicU: true,
  },
  {
    id: "cone",
    name: "Cone",
    blurb:
      "The ruled surface through a point. K = 0 away from the apex — it is developable, a flat " +
      "sheet rolled up — and the apex is not a regular point at all.",
    components: ["v cos u", "v sin u", "c v"],
    params: [{ key: "c", label: "slope c", min: 0.2, max: 3, step: 0.05, default: 1 }],
    u: interval(0, 2 * Math.PI),
    v: interval(0.2, 1.6),
    periodicU: true,
  },
  {
    id: "wallis",
    name: "Wallis's conical edge",
    blurb:
      "A right conoid whose rulings rise as a square root, so the surface has a cuspidal edge " +
      "where the radicand vanishes.",
    components: ["v cos u", "v sin u", "c sqrt(a^2 - b^2 cos^2 u)"],
    params: [
      { key: "a", label: "a", min: 1.1, max: 3, step: 0.05, default: 2 },
      { key: "b", label: "b", min: 0.2, max: 1, step: 0.05, default: 1 },
      { key: "c", label: "c", min: 0.2, max: 2, step: 0.05, default: 1 },
    ],
    u: interval(0, 2 * Math.PI),
    v: interval(0.2, 1.5),
    periodicU: true,
  },

  // ---- non-orientable ----
  {
    id: "mobius",
    name: "Möbius strip",
    blurb:
      "One side and one edge. Follow the normal once around and it comes back reversed, which " +
      "is why the shading changes at the seam rather than joining.",
    components: [
      "(1 + v cos(u/2)) cos u",
      "(1 + v cos(u/2)) sin u",
      "v sin(u/2)",
    ],
    params: [],
    u: interval(0, 2 * Math.PI),
    v: interval(-0.4, 0.4),
  },
  {
    id: "klein",
    name: "Klein bottle",
    blurb:
      "The figure-8 immersion. Closed, non-orientable, and it cannot be embedded in R³ — the " +
      "self-intersection is the price of drawing it here at all.",
    components: [
      "(R + cos(u/2) sin v - sin(u/2) sin(2v)) cos u",
      "(R + cos(u/2) sin v - sin(u/2) sin(2v)) sin u",
      "sin(u/2) sin v + cos(u/2) sin(2v)",
    ],
    params: [{ key: "R", label: "R", min: 1.2, max: 4, step: 0.05, default: 2 }],
    u: interval(0, 2 * Math.PI),
    v: interval(0, 2 * Math.PI),
    periodicV: true,
  },
  {
    id: "cross-cap",
    name: "Cross-cap",
    blurb:
      "An immersion of the projective plane with two pinch points, where it fails to be an " +
      "immersion at all.",
    components: [
      "(1 + cos v) cos u",
      "(1 + cos v) sin u",
      "-tanh(u - pi) sin v",
    ],
    params: [],
    u: interval(0, 2 * Math.PI),
    v: interval(0, 2 * Math.PI),
    periodicV: true,
    singularPoints: true,
  },
  {
    id: "roman",
    name: "Roman surface",
    blurb:
      "Steiner's surface: the sphere's (yz, zx, xy), which identifies antipodes and so maps the " +
      "projective plane into R³. Three double lines meeting at six pinch points.",
    components: [
      "r^2 sin u sin v cos u",
      "r^2 sin u cos u cos v",
      "r^2 sin^2 u sin v cos v",
    ],
    params: [{ key: "r", label: "r", min: 0.5, max: 2, step: 0.05, default: 1.4 }],
    u: interval(0, Math.PI, POLE_INSET),
    v: interval(0, 2 * Math.PI),
    periodicV: true,
    singularPoints: true,
  },
  {
    id: "boy",
    name: "Boy's surface",
    blurb:
      "Apéry's parametrization: an immersion of the projective plane with **no** pinch points — " +
      "the thing the cross-cap and the Roman surface cannot manage.",
    components: [
      "(sqrt(2) cos(2u) cos^2 v + cos u sin(2v)) / (2 - sqrt(2) sin(3u) sin(2v))",
      "(sqrt(2) sin(2u) cos^2 v - sin u sin(2v)) / (2 - sqrt(2) sin(3u) sin(2v))",
      "3 cos^2 v / (2 - sqrt(2) sin(3u) sin(2v))",
    ],
    params: [],
    u: interval(0, Math.PI),
    /**
     * v runs over one period, offset to miss the collapse.
     *
     * Everything here has period π in v, and at v = π/2 all three numerators vanish at once —
     * the whole line maps to the origin. Starting the period just past it covers the surface
     * exactly once with nothing degenerate inside.
     */
    v: interval(Math.PI / 2, (3 * Math.PI) / 2, 0.004),
  },

  // ---- algebraic and miscellaneous ----
  {
    id: "whitney",
    name: "Whitney umbrella",
    blurb:
      "(uv, u, v²): the canonical failure to be an immersion. The handle is a line of double " +
      "points ending in one pinch point, and every stable map of a surface into R³ looks like " +
      "this near a bad point.",
    components: ["u v", "u", "v^2"],
    params: [],
    u: interval(-1.45, 1.55),
    v: interval(-1.4, 1.4),
    singularPoints: true,
  },
  {
    id: "breather",
    name: "Breather surface",
    blurb:
      "Constant curvature K = −1, from a breather solution of the sine-Gordon equation. The " +
      "same equation whose solitons the pseudosphere comes from.",
    components: [
      "-u + 2(1 - a^2) cosh(a u) sinh(a u) / (a((sqrt(1 - a^2) cosh(a u))^2 + (a sin(sqrt(1 - a^2) v))^2))",
      "2 sqrt(1 - a^2) cosh(a u) (-sqrt(1 - a^2) cos v cos(sqrt(1 - a^2) v) - sin v sin(sqrt(1 - a^2) v)) / (a((sqrt(1 - a^2) cosh(a u))^2 + (a sin(sqrt(1 - a^2) v))^2))",
      "2 sqrt(1 - a^2) cosh(a u) (-sqrt(1 - a^2) sin v cos(sqrt(1 - a^2) v) + cos v sin(sqrt(1 - a^2) v)) / (a((sqrt(1 - a^2) cosh(a u))^2 + (a sin(sqrt(1 - a^2) v))^2))",
    ],
    params: [{ key: "a", label: "a", min: 0.1, max: 0.9, step: 0.02, default: 0.4 }],
    u: interval(-13, 13),
    // X_v vanishes along v = 0, so the domain starts just past it.
    v: interval(0.05, 12),
  },
  {
    id: "kuen",
    name: "Kuen surface",
    blurb:
      "Another surface of constant K = −1, and a Bäcklund transform of the pseudosphere: the " +
      "same intrinsic geometry, wrapped into R³ a different way.",
    components: [
      "2(cos u + u sin u) sin v / (1 + u^2 sin^2 v)",
      "2(sin u - u cos u) sin v / (1 + u^2 sin^2 v)",
      "log(tan(v/2)) + 2 cos v / (1 + u^2 sin^2 v)",
    ],
    params: [],
    // X_u vanishes along u = 0 and log(tan(v/2)) runs away at both ends of v, so the domain sits
    // inside all three.
    u: interval(0.06, 4.5),
    v: interval(0.1, 2.9),
  },
  {
    id: "seashell",
    name: "Seashell",
    blurb:
      "A tube swept along a logarithmic spiral, everything scaling by the same factor each turn. " +
      "That self-similarity is the growth law a mollusc is stuck with: it can only add to its " +
      "edge, never rebuild what it has.",
    components: [
      "exp(k v) (1 + m cos u) cos v",
      "exp(k v) (1 + m cos u) sin v",
      "exp(k v) (h + m sin u)",
    ],
    params: [
      { key: "m", label: "tube m", min: 0.05, max: 0.8, step: 0.02, default: 0.35 },
      { key: "k", label: "growth k", min: 0.02, max: 0.4, step: 0.01, default: 0.18 },
      { key: "h", label: "rise h", min: -1, max: 1.5, step: 0.05, default: 0.6 },
    ],
    u: interval(0, 2 * Math.PI),
    v: interval(0, 6 * Math.PI),
    periodicU: true,
  },
  {
    id: "supertoroid",
    name: "Supertoroid",
    blurb:
      "A torus whose cross-section is a superellipse. n = 1 is the torus itself; raising it " +
      "squares the tube off, and the curvature piles up where the corners form.",
    components: [
      "(R + r sign(cos u) abs(cos u)^n) cos v",
      "(R + r sign(cos u) abs(cos u)^n) sin v",
      "r sign(sin u) abs(sin u)^n",
    ],
    params: [
      { key: "R", label: "R", min: 1, max: 4, step: 0.05, default: 2 },
      { key: "r", label: "r", min: 0.2, max: 1.5, step: 0.05, default: 0.8 },
      { key: "n", label: "squareness n", min: 1, max: 4, step: 0.1, default: 1 },
    ],
    u: interval(0, 2 * Math.PI),
    v: interval(0, 2 * Math.PI),
    periodicU: true,
    periodicV: true,
    // At n = 1 this is exactly the torus. Past it X_u vanishes at the four corners of the
    // cross-section: the surface is still there, but the parametrization stops being regular.
    singularPoints: true,
  },
  {
    id: "superegg",
    name: "Superegg",
    blurb:
      "A superellipsoid of revolution: n = 1 is an ellipsoid, and past it the profile flattens " +
      "into the shape that stands on end without falling over.",
    components: [
      "a sign(sin u) abs(sin u)^n cos v",
      "a sign(sin u) abs(sin u)^n sin v",
      "c sign(cos u) abs(cos u)^n",
    ],
    params: [
      { key: "a", label: "waist a", min: 0.3, max: 2, step: 0.05, default: 1 },
      { key: "c", label: "height c", min: 0.3, max: 3, step: 0.05, default: 1.4 },
      { key: "n", label: "squareness n", min: 1, max: 4, step: 0.1, default: 1 },
    ],
    u: interval(0, Math.PI, POLE_INSET),
    v: interval(0, 2 * Math.PI),
    periodicV: true,
    // n = 1 is the ellipsoid; past it the poles and the equator stop being regular points of the
    // parametrization, which is what a superquadric's corners are.
    singularPoints: true,
  },
];

/**
 * Surfaces given as an equation rather than a map, for the marching path.
 *
 * The ones that belong here are the ones that cannot be written the other way, or not usefully: a
 * smooth quartic has no rational parametrization at all, and the triply periodic minimal surfaces
 * have no elementary one. `box` is the window the level set is searched in — a level set has no
 * domain of its own, so this is a choice about what to look at rather than part of the object.
 */
export interface ImplicitSpec {
  readonly id: string;
  readonly name: string;
  readonly blurb: string;
  /** the whole row, as source text: an equation in x, y and z */
  readonly equation: string;
  readonly params: readonly ParamDef[];
  /** the box, applied to all three axes */
  readonly box: readonly [number, number];
}

export const IMPLICIT_CATALOG: readonly ImplicitSpec[] = [
  {
    id: "quartic",
    name: "Smooth quartic",
    blurb:
      "x⁴ + y⁴ + z⁴ = 1. A K3 surface, and **not rational** — no parametrization by rational " +
      "functions exists, so this is a surface the other representation genuinely cannot write.",
    equation: "x^4 + y^4 + z^4 = 1",
    params: [],
    box: [-1.4, 1.4],
  },
  {
    id: "level-torus",
    name: "Torus, as a level set",
    blurb:
      "(√(x² + y²) − R)² + z² = r². The same torus the catalog parametrizes, arrived at the " +
      "other way — same K = cos u / (r(R + r cos u)), computed from ∇F and the Hessian instead.",
    equation: "(sqrt(x^2 + y^2) - R)^2 + z^2 = r^2",
    params: [
      { key: "R", label: "R", min: 0.6, max: 2, step: 0.05, default: 1.2 },
      { key: "r", label: "r", min: 0.1, max: 0.9, step: 0.05, default: 0.45 },
    ],
    box: [-2.2, 2.2],
  },
  {
    id: "gyroid",
    name: "Gyroid",
    blurb:
      "sin x cos y + sin y cos z + sin z cos x = 0, the standard trigonometric approximation to " +
      "Schoen's triply periodic minimal surface. It contains no straight line and no plane of " +
      "symmetry, which is what took it so long to be found.",
    equation: "sin x cos y + sin y cos z + sin z cos x = 0",
    params: [],
    box: [-Math.PI, Math.PI],
  },
  {
    id: "schwarz-p",
    name: "Schwarz P surface",
    blurb:
      "cos x + cos y + cos z = 0, the approximation to Schwarz's primitive surface — the first " +
      "triply periodic minimal surface found, and the one that divides space into two congruent " +
      "labyrinths.",
    equation: "cos x + cos y + cos z = 0",
    params: [],
    box: [-Math.PI, Math.PI],
  },
  {
    id: "schwarz-d",
    name: "Schwarz D surface",
    blurb:
      "The diamond surface, the conjugate of the P surface: the same intrinsic geometry, bent " +
      "into space the other way.",
    equation:
      "sin x sin y sin z + sin x cos y cos z + cos x sin y cos z + cos x cos y sin z = 0",
    params: [],
    box: [-Math.PI, Math.PI],
  },
  {
    id: "scherk-second",
    name: "Scherk's second surface",
    blurb:
      "sin z = sinh x sinh y: the singly periodic minimal surface, a stack of saddles joining " +
      "two pairs of half-planes.",
    equation: "sin z = sinh x sinh y",
    params: [],
    box: [-2.6, 2.6],
  },
  {
    id: "cayley",
    name: "Cayley cubic",
    blurb:
      "4(x² + y² + z²) + 16xyz = 1. The cubic surface with the most nodes a cubic can have — " +
      "four of them, where it is not a surface at all.",
    equation: "4(x^2 + y^2 + z^2) + 16 x y z = 1",
    params: [],
    box: [-1.6, 1.6],
  },
  {
    id: "clebsch",
    name: "Clebsch cubic",
    blurb:
      "The diagonal cubic surface, smooth, and famous for carrying exactly **27 straight lines** " +
      "— as every smooth cubic surface does, all of them real on this one.",
    equation:
      "81(x^3 + y^3 + z^3) - 189(x^2 y + x^2 z + y^2 x + y^2 z + z^2 x + z^2 y) " +
      "+ 54 x y z + 126(x y + x z + y z) - 9(x^2 + y^2 + z^2) - 9(x + y + z) + 1 = 0",
    params: [],
    box: [-2.2, 2.2],
  },
  {
    id: "barth",
    name: "Barth sextic",
    blurb:
      "A degree-six surface with 65 nodes — the most a sextic can have. φ is the golden ratio, " +
      "and the icosahedral symmetry is not a coincidence.",
    equation:
      "4(p^2 x^2 - y^2)(p^2 y^2 - z^2)(p^2 z^2 - x^2) - (1 + 2p)(x^2 + y^2 + z^2 - 1)^2 = 0",
    params: [
      // φ, as a parameter rather than a literal, so it can be moved off the golden ratio and the
      // 65 nodes can be watched falling apart.
      { key: "p", label: "φ", min: 1.2, max: 2, step: 0.005, default: (1 + Math.sqrt(5)) / 2 },
    ],
    box: [-2, 2],
  },
];

export const IMPLICIT_BY_ID: Readonly<Record<string, ImplicitSpec>> = Object.fromEntries(
  IMPLICIT_CATALOG.map((spec) => [spec.id, spec]),
);

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
