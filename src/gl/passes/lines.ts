import { createProgram, type Program } from "../program.ts";
import { linesFragment, linesVertex } from "../shaders/lines.ts";
import type { Mat4 } from "../mat4.ts";

/**
 * Pass 2 of 4: thick antialiased polylines.
 *
 * One draw call per style group, with every segment of every polyline in that group
 * packed into a single interleaved instance buffer. Grouping by style rather than by
 * polyline keeps the call count at one or two even with hundreds of geodesics on screen.
 *
 * Polylines **break at invalid samples** rather than interpolating through them. That is
 * the line-rendering end of the non-finite contract: a curve that leaves its domain or
 * hits a cusp comes back as two visible strokes with a gap, not one stroke lunging
 * through infinity.
 */

export interface Polyline {
  /** 3 doubles per point */
  readonly points: Float64Array | Float32Array;
  readonly count: number;
  /** 1 where the sample is usable; segments touching a 0 are skipped */
  readonly valid?: Uint8Array;
  /** cumulative arc length per point, for dash phase; defaults to index */
  readonly arcLength?: Float64Array;
  readonly color: readonly [number, number, number];
  /** per-point colours, 3 per point, overriding `color` */
  readonly colors?: Float64Array | Float32Array;
}

export interface LineStyle {
  readonly widthPx?: number;
  readonly featherPx?: number;
  readonly opacity?: number;
  /** dash period in arc-length units; 0 or absent means solid */
  readonly dashPeriod?: number;
  /** fraction of each period that is drawn */
  readonly dashDuty?: number;
  /**
   * Constant offset toward the viewer, in NDC depth. Small — it only needs to win exact
   * ties; keeping a drawn curve off the surface it lies on is the mesh's job, via a lift
   * along the normal that scales with the grid's sagitta.
   */
  readonly depthBias?: number;
  /** false to make `widthPx` mean world units instead, so the line shrinks with distance */
  readonly widthInPixels?: boolean;
}

export interface LineGroup {
  readonly polylines: readonly Polyline[];
  readonly style?: LineStyle;
}

export interface LinesPass {
  setGroups(groups: readonly LineGroup[]): void;
  draw(
    viewProjection: Mat4,
    viewportWidth: number,
    viewportHeight: number,
    /** viewport origin, needed because gl_FragCoord is framebuffer-absolute */
    originX?: number,
    originY?: number,
  ): void;
  dispose(): void;
}

/** floats per instance: start(3) end(3) colorA(3) colorB(3) arc(2) */
const STRIDE = 14;

