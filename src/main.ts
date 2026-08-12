import "./style.css";
import { legendGradient } from "./core/geom/curvatureColor.ts";
import { createDocument, type RowId } from "./state/graph.ts";
import { buildScene, type DomainRange, type FrameRequest } from "./state/scene.ts";
import { createDevice } from "./gl/device.ts";
import { createRenderer } from "./gl/renderer.ts";
import { createExprList, type SliderSpec } from "./ui/exprList.ts";
import { createTemplatePicker } from "./ui/templates.ts";
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
/** Quiet period after a drag before upgrading to full resolution. */
const SETTLE_DELAY_MS = 260;

const STARTER_ROWS = [
  "R = 2",
  "r = 0.6",
  "X(u,v) = ((R + r cos u) cos v, (R + r cos u) sin v, r sin u)",
];

/** Drawn when the document holds no surface: clears the pass rather than leaving a stale mesh. */
const EMPTY_MESH = {
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
};

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
  const frames = new Map<RowId, FrameRequest>();
  const rowSliders = new Map<RowId, SliderSpec>();
  const inChart = new Set<RowId>();

  const legendLabels = el("div", { class: "legend-labels" });
  const stats = el("div", { class: "readout" });

  let draftTimer = 0;
  let fullTimer = 0;
  let framePending = false;
  let framedOnce = false;
  let chartVisible = true;

  const render = (resolution: number, refit: boolean, fullRefresh: boolean) => {
    const resolved = store.resolution();

    // Live values win; declared numeric rows supply the rest. Both slider kinds write into
    // the document's parameter store, so reading it covers them uniformly.
    const parameters = new Map<string, number>(store.parameters());
    for (const [name, spec] of sliders) parameters.set(name, spec.value);

    const scene = buildScene({
      items: [...resolved.items.values()],
      parameters,
      declaredParameters: resolved.declaredParameters,
      domains,
      resolution,
      frames,
      inChart,
    });

    renderer.setSurfaceMesh(scene.mesh ?? EMPTY_MESH);
    renderer.setLines(scene.lines);
    renderer.setChartLines(scene.chartLines);
    renderer.setChartBounds(chartVisible ? scene.chartBounds : null);

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

    // A parameter change cannot alter any row's text or structure, so it only needs the
    // readouts. Reparsing and re-typesetting every row on each frame of a slider drag was the
    // bulk of the jank.
    if (fullRefresh) list.refresh(scene.reports);
    else list.refreshReports(scene.reports);
  };

  /**
   * A row's text changed: **debounce**.
   *
   * A half-typed formula should not be compiled, so wait for the typing to pause — draft
   * resolution first for responsiveness, full resolution once it settles.
   */
  const onEdit = (refit: boolean) => {
    window.clearTimeout(draftTimer);
    window.clearTimeout(fullTimer);
    draftTimer = window.setTimeout(() => render(DRAFT_RESOLUTION, refit, true), DRAFT_DELAY_MS);
    fullTimer = window.setTimeout(() => render(FULL_RESOLUTION, false, true), FULL_DELAY_MS);
  };

  /**
   * Only a parameter moved: **throttle**, one draft render per animation frame.
   *
   * Debouncing this was the mistake. A debounce waits for quiet, so a slider held down
   * produced nothing at all until it was released and then jumped — which reads as jank even
   * though each individual render was fast. Throttling gives continuous feedback at the
   * display's own rate, and a trailing timer upgrades to full resolution once the drag stops.
   *
   * Nothing recompiles on this path: parameters are compiled as slots and the jet is cached
   * by interned identity, so the per-frame cost is sampling plus one buffer upload.
   */
  const onParameterChange = () => {
    window.clearTimeout(draftTimer);
    if (!framePending) {
      framePending = true;
      requestAnimationFrame(() => {
        framePending = false;
        render(DRAFT_RESOLUTION, false, false);
      });
    }
    window.clearTimeout(fullTimer);
    fullTimer = window.setTimeout(() => render(FULL_RESOLUTION, false, false), SETTLE_DELAY_MS);
  };

  const list = createExprList({
    document: store,
    onEdit,
    onParameterChange,
    domains,
    sliders,
    frames,
    rowSliders,
    inChart,
  });
  const templates = createTemplatePicker({
    document: store,
    sliders,
    domains,
    requestRender: (refit: boolean) => onEdit(refit),
    invalidateSliders: () => list.invalidateSliders(),
  });

  const chartToggle = el("input", {
    type: "checkbox",
    checked: true,
    onChange: (event: Event) => {
      chartVisible = (event.target as HTMLInputElement).checked;
      onParameterChange();
    },
  });

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
      templates,
      list.root,
      el("section", { class: "panel-section" }, [
        el("h2", { class: "section-title", text: "Gaussian curvature" }),
        el("label", { class: "toggle" }, [curvatureToggle, el("span", { text: "paint K" })]),
        el("div", { class: "legend", style: `background:${legendGradient()}` }),
        legendLabels,
      ]),
      el("section", { class: "panel-section" }, [
        el("h2", { class: "section-title", text: "Chart" }),
        el("label", { class: "toggle" }, [
          chartToggle,
          el("span", { text: "show the (u, v) plane" }),
        ]),
        el("p", {
          class: "blurb",
          text:
            "The domain of the first surface, drawn flat. Tick “read as (u, v)” on a " +
            "two-component curve to draw it here and on the surface at once.",
        }),
      ]),
      el("section", { class: "panel-section" }, [
        el("h2", { class: "section-title", text: "Scene" }),
        stats,
      ]),
    ]);
  }

  render(FULL_RESOLUTION, true, true);
}

main();
