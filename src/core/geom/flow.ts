import { readVec3, surfaceJetOffsets, type SurfaceJetOffsets } from "../jets/jet.ts";
import type { ParametricSurface } from "./parametric.ts";
import { sampleBounds, type Vec3 } from "./types.ts";

/**
 * The flow of a vector field on a surface: particles carried by their own integral curves.
 *
 * A vector field is a picture you can only half read while it holds still. The arrows say where
 * each point would go; the *flow* is where it actually goes, and watching it is the difference
 * between seeing a field and seeing the one-parameter group of diffeomorphisms it generates —
 * which is what a field IS in do Carmo's §3-4 and what every argument about it uses.
 *
 * ## The integration is in the chart, always
 *
 * The field is written in ambient components, so the naive thing is to step `p ← p + V dt` in R³.
 * That leaves the surface immediately: a sphere's rotation field is tangent at p and pointing into
 * empty space a millimetre later, so the particles spiral off and the picture is of nothing. The
 * ODE therefore runs **downstairs**, in (u, v), and its right-hand side is the chart representation
 * of the field's tangential part:
 *
 *     [E F; F G] (u̇, v̇)ᵀ = (⟨V, X_u⟩, ⟨V, X_v⟩)ᵀ
 *
 * so `u̇ = (G·p − F·q)/(EG − F²)` and `v̇ = (E·q − F·p)/(EG − F²)` with p = ⟨V, X_u⟩, q = ⟨V, X_v⟩.
 * Then `X_u u̇ + X_v v̇` is exactly the orthogonal projection of V onto the tangent plane: for a
 * tangent field it reproduces V, and for one that is not it flows along the part that is — which
 * is the honest reading, and the reason a field the scene has warned about still animates instead
 * of failing.
 *
 * Reading X_u and X_v straight off the jet rather than through `surface.at` is deliberate: the
 * full surface point resolves the shape operator — an eigendecomposition — at every stage of every
 * RK4 step, and none of it is used here. Only the first fundamental form matters to a flow.
 *
 * ## Particles die and are replaced, on purpose
 *
 * Every flow with a sink has all of its particles in the sink after a few seconds, and a picture
 * that empties out says nothing about the field it came from. So each particle carries a lifetime
 * and is reseeded when it expires — staggered, so the swarm never blinks in unison — and so is any
 * particle that leaves the domain, reaches a point with no tangent plane, or stalls where V = 0.
 * The result is statistically stationary: what you see after a minute is the same picture you saw
 * after a second, which is the one that is about the field rather than about the elapsed time.
 */

/**
 * Positions kept per particle: the length of the streak each one drags behind it.
 *
 * Long enough to read as a *current* rather than as a moving dot — the streaks are what make the
 * integral curves visible while the particles are still on them — and short enough that the swarm
 * does not congeal into a static picture of the whole field, which is what the arrows already are.
 */
export const FLOW_TRAIL = 24;

/** Seconds a particle lives before being reseeded, before the per-particle stagger. */
const LIFE_MIN = 2.5;
const LIFE_MAX = 6.5;

/** RK4 stages per advance, and the chart distance past which another is taken. */
const MAX_SUBSTEPS = 6;

export interface FlowState {
  readonly count: number;
  /** where each particle is now, in the chart: 2 per particle. The ODE's state, and only that. */
  readonly chart: Float64Array;
  /**
   * The same streak downstairs: `count × FLOW_TRAIL × 2`, newest first.
   *
   * Kept because the inset draws the flow too, and the chart trail is where a flow is at its most
   * legible — the integral curves of the pulled-back field, over the domain they live on. Two
   * doubles per point beside the six already stored for its image, and it is shifted in the same
   * pass, so carrying it costs almost nothing next to evaluating the surface again downstairs.
   */
  readonly chartTrail: Float64Array;
  /**
   * The streak each particle has left behind, in space: `count × FLOW_TRAIL × 3`, newest first.
   *
   * The image is carried in the state rather than recomputed at draw time, and that is a design
   * decision rather than a cache. A trail point is X evaluated at a chart point the particle has
   * already been to, so recomputing the whole streak every frame would evaluate the surface
   * FLOW_TRAIL times more often than the integration itself does — the drawing would cost more
   * than the mathematics. Advancing writes one new head per particle; drawing then reads arrays
   * and evaluates nothing.
   */
  readonly point: Float64Array;
  /** the unit normal at each of those, so the streak can be lifted clear of the mesh */
  readonly normal: Float64Array;
  /** how many of each particle's trail points are real, so a respawn draws no jump */
  readonly filled: Uint8Array;
  readonly age: Float64Array;
  readonly life: Float64Array;
  /** PRNG state, kept here so a seeded flow replays exactly */
  rng: number;
}

