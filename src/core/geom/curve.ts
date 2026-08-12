import type { DiffMap } from "../jets/compile.ts";
import { curveJetOffsets, readVec3, type CurveJetOffsets } from "../jets/jet.ts";
import type { Interval, Vec2, Vec3 } from "./types.ts";
import { sampleBounds } from "./types.ts";

/**
 * Curves in R³ and R², do Carmo Chapter 1.
 *
 * From the order-3 jet of α, for an **arbitrary** parametrization — not arc length, since
 * a user will type `(cos t, sin t, t/3)` and reparametrizing by arc length is generally
 * not possible in closed form:
 *
 *     T = α′/|α′|
 *     κ = |α′ × α″| / |α′|³
 *     B = (α′ × α″) / |α′ × α″|
 *     N = B × T
 *     τ = ⟨α′ × α″, α‴⟩ / |α′ × α″|²
 *
 * (In arc length these reduce to the Frenet equations T′ = κN, N′ = −κT + τB, B′ = −τN.)
 *
 * ## Degeneracies are designed in, not patched afterwards
 *
 * User input hits these constantly, and each has a stated policy rather than a NaN:
 *
 * | condition | meaning | policy |
 * |---|---|---|
 * | \|α′\| ≈ 0 | cusp, e.g. (t², t³) at 0 | `singular`; the sample is invalid and the line renderer breaks the polyline |
 * | \|α′ × α″\| ≈ 0 | inflection, or a straight segment | `inflection`; κ reported honestly as ≈0, τ marked invalid, **N and B not drawn** |
 * | κ small but nonzero | τ's denominator is \|α′ × α″\|² | τ is ill-conditioned; `tauValid` is false so the readout hides it rather than showing noise |
 *
 * ## Two frames, two jobs
 *
 * Frenet's N and B are genuinely discontinuous at an inflection — that is a fact about
 * the curve, not a defect to smooth over. So:
 *
 *  - **Frenet is what we display**: κ, τ, and the N/B glyphs, shown only where regular.
 *  - **Bishop is what we render with**: a rotation-minimizing frame, computed along the
 *    whole polyline by double reflection. Always defined, always continuous, and needed
 *    anyway for drawing a curve as a tube or ribbon.
 *
 * Blending the two — falling back to Bishop and calling it N — would fake the continuity
 * of an object that genuinely lacks it. Keeping the roles separate is the honest design.
 */

/** Below this, |α′| counts as zero and the parametrization is singular. */
const SPEED_EPS = 1e-9;
/** Below this (relative), κ counts as zero and N, B are undefined. */
const CURVATURE_EPS = 1e-9;
/** τ needs κ comfortably above the noise floor to mean anything. */
const TORSION_GUARD = 10;

export type FrenetStatus = "regular" | "inflection" | "singular";

export interface FrenetFrame {
  p: Vec3;
  /** unit tangent; carried over from the previous sample when singular */
  T: Vec3;
  /** principal normal — meaningless unless `status === "regular"` */
  N: Vec3;
  /** binormal — meaningless unless `status === "regular"` */
  B: Vec3;
  /** |α′|, the speed of the given parametrization */
  speed: number;
  kappa: number;
  /** 0, never NaN, when κ is too small; see `tauValid` */
  tau: number;
  tauValid: boolean;
  status: FrenetStatus;
}

export function makeFrenetFrame(): FrenetFrame {
  return {
    p: [0, 0, 0],
    T: [0, 0, 0],
    N: [0, 0, 0],
    B: [0, 0, 0],
    speed: 0,
    kappa: Number.NaN,
    tau: 0,
    tauValid: false,
    status: "singular",
  };
}

export interface SpaceCurve {
  readonly id: string;
  readonly map: DiffMap;
  readonly t: Interval;
  readonly periodic: boolean;
  position(t: number, params: ArrayLike<number>, out: Vec3): void;
  frenet(t: number, params: ArrayLike<number>, out: FrenetFrame): void;
}

