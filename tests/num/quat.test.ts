import { describe, expect, it } from "vitest";
import {
  QUAT_IDENTITY,
  isIdentity,
  quatFromAxisAngle,
  quatMultiply,
  quatRotate,
} from "../../src/core/num/quat.ts";
import type { Vec3 } from "../../src/core/geom/types.ts";

const rotate = (q: Parameters<typeof quatRotate>[0], v: Vec3): Vec3 =>
  quatRotate(q, v[0], v[1], v[2], [0, 0, 0]);

describe("unit quaternions", () => {
  it("turns a quarter circle about each axis", () => {
    const quarter = Math.PI / 2;
    expect(rotate(quatFromAxisAngle([0, 0, 1], quarter), [1, 0, 0])[1]).toBeCloseTo(1, 12);
    expect(rotate(quatFromAxisAngle([1, 0, 0], quarter), [0, 1, 0])[2]).toBeCloseTo(1, 12);
    expect(rotate(quatFromAxisAngle([0, 1, 0], quarter), [0, 0, 1])[0]).toBeCloseTo(1, 12);
  });

  it("preserves length and angle, which is why curvature survives it", () => {
    /**
     * The property the whole arrangement design rests on. A rotation is an isometry, so every
     * derivative of X keeps its length and every pair keeps its angle — and K, H and the
     * principal curvatures are built from exactly those.
     */
    const q = quatMultiply(
      quatFromAxisAngle([1, 2, -3], 0.7),
      quatFromAxisAngle([0.3, -1, 0.2], -1.9),
    );
    const a: Vec3 = [1.5, -0.5, 2];
    const b: Vec3 = [-0.25, 3, 0.75];
    const ra = rotate(q, a);
    const rb = rotate(q, b);
    const dot = (u: Vec3, v: Vec3) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
    expect(Math.hypot(...ra)).toBeCloseTo(Math.hypot(...a), 12);
    expect(Math.hypot(...rb)).toBeCloseTo(Math.hypot(...b), 12);
    expect(dot(ra, rb)).toBeCloseTo(dot(a, b), 12);
  });

  it("stays a rotation through thousands of compositions", () => {
    /**
     * A drag composes one of these per pointer move, so the rounding error compounds. Without
     * renormalising, the quaternion drifts off the unit sphere and the object visibly swells or
     * shrinks as it turns — a bug that only appears after a long drag, which is the worst kind.
     */
    let q = QUAT_IDENTITY;
    for (let i = 0; i < 5000; i++) {
      q = quatMultiply(quatFromAxisAngle([Math.sin(i), Math.cos(i), 0.5], 0.01), q);
    }
    expect(Math.hypot(...q)).toBeCloseTo(1, 10);
    // And a vector it rotates keeps its length, which is what that guarantees in practice.
    expect(Math.hypot(...rotate(q, [3, 0, 4]))).toBeCloseTo(5, 8);
  });

  it("treats a degenerate axis as no rotation rather than as NaN", () => {
    // A drag that has not moved yet produces a zero axis; poisoning the transform with NaN would
    // make the object vanish rather than simply not turn.
    expect(quatFromAxisAngle([0, 0, 0], 1)).toEqual(QUAT_IDENTITY);
    expect(isIdentity(quatFromAxisAngle([0, 0, 0], 1))).toBe(true);
  });

  it("composes left-to-right as 'then'", () => {
    // Two quarter turns about z make a half turn, whichever way the pair is read here.
    const quarter = quatFromAxisAngle([0, 0, 1], Math.PI / 2);
    const half = quatMultiply(quarter, quarter);
    const turned = rotate(half, [1, 0, 0]);
    expect(turned[0]).toBeCloseTo(-1, 12);
    expect(turned[1]).toBeCloseTo(0, 12);
  });
});
