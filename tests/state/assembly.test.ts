import { describe, expect, it } from "vitest";
import { createDocument, type RowId } from "../../src/state/graph.ts";
import { buildScene, type DomainRange } from "../../src/state/scene.ts";
import { PIECES } from "../../src/core/catalog/pieces.ts";
import { sampleBounds, type Vec3 } from "../../src/core/geom/types.ts";
import {
  pruneJoints,
  resolveAssembly,
  rootOf,
  type Joint,
} from "../../src/state/assembly.ts";
import { QUAT_IDENTITY, quatFromAxisAngle } from "../../src/core/num/quat.ts";
import { IDENTITY_PLACEMENT, type Port } from "../../src/core/geom/ports.ts";

/**
 * Assembly: pieces joined boundary to boundary.
 *
 * The claim being tested is the one the whole feature rests on — that two joined pieces really do
 * meet, measured on the **drawn mesh** rather than on the transform that was supposed to produce
 * it. A gap of a fraction of a radius is exactly the failure this mechanism exists to prevent, and
 * it is invisible in any test that only checks the placement arithmetic.
 */

const piece = (id: string) => PIECES.find((entry) => entry.id === id)!;

/** Lay pieces out as a document the way the parts bin does, and build the scene. */
function assemble(
  plan: readonly { id: string; size: number; joint?: Omit<Joint, "parent"> & { parent: number } }[],
) {
  const domains = new Map<RowId, DomainRange[]>();
  const joints = new Map<RowId, Joint>();
  const sources: string[] = [];
  const builds = plan.map((step) => piece(step.id).build(step.size));
  for (const [index, build] of builds.entries()) {
    // Distinct names: two rows declaring the same one is one definition overwritten.
    sources.push(`${["X", "Y", "Z", "W"][index]}(u,v) = (${build.components.join(", ")})`);
  }

  const document = createDocument(sources);
  const rows = document.rows();
  for (const [index, build] of builds.entries()) {
    const rowId = rows[index]!.id;
    const [u0, u1] = sampleBounds(build.u);
    const [v0, v1] = sampleBounds(build.v);
    domains.set(rowId, [
      { min: u0, max: u1 },
      { min: v0, max: v1 },
    ]);
    const step = plan[index]!;
    if (step.joint) {
      joints.set(rowId, { ...step.joint, parent: rows[step.joint.parent]!.id });
    }
  }

  const resolved = document.resolution();
  const scene = buildScene({
    items: [...resolved.items.values()],
    parameters: new Map(),
    declaredParameters: resolved.declaredParameters,
    domains,
    resolution: 24,
    joints,
    showPorts: true,
  });
  return { document, rows, scene, joints };
}

/** The nearest distance from a point to any vertex of the drawn mesh. */
function nearestVertex(positions: Float32Array, count: number, p: Vec3): number {
  let best = Infinity;
  for (let k = 0; k < count; k++) {
    const d = Math.hypot(
      positions[k * 3]! - p[0],
      positions[k * 3 + 1]! - p[1],
      positions[k * 3 + 2]! - p[2],
    );
    if (d < best) best = d;
  }
  return best;
}

