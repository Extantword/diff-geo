import type { Vec3 } from "../core/geom/types.ts";
import type { BoundaryName } from "../core/geom/ports.ts";
import type { Quat } from "../core/num/quat.ts";
import type { Joint, Socket } from "./assembly.ts";
import type { DocumentStore, RowId } from "./graph.ts";
import type { DomainRange, FrameRequest, SurfaceOverlay } from "./scene.ts";

/**
 * The whole scene as plain data: everything the user made, and nothing derived.
 *
 * One snapshot type serves two jobs that would otherwise be written twice and drift apart —
 * carrying a scene across a hot reload, and undo. They need exactly the same thing, so they share
 * exactly one capture and one restore, and any state added later is picked up by both or by
 * neither.
 *
 * ## Rows are identified by POSITION, never by id
 *
 * Row ids are identities within one run of the document; they are handed out fresh and the per-row
 * caches key off them. A snapshot that stored ids would, after a reload, attach a colour to
 * whichever row happened to be issued that number. Position survives both round trips, so every
 * per-row map is written as `[index, value]`.
 *
 * ## What is durable and what is transient
 *
 * The selection and the chosen socket are stored but excluded from `sessionKey`. Undo therefore
 * puts them back when it moves, while *changing* them creates no undo step of its own — clicking
 * a ring to look at it is not an edit, and having to press Ctrl-Z twice to get past it would be.
 */

/** Structurally the UI's `SliderSpec`, restated so `state` need not import from `ui`. */
export interface SliderState {
  value: number;
  min: number;
  max: number;
  step: number;
}

/** `[child, parent, parent's boundary, child's boundary, roll]`, rows by position. */
export type SavedJoint = readonly [number, number, BoundaryName, BoundaryName, number];

export interface SessionState {
  readonly rows: readonly string[];
  readonly parameters: readonly (readonly [string, number])[];
  readonly sliders: readonly (readonly [string, SliderState])[];
  readonly domains: readonly (readonly [number, readonly DomainRange[]])[];
  readonly colors: readonly (readonly [number, Vec3])[];
  readonly translations: readonly (readonly [number, Vec3])[];
  readonly rotations: readonly (readonly [number, Quat])[];
  readonly overlays: readonly (readonly [number, SurfaceOverlay])[];
  readonly frames: readonly (readonly [number, FrameRequest])[];
  readonly inChart: readonly number[];
  readonly joints: readonly SavedJoint[];
  /** transient: restored, but not part of what counts as a change */
  readonly selected: number | null;
  readonly socket: readonly [number, BoundaryName] | null;
}

/** The live state the app owns, which a snapshot is taken of and written back into. */
export interface SessionSlots {
  readonly document: DocumentStore;
  readonly sliders: Map<string, SliderState>;
  readonly domains: Map<RowId, DomainRange[]>;
  readonly colors: Map<RowId, Vec3>;
  readonly translations: Map<RowId, Vec3>;
  readonly rotations: Map<RowId, Quat>;
  readonly overlays: Map<RowId, SurfaceOverlay>;
  readonly frames: Map<RowId, FrameRequest>;
  readonly inChart: Set<RowId>;
  readonly joints: Map<RowId, Joint>;
  selected(): RowId | null;
  select(rowId: RowId | null): void;
  socket(): Socket | null;
  setSocket(socket: Socket | null): void;
}

