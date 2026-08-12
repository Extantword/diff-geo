import { describe, expect, it, vi } from "vitest";
import {
  batch,
  computed,
  effect,
  signal,
  untrack,
} from "../../src/state/signal.ts";

describe("signal and computed", () => {
  it("reads and writes", () => {
    const a = signal(1);
    expect(a()).toBe(1);
    a.set(4);
    expect(a()).toBe(4);
    a.update((x) => x + 1);
    expect(a()).toBe(5);
  });

  it("derives values lazily", () => {
    const a = signal(2);
    const spy = vi.fn(() => a() * 10);
    const b = computed(spy);

    // Never evaluated until read — a computed nobody looks at costs nothing.
    expect(spy).not.toHaveBeenCalled();
    expect(b()).toBe(20);
    expect(spy).toHaveBeenCalledTimes(1);
    // Cached while clean.
    expect(b()).toBe(20);
    expect(spy).toHaveBeenCalledTimes(1);

    a.set(3);
    expect(b()).toBe(30);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("stops propagating when the value does not change", () => {
    // This is what keeps an unchanged compiled program from retriggering a GPU upload.
    const a = signal(1);
    const parity = computed(() => a() % 2);
    const downstream = vi.fn(() => parity());
    const out = computed(downstream);

    expect(out()).toBe(1);
    expect(downstream).toHaveBeenCalledTimes(1);

    // 1 → 3 changes `a` but not its parity, so nothing downstream reruns.
    a.set(3);
    expect(out()).toBe(1);
    expect(downstream).toHaveBeenCalledTimes(1);

    a.set(4);
    expect(out()).toBe(0);
    expect(downstream).toHaveBeenCalledTimes(2);
  });

  it("keeps the previous value when the new one compares equal", () => {
    // The whole point of `eq`: a consumer guarding with `if (v === last) return;` — the
    // GPU-upload check — must keep seeing the same object. Storing a fresh-but-equal value
    // would hand every downstream identity comparison a false positive.
    const a = signal(1);
    const derived = computed(
      () => ({ parity: a() % 2 }),
      (x, y) => x.parity === y.parity,
    );

    const first = derived();
    a.set(3); // same parity, different source value
    expect(derived()).toBe(first);
    a.set(4);
    expect(derived()).not.toBe(first);
  });

  it("honours a custom equality", () => {
    const a = signal({ n: 1 }, (x, y) => x.n === y.n);
    const spy = vi.fn(() => a().n);
    const b = computed(spy);
    expect(b()).toBe(1);
    a.set({ n: 1 }); // a different object, an equal value
    expect(b()).toBe(1);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("glitch-freeness", () => {
  it("recomputes a diamond's apex exactly once", () => {
    //     a
    //    / \
    //   b   c
    //    \ /
    //     d
    const a = signal(1);
    const b = computed(() => a() * 2);
    const c = computed(() => a() * 3);
    const spy = vi.fn(() => b() + c());
    const d = computed(spy);

    expect(d()).toBe(5);
    expect(spy).toHaveBeenCalledTimes(1);

    a.set(2);
    expect(d()).toBe(10);
    // The naive push-based store would recompute d twice — once per path.
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("never lets an effect observe a half-updated graph", () => {
    // The failure this exists to prevent: `c` computed from the new `a` and the old `b`.
    const a = signal(1);
    const b = computed(() => a() + 1);
    const seen: Array<[number, number]> = [];

    effect(() => {
      seen.push([a(), b()]);
    });

    a.set(5);
    a.set(9);

    for (const [value, derived] of seen) {
      expect(derived, `b must equal a + 1, saw a=${value} b=${derived}`).toBe(value + 1);
    }
  });

  it("keeps a deep chain consistent", () => {
    const a = signal(0);
    const chain = [computed(() => a() + 1)];
    for (let i = 1; i < 12; i++) {
      const previous = chain[i - 1]!;
      chain.push(computed(() => previous() + 1));
    }
    const last = chain[chain.length - 1]!;
    expect(last()).toBe(12);
    a.set(10);
    expect(last()).toBe(22);
  });
});

describe("effects", () => {
  it("runs immediately and on every relevant change", () => {
    const a = signal(1);
    const spy = vi.fn(() => void a());
    effect(spy);
    expect(spy).toHaveBeenCalledTimes(1);
    a.set(2);
    expect(spy).toHaveBeenCalledTimes(2);
    a.set(2); // unchanged
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("stops after disposal", () => {
    const a = signal(1);
    const spy = vi.fn(() => void a());
    const dispose = effect(spy);
    a.set(2);
    expect(spy).toHaveBeenCalledTimes(2);
    dispose();
    a.set(3);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("runs teardown before each rerun and on disposal", () => {
    const a = signal(1);
    const teardown = vi.fn();
    const dispose = effect(() => {
      a();
      return teardown;
    });

    expect(teardown).not.toHaveBeenCalled();
    a.set(2);
    expect(teardown).toHaveBeenCalledTimes(1);
    dispose();
    expect(teardown).toHaveBeenCalledTimes(2);
  });

  it("tracks dependencies that change between runs", () => {
    const useFirst = signal(true);
    const first = signal("a");
    const second = signal("b");
    const seen: string[] = [];

    effect(() => {
      seen.push(useFirst() ? first() : second());
    });

    expect(seen).toEqual(["a"]);

    // While reading `first`, a write to `second` must not retrigger.
    second.set("B");
    expect(seen).toEqual(["a"]);

    useFirst.set(false);
    expect(seen).toEqual(["a", "B"]);

    // And now the reverse: `first` is no longer a dependency.
    first.set("A");
    expect(seen).toEqual(["a", "B"]);
    second.set("BB");
    expect(seen).toEqual(["a", "B", "BB"]);
  });
});

describe("batch", () => {
  it("collapses several writes into one effect run", () => {
    const a = signal(1);
    const b = signal(2);
    const spy = vi.fn(() => {
      a();
      b();
    });
    effect(spy);
    expect(spy).toHaveBeenCalledTimes(1);

    batch(() => {
      a.set(10);
      b.set(20);
    });
    // Without batching this would retessellate twice.
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("returns the callback's value and flushes on throw", () => {
    const a = signal(1);
    let runs = 0;
    effect(() => {
      a();
      runs++;
    });

    expect(batch(() => 42)).toBe(42);
    expect(() =>
      batch(() => {
        a.set(2);
        throw new Error("boom");
      }),
    ).toThrow("boom");
    // The write still took effect and the effect still ran.
    expect(a()).toBe(2);
    expect(runs).toBe(2);
  });

  it("nests", () => {
    const a = signal(0);
    const spy = vi.fn(() => void a());
    effect(spy);
    batch(() => {
      a.set(1);
      batch(() => {
        a.set(2);
      });
      a.set(3);
    });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(a()).toBe(3);
  });
});

describe("untrack", () => {
  it("reads without subscribing", () => {
    const tracked = signal(1);
    const hidden = signal(100);
    const spy = vi.fn(() => tracked() + untrack(() => hidden()));
    const total = computed(spy);

    expect(total()).toBe(101);
    hidden.set(200);
    // Still cached: `hidden` was never registered as a dependency.
    expect(total()).toBe(101);
    expect(spy).toHaveBeenCalledTimes(1);

    tracked.set(2);
    expect(total()).toBe(202);
  });
});

describe("safety", () => {
  it("throws rather than hanging when an effect writes its own source", () => {
    const a = signal(0);
    expect(() => {
      effect(() => {
        a.set(a() + 1);
      });
    }).toThrow(/did not settle/);
  });

  it("survives a computed reading a signal it does not depend on being written", () => {
    const a = signal(1);
    const unrelated = signal(1);
    const spy = vi.fn(() => a());
    const b = computed(spy);
    expect(b()).toBe(1);
    unrelated.set(2);
    expect(b()).toBe(1);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
