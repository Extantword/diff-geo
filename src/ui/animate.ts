import type { SliderSpec } from "./exprList.ts";

/**
 * Animating a slider: play, pause, rewind.
 *
 * Watching a parameter sweep is a different tool from dragging one. Dragging answers "what does
 * this value look like"; playing answers "how does the shape change as it varies" — which is the
 * question a one-parameter family actually poses, and the reason a torus becoming a horn torus
 * as r → R is worth seeing rather than being told.
 *
 * ## Two decisions worth stating
 *
 * **Ping-pong, not loop.** At the end of the range the direction reverses instead of snapping
 * back to the start. A jump discards the continuity that makes the sweep informative, and
 * reversing costs nothing.
 *
 * **The frame step is separate from `requestAnimationFrame`.** `step(dt)` is pure arithmetic
 * over the registered specs, so the ping-pong and clamping behaviour is testable in node without
 * a display; the rAF loop only supplies `dt`.
 */

/** Seconds for one traversal of a slider's range, at speed 1. */
const DEFAULT_PERIOD_SECONDS = 4;

/**
 * Largest frame delta acted on.
 *
 * `requestAnimationFrame` stops firing in a hidden tab, so returning to one after a minute
 * hands us a delta of a minute. Without this clamp, the value would leap most of the way across
 * its range — and with ping-pong, land somewhere arbitrary.
 */
const MAX_FRAME_SECONDS = 0.05;

/**
 * Something that is played but is not a slider: a flow.
 *
 * A field's flow has no value to sweep and no range to ping-pong across — it has a *state* that
 * advances, so what it needs from the animator is the clock and the transport, not the
 * arithmetic. Two consequences follow, and both matter. A ticker **paints itself**: `step` reports
 * only whether a slider moved, so the tick callback — which rebuilds the scene — is not run sixty
 * times a second for an animation that touches no formula. And the shared speed multiplier applies
 * to it, so turning the tempo down slows a sweep and a flow together, which is what makes them
 * legible side by side.
 */
export interface Ticker {
  /** advance by `seconds` of animation time */
  advance(seconds: number): void;
  /** start again from the beginning; for a flow, reseed the particles */
  rewind?(): void;
}

interface Entry {
  readonly spec: SliderSpec;
  /** push a new value into the DOM controls for this slider */
  readonly sync: (value: number) => void;
  /** called on pause, for sliders whose value also lives in a row's text */
  readonly commit?: (value: number) => void;
  direction: 1 | -1;
  playing: boolean;
}

export interface Animator {
  /**
   * Register a slider, or refresh its bindings after its DOM was rebuilt.
   *
   * Play state survives re-registration, so a refresh mid-animation does not stop it.
   */
  register(
    key: string,
    spec: SliderSpec,
    sync: (value: number) => void,
    commit?: (value: number) => void,
  ): void;
  unregister(key: string): void;
  /**
   * Register something that advances rather than sweeps. Play state survives re-registration,
   * exactly as a slider's does, so rebuilding a row's DOM mid-flow does not stop it.
   */
  registerTicker(key: string, ticker: Ticker): void;
  unregisterTicker(key: string): void;
  play(key: string): void;
  pause(key: string): void;
  toggle(key: string): void;
  /** Jump back to the start of the range, leaving play state alone. */
  rewind(key: string): void;
  playing(key: string): boolean;
  /**
   * How fast one thing runs, as a multiple of its own default rate — a traversal every four
   * seconds for a slider, a crossing of its patch for a flow.
   *
   * **Per key.** It was one number for the whole animation first, on the reasoning that when two
   * things play together the interesting quantity is their relative rates. That is true of two
   * things being compared and false of everything else: a document has several sliders and
   * several flows, only some of them playing, and they are usually about different questions —
   * a radius creeping while a flow runs at speed. One dial for all of them makes every choice a
   * compromise between unrelated animations. Values below 1 slow it down, above 1 speed it up.
   *
   * Kept apart from the entries, so a slider whose DOM is rebuilt — or a parameter that goes away
   * and comes back — resumes at the rate it was set to, exactly as its play state does.
   */
  setSpeed(key: string, multiplier: number): void;
  speed(key: string): number;
  /**
   * Advance every playing slider and ticker.
   *
   * Returns whether a **slider** moved, which is what decides a rebuild: a ticker paints itself,
   * and rebuilding the scene for one would cost a hundred times what the animation does.
   */
  step(seconds: number): boolean;
  /** Called once per frame after values advance, to trigger a redraw. */
  setOnTick(callback: (() => void) | null): void;
  stopAll(): void;
}

