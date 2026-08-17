import { describe, expect, it } from "vitest";
import { linesFragment, linesVertex } from "../../src/gl/shaders/lines.ts";
import { surfaceFragment, surfaceVertex } from "../../src/gl/shaders/surface.ts";

/**
 * What can be checked about a shader without a GL context.
 *
 * There is none in node, so nothing here compiles GLSL — a shader that fails to compile fails at
 * runtime, in the browser, with the surface simply missing. That makes the cheap checks worth
 * having, and this file exists because one of them would have caught a real bug: `vec3 half = …`,
 * where `half` is a **reserved word** in GLSL ES and the whole surface pass stops compiling.
 *
 * Two more traps, both of which have cost time in this project before:
 *  - a backtick inside a GLSL comment terminates the TypeScript template literal;
 *  - `gl_FragCoord` is framebuffer-absolute, so any pass comparing against screen-space positions
 *    needs the viewport origin — the inset draws at a non-zero one.
 */

const SHADERS: ReadonlyArray<readonly [string, string]> = [
  ["surface vertex", surfaceVertex],
  ["surface fragment", surfaceFragment],
  ["lines vertex", linesVertex],
  ["lines fragment", linesFragment],
];

/** GLSL ES 3.00 keywords reserved for future use — legal to write, illegal to compile. */
const RESERVED = [
  "half", "fixed", "double", "hvec2", "hvec3", "hvec4", "fvec2", "fvec3", "fvec4",
  "dvec2", "dvec3", "dvec4", "input", "output", "long", "short", "unsigned", "sizeof",
  "cast", "namespace", "using", "goto", "inline", "noinline", "public", "static",
  "extern", "external", "interface", "typedef", "template", "this", "packed", "asm",
  "class", "union", "enum", "volatile", "filter", "resource", "sampler3DRect",
];

const TYPES = "(?:float|int|uint|bool|vec2|vec3|vec4|ivec2|ivec3|ivec4|mat2|mat3|mat4)";

describe("the shaders say what they mean to say", () => {
  for (const [name, source] of SHADERS) {
    it(`${name} declares no reserved word`, () => {
      const declarations = [...source.matchAll(new RegExp(`\\b${TYPES}\\s+([A-Za-z_]\\w*)`, "g"))];
      expect(declarations.length).toBeGreaterThan(0);
      const bad = declarations
        .map((match) => match[1]!)
        .filter((identifier) => RESERVED.includes(identifier));
      expect(bad, `${name} uses a GLSL ES reserved word as a name`).toEqual([]);
    });

    it(`${name} declares its version first`, () => {
      // `#version` must be the first line of the source or the compile fails, and a stray blank
      // line from a template literal is the easiest way to break it.
      expect(source.trimStart().startsWith("#version 300 es")).toBe(true);
    });

    it(`${name} keeps its braces balanced`, () => {
      // Not a parser — just enough to catch a template literal that lost a chunk.
      const open = (source.match(/\{/g) ?? []).length;
      const close = (source.match(/\}/g) ?? []).length;
      expect(open).toBe(close);
    });
  }

  it("never writes a backtick inside GLSL", () => {
    /**
     * The trap that has cost time twice: shader source lives in a TypeScript template literal, so
     * a backtick in a comment — `gl_FragCoord`, written the way it would be in prose — terminates
     * the string. `tsc` catches it, pointing at the GLSL line rather than at the cause.
     */
    for (const [name, source] of SHADERS) {
      expect(source.includes("`"), `${name} contains a backtick`).toBe(false);
    }
  });

  it("gives the lines pass the viewport origin it needs", () => {
    /**
     * `gl_FragCoord` is framebuffer-absolute, not viewport-relative. The lines pass compares
     * against screen-space positions computed in its **vertex** shader, so it has to be told
     * where the viewport starts — which works perfectly while everything draws at (0,0) and fails
     * totally the moment something renders into the inset.
     */
    expect(linesVertex).toContain("uViewportOrigin");
  });
});
