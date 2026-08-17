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
import { createPiecePicker } from "./ui/pieces.ts";
import {
  pruneJoints,
  rootOf,
  sameSocket,
  type Joint,
  type Socket,
} from "./state/assembly.ts";
import { arrangedWith, spaceRoots } from "./state/spaces.ts";
import { portOutline } from "./core/geom/ports.ts";
import { createHistory } from "./state/history.ts";
import { createSceneFile } from "./ui/sceneFile.ts";
import {
  captureSession,
  makeSceneFile,
  restoreSession,
  sessionKey,
  type SessionSlots,
  type SessionState,
} from "./state/session.ts";
import type { SceneFlow, ScenePort } from "./state/scene.ts";
import type { FlowState } from "./core/geom/flow.ts";
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
  style: new Float32Array(0),
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
  /** Where each surface's coordinates start repeating, as the last build measured them. */
  const periods = new Map<RowId, readonly [number | null, number | null]>();
  /** Per-row colour, set from the properties card and used everywhere that row is drawn. */
  const colors = new Map<RowId, Vec3>();
  /** Where each object sits. Arrangement only — it never touches a curvature. */
  const translations = new Map<RowId, Vec3>();
  /** How each object is turned. Arrangement, like the translation — never a curvature. */
  const rotations = new Map<RowId, Quat>();
  /**
   * Which objects are plugged into which.
   *
   * A jointed row's placement is derived from its parent's every rebuild, so nothing here is a
   * transform — it is the statement that two boundaries are the same boundary.
   */
  const joints = new Map<RowId, Joint>();
  /** The free boundary a new piece will attach to, or null to drop pieces loose. */
  let activeSocket: Socket | null = null;
  /** Every free boundary in the scene, as last measured; the hit test reads this. */
  let scenePorts: readonly ScenePort[] = [];
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

  /**
   * Whose chart the inset is showing: the last PATCH that was selected, and nothing else.
   *
   * Selection moves for all sorts of reasons — clicking a cell to edit it, selecting a curve,
   * selecting a number — and none of them are a request to look at a different chart. Following
   * the selection literally meant that clicking into a cell swapped the corner back to the first
   * surface, which reads as the chart disappearing. So it changes when you click another surface
   * and at no other time.
   */
  let shownChart: RowId | null = null;
  /**
   * ---- ambient space ----
   *
   * Double-clicking an object asks "let me look at *this*", and the answer is a stage with
   * nothing else on it and the coordinate axes drawn, so the question becomes where the thing
   * sits as much as what shape it is. Held here rather than in the document: it is a way of
   * looking, not a fact about the scene, so it is not saved, not undone, and leaving it is one
   * field going null.
   */
  let isolated: RowId | null = null;

  /**
   * The way out, on screen.
   *
   * A mode you can only leave by rediscovering the gesture that got you in is a trap. This says
   * what the state is and undoes it, and it is the only chrome the mode adds.
   */
  const ambientBar = el("div", { class: "ambient", hidden: true }, [
    el("span", { class: "ambient__label", text: "ambient space" }),
    el("button", {
      class: "ambient__exit",
      text: "leave",
      title: "back to the whole document (or double-click the object again)",
      onClick: () => enterAmbient(null),
    }),
  ]);
  canvas.parentElement?.append(ambientBar);

  /** Is this row a patch — something with a chart of its own to show? */
  const isPatch = (id: RowId | null): boolean => {
    if (id === null) return false;
    const kind = store.resolution().items.get(id)?.kind;
    return kind === "parametricSurface" || kind === "graphSurface";
  };

  const render = (resolution: number, refit: boolean, fullRefresh: boolean) => {
    const resolved = store.resolution();

    // Live values win; declared numeric rows supply the rest. Both slider kinds write into
    // the document's parameter store, so reading it covers them uniformly.
    const parameters = new Map<string, number>(store.parameters());
    for (const [name, spec] of sliders) parameters.set(name, spec.value);

    // A deleted row cannot hold anything: its children come loose rather than following a ghost.
    pruneJoints(joints, new Set(store.rows().map((row) => row.id)));
    // The chart's patch may have been deleted or retyped into something else since it was chosen.
    if (shownChart !== null && !isPatch(shownChart)) shownChart = null;

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
      /**
       * Arrangement is dropped in ambient space, not just disabled.
       *
       * A hand translation is a presentation device: it moves the drawn geometry away from where
       * X puts it, which is exactly what this mode exists to show faithfully. A sphere dragged
       * over to (4, 0, 0) and then measured against the axes would be reporting a position its
       * formula does not claim. So while one object is isolated it is drawn where its own
       * parametrization places it — and the translations are still in the document, waiting, for
       * when the whole scene comes back.
       */
      translations: isolated === null ? translations : new Map<RowId, Vec3>(),
      rotations: isolated === null ? rotations : new Map<RowId, Quat>(),
      joints: isolated === null ? joints : new Map<RowId, Joint>(),
      // Click a patch and the corner shows ITS chart, with the rows stated in it drawn flat.
      // A deleted patch hands the chart back to the first surface rather than to nothing.
      chartRow: shownChart,
      // In ambient space: this object alone, with the axes to place it against.
      isolate: isolated,
      axes: isolated !== null,
      activeSocket,
      showPorts: assembling(),
    });

    /**
     * The sockets, as the scene measured them this build.
     *
     * Held rather than recomputed on demand, because the hit test runs on every pointerdown and
     * measuring a boundary means evaluating the parametrization sixty-four times per side.
     */
    scenePorts = scene.ports;
    periods.clear();
    for (const [rowId, pair] of scene.periods) periods.set(rowId, pair);
    // A socket whose boundary stopped existing — the formula changed, the row was deleted —
    // silently stops being the target rather than pointing at nothing.
    const chosen = activeSocket;
    if (chosen && !scenePorts.some((entry) => entry.free && sameSocket(chosen, socketOf(entry)))) {
      activeSocket = null;
    }

    renderer.setSurfaceMesh(scene.mesh ?? EMPTY_MESH);
    lastScene = scene;
    /**
     * The steppers are rebuilt with the scene; the particles are not.
     *
     * A stepper holds the compiled surface and field this build made, so it must not outlive it.
     * The state it steps is only chart coordinates and their images, so it survives — which is
     * what lets a flow keep running while its own formula is being edited.
     */
    flowRunners = new Map();
    // The hovered square belongs to the scene that answered for it; the next pointer move asks
    // the new one.
    hoverChart = null;
    hoverSurface = null;
    for (const rowId of [...flowStates.keys()]) {
      if (scene.flowFor(rowId)) continue;
      // The row stopped being a field: its particles have nowhere to be.
      flowStates.delete(rowId);
      flowLines.delete(rowId);
      flowChartLines.delete(rowId);
    }
    // The grid first, so a curve drawn on a surface sits over its grid rather than under it.
    sceneLines = [...scene.gridLines, ...scene.lines];
    paintLines();
    chartLines = scene.chartLines;
    paintChartLines();
    /**
     * The inset frames `chartView`, which is the domain widened to hold the curves drawn in it —
     * so a chart curve that leaves the surface is visible going where it goes, instead of the
     * chart looking exactly as small as the surface.
     */
    renderer.setChartBounds(chartVisible ? scene.chartView ?? scene.chartBounds : null);

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
    if (fullRefresh) list.refresh(scene.reports, scene.usedColors);
    else list.refreshReports(scene.reports);
    pieces.refresh();

    /**
     * Notice what changed, after everything else has settled.
     *
     * Nothing announces its own edits: the history compares the state it is handed against the
     * one on top of its stack, so a control added later is undoable without being told to be.
     * Here rather than at each mutation site for that reason, and cheap enough to run per frame.
     */
    history.observe(captureSession(slots));
  };

  /** A scene port as the socket that names it. */
  const socketOf = (entry: ScenePort): Socket => ({
    rowId: entry.rowId,
    boundary: entry.port.boundary,
  });

  /**
   * Whether the scene is being assembled, which decides both whether handles are drawn and
   * whether a press near one means anything.
   *
   * The two have to agree. A ring that is clickable but not drawn is a press that does something
   * unexplained; one drawn but not clickable is worse. So the parts bin being open, a socket
   * being chosen, or anything already being joined all count, and nothing else does.
   */
  const assembling = () =>
    joints.size > 0 ||
    activeSocket !== null ||
    !piecesPanel.classList.contains("tool-popover--hidden");

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
    periods,
    /**
     * Selecting another PATCH moves the chart, and only that.
     *
     * The rebuild is what redraws the inset, and it costs a tessellation — so it is asked for
     * only when the answer would differ. Selecting a curve, a number, or the same patch again
     * changes nothing about the scene and is left alone.
     */
    onFlowTick,
    onFlowRewind,
    onFlowToggle,
    onEnterSpace: (rowId: RowId) => enterAmbient(rowId),
    onSelect: (id) => {
      if (!isPatch(id) || id === shownChart) return;
      shownChart = id;
      onEdit(false);
    },
  });
  /**
   * The properties strip is a sibling of the panel and the stage, not a child of either.
   *
   * It spans the full width of the grid's first row, so it has to live in `.app`; nested inside
   * the stage it could only ever have been an overlay on top of the geometry.
   */
  document.querySelector(".app__props")?.append(list.card);
  /**
   * Put a new object beside whatever is already there.
   *
   * Both the gallery and the parts bin add to the document rather than replacing it, so without
   * this a second surface would be created inside the first — two objects sharing an origin,
   * which reads as one broken object rather than as two.
   */
  const placeBeside = (rowId: RowId) => {
    const bounds = lastScene?.bounds;
    if (!bounds || (translations.size === 0 && store.rows().length <= 2)) return;
    const right = renderer.camera.basis().right;
    const step = bounds.radius * 2.2;
    translations.set(rowId, [
      bounds.center[0] + right[0] * step,
      bounds.center[1] + right[1] * step,
      bounds.center[2] + right[2] * step,
    ]);
  };

  const templates = createTemplatePicker({
    document: store,
    sliders,
    domains,
    // Inside an ambient space, a template loads into that space like anything else written there.
    prefix: rowPrefix,
    requestRender: (refit: boolean) => onEdit(refit),
    invalidateSliders: () => list.invalidateSliders(),
    onCreated: placeBeside,
  });

  /**
   * The parts bin: pieces that snap to a chosen boundary.
   *
   * Given the same `onCreated` as the template gallery, so a piece that cannot be joined — no
   * socket chosen, or one of the wrong shape — still lands somewhere with room rather than inside
   * whatever is already there.
   */
  const pieces = createPiecePicker({
    document: store,
    domains,
    joints,
    socket: () => {
      const chosen = activeSocket;
      if (!chosen) return null;
      return scenePorts.find((entry) => entry.free && sameSocket(chosen, socketOf(entry))) ?? null;
    },
    setSocket: (socket) => {
      activeSocket = socket;
    },
    selected: () => list.selected(),
    surfaceOf: (rowId) =>
      rowId === null
        ? null
        : lastScene?.surfaces.find((surface) => surface.patches.includes(rowId)) ?? null,
    detach: (rowId) => {
      /**
       * Unplugged, and left exactly where it was.
       *
       * The current placement is baked back into the hand arrangement first. Without that the
       * piece would fall back to whatever translation it was created with — usually the origin —
       * and jump across the scene, which reads as having deleted and re-added it.
       */
      const arrangement = lastScene?.arrangementOf(rowId);
      joints.delete(rowId);
      if (arrangement) {
        rotations.set(rowId, arrangement.rotation);
        translations.set(rowId, arrangement.offset);
      }
      onEdit(false);
    },
    requestRender: (refit: boolean) => onEdit(refit),
    onParameterChange: () => onParameterChange(),
    onCreated: (rowId: RowId) => placeBeside(rowId),
  });

  /**
   * The live state, as one bundle.
   *
   * Undo and the hot-reload gate want exactly the same thing — everything the user made and
   * nothing derived — so they share one capture and one restore (`state/session.ts`). Anything
   * added here later is carried by both, or by neither, rather than by whichever was remembered.
   */
  const slots: SessionSlots = {
    document: store,
    sliders,
    domains,
    colors,
    translations,
    rotations,
    overlays,
    frames,
    inChart,
    joints,
    selected: () => list.selected(),
    select: (rowId) => list.select(rowId),
    socket: () => activeSocket,
    setSocket: (socket) => {
      activeSocket = socket;
    },
  };

  /**
   * Undo, over whole snapshots of that bundle.
   *
   * A change that alters the number of rows is its own step — adding a piece, deleting a cell —
   * while everything else merges with whatever landed just before it, so a drag or a burst of
   * typing is one Ctrl-Z rather than four hundred.
   */
  const history = createHistory<SessionState>({
    key: sessionKey,
    boundary: (previous, next) => previous.rows.length !== next.rows.length,
  });

  const applyHistory = (state: SessionState | null) => {
    if (!state) return;
    restoreSession(state, slots);
    // The slider specs were replaced wholesale, so the list has to rebuild them rather than
    // reuse the controls it built for the old ones.
    list.invalidateSliders();
    onEdit(false);
  };

  /**
   * Ctrl-Z, unless something is being typed in.
   *
   * A focused field owns its own undo, and taking it over would mean losing a caret's worth of
   * typing to a keystroke that has meant "undo my last word" everywhere else for thirty years.
   * The same rule the Escape handler follows: look at what the event landed on.
   */
  globalThis.addEventListener("keydown", (event: KeyboardEvent) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    const redo = key === "y" || (key === "z" && event.shiftKey);
    if (key !== "z" && key !== "y") return;

    const target = event.target as HTMLElement | null;
    if (target?.closest("input, textarea, select")) return;

    event.preventDefault();
    applyHistory(redo ? history.redo() : history.undo());
  });

  /**
   * Saving to a file, and opening one.
   *
   * The same snapshot undo and the hot-reload gate use, tagged and versioned on the way out — so
   * a scene is a small piece of JSON the user owns, and a figure in the eventual book can be
   * reproduced from the file that made it rather than from a screenshot of it.
   */
  const sceneFile = createSceneFile({
    capture: () => makeSceneFile(captureSession(slots), renderer.camera.state()),
    restore: ({ scene, camera }) => {
      restoreSession(scene as SessionState, slots);
      list.invalidateSliders();
      if (camera) renderer.camera.restore(camera as Parameters<typeof renderer.camera.restore>[0]);
      // An opened scene frames itself: it was saved from a camera that may not suit this window.
      onEdit(!camera);
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
        /**
         * Whose translation actually moves: the root of the assembly this row belongs to.
         *
         * A joined piece has no translation of its own — its placement is derived from its
         * parent's — so moving one has to move the object at the top of the chain, and the whole
         * assembly comes with it. Dragging a piece to pull it out of a chain would be the other
         * reading, and it is the wrong one: the joint is a statement about the boundaries, not a
         * hint, so breaking it is `detach`'s job and not a side effect of a drag.
         */
        readonly moveId: RowId;
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
        /** the root of its assembly, for the same reason a move has one */
        readonly moveId: RowId;
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

  /**
   * Which of the scene's groups reach this frame.
   *
   * A field's arrows are left out while its flow is playing — a current read through a hedge of
   * arrows is neither — and whenever the row's own switch says so. Both are decisions about the
   * FRAME, not about the document, so they are made here by dropping a group rather than by
   * rebuilding a scene without it: play and pause then cost a repaint instead of a tessellation.
   */
  const visibleSceneLines = (): readonly LineGroup[] => {
    const arrows = lastScene?.fieldArrows;
    if (!arrows || arrows.size === 0) return sceneLines;
    const hidden = new Set<LineGroup>();
    for (const [rowId, group] of arrows) {
      const wanted = overlays.get(rowId)?.arrows ?? true;
      if (!wanted || animator.playing(`flow:${rowId}`)) hidden.add(group);
    }
    return hidden.size === 0 ? sceneLines : sceneLines.filter((group) => !hidden.has(group));
  };

  /**
   * The inset's groups, filtered by the same rule the stage's are.
   *
   * A field's arrows are drawn in the chart as well — its components in the basis {∂/∂u, ∂/∂v} —
   * so they have to come and go with the ones on the surface, or playing a flow would clear the
   * arrows in space and leave a hedge of them downstairs.
   */
  const visibleChartLines = (): readonly LineGroup[] => {
    const arrows = lastScene?.fieldChartArrows;
    const flows = visibleFlows(flowChartLines);
    if (!arrows || arrows.size === 0) {
      return flows.length === 0 ? chartLines : [...chartLines, ...flows];
    }
    const hidden = new Set<LineGroup>();
    for (const [rowId, group] of arrows) {
      const wanted = overlays.get(rowId)?.arrows ?? true;
      if (!wanted || animator.playing(`flow:${rowId}`)) hidden.add(group);
    }
    const base = hidden.size === 0 ? chartLines : chartLines.filter((g) => !hidden.has(g));
    return flows.length === 0 ? base : [...base, ...flows];
  };

  /**
   * ---- the hovered square ----
   *
   * Moving over the inset picks out the grid square under the pointer and the patch of surface it
   * maps to. That is the parametrization made visible one cell at a time, which is the reason the
   * two pictures are side by side at all — and it is a *frame* decision, so it is composed here
   * rather than rebuilt into the scene.
   */
  let hoverChart: LineGroup | null = null;
  let hoverSurface: LineGroup | null = null;

  const setHover = (at: readonly [number, number] | null): boolean => {
    const cell = at === null ? null : lastScene?.chartCellAt(at[0], at[1]) ?? null;
    const had = hoverChart !== null;
    if (!cell) {
      hoverChart = null;
      hoverSurface = null;
      return had;
    }
    hoverChart = { polylines: [cell.chart], style: { widthPx: 3 } };
    hoverSurface = cell.surface
      ? { polylines: [cell.surface], style: { widthPx: 3.5 } }
      : null;
    return true;
  };

  /**
   * The streaks that reach this frame: only those of a field this build actually drew.
   *
   * The particles are app state, deliberately — they survive a rebuild so a flow keeps running
   * while its own formula is edited. The cost of that is that they also survive a rebuild which
   * stopped drawing the field: stepping into an ambient space leaves every other object off the
   * stage, and the swarms went on being painted over the axes with nothing under them. So the
   * scene is asked, per frame, whether the row was drawn — `usedColors` is exactly the record of
   * "what this build put on screen" — and a row it did not draw contributes nothing, without
   * losing its particles. Leaving the space brings them back mid-flight.
   */
  const visibleFlows = (streaks: Map<RowId, LineGroup[]>): LineGroup[] => {
    if (streaks.size === 0) return [];
    const out: LineGroup[] = [];
    for (const [rowId, groups] of streaks) {
      if (lastScene !== null && !lastScene.usedColors.has(rowId)) continue;
      out.push(...groups);
    }
    return out;
  };

  const paintChartLines = () => {
    const base = visibleChartLines();
    renderer.setChartLines(hoverChart ? [...base, hoverChart] : base);
  };

  const paintLines = () => {
    // Flows over the scene and under the preview: the streaks belong to the objects, the aiming
    // arrow belongs to the hand.
    const flows = visibleFlows(flowLines);
    const base = visibleSceneLines();
    const hovered = hoverSurface ? [hoverSurface] : [];
    renderer.setLines(
      flows.length === 0 && previewLines.length === 0 && hovered.length === 0
        ? base
        : [...base, ...flows, ...hovered, ...previewLines],
    );
  };

  /**
   * ---- flows ----
   *
   * The particles of every playing field, kept **here** rather than in the scene, and for the
   * same reason the aimed geodesics are: the scene is rebuilt whenever anything is edited, and a
   * flow that emptied and reseeded every time a slider moved would be a picture of the rebuild
   * rather than of the field. Their positions are chart coordinates, which go on meaning the same
   * thing across a rebuild.
   */
  const flowStates = new Map<RowId, FlowState>();
  /** The flow machinery from the current scene, one per row, dropped when the scene is replaced. */
  let flowRunners = new Map<RowId, SceneFlow>();
  /** The streaks as last advanced, drawn over the scene like the aiming preview. */
  const flowLines = new Map<RowId, LineGroup[]>();
  /** And the same streaks flat, for the inset. */
  const flowChartLines = new Map<RowId, LineGroup[]>();
  /** The scene's own inset content, held so a flow frame can be composed over it. */
  let chartLines: readonly LineGroup[] = [];

  const runnerFor = (rowId: RowId): SceneFlow | null => {
    const existing = flowRunners.get(rowId);
    if (existing) return existing;
    const made = lastScene?.flowFor(rowId) ?? null;
    // Cached because building one allocates a jet buffer, and this is asked for once per frame.
    if (made) flowRunners.set(rowId, made);
    return made;
  };

  // Function declarations, so the expression list built above can be handed them: they are
  // called only once an animation is running, long after everything here is in place.
  function onFlowTick(rowId: RowId, seconds: number): void {
    const runner = runnerFor(rowId);
    if (!runner) return;
    let state = flowStates.get(rowId);
    if (!state) {
      state = runner.seed();
      flowStates.set(rowId, state);
    }
    runner.advance(state, seconds);
    flowLines.set(rowId, runner.lines(state));
    flowChartLines.set(rowId, runner.chartLines(state));
    paintLines();
    paintChartLines();
    renderer.invalidate();
  }

  /** Played, paused or rewound: the arrows come or go, so the frame is composed again. */
  function onFlowToggle(_rowId: RowId): void {
    paintLines();
    paintChartLines();
    renderer.invalidate();
  }

  function onFlowRewind(rowId: RowId): void {
    const runner = runnerFor(rowId);
    if (!runner) return;
    const state = runner.seed();
    flowStates.set(rowId, state);
    flowLines.set(rowId, runner.lines(state));
    flowChartLines.set(rowId, runner.chartLines(state));
    paintLines();
    paintChartLines();
    renderer.invalidate();
  }

  /**
   * Who a drag on this object actually moves.
   *
   * Two redirections, composed. A **joint** hands the drag to the top of the chain it is part of,
   * because a piece snapped onto a tube is not something you can pull off by dragging it. An
   * **ambient space** hands it to the object whose space it is: a point at (1, 2, 3) beside a
   * torus is at (1, 2, 3) *of that torus's space*, and a gesture that moved the two apart would
   * make the sentence false. `scene.ts` reads placements through the same `spaceRoots`, so the
   * hand and the picture cannot disagree about who moves.
   */
  const movedBy = (rowId: RowId): RowId => {
    const spaces = spaceRoots(store.resolution().items.values());
    return rootOf(arrangedWith(rowId, spaces), joints);
  };

  const rect0 = (_event: MouseEvent) => canvas.getBoundingClientRect();

  canvas.addEventListener("pointerleave", () => {
    if (!setHover(null)) return;
    paintLines();
    paintChartLines();
    renderer.invalidate();
  });

  const pickAt = (event: MouseEvent) => {
    const rect = rect0(event);
    return renderer.pick(event.clientX - rect.left, event.clientY - rect.top);
  };

  /**
   * How near a free boundary the pointer has to be, in CSS pixels, to mean it.
   *
   * Measured against the ring **as drawn**, not against its centre: the handle you see is what you
   * click, which for a wide rim is a long way from the middle of it.
   */
  const SOCKET_HIT_PX = 16;
  /** Coarse: enough to follow the ring, cheap enough to run on every press. */
  const SOCKET_HIT_SAMPLES = 24;

  const socketAt = (event: PointerEvent): ScenePort | null => {
    const rect = rect0(event);
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    let best: ScenePort | null = null;
    let bestDepth = Infinity;

    for (const entry of scenePorts) {
      if (!entry.free) continue;
      let near = false;
      let depth = Infinity;
      for (const point of portOutline(entry.port, SOCKET_HIT_SAMPLES)) {
        const screen = renderer.project(point);
        if (!screen) continue;
        if (Math.hypot(screen.x - x, screen.y - y) > SOCKET_HIT_PX) continue;
        near = true;
        depth = Math.min(depth, screen.distance);
      }
      // The nearest ring wins where several overlap, which is what "the one in front" means.
      if (near && depth < bestDepth) {
        best = entry;
        bestDepth = depth;
      }
    }
    return best;
  };

  /**
   * Double click: the controls, over the thing they control.
   *
   * The second half of the split above. A double click has already selected the object through
   * the first click's pointerup, so this only has to reveal the card — which is why it can be an
   * ordinary listener rather than part of the gesture machine.
   */
  /**
   * Enter and leave the ambient space of one object.
   *
   * Asymmetric on purpose. **Double-click** enters, and does nothing else — while you are inside,
   * double-clicking is still how you open an object's controls, and a gesture that also threw you
   * out of the mode would make the two impossible to use together. **Double right-click** leaves,
   * from anywhere, and so does the banner: getting out must not depend on hitting anything.
   */
  /**
   * What every new row starts with: nothing, or the prefix of the space being looked at.
   *
   * One rule, applied wherever a row can be created — the empty cell, the gallery, the formula box
   * on the canvas. A row made inside a space and left unprefixed would belong to the document,
   * which draws it somewhere you cannot see and hides it from the panel you are looking at.
   */
  function rowPrefix(): string {
    if (isolated === null) return "";
    const name = store.resolution().items.get(isolated)?.name;
    return name == null ? "" : `${name}: `;
  }

  const enterAmbient = (rowId: RowId | null) => {
    if (isolated === rowId) return;
    isolated = rowId;
    ambientBar.hidden = rowId === null;
    /**
     * The panel follows the stage.
     *
     * Inside an ambient space the list is about that object: its own row, everything stated on it,
     * and the parameters it is built from. Anything else belongs to a scene that is not on screen,
     * and showing it would make the panel a list of things the stage refuses to draw.
     */
    const name = rowId === null ? null : store.resolution().items.get(rowId)?.name ?? null;
    list.setScope(rowId !== null && name !== null ? { name, rowId } : null);
    // Refit: the stage now holds one object where it held a document, or the other way round, and
    // the camera has no business staying framed on what is no longer there.
    onEdit(true);
  };

  canvas.addEventListener("dblclick", (event: MouseEvent) => {
    const hit = pickAt(event);
    if (!hit) return;
    // Focus, not open: the controls are a right click away now, and a double click that also
    // threw a card over the object it just stepped into would be answering two questions at once.
    list.select(hit.rowId, false);
    /**
     * An ambient space has no way into another one, and that is the point of it.
     *
     * Everything written while inside one belongs to it — a second surface typed there **shares**
     * this space rather than owning a space of its own — so there is nothing to step into, and
     * offering the gesture would suggest a hierarchy of spaces that does not exist. Inside, a
     * double click means what it means everywhere else: open this object's controls.
     */
    if (isolated !== null) return;
    /**
     * Double-clicking an object opens **the space it is in**, not the object.
     *
     * A space is where things are built, so a torus written in A belongs to A and what you want
     * to see beside it is everything else in A — the other objects, the axes they share. An
     * object with no space of its own to belong to still answers the gesture, as its own space:
     * a document that has never made one is not a document that cannot look at anything.
     */
    const spaces = spaceRoots(store.resolution().items.values());
    const root = arrangedWith(hit.rowId, spaces);
    enterAmbient(root);
  });

  /**
   * The way out: two right-presses in quick succession.
   *
   * The browser fires `dblclick` for the left button only, so this is counted by hand — same
   * window and same slop the rest of the file uses for "a press that did not travel". It is
   * checked on `contextmenu` rather than on `pointerdown` so that a right-DRAG, which turns an
   * object, cannot be mistaken for half of it.
   */
  let lastRightPress = { time: 0, x: 0, y: 0 };
  const DOUBLE_RIGHT_MS = 500;

  const isDoubleRight = (event: MouseEvent): boolean => {
    const now = event.timeStamp;
    const travelled = Math.hypot(event.clientX - lastRightPress.x, event.clientY - lastRightPress.y);
    const quick = now - lastRightPress.time < DOUBLE_RIGHT_MS && travelled <= CLICK_SLOP;
    lastRightPress = quick
      ? { time: 0, x: 0, y: 0 }
      : { time: now, x: event.clientX, y: event.clientY };
    return quick;
  };

  canvas.addEventListener(
    "pointerdown",
    (event: PointerEvent) => {
      /**
       * A press on a free boundary chooses it, before anything else looks at the event.
       *
       * The handles are drawn ON the surfaces they belong to, so a press near one would otherwise
       * be read as a press on the object and start dragging it. Sockets come first because they
       * are small, deliberate targets and the surface behind them is a large one.
       */
      if (event.button === 0 && assembling()) {
        const socket = socketAt(event);
        if (socket) {
          const chosen = socketOf(socket);
          // Clicking the chosen one again lets it go, so a piece can be dropped loose without
          // hunting for empty space to click.
          activeSocket = sameSocket(activeSocket, chosen) ? null : chosen;
          gesture = { kind: "idle" };
          onParameterChange();
          event.stopPropagation();
          event.preventDefault();
          return;
        }
      }

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
      if (hit && event.button === 2 && isolated === null) {
        const moveId = movedBy(hit.rowId);
        gesture = {
          kind: "rotate",
          rowId: hit.rowId,
          moveId,
          startRotation: rotations.get(moveId) ?? QUAT_IDENTITY,
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
      /**
       * Nothing is arranged in ambient space.
       *
       * The mode's claim is that this is how the surface sits in R³ — where its own formula puts
       * it, against the axes — and a gesture that moved it would make the picture a lie about the
       * thing it is a picture of. The camera still orbits: looking at an object from another side
       * is not moving it.
       */
      if (hit && lastScene && isolated === null) {
        const from = renderer.unproject(
          event.clientX - rect0(event).left,
          event.clientY - rect0(event).top,
          surfacePointAt(hit.rowId, hit.u, hit.v) ?? lastScene.bounds?.center ?? [0, 0, 0],
        );
        if (from) {
          const moveId = movedBy(hit.rowId);
          gesture = {
            kind: "move",
            rowId: hit.rowId,
            moveId,
            grabbed: translations.get(moveId) ?? [0, 0, 0],
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
      /**
       * The hovered square, before anything else looks at the event.
       *
       * Only while no gesture is running: during a drag the pointer is saying something about the
       * object it grabbed, and a highlight following it into the corner would be answering a
       * question nobody asked. Repainting is two array spreads and an upload, so this can run on
       * every move — it does NOT rebuild the scene, which is what would make it feel heavy.
       */
      if (gesture.kind === "idle") {
        const rect = rect0(event);
        const at = renderer.chartAt(event.clientX - rect.left, event.clientY - rect.top);
        if (setHover(at)) {
          paintLines();
          paintChartLines();
          renderer.invalidate();
        }
      }

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
          gesture.moveId,
          quatMultiply(spin, rotations.get(gesture.moveId) ?? QUAT_IDENTITY),
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
        translations.set(gesture.moveId, [
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
        /**
         * A right press that did not travel was a **click**, and a right click opens the object's
         * controls.
         *
         * One press, one menu — the way every other application answers a right click, and the
         * gesture that was missing here: the card used to need a double click, which is also how
         * you enter an ambient space, so the two were competing for one action. Turning the object
         * is the same button *travelling*, exactly as a left drag moves it and a left click
         * selects it, so nothing had to be given up to free the gesture.
         *
         * It does not disturb the way out of a space either: `contextmenu` returns early while a
         * rotate gesture is live, so a right press on an object never counts toward the double
         * right-click, and two of them on an object open the card twice rather than leaving.
         */
        const travelled = Math.hypot(event.clientX - finished.x, event.clientY - finished.y);
        if (travelled <= CLICK_SLOP) {
          list.placeAt(event.clientX, event.clientY);
          list.select(finished.rowId, true);
          return;
        }
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
          translations.set(finished.moveId, finished.grabbed);
          // Focus, not open: see the pointerup handler below on why the two are different acts.
          list.placeAt(event.clientX, event.clientY);
          list.select(finished.rowId, false);
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

      /**
       * A single click **focuses** an object; it does not open its controls.
       *
       * Clicking a surface is the ordinary way to ask "which one am I looking at" — it turns the
       * inset into that patch's chart and highlights its row, and both are answers you want while
       * still holding the camera. A panel of sliders under the pointer is not: it covers the
       * object you just pointed at, and it appears every time you glance at something. So the
       * sliders wait for a **double click**, which is a deliberate second act rather than a side
       * effect of looking. Both go through the list, so the highlight, the inset and the card can
       * never disagree about what is selected.
       */
      list.placeAt(event.clientX, event.clientY);
      list.select(hit.rowId, false);
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

    // Two of them in quick succession leaves ambient space, and open no menu.
    if (isDoubleRight(event)) {
      if (isolated !== null) enterAmbient(null);
      return;
    }

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
      // Written inside an ambient space, it belongs to that space — the same rule the cells and
      // the gallery follow.
      const row = store.addRow(`${rowPrefix()}${source}`);
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

  /**
   * Escape lets the chosen socket go.
   *
   * Choosing one changes what every piece button does, so there has to be a way out that is not
   * "find the ring again and click it exactly". Typing is left alone: a field owns its own
   * Escape, and stealing it here would break the context menu's.
   */
  globalThis.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key !== "Escape" || !activeSocket) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest("input, textarea, select")) return;
    activeSocket = null;
    onParameterChange();
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
    title: "coordinate patches and curves",
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
    piecesPanel.classList.add("tool-popover--hidden");
  });

  /**
   * The parts bin, under its own button beside the gallery.
   *
   * The icon is two pieces meeting at a rim, because that is the thing being built: a ring where
   * one surface ends and the next begins.
   */
  const piecesPanel = el("div", { class: "tool-popover tool-popover--hidden" }, [pieces.root]);
  const piecesButton = el("button", {
    class: "tool-button",
    title: "pieces that snap together",
    html:
      '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" ' +
      'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M4 8 L 4 16"/><path d="M11 8 L 11 16"/>' +
      '<ellipse cx="11" cy="12" rx="1.9" ry="4"/>' +
      '<path d="M13 9.2 L 20 7"/><path d="M13 14.8 L 20 17"/>' +
      '<ellipse cx="20" cy="12" rx="1.6" ry="5" opacity="0.55"/>' +
      "</svg>",
  });
  piecesButton.addEventListener("click", () => {
    piecesPanel.classList.toggle("tool-popover--hidden");
    templatesPanel.classList.add("tool-popover--hidden");
    // Opening the bin is what makes the handles appear, so the scene has to be redrawn for it.
    onParameterChange();
  });

  canvas.parentElement?.append(
    el("div", { class: "stage-tools" }, [
      // The buttons stay side by side so opening one panel cannot push the other button down
      // the screen while the user is reaching for it.
      el("div", { class: "stage-tools__row" }, [templatesButton, piecesButton]),
      templatesPanel,
      piecesPanel,
    ]),
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
        text: "Campos vectoriales · métricas · pantalón (cobordismos)",
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
      sceneFile.root,
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
   * The same snapshot undo uses, plus the camera — which is not part of the document and so is
   * not something to undo, but is very much part of where you were.
   */
  installHotReloadGate(() => ({
    scene: captureSession(slots),
    camera: renderer.camera.state(),
  }));

  const session = takeHotSession();
  if (session) {
    const saved = session["scene"] as SessionState | undefined;
    if (saved) {
      restoreSession(saved, slots);
      list.invalidateSliders();
    }
    const camera = session["camera"] as Parameters<typeof renderer.camera.restore>[0] | undefined;
    if (camera) renderer.camera.restore(camera);
  }

  render(FULL_RESOLUTION, true, true);
  // The camera was restored deliberately; framing would undo it.
  if (session?.["camera"]) framedOnce = true;
}

main();
