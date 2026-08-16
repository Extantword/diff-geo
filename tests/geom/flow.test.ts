import { describe, expect, it } from "vitest";
import { buildSurface, CATALOG_BY_ID, paramsWith } from "../../src/core/catalog/surfaces.ts";
import { createFlow, FLOW_TRAIL, type FieldAt } from "../../src/core/geom/flow.ts";
import type { Vec3 } from "../../src/core/geom/types.ts";

/**
 * The flow of a field on a surface, against what the field says it should do.
 *
 * Everything here is analytic ground truth rather than a snapshot: the sphere's rotation field is
 * ∂/∂v, so its flow must hold u fixed and advance v at a rate the metric fixes exactly; a field
 * with no tangential part cannot move a particle at all; and a flow must never leave the surface,
 * which is the whole reason the ODE is integrated in the chart rather than in R³.
 */

const close = (a: number, b: number, tol = 1e-9) =>
  expect(Math.abs(a - b), `${a} vs ${b}`).toBeLessThan(tol);

/** The unit sphere, off both poles, with a field written in ambient components. */
function sphereFlow(field: FieldAt, timeScale = 1) {
  const built = buildSurface(CATALOG_BY_ID["sphere"]!);
  const params = paramsWith(built.spec, { R: 1 });
  return createFlow(built.surface, params, field, { timeScale, periodicV: true });
}

/** ∂/∂v of the unit sphere: (−sin u sin v, sin u cos v, 0), the rotation about the axis. */
const rotation: FieldAt = (u, v, out) => {
  out[0] = -Math.sin(u) * Math.sin(v);
  out[1] = Math.sin(u) * Math.cos(v);
  out[2] = 0;
};

describe("the chart velocity of a field", () => {
  it("reproduces a coordinate field exactly", () => {
    /**
     * `[E F; F G](u̇, v̇)ᵀ = (⟨V,X_u⟩, ⟨V,X_v⟩)ᵀ`. Handed X_v itself, the only solution is
     * (0, 1) — so a field written as a patch's own coordinate field flows along its coordinate
     * curves at unit parameter rate, which is what makes ∂/∂v mean what it says.
     */
    const flow = sphereFlow(rotation);
    const out: [number, number] = [0, 0];
    for (const [u, v] of [[1, 0], [2.5, 3], [0.4, 5.5]] as const) {
      expect(flow.velocity(u, v, out)).toBe(true);
      close(out[0], 0);
      close(out[1], 1);
    }
  });

  it("takes the tangential part of a field that leans off the surface", () => {
    /**
     * `(0, 0, 1)` on the unit sphere: ⟨V, X_u⟩ = −sin u and ⟨V, X_v⟩ = 0, with E = 1 and
     * G = sin²u, so u̇ = −sin u and v̇ = 0 — the projection climbs the meridians toward the north
     * pole. Drawn as a field it is reported as untangent; flowed, it flows along the part of it
     * that is tangent, which is the honest reading rather than a refusal.
     */
    const flow = sphereFlow((_u, _v, out) => {
      out[0] = 0;
      out[1] = 0;
      out[2] = 1;
    });
    const out: [number, number] = [0, 0];
    for (const u of [0.5, 1.2, 2.7]) {
      expect(flow.velocity(u, 1.3, out)).toBe(true);
      close(out[0], -Math.sin(u));
      close(out[1], 0);
    }
  });

  it("has no answer where the field is not finite", () => {
    const flow = sphereFlow((u, _v, out) => {
      out[0] = Math.log(u - 10);
      out[1] = 0;
      out[2] = 0;
    });
    expect(flow.velocity(1, 1, [0, 0])).toBe(false);
  });

  it("has no answer at a pole, where there is no tangent plane", () => {
    const flow = sphereFlow(rotation);
    // The sphere's chart collapses at u = 0: X_u × X_v vanishes, so no field has a chart
    // representation there and a particle reaching it is reseeded rather than stepped to NaN.
    expect(flow.velocity(0, 1, [0, 0])).toBe(false);
  });
});

