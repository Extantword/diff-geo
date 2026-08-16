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

describe("animation speed", () => {
  it("scales how far a sweep travels in a given time", () => {
    const make = (speed: number) => {
      const animator = createAnimator();
      const spec = { value: 0, min: 0, max: 4, step: 0.01 };
      animator.register("k", spec, (value) => (spec.value = value));
      animator.play("k");
      animator.setSpeed("k", speed);
      animator.step(0.02);
      return spec.value;
    };
    // Twice the speed covers twice the ground in the same frame.
    expect(make(2)).toBeCloseTo(make(1) * 2, 9);
    expect(make(0.5)).toBeCloseTo(make(1) / 2, 9);
  });

  it("clamps a speed that would stall or reverse the sweep", () => {
    // Direction is owned by the ping-pong; letting speed go negative would give two things
    // authority over it, and zero would look like a bug rather than a setting.
    const animator = createAnimator();
    animator.setSpeed("k", 0);
    expect(animator.speed("k")).toBeGreaterThan(0);
    animator.setSpeed("k", -3);
    expect(animator.speed("k")).toBeGreaterThan(0);
    animator.setSpeed("k", 1e6);
    expect(animator.speed("k")).toBeLessThanOrEqual(20);
  });

  it("gives each thing its own rate", () => {
    /**
     * One dial for the whole animation was the first design, on the reasoning that two things
     * playing together are being compared. Usually they are not — a document has several sliders
     * and several flows, about different questions — so a single rate made every choice a
     * compromise between unrelated animations.
     */
    const animator = createAnimator();
    const a = { value: 0, min: 0, max: 4, step: 0.01 };
    const b = { value: 0, min: 0, max: 4, step: 0.01 };
    animator.register("a", a, (value) => (a.value = value));
    animator.register("b", b, (value) => (b.value = value));
    animator.play("a");
    animator.play("b");

    animator.setSpeed("a", 4);
    expect(animator.speed("b")).toBe(1);
    animator.step(0.02);
    expect(a.value).toBeCloseTo(b.value * 4, 9);
  });

  it("keeps a rate through the rebuild of the control that set it", () => {
    // Held apart from the entries, like play state: a parameter that goes away and comes back
    // resumes at the rate it was given.
    const animator = createAnimator();
    const spec = { value: 0, min: 0, max: 4, step: 0.01 };
    animator.setSpeed("k", 2);
    animator.register("k", spec, () => {});
    expect(animator.speed("k")).toBe(2);
    animator.unregister("k");
    animator.register("k", spec, () => {});
    expect(animator.speed("k")).toBe(2);
  });
});

describe("tickers: things that advance rather than sweep", () => {
  it("advances only while playing, and at its own speed", () => {
    const animator = createAnimator();
    let total = 0;
    animator.registerTicker("flow:1", { advance: (seconds) => (total += seconds) });

    // Registered is not playing: a flow appears paused, like every other transport.
    animator.step(1);
    expect(total).toBe(0);

    animator.play("flow:1");
    animator.step(0.02);
    expect(total).toBeCloseTo(0.02, 12);

    // Its own rate, like every other transport: a flow can run fast while a radius creeps.
    animator.setSpeed("flow:1", 2);
    animator.step(0.02);
    expect(total).toBeCloseTo(0.06, 12);
  });

  it("reports no movement, so a flow does not rebuild the scene sixty times a second", () => {
    /**
     * `step` returns whether a SLIDER moved, because that is what the tick callback rebuilds the
     * scene for. A flow paints its own frame — the particles are not in the document — and
     * reporting it as movement would drag a full retessellation along behind every frame.
     */
    const animator = createAnimator();
    animator.registerTicker("flow:1", { advance: () => {} });
    animator.play("flow:1");
    expect(animator.step(0.02)).toBe(false);
  });

  it("plays, pauses and rewinds through the same transport as a slider", () => {
    const animator = createAnimator();
    let rewound = 0;
    animator.registerTicker("flow:1", { advance: () => {}, rewind: () => rewound++ });

    expect(animator.playing("flow:1")).toBe(false);
    animator.toggle("flow:1");
    expect(animator.playing("flow:1")).toBe(true);
    animator.toggle("flow:1");
    expect(animator.playing("flow:1")).toBe(false);

    animator.rewind("flow:1");
    expect(rewound).toBe(1);
  });

  it("keeps playing across a re-registration, so a refresh does not stop the flow", () => {
    const animator = createAnimator();
    animator.registerTicker("flow:1", { advance: () => {} });
    animator.play("flow:1");
    let advanced = 0;
    animator.registerTicker("flow:1", { advance: () => advanced++ });
    expect(animator.playing("flow:1")).toBe(true);
    animator.step(0.02);
    expect(advanced).toBe(1);
  });

  it("stops with everything else, and can be dropped", () => {
    const animator = createAnimator();
    let advanced = 0;
    animator.registerTicker("flow:1", { advance: () => advanced++ });
    animator.play("flow:1");
    animator.stopAll();
    expect(animator.playing("flow:1")).toBe(false);

    animator.play("flow:1");
    animator.unregisterTicker("flow:1");
    animator.step(0.02);
    expect(advanced).toBe(0);
  });
});