export function captureSession(slots: SessionSlots): SessionState {
  const rows = slots.document.rows();
  const position = new Map<RowId, number>(rows.map((row, index) => [row.id, index]));

  /**
   * Per-row state, by position, in position order.
   *
   * Entries for rows that no longer exist are dropped rather than carried: a map keyed by row id
   * accumulates them as rows come and go, and a snapshot that included them would differ from one
   * taken a moment later for no reason the user could see — which, since the undo stack compares
   * snapshots, would look like an edit nobody made.
   */
  const byPosition = <T>(map: ReadonlyMap<RowId, T>): (readonly [number, T])[] =>
    [...map]
      .flatMap(([id, value]) => {
        const at = position.get(id);
        return at === undefined ? [] : [[at, value] as const];
      })
      .sort((a, b) => a[0] - b[0]);

  const socket = slots.socket();
  const socketAt = socket ? position.get(socket.rowId) : undefined;
  const selected = slots.selected();
  const selectedAt = selected === null ? undefined : position.get(selected);

  return {
    rows: rows.map((row) => row.source()),
    // Sorted, so two snapshots of the same state always compare equal.
    parameters: [...slots.document.parameters()].sort((a, b) => a[0].localeCompare(b[0])),
    sliders: [...slots.sliders]
      .map(([name, spec]) => [name, { ...spec }] as const)
      .sort((a, b) => a[0].localeCompare(b[0])),
    domains: byPosition(slots.domains).map(([at, ranges]) => [at, ranges.map((r) => ({ ...r }))]),
    colors: byPosition(slots.colors).map(([at, color]) => [at, [...color] as Vec3]),
    translations: byPosition(slots.translations).map(([at, v]) => [at, [...v] as Vec3]),
    rotations: byPosition(slots.rotations).map(([at, q]) => [at, [...q] as unknown as Quat]),
    overlays: byPosition(slots.overlays).map(([at, overlay]) => [at, { ...overlay }]),
    frames: byPosition(slots.frames).map(([at, frame]) => [at, { ...frame }]),
    inChart: [...slots.inChart]
      .flatMap((id) => {
        const at = position.get(id);
        return at === undefined ? [] : [at];
      })
      .sort((a, b) => a - b),
    joints: [...slots.joints]
      .flatMap(([child, joint]) => {
        const childAt = position.get(child);
        const parentAt = position.get(joint.parent);
        if (childAt === undefined || parentAt === undefined) return [];
        return [
          [childAt, parentAt, joint.parentBoundary, joint.childBoundary, joint.roll] as SavedJoint,
        ];
      })
      .sort((a, b) => a[0] - b[0]),
    selected: selectedAt ?? null,
    socket: socketAt === undefined || !socket ? null : [socketAt, socket.boundary],
  };
}

/**
 * Write a snapshot back over the live state.
 *
 * Rows are reconciled **in place** wherever possible — the text of an existing row is reassigned
 * rather than the whole document replaced. `setRows` issues fresh ids, which throws away every
 * row's DOM view, its selection and its caret; undoing a dragged object should not close the
 * panel you were reading. Only the count is adjusted, at the tail.
 *
 * Every per-row map is cleared before being refilled, so that undo genuinely *removes* what an
 * action added. Merging instead would make setting a colour irreversible.
 */
export function restoreSession(state: SessionState, slots: SessionSlots): void {
  const { document } = slots;

  for (let i = document.rows().length - 1; i >= state.rows.length; i--) {
    const row = document.rows()[i];
    if (row) document.removeRow(row.id);
  }
  for (let i = document.rows().length; i < state.rows.length; i++) document.addRow("");

  const rows = document.rows();
  rows.forEach((row, index) => {
    const text = state.rows[index] ?? "";
    if (row.source() !== text) row.source.set(text);
  });

  const idAt = (index: number): RowId | undefined => rows[index]?.id;
  const refill = <T>(map: Map<RowId, T>, entries: readonly (readonly [number, T])[]) => {
    map.clear();
    for (const [at, value] of entries) {
      const id = idAt(at);
      if (id !== undefined) map.set(id, value);
    }
  };

  refill(slots.domains, state.domains.map(([at, ranges]) => [at, ranges.map((r) => ({ ...r }))]));
  refill(slots.colors, state.colors.map(([at, color]) => [at, [...color] as Vec3]));
  refill(slots.translations, state.translations.map(([at, v]) => [at, [...v] as Vec3]));
  refill(slots.rotations, state.rotations.map(([at, q]) => [at, [...q] as unknown as Quat]));
  refill(slots.overlays, state.overlays.map(([at, overlay]) => [at, { ...overlay }]));
  refill(slots.frames, state.frames.map(([at, frame]) => [at, { ...frame }]));

  slots.inChart.clear();
  for (const at of state.inChart) {
    const id = idAt(at);
    if (id !== undefined) slots.inChart.add(id);
  }

  slots.joints.clear();
  for (const [childAt, parentAt, parentBoundary, childBoundary, roll] of state.joints) {
    const child = idAt(childAt);
    const parent = idAt(parentAt);
    if (child !== undefined && parent !== undefined) {
      slots.joints.set(child, { parent, parentBoundary, childBoundary, roll });
    }
  }

  slots.sliders.clear();
  for (const [name, spec] of state.sliders) slots.sliders.set(name, { ...spec });
  for (const [name, value] of state.parameters) document.setParameter(name, value);

  const socketRow = state.socket ? idAt(state.socket[0]) : undefined;
  slots.setSocket(
    state.socket && socketRow !== undefined
      ? { rowId: socketRow, boundary: state.socket[1] }
      : null,
  );
  slots.select(state.selected === null ? null : idAt(state.selected) ?? null);
}

