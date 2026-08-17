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
  /**
   * Where a point on screen lands in the chart inset, or null if it is not over it.
   *
   * The inverse of the inset's own projection, and it reads the same layout the drawing does, so
   * the two cannot disagree about where the corner square is.
   */
  chartAt(cssX: number, cssY: number): [number, number] | null;
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
  /**
   * Turn a point on screen into a point in space, on the plane through `through` facing the
   * camera.
   *
   * That plane is what a viewer reads as "where I am pointing": it passes through the scene and
   * is perpendicular to the line of sight, so the answer is at the depth of what is being looked
   * at rather than at some arbitrary distance along the ray.
   */
  unproject(cssX: number, cssY: number, through: [number, number, number]): [number, number, number] | null;
  /**
   * Where a point in space lands on screen, in CSS pixels, or null if it is behind the camera.
   *
   * The inverse of `unproject`, and it exists for handles that are drawn as geometry but must be
   * *hit* as UI — a port ring is a polyline, and the lines pass has no id buffer to pick from, so
   * proximity on screen is what decides. `distance` orders candidates by depth so the nearest one
   * wins when several overlap.
   */
  project(
    point: readonly [number, number, number],
  ): { x: number; y: number; distance: number } | null;
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
  /**
   * Where the inset sits, and what rectangle of (u, v) it shows.
   *
   * One function, used to draw it and to hit-test it — a second copy of this arithmetic living in
   * the pointer handler is a second copy that can drift by a margin and leave the highlight a few
   * pixels off the square under the cursor.
   */
  const insetLayout = () => {
    if (!chartBounds) return null;
    const margin = Math.round(Math.min(device.width, device.height) * 0.02);
    const size = Math.round(Math.min(device.width, device.height) * 0.3);
    if (size < 32) return null; // too small to read; better to omit than to draw noise

    const [u0, u1] = chartBounds.u;
    const [v0, v1] = chartBounds.v;
    // A little padding so the domain border is not flush against the edge.
    const padU = (u1 - u0) * 0.08 || 0.1;
    const padV = (v1 - v0) * 0.08 || 0.1;

    return {
      /** in device pixels, measured from the bottom left as GL does */
      x: device.width - size - margin,
      y: margin,
      size,
      view: {
        u: [u0 - padU, u1 + padU] as [number, number],
        v: [v0 - padV, v1 + padV] as [number, number],
      },
    };
  };

  const drawChartInset = () => {
    const layout = insetLayout();
    if (!layout) return;
    const { x, y, size } = layout;

    /**
     * Bottom RIGHT, opposite the expression panel on the left.
     *
     * `x` is passed on to the lines pass as its viewport origin, which is load-bearing:
     * `gl_FragCoord` is framebuffer-absolute, so a pass comparing against screen-space positions
     * has to be told where its viewport starts. Anything that omits it works perfectly while the
     * inset sits at the origin and fails totally the moment it moves — which is exactly what this
     * change would have triggered.
     */
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(x, y, size, size);
    gl.viewport(x, y, size, size);
    gl.clearColor(INSET_BACKGROUND[0], INSET_BACKGROUND[1], INSET_BACKGROUND[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const projection = orthographic(
      layout.view.u[0],
      layout.view.u[1],
      layout.view.v[0],
      layout.view.v[1],
    );

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

    chartAt(cssX, cssY) {
      const layout = insetLayout();
      if (!layout) return null;
      // The same two conversions `pick` makes: CSS pixels to device pixels, and the y axis flips
      // because pointer events measure down from the top while GL measures up from the bottom.
      const px = cssX * device.dpr;
      const py = device.height - cssY * device.dpr;
      const inX = (px - layout.x) / layout.size;
      const inY = (py - layout.y) / layout.size;
      if (inX < 0 || inX > 1 || inY < 0 || inY > 1) return null;
      return [
        layout.view.u[0] + (layout.view.u[1] - layout.view.u[0]) * inX,
        layout.view.v[0] + (layout.view.v[1] - layout.view.v[0]) * inY,
      ] as [number, number];
    },

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

    unproject(cssX, cssY, through) {
      const width = Math.max(1, device.canvas.clientWidth);
      const height = Math.max(1, device.canvas.clientHeight);
      const { forward, right, up, fov } = camera.basis();
      const eye = camera.eye();

      // Normalised device coordinates, with y flipped: pointer events measure down from the top.
      const ndcX = (cssX / width) * 2 - 1;
      const ndcY = 1 - (cssY / height) * 2;
      const tanHalf = Math.tan(fov / 2);
      const aspect = width / height;

      const dir: [number, number, number] = [
        forward[0] + right[0] * ndcX * tanHalf * aspect + up[0] * ndcY * tanHalf,
        forward[1] + right[1] * ndcX * tanHalf * aspect + up[1] * ndcY * tanHalf,
        forward[2] + right[2] * ndcX * tanHalf * aspect + up[2] * ndcY * tanHalf,
      ];

      // Distance along the ray at which it crosses the plane. The denominator is the ray's
      // component along the view direction, which is positive for anything in front of the
      // camera and vanishes only for a ray parallel to the plane.
      const denominator =
        dir[0] * forward[0] + dir[1] * forward[1] + dir[2] * forward[2];
      if (Math.abs(denominator) < 1e-9) return null;
      const offset: [number, number, number] = [
        through[0] - eye[0],
        through[1] - eye[1],
        through[2] - eye[2],
      ];
      const depth =
        offset[0] * forward[0] + offset[1] * forward[1] + offset[2] * forward[2];
      const t = depth / denominator;
      return [eye[0] + dir[0] * t, eye[1] + dir[1] * t, eye[2] + dir[2] * t];
    },

    project(point) {
      const width = Math.max(1, device.canvas.clientWidth);
      const height = Math.max(1, device.canvas.clientHeight);
      const { forward, right, up, fov } = camera.basis();
      const eye = camera.eye();

      const offset: [number, number, number] = [
        point[0] - eye[0],
        point[1] - eye[1],
        point[2] - eye[2],
      ];
      const depth = offset[0] * forward[0] + offset[1] * forward[1] + offset[2] * forward[2];
      // Behind the camera, or exactly in its plane: there is no screen position to report.
      if (!(depth > 1e-6)) return null;

      const tanHalf = Math.tan(fov / 2);
      const aspect = width / height;
      const x = offset[0] * right[0] + offset[1] * right[1] + offset[2] * right[2];
      const y = offset[0] * up[0] + offset[1] * up[1] + offset[2] * up[2];
      const ndcX = x / (depth * tanHalf * aspect);
      const ndcY = y / (depth * tanHalf);
      return {
        x: ((ndcX + 1) / 2) * width,
        y: ((1 - ndcY) / 2) * height,
        distance: depth,
      };
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
