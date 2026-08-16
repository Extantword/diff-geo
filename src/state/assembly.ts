import {
  IDENTITY_PLACEMENT,
  matePlacement,
  transformPort,
  type BoundaryName,
  type Placement,
  type Port,
} from "../core/geom/ports.ts";
import type { RowId } from "./graph.ts";

/**
 * Assembly: objects held together by their boundaries.
 *
 * A **joint** says that one row's boundary is plugged into another's. Where it sits is then not
 * arrangement any more — it is derived, every frame, from the parent's placement and the two
 * measured port frames. So moving or turning a parent carries its whole subtree with it for free,
 * and nothing can drift out of alignment, because there is no stored transform to drift: the
 * child's placement is recomputed from the joint each time.
 *
 * A row with no joint is a **root** and keeps whatever arrangement the user gave it by hand.
 *
 * ## Why the ports are passed in rather than looked up
 *
 * Ports are measured from the compiled parametrization (`geom/ports.ts`), which only exists inside
 * the scene build. Taking them as an argument keeps this file arithmetic over a graph — no
 * evaluation, no geometry — which is what makes it testable without compiling anything.
 */

export interface Joint {
  /** the row this one is attached to */
  readonly parent: RowId;
  /** the parent's boundary being plugged into */
  readonly parentBoundary: BoundaryName;
  /** this row's boundary doing the plugging */
  readonly childBoundary: BoundaryName;
  /** turn about the shared axis, in radians */
  readonly roll: number;
}

/** Names a boundary of a particular row: what a socket in the UI actually is. */
export interface Socket {
  readonly rowId: RowId;
  readonly boundary: BoundaryName;
}

export interface AssemblyRequest {
  /** child row → the joint holding it */
  readonly joints: ReadonlyMap<RowId, Joint>;
  /** every row's ports, in that row's own coordinates */
  readonly localPorts: ReadonlyMap<RowId, readonly Port[]>;
  /** where a row sits when nothing holds it: its hand arrangement */
  readonly free: (rowId: RowId) => Placement;
}

export interface AssemblyResult {
  /** every row's placement in the world, joints resolved */
  readonly placements: Map<RowId, Placement>;
  /** rows whose joint could not be honoured, and why */
  readonly broken: Map<RowId, string>;
}

/**
 * Resolve every row's placement, following joints up to their roots.
 *
 * Depth-first with memoisation, so a chain of twenty pieces costs twenty mates rather than four
 * hundred. A joint that cannot be honoured — a missing parent, a boundary that turned out not to
 * be a port, a cycle — leaves the row a root and is reported rather than thrown: the user is
 * usually mid-edit, and a broken formula upstream should loosen a piece, not blank the scene.
 */
export function resolveAssembly(
  rows: Iterable<RowId>,
  request: AssemblyRequest,
): AssemblyResult {
  const placements = new Map<RowId, Placement>();
  const broken = new Map<RowId, string>();
  const visiting = new Set<RowId>();

  const portOf = (rowId: RowId, boundary: BoundaryName): Port | undefined =>
    request.localPorts.get(rowId)?.find((port) => port.boundary === boundary);

  const resolve = (rowId: RowId): Placement => {
    const done = placements.get(rowId);
    if (done) return done;

    const joint = request.joints.get(rowId);
    let placement = request.free(rowId);

    if (joint) {
      if (visiting.has(rowId)) {
        // A cycle of joints has no root to measure from. Breaking it here rather than detecting
        // it up front keeps the failure local: the row that closed the loop comes loose, and
        // everything before it stays assembled.
        broken.set(rowId, "this joint closes a loop, so it was left loose");
      } else {
        visiting.add(rowId);
        const parentPlacement = resolve(joint.parent);
        visiting.delete(rowId);

        const socket = portOf(joint.parent, joint.parentBoundary);
        const plug = portOf(rowId, joint.childBoundary);
        if (!socket) {
          broken.set(rowId, `nothing to attach to on ${joint.parentBoundary} of the parent`);
        } else if (!plug) {
          broken.set(rowId, `this object has no ${joint.childBoundary} boundary to attach with`);
        } else {
          placement = matePlacement(
            transformPort(socket, parentPlacement),
            plug,
            joint.roll,
          );
        }
      }
    }

    placements.set(rowId, placement);
    return placement;
  };

  for (const rowId of rows) resolve(rowId);
  return { placements, broken };
}

