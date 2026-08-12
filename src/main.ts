import "./style.css";
import { buildSurface, CATALOG, defaultParams, type SurfaceSpec } from "./core/catalog/surfaces.ts";
import { legendGradient } from "./core/geom/curvatureColor.ts";
import { boundingSphere } from "./core/mesh/grid.ts";
import { tessellate } from "./core/mesh/tessellate.ts";
import { createDevice } from "./gl/device.ts";
import { createRenderer } from "./gl/renderer.ts";
import { mountPanel } from "./ui/panel.ts";

/**
 * M1 vertical slice: a formula becomes a surface with its curvature painted on it.
 *
 * Every layer is exercised — the text is parsed, differentiated symbolically, compiled
 * to a jet evaluator, reduced to the fundamental forms, tessellated with exact normals
 * and per-vertex Gaussian curvature, and drawn by the hand-written WebGL2 pass.
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
  renderer.start();

  let framed = false;

  /** Compile, tessellate, upload. The whole pipeline, on every edit. */
  const show = (spec: SurfaceSpec, params: Float64Array, refit: boolean) => {
    const built = buildSurface(spec);
    const mesh = tessellate(built.surface, params, { resU: 140, resV: 180 });
    renderer.setSurfaceMesh(mesh);

    if (refit || !framed) {
      const { center, radius } = boundingSphere(mesh);
      renderer.camera.frame(center, radius);
      framed = true;
    }
    return { built, mesh };
  };

  mountPanel({
    catalog: CATALOG,
    legendGradient: legendGradient(),
    show,
    defaultParams,
    onCurvatureToggle: (on) => {
      renderer.setCurvatureMix(on ? 1 : 0);
      renderer.invalidate();
    },
  });
}

main();
