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

**A chart boundary is a wall or a seam, and the difference is measured, not declared.** A sphere's
v closes up at 2π, so a geodesic crossing there has gone *around*, not left the surface. The same
flag decides three things: where geodesics stop, whether the mesh welds normals across the seam,
and whether chart curves wrap. The catalog declares it per template — and that declaration is
**useless**, because loading a template inserts its *source text* into a row, so the flag never
reaches the compiled surface, and a hand-typed sphere never had one. `geom/periodic.ts` measures it
by comparing `X(u₀,v)` against `X(u₁,v)`, relative to the surface's own extent. Symptom when it is
wrong: a great-circle spray comes back with four arms instead of six, at uneven lengths.

**A pole is not an edge, and it is found by collapse rather than by degeneracy.** `detectPoles`
asks whether a boundary's *image* shrinks to nothing next to the surface's extent — not whether
X_u × X_v vanishes on it. The degeneracy test fails in practice because insets are usually already
folded into the bounds by the time geometry sees them (the sphere arrives as u ∈ [0.0063, 3.1353],
where it is perfectly regular), and probing outward cannot help: the degeneracy sits at exactly one
value of u and discrete samples step over it. Collapse survives the inset and is scale-free.
Geodesics may integrate one interval-width *past* a pole, because the parametrization continues
through it; a **regular** boundary is left alone, since a cylinder's rim really is where the surface
stops. Note the lift flips sign past a pole — chart orientation reverses — a 0.2% visual artifact.

**Overlay curve density is geometric, never a sample count.** `minSamples` divides the requested
arc length, so it pins a count and lets spacing grow without limit: a geodesic wrapping a sphere
nine times came back with the same 242 points as one crossing it once, drawn as a visible polygon.
`maxStepArc` bounds the spacing instead. Density is capped twice — `SEGMENTS_PER_EXTENT` for
smoothness, `MAX_SPRAY_SEGMENTS` so turning up both length and ray count cannot freeze the UI (12
rays × 40 units costs 89k points and 0.9 s uncapped). The numeric symptom of faceting is that the
summed chords fall short of the arc length; that is what the test asserts.

**Domain insets are the default, not a special case.** Chart quantities routinely blow up exactly
at the coordinate boundary. `Interval.inset` pulls sampling in from both ends. ManifoldSandbox
shipped the sphere as `uRange: [0.001, 3.1405926535897932]` for exactly this reason — its
Christoffel symbols contain `1/tan(u)`.

**Sign conventions come from do Carmo, never from the web.** K is convention-independent, but II,
the shape operator and H all flip with the choice of unit normal. If a computed K or H disagrees in
*sign*, the convention is wrong at the source — fix it there, do not patch downstream. Verify
against the analytic ground-truth table.

**`src/core/geom/types.ts` is frozen as of the end of M1.** Changes to it now ripple through
everything, so extend it only deliberately.

**Constructors preserve order; only `simplify` sorts.** `ast.ts`'s smart constructors flatten, fold
constants and drop identities, but never reorder terms — the live typeset echo renders from that
tree and must not rearrange a formula while the user is still typing it. So
`parse("u+v") !== parse("v+u")` while `simplify` makes them identical. Canonical ordering and
like-term collection belong to `simplify.ts`, which is what the math pipeline runs.

**The shape operator needs an orthonormal tangent basis.** `I⁻¹·II` in the chart basis {X_u, X_v}
is **not symmetric** whenever F ≠ 0, so eigendecomposing it directly is wrong. Gram–Schmidt to
(t₁, t₂) and eigendecompose `II₂ = Qᵀ·II·Q`. `resolveShape` in `geom/shape.ts` is the only place
curvature is computed, for every representation; do Carmo's closed forms for K and H are *tests*
of it, not the implementation.

**Colour and extent scales use a robust quantile, never `max`.** One sample near a chart
singularity returns K ≈ 10¹²; scaling by the maximum then paints the whole surface uniform grey —
a silent failure that looks like a rendering bug. `robustScale` takes the 98th percentile so
outliers saturate the colormap instead of flattening everything. ManifoldSandbox has the `max`
version; do not copy it back.

**Debounce text edits; throttle everything else.** A debounce waits for quiet, so a *held* slider
produces nothing until release and then jumps — jank, even though each render was fast. Only a
change that must **reparse** belongs on `onEdit`. Parameter values, domain bounds and overlay
settings change no formula, so they go through `onParameterChange`: one draft render per animation
frame, upgrading to full resolution once the drag settles. This mistake has now been made three
times — parameter sliders, domain sliders, overlay sliders.