export function createLinesPass(gl: WebGL2RenderingContext): LinesPass {
  const program: Program = createProgram(gl, linesVertex, linesFragment, "lines");

  const vao = gl.createVertexArray();
  const quadBuffer = gl.createBuffer();
  const quadIndexBuffer = gl.createBuffer();
  const instanceBuffer = gl.createBuffer();
  if (!vao || !quadBuffer || !quadIndexBuffer || !instanceBuffer) {
    throw new Error("lines pass: could not allocate GPU buffers");
  }

  // x ∈ {0,1} selects the endpoint, y ∈ {−1,1} the side.
  const quad = new Float32Array([0, -1, 1, -1, 1, 1, 0, 1]);
  const quadIndices = new Uint16Array([0, 1, 2, 0, 2, 3]);

  gl.bindVertexArray(vao);

  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
  const aQuad = program.attribute("aQuad");
  if (aQuad >= 0) {
    gl.enableVertexAttribArray(aQuad);
    gl.vertexAttribPointer(aQuad, 2, gl.FLOAT, false, 0, 0);
  }

  const INSTANCE_FIELDS: ReadonlyArray<{ name: string; size: number; offset: number }> = [
    { name: "aStart", size: 3, offset: 0 },
    { name: "aEnd", size: 3, offset: 3 },
    { name: "aColorA", size: 3, offset: 6 },
    { name: "aColorB", size: 3, offset: 9 },
    { name: "aArc", size: 2, offset: 12 },
  ];

  /**
   * Point the per-instance attributes at instance `baseInstance` onward.
   *
   * WebGL2's `drawElementsInstanced` has no base-instance parameter — that only arrives
   * with `WEBGL_draw_instanced_base_vertex_base_instance`. Encoding the offset in the
   * attribute pointer is the portable way to draw one style group out of a shared buffer,
   * and it costs a handful of state calls per group rather than a call per polyline.
   */
  const bindInstances = (baseInstance: number) => {
    gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
    const strideBytes = STRIDE * 4;
    for (const field of INSTANCE_FIELDS) {
      const location = program.attribute(field.name);
      if (location < 0) continue;
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(
        location,
        field.size,
        gl.FLOAT,
        false,
        strideBytes,
        (baseInstance * STRIDE + field.offset) * 4,
      );
      gl.vertexAttribDivisor(location, 1);
    }
  };

  bindInstances(0);

  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, quadIndexBuffer);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, quadIndices, gl.STATIC_DRAW);
  gl.bindVertexArray(null);

  interface Batch {
    readonly offset: number;
    readonly count: number;
    readonly style: LineStyle;
  }

  let batches: Batch[] = [];
  let capacity = 0;

  return {
    setGroups(groups) {
      // Count segments first so the buffer is sized in one go.
      let total = 0;
      for (const group of groups) {
        for (const line of group.polylines) {
          for (let i = 0; i + 1 < line.count; i++) {
            if (line.valid && (!line.valid[i] || !line.valid[i + 1])) continue;
            total++;
          }
        }
      }

      const data = new Float32Array(total * STRIDE);
      const nextBatches: Batch[] = [];
      let instance = 0;

      for (const group of groups) {
        const start = instance;
        for (const line of group.polylines) {
          const { points, colors, arcLength, valid, color } = line;
          for (let i = 0; i + 1 < line.count; i++) {
            // A segment is emitted only if both of its endpoints are usable, which is how
            // the polyline breaks rather than lunging through a singularity.
            if (valid && (!valid[i] || !valid[i + 1])) continue;

            const base = instance * STRIDE;
            data[base] = points[i * 3]!;
            data[base + 1] = points[i * 3 + 1]!;
            data[base + 2] = points[i * 3 + 2]!;
            data[base + 3] = points[(i + 1) * 3]!;
            data[base + 4] = points[(i + 1) * 3 + 1]!;
            data[base + 5] = points[(i + 1) * 3 + 2]!;

            if (colors) {
              data[base + 6] = colors[i * 3]!;
              data[base + 7] = colors[i * 3 + 1]!;
              data[base + 8] = colors[i * 3 + 2]!;
              data[base + 9] = colors[(i + 1) * 3]!;
              data[base + 10] = colors[(i + 1) * 3 + 1]!;
              data[base + 11] = colors[(i + 1) * 3 + 2]!;
            } else {
              data[base + 6] = color[0];
              data[base + 7] = color[1];
              data[base + 8] = color[2];
              data[base + 9] = color[0];
              data[base + 10] = color[1];
              data[base + 11] = color[2];
            }

            data[base + 12] = arcLength ? arcLength[i]! : i;
            data[base + 13] = arcLength ? arcLength[i + 1]! : i + 1;
            instance++;
          }
        }
        if (instance > start) {
          nextBatches.push({
            offset: start,
            count: instance - start,
            style: group.style ?? {},
          });
        }
      }

      gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
      if (total > capacity) {
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
        capacity = total;
      } else {
        // Reuse the allocation while it is big enough; only the changed prefix is sent.
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
      }
      batches = nextBatches;
    },

    draw(viewProjection, viewportWidth, viewportHeight, originX = 0, originY = 0) {
      if (batches.length === 0) return;

      program.use();
      gl.uniformMatrix4fv(program.uniform("uViewProj"), false, viewProjection);
      gl.uniform2f(program.uniform("uViewport"), viewportWidth, viewportHeight);
      gl.uniform2f(program.uniform("uViewportOrigin"), originX, originY);

      gl.enable(gl.DEPTH_TEST);
      /**
       * Depth **test** on, depth **write** off.
       *
       * This is load-bearing, not a tweak. Consecutive segments deliberately overlap by
       * half a width — that is what fills the join — and each extrapolates its own
       * segment's depth across that overlap. With writes enabled the second segment loses
       * the depth comparison over part of the shared region and its fragments are
       * dropped, leaving a small gap at *every* join. On a densely sampled curve that
       * reads as a dashed line rather than as the artifact it is.
       *
       * Writes off means overlaps blend twice instead, which is invisible, while the test
       * still hides the parts of a line that pass behind the surface.
       */
      gl.depthMask(false);
      gl.disable(gl.CULL_FACE);
      gl.enable(gl.BLEND);
      // Premultiplied alpha, matching the fragment shader's output.
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

      gl.bindVertexArray(vao);
      for (const batch of batches) {
        const style = batch.style;
        gl.uniform1f(program.uniform("uWidthPx"), style.widthPx ?? 2.5);
        gl.uniform1f(program.uniform("uFeatherPx"), style.featherPx ?? 1.2);
        gl.uniform1f(program.uniform("uOpacity"), style.opacity ?? 1);
        gl.uniform1f(program.uniform("uDashPeriod"), style.dashPeriod ?? 0);
        gl.uniform1f(program.uniform("uDashDuty"), style.dashDuty ?? 0.6);
        gl.uniform1f(program.uniform("uDepthBias"), style.depthBias ?? 1e-4);
        gl.uniform1f(
          program.uniform("uWidthIsPixels"),
          style.widthInPixels === false ? 0 : 1,
        );
        bindInstances(batch.offset);
        gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, batch.count);
      }
      gl.bindVertexArray(null);
      gl.disable(gl.BLEND);
      // Restore for whatever draws next.
      gl.depthMask(true);
    },

    dispose() {
      gl.deleteVertexArray(vao);
      gl.deleteBuffer(quadBuffer);
      gl.deleteBuffer(quadIndexBuffer);
      gl.deleteBuffer(instanceBuffer);
    },
  };
}
