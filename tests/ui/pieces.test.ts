// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { createDocument, type RowId } from "../../src/state/graph.ts";
import { createPiecePicker } from "../../src/ui/pieces.ts";
import { absoluteRoll, type Joint, type Socket } from "../../src/state/assembly.ts";
import type { DomainRange, ScenePort } from "../../src/state/scene.ts";
import type { BoundaryName, Port } from "../../src/core/geom/ports.ts";

/**
 * The parts bin, as wiring.
 *
 * What a click on a piece is supposed to do — generate it **at the socket's size**, record the
 * joint, carry the domain across, and move the socket to the new piece's far end so the next
 * click extends the chain — is all interaction, invisible to the geometry suite.
 */

function socketPort(
  rowId: RowId,
  boundary: BoundaryName,
  kind: Port["kind"],
  size: number,
): ScenePort {
  return {
    rowId,
    free: true,
    port: {
      boundary,
      kind,
      size,
      origin: [0, 0, 0],
      axis: [0, 0, 1],
      up: [1, 0, 0],
      deviation: 0,
    },
  };
}

function makeBin(socket: ScenePort | null) {
  const store = createDocument(["X(u,v) = (cos v, sin v, u)"]);
  let current = socket;
  const joints = new Map<RowId, Joint>();
  const domains = new Map<RowId, DomainRange[]>();
  let active: Socket | null = socket
    ? { rowId: socket.rowId, boundary: socket.port.boundary }
    : null;
  let loose: RowId | null = null;
  let renders = 0;

  const bin = createPiecePicker({
    document: store,
    domains,
    joints,
    socket: () => current,
    setSocket: (next) => {
      active = next;
      /**
       * Follow the chain, as the next scene build would.
       *
       * The panel names the socket; the scene is what measures a port there. Standing in for it
       * with a port of the same kind and size is what lets a test lay a run of pieces the way a
       * user does, one click after another.
       */
      const kind = current?.port.kind ?? "circle";
      const size = current?.port.size ?? 1;
      current = next ? socketPort(next.rowId, next.boundary, kind, size) : null;
    },
    selected: () => null,
    surfaceOf: () => null,
    detach: () => {},
    requestRender: () => {
      renders++;
    },
    onParameterChange: () => {},
    onCreated: (rowId) => {
      loose = rowId;
    },
  });

  const button = (name: string) => {
    const node = [...bin.root.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === name,
    );
    expect(node, `no ${name} button`).toBeDefined();
    return node!;
  };

  const click = (name: string) => button(name).click();

  /** Drag the "roll of new pieces" dial, which is the only range control until one is selected. */
  const setRoll = (degrees: number) => {
    const dial = bin.root.querySelector("input[type=range]") as HTMLInputElement;
    expect(dial, "no roll dial").toBeTruthy();
    dial.value = String(degrees);
    dial.dispatchEvent(new Event("input"));
  };

  /** Move on to the next socket, as clicking a ring on the stage would. */
  const focus = (port: ScenePort | null) => {
    current = port;
  };

  return {
    store,
    joints,
    domains,
    click,
    button,
    setRoll,
    focus,
    bin,
    socketAfter: () => active,
    looseRow: () => loose,
    renders: () => renders,
  };
}

describe("placing a piece", () => {
  it("generates it at the socket's size and records the joint", () => {
    const parent = 1 as RowId;
    const bin = makeBin(socketPort(parent, "uMax", "circle", 0.5));
    bin.click("Tube");

    const rows = bin.store.rows();
    expect(rows).toHaveLength(2);
    const added = rows[1]!;
    // Sized to the socket, in the formula itself — that is what makes the rims agree exactly
    // rather than nearly, and it is visible in the source the user can go on to edit.
    expect(added.source()).toContain("0.5 cos v");

    const joint = bin.joints.get(added.id);
    expect(joint).toEqual({
      parent,
      parentBoundary: "uMax",
      childBoundary: "uMin",
      roll: 0,
    });

    // The domain travels with it, or the piece would be sampled over the default 0…2π in both
    // coordinates and come out the wrong length entirely.
    const domain = bin.domains.get(added.id)!;
    expect(domain[0]).toEqual({ min: 0, max: 1 });
    expect(domain[1]!.max).toBeCloseTo(2 * Math.PI, 12);

    // Chaining: the far end becomes the next socket, so clicking Tube again extends it.
    expect(bin.socketAfter()).toEqual({ rowId: added.id, boundary: "uMax" });
    expect(bin.renders()).toBe(1);
  });

  it("drops a piece loose when nothing is selected, and leaves no joint behind", () => {
    const bin = makeBin(null);
    bin.click("Dome");

    const added = bin.store.rows()[1]!;
    expect(bin.joints.size).toBe(0);
    // Placed by the app rather than left at the origin, where it would sit inside whatever is
    // already there.
    expect(bin.looseRow()).toBe(added.id);
    // A cap has no far end, so there is nothing to chain onto.
    expect(bin.socketAfter()).toBeNull();
  });

  it("offers only what can be joined to the chosen socket", () => {
    // A straight edge takes a plate or a fold. A tube plugs into a rim, so it is not on offer
    // here at all — the alternative is a join that does not meet, or a piece silently dropped
    // somewhere else in the scene.
    const bin = makeBin(socketPort(1 as RowId, "uMax", "segment", 1));
    bin.bin.refresh();

    expect(bin.button("Tube").disabled).toBe(true);
    expect(bin.button("Dome").disabled).toBe(true);
    expect(bin.button("Plate").disabled).toBe(false);
    expect(bin.button("Fold").disabled).toBe(false);
    // And the reason is on the button rather than left to be guessed at.
    expect(bin.button("Tube").title).toContain("rim");

    bin.click("Tube");
    expect(bin.store.rows()).toHaveLength(1);
  });

  it("offers everything when no socket is chosen, since nothing is being joined", () => {
    const bin = makeBin(null);
    bin.bin.refresh();
    for (const name of ["Tube", "Dome", "Plate", "Fold"]) {
      expect(bin.button(name).disabled, name).toBe(false);
    }
  });

  it("sizes a plate to the edge it is joined to", () => {
    const bin = makeBin(socketPort(1 as RowId, "vMax", "segment", 2));
    bin.click("Plate");

    const added = bin.store.rows()[1]!;
    expect(bin.joints.get(added.id)?.parentBoundary).toBe("vMax");
    expect(bin.domains.get(added.id)![0]).toEqual({ min: -2, max: 2 });
  });
});

