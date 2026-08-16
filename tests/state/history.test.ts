import { describe, expect, it } from "vitest";
import { createHistory } from "../../src/state/history.ts";

/**
 * Undo over snapshots.
 *
 * The behaviour worth pinning is not "it can go back" — it is the two rules that make going back
 * mean something: a drag has to collapse into one step, and a real edit must never be swallowed
 * by the one before it.
 */

/** A clock the test drives, so coalescing is tested without waiting for it. */
function clock() {
  let time = 0;
  return { now: () => time, advance: (ms: number) => (time += ms) };
}

const key = (state: { text: string; rows: number }) => JSON.stringify(state);
const boundary = (a: { rows: number }, b: { rows: number }) => a.rows !== b.rows;

describe("recording", () => {
  it("takes the first state as the floor and moves back through the changes", () => {
    const time = clock();
    const history = createHistory({ key, now: time.now, coalesceMs: 100 });

    history.observe({ text: "a", rows: 1 });
    time.advance(1000);
    history.observe({ text: "b", rows: 1 });
    time.advance(1000);
    history.observe({ text: "c", rows: 1 });

    expect(history.size()).toEqual({ entries: 3, index: 2 });
    expect(history.undo()).toEqual({ text: "b", rows: 1 });
    expect(history.undo()).toEqual({ text: "a", rows: 1 });
    // The floor: there is nothing before the state everything started from.
    expect(history.undo()).toBeNull();
    expect(history.canUndo()).toBe(false);
  });

  it("ignores a state that is not a change", () => {
    const history = createHistory({ key, now: clock().now });
    history.observe({ text: "a", rows: 1 });
    history.observe({ text: "a", rows: 1 });
    history.observe({ text: "a", rows: 1 });
    expect(history.size().entries).toBe(1);
  });

  it("redoes, and discards the redo tail once a new edit lands", () => {
    const time = clock();
    const history = createHistory({ key, now: time.now, coalesceMs: 100 });
    history.observe({ text: "a", rows: 1 });
    time.advance(1000);
    history.observe({ text: "b", rows: 1 });
    time.advance(1000);
    history.observe({ text: "c", rows: 1 });

    expect(history.undo()).toEqual({ text: "b", rows: 1 });
    expect(history.redo()).toEqual({ text: "c", rows: 1 });
    expect(history.redo()).toBeNull();

    history.undo();
    time.advance(1000);
    history.observe({ text: "d", rows: 1 });
    // "c" is gone: the history is a line, not a tree the user cannot see.
    expect(history.canRedo()).toBe(false);
    expect(history.size()).toEqual({ entries: 3, index: 2 });
  });
});

describe("coalescing", () => {
  it("collapses a burst into one step", () => {
    const time = clock();
    const history = createHistory({ key, now: time.now, coalesceMs: 100 });
    history.observe({ text: "", rows: 1 });
    time.advance(1000);

    // A drag: many states, all inside the window.
    for (let i = 1; i <= 20; i++) {
      history.observe({ text: `x${i}`, rows: 1 });
      time.advance(20);
    }

    expect(history.size().entries).toBe(2);
    expect(history.undo()).toEqual({ text: "", rows: 1 });
  });

  it("keeps a slow drag as one step, rather than splitting it every window", () => {
    // The timer restarts on each merge. Without that, a drag longer than the window would leave
    // an undo entry every 450 ms — the user would have to press Ctrl-Z eleven times to put an
    // object back where it started.
    const time = clock();
    const history = createHistory({ key, now: time.now, coalesceMs: 100 });
    history.observe({ text: "", rows: 1 });
    time.advance(1000);
    for (let i = 1; i <= 30; i++) {
      history.observe({ text: `x${i}`, rows: 1 });
      time.advance(90);
    }
    expect(history.size().entries).toBe(2);
  });

  it("never merges the first edit into the state it started from", () => {
    // Otherwise the original state becomes unreachable, and the very first thing you do in a
    // session is the one thing you cannot undo.
    const time = clock();
    const history = createHistory({ key, now: time.now, coalesceMs: 100 });
    history.observe({ text: "a", rows: 1 });
    time.advance(1);
    history.observe({ text: "b", rows: 1 });

    expect(history.size().entries).toBe(2);
    expect(history.undo()).toEqual({ text: "a", rows: 1 });
  });

  it("gives a structural change its own step however fast it lands", () => {
    const time = clock();
    const history = createHistory({ key, boundary, now: time.now, coalesceMs: 100 });
    history.observe({ text: "a", rows: 1 });
    time.advance(1000);
    history.observe({ text: "b", rows: 1 });
    time.advance(1);
    // A row appeared: adding a piece is one action even if it lands mid-drag.
    history.observe({ text: "b", rows: 2 });
    time.advance(1);
    history.observe({ text: "c", rows: 3 });

    expect(history.size().entries).toBe(4);
    expect(history.undo()).toEqual({ text: "b", rows: 2 });
    expect(history.undo()).toEqual({ text: "b", rows: 1 });
  });
});

describe("the limit", () => {
  it("drops the oldest entries and keeps pointing at the newest", () => {
    const time = clock();
    const history = createHistory({ key, now: time.now, coalesceMs: 0, limit: 5 });
    for (let i = 0; i < 20; i++) {
      history.observe({ text: `s${i}`, rows: 1 });
      time.advance(1000);
    }
    expect(history.size()).toEqual({ entries: 5, index: 4 });
    expect(history.undo()).toEqual({ text: "s18", rows: 1 });
  });
});
