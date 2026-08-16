import { QUAT_IDENTITY, quatFromAxisAngle, quatRotate, type Quat } from "../num/quat.ts";
import { makeChartData, makeSurfacePoint, sampleBounds, type Vec3 } from "./types.ts";
import type { ParametricSurface } from "./parametric.ts";
import type { ChartPoles } from "./periodic.ts";

/**
 * Boundaries as **ports**: what one surface can be joined to another along.
 *
 * A piece-based builder — the roller-coaster idea, where a catalog of parts snaps together — needs
 * to answer one question about every patch: where does it end, and what shape is the end. Both are
 * **measured from the parametrization**, never declared, for the same reason periodicity is
 * (`periodic.ts`): a template arrives as source text, so any declaration attached to the catalog
 * entry is gone by the time geometry sees it, and a hand-typed cylinder never had one. Measuring
 * gives the hand-typed cylinder the same two rims the catalog one has.
 *
 * ## What a port is
 *
 * A rigid **frame** on a boundary curve — origin, an axis pointing out of the patch, and a phase
 * reference perpendicular to it — plus the curve's shape, as one of two cases:
 *
 *  - a **circle**: a boundary that closes up, like a tube's rim. `size` is its radius.
 *  - a **segment**: a boundary that does not, like the edge of a plate. `size` is its half-length.
 *
 * That is enough for joining, because joining is exactly "bring these two frames into opposition":
 * one rigid motion, determined up to a roll about the shared axis, which is left as a dial.
 *
 * ## Which boundaries are ports, and which are not
 *
 * Three kinds of chart boundary are **not** an edge of the surface and so cannot be a port:
 *
 *  - a **seam**, where the chart closes on itself — the torus has no boundary at all;
 *  - a **pole**, whose image collapses to a point — the sphere does not end at its north pole,
 *    its coordinates do;
 *  - anything the evaluator cannot make finite sense of.
 *
 * Both of the first two are already measured elsewhere and are consumed here rather than redone.
 */

export type BoundaryName = "uMin" | "uMax" | "vMin" | "vMax";

export const BOUNDARIES: readonly BoundaryName[] = ["uMin", "uMax", "vMin", "vMax"];

export interface Port {
  readonly boundary: BoundaryName;
  /** a boundary that closes up is a circle; one that does not is a segment */
  readonly kind: "circle" | "segment";
  /** radius for a circle, half-length for a segment */
  readonly size: number;
  /** the centre of the boundary curve */
  readonly origin: Vec3;
  /**
   * Unit, pointing **out of the patch**: the direction the surface would continue in.
   *
   * For a circle this is the normal of the circle's own plane, signed to agree with the chart's
   * outward direction — so a tube's rim gives the tube's axis, and a flat disc gives its normal,
   * which is what makes a disc cap a tube rather than stand up in it.
   */
  readonly axis: Vec3;
  /**
   * Unit, perpendicular to the axis: where the boundary's first sample lies.
   *
   * This is what fixes the **roll**. Two tubes joined with roll 0 have their v = 0 seams aligned,
   * so the join is reproducible rather than dependent on how the mesh happened to be sampled.
   */
  readonly up: Vec3;
  /**
   * How far the boundary departs from the ideal shape, relative to `size`.
   *
   * Reported rather than enforced. An out-of-round rim can still be joined — the frames match
   * regardless — and the number is what tells the user why a visible gap appeared.
   */
  readonly deviation: number;
}

/** Samples taken along a boundary when measuring it. */
const SAMPLES = 64;

/**
 * Below this, the chart's outward direction says nothing about which way the port's axis points.
 *
 * The case is a **flat cap**: a disc's boundary circle lies in the disc's own plane, so the plane's
 * normal is perpendicular to the direction the chart runs out along, and signing one by the other
 * is a coin flip. The surface normal decides it instead.
 */
const OUTWARD_AGREEMENT = 0.25;

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const finite = (a: Vec3) => Number.isFinite(a[0]) && Number.isFinite(a[1]) && Number.isFinite(a[2]);

