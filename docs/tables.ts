import {
  CATALOG,
  CATALOG_FIELDS,
  IMPLICIT_CATALOG,
} from "../src/core/catalog/surfaces.ts";
import { CURVE_CATALOG } from "../src/core/catalog/curves.ts";
import { PIECES } from "../src/core/catalog/pieces.ts";
import { FN_DEFS } from "../src/core/expr/fns.ts";
import { CONSTANTS, GREEK_WORDS } from "../src/core/expr/lex.ts";
import type { DiagCode } from "../src/core/expr/diagnostics.ts";
import type { StopReason } from "../src/core/geom/geodesic.ts";
import type { ItemKind } from "../src/state/graph.ts";

/**
 * The parts of the reference that are read off the code rather than typed.
 *
 * Every table here is either **generated** from live data — the function list, the catalog, the
 * pieces — or is a `Record` over a union the code exports, so that adding a member to `ItemKind`,
 * `DiagCode` or `StopReason` fails `tsc -b`, which fails the build, which fails the deploy, until
 * somebody writes the sentence. Documentation that can go quietly out of date is worse than none,
 * because it is believed; this is the same reasoning that makes periodicity measured rather than
 * declared, and it is cheap to arrange while the docs live in the repo.
 *
 * Pure: no node imports, so the test suite can import it directly. See `render.ts`.
 */

/** Where the site lives. The one absolute URL in the project; see `absolutize`. */
export const SITE = "https://extantword.github.io/diff-geo";

/** A block the markdown asks for by name, as `<!-- generated: functions -->`. */
const DIRECTIVE = /^<!--\s*generated:\s*([a-zA-Z.]+)\s*-->$/;

/**
 * What each kind of row is, in the reader's terms.
 *
 * `Record<ItemKind, …>` on purpose: a new kind of drawable object cannot ship undocumented.
 */
const ROW_KINDS: Record<ItemKind, { readonly example: string; readonly draws: string }> = {
  parametricSurface: {
    example: "X(u,v) = (sin u cos v, sin u sin v, cos u)",
    draws: "a coordinate patch: a shaded face, its (u, v) grid and its domain border",
  },
  graphSurface: {
    example: "z = x^2 - y^2",
    draws: "the graph of a function of two ambient coordinates, as a patch over the x–y plane",
  },
  spaceCurve: {
    example: "alpha(t) = (cos t, sin t, t/3)",
    draws: "a curve in space, with an optional moving frame",
  },
  planeCurve: {
    example: "beta(t) = (cos t, sin t)",
    draws: "a curve in the z = 0 plane — or in a chart, if the row says so",
  },
  point: { example: "(1, 2, 3)", draws: "a single point" },
  chartGraph: {
    example: "X: v = sin u",
    draws: "the graph v = f(u) drawn flat in the chart and pushed onto the surface",
  },
  chartRelation: {
    example: "X: (u - 1)^2 + (v - 2)^2 = 1",
    draws: "the level set of a relation between u and v, in the chart and on the surface",
  },
  tangentPlane: {
    example: "T_(1, 2) X",
    draws: "the tangent plane at a point of a chart, with X_u, X_v and N",
  },
  surfaceField: {
    example: "X: VectorField(-sin u sin v, sin u cos v, 0)",
    draws: "a vector field along a patch, as arrows — and as a flow when played",
  },
  parameter: { example: "R = 2", draws: "nothing; it gets a slider, and other rows can use it" },
  ambientSpace: {
    example: "A_1 = AmbientSpace",
    draws: "a copy of R\u00b3 with its axes, entered by opening it; rows written in it say `A_1:`",
  },
  scalar: { example: "a = 2R + 1", draws: "nothing; a value other rows can use" },
  functionDefinition: {
    example: "h(a, b) = a^2 + b^2",
    draws: "nothing; a definition other rows can call",
  },
  implicitSurface: {
    example: "x^2 + y^2 + z^2 = 1",
    draws:
      "the level set F = 0, meshed inside a box — `x^2 + y^2 = 1` is the cylinder, and a row " +
      "can ask to be drawn flat in the z = 0 plane instead",
  },
  vectorField: { example: "V(x,y,z) = (y, -x, 0)", draws: "nothing yet — a field on all of R³" },
  unknown: { example: "—", draws: "nothing; the row did not classify" },
};

/** Every diagnostic the document layer can raise, and what to do about it. */
const DIAGNOSTICS: Record<DiagCode, string> = {
  E_PARSE: "the text could not be read as a formula at all",
  E_UNEXPECTED: "something is where nothing can be — usually a stray operator or a missing one",
  E_UNCLOSED: "a parenthesis, a subscript brace or a row form was never closed",
  E_ARITY: "a function or a row form was given the wrong number of arguments",
  E_RESERVED: "the name is a built-in function, or a coordinate, and cannot be defined",
  E_EMPTY: "there is nothing to read here",
  E_BAD_ARGUMENT: "a function was used with no argument, as in a bare `sin`",
  E_NESTED_TUPLE: "a tuple may only be the whole right-hand side, never part of an expression",
  E_UNDEF_SYMBOL: "a name that nothing defines and that cannot become a slider",
  E_CYCLE: "this row is part of a circular definition, so nothing in the cycle is evaluated",
  E_DUPLICATE:
    "two rows declare this name, so it resolves to **neither** — failing closed, because " +
    "picking the first would make editing order silently significant",
  E_RECURSION: "the row refers to itself, which the CAS cannot differentiate",
  E_TOO_COMPLEX: "expanding the definitions produced more terms than the compiler will take",
  E_CLASSIFY:
    "the shape is recognised but is not a drawable object; the message says what would be",
  W_AMBIGUOUS_IMPLICIT_MUL:
    "an implicit product was swallowed into a denominator: `1/2u` reads as `1/(2u)`",
  W_DOMAIN: "part of what was drawn falls outside the domain it is drawn over",
  W_TWO_HOSTS: "the row names two different patches; the one after the form wins",
  H_PARENTHESIZE: "a suggestion to bracket something the reader may be misjudging",
  H_ADD_SLIDER: "a free name was found, so it became a parameter with a slider",
};

