import { describe, expect, it } from "vitest";
import { createDocument, type RowId } from "../../src/state/graph.ts";
import {
  captureSession,
  makeSceneFile,
  readSceneFile,
  restoreSession,
  sessionKey,
  type SessionSlots,
  type SliderState,
} from "../../src/state/session.ts";
import type { Joint, Socket } from "../../src/state/assembly.ts";
import type { DomainRange, FrameRequest, SurfaceOverlay } from "../../src/state/scene.ts";
import type { Vec3 } from "../../src/core/geom/types.ts";
import type { Quat } from "../../src/core/num/quat.ts";

/**
 * The snapshot undo and hot reload both run on.
 *
 * What it has to get right is that a restore is a *replacement*, not a merge — undo has to remove
 * what an action added — and that everything keyed by a row survives being written by position,
 * since row ids are identities within one run of the document and nothing else.
 */

function makeSlots(sources: readonly string[]) {
  const document = createDocument(sources);
  let selected: RowId | null = null;
  let socket: Socket | null = null;
  const slots: SessionSlots = {
    document,
    sliders: new Map<string, SliderState>(),
    domains: new Map<RowId, DomainRange[]>(),
    colors: new Map<RowId, Vec3>(),
    translations: new Map<RowId, Vec3>(),
    rotations: new Map<RowId, Quat>(),
    overlays: new Map<RowId, SurfaceOverlay>(),
    frames: new Map<RowId, FrameRequest>(),
    inChart: new Set<RowId>(),
    joints: new Map<RowId, Joint>(),
    selected: () => selected,
    select: (rowId) => {
      selected = rowId;
    },
    socket: () => socket,
    setSocket: (next) => {
      socket = next;
    },
  };
  return slots;
}

const ids = (slots: SessionSlots) => slots.document.rows().map((row) => row.id);

describe("capture and restore", () => {
  it("puts back the text, the arrangement and the joints", () => {
    const slots = makeSlots(["X(u,v) = (u, v, 0)", "Y(u,v) = (u, v, 1)"]);
    const [first, second] = ids(slots);
    slots.translations.set(second!, [1, 2, 3]);
    slots.colors.set(first!, [0.2, 0.4, 0.6]);
    slots.joints.set(second!, {
      parent: first!,
      parentBoundary: "uMax",
      childBoundary: "uMin",
      roll: 1.25,
    });
    slots.domains.set(first!, [{ min: -1, max: 1 }, { min: 0, max: 2 }]);

    const snapshot = captureSession(slots);

    // Something else entirely happens.
    slots.document.rows()[0]!.source.set("X(u,v) = (u, v, u^2)");
    slots.document.addRow("Z(u,v) = (u, v, 2)");
    slots.translations.set(first!, [9, 9, 9]);
    slots.joints.clear();

    restoreSession(snapshot, slots);

    expect(slots.document.rows().map((row) => row.source())).toEqual([
      "X(u,v) = (u, v, 0)",
      "Y(u,v) = (u, v, 1)",
    ]);
    const [a, b] = ids(slots);
    expect(slots.translations.get(b!)).toEqual([1, 2, 3]);
    // A merge would have left this behind; undo has to be able to remove things.
    expect(slots.translations.has(a!)).toBe(false);
    expect(slots.joints.get(b!)?.roll).toBe(1.25);
    expect(slots.joints.get(b!)?.parent).toBe(a);
    expect(slots.domains.get(a!)).toEqual([{ min: -1, max: 1 }, { min: 0, max: 2 }]);
  });

  it("keeps row ids when only the text changed, so nothing is rebuilt under the user", () => {
    /**
     * Restoring through `setRows` would issue fresh ids, and every row's DOM view, its selection
     * and its caret go with them. Undoing a formula should not close the panel you are reading.
     */
    const slots = makeSlots(["X(u,v) = (u, v, 0)"]);
    const before = ids(slots);
    const snapshot = captureSession(slots);
    slots.document.rows()[0]!.source.set("X(u,v) = (u, v, 7)");

    restoreSession(snapshot, slots);
    expect(ids(slots)).toEqual(before);
    expect(slots.document.rows()[0]!.source()).toBe("X(u,v) = (u, v, 0)");
  });

  it("restores rows that were deleted, and drops rows that were added", () => {
    const slots = makeSlots(["a = 1", "b = 2", "c = 3"]);
    const snapshot = captureSession(slots);

    slots.document.removeRow(ids(slots)[1]!);
    restoreSession(snapshot, slots);
    expect(slots.document.rows().map((row) => row.source())).toEqual(["a = 1", "b = 2", "c = 3"]);

    slots.document.addRow("d = 4");
    restoreSession(snapshot, slots);
    expect(slots.document.rows().map((row) => row.source())).toEqual(["a = 1", "b = 2", "c = 3"]);
  });

  it("carries the parameters and the sliders", () => {
    const slots = makeSlots(["R = 2"]);
    slots.document.setParameter("R", 2);
    slots.sliders.set("R", { value: 2, min: 0, max: 5, step: 0.1 });
    const snapshot = captureSession(slots);

    slots.document.setParameter("R", 4);
    slots.sliders.set("R", { value: 4, min: 0, max: 5, step: 0.1 });
    slots.sliders.set("S", { value: 1, min: 0, max: 2, step: 0.1 });

    restoreSession(snapshot, slots);
    expect(slots.document.parameters().get("R")).toBe(2);
    expect(slots.sliders.get("R")?.value).toBe(2);
    // The slider that was created after the snapshot is gone with it.
    expect(slots.sliders.has("S")).toBe(false);
  });
});

