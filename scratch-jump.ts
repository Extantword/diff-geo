import { createDocument } from "./src/state/graph.ts";
import { buildScene } from "./src/state/scene.ts";
import { quatFromAxisAngle, QUAT_IDENTITY } from "./src/core/num/quat.ts";
import type { Quat } from "./src/core/num/quat.ts";

function centre(uMax: number, rot: Quat) {
  const document = createDocument(["X(u,v) = (sin u cos v, sin u sin v, cos u)"]);
  const rowId = document.rows()[0]!.id;
  const scene = buildScene({
    items: [...document.resolution().items.values()],
    parameters: new Map(),
    domains: new Map([[rowId, [{ min: 0.01, max: uMax }, { min: 0, max: 2 * Math.PI }]]]),
    resolution: 24,
    rotations: new Map([[rowId, rot]]),
  });
  const m = scene.mesh!;
  let sx = 0, sy = 0, sz = 0, n = 0;
  for (let k = 0; k < m.vertexCount; k++) {
    sx += m.positions[k*3]!; sy += m.positions[k*3+1]!; sz += m.positions[k*3+2]!; n++;
  }
  return [sx/n, sy/n, sz/n];
}

const rot = quatFromAxisAngle([1, 0.3, 0], 1.2);
for (const uMax of [Math.PI - 0.01, 2.0, 1.4]) {
  const still = centre(uMax, QUAT_IDENTITY);
  const spun = centre(uMax, rot);
  console.log(
    `uMax=${uMax.toFixed(2)}`,
    "unrotated centroid", still.map(v => v.toFixed(4)).join(","),
    "| rotated centroid", spun.map(v => v.toFixed(4)).join(","),
  );
}
