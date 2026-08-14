import { lookAt, perspective, type Mat4, type V3 } from "./mat4.ts";

/**
 * Orbit camera with critically-ish damped motion.
 *
 * `aiming` exists to resolve a conflict that shows up the moment you can drag on
 * the surface itself: dragging to aim a geodesic and dragging to orbit are the same
 * gesture. While `aiming` is set, the camera ignores pointer input entirely.
 * ManifoldSandbox solved this with `<OrbitControls enabled={!aiming} />`; the same
 * flag, hand-rolled.
 */
export interface Camera {
  /** Advance damping. Returns true while still settling, so the renderer keeps drawing. */
  update(): boolean;
  view(): Mat4;
  projection(aspect: number): Mat4;
  eye(): V3;
  /**
   * The camera's own axes in world space, and its vertical field of view.
   *
   * Exposed so a screen point can be turned back into a world ray. Derived here rather than by
   * inverting the view-projection matrix: the basis is what the view matrix is BUILT from, so
   * reading it straight off is exact and needs no matrix inverse that could quietly disagree.
   */
  basis(): { forward: V3; right: V3; up: V3; fov: number };
  setAiming(aiming: boolean): void;
  isAiming(): boolean;
  /** Frame a bounding sphere. */
  frame(center: V3, radius: number): void;
  /** Attach pointer/wheel handlers. Returns a detach function. */
  attach(canvas: HTMLCanvasElement, onChange: () => void): () => void;
}

const DAMPING = 0.18;
const MIN_PHI = 0.02;
const MAX_PHI = Math.PI - 0.02;
const FOV = (50 * Math.PI) / 180;

