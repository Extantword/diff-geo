/// <reference types="vitest/config" />
import { defineConfig } from "vite";

import { docsPlugin } from "./docs/plugin.ts";

// Relative base so the static build works under any GitHub Pages project path.
export default defineConfig({
  base: "./",
  /**
   * The reference page is part of the bundle, not a step after it.
   *
   * `vite build` empties `dist`, and the deploy workflow uploads whatever is in `dist` without
   * looking — so documentation written by a separate post-build command is one forgotten command
   * away from a deploy that silently has none.
   */
  plugins: [docsPlugin()],
  test: {
    globals: true,
    // `src/core` is pure TypeScript by contract — no DOM, no WebGL — so the whole
    // math suite runs in node. GL/JS agreement is checked separately by the
    // `verify:glsl` dev page, which needs a real context.
    environment: "node",
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
  },
});
