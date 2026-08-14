import "./style.css";
import { legendGradient } from "./core/geom/curvatureColor.ts";
import type { ColormapName } from "./core/geom/colormaps.ts";
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
import { createTemplatePicker, TEMPLATE_ENTRIES } from "./ui/templates.ts";
import { installHotReloadGate, takeHotSession } from "./dev/hot.ts";
import type { Vec3 } from "./core/geom/types.ts";
import {
  QUAT_IDENTITY,
  quatFromAxisAngle,
  quatMultiply,
  type Quat,
} from "./core/num/quat.ts";
import type { LineGroup } from "./gl/passes/lines.ts";
import { arrow, type Scene } from "./state/scene.ts";
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
  baseColors: new Float32Array(0),
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
    stage.innerHTML = `<div style="padding:24px;color:#a3231b;font:14px/1.6 ui-sans-serif,system-ui">
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
  /** Per-row colour, set from the properties card and used everywhere that row is drawn. */
  const colors = new Map<RowId, Vec3>();
  /** Where each object sits. Arrangement only — it never touches a curvature. */
  const translations = new Map<RowId, Vec3>();
  /** How each object is turned. Arrangement, like the translation — never a curvature. */
  const rotations = new Map<RowId, Quat>();
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
      colors,
      translations,
      rotations,
    });

    renderer.setSurfaceMesh(scene.mesh ?? EMPTY_MESH);
    lastScene = scene;
    sceneLines = scene.lines;
    paintLines();
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

    syncLegend();
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
    colors,
  });
  /**
   * The properties strip is a sibling of the panel and the stage, not a child of either.
   *
   * It spans the full width of the grid's first row, so it has to live in `.app`; nested inside
   * the stage it could only ever have been an overlay on top of the geometry.
   */
  document.querySelector(".app__props")?.append(list.card);
  const templates = createTemplatePicker({
    document: store,
    sliders,
    domains,
    requestRender: (refit: boolean) => onEdit(refit),
    invalidateSliders: () => list.invalidateSliders(),
    /**
     * Put a template beside whatever is already there.
     *
     * Templates add to the document now rather than replacing it, so without this a second
     * surface would be created inside the first — two objects sharing an origin, which reads as
     * one broken object rather than as two.
     */
    onCreated: (rowId: RowId) => {
      const bounds = lastScene?.bounds;
      if (!bounds || translations.size === 0 && store.rows().length <= 2) return;
      const right = renderer.camera.basis().right;
      const step = bounds.radius * 2.2;
      translations.set(rowId, [
        bounds.center[0] + right[0] * step,
        bounds.center[1] + right[1] * step,
        bounds.center[2] + right[2] * step,
      ]);
    },
  });

  // A playing slider redraws through the same throttled path as a drag: one draft render per
  // animation frame, with the full-resolution pass arriving once it settles.
  animator.setOnTick(() => onParameterChange());

  /**
   * Pointer gestures on the canvas: orbit, select, and aim a geodesic.
   *
   * ## A tool state machine, not a flag
   *
   * The camera owns its own drag listeners on the same canvas, so every gesture — orbiting,
   * selecting, aiming — begins with an identical pointerdown. The precedent resolved this with an
   * `aiming` boolean, which gets "started on the background, dragged across the surface" wrong in
   * both directions: it has to be set before anyone knows what the drag will turn out to be.
   *
   * So the OWNER IS DECIDED ON POINTERDOWN AND FIXED FOR THE WHOLE DRAG. A press that lands on a
   * surface whose aim tool is armed becomes an aim and stays one wherever the cursor wanders;
   * anything else is left to the camera. The listeners run in the CAPTURE phase so this decision
   * is made before the camera's own handler sees the event and starts orbiting.
   */
  type Gesture =
    | { readonly kind: "idle" }
    | { readonly kind: "camera"; readonly x: number; readonly y: number }
    | {
        /** Dragging an object through space; see the note on placement below. */
        readonly kind: "move";
        readonly rowId: RowId;
        readonly grabbed: Vec3;
        readonly from: Vec3;
        /** Where the press started, so a click can be told from a drag on release. */
        readonly x: number;
        readonly y: number;
      }
    | {
        /** Right-dragging an object to turn it. */
        readonly kind: "rotate";
        readonly rowId: RowId;
        readonly startRotation: Quat;
        x: number;
        y: number;
      }
    | {
        readonly kind: "aim";
        readonly rowId: RowId;
        readonly u: number;
        readonly v: number;
        readonly origin: Vec3;
      };

  let gesture: Gesture = { kind: "idle" };
  /** The aiming arrow's colour: the geodesic amber, so the preview names what it will become. */
  const AIM_COLOR: Vec3 = [0.85, 0.55, 0.0];
  /** The direction being aimed, in CHART coordinates — what the integrator actually needs. */
  let aimChart: [number, number] = [0, 0];
  /** The scene as last built, for turning a picked (u, v) back into a point without rebuilding. */
  let lastScene: Scene | null = null;
  /**
   * A picked chart point, in the place the object is actually drawn.
   *
   * `positionOf` evaluates the parametrization, which knows nothing about arrangement — so for a
   * surface that has been moved it answers where the formula puts it rather than where it is. The
   * translation has to be added back, or aiming and dragging both work against a phantom sitting
   * at the origin.
   */
  const surfacePointAt = (rowId: RowId, u: number, v: number): Vec3 | null => {
    const base = lastScene?.positionOf(rowId, u, v);
    if (!base) return null;
    const offset = translations.get(rowId);
    if (!offset) return base;
    return [base[0] + offset[0], base[1] + offset[1], base[2] + offset[2]];
  };
  /** Preview at the arc length the committed geodesic will use, so the drag does not mislead. */
  const previewLength = (rowId: RowId) => {
    const extent = lastScene?.bounds?.radius ?? 1;
    return extent * (overlays.get(rowId)?.geodesicLength ?? 1.5);
  };
  /**
   * How far the pointer may travel and still count as a click, in CSS pixels.
   *
   * Generous, because every press on an object now begins a drag: too tight and an ordinary click
   * with a hand tremor in it becomes a one-pixel move, and the selection it was meant to make
   * never happens.
   */
  const CLICK_SLOP = 6;
  /** Lines from the last built scene, so a preview can be drawn without rebuilding it. */
  let sceneLines: readonly LineGroup[] = [];
  /** The live aiming arrow, drawn on top of the scene during a drag. */
  let previewLines: LineGroup[] = [];

  const paintLines = () => {
    renderer.setLines(previewLines.length === 0 ? sceneLines : [...sceneLines, ...previewLines]);
  };

  const rect0 = (_event: PointerEvent) => canvas.getBoundingClientRect();

  const pickAt = (event: PointerEvent) => {
    const rect = rect0(event);
    return renderer.pick(event.clientX - rect.left, event.clientY - rect.top);
  };

  canvas.addEventListener(
    "pointerdown",
    (event: PointerEvent) => {
      const hit = pickAt(event);
      const overlay = hit ? overlays.get(hit.rowId) : undefined;

      if (hit && overlay?.aiming) {
        /**
         * Aiming owns this drag. The camera is suspended for its duration rather than for as
         * long as the tool is armed, so orbiting still works by dragging anywhere off the
         * surface even while the tool is on.
         */
        const origin = surfacePointAt(hit.rowId, hit.u, hit.v);
        if (origin) {
          gesture = { kind: "aim", rowId: hit.rowId, u: hit.u, v: hit.v, origin };
          renderer.camera.setAiming(true);
          canvas.setPointerCapture(event.pointerId);
          event.stopPropagation();
          event.preventDefault();
          return;
        }
      }
      /**
       * Right-dragging an object turns it.
       *
       * The same rule as everywhere else on this canvas — what is under the pointer decides who
       * owns the drag — which is also what keeps this from stealing the context menu: right-click
       * on EMPTY space still opens it, because there is no object there to turn.
       */
      if (hit && event.button === 2) {
        gesture = {
          kind: "rotate",
          rowId: hit.rowId,
          startRotation: rotations.get(hit.rowId) ?? QUAT_IDENTITY,
          x: event.clientX,
          y: event.clientY,
        };
        renderer.camera.setAiming(true);
        canvas.setPointerCapture(event.pointerId);
        event.stopPropagation();
        event.preventDefault();
        return;
      }

      /**
       * A press that lands on a surface moves that surface; one on empty space orbits.
       *
       * The same rule the aim tool follows: the owner of the drag is decided on pointerdown from
       * what is under it, and fixed for the whole gesture. It does cost the ability to orbit by
       * dragging ON an object — the background is now the place to grab for that — which is the
       * trade a direct-manipulation scene makes, and the one that makes objects feel like things
       * rather than pictures.
       */
      if (hit && lastScene) {
        const from = renderer.unproject(
          event.clientX - rect0(event).left,
          event.clientY - rect0(event).top,
          surfacePointAt(hit.rowId, hit.u, hit.v) ?? lastScene.bounds?.center ?? [0, 0, 0],
        );
        if (from) {
          gesture = {
            kind: "move",
            rowId: hit.rowId,
            grabbed: translations.get(hit.rowId) ?? [0, 0, 0],
            from,
            x: event.clientX,
            y: event.clientY,
          };
          renderer.camera.setAiming(true);
          canvas.setPointerCapture(event.pointerId);
          event.stopPropagation();
          event.preventDefault();
          return;
        }
      }

      gesture = { kind: "camera", x: event.clientX, y: event.clientY };
    },
    { capture: true },
  );

  canvas.addEventListener(
    "pointermove",
    (event: PointerEvent) => {
      if (gesture.kind === "rotate") {
        /**
         * Turn about the camera's own axes, so the object follows the hand.
         *
         * A horizontal drag spins it about the screen's vertical axis and a vertical drag about
         * the horizontal one — which is what "turning something to look at its other side" means
         * when the thing you are turning is on a screen rather than in your hands. Composing on
         * the LEFT applies the new turn in world space, so the gesture stays intuitive however
         * far the object has already been rotated.
         */
        const dx = event.clientX - gesture.x;
        const dy = event.clientY - gesture.y;
        gesture.x = event.clientX;
        gesture.y = event.clientY;

        const { right, up } = renderer.camera.basis();
        const RADIANS_PER_PIXEL = 0.008;
        const spin = quatMultiply(
          quatFromAxisAngle(up, dx * RADIANS_PER_PIXEL),
          quatFromAxisAngle(right, dy * RADIANS_PER_PIXEL),
        );
        rotations.set(
          gesture.rowId,
          quatMultiply(spin, rotations.get(gesture.rowId) ?? QUAT_IDENTITY),
        );
        onParameterChange();
        event.stopPropagation();
        return;
      }

      if (gesture.kind === "move") {
        /**
         * Follow the pointer on the plane the object was grabbed on.
         *
         * Measured as a DIFFERENCE from where the grab started rather than by putting the object
         * under the cursor, so it does not jump when picked up away from its centre — the point
         * you grabbed stays the point under your finger.
         */
        const to = renderer.unproject(
          event.clientX - rect0(event).left,
          event.clientY - rect0(event).top,
          gesture.from,
        );
        if (!to) return;
        translations.set(gesture.rowId, [
          gesture.grabbed[0] + to[0] - gesture.from[0],
          gesture.grabbed[1] + to[1] - gesture.from[1],
          gesture.grabbed[2] + to[2] - gesture.from[2],
        ]);
        onParameterChange();
        event.stopPropagation();
        return;
      }
      if (gesture.kind !== "aim") return;
      const hit = pickAt(event);
      // Off the surface: keep the last arrow rather than dropping it, so a cursor that strays
      // past the silhouette mid-drag does not make the preview flicker.
      if (!hit || hit.rowId !== gesture.rowId) return;

      const target = surfacePointAt(gesture.rowId, hit.u, hit.v);
      if (!target) return;
      const direction: Vec3 = [
        target[0] - gesture.origin[0],
        target[1] - gesture.origin[1],
        target[2] - gesture.origin[2],
      ];
      const length = Math.hypot(direction[0], direction[1], direction[2]);
      if (length < 1e-9) return;

      aimChart = [hit.u - gesture.u, hit.v - gesture.v];

      /**
       * The preview is the geodesic itself, lying on the surface.
       *
       * A straight arrow through space would be cheaper and would faithfully show the initial
       * VELOCITY, but it says nothing about where the curve goes — and on a curved surface those
       * differ immediately, which is the whole point of the thing being aimed. Integrating one
       * curve costs a few milliseconds against the ~150 ms of a scene rebuild, so the real curve
       * is affordable as long as the scene is not rebuilt: `geodesicFrom` reuses the surface
       * already compiled for this frame.
       */
      const preview = lastScene?.geodesicFrom(
        gesture.rowId,
        [gesture.u, gesture.v],
        aimChart,
        previewLength(gesture.rowId),
      );

      previewLines = preview
        ? [{ polylines: [preview], style: { widthPx: 3.4 } }]
        : // Falling back to the straight arrow when the geodesic cannot be integrated — at a pole,
          // say — keeps the drag legible instead of silently showing nothing.
          [{
            polylines: [arrow(gesture.origin, direction, length, AIM_COLOR)],
            style: { widthPx: 3.4 },
          }];
      paintLines();
      renderer.invalidate();
      event.stopPropagation();
    },
    { capture: true },
  );

  canvas.addEventListener(
    "pointerup",
    (event: PointerEvent) => {
      const finished = gesture;
      gesture = { kind: "idle" };
      previewLines = [];

      if (finished.kind === "rotate") {
        renderer.camera.setAiming(false);
        onEdit(false);
        return;
      }

      if (finished.kind === "move") {
        renderer.camera.setAiming(false);

        /**
         * A press that did not travel was a CLICK, not a move.
         *
         * Taking ownership of the drag on pointerdown is what makes dragging an object work, and
         * it also swallows the click that used to select it — so the distinction has to be made
         * again on release, the same way the camera gesture makes it. The translation is put back
         * exactly, so a click cannot nudge an object by a pixel of hand tremor.
         */
        const travelled = Math.hypot(event.clientX - finished.x, event.clientY - finished.y);
        if (travelled <= CLICK_SLOP) {
          translations.set(finished.rowId, finished.grabbed);
          list.placeAt(event.clientX, event.clientY);
          list.select(finished.rowId, true);
          pickedAt = null;
          onEdit(false);
          return;
        }

        // One full-resolution pass at the end, as with any other drag.
        onEdit(false);
        return;
      }

      if (finished.kind === "aim") {
        renderer.camera.setAiming(false);
        paintLines();
        const overlay = overlays.get(finished.rowId);
        const [du, dv] = aimChart;
        aimChart = [0, 0];
        // A drag that never left its start has no direction to shoot along.
        if (overlay && (du !== 0 || dv !== 0)) {
          overlays.set(finished.rowId, {
            ...overlay,
            shots: [
              ...(overlay.shots ?? []),
              { start: [finished.u, finished.v], direction: [du, dv] },
            ],
          });
          onEdit(false);
        }
        return;
      }

      if (finished.kind !== "camera") return;
      const travelled = Math.hypot(event.clientX - finished.x, event.clientY - finished.y);
      if (travelled > CLICK_SLOP) return;

      const hit = pickAt(event);

      // Clicking empty space deselects, which is the only way to dismiss the card without
      // reaching for its close button.
      if (!hit) {
        list.select(null);
        return;
      }

      // Selecting an object opens its properties. This is the same act as clicking its row, and
      // both land in the list so the highlight and the card can never disagree.
      // The window opens where the click happened; the bar placement ignores this.
      list.placeAt(event.clientX, event.clientY);
      list.select(hit.rowId);
      pickedAt = { u: hit.u, v: hit.v };

      /**
       * A click on an armed surface also moves where its spray and curvature lines start.
       *
       * Only rows already showing one respond: clicking a bare surface should select it and
       * nothing more, rather than silently arming a feature the user has not asked for.
       */
      const overlay = overlays.get(hit.rowId);
      if (overlay && (overlay.geodesics > 0 || overlay.curvatureLines)) {
        overlays.set(hit.rowId, { ...overlay, start: [hit.u, hit.v] });
      }
      onEdit(false);
    },
    { capture: true },
  );

  /**
   * Right-click on empty space: pick a template, or start one of your own.
   *
   * The gallery button in the corner answers "show me the catalog"; this answers "put something
   * here", which is the thing you want when the scene is empty and the cursor is already where
   * you are looking. Typing into the field and pressing Enter creates a cell on the left, so the
   * menu is a shortcut into the same document rather than a separate way of making objects.
   */
  /**
   * Where a newly created object should sit.
   *
   * Two cases, and the difference is what the click landed on. On EMPTY SPACE the answer is
   * simply "there": the click ray is intersected with the plane through the scene's centre facing
   * the camera, which is the surface a viewer reads as "the place I am pointing at". On an
   * EXISTING SURFACE, dropping the new object at that point would bury it inside the old one, so
   * it is offset clear of that object's extent — beside it, along whichever screen direction has
   * the most room.
   *
   * Returns a translation, never a change to the formula. A parametrization says where its points
   * are relative to its own origin; where that origin sits is arrangement.
   */
  const placementFor = (event: MouseEvent, exclude: RowId): Vec3 => {
    const bounds = lastScene?.bounds;
    if (!bounds) return [0, 0, 0];

    const rect = canvas.getBoundingClientRect();
    const hit = renderer.pick(event.clientX - rect.left, event.clientY - rect.top);
    const point = renderer.unproject(
      event.clientX - rect.left,
      event.clientY - rect.top,
      bounds.center,
    );
    if (!point) return [0, 0, 0];

    if (!hit || hit.rowId === exclude) return point;

    /**
     * Landed on something: step aside rather than inside it.
     *
     * The offset is along the camera's own right vector, so "beside" means beside as SEEN, which
     * is what a person pointing at a crowded scene means. Its size comes from the scene's extent,
     * so it scales with whatever is already there.
     */
    const right = renderer.camera.basis().right;
    const step = bounds.radius * 1.2;
    return [point[0] + right[0] * step, point[1] + right[1] * step, point[2] + right[2] * step];
  };

  const menu = el("div", { class: "context-menu context-menu--hidden" });
  canvas.parentElement?.append(menu);

  const closeMenu = () => menu.classList.add("context-menu--hidden");

  canvas.addEventListener("contextmenu", (event: MouseEvent) => {
    event.preventDefault();
    // A right-press that landed on an object was a rotation, not a request for the menu.
    if (gesture.kind === "rotate") return;

    const field = el("input", {
      class: "field field--mono context-menu__field",
      placeholder: "X(u,v) = (…, …, …)",
      spellcheck: "false",
    }) as HTMLInputElement;

    field.addEventListener("keydown", (keyEvent: KeyboardEvent) => {
      if (keyEvent.key === "Escape") closeMenu();
      if (keyEvent.key !== "Enter") return;
      const source = field.value.trim();
      if (source === "") return;
      const row = store.addRow(source);
      translations.set(row.id, placementFor(event, row.id));
      closeMenu();
      onEdit(true);
      list.select(row.id);
    });

    replace(menu, [
      field,
      el("div", { class: "context-menu__label", text: "or load" }),
      el("div", { class: "context-menu__grid" },
        TEMPLATE_ENTRIES.map((entry) =>
          el("button", {
            class: "template",
            title: entry.blurb,
            text: entry.name,
            onClick: () => {
              entry.load();
              closeMenu();
            },
          }),
        )),
    ]);

    // Clamped to the viewport, like the properties window: a right-click near an edge is the
    // common case, not the exception.
    menu.classList.remove("context-menu--hidden");
    const margin = 8;
    const maxX = globalThis.innerWidth - menu.offsetWidth - margin;
    const maxY = globalThis.innerHeight - menu.offsetHeight - margin;
    menu.style.left = `${Math.max(margin, Math.min(maxX, event.clientX))}px`;
    menu.style.top = `${Math.max(margin, Math.min(maxY, event.clientY))}px`;
    field.focus();
  });

  // Any click elsewhere dismisses it, which is what a context menu is expected to do.
  globalThis.addEventListener("pointerdown", (event: PointerEvent) => {
    if (!menu.contains(event.target as Node)) closeMenu();
  });

  canvas.addEventListener("pointercancel", () => {
    if (gesture.kind !== "idle" && gesture.kind !== "camera") renderer.camera.setAiming(false);
    gesture = { kind: "idle" };
    previewLines = [];
    aimChart = [0, 0];
    paintLines();
  });

  /**
   * Which placement the properties use.
   *
   * Both are kept while it is being decided which reads better — they are one DOM with a
   * different class, so this costs a class toggle rather than a second implementation.
   */
  const placementToggle = el("input", {
    type: "checkbox",
    checked: true,
    onChange: (event: Event) => {
      list.setPlacement((event.target as HTMLInputElement).checked ? "cursor" : "bar");
    },
  }) as HTMLInputElement;
  list.setPlacement("cursor");

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

  /**
   * Scene-wide controls, in a card of their own on the stage.
   *
   * The expression bar is only cells now, so everything that is about the SCENE rather than about
   * one object had to go somewhere. Bottom left keeps it clear of the properties card (top right)
   * and of the chart inset (bottom right, drawn into the canvas itself). It starts collapsed so
   * the default view is the geometry and a column of cells, and nothing else.
   */
  /**
   * The legend follows whichever map the surfaces are painted with.
   *
   * Colour maps are chosen per surface but the scale is shared, so the legend can only honestly
   * label one map: it takes the first surface that has chosen one. A legend showing a different
   * ramp from the surface beside it would be worse than none.
   */
  const legendBar = el("div", { class: "legend" });
  const syncLegend = () => {
    let name: ColormapName = "curvature";
    for (const [, overlay] of overlays) {
      if (overlay.colormap && overlay.colormap !== "solid") {
        name = overlay.colormap;
        break;
      }
    }
    legendBar.style.background = legendGradient(name);
  };
  syncLegend();

  /**
   * The template gallery, behind a button in the stage's top right corner.
   *
   * A preset gallery is not a convenience here — text entry only works if nobody has to face an
   * empty box, which is one of the three affordances that make formula input viable at all. It
   * had ended up inside the collapsed scene card, which is the same as not having it.
   *
   * The icon is a curved patch with its chart lines, because that is what the button produces.
   */
  const templatesPanel = el("div", { class: "tool-popover tool-popover--hidden" }, [templates]);
  const templatesButton = el("button", {
    class: "tool-button",
    title: "surface and curve templates",
    html:
      '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" ' +
      'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M3 8 C 8 4, 16 12, 21 8"/>' +
      '<path d="M3 16 C 8 12, 16 20, 21 16"/>' +
      '<path d="M3 8 L 3 16"/><path d="M21 8 L 21 16"/>' +
      '<path d="M9.1 7.2 L 9.1 15.2" opacity="0.55"/>' +
      '<path d="M14.9 8.8 L 14.9 16.8" opacity="0.55"/>' +
      "</svg>",
  });
  templatesButton.addEventListener("click", () => {
    templatesPanel.classList.toggle("tool-popover--hidden");
  });
  canvas.parentElement?.append(
    el("div", { class: "stage-tools" }, [templatesButton, templatesPanel]),
  );

  /**
   * What is coming, on the stage rather than in a file.
   *
   * Kept where the work is visible so the direction stays in view while using the thing, rather
   * than living only in a plan nobody has open.
   */
  canvas.parentElement?.append(
    el("aside", { class: "roadmap" }, [
      el("span", { class: "roadmap__label", text: "A continuación" }),
      el("span", {
        class: "roadmap__items",
        text: "Campos vectoriales · métricas · piezas ensamblables",
      }),
    ]),
  );

  const sceneBody = el("div", { class: "scene-card__body" }, [
    el("section", { class: "panel-section" }, [
      el("h2", { class: "section-title", text: "Gaussian curvature" }),
      el("label", { class: "toggle" }, [curvatureToggle, el("span", { text: "paint K" })]),
      legendBar,
      legendLabels,
    ]),
    el("section", { class: "panel-section" }, [
      el("h2", { class: "section-title", text: "Properties" }),
      el("label", { class: "toggle" }, [
        placementToggle,
        el("span", { text: "as a window at the pointer" }),
      ]),
    ]),
    el("section", { class: "panel-section" }, [
      el("h2", { class: "section-title", text: "Chart" }),
      el("label", { class: "toggle" }, [
        chartToggle,
        el("span", { text: "show the (u, v) plane" }),
      ]),
    ]),
    el("section", { class: "panel-section" }, [
      el("h2", { class: "section-title", text: "Scene" }),
      stats,
    ]),
  ]);
  sceneBody.classList.add("scene-card__body--hidden");

  const sceneToggle = el("button", {
    class: "scene-card__toggle",
    title: "scene settings",
    text: "\u2699 scene",
    onClick: () => sceneBody.classList.toggle("scene-card__body--hidden"),
  });
  const sceneCard = el("div", { class: "scene-card" }, [sceneToggle, sceneBody]);
  canvas.parentElement?.append(sceneCard);

  const panel = document.querySelector<HTMLElement>(".panel");
  // Only the cells. Everything else lives on the stage, next to what it affects.
  if (panel) replace(panel, [list.root]);

  /**
   * Carry the scene across a hot reload.
   *
   * Only what the user made: the rows they typed, the values they dragged to, where they put
   * things, and the angle they are looking from. Everything else is derived and will be rebuilt.
   */
  installHotReloadGate(() => ({
    rows: store.rows().map((row) => row.source()),
    parameters: [...store.parameters()],
    sliders: [...sliders].map(([name, spec]) => [name, { ...spec }]),
    domains: [...domains].map(([id, ranges]) => [id, ranges.map((r) => ({ ...r }))]),
    colors: [...colors],
    translations: [...translations],
    overlays: [...overlays].map(([id, overlay]) => [id, { ...overlay }]),
    camera: renderer.camera.state(),
    selected: list.selected(),
  }));

  const session = takeHotSession();
  if (session) {
    const rowSources = session["rows"] as string[] | undefined;
    if (rowSources?.length) store.setRows(rowSources);
    const rows = store.rows();
    /**
     * Row ids are reassigned on `setRows`, so anything keyed by id is remapped by POSITION.
     * Saving the ids themselves would look more faithful and be wrong: they are identities within
     * one run of the document, not names that survive it.
     */
    const remap = <T>(saved: unknown): Map<RowId, T> => {
      const out = new Map<RowId, T>();
      const entries = (saved as [number, T][] | undefined) ?? [];
      for (const [index, [, value]] of entries.entries()) {
        const row = rows[index];
        if (row) out.set(row.id, value);
      }
      return out;
    };
    for (const [id, value] of remap<Vec3>(session["colors"])) colors.set(id, value);
    for (const [id, value] of remap<Vec3>(session["translations"])) translations.set(id, value);
    for (const [id, value] of remap<DomainRange[]>(session["domains"])) domains.set(id, value);
    for (const [id, value] of remap<SurfaceOverlay>(session["overlays"])) overlays.set(id, value);
    for (const [name, spec] of (session["sliders"] as [string, SliderSpec][] | undefined) ?? []) {
      sliders.set(name, spec);
    }
    for (const [name, value] of (session["parameters"] as [string, number][] | undefined) ?? []) {
      store.setParameter(name, value);
    }
    const camera = session["camera"] as Parameters<typeof renderer.camera.restore>[0] | undefined;
    if (camera) renderer.camera.restore(camera);
    list.invalidateSliders();
  }

  render(FULL_RESOLUTION, true, true);
  // The camera was restored deliberately; framing would undo it.
  if (session?.["camera"]) framedOnce = true;
}

main();