export function createCamera(): Camera {
  // Desired (target) and current (rendered) orbit state. Damping interpolates the
  // second toward the first.
  let theta = 0.9;
  let phi = 1.05;
  let radius = 5.5;
  let tx = 0;
  let ty = 0;
  let tz = 0;

  let cTheta = theta;
  let cPhi = phi;
  let cRadius = radius;
  let ctx = tx;
  let cty = ty;
  let ctz = tz;

  let aiming = false;

  const eyeOf = (): V3 => {
    const sp = Math.sin(cPhi);
    return [
      ctx + cRadius * sp * Math.sin(cTheta),
      cty + cRadius * Math.cos(cPhi),
      ctz + cRadius * sp * Math.cos(cTheta),
    ];
  };

  return {
    update() {
      const dTheta = theta - cTheta;
      const dPhi = phi - cPhi;
      const dRadius = radius - cRadius;
      const dx = tx - ctx;
      const dy = ty - cty;
      const dz = tz - ctz;

      const settled =
        Math.abs(dTheta) < 1e-4 &&
        Math.abs(dPhi) < 1e-4 &&
        Math.abs(dRadius) < 1e-4 &&
        Math.abs(dx) < 1e-4 &&
        Math.abs(dy) < 1e-4 &&
        Math.abs(dz) < 1e-4;

      if (settled) {
        cTheta = theta;
        cPhi = phi;
        cRadius = radius;
        ctx = tx;
        cty = ty;
        ctz = tz;
        return false;
      }

      cTheta += dTheta * DAMPING;
      cPhi += dPhi * DAMPING;
      cRadius += dRadius * DAMPING;
      ctx += dx * DAMPING;
      cty += dy * DAMPING;
      ctz += dz * DAMPING;
      return true;
    },

    view() {
      return lookAt(eyeOf(), [ctx, cty, ctz], [0, 1, 0]);
    },

    projection(aspect) {
      // Near/far scale with distance so a zoomed-in view keeps depth precision.
      const near = Math.max(cRadius * 0.01, 0.001);
      const far = cRadius * 100 + 100;
      return perspective(FOV, aspect, near, far);
    },

    eye: eyeOf,

    basis() {
      const eye = eyeOf();
      // Built as plain mutable triples and frozen into V3 on return: V3 is readonly, which is
      // the right contract for a camera axis but not for one being normalised in place.
      const fx = ctx - eye[0];
      const fy = cty - eye[1];
      const fz = ctz - eye[2];
      const flen = Math.hypot(fx, fy, fz) || 1;
      const forward: V3 = [fx / flen, fy / flen, fz / flen];

      /**
       * right = forward × worldUp, then up = right × forward.
       *
       * Taken in that order so the pair stays orthonormal even when the camera looks steeply up
       * or down, where forward and worldUp are nearly parallel and the cross product collapses —
       * the fallback catches exactly that case.
       */
      const rlen = Math.hypot(forward[2], 0, -forward[0]);
      const right: V3 =
        rlen > 1e-9 ? [forward[2] / rlen, 0, -forward[0] / rlen] : [1, 0, 0];
      const up: V3 = [
        right[1] * forward[2] - right[2] * forward[1],
        right[2] * forward[0] - right[0] * forward[2],
        right[0] * forward[1] - right[1] * forward[0],
      ];
      return { forward, right, up, fov: FOV };
    },

    setAiming(a) {
      aiming = a;
    },

    isAiming() {
      return aiming;
    },

    frame(center, r) {
      tx = center[0];
      ty = center[1];
      tz = center[2];
      // Fit the sphere in the vertical FOV with a little margin.
      radius = Math.max(r / Math.sin(FOV / 2), 0.1) * 1.15;
    },

    attach(canvas, onChange) {
      let dragging: "orbit" | "pan" | null = null;
      let lastX = 0;
      let lastY = 0;
      let pointerId = -1;

      const onPointerDown = (e: PointerEvent) => {
        if (aiming || dragging) return;
        // Shift-drag, middle button, or right button pans; plain left drag orbits.
        dragging = e.shiftKey || e.button === 1 || e.button === 2 ? "pan" : "orbit";
        lastX = e.clientX;
        lastY = e.clientY;
        pointerId = e.pointerId;
        canvas.setPointerCapture(pointerId);
        e.preventDefault();
      };

      const onPointerMove = (e: PointerEvent) => {
        if (!dragging || e.pointerId !== pointerId) return;
        const dx = e.clientX - lastX;
        const dy = e.clientY - lastY;
        lastX = e.clientX;
        lastY = e.clientY;

        if (dragging === "orbit") {
          theta -= dx * 0.007;
          phi = Math.min(MAX_PHI, Math.max(MIN_PHI, phi - dy * 0.007));
        } else {
          // Pan in the camera's screen plane, scaled so the grab point tracks the
          // cursor at roughly 1:1 regardless of zoom.
          const scale = (radius * 2 * Math.tan(FOV / 2)) / Math.max(1, canvas.clientHeight);
          const sp = Math.sin(cPhi);
          const rightX = Math.cos(cTheta);
          const rightZ = -Math.sin(cTheta);
          const upX = -Math.cos(cPhi) * Math.sin(cTheta);
          const upY = sp;
          const upZ = -Math.cos(cPhi) * Math.cos(cTheta);
          tx -= (rightX * dx + upX * -dy) * scale;
          ty -= upY * -dy * scale;
          tz -= (rightZ * dx + upZ * -dy) * scale;
        }
        onChange();
        e.preventDefault();
      };

      const endDrag = (e: PointerEvent) => {
        if (e.pointerId !== pointerId) return;
        dragging = null;
        pointerId = -1;
      };

      const onWheel = (e: WheelEvent) => {
        if (aiming) return;
        // Exponential zoom so each notch feels the same at any distance.
        radius = Math.min(5000, Math.max(0.05, radius * Math.exp(e.deltaY * 0.001)));
        onChange();
        e.preventDefault();
      };

      const onContextMenu = (e: Event) => e.preventDefault();

      canvas.addEventListener("pointerdown", onPointerDown);
      canvas.addEventListener("pointermove", onPointerMove);
      canvas.addEventListener("pointerup", endDrag);
      canvas.addEventListener("pointercancel", endDrag);
      canvas.addEventListener("wheel", onWheel, { passive: false });
      canvas.addEventListener("contextmenu", onContextMenu);

      return () => {
        canvas.removeEventListener("pointerdown", onPointerDown);
        canvas.removeEventListener("pointermove", onPointerMove);
        canvas.removeEventListener("pointerup", endDrag);
        canvas.removeEventListener("pointercancel", endDrag);
        canvas.removeEventListener("wheel", onWheel);
        canvas.removeEventListener("contextmenu", onContextMenu);
      };
    },
  };
}
