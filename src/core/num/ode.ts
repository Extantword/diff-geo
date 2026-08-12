/**
 * Adaptive Runge–Kutta (Cash–Karp), written rather than imported.
 *
 * `core` carries no dependencies by contract, and the precedent's `ode45-cash-karp` shipped
 * untyped and needed a hand-written ambient declaration anyway. The coefficients below are
 * the standard Cash–Karp tableau: a fifth-order solution plus an embedded fourth-order one,
 * whose difference is the error estimate that drives step selection.
 *
 * ## Why adaptive matters here
 *
 * A geodesic crossing a region of high curvature needs small steps; one running along a flat
 * ruling needs almost none. A fixed step is therefore either wrong or wasteful. More
 * importantly, the step size collapsing toward zero is *diagnostic*: it is how the integrator
 * notices a coordinate singularity — the sphere's poles, a cone point — and the caller stops
 * there rather than integrating into nonsense.
 */

/** Writes dy/dt at (t, y) into `out`. */
export type Derivative = (t: number, y: Float64Array, out: Float64Array) => void;

export interface StepperOptions {
  /** absolute + relative error target per step */
  readonly tolerance?: number;
  readonly initialStep?: number;
  readonly minStep?: number;
  readonly maxStep?: number;
}

export interface Stepper {
  /** current independent variable */
  readonly t: number;
  /** current state; owned by the stepper, copy it if you keep it */
  readonly y: Float64Array;
  /** the step size that will be attempted next */
  readonly dt: number;
  /**
   * Advance one accepted step, not past `until`.
   * Returns false when `until` has been reached or the step size has collapsed.
   */
  step(until: number): boolean;
  /** true when the step size fell below `minStep`, i.e. a singularity was approached */
  readonly collapsed: boolean;
}

// Cash–Karp tableau.
const A = [0, 1 / 5, 3 / 10, 3 / 5, 1, 7 / 8];
const B: readonly number[][] = [
  [],
  [1 / 5],
  [3 / 40, 9 / 40],
  [3 / 10, -9 / 10, 6 / 5],
  [-11 / 54, 5 / 2, -70 / 27, 35 / 27],
  [1631 / 55296, 175 / 512, 575 / 13824, 44275 / 110592, 253 / 4096],
];
/** fifth-order weights */
const C5 = [37 / 378, 0, 250 / 621, 125 / 594, 0, 512 / 1771];
/** embedded fourth-order weights */
const C4 = [2825 / 27648, 0, 18575 / 48384, 13525 / 55296, 277 / 14336, 1 / 4];

export function createStepper(
  derivative: Derivative,
  y0: ArrayLike<number>,
  t0: number,
  options: StepperOptions = {},
): Stepper {
  const n = y0.length;
  const tolerance = options.tolerance ?? 1e-8;
  const minStep = options.minStep ?? 1e-7;
  const maxStep = options.maxStep ?? Infinity;

  const y = Float64Array.from(y0);
  const trial = new Float64Array(n);
  const candidate = new Float64Array(n);
  const k: Float64Array[] = Array.from({ length: 6 }, () => new Float64Array(n));

  let t = t0;
  let dt = options.initialStep ?? 1e-2;
  let collapsed = false;

  const stepper: Stepper = {
    get t() {
      return t;
    },
    get y() {
      return y;
    },
    get dt() {
      return dt;
    },
    get collapsed() {
      return collapsed;
    },

    step(until: number): boolean {
      if (t >= until || collapsed) return false;

      // Never overshoot the requested endpoint.
      let h = Math.min(dt, until - t, maxStep);

      for (let attempt = 0; attempt < 40; attempt++) {
        // Six stages.
        for (let stage = 0; stage < 6; stage++) {
          for (let i = 0; i < n; i++) {
            let sum = y[i]!;
            const row = B[stage]!;
            for (let j = 0; j < row.length; j++) sum += h * row[j]! * k[j]![i]!;
            trial[i] = sum;
          }
          derivative(t + A[stage]! * h, trial, k[stage]!);
        }

        // Fifth-order solution and the embedded fourth-order estimate.
        let worst = 0;
        for (let i = 0; i < n; i++) {
          let fifth = y[i]!;
          let fourth = y[i]!;
          for (let stage = 0; stage < 6; stage++) {
            fifth += h * C5[stage]! * k[stage]![i]!;
            fourth += h * C4[stage]! * k[stage]![i]!;
          }
          candidate[i] = fifth;
          // Mixed absolute/relative scale, so a state component passing through zero does
          // not force the step to collapse.
          const scale = tolerance * (1 + Math.abs(y[i]!));
          worst = Math.max(worst, Math.abs(fifth - fourth) / scale);
        }

        if (!Number.isFinite(worst)) {
          // The right-hand side blew up; shrink hard and retry, and let the caller notice
          // via `collapsed` if this does not recover.
          h *= 0.1;
          if (h < minStep) {
            collapsed = true;
            return false;
          }
          continue;
        }

        if (worst <= 1) {
          t += h;
          y.set(candidate);
          // Grow for next time, capped so one easy step cannot overshoot a hard region.
          const growth = worst === 0 ? 5 : Math.min(5, 0.9 * Math.pow(worst, -0.2));
          dt = Math.min(h * growth, maxStep);
          return true;
        }

        h *= Math.max(0.1, 0.9 * Math.pow(worst, -0.25));
        if (h < minStep) {
          // Step collapse. Not a failure to hide — it is how a coordinate singularity
          // announces itself, and the caller stops and says so.
          collapsed = true;
          return false;
        }
      }

      collapsed = true;
      return false;
    },
  };

  return stepper;
}
