/// <reference types="vitest/config" />
import { defineConfig } from "vite";

// Relative base so the static build works under any GitHub Pages project path.
export default defineConfig({
  base: "./",
  test: {
    globals: true,
    // `src/core` is pure TypeScript by contract — no DOM, no WebGL — so the whole
    // math suite runs in node. GL/JS agreement is checked separately by the
    // `verify:glsl` dev page, which needs a real context.
    environment: "node",
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
  },
});