function normalized(a: Vec3): Vec3 | null {
  const length = norm(a);
  if (!(length > 1e-12) || !Number.isFinite(length)) return null;
  return [a[0] / length, a[1] / length, a[2] / length];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

/** `a` with its component along the unit vector `n` removed. */
function rejected(a: Vec3, n: Vec3): Vec3 {
  const d = dot(a, n);
  return [a[0] - d * n[0], a[1] - d * n[1], a[2] - d * n[2]];
}

/**
 * Measure every boundary of a surface that is a genuine edge, and describe it as a port.
 *
 * Seams and poles are skipped, so a torus yields nothing, a sphere yields nothing, a cylinder
 * yields its two rims and a plane patch yields its four sides.
 */
export function detectPorts(
  surface: ParametricSurface,
  params: ArrayLike<number>,
  poles?: ChartPoles,
): Port[] {
  const ports: Port[] = [];
  for (const boundary of BOUNDARIES) {
    const port = detectPort(surface, params, boundary, poles);
    if (port) ports.push(port);
  }
  return ports;
}

/** One boundary, or null when it is a seam, a pole, or not finite. */
export function detectPort(
  surface: ParametricSurface,
  params: ArrayLike<number>,
  boundary: BoundaryName,
  poles?: ChartPoles,
): Port | null {
  const alongU = boundary === "uMin" || boundary === "uMax";
  // A coordinate that closes up has no boundary to speak of: both of its "ends" are the same
  // curve, glued. Offering it as a port would invite joining a surface to itself along a seam.
  if (alongU ? surface.periodicU : surface.periodicV) return null;
  if (poles?.[boundary]) return null;

  const [uLo, uHi] = sampleBounds(surface.u);
  const [vLo, vHi] = sampleBounds(surface.v);
  const atMin = boundary === "uMin" || boundary === "vMin";
  const fixed = alongU ? (atMin ? uLo : uHi) : atMin ? vLo : vHi;
  const [runLo, runHi] = alongU ? [vLo, vHi] : [uLo, uHi];
  if (!(runHi > runLo)) return null;

  // The boundary runs along the OTHER coordinate; it closes up exactly when that one is a seam.
  const closed = alongU ? surface.periodicV : surface.periodicU;

  const point = makeSurfacePoint();
  const chart = makeChartData();
  const samples: Vec3[] = [];
  const outward: Vec3 = [0, 0, 0];
  const meanNormal: Vec3 = [0, 0, 0];
  let framed = 0;

  // A closed boundary's two ends are the same point; sampling both would weight it twice in
  // every mean taken below.
  const count = closed ? SAMPLES : SAMPLES + 1;
  for (let k = 0; k < count; k++) {
    const t = runLo + ((runHi - runLo) * k) / SAMPLES;
    const u = alongU ? fixed : t;
    const v = alongU ? t : fixed;

    surface.at(u, v, params, point, chart);
    if (!finite(point.p)) continue;
    samples.push([point.p[0], point.p[1], point.p[2]]);
    if (point.degenerate) continue;

    /**
     * Which way the patch runs out through this boundary, as an exact derivative.
     *
     * `X_u` at a u-boundary, signed by which end it is. Taken from the chart data rather than
     * by differencing two positions: the jet already has it, and a difference would be one more
     * place for a numerical tolerance to be tuned.
     */
    const tangent = alongU ? chart.Xu : chart.Xv;
    const sign = atMin ? -1 : 1;
    const unit = normalized([tangent[0], tangent[1], tangent[2]]);
    if (!unit) continue;
    outward[0] += sign * unit[0];
    outward[1] += sign * unit[1];
    outward[2] += sign * unit[2];
    meanNormal[0] += point.N[0];
    meanNormal[1] += point.N[1];
    meanNormal[2] += point.N[2];
    framed++;
  }

  if (samples.length < 3 || framed === 0) return null;

  /**
   * The mean outward direction can vanish, and does for the case that matters most.
   *
   * A flat disc runs out of chart radially, in every direction at once, so the mean is zero — and
   * it is exactly the disc that needs an axis to be capped with. The mean surface normal answers
   * it there, which is why both are carried this far rather than one being demanded up front.
   */
  const outwardUnit = normalized(outward);
  const normalUnit = normalized(meanNormal);

  if (closed) return circlePort(boundary, samples, outwardUnit, normalUnit);
  return outwardUnit ? segmentPort(boundary, samples, outwardUnit) : null;
}

/**
 * A closed boundary, as a circle in its own plane.
 *
 * The plane comes from Newell's area vector rather than from three chosen samples, so a boundary
 * sampled unevenly — or one with a nearly-degenerate stretch — still gets a stable normal.
 */
function circlePort(
  boundary: BoundaryName,
  samples: readonly Vec3[],
  outward: Vec3 | null,
  meanNormal: Vec3 | null,
): Port | null {
  const area: Vec3 = [0, 0, 0];
  for (let i = 0; i < samples.length; i++) {
    const a = samples[i]!;
    const b = samples[(i + 1) % samples.length]!;
    area[0] += a[1] * b[2] - a[2] * b[1];
    area[1] += a[2] * b[0] - a[0] * b[2];
    area[2] += a[0] * b[1] - a[1] * b[0];
  }
  let axis = normalized(area);
  if (!axis) return null;

  /**
   * Point the axis out of the patch.
   *
   * Normally the chart's own outward direction decides. When the two are perpendicular the
   * boundary is a flat cap — a disc's rim lies in the disc's plane — and the surface normal is
   * what is left to decide with. Either choice describes the same circle; what it fixes is which
   * face of the cap points away from whatever it is joined to.
   */
  const agreement = outward ? dot(axis, outward) : 0;
  if (Math.abs(agreement) >= OUTWARD_AGREEMENT) {
    if (agreement < 0) axis = [-axis[0], -axis[1], -axis[2]];
  } else if (meanNormal && dot(axis, meanNormal) < 0) {
    axis = [-axis[0], -axis[1], -axis[2]];
  }

  const { centre, radius } = fitCircle(samples, axis);
  if (!(radius > 0) || !Number.isFinite(radius) || !finite(centre)) return null;

  let deviation = 0;
  for (const p of samples) {
    const d: Vec3 = [p[0] - centre[0], p[1] - centre[1], p[2] - centre[2]];
    deviation = Math.max(deviation, Math.abs(norm(d) - radius) / radius);
    deviation = Math.max(deviation, Math.abs(dot(d, axis)) / radius);
  }

  const up = normalized(rejected(
    [samples[0]![0] - centre[0], samples[0]![1] - centre[1], samples[0]![2] - centre[2]],
    axis,
  )) ?? anyPerpendicular(axis);

  return { boundary, kind: "circle", size: radius, origin: centre, axis, up, deviation };
}

/**
 * The circle through a set of samples, by least squares in their own plane.
 *
 * **Not** the centroid and the mean radius. Those agree with the circle only when the boundary is
 * swept at a constant rate, and a user's parametrization need not be — `cos(v + sin v)` traces the
 * same circle unevenly, and the centroid then sits visibly off centre, which in an assembly shows
 * up as pieces joined with a step in them.
 *
 * The algebraic (Kåsa) fit is used because it is linear: minimising `Σ(|p−c|² − r²)²` gives three
 * normal equations, and for samples that really do lie on a circle the fit is **exact regardless
 * of how they are distributed**, which is the property being bought here. Its known weakness —
 * bias when the samples cover only a short arc of a noisy circle — cannot arise, since a boundary
 * that closes up covers the whole of it.
 */
function fitCircle(samples: readonly Vec3[], axis: Vec3): { centre: Vec3; radius: number } {
  const origin: Vec3 = [0, 0, 0];
  for (const p of samples) {
    origin[0] += p[0] / samples.length;
    origin[1] += p[1] / samples.length;
    origin[2] += p[2] / samples.length;
  }

  const e1 = anyPerpendicular(axis);
  const e2 = cross(axis, e1);

  let sa = 0;
  let sb = 0;
  let saa = 0;
  let sab = 0;
  let sbb = 0;
  let sq = 0;
  let saq = 0;
  let sbq = 0;
  let sn = 0;
  for (const p of samples) {
    const d: Vec3 = [p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]];
    const a = dot(d, e1);
    const b = dot(d, e2);
    const q = a * a + b * b;
    sa += a;
    sb += b;
    saa += a * a;
    sab += a * b;
    sbb += b * b;
    sq += q;
    saq += a * q;
    sbq += b * q;
    sn += dot(d, axis);
  }

  const n = samples.length;
  // Cramer's rule on the 3×3 normal equations for (A, B, C), with the centre at (A/2, B/2).
  const m = [saa, sab, sa, sab, sbb, sb, sa, sb, n];
  const det =
    m[0]! * (m[4]! * m[8]! - m[5]! * m[7]!) -
    m[1]! * (m[3]! * m[8]! - m[5]! * m[6]!) +
    m[2]! * (m[3]! * m[7]! - m[4]! * m[6]!);

  const centre: Vec3 = [
    origin[0] + (sn / n) * axis[0],
    origin[1] + (sn / n) * axis[1],
    origin[2] + (sn / n) * axis[2],
  ];

  // A determinant this small means the samples are collinear or coincident — there is no circle
  // through them. The centroid and the mean radius are then the honest answer, and `deviation`
  // will say how badly the boundary fails to be round.
  const scale = Math.max(saa + sbb, 1e-300);
  if (Math.abs(det) > 1e-12 * scale * scale) {
    const rhs = [saq, sbq, sq];
    const solveColumn = (column: number) => {
      const c = [...m];
      c[column] = rhs[0]!;
      c[column + 3] = rhs[1]!;
      c[column + 6] = rhs[2]!;
      return (
        c[0]! * (c[4]! * c[8]! - c[5]! * c[7]!) -
        c[1]! * (c[3]! * c[8]! - c[5]! * c[6]!) +
        c[2]! * (c[3]! * c[7]! - c[4]! * c[6]!)
      ) / det;
    };
    const A = solveColumn(0) / 2;
    const B = solveColumn(1) / 2;
    centre[0] += A * e1[0] + B * e2[0];
    centre[1] += A * e1[1] + B * e2[1];
    centre[2] += A * e1[2] + B * e2[2];
  }

  let radius = 0;
  for (const p of samples) {
    radius += Math.hypot(p[0] - centre[0], p[1] - centre[1], p[2] - centre[2]) / samples.length;
  }
  return { centre, radius };
}

