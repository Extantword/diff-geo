import type { Item, RowId } from "./graph.ts";

/**
 * Which row an object is arranged *with*.
 *
 * An ambient space is a place, and everything written inside one is somewhere in it: a point at
 * (1, 2, 3) beside a torus is at (1, 2, 3) **of that torus's space**, and the sentence stops being
 * true the moment the two are moved independently. So arrangement is a property of the space
 * rather than of each object in it — dragging any member drags the whole thing, and a member has
 * no placement of its own to drift by.
 *
 * The chain is followed to the top rather than one level, because a space nests as far as the user
 * builds: a patch written in X's space can carry a field, a curve and a plane of its own, and all
 * of them are in X's space. Eight passes is a depth nobody reaches; a cycle — which the classifier
 * already reports as an error — stops there rather than spinning.
 */
export function spaceRoots(items: Iterable<Item>): Map<RowId, RowId> {
  const byName = new Map<string, Item>();
  const all: Item[] = [];
  for (const item of items) {
    all.push(item);
    if (item.name !== null) byName.set(item.name, item);
  }

  const roots = new Map<RowId, RowId>();
  for (const item of all) {
    let current = item;
    for (let step = 0; step < 8; step++) {
      const host = current.host == null ? null : byName.get(current.host) ?? null;
      if (host === null || host.rowId === item.rowId) break;
      current = host;
    }
    if (current.rowId !== item.rowId) roots.set(item.rowId, current.rowId);
  }
  return roots;
}

/**
 * The row that carries `rowId`'s placement: the root of its space, or itself.
 *
 * A lone object is its own root, so callers need no special case.
 */
export function arrangedWith(rowId: RowId, roots: ReadonlyMap<RowId, RowId>): RowId {
  return roots.get(rowId) ?? rowId;
}
