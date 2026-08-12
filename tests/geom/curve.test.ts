import { describe, expect, it } from "vitest";
import {
  buildSpaceCurve,
  CURVE_BY_ID,
  curveParamsWith,
} from "../../src/core/catalog/curves.ts";
import {
  bishopFrames,
  createPlaneCurve,
  makeFrenetFrame,
  makePlaneFrenet,
} from "../../src/core/geom/curve.ts";
import { buildDiffMap } from "../../src/core/jets/compile.ts";
import { parse } from "../../src/core/expr/parse.ts";
import { interval, type Vec3 } from "../../src/core/geom/types.ts";

const closeRel = (a: number, b: number, rel = 1e-9) =>
  expect(Math.abs(a - b)).toBeLessThan(rel * Math.max(1, Math.abs(a), Math.abs(b)));

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const NO_PARAMS = new Float64Array(0);

describe("helix", () => {
  it("has constant κ = a/(a²+b²) and τ = b/(a²+b²)", () => {
    for (const [a, b] of [
      [1, 0.3],
      [0.5, 1],
      [2, -0.7],
    ]) {
      const spec = CURVE_BY_ID["helix"]!;
      const curve = buildSpaceCurve(spec);
      const params = curveParamsWith(spec, { a: a!, b: b! });
      const frame = makeFrenetFrame();
      const denominator = a! * a! + b! * b!;

      for (const t of [-4, -1.1, 0, 2.3, 5.7]) {
        curve.frenet(t, params, frame);
        expect(frame.status).toBe("regular");
        closeRel(frame.kappa, Math.abs(a!) / denominator, 1e-9);
        expect(frame.tauValid).toBe(true);
        closeRel(frame.tau, b! / denominator, 1e-9);
      }
    }
  });

  it("has an orthonormal Frenet trihedron with B = T × N", () => {
    const spec = CURVE_BY_ID["helix"]!;
    const curve = buildSpaceCurve(spec);
    const params = curveParamsWith(spec, {});
    const frame = makeFrenetFrame();

    for (const t of [-2.2, 0.4, 3.9]) {
      curve.frenet(t, params, frame);
      closeRel(Math.hypot(...frame.T), 1, 1e-9);
      closeRel(Math.hypot(...frame.N), 1, 1e-9);
      closeRel(Math.hypot(...frame.B), 1, 1e-9);
      expect(Math.abs(dot(frame.T, frame.N))).toBeLessThan(1e-9);
      expect(Math.abs(dot(frame.N, frame.B))).toBeLessThan(1e-9);
      expect(Math.abs(dot(frame.B, frame.T))).toBeLessThan(1e-9);
      // Right-handed: T × N = B.
      const cross: Vec3 = [
        frame.T[1] * frame.N[2] - frame.T[2] * frame.N[1],
        frame.T[2] * frame.N[0] - frame.T[0] * frame.N[2],
        frame.T[0] * frame.N[1] - frame.T[1] * frame.N[0],
      ];
      closeRel(dot(cross, frame.B), 1, 1e-9);
    }
  });
});

describe("circle", () => {
  it("has κ = 1/a and τ = 0", () => {
    for (const a of [0.4, 1, 1.9]) {
      const spec = CURVE_BY_ID["circle"]!;
      const curve = buildSpaceCurve(spec);
      const params = curveParamsWith(spec, { a });
      const frame = makeFrenetFrame();
      for (const t of [0.3, 2.1, 4.8]) {
        curve.frenet(t, params, frame);
        closeRel(frame.kappa, 1 / a, 1e-9);
        expect(Math.abs(frame.tau)).toBeLessThan(1e-9);
      }
    }
  });
});