**Focus and click ownership are implicit in the DOM, and that is where this UI keeps breaking.**
Three separate bugs, one root: replacing a focused `<input>`; reparenting a node containing one
(`append` on an existing child is a *move*, which detaches and reinserts); and a parent click
handler stealing a child control's click. A row-level handler must test `event.target.closest(
"input, button, select, textarea, label, …")` before acting.

**`el()` sets attributes, and a `<textarea>`'s text is not an attribute.** `setAttribute("value",…)`
is silently ignored there — the element is created empty and stays empty, while the attribute shows
up in the inspector. `dom.ts` special-cases it; anything else property-backed needs the same care.

**Never replace a DOM element the user might be typing in.** Rebuilding an `<input>` destroys its
focus and caret, which reads as the UI refusing input. Build fields once; update only their
siblings. Feature code goes through `ui/dom.ts` and never touches `appendChild` directly.

**Separate the cheap path from the expensive one in the UI.** Parsing and typesetting are
microseconds and run on every keystroke. Compiling a jet and tessellating ~32k vertices is ~29 ms
and must be debounced (draft resolution first, full resolution on idle). A transiently broken
formula leaves the last good surface on screen rather than blanking the canvas.

## Two traps that have each cost time twice

**Shader source lives in TypeScript template literals, so a backtick inside a GLSL comment
terminates the string.** Write `gl_FragCoord` without backticks inside `src/gl/shaders/*`.
`tsc` catches it immediately, but the error points at the GLSL line rather than the cause.

**`gl_FragCoord` is framebuffer-absolute, not viewport-relative.** Any pass whose fragment
shader compares against screen-space positions computed in the vertex shader must be told the
viewport origin (`uViewportOrigin` in the lines pass). Omitting it works perfectly while
everything draws at (0,0) and fails totally the moment something renders into an inset.

## Style

Matching the sibling project `../grupos`, deliberately with **no linter or formatter** — the style
is hand-enforced and consistent:

- double quotes, semicolons, trailing commas, 2-space indent, wrap at ~95–100 columns
- relative imports with explicit `.ts` extensions; **no path aliases**
- a JSDoc block on every exported math function, stating the actual formula in unicode
  (`γ̈ᵏ = −Γᵏᵢⱼ γ̇ⁱ γ̇ʲ`)
- `noUncheckedIndexedAccess` is **on**. In tight numeric loops over typed arrays, confine the `!`
  assertions to a single named accessor rather than sprinkling them through the loop.

## Two independent checks on the CAS

**`core/num/taylor.ts` must never read `fns.ts`'s `partial` table.** That is the whole reason it
exists: truncated power-series arithmetic where every elementary function's coefficients come from
its own defining ODE (`y = eᵘ` from `y′ = y·u′`, `tan` from `y′ = (1+y²)u′`), so a wrong entry in the
symbolic derivative table cannot hide in it. The reciprocal functions are composed (`sec = 1/cos`)
rather than given rules — fewer rules, no less independent.

Two things there are deliberate and easy to undo by accident: integer powers use repeated
multiplication rather than the `y′ = p·y·u′/u` rule, because that rule divides by u and `x²` at
`x = 0` is far too common to answer with NaN; and `atan2` is written from
`(x·y′ − y·x′)/(x² + y²)` rather than as `atan(y/x)`, which is wrong across the branch.

The core is **univariate**, so it yields *directional* derivatives. That still verifies every mixed
partial, because `D_v^m f = Σ (m!/α!) v^α ∂^α f` is linear in the partials and enough directions pin
each one. Recovering partials separately would need polarization — the missing piece before this
could double as the numeric fallback for jets past the node budget.

**Never use finite differences for this.** A third derivative by differencing lands near 1e-5
relative, needs a step size tuned per expression, and produces flaky tests whose tolerances get
loosened until they catch nothing.

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

M0 scaffold + lit torus ✅ · M1 CAS + jets + vertical slice ✅ · M2 signal store + expression list +
curves ✅ · M3 curvature lines, geodesics, picking, Gauss map ✅ (parallel transport still open) ·
M4 implicit surfaces · M5 book scaffolding. One commit per milestone.

## The Gauss map is a swap, not a computation

`mesh/gaussMap.ts` builds the Gauss image by **exchanging positions and normals** on an existing
tessellation. That works because the mesh already stores the unit normal per vertex, and because the
outward normal of a unit sphere at N is N itself — so the swap is self-consistent and nothing is
re-evaluated. Colours, curvature, chart coordinates and ids are *shared by reference*, which is what
makes the two meshes readable side by side and, as a free consequence, makes a click on the Gauss
sphere report the (u, v) of its preimage.

The verification worth keeping: the Gauss map's area distortion is exactly |K| (do Carmo §3-3), so
`meshArea(gaussImage(m))` must equal `totalAbsoluteCurvature(m)`. It is a **per-triangle** identity,
so it holds even where the map is not injective — a torus is 2-to-1 over part of the sphere and the
areas still agree. That one line checks the normals against the curvatures, and it is the test most
likely to catch a normal-orientation bug.

## Picking, and what is not verified in node

`gl/passes/pick.ts` renders `(rowId, u, v)` to an RGBA32F target and reads one pixel back, so a
click recovers chart coordinates exactly. **The GPU half of this cannot run under Vitest** — no
context in a node environment — so what the suite covers is the mesh half: that `mesh.ids` names
the owning row per vertex, and that ids and `chart` stay aligned through `concatenate`. That
alignment is the whole correctness claim; if it drifts, a click on one surface reports a point on
another and no amount of shader review would show it. The shader itself is verified by eye until
the `verify:glsl` page exists (M4).

Every vertex carries its **real** (u, v), not normalized [0,1] coordinates — the precedent
normalized and un-normalized around a raycast, and carrying the true values removes that
conversion and survives a restricted domain.
