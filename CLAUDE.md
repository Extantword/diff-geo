# DiffGeo — working notes

An interactive differential geometry engine for curves and surfaces in R³, following
**do Carmo, _Differential Geometry of Curves and Surfaces_**. The long-term goal is a digital
version of the book; the near-term goal is the engine every figure will be a view onto.

Plan: `/home/joan/.claude/plans/claude-today-we-are-shiny-honey.md`.

## Commands

```bash
npm run dev        # vite dev server on :5173
npm run build      # tsc -b && vite build  → dist/
npm test           # vitest, node environment (the math suite)
npm run test:watch
npm run oracle     # python + sympy cross-check of the TS CAS (offline, dev only)
```

## Architecture: the dependency direction is one-way

```
core  →  state  →  gl / ui
```

- **`src/core/` is pure TypeScript.** No DOM, no WebGL, no framework imports. It must stay
  unit-testable in a node environment, and it is the public API this project exists to provide.
  If you are about to import something browser-specific into `core`, the design is wrong.
- **`src/gl/`** is the only place WebGL2 appears. Four passes, one camera. It is a
  *purpose-built renderer, not an engine* — no scene graph, no material system, no asset loading.
  Resist growing it into one.
- **`src/ui/`** is vanilla DOM and never touches WebGL.
- **`src/state/`** holds the signal store and the expression dependency graph.

## Non-negotiables

**The non-finite contract.** Arbitrary user formulas produce NaN and ±Infinity constantly — `log`
of a negative, `1/tan(u)` at a chart pole. Nothing in `core` throws on bad numerics; evaluators
return non-finite values and every consumer branches explicitly. The mesh builder drops triangles
touching non-finite vertices; readouts show "—"; integrators bail out. A single NaN reaching a GPU
buffer becomes a triangle smeared across the whole scene, so culling at the mesh boundary is
load-bearing. See `src/core/geom/types.ts`.

**Domain insets are the default, not a special case.** Chart quantities routinely blow up exactly
at the coordinate boundary. `Interval.inset` pulls sampling in from both ends. ManifoldSandbox
shipped the sphere as `uRange: [0.001, 3.1405926535897932]` for exactly this reason — its
Christoffel symbols contain `1/tan(u)`.

**Sign conventions come from do Carmo, never from the web.** K is convention-independent, but II,
the shape operator and H all flip with the choice of unit normal. If a computed K or H disagrees in
*sign*, the convention is wrong at the source — fix it there, do not patch downstream. Verify
against the analytic ground-truth table.

**`src/core/geom/types.ts` is frozen at the end of M1.** Until then it grows freely; after that,
changes to it ripple through everything.

## Style

Matching the sibling project `../grupos`, deliberately with **no linter or formatter** — the style
is hand-enforced and consistent:

- double quotes, semicolons, trailing commas, 2-space indent, wrap at ~95–100 columns
- relative imports with explicit `.ts` extensions; **no path aliases**
- a JSDoc block on every exported math function, stating the actual formula in unicode
  (`γ̈ᵏ = −Γᵏᵢⱼ γ̇ⁱ γ̇ʲ`)
- `noUncheckedIndexedAccess` is **on**. In tight numeric loops over typed arrays, confine the `!`
  assertions to a single named accessor rather than sprinkling them through the loop.

## Testing

Analytic ground truth, not snapshots. A local `close()` helper per test file. Ground truth to hold
onto: sphere K = 1/R² and H = ∓1/R; cylinder K = 0; torus K = cos u / (r(R + r cos u)); catenoid and
helicoid minimal so H = 0; pseudosphere K = −1; helix κ and τ constant. **Never weaken these
tolerances to make a test pass** — a failure means the math is wrong.

The parametric and implicit code paths must both reproduce the sphere's **H**, not just its K. That
is the test most likely to catch a real sign bug.

JS↔GLSL agreement cannot run under Vitest's node environment; it is checked by a separate
`verify:glsl` dev page (M4).

## Milestones

M0 scaffold + lit torus ✅ · M1 CAS + jets + vertical slice · M2 signal store + expression list +
curves · M3 Gauss map, curvature lines, geodesics · M4 implicit surfaces · M5 book scaffolding.
One commit per milestone.
