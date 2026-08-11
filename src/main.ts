import "./style.css";
import { torus } from "./core/catalog/torus.ts";
import { boundingSphere, buildSurfaceMesh } from "./core/mesh/grid.ts";
import { createDevice } from "./gl/device.ts";
import { createRenderer } from "./gl/renderer.ts";

/**
 * M0 entry point: prove the pipeline end to end — tessellate a hand-written
 * parametric surface in `core`, upload it, orbit it — before any of the CAS exists.
 * From M1, the surface comes from a parsed and differentiated user formula instead.
 */

function fail(message: string) {
  const stage = document.querySelector<HTMLElement>(".stage");
  if (stage) {
    stage.innerHTML = `<div style="padding:24px;color:#ff9b9b;font:14px/1.6 ui-sans-serif,system-ui">
      <strong>DiffGeo could not start.</strong><br>${message}
    </div>`;
  }
  console.error(message);
}

function main() {
  const canvas = document.querySelector<HTMLCanvasElement>("#stage-canvas");
  if (!canvas) return fail("canvas #stage-canvas is missing from the document");

  let device;
  try {
    device = createDevice(canvas);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }

  const renderer = createRenderer(device);

  const source = torus();
  const mesh = buildSurfaceMesh(source, { resU: 160, resV: 220 });
  renderer.setSurfaceMesh(mesh);

  const { center, radius } = boundingSphere(mesh);
  renderer.camera.frame(center, radius);
  renderer.start();

  const readout = document.querySelector<HTMLElement>("#readout");
  if (readout) {
    readout.textContent = [
      `${source.name}`,
      `vertices    ${mesh.vertexCount.toLocaleString()}`,
      `triangles   ${mesh.triangleCount.toLocaleString()}`,
      `dropped     ${mesh.droppedVertices} vertices, ${mesh.droppedTriangles} triangles`,
      `radius      ${radius.toFixed(3)}`,
    ].join("\n");
  }
}

main();