export interface FlowOptions {
  /**
   * Seconds of animation per second of flow time, applied to every step.
   *
   * The field's own magnitude sets the relative speeds; this sets the tempo, and it belongs to
   * the caller because it is the one number that depends on how big the surface is on screen
   * rather than on the mathematics.
   */
  readonly timeScale?: number;
  /** Wrap rather than expire at these boundaries — a seam is not an edge. */
  readonly periodicU?: boolean;
  readonly periodicV?: boolean;
}

export interface Flow {
  /** Fresh particles, spread uniformly over the domain. */
  seed(count: number, seed?: number): FlowState;
  /** Advance every particle by `dt` seconds, reseeding the ones that finish. */
  advance(state: FlowState, dt: number): void;
  /**
   * The chart velocity at a point: the field's tangential part in (u, v) components.
   *
   * False when there is no tangent plane there, or the field is not finite — the non-finite
   * contract, stated where a particle would otherwise be stepped to NaN.
   */
  velocity(u: number, v: number, out: [number, number]): boolean;
  /**
   * Where a chart point sits in space, with its unit normal. False where there is no tangent
   * plane — which is the same test the velocity makes, since both are |X_u × X_v| ≠ 0.
   */
  frame(u: number, v: number, point: Vec3, normal: Vec3): boolean;
}

/** The ambient vector of the field at a chart point, written into `out`. */
export type FieldAt = (u: number, v: number, out: Vec3) => void;

/**
 * A flow on one surface, driven by one field.
 *
 * The surface supplies the chart, the metric and the domain; the field supplies V. Both are held
 * by reference and evaluated on demand, so a flow costs nothing until it is advanced.
 */