/** An open boundary, as the straight segment between its two ends. */
function segmentPort(
  boundary: BoundaryName,
  samples: readonly Vec3[],
  outward: Vec3,
): Port | null {
  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  const chord: Vec3 = [last[0] - first[0], last[1] - first[1], last[2] - first[2]];
  const half = norm(chord) / 2;
  const along = normalized(chord);
  if (!along || !(half > 0)) return null;

  const origin: Vec3 = [
    (first[0] + last[0]) / 2,
    (first[1] + last[1]) / 2,
    (first[2] + last[2]) / 2,
  ];
  // Straightness, as the largest departure from the chord. A curved edge still joins — the frames
  // match — but the two edges will only lie on each other if they curve the same way.
  let deviation = 0;
  for (const p of samples) {
    const d: Vec3 = [p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]];
    deviation = Math.max(deviation, norm(rejected(d, along)) / half);
  }

  const axis = normalized(rejected(outward, along));
  if (!axis) return null;
  const up = normalized(rejected(along, axis)) ?? anyPerpendicular(axis);
  return { boundary, kind: "segment", size: half, origin, axis, up, deviation };
}

/** Some unit vector perpendicular to `axis`, for a phase reference that could not be measured. */
function anyPerpendicular(axis: Vec3): Vec3 {
  const helper: Vec3 = Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  return normalized(cross(axis, helper)) ?? [0, 0, 1];
}