describe("a long chain", () => {
  it("keeps every patch a real surface past the letters of the alphabet", () => {
    /**
     * The regression this file exists for.
     *
     * Names ran X, Y, Z, W, P, Q and then `X2`, which lexes as `X · 2` — so the seventh piece was
     * a parse error that drew nothing, and since a broken row declares no name, every piece after
     * it was handed `X2` as well. On screen: elbows that were placed, joined, and invisible.
     */
    const bin = makeBin(socketPort(1 as RowId, "uMax", "circle", 1));
    for (let i = 0; i < 12; i++) bin.click("Elbow");

    const rows = bin.store.rows();
    // The document started with one patch of its own.
    expect(rows).toHaveLength(13);

    const items = [...bin.store.resolution().items.values()];
    expect(items.filter((item) => item.kind === "parametricSurface")).toHaveLength(13);

    // Every one of them named differently, or they would be one definition overwritten twelve
    // times rather than thirteen objects.
    const names = items.map((item) => item.name);
    expect(new Set(names).size).toBe(13);
    // And every one of them joined to the one before it.
    expect(bin.joints.size).toBe(12);
  });
});

describe("the roll of new pieces", () => {
  const rim = (rowId: RowId) => socketPort(rowId, "uMax", "circle", 1);

  it("places a piece at the roll on the dial", () => {
    const bin = makeBin(rim(1 as RowId));
    bin.setRoll(30);
    bin.click("Tube");

    const added = bin.store.rows()[1]!;
    expect(bin.joints.get(added.id)!.roll).toBeCloseTo(Math.PI / 6, 9);
  });

  it("keeps the run at that roll instead of twisting further at every joint", () => {
    /**
     * The point of the dial reading as an absolute. A joint's roll is relative to its parent, so
     * re-applying 30° at each one would spiral: 30°, 60°, 90°. What goes into each joint is the
     * difference from what the chain has already accumulated, so the second piece needs none.
     */
    const bin = makeBin(rim(1 as RowId));
    bin.setRoll(30);
    bin.click("Tube");
    const first = bin.store.rows()[1]!;

    bin.focus(rim(first.id));
    bin.click("Tube");
    const second = bin.store.rows()[2]!;

    expect(bin.joints.get(second.id)!.roll).toBeCloseTo(0, 9);
    // Both patches are twisted by the same 30° from the root, which is what "keeps its banking"
    // means once the rolls are added down the chain.
    expect(absoluteRoll(second.id, bin.joints)).toBeCloseTo(Math.PI / 6, 9);
  });

  it("turns only from where the dial was changed, not retroactively", () => {
    const bin = makeBin(rim(1 as RowId));
    bin.setRoll(30);
    bin.click("Tube");
    const first = bin.store.rows()[1]!;

    bin.focus(rim(first.id));
    bin.setRoll(90);
    bin.click("Tube");
    const second = bin.store.rows()[2]!;

    // 60° more at this joint, landing the piece at the 90° asked for.
    expect(bin.joints.get(second.id)!.roll).toBeCloseTo(Math.PI / 3, 9);
    expect(absoluteRoll(second.id, bin.joints)).toBeCloseTo(Math.PI / 2, 9);
    // And the piece before it is untouched.
    expect(bin.joints.get(first.id)!.roll).toBeCloseTo(Math.PI / 6, 9);
  });

  it("never asks a joint for a negative roll, which a 0…360 control could not show", () => {
    const bin = makeBin(rim(1 as RowId));
    bin.setRoll(90);
    bin.click("Tube");
    const first = bin.store.rows()[1]!;

    bin.focus(rim(first.id));
    bin.setRoll(30);
    bin.click("Tube");
    const second = bin.store.rows()[2]!;

    const roll = bin.joints.get(second.id)!.roll;
    expect(roll).toBeGreaterThan(0);
    // −60° wrapped to 300°, which is the same rotation.
    expect(roll).toBeCloseTo((5 * Math.PI) / 3, 9);
  });
});

describe("the socket line", () => {
  it("says what is being attached to, and what is not", () => {
    expect(makeBin(null).bin.root.textContent).toContain("no socket");
    const bin = makeBin(socketPort(1 as RowId, "uMax", "circle", 0.5));
    bin.bin.refresh();
    expect(bin.bin.root.textContent).toContain("rim");
    expect(bin.bin.root.textContent).toContain("0.500");
  });
});
