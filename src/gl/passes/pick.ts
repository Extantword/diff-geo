import type { TessellatedSurface } from "../../core/mesh/tessellate.ts";
import { createProgram, type Program } from "../program.ts";
import type { Mat4 } from "../mat4.ts";

/**
 * Pass 4 of 4: picking, by rendering an id buffer.
 *
 * ## Why not raycasting
 *
 * The alternative is to intersect a ray with the mesh on the CPU. That means either a linear scan
 * over 50k triangles or a spatial index to maintain, and it answers a different question from the
 * one we have: the GPU already knows exactly which surface point is under a pixel, because it just
 * drew it.
 *
 * Rendering `(rowId, u, v)` into a float target and reading one pixel back recovers the chart
 * coordinates **exactly**. The sibling project baked *normalized* chart coordinates into the mesh's
 * `uv` attribute and un-normalized a raycast hit afterwards; carrying the real (u, v) removes that
 * conversion and works unchanged for a restricted or non-rectangular domain.
 *
 * Interpolation across a triangle is affine in (u, v), which is precisely the right reconstruction
 * for a barycentric hit — so the value read back is the chart coordinate of the point under the
 * cursor, not of the nearest vertex.
 *
 * ## Float targets are required, and the absence is reported rather than papered over
 *
 * `EXT_color_buffer_float` is needed to render to RGBA32F. It is near-universal in WebGL2, but
 * where it is missing this pass reports itself unavailable instead of falling back to a fixed-point
 * encoding that would never be exercised and so would rot untested.
 */

export interface PickResult {
  /** the document row that owns the surface under the cursor */
  readonly rowId: number;
  /** exact chart coordinates at that point */
  readonly u: number;
  readonly v: number;
}

export interface PickPass {
  readonly available: boolean;
  /** Why picking is unavailable, if it is. */
  readonly unavailableReason: string;
  setMesh(mesh: TessellatedSurface): void;
  /**
   * Read the surface under a pixel. `x` and `y` are in device pixels with the origin at the
   * bottom left, matching WebGL's own convention.
   */
  pick(
    x: number,
    y: number,
    viewProjection: Mat4,
    width: number,
    height: number,
  ): PickResult | null;
  dispose(): void;
}

const pickVertex = /* glsl */ `#version 300 es
precision highp float;

in vec3 aPosition;
in vec2 aChart;
in float aObjectId;

uniform mat4 uViewProj;

out vec2 vChart;
/* flat: an id must not be interpolated between vertices of different objects. */
flat out float vObjectId;

void main() {
  vChart = aChart;
  vObjectId = aObjectId;
  gl_Position = uViewProj * vec4(aPosition, 1.0);
}
`;

const pickFragment = /* glsl */ `#version 300 es
precision highp float;

in vec2 vChart;
flat in float vObjectId;

out vec4 fragColor;

void main() {
  /* Row id, then the chart coordinates the cursor is actually over. The alpha channel marks the
     pixel as covered, so a zero row id is still distinguishable from empty space. */
  fragColor = vec4(vObjectId, vChart.x, vChart.y, 1.0);
}
`;

/** Half-width of the readback square, in device pixels. */
const PICK_RADIUS = 3;