/**
 * A saved scene, as it appears on disk.
 *
 * Tagged and versioned, because a file outlives the code that wrote it: the tag is what lets a
 * wrong file be refused with a sentence instead of a stack trace, and the version is what a later
 * reader migrates from. The camera rides along — it is not part of the document and so not
 * something to undo, but it very much is part of the figure you saved.
 */
export interface SceneFile {
  readonly format: "diffgeo/scene";
  readonly version: 1;
  readonly scene: SessionState;
  readonly camera?: unknown;
}

export const SCENE_FILE_FORMAT = "diffgeo/scene";
export const SCENE_FILE_VERSION = 1;

export function makeSceneFile(scene: SessionState, camera?: unknown): SceneFile {
  return { format: SCENE_FILE_FORMAT, version: SCENE_FILE_VERSION, scene, camera };
}

/**
 * Read a saved scene, or say why it cannot be read.
 *
 * Returns a message rather than throwing: opening the wrong file is an ordinary thing to do, and
 * the answer to it is a sentence in the panel, not a broken app. Only the fields that are
 * load-bearing are checked — `rows` is what everything else is indexed against, so a file without
 * it cannot be restored no matter what else it holds.
 */
export function readSceneFile(
  text: string,
): { scene: SessionState; camera?: unknown } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: "that file is not JSON" };
  }
  if (typeof parsed !== "object" || parsed === null) return { error: "that file is not a scene" };

  const file = parsed as Partial<SceneFile>;
  if (file.format !== SCENE_FILE_FORMAT) return { error: "that file is not a DiffGeo scene" };
  if (typeof file.version !== "number" || file.version > SCENE_FILE_VERSION) {
    return { error: `that scene was written by a newer version (${String(file.version)})` };
  }
  const scene = file.scene as SessionState | undefined;
  if (!scene || !Array.isArray(scene.rows)) return { error: "that scene has no rows in it" };
  if (!scene.rows.every((row) => typeof row === "string")) {
    return { error: "that scene's rows are not text" };
  }

  /**
   * Missing collections become empty ones rather than a refusal.
   *
   * A scene saved before some feature existed simply has none of it, and that is a scene that
   * should still open — the alternative is a file format nobody can ever add anything to.
   */
  return {
    scene: {
      ...scene,
      parameters: scene.parameters ?? [],
      sliders: scene.sliders ?? [],
      domains: scene.domains ?? [],
      colors: scene.colors ?? [],
      translations: scene.translations ?? [],
      rotations: scene.rotations ?? [],
      overlays: scene.overlays ?? [],
      frames: scene.frames ?? [],
      inChart: scene.inChart ?? [],
      joints: scene.joints ?? [],
      selected: scene.selected ?? null,
      socket: scene.socket ?? null,
    },
    camera: file.camera,
  };
}

/**
 * What counts as a different scene, for the undo stack.
 *
 * Everything durable, and nothing else: the selection and the chosen socket are deliberately
 * absent, so looking at something is never an undo step.
 */
export function sessionKey(state: SessionState): string {
  const { selected: _selected, socket: _socket, ...durable } = state;
  return JSON.stringify(durable);
}