/**
 * The port's boundary curve itself, as points — a ring for a rim, two ends for an edge.
 *
 * Shared by the handle drawn on the stage and by the hit test that selects it, so what the pointer
 * is measured against is exactly what the eye is looking at. Computing them separately is how a
 * handle ends up unclickable a few pixels from where it is drawn.
 */
export function portOutline(port: Port, samples = 48): Vec3[] {
  const e2 = cross(port.axis, port.up);
  if (port.kind === "segment") {
    return [
      [
        port.origin[0] - port.up[0] * port.size,
        port.origin[1] - port.up[1] * port.size,
        port.origin[2] - port.up[2] * port.size,
      ],
      [
        port.origin[0] + port.up[0] * port.size,
        port.origin[1] + port.up[1] * port.size,
        port.origin[2] + port.up[2] * port.size,
      ],
    ];
  }
  const points: Vec3[] = [];
  for (let k = 0; k <= samples; k++) {
    const angle = (2 * Math.PI * k) / samples;
    const c = Math.cos(angle) * port.size;
    const s = Math.sin(angle) * port.size;
    points.push([
      port.origin[0] + c * port.up[0] + s * e2[0],
      port.origin[1] + c * port.up[1] + s * e2[1],
      port.origin[2] + c * port.up[2] + s * e2[2],
    ]);
  }
  return points;
}