export function createPickPass(gl: WebGL2RenderingContext): PickPass {
  const floatTargets = gl.getExtension("EXT_color_buffer_float");
  if (!floatTargets) {
    return {
      available: false,
      unavailableReason: "EXT_color_buffer_float is not supported, so picking is unavailable",
      setMesh: () => {},
      pick: () => null,
      dispose: () => {},
    };
  }

  const program: Program = createProgram(gl, pickVertex, pickFragment, "pick");

  const vao = gl.createVertexArray();
  const positionBuffer = gl.createBuffer();
  const chartBuffer = gl.createBuffer();
  const idBuffer = gl.createBuffer();
  const indexBuffer = gl.createBuffer();
  const framebuffer = gl.createFramebuffer();
  const colorTexture = gl.createTexture();
  const depthTexture = gl.createTexture();

  if (
    !vao ||
    !positionBuffer ||
    !chartBuffer ||
    !idBuffer ||
    !indexBuffer ||
    !framebuffer ||
    !colorTexture ||
    !depthTexture
  ) {
    throw new Error("pick pass: could not allocate GPU resources");
  }

  gl.bindVertexArray(vao);
  const bind = (buffer: WebGLBuffer, name: string, size: number) => {
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    const location = program.attribute(name);
    if (location >= 0) {
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
    }
  };
  bind(positionBuffer, "aPosition", 3);
  bind(chartBuffer, "aChart", 2);
  bind(idBuffer, "aObjectId", 1);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
  gl.bindVertexArray(null);

  let indexCount = 0;
  let targetWidth = 0;
  let targetHeight = 0;
  const readback = new Float32Array((PICK_RADIUS * 2 + 1) * (PICK_RADIUS * 2 + 1) * 4);

  /** Size the offscreen target to the viewport, reallocating only when it changes. */
  const resizeTarget = (width: number, height: number) => {
    if (width === targetWidth && height === targetHeight) return;
    targetWidth = width;
    targetHeight = height;

    gl.bindTexture(gl.TEXTURE_2D, colorTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    gl.bindTexture(gl.TEXTURE_2D, depthTexture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.DEPTH_COMPONENT24,
      width,
      height,
      0,
      gl.DEPTH_COMPONENT,
      gl.UNSIGNED_INT,
      null,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, colorTexture, 0);
    // Depth is what makes the pick respect occlusion: the front-most surface wins.
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depthTexture, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
  };

  return {
    available: true,
    unavailableReason: "",

    setMesh(mesh) {
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, chartBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, mesh.chart, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, idBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, mesh.ids, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.DYNAMIC_DRAW);
      gl.bindVertexArray(null);
      indexCount = mesh.indices.length;
    },

    pick(x, y, viewProjection, width, height) {
      if (indexCount === 0) return null;
      resizeTarget(width, height);

      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        return null;
      }

      /**
       * Only the neighbourhood of the cursor is drawn.
       *
       * A scissor over a 7×7 square turns a full-viewport render into a handful of pixels, which
       * is what makes picking cheap enough to do on every pointer move during a drag.
       */
      const left = Math.max(0, Math.round(x) - PICK_RADIUS);
      const bottom = Math.max(0, Math.round(y) - PICK_RADIUS);
      const size = PICK_RADIUS * 2 + 1;

      gl.viewport(0, 0, width, height);
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(left, bottom, size, size);
      // Alpha zero means "nothing here", which is how an empty pixel is told from row id 0.
      gl.clearColor(0, 0, 0, 0);
      gl.clearDepth(1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

      gl.enable(gl.DEPTH_TEST);
      gl.depthMask(true);
      gl.depthFunc(gl.LEQUAL);
      gl.disable(gl.BLEND);
      gl.disable(gl.CULL_FACE);

      program.use();
      gl.uniformMatrix4fv(program.uniform("uViewProj"), false, viewProjection);
      gl.bindVertexArray(vao);
      gl.drawElements(gl.TRIANGLES, indexCount, gl.UNSIGNED_INT, 0);
      gl.bindVertexArray(null);

      const readWidth = Math.min(size, width - left);
      const readHeight = Math.min(size, height - bottom);
      if (readWidth <= 0 || readHeight <= 0) {
        gl.disable(gl.SCISSOR_TEST);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        return null;
      }

      gl.readPixels(left, bottom, readWidth, readHeight, gl.RGBA, gl.FLOAT, readback);
      gl.disable(gl.SCISSOR_TEST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);

      /**
       * Nearest covered pixel to the centre wins.
       *
       * Reading a single pixel makes a thin feature or a silhouette edge nearly unclickable; a
       * small search costs nothing and makes the interaction forgiving.
       */
      const centreX = Math.round(x) - left;
      const centreY = Math.round(y) - bottom;
      let best: PickResult | null = null;
      let bestDistance = Infinity;

      for (let row = 0; row < readHeight; row++) {
        for (let column = 0; column < readWidth; column++) {
          const index = (row * readWidth + column) * 4;
          if (readback[index + 3] === 0) continue;
          const dx = column - centreX;
          const dy = row - centreY;
          const distance = dx * dx + dy * dy;
          if (distance >= bestDistance) continue;
          bestDistance = distance;
          best = {
            rowId: Math.round(readback[index]!),
            u: readback[index + 1]!,
            v: readback[index + 2]!,
          };
        }
      }

      return best;
    },

    dispose() {
      gl.deleteVertexArray(vao);
      gl.deleteBuffer(positionBuffer);
      gl.deleteBuffer(chartBuffer);
      gl.deleteBuffer(idBuffer);
      gl.deleteBuffer(indexBuffer);
      gl.deleteFramebuffer(framebuffer);
      gl.deleteTexture(colorTexture);
      gl.deleteTexture(depthTexture);
    },
  };
}
