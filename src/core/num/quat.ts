import type { Vec3 } from "../geom/types.ts";

/**
 * Unit quaternions, for arranging objects in space.
 *
 * Only rotation lives here — arrangement, not geometry. A rigid motion leaves every curvature
 * exactly as it was, because K, H and the principal curvatures are built from derivatives of X and
 * from angles between them, and a rotation preserves both. So this is applied to the DRAWN
 * positions and normals after the geometry is computed, never folded into the map it came from.
 *
 * ## Why quaternions rather than Euler angles
 *
 * Dragging composes many small rotations about axes that change as the camera moves. Euler angles
 * accumulate that badly: they gimbal-lock, and the order of application becomes a hidden part of
 * the state. A quaternion composes by multiplication with no preferred axis and no lock, and
 * renormalising once per composition keeps it a rotation forever — which matters when a drag can
 * apply thousands of them in sequence.
 */

/** `[x, y, z, w]`, unit length, `w` last. */
export type Quat = readonly [number, number, number, number];

export const QUAT_IDENTITY: Quat = [0, 0, 0, 1];

/**
 * A rotation of `angle` radians about `axis`, which need not be normalised.
 *
 * A zero-length axis yields the identity rather than a NaN: an interaction that produces a
 * degenerate axis — a drag that has not moved yet — should do nothing, not poison the transform.
 */
export function quatFromAxisAngle(axis: readonly [number, number, number], angle: number): Quat {
  const length = Math.hypot(axis[0], axis[1], axis[2]);
  if (!(length > 0) || !Number.isFinite(angle)) return QUAT_IDENTITY;
  const half = angle / 2;
  const s = Math.sin(half) / length;
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(half)];
}

/**
 * `a` applied after `b` — the composition that reads left to right as "then".
 *
 * Renormalised, because a drag composes thousands of these and the rounding error in each one
 * compounds: without it the quaternion slowly stops being unit length and the object visibly
 * shrinks or swells as it turns.
 */
export function quatMultiply(a: Quat, b: Quat): Quat {
  const x = a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1];
  const y = a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0];
  const z = a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3];
  const w = a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2];
  const length = Math.hypot(x, y, z, w);
  if (!(length > 0)) return QUAT_IDENTITY;
  return [x / length, y / length, z / length, w / length];
}

/**
 * Rotate a vector: `v + 2w(q × v) + 2(q × (q × v))`, with q the vector part.
 *
 * The expanded form rather than converting to a matrix first, since a drag rotates tens of
 * thousands of vertices per frame and this touches no intermediate storage.
 */
export function quatRotate(q: Quat, x: number, y: number, z: number, out: Vec3): Vec3 {
  const [qx, qy, qz, qw] = q;
  // t = 2 · (q × v)
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  out[0] = x + qw * tx + (qy * tz - qz * ty);
  out[1] = y + qw * ty + (qz * tx - qx * tz);
  out[2] = z + qw * tz + (qx * ty - qy * tx);
  return out;
}

/** Whether a quaternion is the identity, to skip work that would do nothing. */
export function isIdentity(q: Quat): boolean {
  return q[0] === 0 && q[1] === 0 && q[2] === 0 && Math.abs(q[3]) === 1;
}
