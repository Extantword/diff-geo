import { interval, type Interval } from "../geom/types.ts";
import type { BoundaryName } from "../geom/ports.ts";

/**
 * The parts bin: surfaces made to be joined edge to edge.
 *
 * Roller-coaster construction, for surfaces. Every piece is an ordinary parametrization — the same
 * source text a user could type — and everything that makes it snap comes from **measuring** its
 * boundaries afterwards (`geom/ports.ts`). Nothing here is a special kind of object; a piece is a
 * row like any other, and can be edited, coloured, painted with K and shot with geodesics.
 *
 * ## Pieces are sized to the socket, not scaled after the fact
 *
 * A piece is generated at the size of the boundary it is being attached to: joining a tube of
 * radius 0.8 emits a tube whose formula says 0.8. That is the difference between "matching
 * boundaries" and "boundaries that look matched" — the two rims coincide to machine precision
 * because they are the same number, and no scale factor is applied to the drawn geometry, which
 * would have changed every curvature.
 *
 * `entry` is the boundary that plugs into the socket and `exit` the one offered as the next
 * socket, so clicking a piece repeatedly builds a chain the way laying track does. Both are
 * **checked against measurement** in the tests rather than trusted.
 */

export interface PieceBuild {
  readonly components: readonly [string, string, string];
  readonly u: Interval;
  readonly v: Interval;
}

export interface PieceSpec {
  readonly id: string;
  readonly name: string;
  readonly blurb: string;
  /** which shape of port this piece can plug into */
  readonly plug: "circle" | "segment";
  /** the boundary that mates with the socket */
  readonly entry: BoundaryName;
  /** the boundary offered as the next socket, or null for a piece that closes one off */
  readonly exit: BoundaryName | null;
  /** the parametrization, sized to the port it must match */
  build(size: number): PieceBuild;
}

/**
 * How far a cap's chart starts from its own tip, as a fraction of the piece.
 *
 * At the tip `X_u × X_v` vanishes, so the domain has to open there. It is written as a shifted
 * start rather than as an `Interval` inset because an inset pulls in from **both** ends, which
 * would shrink the rim by the same fraction — and a rim 0.2% too small is exactly the kind of gap
 * this whole mechanism exists to prevent. The other end is the port, and it must be exact.
 */
const TIP_GAP = 0.004;

const HALF_PI = Math.PI / 2;
const TWO_PI = 2 * Math.PI;

/** A number as a person would write it, with the trailing noise of binary floats removed. */
function num(value: number): string {
  return String(Number(value.toPrecision(6)));
}

/** `k · expr`, written the way a person would: nothing for 1, a bare minus for −1. */
function scaled(k: number, expr: string): string {
  if (Math.abs(k - 1) < 1e-12) return expr;
  if (Math.abs(k + 1) < 1e-12) return `-${expr}`;
  return `${num(k)} ${expr}`;
}

export const PIECES: readonly PieceSpec[] = [
  {
    id: "tube",
    name: "Tube",
    blurb: "A cylinder of the socket's radius. Two rims; the identity cobordism of a circle.",
    plug: "circle",
    entry: "uMin",
    exit: "uMax",
    build: (r) => ({
      components: [scaled(r, "cos v"), scaled(r, "sin v"), "u"],
      u: interval(0, 2 * r),
      v: interval(0, TWO_PI),
    }),
  },
  {
    id: "elbow",
    name: "Elbow",
    blurb: "A quarter turn of tube, bent about a radius twice its own. Two rims at right angles.",
    plug: "circle",
    entry: "uMin",
    exit: "uMax",
    build: (r) => ({
      // A quarter of a torus: the tube of radius r about a circle of radius 2r.
      components: [
        `(${num(2 * r)} + ${scaled(r, "cos v")}) cos u`,
        `(${num(2 * r)} + ${scaled(r, "cos v")}) sin u`,
        scaled(r, "sin v"),
      ],
      u: interval(0, HALF_PI),
      v: interval(0, TWO_PI),
    }),
  },
  {
    id: "reducer",
    name: "Reducer",
    blurb: "A cone frustum, halving the radius over its length. Joins two tubes of different size.",
    plug: "circle",
    entry: "uMin",
    exit: "uMax",
    build: (r) => ({
      // Radius r → r/2 over a length of 2r, so the slope is a constant ¼ whatever the size.
      components: [`(${num(r)} - 0.25u) cos v`, `(${num(r)} - 0.25u) sin v`, "u"],
      u: interval(0, 2 * r),
      v: interval(0, TWO_PI),
    }),
  },
  {
    id: "dome",
    name: "Dome",
    blurb: "A hemisphere closing a rim off. The birth or death of a circle, in a cobordism.",
    plug: "circle",
    entry: "uMax",
    exit: null,
    build: (r) => ({
      components: [scaled(r, "sin u cos v"), scaled(r, "sin u sin v"), scaled(r, "cos u")],
      // The chart is singular at the tip, where X_u × X_v vanishes; starting just off it keeps
      // sampling clear, and the collapse is what tells the port detector that end is no boundary.
      u: interval(TIP_GAP, HALF_PI),
      v: interval(0, TWO_PI),
    }),
  },
  {
    id: "disc",
    name: "Disc",
    blurb: "A flat cap. Closes a rim off in its own plane rather than bulging out of it.",
    plug: "circle",
    entry: "uMax",
    exit: null,
    build: (r) => ({
      components: ["u cos v", "u sin v", "0"],
      u: interval(TIP_GAP * r, r),
      v: interval(0, TWO_PI),
    }),
  },
  {
    id: "plate",
    name: "Plate",
    blurb: "A flat square patch. Four straight edges, all of them joinable.",
    plug: "segment",
    entry: "uMin",
    exit: "uMax",
    build: (r) => ({
      components: ["u", "v", "0"],
      u: interval(-r, r),
      v: interval(-r, r),
    }),
  },
  {
    id: "fold",
    name: "Fold",
    blurb: "A plate bent through a right angle, on a radius of its own half-width.",
    plug: "segment",
    entry: "uMin",
    exit: "uMax",
    build: (r) => ({
      components: [scaled(r, "sin u"), "v", `${num(r)} (1 - cos u)`],
      u: interval(0, HALF_PI),
      v: interval(-r, r),
    }),
  },
];

export const PIECE_BY_ID: Readonly<Record<string, PieceSpec>> = Object.fromEntries(
  PIECES.map((piece) => [piece.id, piece]),
);