describe("degeneracies produce policy, not NaN", () => {
  it("marks a straight line as an inflection with κ = 0 and no normal", () => {
    const curve = buildSpaceCurve(CURVE_BY_ID["line"]!);
    const frame = makeFrenetFrame();
    for (const t of [-1, 0, 0.7]) {
      curve.frenet(t, NO_PARAMS, frame);
      expect(frame.status).toBe("inflection");
      expect(Math.abs(frame.kappa)).toBeLessThan(1e-12);
      // τ is not merely unknown, it is meaningless — and must not be NaN.
      expect(frame.tauValid).toBe(false);
      expect(Number.isFinite(frame.tau)).toBe(true);
      // The tangent is still perfectly well defined.
      closeRel(Math.hypot(...frame.T), 1, 1e-9);
      // N and B are refused rather than invented.
      expect(Math.hypot(...frame.N)).toBe(0);
      expect(Math.hypot(...frame.B)).toBe(0);
    }
  });

  it("marks the origin of a cusp as singular without NaN", () => {
    const curve = buildSpaceCurve(CURVE_BY_ID["cusp"]!);
    const frame = makeFrenetFrame();
    curve.frenet(0, NO_PARAMS, frame);
    expect(frame.status).toBe("singular");
    expect(frame.speed).toBe(0);
    // The limiting tangent from α″ is still usable, so a rendered tube does not twist.
    closeRel(Math.hypot(...frame.T), 1, 1e-9);
    for (const value of [...frame.T, ...frame.p]) {
      expect(Number.isFinite(value)).toBe(true);
    }
  });

  it("is regular away from the cusp", () => {
    const curve = buildSpaceCurve(CURVE_BY_ID["cusp"]!);
    const frame = makeFrenetFrame();
    curve.frenet(0.8, NO_PARAMS, frame);
    expect(frame.status).toBe("regular");
    expect(frame.kappa).toBeGreaterThan(0);
  });

  it("gives κ = 2 and τ = 3 at the origin of the twisted cubic", () => {
    // (t, t², t³) is regular and non-degenerate at t = 0 — worth stating because it is
    // often described loosely as having an inflection there, and it does not: α′ and α″
    // are (1,0,0) and (0,2,0), which are orthogonal, not parallel.
    //
    // α′ × α″ = (0,0,2), so κ = |(0,0,2)|/|α′|³ = 2, and with α‴ = (0,0,6),
    // τ = ⟨(0,0,2),(0,0,6)⟩ / |(0,0,2)|² = 12/4 = 3.
    const curve = buildSpaceCurve(CURVE_BY_ID["twisted-cubic"]!);
    const frame = makeFrenetFrame();
    curve.frenet(0, NO_PARAMS, frame);
    expect(frame.status).toBe("regular");
    closeRel(frame.kappa, 2, 1e-9);
    closeRel(frame.tau, 3, 1e-9);
  });

  it("never emits a non-finite value for any catalog curve", () => {
    for (const spec of Object.values(CURVE_BY_ID)) {
      if (spec.components.length !== 3) continue;
      const curve = buildSpaceCurve(spec);
      const params = curveParamsWith(spec, {});
      const frame = makeFrenetFrame();
      for (let i = 0; i <= 60; i++) {
        const t = spec.t.min + ((spec.t.max - spec.t.min) * i) / 60;
        curve.frenet(t, params, frame);
        for (const value of [...frame.p, ...frame.T, ...frame.N, ...frame.B, frame.tau]) {
          expect(Number.isFinite(value), `${spec.id} at t=${t}`).toBe(true);
        }
        // κ may be NaN at a singular point, but only there, and it is flagged.
        if (frame.status !== "singular") expect(Number.isFinite(frame.kappa)).toBe(true);
      }
    }
  });
});

