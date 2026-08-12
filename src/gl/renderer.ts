import type { TessellatedSurface } from "../core/mesh/tessellate.ts";
import { createCamera, type Camera } from "./camera.ts";
import type { Device } from "./device.ts";
import { createLinesPass, type LineGroup, type LinesPass } from "./passes/lines.ts";
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
  start(): void;
  stop(): void;
  dispose(): void;
}

const BACKGROUND: [number, number, number] = [0.043, 0.059, 0.078]; // #0b0f14
/** Slightly lifted, so the inset reads as a separate surface rather than a hole. */
const INSET_BACKGROUND: [number, number, number] = [0.067, 0.094, 0.125];

export function createRenderer(device: Device): Renderer {
  const { gl } = device;
  const camera = createCamera();
  const surfacePass: SurfacePass = createSurfacePass(gl);
  const linesPass: LinesPass = createLinesPass(gl);
  const chartLinesPass: LinesPass = createLinesPass(gl);

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

    chartLinesPass.draw(projection, size, size);

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

    setSurfaceMesh(mesh) {
      surfacePass.setMesh(mesh);
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
      this.stop();
      surfacePass.dispose();
      linesPass.dispose();
      chartLinesPass.dispose();
    },
  };
}
