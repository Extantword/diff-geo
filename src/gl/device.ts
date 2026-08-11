/**
 * Owns the canvas, the WebGL2 context, and the drawing-buffer size.
 *
 * The only place that calls `getContext`. Everything else takes a `Device`.
 */

export interface Device {
  canvas: HTMLCanvasElement;
  gl: WebGL2RenderingContext;
  /** drawing-buffer width in device pixels */
  width: number;
  /** drawing-buffer height in device pixels */
  height: number;
  /** CSS-pixel size, for pointer math */
  cssWidth: number;
  cssHeight: number;
  dpr: number;
  /** Resize the drawing buffer to match layout. Returns true if it changed. */
  resize(): boolean;
}

/** Cap DPR: a 3× retina display at full resolution costs 9× the fill rate for
 *  visual gain that stops being perceptible past 2×. */
const MAX_DPR = 2;

export function createDevice(canvas: HTMLCanvasElement): Device {
  const gl = canvas.getContext("webgl2", {
    antialias: true,
    depth: true,
    stencil: false,
    alpha: false,
    // Needed for readPixels-based picking to be reliable, and for eventual
    // high-resolution offscreen capture.
    preserveDrawingBuffer: false,
    powerPreference: "high-performance",
  });

  if (!gl) {
    throw new Error(
      "WebGL2 is not available in this browser. DiffGeo requires WebGL2 " +
        "(supported by all current versions of Firefox, Chrome and Safari).",
    );
  }

  const device: Device = {
    canvas,
    gl,
    width: 0,
    height: 0,
    cssWidth: 0,
    cssHeight: 0,
    dpr: 1,
    resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      const rect = canvas.getBoundingClientRect();
      const cssWidth = Math.max(1, rect.width);
      const cssHeight = Math.max(1, rect.height);
      const width = Math.max(1, Math.round(cssWidth * dpr));
      const height = Math.max(1, Math.round(cssHeight * dpr));

      device.cssWidth = cssWidth;
      device.cssHeight = cssHeight;
      device.dpr = dpr;

      if (width === device.width && height === device.height) return false;

      canvas.width = width;
      canvas.height = height;
      device.width = width;
      device.height = height;
      return true;
    },
  };

  device.resize();
  return device;
}