describe("resolveAssembly", () => {
  const port = (boundary: Port["boundary"], origin: Vec3, axis: Vec3): Port => ({
    boundary,
    kind: "circle",
    size: 1,
    origin,
    axis,
    up: [1, 0, 0],
    deviation: 0,
  });

  const localPorts = new Map<RowId, readonly Port[]>([
    [1 as RowId, [port("uMin", [0, 0, 0], [0, 0, -1]), port("uMax", [0, 0, 2], [0, 0, 1])]],
    [2 as RowId, [port("uMin", [0, 0, 0], [0, 0, -1]), port("uMax", [0, 0, 2], [0, 0, 1])]],
    [3 as RowId, [port("uMin", [0, 0, 0], [0, 0, -1]), port("uMax", [0, 0, 2], [0, 0, 1])]],
  ]);

  it("stacks a chain end to end, each on the one before", () => {
    const joints = new Map<RowId, Joint>([
      [2 as RowId, { parent: 1 as RowId, parentBoundary: "uMax", childBoundary: "uMin", roll: 0 }],
      [3 as RowId, { parent: 2 as RowId, parentBoundary: "uMax", childBoundary: "uMin", roll: 0 }],
    ]);
    const { placements, broken } = resolveAssembly([1, 2, 3] as RowId[], {
      joints,
      localPorts,
      free: () => IDENTITY_PLACEMENT,
    });

    expect(broken.size).toBe(0);
    expect(placements.get(2 as RowId)!.translation[2]).toBeCloseTo(2, 12);
    // The third is placed on the second, which had already been placed on the first — the
    // transform composes down the chain rather than every piece sitting on the root.
    expect(placements.get(3 as RowId)!.translation[2]).toBeCloseTo(4, 12);
  });

  it("carries the whole chain when the root is moved by hand", () => {
    const joints = new Map<RowId, Joint>([
      [2 as RowId, { parent: 1 as RowId, parentBoundary: "uMax", childBoundary: "uMin", roll: 0 }],
    ]);
    const { placements } = resolveAssembly([1, 2] as RowId[], {
      joints,
      localPorts,
      free: (rowId) =>
        rowId === (1 as RowId)
          ? { rotation: QUAT_IDENTITY, translation: [5, 0, 0] }
          : IDENTITY_PLACEMENT,
    });
    expect(placements.get(2 as RowId)!.translation).toEqual([5, 0, 2]);
  });

  it("turns a child with its parent, about the parent's own rotation", () => {
    const joints = new Map<RowId, Joint>([
      [2 as RowId, { parent: 1 as RowId, parentBoundary: "uMax", childBoundary: "uMin", roll: 0 }],
    ]);
    // A quarter turn about x sends z to −y, so the parent's +z rim points along −y and the
    // child follows it there rather than staying above.
    const rotation = quatFromAxisAngle([1, 0, 0], Math.PI / 2);
    const { placements } = resolveAssembly([1, 2] as RowId[], {
      joints,
      localPorts,
      free: (rowId) =>
        rowId === (1 as RowId) ? { rotation, translation: [0, 0, 0] } : IDENTITY_PLACEMENT,
    });
    const child = placements.get(2 as RowId)!;
    expect(child.translation[1]).toBeCloseTo(-2, 9);
    expect(child.translation[2]).toBeCloseTo(0, 9);
  });

  it("leaves a piece loose rather than looping forever when joints form a cycle", () => {
    const joints = new Map<RowId, Joint>([
      [1 as RowId, { parent: 2 as RowId, parentBoundary: "uMax", childBoundary: "uMin", roll: 0 }],
      [2 as RowId, { parent: 1 as RowId, parentBoundary: "uMax", childBoundary: "uMin", roll: 0 }],
    ]);
    const { broken } = resolveAssembly([1, 2] as RowId[], {
      joints,
      localPorts,
      free: () => IDENTITY_PLACEMENT,
    });
    expect(broken.size).toBeGreaterThan(0);
  });

  it("reports a joint whose boundary is not a port, instead of dropping it silently", () => {
    const joints = new Map<RowId, Joint>([
      [2 as RowId, { parent: 1 as RowId, parentBoundary: "vMax", childBoundary: "uMin", roll: 0 }],
    ]);
    const { placements, broken } = resolveAssembly([1, 2] as RowId[], {
      joints,
      localPorts,
      free: () => IDENTITY_PLACEMENT,
    });
    expect(broken.get(2 as RowId)).toContain("vMax");
    expect(placements.get(2 as RowId)).toEqual(IDENTITY_PLACEMENT);
  });

  it("finds the root of a chain, and releases children of a deleted row", () => {
    const joints = new Map<RowId, Joint>([
      [2 as RowId, { parent: 1 as RowId, parentBoundary: "uMax", childBoundary: "uMin", roll: 0 }],
      [3 as RowId, { parent: 2 as RowId, parentBoundary: "uMax", childBoundary: "uMin", roll: 0 }],
    ]);
    expect(rootOf(3 as RowId, joints)).toBe(1 as RowId);

    pruneJoints(joints, new Set([2, 3] as RowId[]));
    expect(joints.has(2 as RowId)).toBe(false);
    expect(joints.has(3 as RowId)).toBe(true);
  });
});

