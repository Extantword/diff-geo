import "./style.css";
import {
  buildSurface,
  CATALOG,
  defaultParams,
  type SurfaceSpec,
} from "./core/catalog/surfaces.ts";
import { legendGradient } from "./core/geom/curvatureColor.ts";
import type { ParametricSurface } from "./core/geom/parametric.ts";
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
 *
 * Compiling and tessellating are exposed as *separate* steps so the panel can move a
 * slider without recompiling, and can retessellate at draft resolution while typing.
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

  mountPanel({
    catalog: CATALOG,
    legendGradient: legendGradient(),
    defaultParams,

    compile: (spec: SurfaceSpec): ParametricSurface => buildSurface(spec).surface,

    render: (surface, params, resolution, refit) => {
      // Slightly more samples around v, which is the longer way round on most surfaces
      // of revolution.
      const mesh = tessellate(surface, params, {
        resU: resolution,
        resV: Math.round(resolution * 1.25),
      });
      renderer.setSurfaceMesh(mesh);
      if (refit) {
        const { center, radius } = boundingSphere(mesh);
        renderer.camera.frame(center, radius);
      }
      return mesh;
    },

    onCurvatureToggle: (on) => renderer.setCurvatureMix(on ? 1 : 0),
  });
}

main();