export function createAnimator(): Animator {
  /**
   * The frame loop is optional.
   *
   * `requestAnimationFrame` does not exist outside a browser, and reaching for it unguarded made
   * every `play()` throw under the node test environment. Guarding it is not only for tests
   * though: with no loop available the animator is still perfectly usable by a caller that
   * supplies its own deltas through `step`, which is exactly what makes the sweep arithmetic
   * verifiable without a display.
   */
  const schedule =
    typeof requestAnimationFrame === "function" ? requestAnimationFrame : null;
  const unschedule = typeof cancelAnimationFrame === "function" ? cancelAnimationFrame : null;
  const now = () =>
    typeof performance === "object" && typeof performance.now === "function"
      ? performance.now()
      : Date.now();

  const entries = new Map<string, Entry>();
  const tickers = new Map<string, { ticker: Ticker; playing: boolean }>();
  /** Per key, and outliving the entry it belongs to. */
  const speeds = new Map<string, number>();
  const speedOf = (key: string) => speeds.get(key) ?? 1;
  let frame = 0;
  let previous = 0;
  let onTick: (() => void) | null = null;

  const anyPlaying = () => {
    for (const entry of entries.values()) if (entry.playing) return true;
    for (const entry of tickers.values()) if (entry.playing) return true;
    return false;
  };

  const step = (seconds: number): boolean => {
    // Clamped here rather than in the frame loop, so the guard is part of the unit that gets
    // tested. A hidden tab stops firing frames, and the delta on returning is however long it
    // was hidden.
    const dt = Math.min(Math.max(seconds, 0), MAX_FRAME_SECONDS);

    // Tickers first, and their result deliberately not folded into `moved`: they draw their own
    // frame, and reporting them as movement would drag the whole scene rebuild along behind them.
    for (const [key, entry] of tickers) {
      if (entry.playing) entry.ticker.advance(dt * speedOf(key));
    }

    let moved = false;
    for (const [key, entry] of entries) {
      if (!entry.playing) continue;
      const { min, max } = entry.spec;
      const span = max - min;
      // A degenerate or inverted range has nothing to sweep; leave it rather than divide by it.
      if (!(span > 0)) continue;

      let next =
        entry.spec.value +
        entry.direction * (span / DEFAULT_PERIOD_SECONDS) * speedOf(key) * dt;

      /**
       * Reflect the overshoot rather than clamping to the end.
       *
       * Clamping loses the excess and stalls for a frame — a slider already sitting at its
       * maximum would not appear to move at all on the first step. Reflecting keeps the sweep
       * moving at a constant rate straight through the turn.
       */
      if (next > max) {
        next = max - (next - max);
        entry.direction = -1;
      } else if (next < min) {
        next = min + (min - next);
        entry.direction = 1;
      }
      // A delta large enough to cross the whole range could reflect past the far end.
      next = Math.min(max, Math.max(min, next));

      entry.spec.value = next;
      entry.sync(next);
      moved = true;
    }
    return moved;
  };

  const tick = (timestamp: number) => {
    const seconds = (timestamp - previous) / 1000;
    previous = timestamp;
    if (step(seconds) && onTick) onTick();
    frame = anyPlaying() && schedule ? schedule(tick) : 0;
  };

  const ensureRunning = () => {
    if (!schedule || frame !== 0 || !anyPlaying()) return;
    previous = now();
    frame = schedule(tick);
  };

  return {
    register(key, spec, sync, commit) {
      const existing = entries.get(key);
      entries.set(key, {
        spec,
        sync,
        commit,
        // Preserve direction and play state, so rebuilding a row's DOM mid-sweep is invisible.
        direction: existing?.direction ?? 1,
        playing: existing?.playing ?? false,
      });
      ensureRunning();
    },

    unregister(key) {
      entries.delete(key);
    },

    registerTicker(key, ticker) {
      const existing = tickers.get(key);
      tickers.set(key, { ticker, playing: existing?.playing ?? false });
      ensureRunning();
    },

    unregisterTicker(key) {
      tickers.delete(key);
    },

    play(key) {
      const ticking = tickers.get(key);
      if (ticking) {
        ticking.playing = true;
        ensureRunning();
        return;
      }
      const entry = entries.get(key);
      if (!entry) return;
      entry.playing = true;
      ensureRunning();
    },

    pause(key) {
      const ticking = tickers.get(key);
      if (ticking) {
        ticking.playing = false;
        return;
      }
      const entry = entries.get(key);
      if (!entry) return;
      entry.playing = false;
      // Reconcile the value's other home, if it has one — a numeric row's text, say. Once per
      // pause rather than once per frame, which is what keeps the animation cheap.
      entry.commit?.(entry.spec.value);
    },

    toggle(key) {
      if (this.playing(key)) this.pause(key);
      else this.play(key);
    },

    rewind(key) {
      const ticking = tickers.get(key);
      if (ticking) {
        ticking.ticker.rewind?.();
        if (onTick) onTick();
        return;
      }
      const entry = entries.get(key);
      if (!entry) return;
      entry.direction = 1;
      entry.spec.value = entry.spec.min;
      entry.sync(entry.spec.value);
      if (!entry.playing) entry.commit?.(entry.spec.value);
      if (onTick) onTick();
    },

    playing(key) {
      return tickers.get(key)?.playing ?? entries.get(key)?.playing ?? false;
    },

    setSpeed(key, multiplier) {
      // Zero or negative would stall or reverse the sweep, which the direction flag already owns;
      // clamped rather than rejected so a slider bound to this cannot wedge the animation.
      speeds.set(key, Math.min(20, Math.max(0.05, multiplier)));
    },

    speed: (key) => speedOf(key),

    step,

    setOnTick(callback) {
      onTick = callback;
    },

    stopAll() {
      for (const entry of entries.values()) {
        if (!entry.playing) continue;
        entry.playing = false;
        entry.commit?.(entry.spec.value);
      }
      for (const entry of tickers.values()) entry.playing = false;
      if (frame !== 0 && unschedule) {
        unschedule(frame);
        frame = 0;
      }
    },
  };
}
