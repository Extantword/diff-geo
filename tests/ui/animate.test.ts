import { describe, expect, it, vi } from "vitest";
import { createAnimator } from "../../src/ui/animate.ts";
import type { SliderSpec } from "../../src/ui/exprList.ts";

/**
 * The animator's arithmetic is deliberately separate from `requestAnimationFrame`, so all of the
 * behaviour that matters — sweep rate, ping-pong at the ends, the frame-delta clamp — is testable
 * here without a display.
 */

const spec = (over: Partial<SliderSpec> = {}): SliderSpec => ({
  value: 0,
  min: 0,
  max: 4,
  step: 0.01,
  ...over,
});

describe("stepping", () => {
  it("sweeps the range in the period", () => {
    const animator = createAnimator();
    const s = spec();
    animator.register("a", s, () => {});
    animator.play("a");

    // Four seconds for one traversal of a range of four units, accumulated over frames of a
    // realistic size — a single huge step is clamped, deliberately.
    for (let i = 0; i < 50; i++) animator.step(0.02);
    expect(s.value).toBeCloseTo(1, 6);
    for (let i = 0; i < 100; i++) animator.step(0.02);
    expect(s.value).toBeCloseTo(3, 6);
  });

  it("does nothing while paused", () => {
    const animator = createAnimator();
    const s = spec();
    animator.register("a", s, () => {});
    animator.step(0.05);
    expect(s.value).toBe(0);
  });

  it("reverses at each end, staying inside the range throughout", () => {
    // Ping-pong keeps the sweep continuous; jumping back to the start would discard exactly the
    // continuity that makes watching it informative. Asserted as invariants over many frames
    // rather than as exact values, so the test does not encode the frame rate.
    const animator = createAnimator();
    const s = spec({ value: 3.9 });
    animator.register("a", s, () => {});
    animator.play("a");

    let sawIncrease = false;
    let sawDecrease = false;
    let previous = s.value;

    for (let i = 0; i < 600; i++) {
      animator.step(0.02);
      expect(s.value).toBeGreaterThanOrEqual(s.min);
      expect(s.value).toBeLessThanOrEqual(s.max);
      if (s.value > previous) sawIncrease = true;
      if (s.value < previous) sawDecrease = true;
      previous = s.value;
    }

    // It went up, turned around, and came back — both directions occurred.
    expect(sawIncrease).toBe(true);
    expect(sawDecrease).toBe(true);
  });

  it("keeps moving even when it starts exactly at an end", () => {
    // Clamping instead of reflecting would stall here for a frame.
    const animator = createAnimator();
    const s = spec({ value: 4 });
    animator.register("a", s, () => {});
    animator.play("a");
    animator.step(0.05);
    expect(s.value).toBeLessThan(4);
  });

  it("clamps a huge frame delta", () => {
    // requestAnimationFrame stops in a hidden tab, so returning to one hands over a delta of
    // however long it was hidden. Without the clamp the value would leap across the range and,
    // with ping-pong, land somewhere arbitrary.
    const animator = createAnimator();
    const s = spec();
    animator.register("a", s, () => {});
    animator.play("a");
    animator.step(600);
    // At most one clamped frame's worth of movement, not most of the range.
    expect(s.value).toBeLessThan(0.1);
  });

  it("leaves a degenerate range alone instead of dividing by it", () => {
    const animator = createAnimator();
    const s = spec({ min: 2, max: 2, value: 2 });
    animator.register("a", s, () => {});
    animator.play("a");
    animator.step(0.05);
    expect(s.value).toBe(2);
    expect(Number.isFinite(s.value)).toBe(true);
  });
});

describe("controls", () => {
  it("pushes each new value into the DOM through sync", () => {
    const animator = createAnimator();
    const s = spec();
    const sync = vi.fn();
    animator.register("a", s, sync);
    animator.play("a");
    animator.step(0.05);
    expect(sync).toHaveBeenCalledWith(s.value);
  });

  it("reports play state, and toggles it", () => {
    const animator = createAnimator();
    animator.register("a", spec(), () => {});
    expect(animator.playing("a")).toBe(false);
    animator.toggle("a");
    expect(animator.playing("a")).toBe(true);
    animator.toggle("a");
    expect(animator.playing("a")).toBe(false);
  });

  it("rewinds to the start and resets direction", () => {
    const animator = createAnimator();
    const s = spec({ value: 4 });
    animator.register("a", s, () => {});
    animator.play("a");
    animator.step(0.05); // reflects off the top and heads down
    expect(s.value).toBeLessThan(4);

    animator.rewind("a");
    expect(s.value).toBe(0);
    // Rewinding leaves it playing, and it must now travel upward.
    animator.step(0.05);
    expect(s.value).toBeGreaterThan(0);
  });

  it("commits only on pause, never per frame", () => {
    // The commit writes a row's text, which rebuilds its expression tree. Doing that per frame is
    // the trap that made dragging janky before parameters became slots.
    const animator = createAnimator();
    const commit = vi.fn();
    animator.register("a", spec(), () => {}, commit);
    animator.play("a");
    animator.step(0.05);
    animator.step(0.05);
    expect(commit).not.toHaveBeenCalled();

    animator.pause("a");
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("keeps playing across a re-registration", () => {
    // A row's DOM is rebuilt whenever its kind changes; an animation must survive that rather
    // than silently stopping.
    const animator = createAnimator();
    const s = spec();
    animator.register("a", s, () => {});
    animator.play("a");
    animator.step(0.05);
    const before = s.value;

    animator.register("a", s, () => {});
    expect(animator.playing("a")).toBe(true);
    animator.step(0.05);
    expect(s.value).toBeGreaterThan(before);
  });

  it("stops when unregistered", () => {
    const animator = createAnimator();
    const s = spec();
    animator.register("a", s, () => {});
    animator.play("a");
    animator.unregister("a");
    animator.step(0.05);
    expect(s.value).toBe(0);
    expect(animator.playing("a")).toBe(false);
  });

  it("ignores controls for a key it does not know", () => {
    const animator = createAnimator();
    expect(() => {
      animator.play("missing");
      animator.pause("missing");
      animator.toggle("missing");
      animator.rewind("missing");
    }).not.toThrow();
    expect(animator.playing("missing")).toBe(false);
  });

  it("notifies once per stepped frame", () => {
    const animator = createAnimator();
    const onTick = vi.fn();
    animator.setOnTick(onTick);
    animator.register("a", spec(), () => {});
    animator.rewind("a");
    expect(onTick).toHaveBeenCalledTimes(1);
  });
});
