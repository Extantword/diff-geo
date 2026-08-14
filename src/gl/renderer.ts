import type { TessellatedSurface } from "../core/mesh/tessellate.ts";
import { createCamera, type Camera } from "./camera.ts";
import type { Device } from "./device.ts";
import {
  createLinesPass,
  type LineGroup,
  type LineStats,
  type LinesPass,
} from "./passes/lines.ts";
import { createPickPass, type PickPass, type PickResult } from "./passes/pick.ts";
import { createSurfacePass, type SurfacePass } from "./passes/surface.ts";
import { multiply, orthographic } from "./mat4.ts";

/**
 * Pass orchestration and the frame loop.
 *
 * The loop is **dirty-driven**: it draws only when something actually changed, or
 * while the camera is still damping toward its target. An always-on render loop
 * would burn a laptop battery displaying a static torus, and — more importantly —
 * it hides accidental per-frame recomputation, which is exactly the bug class that
 * matters once retessellating a user formula sits in the pipeline.
 */
export interface Renderer {
  camera: Camera;
  setSurfaceMesh(mesh: TessellatedSurface): void;
  /** 0 shows a flat colour, 1 shows Gaussian curvature. */
  setCurvatureMix(amount: number): void;
  /** Replace every drawn polyline. Grouped by style, one draw call per group. */
  setLines(groups: readonly LineGroup[]): void;
  /**
   * Content for the chart inset: polylines in (u, v), drawn orthographically in a corner.
   *
   * A separate pass instance rather than a second use of the 3D one, because each owns a
   * single instance buffer — sharing it would mean re-uploading both sets every frame.
   */
  setChartLines(groups: readonly LineGroup[]): void;
  /** The (u, v) rectangle the inset shows, or null to hide it. */
  setChartBounds(bounds: { u: [number, number]; v: [number, number] } | null): void;
  setSurfaceVisible(visible: boolean): void;
  /** Request one redraw on the next frame. */
  invalidate(): void;
  /** What each line pass did last frame, for the on-screen diagnostics. */
  lineStats(): { main: LineStats; chart: LineStats };
  /**
   * What surface lies under a point in CSS pixels, with the origin at the canvas's top left —
   * matching a pointer event, since that is the only caller.
   *
   * Returns null over empty space, and also when float render targets are unavailable; use
   * `pickAvailable()` to tell those two apart.
   */
  pick(cssX: number, cssY: number): PickResult | null;
  pickAvailable(): { available: boolean; reason: string };
  start(): void;
  stop(): void;
  dispose(): void;
}

const BACKGROUND: [number, number, number] = [1, 1, 1];
/** Slightly recessed, so the inset reads as a separate surface rather than a hole. */
const INSET_BACKGROUND: [number, number, number] = [0.964, 0.972, 0.980];

