import type { TessellatedSurface } from "../../core/mesh/tessellate.ts";
import { createProgram, type Program } from "../program.ts";
import { surfaceFragment, surfaceVertex } from "../shaders/surface.ts";
import type { Mat4, V3 } from "../mat4.ts";

/**
 * Pass 1 of 4: draw tessellated parametric surfaces.
 *
 * Owns one VAO whose buffers are reallocated when the mesh changes. Uploading is
 * explicit (`setMesh`) rather than implicit per frame — retessellating is the
 * expensive operation and must be driven by state changes, never by the render loop.
 */
export interface SurfacePass {
  setMesh(mesh: TessellatedSurface): void;
  draw(view: Mat4, projection: Mat4, eye: V3): void;
  /** 0 shows the flat base colour, 1 shows Gaussian curvature */
  setCurvatureMix(amount: number): void;
  setVisible(visible: boolean): void;
  dispose(): void;
}

export interface SurfacePassOpts {
  /** chart-grid line spacing in (u, v) units; 0 disables that axis */
  gridSpacing?: [number, number];
  gridOpacity?: number;
  curvatureMix?: number;
}

export function createSurfacePass(
  gl: WebGL2RenderingContext,
  opts: SurfacePassOpts = {},
): SurfacePass {
  const {
    gridSpacing = [Math.PI / 4, Math.PI / 4],
    gridOpacity = 1,
    curvatureMix = 1,
  } = opts;

  const program: Program = createProgram(gl, surfaceVertex, surfaceFragment, "surface");

  const vao = gl.createVertexArray();
  const positionBuffer = gl.createBuffer();
  const normalBuffer = gl.createBuffer();
  const chartBuffer = gl.createBuffer();
  const colorBuffer = gl.createBuffer();
  const baseColorBuffer = gl.createBuffer();
  const indexBuffer = gl.createBuffer();
  if (
    !vao ||
    !positionBuffer ||
    !normalBuffer ||
    !chartBuffer ||
    !colorBuffer ||
    !baseColorBuffer ||
    !indexBuffer
  ) {
    throw new Error("surface pass: could not allocate GPU buffers");
  }

  const aPosition = program.attribute("aPosition");
  const aNormal = program.attribute("aNormal");
  const aChart = program.attribute("aChart");
  const aColor = program.attribute("aColor");
  const aBaseColor = program.attribute("aBaseColor");

  gl.bindVertexArray(vao);
  const bindFloatAttrib = (buffer: WebGLBuffer, location: number, size: number) => {
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    if (location >= 0) {
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
    }
  };
  bindFloatAttrib(positionBuffer, aPosition, 3);
  bindFloatAttrib(normalBuffer, aNormal, 3);
  bindFloatAttrib(chartBuffer, aChart, 2);
  bindFloatAttrib(colorBuffer, aColor, 3);
  bindFloatAttrib(baseColorBuffer, aBaseColor, 3);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
  gl.bindVertexArray(null);

  let indexCount = 0;
  let mix = curvatureMix;
  let visible = true;

  return {
    setMesh(mesh) {
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, normalBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, mesh.normals, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, chartBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, mesh.chart, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, colorBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, mesh.colors, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, baseColorBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, mesh.baseColors, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.DYNAMIC_DRAW);
      gl.bindVertexArray(null);
      indexCount = mesh.indices.length;
    },

    setCurvatureMix(amount) {
      mix = amount;
    },

    setVisible(next) {
      visible = next;
    },

    draw(view, projection, eye) {
      if (indexCount === 0 || !visible) return;
      program.use();
      gl.uniformMatrix4fv(program.uniform("uView"), false, view);
      gl.uniformMatrix4fv(program.uniform("uProjection"), false, projection);
      gl.uniform3f(program.uniform("uEye"), eye[0], eye[1], eye[2]);
      gl.uniform2f(program.uniform("uGridSpacing"), gridSpacing[0], gridSpacing[1]);
      gl.uniform1f(program.uniform("uGridOpacity"), gridOpacity);
      gl.uniform1f(program.uniform("uCurvatureMix"), mix);

      // Open surfaces are visible from both sides, so no back-face culling.
      gl.disable(gl.CULL_FACE);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);

      gl.bindVertexArray(vao);
      gl.drawElements(gl.TRIANGLES, indexCount, gl.UNSIGNED_INT, 0);
      gl.bindVertexArray(null);
    },

    dispose() {
      gl.deleteVertexArray(vao);
      gl.deleteBuffer(positionBuffer);
      gl.deleteBuffer(normalBuffer);
      gl.deleteBuffer(chartBuffer);
      gl.deleteBuffer(colorBuffer);
      gl.deleteBuffer(indexBuffer);
    },
  };
}