describe("what counts as a change", () => {
  it("ignores the selection and the chosen socket", () => {
    /**
     * Looking at something is not an edit. If it were, every click on a ring would cost an undo
     * step, and getting back past one would take two presses for reasons nobody could see.
     */
    const slots = makeSlots(["X(u,v) = (u, v, 0)"]);
    const before = sessionKey(captureSession(slots));

    slots.select(ids(slots)[0]!);
    slots.setSocket({ rowId: ids(slots)[0]!, boundary: "uMax" });
    expect(sessionKey(captureSession(slots))).toBe(before);

    slots.translations.set(ids(slots)[0]!, [1, 0, 0]);
    expect(sessionKey(captureSession(slots))).not.toBe(before);
  });

  it("is stable under the order things were put in the maps", () => {
    // Two snapshots of the same scene must compare equal, or the history would record edits
    // nobody made.
    const slots = makeSlots(["a = 1", "b = 2"]);
    const [first, second] = ids(slots);
    slots.colors.set(second!, [1, 0, 0]);
    slots.colors.set(first!, [0, 1, 0]);
    const one = sessionKey(captureSession(slots));

    slots.colors.clear();
    slots.colors.set(first!, [0, 1, 0]);
    slots.colors.set(second!, [1, 0, 0]);
    expect(sessionKey(captureSession(slots))).toBe(one);
  });

  it("ignores state left behind for rows that no longer exist", () => {
    const slots = makeSlots(["a = 1", "b = 2"]);
    const doomed = ids(slots)[1]!;
    slots.document.removeRow(doomed);
    const clean = sessionKey(captureSession(slots));

    // The app's maps are keyed by row id and are not swept when a row goes; a snapshot that
    // carried the debris would differ from one taken a moment later for no visible reason.
    slots.colors.set(doomed, [1, 0, 0]);
    expect(sessionKey(captureSession(slots))).toBe(clean);
  });
});

describe("a scene on disk", () => {
  it("writes a tagged, versioned file and reads it back", () => {
    const slots = makeSlots(["X(u,v) = (u, v, 0)"]);
    slots.translations.set(ids(slots)[0]!, [1, 2, 3]);

    const text = JSON.stringify(makeSceneFile(captureSession(slots), { fake: "camera" }));
    const read = readSceneFile(text);
    expect("error" in read).toBe(false);
    if ("error" in read) return;

    expect(read.camera).toEqual({ fake: "camera" });
    // Into a fresh document, which is what opening a file actually does.
    const fresh = makeSlots(["something else"]);
    restoreSession(read.scene, fresh);
    expect(fresh.document.rows().map((row) => row.source())).toEqual(["X(u,v) = (u, v, 0)"]);
    expect(fresh.translations.get(ids(fresh)[0]!)).toEqual([1, 2, 3]);
  });

  it("refuses what is not a scene, with a sentence rather than a throw", () => {
    // Opening the wrong file is an ordinary thing to do.
    expect(readSceneFile("not json at all")).toEqual({ error: "that file is not JSON" });
    expect(readSceneFile("[1, 2, 3]")).toHaveProperty("error");
    expect(readSceneFile(JSON.stringify({ format: "something/else" }))).toHaveProperty("error");
    expect(
      readSceneFile(JSON.stringify({ format: "diffgeo/scene", version: 1, scene: {} })),
    ).toHaveProperty("error");
  });

  it("refuses a file from a newer version rather than half-reading it", () => {
    const text = JSON.stringify({ format: "diffgeo/scene", version: 99, scene: { rows: [] } });
    const read = readSceneFile(text);
    expect("error" in read && read.error).toContain("newer version");
  });

  it("opens a scene that predates a collection it does not have", () => {
    // The format has to be able to grow: a file written before joints existed is still a scene.
    const text = JSON.stringify({
      format: "diffgeo/scene",
      version: 1,
      scene: { rows: ["a = 1"] },
    });
    const read = readSceneFile(text);
    expect("error" in read).toBe(false);
    if ("error" in read) return;
    expect(read.scene.joints).toEqual([]);

    const slots = makeSlots([]);
    restoreSession(read.scene, slots);
    expect(slots.document.rows().map((row) => row.source())).toEqual(["a = 1"]);
  });
});