describe("joined pieces, on the drawn mesh", () => {
  it("puts a second tube's rim exactly on the first's", () => {
    const { scene } = assemble([
      { id: "tube", size: 1 },
      {
        id: "tube",
        size: 1,
        joint: { parent: 0, parentBoundary: "uMax", childBoundary: "uMin", roll: 0 },
      },
    ]);

    // The first tube runs z ∈ [0, 2], so the join is the circle z = 2 and the far end is z = 4.
    const mesh = scene.mesh!;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let k = 0; k < mesh.vertexCount; k++) {
      const z = mesh.positions[k * 3 + 2]!;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    expect(minZ).toBeCloseTo(0, 5);
    expect(maxZ).toBeCloseTo(4, 5);

    // And the two rims coincide: a point on the join is a vertex of BOTH pieces, so the mesh has
    // material either side of it rather than a gap the width of a triangle.
    expect(nearestVertex(mesh.positions, mesh.vertexCount, [1, 0, 2])).toBeLessThan(1e-5);
  });

  it("caps a tube with a dome that meets its rim all the way round", () => {
    const { scene } = assemble([
      { id: "tube", size: 0.7 },
      {
        id: "dome",
        size: 0.7,
        joint: { parent: 0, parentBoundary: "uMax", childBoundary: "uMax", roll: 0 },
      },
    ]);

    const mesh = scene.mesh!;
    // The dome's pole stands one radius past the tube's far rim, at z = 1.4 + 0.7.
    expect(nearestVertex(mesh.positions, mesh.vertexCount, [0, 0, 2.1])).toBeLessThan(0.01);
    /**
     * The whole rim is met, not just the one point the frames were aligned by — and met vertex
     * for vertex. Both pieces sweep v over the same interval at the same resolution, and roll 0
     * lines their phase references up, so the two rims are the *same points*: the seam has no
     * sliver of a triangle in it at any angle.
     */
    for (let k = 0; k < 6; k++) {
      const angle = (2 * Math.PI * k) / 24;
      const p: Vec3 = [0.7 * Math.cos(angle), 0.7 * Math.sin(angle), 1.4];
      expect(nearestVertex(mesh.positions, mesh.vertexCount, p)).toBeLessThan(1e-5);
    }
  });

  it("bends a chain: tube, elbow, tube, and the last one runs sideways", () => {
    const { scene } = assemble([
      { id: "tube", size: 1 },
      {
        id: "elbow",
        size: 1,
        joint: { parent: 0, parentBoundary: "uMax", childBoundary: "uMin", roll: 0 },
      },
      {
        id: "tube",
        size: 1,
        joint: { parent: 1, parentBoundary: "uMax", childBoundary: "uMin", roll: 0 },
      },
    ]);

    // The elbow turns a right angle on a radius of 2, so the last tube leaves horizontally from
    // (−2, 0, 4) and runs two units further out, to x = −4.
    const mesh = scene.mesh!;
    let minX = Infinity;
    for (let k = 0; k < mesh.vertexCount; k++) minX = Math.min(minX, mesh.positions[k * 3]!);
    expect(minX).toBeCloseTo(-4, 5);
    expect(nearestVertex(mesh.positions, mesh.vertexCount, [-4, 0, 5])).toBeLessThan(0.01);
  });

  it("offers the join to nobody once it is used, and the free ends to everybody", () => {
    const { rows, scene } = assemble([
      { id: "tube", size: 1 },
      {
        id: "tube",
        size: 1,
        joint: { parent: 0, parentBoundary: "uMax", childBoundary: "uMin", roll: 0 },
      },
    ]);

    const free = scene.ports.filter((entry) => entry.free);
    expect(scene.ports).toHaveLength(4);
    expect(free).toHaveLength(2);
    // The two ends of the whole assembly, and neither of the boundaries inside the joint.
    expect(free.map((entry) => `${entry.rowId}:${entry.port.boundary}`).sort()).toEqual(
      [`${rows[0]!.id}:uMin`, `${rows[1]!.id}:uMax`].sort(),
    );
    for (const entry of free) {
      expect(entry.port.kind).toBe("circle");
      expect(entry.port.size).toBeCloseTo(1, 9);
    }
  });

  it("turns the piece about the joint axis by the roll, and its whole subtree with it", () => {
    // The roll is what decides which way an elbow bends, so it has to be visible in where the
    // elbow's far rim ends up: at roll 0 it leaves along −x, and a quarter turn about the joint's
    // own axis (+z) swings that to −y.
    const straight = assemble([
      { id: "tube", size: 1 },
      {
        id: "elbow",
        size: 1,
        joint: { parent: 0, parentBoundary: "uMax", childBoundary: "uMin", roll: 0 },
      },
    ]).scene;
    const rolled = assemble([
      { id: "tube", size: 1 },
      {
        id: "elbow",
        size: 1,
        joint: { parent: 0, parentBoundary: "uMax", childBoundary: "uMin", roll: Math.PI / 2 },
      },
    ]).scene;

    const exitOf = (scene: typeof straight) =>
      scene.ports.find((entry) => entry.free && entry.port.boundary === "uMax")!.port;

    const before = exitOf(straight);
    const after = exitOf(rolled);
    expect(before.origin[0]).toBeCloseTo(-2, 6);
    expect(before.origin[1]).toBeCloseTo(0, 6);
    expect(after.origin[0]).toBeCloseTo(0, 6);
    expect(after.origin[1]).toBeCloseTo(-2, 6);
    // The bend still rises the same amount: a roll turns the piece, it does not move it.
    expect(after.origin[2]).toBeCloseTo(before.origin[2], 9);
  });

  it("makes one surface out of the patches, and knows when it is closed", () => {
    /**
     * The vocabulary the model now keeps: each row is a **coordinate patch**, and what they make
     * once joined is a **surface**. A tube capped at both ends has no boundary left anywhere, and
     * saying so is the thing a cobordism is being assembled to reach.
     */
    const { rows, scene } = assemble([
      { id: "tube", size: 1 },
      {
        id: "dome",
        size: 1,
        joint: { parent: 0, parentBoundary: "uMax", childBoundary: "uMax", roll: 0 },
      },
      {
        id: "dome",
        size: 1,
        joint: { parent: 0, parentBoundary: "uMin", childBoundary: "uMax", roll: 0 },
      },
    ]);

    expect(scene.surfaces).toHaveLength(1);
    const surface = scene.surfaces[0]!;
    expect(surface.name).toBe("S1");
    expect(surface.root).toBe(rows[0]!.id);
    expect([...surface.patches].sort()).toEqual(rows.slice(0, 3).map((row) => row.id).sort());
    expect(surface.freeBoundaries).toBe(0);
    expect(surface.closed).toBe(true);
  });

  it("counts two loose patches as two surfaces, and names them in document order", () => {
    const { rows, scene } = assemble([
      { id: "tube", size: 1 },
      { id: "plate", size: 1 },
    ]);
    expect(scene.surfaces.map((surface) => surface.name)).toEqual(["S1", "S2"]);
    expect(scene.surfaces[0]!.root).toBe(rows[0]!.id);
    // A lone patch is a surface with one chart — no special case, and its boundaries are open.
    expect(scene.surfaces[0]!.freeBoundaries).toBe(2);
    expect(scene.surfaces[1]!.freeBoundaries).toBe(4);
    expect(scene.surfaces.every((surface) => surface.closed)).toBe(false);
  });

  it("says on every patch which surface it is part of", () => {
    const { rows, scene } = assemble([
      { id: "tube", size: 1 },
      {
        id: "tube",
        size: 1,
        joint: { parent: 0, parentBoundary: "uMax", childBoundary: "uMin", roll: 0 },
      },
    ]);
    for (const row of rows.slice(0, 2)) {
      const report = scene.reports.find((entry) => entry.rowId === row.id)!;
      expect(report.info.some((line) => line.startsWith("S1 · 2 patches"))).toBe(true);
    }
  });

  it("keeps every curvature the piece had before it was placed", () => {
    // The whole reason placement happens after the geometry: a rigid motion changes nothing K, H
    // or the principal directions are built from. A joined elbow is a quarter torus wherever it
    // is put, so its curvature has to match the analytic value for one.
    const loose = assemble([{ id: "elbow", size: 1 }]).scene;
    const joined = assemble([
      { id: "tube", size: 1 },
      {
        id: "elbow",
        size: 1,
        joint: { parent: 0, parentBoundary: "uMax", childBoundary: "uMin", roll: 1.1 },
      },
    ]).scene;

    const curvatures = (mesh: NonNullable<typeof loose.mesh>, from: number, count: number) =>
      [...mesh.curvature.slice(from, from + count)];

    const elbowVertices = loose.mesh!.vertexCount;
    expect(joined.mesh!.vertexCount).toBe(elbowVertices * 2);
    // The elbow is the second surface, so its vertices follow the tube's in the packed mesh.
    expect(curvatures(joined.mesh!, elbowVertices, elbowVertices)).toEqual(
      curvatures(loose.mesh!, 0, elbowVertices),
    );
  });
});