export function createFlow(
  surface: ParametricSurface,
  params: ArrayLike<number>,
  field: FieldAt,
  options: FlowOptions = {},
): Flow {
  const offsets: SurfaceJetOffsets = surfaceJetOffsets(surface.map.layout);
  const jet = surface.map.makeJet();
  const argument: [number, number] = [0, 0];
  const X: Vec3 = [0, 0, 0];
  const Xu: Vec3 = [0, 0, 0];
  const Xv: Vec3 = [0, 0, 0];
  const V: Vec3 = [0, 0, 0];
  const timeScale = options.timeScale ?? 1;

  const [uLo, uHi] = sampleBounds(surface.u);
  const [vLo, vHi] = sampleBounds(surface.v);
  const uSpan = uHi - uLo;
  const vSpan = vHi - vLo;
  const periodicU = options.periodicU ?? surface.periodicU;
  const periodicV = options.periodicV ?? surface.periodicV;

  const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

  const velocity = (u: number, v: number, out: [number, number]): boolean => {
    argument[0] = u;
    argument[1] = v;
    surface.map.evaluate(argument, params, jet);
    readVec3(jet, offsets.Xu, Xu);
    readVec3(jet, offsets.Xv, Xv);

    const E = dot(Xu, Xu);
    const F = dot(Xu, Xv);
    const G = dot(Xv, Xv);
    const det = E * G - F * F;
    // |X_u × X_v|² = EG − F², so this one test covers both the degenerate chart and a jet that
    // came back non-finite.
    if (!Number.isFinite(det) || det <= 1e-14 * Math.max(1, Math.abs(E * G))) return false;

    field(u, v, V);
    if (!Number.isFinite(V[0] + V[1] + V[2])) return false;

    const p = dot(V, Xu);
    const q = dot(V, Xv);
    out[0] = (G * p - F * q) / det;
    out[1] = (E * q - F * p) / det;
    return Number.isFinite(out[0]) && Number.isFinite(out[1]);
  };

  /**
   * The area element |X_u × X_v| at the last point `frame` answered for.
   *
   * Kept rather than returned because `frame` is called in the inner loop and its callers want
   * the point; only the seeding cares about the area, and it asks straight afterwards.
   */
  let lastArea = 0;

  const frame = (u: number, v: number, point: Vec3, normal: Vec3): boolean => {
    argument[0] = u;
    argument[1] = v;
    surface.map.evaluate(argument, params, jet);
    readVec3(jet, offsets.X, X);
    readVec3(jet, offsets.Xu, Xu);
    readVec3(jet, offsets.Xv, Xv);
    if (!Number.isFinite(X[0] + X[1] + X[2])) return false;

    // N = X_u × X_v / |X_u × X_v|, with the surface's own orientation — the same normal the mesh
    // was built with, or a streak would be lifted into the surface instead of off it.
    const sign = surface.flipped ? -1 : 1;
    const nx = Xu[1] * Xv[2] - Xu[2] * Xv[1];
    const ny = Xu[2] * Xv[0] - Xu[0] * Xv[2];
    const nz = Xu[0] * Xv[1] - Xu[1] * Xv[0];
    const length = Math.hypot(nx, ny, nz);
    lastArea = length;
    if (!(length > 0) || !Number.isFinite(length)) return false;

    point[0] = X[0];
    point[1] = X[1];
    point[2] = X[2];
    normal[0] = (sign * nx) / length;
    normal[1] = (sign * ny) / length;
    normal[2] = (sign * nz) / length;
    return true;
  };

  /** mulberry32: small, seeded, and good enough to scatter points over a rectangle. */
  const random = (state: FlowState): number => {
    state.rng = (state.rng + 0x6d2b79f5) | 0;
    let t = state.rng;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const scratchP: Vec3 = [0, 0, 0];
  const scratchN: Vec3 = [0, 0, 0];

  /** Put the particle's current chart position at the head of its streak. */
  const record = (state: FlowState, index: number, u: number, v: number): boolean => {
    if (!frame(u, v, scratchP, scratchN)) return false;
    state.chartTrail[index * FLOW_TRAIL * 2] = u;
    state.chartTrail[index * FLOW_TRAIL * 2 + 1] = v;
    const base = index * FLOW_TRAIL * 3;
    state.point[base] = scratchP[0];
    state.point[base + 1] = scratchP[1];
    state.point[base + 2] = scratchP[2];
    state.normal[base] = scratchN[0];
    state.normal[base + 1] = scratchN[1];
    state.normal[base + 2] = scratchN[2];
    return true;
  };

  /**
   * The largest area element over a coarse sweep of the domain, measured once.
   *
   * The reference for seeding **by area** rather than by parameter. Uniform in (u, v) is not
   * uniform on the surface: a sphere's chart crowds its poles, so a swarm scattered evenly in the
   * rectangle comes out as two dense knots and a sparse equator — a picture of the parametrization
   * rather than of the field. Rejection against this reference spreads the particles over the
   * OBJECT, which is what the eye is reading.
   */
  const areaReference = (() => {
    const point: Vec3 = [0, 0, 0];
    const normal: Vec3 = [0, 0, 0];
    let largest = 0;
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 8; j++) {
        const u = uLo + (uSpan * (i + 0.5)) / 8;
        const v = vLo + (vSpan * (j + 0.5)) / 8;
        if (!frame(u, v, point, normal)) continue;
        if (lastArea > largest) largest = lastArea;
      }
    }
    return largest;
  })();

  const respawn = (state: FlowState, index: number): void => {
    /**
     * A handful of tries, then whatever the last one gave.
     *
     * Each try can fail two ways: the chart may be degenerate there — a domain whose middle is a
     * pole would otherwise hand back a particle that dies again immediately — or the point may be
     * rejected for sitting where the chart is stretched thin. Bounded because the alternative is
     * a loop that never ends on a surface where every candidate is bad.
     */
    for (let attempt = 0; attempt < 8; attempt++) {
      const u = uLo + random(state) * uSpan;
      const v = vLo + random(state) * vSpan;
      state.chart[index * 2] = u;
      state.chart[index * 2 + 1] = v;
      state.age[index] = 0;
      state.life[index] = LIFE_MIN + random(state) * (LIFE_MAX - LIFE_MIN);
      state.filled[index] = record(state, index, u, v) ? 1 : 0;
      if (state.filled[index]! === 0) continue;
      const accept = areaReference > 0 ? lastArea / areaReference : 1;
      if (attempt === 7 || random(state) < accept) return;
    }
  };

  /** One RK4 step of γ̇ = velocity(γ). False when any stage has no answer. */
  const k: [number, number] = [0, 0];
  const step = (u: number, v: number, h: number, out: [number, number]): boolean => {
    if (!velocity(u, v, k)) return false;
    const k1u = k[0];
    const k1v = k[1];
    if (!velocity(u + (h / 2) * k1u, v + (h / 2) * k1v, k)) return false;
    const k2u = k[0];
    const k2v = k[1];
    if (!velocity(u + (h / 2) * k2u, v + (h / 2) * k2v, k)) return false;
    const k3u = k[0];
    const k3v = k[1];
    if (!velocity(u + h * k3u, v + h * k3v, k)) return false;
    out[0] = u + (h / 6) * (k1u + 2 * k2u + 2 * k3u + k[0]);
    out[1] = v + (h / 6) * (k1v + 2 * k2v + 2 * k3v + k[1]);
    return Number.isFinite(out[0]) && Number.isFinite(out[1]);
  };

  /** Into the domain if the direction closes up, off the end if it does not. */
  const wrap = (value: number, lo: number, span: number): number => {
    const shifted = (value - lo) % span;
    return lo + (shifted < 0 ? shifted + span : shifted);
  };

  const moved: [number, number] = [0, 0];

  return {
    seed(count, seed = 1) {
      const state: FlowState = {
        count,
        chart: new Float64Array(count * 2),
        chartTrail: new Float64Array(count * FLOW_TRAIL * 2),
        point: new Float64Array(count * FLOW_TRAIL * 3),
        normal: new Float64Array(count * FLOW_TRAIL * 3),
        filled: new Uint8Array(count),
        age: new Float64Array(count),
        life: new Float64Array(count),
        rng: seed | 0,
      };
      for (let i = 0; i < count; i++) {
        respawn(state, i);
        // Staggered from the start: seeded with a full lifetime each, the whole swarm would
        // vanish and reappear together a few seconds in.
        state.age[i] = random(state) * state.life[i]!;
      }
      return state;
    },

    advance(state, dt) {
      const h = dt * timeScale;
      if (!(h > 0)) return;

      for (let i = 0; i < state.count; i++) {
        const u = state.chart[i * 2]!;
        const v = state.chart[i * 2 + 1]!;

        state.age[i] = state.age[i]! + dt;
        if (state.age[i]! > state.life[i]!) {
          respawn(state, i);
          continue;
        }

        /**
         * Substeps so a fast particle is integrated rather than teleported.
         *
         * The count follows how far the field would carry it across the domain this frame: a
         * flow that crosses the patch in one step is not being solved, it is being sampled at
         * two points and joined with a line.
         */
        if (!velocity(u, v, k)) {
          respawn(state, i);
          continue;
        }
        const reach =
          Math.abs(k[0] * h) / (uSpan || 1) + Math.abs(k[1] * h) / (vSpan || 1);
        const substeps = Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil(reach * 8)));

        let nextU = u;
        let nextV = v;
        let alive = true;
        for (let s = 0; s < substeps && alive; s++) {
          alive = step(nextU, nextV, h / substeps, moved);
          if (!alive) break;
          nextU = moved[0];
          nextV = moved[1];
        }
        if (!alive) {
          respawn(state, i);
          continue;
        }

        // A seam is not an edge: a particle crossing it has gone round, so it comes back on the
        // other side and its streak starts again there rather than being stretched across the
        // whole chart.
        let jumped = false;
        if (periodicU && uSpan > 0 && (nextU < uLo || nextU > uHi)) {
          nextU = wrap(nextU, uLo, uSpan);
          jumped = true;
        }
        if (periodicV && vSpan > 0 && (nextV < vLo || nextV > vHi)) {
          nextV = wrap(nextV, vLo, vSpan);
          jumped = true;
        }
        if (nextU < uLo || nextU > uHi || nextV < vLo || nextV > vHi) {
          respawn(state, i);
          continue;
        }

        state.chart[i * 2] = nextU;
        state.chart[i * 2 + 1] = nextV;

        const base = i * FLOW_TRAIL * 3;
        const chartBase = i * FLOW_TRAIL * 2;
        if (!jumped) {
          // Shift the streak down; the new position goes at the head. Both copies of it move
          // together, or the picture in the inset would lag the one in space.
          for (let s = Math.min(state.filled[i]!, FLOW_TRAIL - 1); s > 0; s--) {
            for (let c = 0; c < 3; c++) {
              state.point[base + s * 3 + c] = state.point[base + (s - 1) * 3 + c]!;
              state.normal[base + s * 3 + c] = state.normal[base + (s - 1) * 3 + c]!;
            }
            state.chartTrail[chartBase + s * 2] = state.chartTrail[chartBase + (s - 1) * 2]!;
            state.chartTrail[chartBase + s * 2 + 1] =
              state.chartTrail[chartBase + (s - 1) * 2 + 1]!;
          }
        }
        if (!record(state, i, nextU, nextV)) {
          respawn(state, i);
          continue;
        }
        state.filled[i] = jumped
          ? 1
          : Math.min(FLOW_TRAIL, state.filled[i]! + 1);
      }
    },

    velocity,
    frame,
  };
}