export interface SpaceCurveOptions {
  readonly id: string;
  /** a map R → R³ of order ≥ 3 */
  readonly map: DiffMap;
  readonly t: Interval;
  readonly periodic?: boolean;
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export function createSpaceCurve(options: SpaceCurveOptions): SpaceCurve {
  const { id, map, t: range } = options;
  const offsets: CurveJetOffsets = curveJetOffsets(map.layout);

  const jet = map.makeJet();
  const p: Vec3 = [0, 0, 0];
  const d1: Vec3 = [0, 0, 0];
  const d2: Vec3 = [0, 0, 0];
  const d3: Vec3 = [0, 0, 0];
  const cross: Vec3 = [0, 0, 0];
  const argument: [number] = [0];

  return {
    id,
    map,
    t: range,
    periodic: options.periodic ?? false,

    position(t, params, out) {
      argument[0] = t;
      map.evaluate(argument, params, jet);
      readVec3(jet, offsets.a, out);
    },

    frenet(t, params, out) {
      argument[0] = t;
      map.evaluate(argument, params, jet);
      readVec3(jet, offsets.a, p);
      readVec3(jet, offsets.a1, d1);
      readVec3(jet, offsets.a2, d2);
      readVec3(jet, offsets.a3, d3);

      out.p[0] = p[0];
      out.p[1] = p[1];
      out.p[2] = p[2];

      const finite =
        Number.isFinite(p[0] + p[1] + p[2]) && Number.isFinite(d1[0] + d1[1] + d1[2]);
      const speed = Math.hypot(d1[0], d1[1], d1[2]);
      out.speed = speed;

      if (!finite || !(speed > SPEED_EPS)) {
        // A cusp, or a formula that blew up. The limiting tangent is ±α″/|α″| when α″ is
        // available; otherwise leave T as the previous sample's, which keeps a rendered
        // tube from twisting wildly at one bad point.
        const accel = Math.hypot(d2[0], d2[1], d2[2]);
        if (finite && accel > SPEED_EPS) {
          out.T[0] = d2[0] / accel;
          out.T[1] = d2[1] / accel;
          out.T[2] = d2[2] / accel;
        }
        out.kappa = Number.NaN;
        out.tau = 0;
        out.tauValid = false;
        out.status = "singular";
        return;
      }

      out.T[0] = d1[0] / speed;
      out.T[1] = d1[1] / speed;
      out.T[2] = d1[2] / speed;

      cross[0] = d1[1] * d2[2] - d1[2] * d2[1];
      cross[1] = d1[2] * d2[0] - d1[0] * d2[2];
      cross[2] = d1[0] * d2[1] - d1[1] * d2[0];
      const crossLength = Math.hypot(cross[0], cross[1], cross[2]);

      // κ = |α′ × α″| / |α′|³
      const kappa = crossLength / (speed * speed * speed);
      out.kappa = kappa;

      if (crossLength <= CURVATURE_EPS * speed * speed) {
        // An inflection point or a straight segment: α′ and α″ are parallel, so the
        // osculating plane — and with it N and B — is undefined. Report κ ≈ 0 honestly
        // and refuse to invent a normal.
        out.N[0] = 0;
        out.N[1] = 0;
        out.N[2] = 0;
        out.B[0] = 0;
        out.B[1] = 0;
        out.B[2] = 0;
        out.tau = 0;
        out.tauValid = false;
        out.status = "inflection";
        return;
      }

      out.B[0] = cross[0] / crossLength;
      out.B[1] = cross[1] / crossLength;
      out.B[2] = cross[2] / crossLength;

      // N = B × T
      out.N[0] = out.B[1] * out.T[2] - out.B[2] * out.T[1];
      out.N[1] = out.B[2] * out.T[0] - out.B[0] * out.T[2];
      out.N[2] = out.B[0] * out.T[1] - out.B[1] * out.T[0];

      // τ = ⟨α′ × α″, α‴⟩ / |α′ × α″|²
      out.tau = dot(cross, d3) / (crossLength * crossLength);
      // The denominator is κ² up to a power of the speed, so τ is severely
      // ill-conditioned near an inflection. Better to hide it than to show noise.
      out.tauValid = kappa > TORSION_GUARD * CURVATURE_EPS;
      out.status = "regular";
    },
  };
}

// --------------------------------------------------------------------------- //
// Bishop frame — what we render with
// --------------------------------------------------------------------------- //

export interface BishopFrames {
  /** sampled points */
  readonly points: Float64Array;
  /** unit tangents, 3 per sample */
  readonly tangents: Float64Array;
  /** rotation-minimizing normals, 3 per sample */
  readonly normals: Float64Array;
  /** binormals = T × U, 3 per sample */
  readonly binormals: Float64Array;
  /** 1 where the sample is usable, 0 where the curve was singular or non-finite */
  readonly valid: Uint8Array;
  /** cumulative arc length, for dashes and arrow placement */
  readonly arcLength: Float64Array;
  readonly count: number;
}

/**
 * A rotation-minimizing frame along a sampled curve, by **double reflection**
 * (Wang et al.). Unconditionally stable, no ODE, and continuous through inflections
 * where Frenet's N and B are not.
 *
 * Each step reflects the previous frame twice: once to carry the old tangent onto the new
 * one, once to correct the residual rotation. The composition of two reflections is a
 * rotation, so the frame stays orthonormal by construction rather than by
 * renormalization.
 */
export function bishopFrames(
  curve: SpaceCurve,
  params: ArrayLike<number>,
  samples: number,
): BishopFrames {
  const [t0, t1] = sampleBounds(curve.t);
  const count = samples + 1;

  const points = new Float64Array(count * 3);
  const tangents = new Float64Array(count * 3);
  const normals = new Float64Array(count * 3);
  const binormals = new Float64Array(count * 3);
  const valid = new Uint8Array(count);
  const arcLength = new Float64Array(count);

  const frame = makeFrenetFrame();

  for (let i = 0; i < count; i++) {
    const t = t0 + ((t1 - t0) * i) / samples;
    curve.frenet(t, params, frame);
    const usable =
      frame.status !== "singular" &&
      Number.isFinite(frame.p[0] + frame.p[1] + frame.p[2]);
    valid[i] = usable ? 1 : 0;
    points[i * 3] = frame.p[0];
    points[i * 3 + 1] = frame.p[1];
    points[i * 3 + 2] = frame.p[2];
    tangents[i * 3] = frame.T[0];
    tangents[i * 3 + 1] = frame.T[1];
    tangents[i * 3 + 2] = frame.T[2];
  }

  for (let i = 1; i < count; i++) {
    const dx = points[i * 3]! - points[(i - 1) * 3]!;
    const dy = points[i * 3 + 1]! - points[(i - 1) * 3 + 1]!;
    const dz = points[i * 3 + 2]! - points[(i - 1) * 3 + 2]!;
    const step = Math.hypot(dx, dy, dz);
    arcLength[i] = arcLength[i - 1]! + (Number.isFinite(step) ? step : 0);
  }

  // Seed with any unit vector not parallel to the first tangent.
  let ux = 0;
  let uy = 0;
  let uz = 0;
  {
    const tx = tangents[0]!;
    const ty = tangents[1]!;
    const tz = tangents[2]!;
    // Cross with the axis the tangent leans on least — the standard robust choice.
    const ax = Math.abs(tx);
    const ay = Math.abs(ty);
    const az = Math.abs(tz);
    const axis: Vec3 = ax <= ay && ax <= az ? [1, 0, 0] : ay <= az ? [0, 1, 0] : [0, 0, 1];
    ux = axis[1] * tz - axis[2] * ty;
    uy = axis[2] * tx - axis[0] * tz;
    uz = axis[0] * ty - axis[1] * tx;
    const length = Math.hypot(ux, uy, uz) || 1;
    ux /= length;
    uy /= length;
    uz /= length;
  }

  const setFrame = (i: number) => {
    normals[i * 3] = ux;
    normals[i * 3 + 1] = uy;
    normals[i * 3 + 2] = uz;
    const tx = tangents[i * 3]!;
    const ty = tangents[i * 3 + 1]!;
    const tz = tangents[i * 3 + 2]!;
    binormals[i * 3] = ty * uz - tz * uy;
    binormals[i * 3 + 1] = tz * ux - tx * uz;
    binormals[i * 3 + 2] = tx * uy - ty * ux;
  };

  setFrame(0);

  for (let i = 1; i < count; i++) {
    const t0x = tangents[(i - 1) * 3]!;
    const t0y = tangents[(i - 1) * 3 + 1]!;
    const t0z = tangents[(i - 1) * 3 + 2]!;
    const t1x = tangents[i * 3]!;
    const t1y = tangents[i * 3 + 1]!;
    const t1z = tangents[i * 3 + 2]!;

    // First reflection: in the plane bisecting the two sample points, which maps the
    // previous tangent toward the new one.
    let r1x = points[i * 3]! - points[(i - 1) * 3]!;
    let r1y = points[i * 3 + 1]! - points[(i - 1) * 3 + 1]!;
    let r1z = points[i * 3 + 2]! - points[(i - 1) * 3 + 2]!;
    const c1 = r1x * r1x + r1y * r1y + r1z * r1z;

    if (!(c1 > 0) || !Number.isFinite(c1)) {
      // Coincident or non-finite samples: carry the frame unchanged.
      setFrame(i);
      continue;
    }

    const d1 = (2 / c1) * (r1x * ux + r1y * uy + r1z * uz);
    const uLx = ux - d1 * r1x;
    const uLy = uy - d1 * r1y;
    const uLz = uz - d1 * r1z;

    const e1 = (2 / c1) * (r1x * t0x + r1y * t0y + r1z * t0z);
    const tLx = t0x - e1 * r1x;
    const tLy = t0y - e1 * r1y;
    const tLz = t0z - e1 * r1z;

    // Second reflection: corrects the reflected tangent onto the actual new tangent.
    r1x = t1x - tLx;
    r1y = t1y - tLy;
    r1z = t1z - tLz;
    const c2 = r1x * r1x + r1y * r1y + r1z * r1z;

    if (!(c2 > 0) || !Number.isFinite(c2)) {
      ux = uLx;
      uy = uLy;
      uz = uLz;
    } else {
      const d2 = (2 / c2) * (r1x * uLx + r1y * uLy + r1z * uLz);
      ux = uLx - d2 * r1x;
      uy = uLy - d2 * r1y;
      uz = uLz - d2 * r1z;
    }

    // Two reflections compose to a rotation, so the frame is orthonormal already; this
    // only cleans up accumulated rounding.
    const length = Math.hypot(ux, uy, uz);
    if (length > SPEED_EPS) {
      ux /= length;
      uy /= length;
      uz /= length;
    }
    setFrame(i);
  }

  return { points, tangents, normals, binormals, valid, arcLength, count };
}

// --------------------------------------------------------------------------- //
// plane curves
// --------------------------------------------------------------------------- //

export interface PlaneFrenet {
  p: Vec2;
  T: Vec2;
  /** N = JT, the counter-clockwise quarter turn of T */
  N: Vec2;
  /**
   * **Signed** curvature, do Carmo §1-5:
   *
   *     k = (x′y″ − y′x″) / (x′² + y′²)^{3/2}
   */
  k: number;
  speed: number;
  status: "regular" | "singular";
}

export function makePlaneFrenet(): PlaneFrenet {
  return { p: [0, 0], T: [0, 0], N: [0, 0], k: Number.NaN, speed: 0, status: "singular" };
}

export interface PlaneCurve {
  readonly id: string;
  readonly map: DiffMap;
  readonly t: Interval;
  readonly periodic: boolean;
  frenet(t: number, params: ArrayLike<number>, out: PlaneFrenet): void;
}

/**
 * Plane curves get their own type because **signed** curvature is the entire point.
 *
 * Computing the 3D κ with z = 0 would discard the sign, and the sign is what carries
 * every plane-curve result in Chapter 1: the rotation index, the four-vertex theorem,
 * convexity, evolutes and involutes. A magnitude alone makes all of them unstatable.
 */
export function createPlaneCurve(options: {
  readonly id: string;
  /** a map R → R² of order ≥ 2 */
  readonly map: DiffMap;
  readonly t: Interval;
  readonly periodic?: boolean;
}): PlaneCurve {
  const { id, map, t: range } = options;
  if (map.layout.m !== 2) {
    throw new Error(`a plane curve needs 2 components, got ${map.layout.m}`);
  }
  const jet = map.makeJet();
  const argument: [number] = [0];
  const value = map.layout.slotOf([0]) * 2;
  const first = map.layout.slotOf([1]) * 2;
  const second = map.layout.slotOf([2]) * 2;

  return {
    id,
    map,
    t: range,
    periodic: options.periodic ?? false,

    frenet(t, params, out) {
      argument[0] = t;
      map.evaluate(argument, params, jet);

      out.p[0] = jet[value]!;
      out.p[1] = jet[value + 1]!;
      const xp = jet[first]!;
      const yp = jet[first + 1]!;
      const xpp = jet[second]!;
      const ypp = jet[second + 1]!;

      const speed = Math.hypot(xp, yp);
      out.speed = speed;

      if (!Number.isFinite(speed) || !(speed > SPEED_EPS)) {
        out.k = Number.NaN;
        out.status = "singular";
        return;
      }

      out.T[0] = xp / speed;
      out.T[1] = yp / speed;
      // N = JT: rotate the tangent a quarter turn counter-clockwise, so that k > 0 means
      // the curve turns toward N.
      out.N[0] = -out.T[1];
      out.N[1] = out.T[0];
      out.k = (xp * ypp - yp * xpp) / (speed * speed * speed);
      out.status = "regular";
    },
  };
}
