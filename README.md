# DiffGeo

An interactive engine for **curves and surfaces in R³** — type a formula, see the geometry.
Concepts and conventions follow Manfredo do Carmo, _Differential Geometry of Curves and Surfaces_.

**→ [extantword.github.io/diff-geo](https://extantword.github.io/diff-geo/)**

> Status: **M3** — a Desmos-like expression list drives surfaces, curves and chart curves at once.
> Type a parametrization, see Gaussian curvature painted on it with its exact fundamental forms in
> LaTeX, shoot geodesics and lines of curvature by clicking the surface, and put the Gauss map
> beside it. Next: implicit surfaces. See [the milestones](#milestones).

## Documentation

**→ [extantword.github.io/diff-geo/docs/](https://extantword.github.io/diff-geo/docs/)** — the
reference: the formula language, what each kind of row draws, the interface, what the engine
computes, and the catalog.

The same document is served as plain text at
[`/llms-full.txt`](https://extantword.github.io/diff-geo/llms-full.txt), indexed by
[`/llms.txt`](https://extantword.github.io/diff-geo/llms.txt), for pointing an agent at. Its source
is [`docs/index.md`](docs/index.md); the tables in it are generated from the code and every example
on it is run through the real document layer by the test suite, so the page cannot quietly go out
of date.

`CLAUDE.md` is the other half: the architecture and the invariants, for changing the code rather
than using it.

## Develop

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # typecheck + production build to dist/
npm test           # analytic ground-truth geometry tests (Vitest), and the docs suite
npm run oracle     # cross-check the TS CAS against sympy (needs python + sympy)
```

## How it's built

- **TypeScript + Vite**, no UI framework — vanilla DOM with a small signal store.
- **Raw WebGL2, hand-written.** No three.js. A purpose-built renderer — not an engine: no scene
  graph, no material system. Three passes so far (surface, instanced thick lines, id-buffer
  picking) plus one orbit camera, so geodesics and curvature lines are thick, antialiased and
  depth-correct. The implicit raymarch pass arrives with M4.
- **A TypeScript CAS.** User formulas are parsed, differentiated symbolically, simplified, then
  compiled to both JS closures and GLSL. This is what lets the fundamental forms be displayed
  *exactly*, in LaTeX, for a surface you just invented.
- **The CAS is checked two independent ways.** `core/num/taylor.ts` implements truncated
  power-series arithmetic, deriving every elementary function's coefficients from its defining
  ODE — so it shares no code with the symbolic derivative table and disagrees with it if either is
  wrong. And **sympy is a test oracle, not a dependency**: it cross-checks the TS CAS offline
  (`npm run oracle`) and never ships to the browser.
- `src/core/` is pure TypeScript with no DOM or WebGL imports: the engine is usable as a library
  independently of this app.

## What is verified, and how

The tests are **analytic ground truth, not snapshots** — a failure means the mathematics is wrong.
The strongest checks are the ones that tie two independently computed quantities together:

- the **Gauss map's area distortion is |K|**, so the image mesh's area must equal ∫|K| dA over the
  source — one comparison that checks every normal against every curvature, and holds even where
  the map is not injective;
- **Clairaut's relation** is conserved along geodesics on surfaces of revolution, though the
  integrator knows nothing about it;
- geodesics keep **unit metric speed**, and on a sphere come out as coplanar great circles;
- **Taylor-series arithmetic against symbolic differentiation**, to third order, over twelve
  expressions and five directions — with no shared code between the two sides.

Ground truth held onto: sphere K = 1/R² and H = ∓1/R, cylinder K = 0, torus
K = cos u / (r(R + r cos u)), catenoid and helicoid minimal so H = 0, pseudosphere K = −1, helix κ
and τ constant.

## Milestones

| | | |
|---|---|---|
| **M0** | scaffold + WebGL2 renderer skeleton | ✅ |
| **M1** | CAS + jets + vertical slice: type a formula, see curvature painted on it | ✅ |
| **M2** | expression list, signal store, curves with the Frenet trihedron | ✅ |
| **M3** | Gauss map, lines of curvature, geodesics, id-buffer picking | ✅ |
| **M4** | implicit surfaces `F(x,y,z) = 0`, raymarched | |
| **M5** | book scaffolding: shareable figures embedded in chapters | |
