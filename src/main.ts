import "./style.css";
import { legendGradient } from "./core/geom/curvatureColor.ts";
import { createDocument, type RowId } from "./state/graph.ts";
import {
  buildScene,
  type DomainRange,
  type FrameRequest,
  type SurfaceOverlay,
} from "./state/scene.ts";
import { createDevice } from "./gl/device.ts";
import { createRenderer } from "./gl/renderer.ts";
import { createAnimator } from "./ui/animate.ts";
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
  ids: new Float32Array(0),
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
  const overlays = new Map<RowId, SurfaceOverlay>();
  /** Chart coordinates of the last successful pick, for the diagnostics readout. */
  let pickedAt: { u: number; v: number } | null = null;
  const animator = createAnimator();

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
      overlays,
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

    const picking = renderer.pickAvailable();
    const surfaces = scene.mesh ? scene.mesh.triangleCount.toLocaleString() : "0";
    const curveCount = scene.lines.reduce((n, group) => n + group.polylines.length, 0);
    const gl = renderer.lineStats();
    const missing = Object.entries(gl.main.attributeLocations)
      .filter(([, location]) => location < 0)
      .map(([name]) => name);
    replace(stats, [
      el("div", { text: `triangles  ${surfaces}` }),
      el("div", { text: `curves     ${curveCount}` }),
      el("div", { text: `3D lines   ${gl.main.batches} groups, ${gl.main.instances} segments` }),
      el("div", { text: `chart      ${gl.chart.batches} groups, ${gl.chart.instances} segments` }),
      gl.main.glError !== 0 || gl.chart.glError !== 0
        ? el("div", {
            class: "diag diag--error",
            text: `GL error ${gl.main.glError || gl.chart.glError}`,
          })
        : null,
      missing.length > 0
        ? el("div", {
            class: "diag diag--error",
            text: `shader attributes not found: ${missing.join(", ")}`,
          })
        : null,
      // Where the last click landed, in chart coordinates — the readout that shows the pick is
      // exact rather than approximately the nearest vertex.
      pickedAt
        ? el("div", {
            text: `picked     u = ${pickedAt.u.toFixed(4)}, v = ${pickedAt.v.toFixed(4)}`,
          })
        : null,
      picking.available
        ? null
        : el("div", { class: "diag diag--warning", text: picking.reason }),
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
    animator,
    overlays,
  });
  const templates = createTemplatePicker({
    document: store,
    sliders,
    domains,
    requestRender: (refit: boolean) => onEdit(refit),
    invalidateSliders: () => list.invalidateSliders(),
  });

  // A playing slider redraws through the same throttled path as a drag: one draft render per
  // animation frame, with the full-resolution pass arriving once it settles.
  animator.setOnTick(() => onParameterChange());

  /**
   * Click a surface to move where its geodesics and curvature lines start from.
   *
   * ## Telling a click from an orbit
   *
   * The camera owns its own drag listeners on the same canvas, so both gestures begin with a
   * pointerdown in the same place. Rather than suspending the camera behind a flag — the
   * precedent's `aiming` boolean, which gets "started on the background, dragged onto the
   * surface" wrong in both directions — this decides *after the fact*: a pointerup that stayed
   * within a few pixels of its pointerdown was a click, and anything else was an orbit. A
   * stationary drag rotates the camera by nothing, so no gesture is stolen either way.
   */
  let pressX = 0;
  let pressY = 0;
  let pressed = false;
  /** How far the pointer may travel and still count as a click, in CSS pixels. */
  const CLICK_SLOP = 4;

  canvas.addEventListener("pointerdown", (event: PointerEvent) => {
    pressed = true;
    pressX = event.clientX;
    pressY = event.clientY;
  });

  canvas.addEventListener("pointerup", (event: PointerEvent) => {
    if (!pressed) return;
    pressed = false;
    const travelled = Math.hypot(event.clientX - pressX, event.clientY - pressY);
    if (travelled > CLICK_SLOP) return;

    // Only rows already showing an overlay respond. Clicking a bare surface should do nothing
    // rather than silently arming a feature the user has not asked for.
    const armed = [...overlays.entries()].filter(
      ([, overlay]) => overlay.geodesics > 0 || overlay.curvatureLines,
    );
    if (armed.length === 0) return;

    const rect = canvas.getBoundingClientRect();
    const hit = renderer.pick(event.clientX - rect.left, event.clientY - rect.top);
    if (!hit) return;

    const overlay = overlays.get(hit.rowId);
    if (!overlay || (overlay.geodesics === 0 && !overlay.curvatureLines)) return;

    overlays.set(hit.rowId, { ...overlay, start: [hit.u, hit.v] });
    pickedAt = { u: hit.u, v: hit.v };
    onEdit(false);
  });

  canvas.addEventListener("pointercancel", () => {
    pressed = false;
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