describe("advancing a flow", () => {
  it("carries a particle along the coordinate curve, at the rate the field sets", () => {
    const flow = sphereFlow(rotation);
    const state = flow.seed(1, 7);
    const u0 = state.chart[0]!;
    const v0 = state.chart[1]!;

    // Short steps, and few enough that the particle's lifetime cannot expire underneath us.
    for (let i = 0; i < 20; i++) flow.advance(state, 0.01);

    // ∂/∂v holds u fixed exactly — the flow of a coordinate field IS the coordinate curve.
    close(state.chart[0]!, u0, 1e-9);
    // and advances v at unit rate: 20 steps of 0.01 is 0.2 of the parameter.
    close(state.chart[1]!, v0 + 0.2, 1e-7);
  });

  it("obeys the tempo it is given", () => {
    const fast = sphereFlow(rotation, 3);
    const state = fast.seed(1, 7);
    const v0 = state.chart[1]!;
    for (let i = 0; i < 10; i++) fast.advance(state, 0.01);
    // Three times the time scale is three times the parameter, and nothing else changes.
    close(state.chart[1]!, v0 + 0.3, 1e-7);
  });

  it("keeps every particle on the surface", () => {
    /**
     * The reason the ODE is in the chart. Stepping `p ← p + V dt` in R³ leaves a sphere at once —
     * the field is tangent at p and pointing into empty space a millimetre later — so the swarm
     * would spiral off and the picture would be of nothing.
     */
    const flow = sphereFlow(rotation);
    const state = flow.seed(40, 3);
    for (let i = 0; i < 90; i++) flow.advance(state, 1 / 60);
    for (let i = 0; i < state.count; i++) {
      for (let s = 0; s < (state.filled[i] ?? 0); s++) {
        const base = i * FLOW_TRAIL * 3 + s * 3;
        const radius = Math.hypot(state.point[base]!, state.point[base + 1]!, state.point[base + 2]!);
        close(radius, 1, 1e-9);
      }
    }
  });

  it("does not move a particle when the field has no tangential part", () => {
    // A field along the normal is zero as a field on the surface: the flow it generates is the
    // identity, and the particles must sit exactly still rather than drift on rounding.
    const flow = sphereFlow((u, v, out: Vec3) => {
      out[0] = Math.sin(u) * Math.cos(v);
      out[1] = Math.sin(u) * Math.sin(v);
      out[2] = Math.cos(u);
    });
    const state = flow.seed(1, 11);
    const u0 = state.chart[0]!;
    const v0 = state.chart[1]!;
    for (let i = 0; i < 10; i++) flow.advance(state, 0.02);
    close(state.chart[0]!, u0, 1e-12);
    close(state.chart[1]!, v0, 1e-12);
  });

  it("wraps at a seam and starts the streak again there", () => {
    /**
     * A seam is not an edge: v = 2π is where the sphere closes up, so a particle crossing it has
     * gone round. It comes back at v = 0 — and its streak begins again, because a trail drawn
     * across the wrap would be a straight line through the middle of the chart, which is not
     * where the particle went.
     */
    const flow = sphereFlow(rotation, 40);
    const state = flow.seed(6, 5);
    let wrapped = false;
    for (let i = 0; i < 240 && !wrapped; i++) {
      const before = [...state.chart];
      flow.advance(state, 1 / 60);
      for (let k = 0; k < state.count; k++) {
        if (state.chart[k * 2 + 1]! < before[k * 2 + 1]! - Math.PI) {
          wrapped = true;
          expect(state.filled[k]).toBe(1);
        }
      }
    }
    expect(wrapped, "no particle crossed the seam").toBe(true);
    // And every particle is still inside the domain it was given.
    for (let k = 0; k < state.count; k++) {
      expect(state.chart[k * 2 + 1]!).toBeGreaterThanOrEqual(0);
      expect(state.chart[k * 2 + 1]!).toBeLessThanOrEqual(2 * Math.PI);
    }
  });

  it("reseeds a particle that runs off a boundary that is a wall", () => {
    // The u direction of a sphere does not close up, so a flow along the meridians reaches the
    // end of the domain and stops being anywhere. It is replaced rather than clamped, or every
    // particle would end up parked on the border.
    const built = buildSurface(CATALOG_BY_ID["sphere"]!);
    const flow = createFlow(built.surface, paramsWith(built.spec, { R: 1 }), (u, v, out) => {
      out[0] = Math.cos(u) * Math.cos(v);
      out[1] = Math.cos(u) * Math.sin(v);
      out[2] = -Math.sin(u);
    }, { timeScale: 30 });
    const state = flow.seed(24, 2);
    for (let i = 0; i < 120; i++) flow.advance(state, 1 / 60);
    for (let k = 0; k < state.count; k++) {
      expect(state.chart[k * 2]!).toBeGreaterThanOrEqual(built.surface.u.min);
      expect(state.chart[k * 2]!).toBeLessThanOrEqual(built.surface.u.max);
    }
  });

  it("spreads the particles over the surface, not over its chart", () => {
    /**
     * Uniform in (u, v) is not uniform on the sphere: the chart crowds its poles, so a swarm
     * scattered evenly in the rectangle comes out as two dense knots and a sparse equator — a
     * picture of the parametrization rather than of the field. Seeding is rejection-sampled
     * against the area element, so the count in each latitude band follows ∫sin u du, which is
     * what "evenly spread over the sphere" means.
     */
    const flow = sphereFlow(rotation);
    const state = flow.seed(4000, 1);

    const bands = new Array(6).fill(0) as number[];
    for (let i = 0; i < state.count; i++) {
      const u = state.chart[i * 2]!;
      bands[Math.min(5, Math.floor((u / Math.PI) * 6))]! += 1;
    }
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI;
      const b = ((k + 1) / 6) * Math.PI;
      const expected = ((Math.cos(a) - Math.cos(b)) / 2) * state.count;
      // Within 15%: this is a sampled distribution, and the claim is the shape of it — the polar
      // bands hold a quarter of what the equatorial ones do, rather than the same number.
      expect(Math.abs(bands[k]! - expected), `band ${k}: ${bands[k]} vs ${expected}`).toBeLessThan(
        0.15 * state.count / 6 + 0.15 * expected,
      );
    }
  });

  it("replays exactly from the same seed", () => {
    // The PRNG state lives in the flow state, so a figure in the eventual book is reproducible:
    // same seed, same swarm, same picture.
    const flow = sphereFlow(rotation);
    const a = flow.seed(12, 42);
    const b = flow.seed(12, 42);
    for (let i = 0; i < 30; i++) {
      flow.advance(a, 1 / 60);
      flow.advance(b, 1 / 60);
    }
    expect([...a.chart]).toEqual([...b.chart]);
    expect([...a.filled]).toEqual([...b.filled]);
  });

  it("grows a streak, and never past its length", () => {
    const flow = sphereFlow(rotation);
    const state = flow.seed(8, 9);
    for (let i = 0; i < state.count; i++) expect(state.filled[i]).toBe(1);
    for (let i = 0; i < 3; i++) flow.advance(state, 1 / 60);
    expect(Math.max(...state.filled)).toBe(4);
    for (let i = 0; i < 60; i++) flow.advance(state, 1 / 60);
    expect(Math.max(...state.filled)).toBe(FLOW_TRAIL);
  });

  it("does nothing on a zero or negative step", () => {
    const flow = sphereFlow(rotation);
    const state = flow.seed(4, 1);
    const before = [...state.chart];
    flow.advance(state, 0);
    flow.advance(state, -1);
    expect([...state.chart]).toEqual(before);
  });
});