/**
 * A rigid placement: `world = rotation · local + translation`.
 *
 * Rotation about the **local origin**, deliberately. Arrangement by hand turns an object about its
 * own centre, which is what makes dragging feel right; but a joined piece has to turn about the
 * frame it is being joined by, and only a placement written this way composes down a chain of
 * joints without accumulating a different pivot at every step.
 */
export interface Placement {
  readonly rotation: Quat;
  readonly translation: Vec3;
}

export const IDENTITY_PLACEMENT: Placement = {
  rotation: QUAT_IDENTITY,
  translation: [0, 0, 0],
};

/** Where a local point ends up. */
export function applyPlacement(placement: Placement, p: Vec3, out: Vec3): Vec3 {
  quatRotate(placement.rotation, p[0], p[1], p[2], out);
  out[0] += placement.translation[0];
  out[1] += placement.translation[1];
  out[2] += placement.translation[2];
  return out;
}

/**
 * The placement equivalent to turning about `pivot` and then shifting by `offset`.
 *
 * This is how hand arrangement is expressed in the same algebra as a joint, so a piece attached to
 * a hand-placed one inherits its motion correctly instead of needing a second code path.
 */
export function placementAbout(rotation: Quat, pivot: Vec3, offset: Vec3): Placement {
  const turned: Vec3 = [0, 0, 0];
  quatRotate(rotation, pivot[0], pivot[1], pivot[2], turned);
  return {
    rotation,
    translation: [
      pivot[0] - turned[0] + offset[0],
      pivot[1] - turned[1] + offset[1],
      pivot[2] - turned[2] + offset[2],
    ],
  };
}

/**
 * The hand arrangement — turn about `pivot`, then shift — equivalent to a placement.
 *
 * The inverse of `placementAbout`, and what a piece needs when it is unplugged: without it a
 * detached piece would fall back to whatever translation it was created with and jump across the
 * scene, when what the user asked for was to leave it exactly where it is.
 */
export function handArrangement(
  placement: Placement,
  pivot: Vec3,
): { rotation: Quat; offset: Vec3 } {
  const turned: Vec3 = [0, 0, 0];
  quatRotate(placement.rotation, pivot[0], pivot[1], pivot[2], turned);
  return {
    rotation: placement.rotation,
    offset: [
      placement.translation[0] + turned[0] - pivot[0],
      placement.translation[1] + turned[1] - pivot[1],
      placement.translation[2] + turned[2] - pivot[2],
    ],
  };
}

/** The same port, seen from the world after its surface has been placed. */
export function transformPort(port: Port, placement: Placement): Port {
  const origin: Vec3 = [0, 0, 0];
  const axis: Vec3 = [0, 0, 0];
  const up: Vec3 = [0, 0, 0];
  applyPlacement(placement, port.origin, origin);
  quatRotate(placement.rotation, port.axis[0], port.axis[1], port.axis[2], axis);
  quatRotate(placement.rotation, port.up[0], port.up[1], port.up[2], up);
  return { ...port, origin, axis, up };
}

/**
 * The placement that brings `plug` onto `socket`: **origins together, axes opposed**.
 *
 * Opposed rather than aligned because both axes point *out* of their own patch, so joining means
 * each one leaves through the other. That is one rotation, fixed up to a turn about the shared
 * axis, and `roll` is that turn: at 0 the two phase references coincide, so two tubes join with
 * their v = 0 seams in line.
 *
 * The rotation is genuinely a rotation and not a reflection, which is worth stating because
 * reversing one axis of a frame does invert it: the frame being matched is (−a, u, (−a)×u), whose
 * third vector is −(a×u), so *two* axes reverse and the determinant stays +1.
 */
