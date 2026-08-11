/**
 * Shader compilation and uniform/attribute lookup.
 *
 * The error reporting here is deliberately generous. We hand-write GLSL now, and
 * from M4 the CAS *generates* GLSL from user formulas — at which point a compile
 * error is a bug in the emitter and "ERROR: 0:47: syntax error" with no source is
 * useless. So failures always print the offending line in context.
 */

export interface Program {
  program: WebGLProgram;
  uniform(name: string): WebGLUniformLocation | null;
  attribute(name: string): number;
  use(): void;
}

function annotate(source: string, log: string): string {
  const lines = source.split("\n");
  const width = String(lines.length).length;
  const badLines = new Set<number>();
  // Driver logs look like "ERROR: 0:47: '...' : message" — pull out the 47.
  for (const match of log.matchAll(/\b\d+:(\d+)\b/g)) {
    const n = Number(match[1]);
    if (Number.isFinite(n)) badLines.add(n);
  }
  const numbered = lines.map((line, i) => {
    const n = i + 1;
    const mark = badLines.has(n) ? ">>" : "  ";
    return `${mark} ${String(n).padStart(width)} | ${line}`;
  });
  return numbered.join("\n");
}

function compile(gl: WebGL2RenderingContext, type: number, source: string, label: string) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error(`could not create ${label} shader`);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? "(no log)";
    gl.deleteShader(shader);
    throw new Error(`${label} shader failed to compile:\n${log}\n\n${annotate(source, log)}`);
  }
  return shader;
}

export function createProgram(
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string,
  label = "program",
): Program {
  const vs = compile(gl, gl.VERTEX_SHADER, vertexSource, `${label} vertex`);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fragmentSource, `${label} fragment`);

  const program = gl.createProgram();
  if (!program) throw new Error(`could not create ${label}`);
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);

  // Safe to delete once linked — the program holds its own reference.
  gl.deleteShader(vs);
  gl.deleteShader(fs);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? "(no log)";
    gl.deleteProgram(program);
    throw new Error(`${label} failed to link:\n${log}`);
  }

  const uniforms = new Map<string, WebGLUniformLocation | null>();
  const attributes = new Map<string, number>();

  return {
    program,
    uniform(name) {
      let loc = uniforms.get(name);
      if (loc === undefined) {
        loc = gl.getUniformLocation(program, name);
        uniforms.set(name, loc);
        if (loc === null) {
          // Not fatal — a uniform the optimiser removed as unused reads as absent.
          console.warn(`[${label}] uniform "${name}" not found (unused or misspelled?)`);
        }
      }
      return loc;
    },
    attribute(name) {
      let loc = attributes.get(name);
      if (loc === undefined) {
        loc = gl.getAttribLocation(program, name);
        attributes.set(name, loc);
        if (loc < 0) console.warn(`[${label}] attribute "${name}" not found`);
      }
      return loc;
    },
    use() {
      gl.useProgram(program);
    },
  };
}
