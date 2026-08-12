import type { Vec2 } from "../geom/types.ts";

/**
 * Marching squares: the zero set of a scalar field on a rectangular grid.
 *
 * Used for relations in the chart — `u² + v² = 1` becomes the level set of
 * `F = u² + v² − 1`, and each piece of that curve is then pushed forward onto the surface.
 * The same idea one dimension up is marching cubes, which is how implicit surfaces will be
 * meshed in M4, so getting the sign conventions and the ambiguous case right here pays twice.
 *
 * ## Segments, not traced contours
 *
 * Cells are visited independently and each emits its own short segment; nothing links them into
 * ordered polylines. That is a deliberate simplification rather than a shortcut: the line pass
 * draws one instanced quad per segment regardless, and its round caps make abutting segments
 * join seamlessly. Contour *tracing* would only be needed for arc-length parametrization or
 * dash phase along the curve, neither of which a level set needs.
 *
 * ## The ambiguous case
 *
 * When two diagonally opposite corners share a sign, a cell can be cut two ways — as two
 * separate arcs, or as a saddle joining the other pair. Guessing produces contours that
 * visibly connect wrongly near a saddle of `F`. The cell centre is sampled to decide, which is
 * the standard resolution and costs one extra evaluation per ambiguous cell only.
 */

export interface ContourOptions {
  readonly resU?: number;
  readonly resV?: number;
}

export interface ContourResult {
  /** flat pairs of endpoints: [u0,v0, u1,v1, …], two points per segment */
  readonly segments: Float64Array;
  readonly segmentCount: number;
  /** grid samples that were not finite — the non-finite contract, reported not hidden */
  readonly invalidSamples: number;
}

/** Linear interpolation to the zero crossing between two corner values. */
function crossing(a: Vec2, fa: number, b: Vec2, fb: number, out: Vec2): void {
  const denominator = fa - fb;
  // A zero denominator means both corners are zero; the midpoint is as good as anything.
  const t = Math.abs(denominator) < 1e-300 ? 0.5 : fa / denominator;
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
}

/**
 * Extract `{ (u,v) : field(u,v) = 0 }` over the given rectangle.
 *
 * `field` may return non-finite values — a relation containing `1/u` will — and cells touching
 * one are skipped rather than producing a segment through infinity.
 */
export function marchingSquares(
  field: (u: number, v: number) => number,
  bounds: { u: Vec2; v: Vec2 },
  options: ContourOptions = {},
): ContourResult {
  const resU = options.resU ?? 160;
  const resV = options.resV ?? 160;

  const [u0, u1] = bounds.u;
  const [v0, v1] = bounds.v;
  const du = (u1 - u0) / resU;
  const dv = (v1 - v0) / resV;

  // Two rows of samples at a time is all marching squares needs.
  const lower = new Float64Array(resU + 1);
  const upper = new Float64Array(resU + 1);
  let invalidSamples = 0;

  const sampleRow = (v: number, into: Float64Array) => {
    for (let i = 0; i <= resU; i++) {
      const value = field(u0 + i * du, v);
      into[i] = value;
      if (!Number.isFinite(value)) invalidSamples++;
    }
  };

  sampleRow(v0, lower);

  const out: number[] = [];
  const cornerA: Vec2 = [0, 0];
  const cornerB: Vec2 = [0, 0];
  const point: Vec2 = [0, 0];

  /** Push the crossing on the edge between two labelled corners. */
  const emitEdge = (
    au: number,
    av: number,
    fa: number,
    bu: number,
    bv: number,
    fb: number,
  ) => {
    cornerA[0] = au;
    cornerA[1] = av;
    cornerB[0] = bu;
    cornerB[1] = bv;
    crossing(cornerA, fa, cornerB, fb, point);
    out.push(point[0], point[1]);
  };

  for (let j = 0; j < resV; j++) {
    const vLow = v0 + j * dv;
    const vHigh = v0 + (j + 1) * dv;
    sampleRow(vHigh, upper);

    for (let i = 0; i < resU; i++) {
      const uLeft = u0 + i * du;
      const uRight = u0 + (i + 1) * du;

      // Corners, counter-clockwise from bottom-left.
      const f00 = lower[i]!;
      const f10 = lower[i + 1]!;
      const f11 = upper[i + 1]!;
      const f01 = upper[i]!;

      if (
        !Number.isFinite(f00) ||
        !Number.isFinite(f10) ||
        !Number.isFinite(f11) ||
        !Number.isFinite(f01)
      ) {
        continue;
      }

      // Corner sign bits: a cell is cut wherever neighbouring signs differ.
      const code =
        (f00 > 0 ? 1 : 0) | (f10 > 0 ? 2 : 0) | (f11 > 0 ? 4 : 0) | (f01 > 0 ? 8 : 0);
      if (code === 0 || code === 15) continue;

      const bottom = () => emitEdge(uLeft, vLow, f00, uRight, vLow, f10);
      const right = () => emitEdge(uRight, vLow, f10, uRight, vHigh, f11);
      const top = () => emitEdge(uRight, vHigh, f11, uLeft, vHigh, f01);
      const left = () => emitEdge(uLeft, vHigh, f01, uLeft, vLow, f00);

      switch (code) {
        case 1:
        case 14:
          left();
          bottom();
          break;
        case 2:
        case 13:
          bottom();
          right();
          break;
        case 3:
        case 12:
          left();
          right();
          break;
        case 4:
        case 11:
          right();
          top();
          break;
        case 6:
        case 9:
          bottom();
          top();
          break;
        case 7:
        case 8:
          top();
          left();
          break;

        // Diagonally opposite corners agree: the cell can be cut two ways, and the centre
        // value decides which. Without this the contour joins wrongly at a saddle of F.
        case 5:
        case 10: {
          const centre = field(uLeft + du / 2, vLow + dv / 2);
          if (!Number.isFinite(centre)) break;
          const centrePositive = centre > 0;
          const cornerPositive = code === 5; // f00 and f11 positive
          if (centrePositive === cornerPositive) {
            // Saddle: the two arcs connect through the middle.
            left();
            top();
            bottom();
            right();
          } else {
            left();
            bottom();
            right();
            top();
          }
          break;
        }
      }
    }

    lower.set(upper);
  }

  return {
    segments: Float64Array.from(out),
    segmentCount: out.length / 4,
    invalidSamples,
  };
}
