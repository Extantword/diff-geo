/**
 * Undo, as a stack of whole snapshots.
 *
 * Deliberately **not** a log of commands. A scene here is a document of text plus a dozen small
 * maps, and every action already has to write several of them at once — placing a piece adds a
 * row, a domain and a joint. Recording those as invertible operations means writing an inverse
 * for each and keeping the two in step forever; snapshotting the state means one capture, one
 * restore, and an action added later is undoable without anyone remembering to make it so.
 *
 * ## Nothing is instrumented: changes are noticed, not announced
 *
 * `observe` is called with the current state after every render. If it differs from what is on
 * top of the stack, that is an edit. So there is no list of call sites to keep complete, and a
 * feature cannot forget to record itself — the failure mode of command logs in a codebase where
 * new controls appear every week.
 *
 * ## Coalescing, or a drag becomes four hundred undo steps
 *
 * A pointer drag re-renders every frame and each frame is a different state. Successive changes
 * inside `coalesceMs` therefore **replace** the top entry rather than pushing a new one, so a
 * drag or a burst of typing collapses to one step. Two guards keep that from swallowing real
 * edits: the timer restarts on each replacement, so a continuous drag stays one entry however
 * long it runs; and `boundary` forces a fresh entry regardless of timing — a change that adds or
 * removes a row is its own step even if it lands a millisecond after the last one.
 *
 * The first entry is never replaced. It is the state everything can be undone back to, and
 * merging the first edit into it would make that state unreachable.
 */

export interface History<T> {
  /** Record the current state, if it is a change. Safe to call on every frame. */
  observe(state: T): void;
  /** The previous state, or null at the bottom. The caller applies it. */
  undo(): T | null;
  /** The state undone away from, or null if nothing was undone. */
  redo(): T | null;
  canUndo(): boolean;
  canRedo(): boolean;
  /** For tests and diagnostics. */
  size(): { entries: number; index: number };
}

export interface HistoryOptions<T> {
  /** What makes two states the same. States with equal keys are not a change. */
  readonly key: (state: T) => string;
  /** True when the step from `previous` to `next` must not merge into the entry before it. */
  readonly boundary?: (previous: T, next: T) => boolean;
  /** How close in time two changes must be to merge. */
  readonly coalesceMs?: number;
  /** Entries kept; the oldest are dropped past this. */
  readonly limit?: number;
  /** Injectable clock, so the coalescing rule is testable without waiting. */
  readonly now?: () => number;
}

const COALESCE_MS = 450;
const LIMIT = 80;

export function createHistory<T>(options: HistoryOptions<T>): History<T> {
  const coalesceMs = options.coalesceMs ?? COALESCE_MS;
  const limit = Math.max(2, options.limit ?? LIMIT);
  const now = options.now ?? (() => Date.now());

  const entries: { state: T; key: string; at: number }[] = [];
  let index = -1;

  return {
    observe(state) {
      const key = options.key(state);
      const current = entries[index];
      if (current && current.key === key) return;

      // Anything undone past is discarded the moment a new edit lands, which is what makes the
      // history a line rather than a tree the user cannot see.
      if (entries.length > index + 1) entries.length = index + 1;

      const at = now();
      const previous = entries[index];
      const merge =
        previous !== undefined &&
        index > 0 &&
        at - previous.at < coalesceMs &&
        !(options.boundary?.(previous.state, state) ?? false);

      if (merge && previous) {
        previous.state = state;
        previous.key = key;
        // Restarted, not left at the first frame of the drag: a slow drag is still one action.
        previous.at = at;
        return;
      }

      entries.push({ state, key, at });
      index = entries.length - 1;

      if (entries.length > limit) {
        entries.shift();
        index--;
      }
    },

    undo() {
      if (index <= 0) return null;
      index--;
      return entries[index]!.state;
    },

    redo() {
      if (index >= entries.length - 1) return null;
      index++;
      return entries[index]!.state;
    },

    canUndo: () => index > 0,
    canRedo: () => index < entries.length - 1,
    size: () => ({ entries: entries.length, index }),
  };
}
