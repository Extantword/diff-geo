import "./style.css";
import { legendGradient } from "./core/geom/curvatureColor.ts";
import { createDocument, type RowId } from "./state/graph.ts";
import { buildScene, type DomainRange } from "./state/scene.ts";
import { createDevice } from "./gl/device.ts";
import { createRenderer } from "./gl/renderer.ts";
import { createExprList, type SliderSpec } from "./ui/exprList.ts";
import { el, replace } from "./ui/dom.ts";

/**
 * M2: a document of expressions, drawn.
 *
 * Rows can reference each other, any undefined symbol becomes a slider, and every drawable
 * row is compiled through the same path — parse, inline, differentiate, jets, fundamental
 * forms, tessellate or sample — before reaching the WebGL2 passes.
 */

/** Coarse mesh while typing or dragging; full mesh once things settle. */
const DRAFT_RESOLUTION = 64;
const FULL_RESOLUTION = 150;
const DRAFT_DELAY_MS = 90;
const FULL_DELAY_MS = 340;

const STARTER_ROWS = [
  "R = 2",
  "r = 0.6",
  "X(u,v) = ((R + r cos u) cos v, (R + r cos u) sin v, r sin u)",
];

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

  const store = createDocument(STARTER_ROWS);
  const domains = new Map<RowId, DomainRange[]>();
  const sliders = new Map<string, SliderSpec>();

  const legendLabels = el("div", { class: "legend-labels" });
  const stats = el("div", { class: "readout" });

  let draftTimer = 0;
  let fullTimer = 0;
  let framedOnce = false;

  const render = (resolution: number, refit: boolean) => {
    const parameters = new Map<string, number>();
    for (const [name, spec] of sliders) parameters.set(name, spec.value);

    const scene = buildScene({
      items: [...store.resolution().items.values()],
      parameters,
      domains,
      resolution,
    });

    renderer.setSurfaceMesh(
      scene.mesh ?? {
        // An empty mesh rather than a stale one: removing the last surface must clear it.
        positions: new Float32Array(0),
        normals: new Float32Array(0),
        colors: new Float32Array(0),
        chart: new Float32Array(0),
        curvature: new Float64Array(0),
        indices: new Uint32Array(0),
        vertexCount: 0,
        triangleCount: 0,
        droppedVertices: 0,
        droppedTriangles: 0,
        range: { scale: 1, minK: NaN, maxK: NaN, invalidFraction: 0 },
      },
    );
    renderer.setLines(scene.lines);

    if (scene.bounds && (refit || !framedOnce)) {
      renderer.camera.frame(scene.bounds.center, scene.bounds.radius);
      renderer.invalidate();
      framedOnce = true;
    }

    replace(legendLabels, [
      el("span", { text: (-scene.curvatureScale).toPrecision(3) }),
      el("span", { text: "K" }),
      el("span", { text: scene.curvatureScale.toPrecision(3) }),
    ]);

    const surfaces = scene.mesh ? scene.mesh.triangleCount.toLocaleString() : "0";
    const curveCount = scene.lines.reduce((n, group) => n + group.polylines.length, 0);
    replace(stats, [
      el("div", { text: `triangles  ${surfaces}` }),
      el("div", { text: `curves     ${curveCount}` }),
    ]);

    list.refresh(scene.reports);
  };

  /**
   * Parsing and typesetting are microseconds, so the echo updates on every keystroke;
   * compiling jets and tessellating is tens of milliseconds, so it is debounced — draft
   * resolution first for responsiveness, full resolution once typing stops.
   */
  const requestRender = (refit: boolean) => {
    list.refresh([]);
    window.clearTimeout(draftTimer);
    window.clearTimeout(fullTimer);
    draftTimer = window.setTimeout(() => render(DRAFT_RESOLUTION, refit), DRAFT_DELAY_MS);
    fullTimer = window.setTimeout(() => render(FULL_RESOLUTION, false), FULL_DELAY_MS);
  };

  const list = createExprList({ document: store, requestRender, domains, sliders });

  const curvatureToggle = el("input", {
    type: "checkbox",
    checked: true,
    onChange: (event: Event) =>
      renderer.setCurvatureMix((event.target as HTMLInputElement).checked ? 1 : 0),
  });

  const panel = document.querySelector<HTMLElement>(".panel");
  if (panel) {
    replace(panel, [
      el("header", { class: "panel-header" }, [
        el("h1", { text: "DiffGeo" }),
        el("p", { text: "Curves and surfaces in R³, after do Carmo." }),
      ]),
      list.root,
      el("section", { class: "panel-section" }, [
        el("h2", { class: "section-title", text: "Gaussian curvature" }),
        el("label", { class: "toggle" }, [curvatureToggle, el("span", { text: "paint K" })]),
        el("div", { class: "legend", style: `background:${legendGradient()}` }),
        legendLabels,
      ]),
      el("section", { class: "panel-section" }, [
        el("h2", { class: "section-title", text: "Scene" }),
        stats,
      ]),
    ]);
  }

  render(FULL_RESOLUTION, true);
}

main();