/** Every socket already spoken for: both sides of each joint. */
export function occupiedSockets(joints: ReadonlyMap<RowId, Joint>): Set<string> {
  const used = new Set<string>();
  for (const [child, joint] of joints) {
    used.add(socketKey({ rowId: joint.parent, boundary: joint.parentBoundary }));
    used.add(socketKey({ rowId: child, boundary: joint.childBoundary }));
  }
  return used;
}

export function socketKey(socket: Socket): string {
  return `${socket.rowId}:${socket.boundary}`;
}

export function sameSocket(a: Socket | null, b: Socket | null): boolean {
  if (!a || !b) return a === b;
  return a.rowId === b.rowId && a.boundary === b.boundary;
}

/**
 * The row at the top of an assembly — the one whose hand arrangement moves the whole thing.
 *
 * Dragging a piece in the middle of a chain has to move the root, because every other placement is
 * derived from it; moving the piece itself would be overwritten by the next rebuild.
 */
export function rootOf(rowId: RowId, joints: ReadonlyMap<RowId, Joint>): RowId {
  const seen = new Set<RowId>([rowId]);
  let current = rowId;
  for (;;) {
    const joint = joints.get(current);
    if (!joint || seen.has(joint.parent)) return current;
    seen.add(joint.parent);
    current = joint.parent;
  }
}

/**
 * How far a patch is twisted about the build direction, relative to the root of its surface.
 *
 * A joint's `roll` is **relative**: zero means the plug's phase reference lands on the socket's,
 * so a piece placed at zero continues its parent's seam rather than resetting to the one its own
 * parametrization has. That is what makes a chain keep its banking for free — but the twist a user
 * sees is the *sum* down the chain, and that sum is the number a control has to speak in. Setting
 * the dial to 30° and clicking four times should give four pieces at 30°, not one at 30° and the
 * last at 120°.
 *
 * Rolls about successive joints are added even though an elbow turns the axis between them. That
 * is the right arithmetic for the quantity being tracked: each relative roll says how much the
 * seam was twisted at that joint, so the total says how far it has drifted from a run that never
 * twisted at all.
 */
export function absoluteRoll(rowId: RowId, joints: ReadonlyMap<RowId, Joint>): number {
  const seen = new Set<RowId>([rowId]);
  let total = 0;
  let current = rowId;
  for (;;) {
    const joint = joints.get(current);
    if (!joint || seen.has(joint.parent)) return total;
    total += joint.roll;
    seen.add(joint.parent);
    current = joint.parent;
  }
}

/**
 * An angle in [0, 2π).
 *
 * Joint rolls are stored this way so the control showing one never has to render a negative:
 * placing a piece at an absolute 30° behind a parent already at 50° needs a relative −20°, and a
 * slider running 0…360 would clamp that to zero and silently untwist the piece the moment it was
 * touched.
 */
export function normalizeRoll(angle: number): number {
  if (!Number.isFinite(angle)) return 0;
  const turn = 2 * Math.PI;
  return ((angle % turn) + turn) % turn;
}

/** Drop joints referring to rows that no longer exist, so a deleted piece releases its children. */
export function pruneJoints(joints: Map<RowId, Joint>, alive: ReadonlySet<RowId>): boolean {
  let changed = false;
  for (const [child, joint] of joints) {
    if (!alive.has(child) || !alive.has(joint.parent)) {
      joints.delete(child);
      changed = true;
    }
  }
  return changed;
}

/** A placement that does nothing, for rows with no arrangement of their own. */
export const FREE_PLACEMENT = IDENTITY_PLACEMENT;