describe("Bishop frame", () => {
  it("stays orthonormal along a helix", () => {
    const spec = CURVE_BY_ID["helix"]!;
    const curve = buildSpaceCurve(spec);
    const frames = bishopFrames(curve, curveParamsWith(spec, {}), 200);

    for (let i = 0; i < frames.count; i++) {
      const T: Vec3 = [
        frames.tangents[i * 3]!,
        frames.tangents[i * 3 + 1]!,
        frames.tangents[i * 3 + 2]!,
      ];
      const U: Vec3 = [
        frames.normals[i * 3]!,
        frames.normals[i * 3 + 1]!,
        frames.normals[i * 3 + 2]!,
      ];
      const V: Vec3 = [
        frames.binormals[i * 3]!,
        frames.binormals[i * 3 + 1]!,
        frames.binormals[i * 3 + 2]!,
      ];
      closeRel(Math.hypot(...U), 1, 1e-8);
      closeRel(Math.hypot(...V), 1, 1e-8);
      expect(Math.abs(dot(T, U))).toBeLessThan(1e-8);
      expect(Math.abs(dot(U, V))).toBeLessThan(1e-8);
    }
  });

  it("is continuous where the Frenet frame is not", () => {
    // A straight line has no Frenet normal at all, yet the Bishop frame must still be
    // defined and vary smoothly — which is exactly why it is the frame we render with.
    const curve = buildSpaceCurve(CURVE_BY_ID["line"]!);
    const frames = bishopFrames(curve, NO_PARAMS, 50);

    for (let i = 1; i < frames.count; i++) {
      const previous: Vec3 = [
        frames.normals[(i - 1) * 3]!,
        frames.normals[(i - 1) * 3 + 1]!,
        frames.normals[(i - 1) * 3 + 2]!,
      ];
      const current: Vec3 = [
        frames.normals[i * 3]!,
        frames.normals[i * 3 + 1]!,
        frames.normals[i * 3 + 2]!,
      ];
      closeRel(Math.hypot(...current), 1, 1e-8);
      // Consecutive normals barely rotate: that is the rotation-minimizing property.
      expect(dot(previous, current)).toBeGreaterThan(0.999);
    }
  });

  it("accumulates arc length monotonically", () => {
    const spec = CURVE_BY_ID["helix"]!;
    const curve = buildSpaceCurve(spec);
    const frames = bishopFrames(curve, curveParamsWith(spec, { a: 1, b: 0.3 }), 400);
    expect(frames.arcLength[0]).toBe(0);
    for (let i = 1; i < frames.count; i++) {
      expect(frames.arcLength[i]!).toBeGreaterThanOrEqual(frames.arcLength[i - 1]!);
    }
    // A helix of radius a and pitch b over t ∈ [−3π, 3π] has length 6π√(a²+b²).
    const expected = 6 * Math.PI * Math.hypot(1, 0.3);
    closeRel(frames.arcLength[frames.count - 1]!, expected, 1e-4);
  });

  it("flags singular samples so the line renderer can break the polyline", () => {
    const curve = buildSpaceCurve(CURVE_BY_ID["cusp"]!);
    // An even sample count puts a sample exactly at t = 0, the cusp.
    const frames = bishopFrames(curve, NO_PARAMS, 60);
    let invalid = 0;
    for (let i = 0; i < frames.count; i++) if (!frames.valid[i]) invalid++;
    expect(invalid).toBeGreaterThan(0);
    for (const value of frames.normals) expect(Number.isFinite(value)).toBe(true);
  });
});

describe("plane curves carry signed curvature", () => {
  function planeCurveOf(x: string, y: string) {
    const comps = [parse(x).expr!, parse(y).expr!];
    const map = buildDiffMap({ id: "test", comps, vars: ["t"], order: 2 });
    return createPlaneCurve({ id: "test", map, t: interval(-2, 2) });
  }

  it("gives k = 1/a for a counter-clockwise circle and −1/a for clockwise", () => {
    // The sign is the whole point: it distinguishes the two orientations, which a
    // magnitude-only curvature cannot.
    const ccw = planeCurveOf("cos t", "sin t");
    const cw = planeCurveOf("cos t", "-sin t");
    const frame = makePlaneFrenet();

    ccw.frenet(0.6, NO_PARAMS, frame);
    closeRel(frame.k, 1, 1e-9);
    cw.frenet(0.6, NO_PARAMS, frame);
    closeRel(frame.k, -1, 1e-9);
  });

  it("changes sign through an inflection", () => {
    // (t, t³) has k(0) = 0 with opposite signs on either side — the fact that makes the
    // four-vertex theorem and the rotation index statable at all.
    const curve = planeCurveOf("t", "t^3");
    const frame = makePlaneFrenet();

    curve.frenet(-0.5, NO_PARAMS, frame);
    const before = frame.k;
    curve.frenet(0, NO_PARAMS, frame);
    const at = frame.k;
    curve.frenet(0.5, NO_PARAMS, frame);
    const after = frame.k;

    expect(Math.abs(at)).toBeLessThan(1e-12);
    expect(before * after).toBeLessThan(0);
  });

  it("has N as the quarter turn of T", () => {
    const curve = planeCurveOf("cos t", "sin t");
    const frame = makePlaneFrenet();
    curve.frenet(1.1, NO_PARAMS, frame);
    closeRel(Math.hypot(frame.T[0], frame.T[1]), 1, 1e-9);
    closeRel(frame.N[0], -frame.T[1], 1e-12);
    closeRel(frame.N[1], frame.T[0], 1e-12);
  });

  it("reports a cusp as singular rather than dividing by zero", () => {
    const curve = planeCurveOf("t^2", "t^3");
    const frame = makePlaneFrenet();
    curve.frenet(0, NO_PARAMS, frame);
    expect(frame.status).toBe("singular");
    expect(Number.isFinite(frame.p[0])).toBe(true);
  });
});
