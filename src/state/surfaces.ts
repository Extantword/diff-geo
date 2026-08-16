import type { Joint } from "./assembly.ts";
import { rootOf } from "./assembly.ts";
import type { RowId } from "./graph.ts";

/**
 * A **surface** is what a set of joined coordinate patches makes.
 *
 * The vocabulary is do Carmo's and it matters here, because the two things are now genuinely
 * different objects. A row carrying `X(u,v) = (…)` is a **coordinate patch**: one chart, one
 * rectangle of parameters, one image in R³. A surface is the thing built out of patches glued
 * along their boundaries — which is exactly what a joint asserts. A lone patch is a surface with
 * one chart, so nothing needs a special case.
 *
 * This is derived, never stored. Joints are the source of truth and the components fall out of
 * them, so there is no second structure to keep in step: attaching a piece extends a surface,
 * detaching one splits it, and deleting a patch in the middle of a chain leaves two surfaces —
 * all without anything here being told.
 */

export interface Surface {
  /** short, stable while the assembly is only added to: S1, S2, … */
  readonly name: string;
  /** the patch whose hand arrangement places the whole surface */
  readonly root: RowId;
  /** every patch of it, the root first and the rest in document order */
  readonly patches: readonly RowId[];
}

/**
 * Group patches into surfaces by following joints to their roots.
 *
 * Numbered by where each surface's root sits in the document, so adding a piece to the first
 * surface cannot renumber the second — a name that jumped around as the scene was built would be
 * useless for talking about what you are looking at.
 */
export function groupSurfaces(
  patches: readonly RowId[],
  joints: ReadonlyMap<RowId, Joint>,
): Surface[] {
  const byRoot = new Map<RowId, RowId[]>();
  for (const patch of patches) {
    const root = rootOf(patch, joints);
    const group = byRoot.get(root);
    if (group) group.push(patch);
    else byRoot.set(root, [patch]);
  }

  const surfaces: Surface[] = [];
  for (const [root, members] of byRoot) {
    // The root first, then the rest as the document holds them.
    const ordered = [root, ...members.filter((patch) => patch !== root)];
    surfaces.push({ name: "", root, patches: ordered });
  }

  const position = new Map(patches.map((patch, index) => [patch, index]));
  surfaces.sort((a, b) => (position.get(a.root) ?? 0) - (position.get(b.root) ?? 0));
  return surfaces.map((surface, index) => ({ ...surface, name: `S${index + 1}` }));
}

/** Which surface each patch belongs to, for a lookup that does not rescan the joints. */
export function surfaceIndex(surfaces: readonly Surface[]): Map<RowId, Surface> {
  const index = new Map<RowId, Surface>();
  for (const surface of surfaces) {
    for (const patch of surface.patches) index.set(patch, surface);
  }
  return index;
}