export function matePlacement(socket: Port, plug: Port, roll = 0): Placement {
  const target = mateFrame(socket, roll);
  const rotation = rotationBetweenFrames(
    frameOf(plug.axis, plug.up),
    target,
  );
  const moved: Vec3 = [0, 0, 0];
  quatRotate(rotation, plug.origin[0], plug.origin[1], plug.origin[2], moved);
  return {
    rotation,
    translation: [
      socket.origin[0] - moved[0],
      socket.origin[1] - moved[1],
      socket.origin[2] - moved[2],
    ],
  };
}

/** The frame a plug must land in: the socket's, reversed, and rolled about the socket's axis. */
function mateFrame(socket: Port, roll: number): readonly [Vec3, Vec3, Vec3] {
  const axis: Vec3 = [-socket.axis[0], -socket.axis[1], -socket.axis[2]];
  const rolled: Vec3 = [0, 0, 0];
  quatRotate(
    quatFromAxisAngle(socket.axis, roll),
    socket.up[0],
    socket.up[1],
    socket.up[2],
    rolled,
  );
  const up = normalized(rejected(rolled, axis)) ?? anyPerpendicular(axis);
  return frameOf(axis, up);
}

/** An orthonormal right-handed frame from an axis and a perpendicular reference. */
function frameOf(axis: Vec3, up: Vec3): readonly [Vec3, Vec3, Vec3] {
  const e1 = normalized(axis) ?? [0, 0, 1];
  const e2 = normalized(rejected(up, e1)) ?? anyPerpendicular(e1);
  return [e1, e2, cross(e1, e2)];
}

/**
 * The rotation carrying one orthonormal frame onto another: `R = B · Aᵀ`.
 *
 * Converted to a quaternion through the largest-diagonal branch of Shepperd's method, which is
 * what keeps it stable when the rotation is near π and the naive trace formula divides by nearly
 * zero.
 */
function rotationBetweenFrames(
  from: readonly [Vec3, Vec3, Vec3],
  to: readonly [Vec3, Vec3, Vec3],
): Quat {
  // R[j][k] = Σᵢ to[i][j] · from[i][k]
  const m = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      for (let k = 0; k < 3; k++) {
        m[j * 3 + k] = m[j * 3 + k]! + to[i]![j]! * from[i]![k]!;
      }
    }
  }
  return quatFromRotationMatrix(m);
}

/** Row-major 3×3 rotation matrix to a unit quaternion. */
export function quatFromRotationMatrix(m: readonly number[]): Quat {
  const [m00, m01, m02, m10, m11, m12, m20, m21, m22] = m as [
    number, number, number, number, number, number, number, number, number,
  ];
  const trace = m00 + m11 + m22;
  let x = 0;
  let y = 0;
  let z = 0;
  let w = 1;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    w = s / 4;
    x = (m21 - m12) / s;
    y = (m02 - m20) / s;
    z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    w = (m21 - m12) / s;
    x = s / 4;
    y = (m01 + m10) / s;
    z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    w = (m02 - m20) / s;
    x = (m01 + m10) / s;
    y = s / 4;
    z = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    w = (m10 - m01) / s;
    x = (m02 + m20) / s;
    y = (m12 + m21) / s;
    z = s / 4;
  }
  const length = Math.hypot(x, y, z, w);
  if (!(length > 0)) return QUAT_IDENTITY;
  return [x / length, y / length, z / length, w / length];
}

/**
 * Whether two ports can be joined, and by how much they disagree.
 *
 * Kind must match — a rim and an edge are not the same thing to join — and the sizes are compared
 * relatively, because a 2% mismatch on a rim of radius 3 is a visible step while the same absolute
 * gap on a rim of radius 300 is nothing.
 */
export function portMismatch(a: Port, b: Port): { compatible: boolean; relative: number } {
  if (a.kind !== b.kind) return { compatible: false, relative: Infinity };
  const scale = Math.max(a.size, b.size);
  const relative = scale > 0 ? Math.abs(a.size - b.size) / scale : 0;
  return { compatible: true, relative };
}
