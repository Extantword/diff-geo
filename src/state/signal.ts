/**
 * A small reactive store: `signal`, `computed`, `effect`.
 *
 * ## Why not a simpler push-based store
 *
 * The obvious implementation — on write, walk the observers and recompute each — is
 * *glitchy*. Given `a`, `b = f(a)` and `c = g(a, b)`, writing `a` can recompute `c`
 * against the new `a` and the **old** `b` before `b` has caught up. Here that would mean
 * a mesh rebuilt from the new parameter and the previous formula: a visible wrong frame,
 * and a bug that only appears under specific dependency shapes.
 *
 * So this uses the lazy pull-based two-colour scheme (as in Reactively and Solid).
 * Each node is CLEAN, CHECK or DIRTY:
 *
 *  - writing a signal marks its direct observers DIRTY and everything downstream CHECK;
 *  - reading a CHECK node validates its sources first, and recomputes only if one of them
 *    actually changed value.
 *
 * Glitch-freeness follows without any topological sort, and a diamond recomputes its apex
 * exactly once. Values are computed on demand, so a computed nobody reads costs nothing.
 *
 * ## `eq` is load-bearing
 *
 * A computed that returns the *same compiled program* must not retrigger a GPU upload.
 * Equality is what stops propagation, so the default is `Object.is` and callers override
 * it when identity is too strict.
 */

const CLEAN = 0;
const CHECK = 1;
const DIRTY = 2;

type State = typeof CLEAN | typeof CHECK | typeof DIRTY;

interface Node<T = unknown> {
  value: T;
  /** absent for a plain signal */
  fn?: () => T;
  state: State;
  /** nodes this one read during its last computation */
  sources: Node[];
  /** nodes that read this one */
  observers: Node[];
  eq: (a: T, b: T) => boolean;
  /** effects are scheduled rather than pulled */
  isEffect: boolean;
  /** teardown returned by the previous effect run */
  cleanup?: () => void;
  disposed: boolean;
}

export interface Signal<T> {
  (): T;
}

export interface WritableSignal<T> extends Signal<T> {
  set(value: T): void;
  update(fn: (previous: T) => T): void;
}

/** The computation currently running, for automatic dependency tracking. */
let currentObserver: Node | null = null;
/** When true, reads do not register dependencies. */
let tracking = true;

let batchDepth = 0;
/** True while `flush` is draining, to keep reentrant writes iterative. */
let flushing = false;
const pendingEffects = new Set<Node>();

function link(source: Node, observer: Node): void {
  if (!source.observers.includes(observer)) source.observers.push(observer);
  if (!observer.sources.includes(source)) observer.sources.push(source);
}

function unlinkSources(node: Node): void {
  for (const source of node.sources) {
    const index = source.observers.indexOf(node);
    if (index >= 0) source.observers.splice(index, 1);
  }
  node.sources.length = 0;
}

/**
 * Propagate a change. Direct observers become DIRTY — they must recompute — while
 * everything further downstream becomes CHECK, meaning "one of my ancestors moved, ask my
 * sources whether it actually reached me".
 *
 * That distinction is the whole trick: CHECK nodes resolve lazily and often turn out not
 * to need recomputation at all.
 */
function markDownstream(node: Node, state: State): void {
  for (const observer of node.observers) {
    if (observer.disposed) continue;
    // A node already at least this stale needs no further marking; this also terminates
    // the walk on cycles in the *reactive* graph, which should not exist but must not hang.
    if (observer.state >= state) continue;
    observer.state = state;
    if (observer.isEffect) {
      pendingEffects.add(observer);
    } else {
      markDownstream(observer, CHECK);
    }
  }
}

function recompute<T>(node: Node<T>): void {
  if (!node.fn) return;

  node.cleanup?.();
  node.cleanup = undefined;

  const previousObserver = currentObserver;
  const previousTracking = tracking;
  currentObserver = node as Node;
  tracking = true;
  // Dependencies are re-derived every run, so a computation that reads different signals
  // on different runs (a conditional) is tracked correctly.
  unlinkSources(node as Node);

  /**
   * Marked clean *before* running, not after.
   *
   * If this were left until the `finally`, a write that happens *during* the computation
   * would find the node still flagged DIRTY, `markDownstream`'s "already at least this
   * stale" shortcut would skip it, and the node would then be forced CLEAN while holding
   * a value computed from data that has since moved. Clearing first means such a write
   * re-dirties the node honestly and it recomputes on the next read.
   *
   * A throw therefore also leaves it CLEAN with a stale value, which is deliberate: the
   * alternative is retrying a failing computation forever.
   */
  node.state = CLEAN;

  try {
    const next = node.fn();
    const changed = !node.eq(node.value, next);
    node.value = next;
    if (changed) markDownstream(node as Node, DIRTY);
  } finally {
    currentObserver = previousObserver;
    tracking = previousTracking;
  }
}