export function createRenderer(device: Device): Renderer {
  const { gl } = device;
  const camera = createCamera();
  const surfacePass: SurfacePass = createSurfacePass(gl);
  const linesPass: LinesPass = createLinesPass(gl);
  const chartLinesPass: LinesPass = createLinesPass(gl);
  const pickPass: PickPass = createPickPass(gl);

  let dirty = true;
  let running = false;
  let frame = 0;
  let detachCamera: (() => void) | null = null;
  let chartBounds: { u: [number, number]; v: [number, number] } | null = null;

  const invalidate = () => {
    dirty = true;
  };

  const drawFrame = () => {
    const resized = device.resize();
    const cameraMoving = camera.update();
    if (!dirty && !cameraMoving && !resized) return;
    dirty = false;

    gl.viewport(0, 0, device.width, device.height);
    gl.clearColor(BACKGROUND[0], BACKGROUND[1], BACKGROUND[2], 1);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const aspect = device.width / Math.max(1, device.height);
    const view = camera.view();
    const projection = camera.projection(aspect);
    const eye = camera.eye();

    surfacePass.draw(view, projection, eye);
    // Lines after the surface: they blend, and they depth-test against it.
    linesPass.draw(multiply(projection, view), device.width, device.height);

    drawChartInset();
  };

  /**
   * The chart inset: a second viewport in the corner showing the (u, v) domain flat.
   *
   * Same context and same passes as the main view — only the viewport and the projection
   * differ. A scissor confines the clear, so the inset gets its own background without
   * touching the 3D view behind it.
   */
  const drawChartInset = () => {
    if (!chartBounds) return;

    const margin = Math.round(Math.min(device.width, device.height) * 0.02);
    const size = Math.round(Math.min(device.width, device.height) * 0.3);
    if (size < 32) return; // too small to read; better to omit than to draw noise

    const x = margin;
    const y = margin;

    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(x, y, size, size);
    gl.viewport(x, y, size, size);
    gl.clearColor(INSET_BACKGROUND[0], INSET_BACKGROUND[1], INSET_BACKGROUND[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    // A little padding so the domain border is not flush against the edge.
    const [u0, u1] = chartBounds.u;
    const [v0, v1] = chartBounds.v;
    const padU = (u1 - u0) * 0.08 || 0.1;
    const padV = (v1 - v0) * 0.08 || 0.1;
    const projection = orthographic(u0 - padU, u1 + padU, v0 - padV, v1 + padV);

    chartLinesPass.draw(projection, size, size, x, y);

    gl.disable(gl.SCISSOR_TEST);
    gl.viewport(0, 0, device.width, device.height);
  };

  const tick = () => {
    if (!running) return;
    drawFrame();
    frame = requestAnimationFrame(tick);
  };

  const onWindowResize = () => invalidate();

  return {
    camera,

    pick(cssX, cssY) {
      if (!pickPass.available) return null;
      /**
       * Two conversions, both easy to get wrong and silently off by a factor.
       *
       * The device pixel ratio scales CSS pixels to the framebuffer's, and the y axis flips:
       * pointer events measure down from the top, GL measures up from the bottom.
       */
      const scale = device.width / Math.max(1, device.canvas.clientWidth);
      const x = cssX * scale;
      const y = device.height - cssY * scale;
      if (x < 0 || y < 0 || x >= device.width || y >= device.height) return null;

      const aspect = device.width / Math.max(1, device.height);
      const viewProjection = multiply(camera.projection(aspect), camera.view());
      const hit = pickPass.pick(x, y, viewProjection, device.width, device.height);
      // The pick pass leaves its own framebuffer bound to null but rebinds nothing else, so
      // the next frame has to reissue its own state. Marking dirty is what guarantees that.
      invalidate();
      return hit;
    },

    pickAvailable() {
      return { available: pickPass.available, reason: pickPass.unavailableReason };
    },

    setSurfaceMesh(mesh) {
      surfacePass.setMesh(mesh);
      pickPass.setMesh(mesh);
      invalidate();
    },

    setCurvatureMix(amount) {
      surfacePass.setCurvatureMix(amount);
      invalidate();
    },

    setLines(groups) {
      linesPass.setGroups(groups);
      invalidate();
    },

    setChartLines(groups) {
      chartLinesPass.setGroups(groups);
      invalidate();
    },

    setChartBounds(bounds) {
      chartBounds = bounds;
      invalidate();
    },

    setSurfaceVisible(visible) {
      surfacePass.setVisible(visible);
      invalidate();
    },

    invalidate,

    lineStats: () => ({ main: linesPass.stats(), chart: chartLinesPass.stats() }),

    start() {
      if (running) return;
      running = true;
      detachCamera = camera.attach(device.canvas, invalidate);
      window.addEventListener("resize", onWindowResize);
      frame = requestAnimationFrame(tick);
    },

    stop() {
      running = false;
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", onWindowResize);
      detachCamera?.();
      detachCamera = null;
    },

    dispose() {
      pickPass.dispose();
      this.stop();
      surfacePass.dispose();
      linesPass.dispose();
      chartLinesPass.dispose();
    },
  };
}
