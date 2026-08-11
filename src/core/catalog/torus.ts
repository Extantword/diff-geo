import { interval, type ParametricSource, type Vec3 } from "../geom/types.ts";

/**
 * The torus of revolution, do Carmo's running example for a surface with curvature
 * of both signs (Example 2-2-5 / §3-3).
 *
 *   X(u,v) = ((R + r cos u) cos v,  r sin u,  (R + r cos u) sin v)
 *
 * with u the angle around the tube and v the angle around the axis of revolution.
 * Ground truth for the test suite:  K = cos u / (r (R + r cos u)).
 *
 * Hand-written for M0 so the render pipeline can be proven before the CAS exists.
 * From M1 this same interface is satisfied by compiled jets of a parsed formula.
 */
export function torus(R = 2, r = 0.7): ParametricSource {
  return {
    id: "torus",
    name: "Torus of revolution",
    position(u: number, v: number): Vec3 {
      const ring = R + r * Math.cos(u);
      return [ring * Math.cos(v), r * Math.sin(u), ring * Math.sin(v)];
    },
    // Regular everywhere, so no inset is needed — unlike the sphere, whose chart
    // is singular at both poles.
    u: interval(0, 2 * Math.PI),
    v: interval(0, 2 * Math.PI),
    periodicU: true,
    periodicV: true,
  };
}