/** Bring a node up to date, recomputing only if a source genuinely changed. */
function validate(node: Node): void {
  if (node.disposed || node.state === CLEAN) return;

  if (node.state === CHECK) {
    for (const source of node.sources) {
      validate(source);
      // Validating a source may have marked this node DIRTY, at which point there is no
      // point checking the rest.
      if ((node.state as State) === DIRTY) break;
    }
  }

  if (node.state === DIRTY) recompute(node);
  else node.state = CLEAN;
}

function read<T>(node: Node<T>): T {
  if (node.fn) validate(node as Node);
  if (currentObserver && tracking) link(node as Node, currentObserver);
  return node.value;
}

function flush(): void {
  if (batchDepth > 0) return;
  // Reentrancy: an effect that writes a signal calls back in here. Returning immediately
  // lets the outer loop pick up whatever it queued, which keeps the drain iterative
  // instead of recursing until the stack overflows.
  if (flushing) return;

  flushing = true;
  // Effects may schedule further effects; drain until quiet. The guard is a safety net
  // against a genuinely cyclic effect graph rather than an expected condition.
  let guard = 0;
  try {
    while (pendingEffects.size > 0) {
      if (++guard > 10_000) {
        pendingEffects.clear();
        throw new Error(
          "signal: effects did not settle after 10000 rounds — is an effect writing a " +
            "signal it also reads?",
        );
      }
      const running = [...pendingEffects];
      pendingEffects.clear();
      for (const node of running) {
        if (!node.disposed) validate(node);
      }
    }
  } finally {
    flushing = false;
  }
}

export function signal<T>(
  initial: T,
  eq: (a: T, b: T) => boolean = Object.is,
): WritableSignal<T> {
  const node: Node<T> = {
    value: initial,
    state: CLEAN,
    sources: [],
    observers: [],
    eq,
    isEffect: false,
    disposed: false,
  };

  const accessor = (() => read(node)) as WritableSignal<T>;

  accessor.set = (value: T) => {
    if (node.eq(node.value, value)) return;
    node.value = value;
    markDownstream(node as Node, DIRTY);
    flush();
  };

  accessor.update = (fn: (previous: T) => T) => {
    accessor.set(fn(node.value));
  };

  return accessor;
}

export function computed<T>(
  fn: () => T,
  eq: (a: T, b: T) => boolean = Object.is,
): Signal<T> {
  const node: Node<T> = {
    // Starts DIRTY and is never evaluated until read — a computed nobody looks at costs
    // nothing, which matters when a document holds rows that are scrolled out of view.
    value: undefined as T,
    fn,
    state: DIRTY,
    sources: [],
    observers: [],
    eq,
    isEffect: false,
    disposed: false,
  };
  return () => read(node);
}

/**
 * Run `fn` now, and again whenever anything it read changes.
 *
 * A returned function is treated as teardown and runs before the next execution and on
 * dispose — which is how a DOM subscription or an animation frame gets cleaned up.
 */
export function effect(fn: () => void | (() => void)): () => void {
  const node: Node<undefined> = {
    value: undefined,
    state: DIRTY,
    sources: [],
    observers: [],
    eq: Object.is,
    isEffect: true,
    disposed: false,
  };

  node.fn = () => {
    const teardown = fn();
    node.cleanup = typeof teardown === "function" ? teardown : undefined;
    return undefined;
  };

  validate(node as Node);

  return () => {
    if (node.disposed) return;
    node.disposed = true;
    node.cleanup?.();
    node.cleanup = undefined;
    unlinkSources(node as Node);
    pendingEffects.delete(node as Node);
  };
}

/**
 * Apply several writes as one update, so effects run once at the end.
 *
 * Without this, setting three parameters would retessellate three times.
 */
export function batch<T>(fn: () => T): T {
  batchDepth++;
  try {
    return fn();
  } finally {
    batchDepth--;
    flush();
  }
}

/** Read without registering a dependency. */
export function untrack<T>(fn: () => T): T {
  const previous = tracking;
  tracking = false;
  try {
    return fn();
  } finally {
    tracking = previous;
  }
}