/** Why a geodesic stopped. Reported per ray, because a picture without one is not a diagnosis. */
const GEODESIC_STOPS: Record<StopReason, string> = {
  length: "it ran the whole arc length asked for",
  outOfDomain: "it reached the edge of the domain, and that edge is a wall rather than a seam",
  singular: "it reached a point with no tangent plane — a chart pole, a cone point",
  nonFinite: "the integration produced a value that is not a number",
  maxSteps: "the step count ran out before the length did",
};

/** Replace every `<!-- generated: … -->` line with the block it names. */
export function expand(source: string): string {
  return source
    .split("\n")
    .map((line) => {
      const matched = DIRECTIVE.exec(line.trim());
      if (!matched) return line;
      const name = matched[1]!;
      const block = BLOCKS[name];
      if (!block) {
        throw new Error(
          `docs: no generated block called "${name}" — known blocks are ` +
            `${Object.keys(BLOCKS).join(", ")}`,
        );
      }
      return block();
    })
    .join("\n");
}

/** Every generated block's name, for the test that checks the markdown uses them all. */
export const BLOCK_NAMES: readonly string[] = [
  "rowKinds",
  "diagnostics",
  "geodesicStops",
  "functions",
  "constants",
  "greek",
  "catalog.surfaces",
  "catalog.implicit",
  "catalog.curves",
  "catalog.fields",
  "catalog.pieces",
];

const BLOCKS: Record<string, () => string> = {
  rowKinds: () =>
    table(
      ["kind", "written as", "what it draws"],
      Object.entries(ROW_KINDS).map(([kind, entry]) => [
        `\`${kind}\``,
        `\`${entry.example}\``,
        entry.draws,
      ]),
    ),

  diagnostics: () =>
    table(
      ["code", "what it means"],
      Object.entries(DIAGNOSTICS).map(([code, meaning]) => [`\`${code}\``, meaning]),
    ),

  geodesicStops: () =>
    table(
      ["stop", "meaning"],
      Object.entries(GEODESIC_STOPS).map(([stop, meaning]) => [`\`${stop}\``, meaning]),
    ),

  functions: () => {
    const rows = FN_DEFS.map((def) => {
      const aliases = def.aliases ?? [];
      return [
        `\`${def.name}\``,
        String(def.arity),
        aliases.length === 0 ? "—" : aliases.map((name) => `\`${name}\``).join(", "),
      ];
    });
    return table(["function", "arguments", "also written"], rows);
  },

  constants: () =>
    table(
      ["written", "value"],
      [...CONSTANTS.entries()].map(([name, value]) => [
        `\`${name}\``,
        value === Math.PI ? "π = 3.14159…" : String(value),
      ]),
    ),

  greek: () => `Spelled out: ${GREEK_WORDS.map((name) => `\`${name}\``).join(", ")}.`,

  "catalog.surfaces": () =>
    table(
      ["surface", "X(u, v)", "what it is for"],
      CATALOG.map((spec) => [
        spec.name,
        `\`(${spec.components.join(", ")})\``,
        spec.blurb,
      ]),
    ),

  "catalog.implicit": () =>
    table(
      ["surface", "equation", "what it is for"],
      IMPLICIT_CATALOG.map((spec) => [spec.name, `\`${spec.equation}\``, spec.blurb]),
    ),

  "catalog.curves": () =>
    table(
      ["curve", "α(t)", "what it is for"],
      CURVE_CATALOG.map((spec) => [
        spec.name,
        `\`(${spec.components.join(", ")})\``,
        spec.blurb,
      ]),
    ),

  "catalog.fields": () =>
    table(
      ["on", "field", "components"],
      CATALOG_FIELDS.map(({ spec, field }) => [
        spec.name,
        field.label,
        `\`(${field.components.join(", ")})\``,
      ]),
    ),

  "catalog.pieces": () =>
    table(
      ["piece", "joins to", "what it is"],
      PIECES.map((piece) => [piece.name, `a ${piece.plug}`, piece.blurb]),
    ),
};

/**
 * A pipe table, with every cell's pipes escaped.
 *
 * A blurb containing a `|` would otherwise produce a ragged row, which `render.ts` refuses — so
 * the generator would break the build over a comma in a catalog entry.
 */
function table(head: readonly string[], rows: readonly (readonly string[])[]): string {
  const escape = (cell: string) => cell.replace(/\|/g, "\\|").replace(/\n/g, " ");
  const lines = [
    `| ${head.map(escape).join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(escape).join(" | ")} |`),
  ];
  return lines.join("\n");
}
