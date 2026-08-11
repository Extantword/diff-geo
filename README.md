# DiffGeo

An interactive engine for **curves and surfaces in R³** — type a formula, see the geometry.
Concepts and conventions follow Manfredo do Carmo, _Differential Geometry of Curves and Surfaces_.

> Status: **M0** — hand-written WebGL2 renderer with an orbitable tessellated surface.
> The symbolic engine (parse → differentiate → curvature) lands in M1. See [the plan](#milestones).

## Develop

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # typecheck + production build to dist/
npm test           # analytic ground-truth geometry tests (Vitest)
```

## How it's built

- **TypeScript + Vite**, no UI framework — vanilla DOM with a small signal store.
- **Raw WebGL2, hand-written.** No three.js. A purpose-built renderer of four passes
  (surface, thick lines, implicit raymarch, id-buffer picking) plus one orbit camera, so that
  geodesics and curvature lines are thick, antialiased and depth-correct.
- **A TypeScript CAS.** User formulas are parsed, differentiated symbolically, simplified, then
  compiled to both JS closures and GLSL. This is what lets the fundamental forms be displayed
  *exactly*, in LaTeX, for a surface you just invented.
- **sympy is a test oracle, not a dependency** — it cross-checks the TS CAS offline and never
  ships to the browser.
- `src/core/` is pure TypeScript with no DOM or WebGL imports: the engine is usable as a library
  independently of this app.

## Milestones

| | | |
|---|---|---|
| **M0** | scaffold + WebGL2 renderer skeleton | ✅ |
| **M1** | CAS + jets + vertical slice: type a formula, see curvature painted on it | |
| **M2** | expression list, signal store, curves with the Frenet trihedron | |
| **M3** | Gauss map, principal directions, lines of curvature, geodesics | |
| **M4** | implicit surfaces `F(x,y,z) = 0`, raymarched | |
| **M5** | book scaffolding: shareable figures embedded in chapters | |
