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

**A row is a coordinate patch; a surface is what joined patches make.** The vocabulary is load-
bearing now that pieces snap together. One row of `X(u,v) = (…)` is a **coordinate patch** — one
chart, one rectangle of parameters. A **surface** is a connected component of the joint graph, and
it is *derived every build* (`state/surfaces.ts`), never stored: attaching a piece extends one,
detaching splits one, deleting a patch mid-chain leaves two, and nothing has to be told. A lone
patch is a surface with one chart, so there is no special case. Surfaces are numbered by where
their root sits in the document, so building on S1 cannot renumber S2. `closed` — no free boundary
anywhere — is reported because that is the condition a cobordism is being assembled to reach.

**Pieces snap by ports that are measured, exactly like periodicity.** `geom/ports.ts` turns each
chart boundary that is neither a seam nor a pole into a **port**: a rigid frame (origin, an axis
pointing out of the patch, a phase reference) plus a shape — a `circle` for a boundary that closes
up, a `segment` for one that does not. Joining is then "bring two frames into opposition", one
rotation fixed up to a roll. Four consequences worth keeping:

- The circle fit is **least squares (Kåsa), never the centroid and the mean radius**. Those agree
  only when the boundary is swept at a constant rate; `cos(v + sin v)` traces the same circle
  unevenly and puts the centroid visibly off centre, which shows up as pieces joined with a step.
- A **flat cap's axis comes from the surface normal.** A disc's rim lies in the disc's own plane,
  so the chart's outward direction is perpendicular to the circle's normal and cannot sign it —
  and the mean outward direction is *zero*, since it points radially in every direction at once.
  Get this wrong and a disc stands up inside the tube it is meant to cap.
- Pieces are **generated at the socket's size** (`catalog/pieces.ts`), never scaled to it. Scaling
  the drawn geometry would change every curvature; writing the size into the formula makes the two
  boundaries the same number. For the same reason a cap's chart opens at its tip with a shifted
  start rather than an `Interval` inset — an inset pulls in from *both* ends and would shrink the
  rim by 0.2%, which is exactly the gap this exists to prevent.
- Handles are drawn **only while assembling**. A saddle patch has four open edges, and ringing all
  of them on a surface nobody is joining is noise drawn over the figure. Drawn and clickable are
  gated on the same condition, or a press does something unexplained.

**Arrangement and assembly are one affine placement.** A jointed row's placement is *derived* every
rebuild from its parent's and the two port frames (`state/assembly.ts`), so nothing can drift out of
alignment — there is no stored transform to drift. Hand arrangement turns about the object's own
bounding centre, a joint about the frame it is joined by; `placementAbout` and `handArrangement`
convert between the two, which is what lets a piece hang off a hand-turned object and what lets
`detach` leave a piece exactly where it was instead of snapping it back to the origin.

**A joint's roll is relative; the dial that sets it is absolute.** Roll 0 lands the plug's phase
reference on the socket's, so a piece placed at 0 *continues its parent's seam* — that is what
makes a chain keep its banking for free, and it is why the roll decides which way an elbow bends.
But the twist a user sees is the sum down the chain, so the "roll of new pieces" control speaks in
that sum (`absoluteRoll`) and the joint stores the difference. Applying the dial's value at every
joint instead would spiral a run — 30°, 60°, 90° — which is the difference between a control that
says "how twisted" and one that says "twist some more". Rolls are stored in [0, 2π) so a 0…360
slider can never clamp a negative difference to zero and silently untwist a piece.

**Every transport sets its own rate.** `setSpeed(key, …)` is per key, and the rates live apart
from the entries so a control whose DOM is rebuilt — or a parameter that goes away and comes back —
resumes at the rate it was given, exactly as its play state does. It was one global dial first, on
the reasoning that two things playing together are being compared. That is true of two things being
compared and false of everything else: a document has several sliders and several flows, usually
about different questions, and one dial made every choice a compromise between unrelated
animations. The `<select>` sets its choice as a **property** after its options exist — `selected`
through `setAttribute` sets an option's *default*, which is not the same thing and is not honoured
everywhere, the same trap `dom.ts` special-cases for a textarea's `value`.

**Undo snapshots the whole document; nothing announces its own edits.** `state/session.ts` captures
everything the user made — row text, parameters, sliders, domains, colours, arrangement, joints,
overlays — as plain data with **rows identified by position**, since row ids are identities within
one run and `setRows` issues fresh ones. `state/history.ts` compares the snapshot it is handed
against the top of its stack, so a control added later is undoable without anyone remembering to
instrument it. Three rules make it usable: changes within ~450 ms **merge** (a drag is one step,
and the timer restarts so a slow drag stays one step); a change in the **row count** is always its
own step; and the first entry is never merged into, or the very first edit becomes the one thing
you cannot undo. Restore reconciles rows **in place** — `setRows` would rebuild every DOM view and
close the panel you were reading — and it *clears* each per-row map before refilling it, because
undo has to be able to remove what an action added. The hot-reload gate uses the same snapshot, so
the two cannot drift.

**Focusing an object and opening its controls are two acts.** A single click on a surface
**selects** it: the inset turns into that patch's chart and its cell is highlighted — the answer to
"which one am I looking at", which you want while still holding the camera. A **double click**
opens the properties window, at the pointer. They are split because the panel appears over the very
object just pointed at, so having it come up on every glance makes looking around expensive. Both
go through `list.select(id, reveal)`, so the highlight, the inset and the card can never disagree;
a click in the row list passes `reveal: false` for the same reason (the window would cover the cell
being edited).

**The inset shows the SELECTED patch's chart; the fallback host is the first one.** Two questions
that look like one. `primary` — the first surface — is where a row that names no chart is drawn,
and it only has to hold still. `shown` follows the selection, so clicking a patch turns the corner
into its (u, v) plane with the rows stated in it drawn flat. Tying the *fallback* to the selection
instead would move every unprefixed curve onto another surface the moment you clicked one: a
document that changes meaning when you look at it. Selection therefore rebuilds the scene
(`onSelect`), which is why the list has to report it rather than keeping it to itself.

**The chart is the whole (u, v) plane; the domain is a rectangle in it.** A curve defined in the
chart is drawn flat wherever it is finite — dashed, past the domain border — and has an image on
the surface only inside the domain. The inset frames `chartView`, the domain widened to hold what
was drawn (capped, or one sample at v = 10⁶ shrinks the domain to a dot), while the grid and border
still come from `chartBounds`, so the surface's own extent reads as a frame inside a larger plane.

**`X:` in front of a row says which chart it is stated in, and the text is the only binding.**
`(u − a)² + (v − b)² = r²` is a curve on a surface that no parametrized `t ↦ (u, v)` can state
without being solved for first — the level set is traced by marching squares and pushed forward, so
a relation with no closed form costs the same as a circle. What the formula *cannot* say is whose
u and v those are, and with several patches on screen the first one is a bad guess. So the row says
it: `splitHost` in `parse.ts` peels a leading `X:` off any row and `Item.host` carries it, which
means the binding is visible, editable, typeset in the echo, saved with the document and undone
with the text. A hidden `chartHosts` map keyed by row id was tried first and removed — it had to be
snapshotted, restored, remapped by position and kept in step with a row it was not part of, and
none of that survives the user simply retyping the row. Two consequences worth keeping: the prefix
is **blanked, not stripped**, so every diagnostic's character offsets still land on the right
column; and naming a chart also *means* the row is stated in one, so a two-component curve written
in t reads as a curve in (u, v) without the toggle being found first. The "+ relation" button does
nothing more than open a cell containing `X: ` in edit mode with the caret after it. Two things
that follow from the prefix being text: `renameDeclaration` has to **keep** it, or copying a curve
silently moves it onto whatever surface comes first; and duplicating a patch duplicates every row
stated in its chart, `rehost`ed onto the copy, along with the domain, colour, overlays and frame —
a copy that came back as a bare formula on the default domain is not the object that was copied.
Parameters are deliberately *shared* by the two, so one slider moves both circles, which is what
makes the copies comparable. The `\colon` in the typeset echo is written `\\colon` in the
template literal: a single backslash is an unknown JS escape that becomes the bare letter, and the
cell read "Xcolon u + v = 2". A parameter
first seen in a hosted row is seeded over that patch's own domain, reaching one curve-width past
each end — where such a curve leaves the chart and there is nothing more to see — because ±5 is
wrong twice over for a constant living in a chart that runs to 2π or to 1.

**`T_(u₀, v₀) X` names its point downstairs, and is peeled off before the lexer.** A tangent plane
has to be attached somewhere, and the chart is the only place it can be named without solving
anything: a point of R³ either is on the surface or is not, and asking which (u, v) it came from is
inverting X. The form is recognized by `splitTangent` in `parse.ts` **before lexing**, exactly like
`X:` — a subscript binds into a name in the lexer (`k_1`, `a_{max}`), so `T_(1,2)` otherwise comes
back as "subscript is empty" pointing at a parenthesis, which is a fact about tokens for a row
whose *form* is the thing being written. Once a row has opened `T_(` it is answered in its own
terms rather than handed back to the expression parser. Four consequences: the coordinates are
**expressions**, so `T_(a, 0) X` slides along the surface as a slider moves and costs a slot rather
than a recompile; the patch is named **after** the point, so `parseRow` reports it as the row's
`host` (the `X:` prefix spelling means the same thing) and `rehost` rewrites it *in place* — given a
prefix instead, a copied plane would read `Y: T_(1,2) X` and go on being drawn on the original; the
coordinates are **blanked, not cut**, so a diagnostic still lands on the right column; and `T_1 u`
is still a product, because only `T_(` starts one. A point written in u or v is an error, not a
slider: u is what varies over the domain, and a plane is attached at one value of it. `splitRowForm`
is shared by both forms, so `VectorField(…)` is recognized the same way — which does reserve that
spelling: a row declaring a function called `VectorField` is read as the form and told its tail is
not a patch name.

**A vector field is written in ambient components, and tangency is measured, not assumed.**
`X: VectorField(a, b, c)` gives the vector's coordinates in the R³ the surface lives in, as
functions of that patch's u and v. Ambient rather than chart components because that is how a
field is written when it is the restriction of something defined on all of space — a rotation, a
gradient, a constant wind — and because it makes tangency a *question with an answer*: the scene
measures |⟨V, N⟩|/|V| at every arrow and names the worst in degrees. `(0, 0, 1)` is a perfectly
good field on R³, tangent to a cylinder everywhere and to a sphere almost nowhere, and the row says
which. It is drawn either way — seeing a field lean off the surface is how the failure is
understood — but it is drawn *and named*, because nothing intrinsic can be read off a field that is
not tangent. The tolerance is 1e-3, a quarter of a degree: with analytic derivatives a genuinely
tangent field lands at 1e-15, so anything meant to be tangent and failing is off by degrees rather
than by rounding.

**A flow is integrated in the chart, never in R³.** `core/geom/flow.ts` plays a field by carrying
particles along their integral curves, and the ODE runs **downstairs**: stepping `p ← p + V dt` in
space leaves the surface immediately — a sphere's rotation field is tangent at p and pointing into
empty space a millimetre later — so the swarm spirals off and the picture is of nothing. The
right-hand side is the field's tangential part in chart components, `[E F; F G](u̇, v̇)ᵀ =
(⟨V,X_u⟩, ⟨V,X_v⟩)ᵀ`, which reproduces V exactly for a tangent field and flows along the part that
is tangent for one that is not — so a field the scene has warned about still animates instead of
failing. X_u and X_v are read straight off the jet rather than through `surface.at`, which would
resolve the shape operator (an eigendecomposition) at every stage of every RK4 step and use none of
it. A seam wraps and the streak restarts there; a wall reseeds; particles carry staggered lifetimes,
because every flow with a sink is a picture of an empty surface after five seconds.

**The flow's state belongs to the app, and its image travels with it.** Two decisions that look
like caching and are not. The particles live in `main.ts` beside the aimed shots, **not** in the
scene: the scene is rebuilt whenever anything is edited, and a flow that emptied and reseeded every
time a slider moved would be a picture of the rebuild. Their positions are chart coordinates, which
go on meaning the same thing across one. And `FlowState` carries the *drawn* points and normals,
written one head per particle per frame by `advance` — recomputing the whole streak at draw time
would evaluate X `FLOW_TRAIL` times more often than the integration does, so the drawing would cost
more than the mathematics. Drawing then evaluates nothing. The rest follows: a **ticker** in
`ui/animate.ts` is played by the same transport a slider sweep uses and shares its speed, but
`step()` reports only whether a *slider* moved — a ticker paints its own frame, and reporting it as
movement would drag a full retessellation behind every frame at sixty frames a second. Dropping a
row unregisters its ticker (`dropView`), or the frame loop keeps running for a row that no longer
exists. The transport goes **on the row's cell**, where a numeric row's slider goes. It was in the
properties card first, which was wrong twice over: the floating placement hides that card's tray on
purpose, so the button was invisible in the default layout — and a play button nobody can find is a
feature that does not exist. One copy only, since two would each paint their own play state and
disagree the moment either was pressed.

**A row's colour is shown on its cell, and the scene is what says what it is.** The dot in a cell's
left gutter is a **readout** — the colour that build actually drew the object in — because the
defaults are not one rule: a curve takes the next palette entry by document order, a field its own
blue, a patch the shade under its curvature map. A dot that guessed would be a swatch that lies
about the object beside it, so `buildScene` reports `usedColors` and the list shows that, with a
chosen colour winning exactly as the scene resolves it. The dot is also the **switch**: clicking it stops the object being drawn, filled while it is on
screen and a hollow ring in the same colour while it is not — switched off, not decoloured, so it
comes back in the colour it left in. What "off" means depends on the object: a patch takes its face
off and keeps its grid, since the outline is the half worth leaving behind; a field takes its
arrows off, through the same flag the → chip holds; everything else stops being drawn. All three
land in the overlays record, so being switched off is part of the figure — snapshotted by undo,
saved with the document — rather than a mood the session is in. **That record is no longer only
about patches**, which broke it once: `syncOverlayControl` deleted the whole entry for any row that
was not a surface, so a field's `arrows` was erased on the next refresh and the switch turned itself
back on. The controls that rewrite the record from their closure locals now carry `hidden` and
`arrows` across the same way `start` is read back from the map. Changing the colour is the
**pencil's** job and not the dot's, so a stray click on a cell cannot repaint an object; the pencil
is an inline **SVG**, because `✎` is only there if the reader's font has it — which is exactly how
it shipped invisible. **A slider row wraps; it never overflows.** The arithmetic does not fit and cannot be made to: a
300px panel leaves ~230px of cell body once the colour gutter and the padding are out, and a name,
two typed ends, a draggable track and a transport want half again as much. So `.slider` is
`flex-wrap: wrap` and the transport drops to a second line, still right-aligned. The alternative is
a control pushed off the edge — in the DOM, doing nothing, reading as a missing feature — which is
exactly how the play button went missing twice: first to `overflow: hidden` on the row (added so
its rounded corners would clip the gutter, now the gutter rounds its own), then to the 30 pixels
the gutter took. Nothing in a cell may be clipped horizontally; the card's swatch stays as a second
way in, and both route through one `applyColor` — a value with two controls has to be written in one
place or they drift, which is the bug the two play buttons already had. The hidden `<input
type="color">` is positioned off screen rather than `display: none`, because `click()` on a hidden
input is a no-op in some browsers and opening it is the only reason it exists.

**A field is drawn twice: on the surface and in the chart.** Downstairs it is the field's own
chart representation — the (u̇, v̇) solving `[E F; F G](u̇,v̇)ᵀ = (⟨V,X_u⟩, ⟨V,X_v⟩)ᵀ`, components in
the basis {∂/∂u, ∂/∂v} — taken from `createFlow(...).velocity` rather than written a second time,
so the arrows in the inset and the flow that runs along them cannot disagree about which way the
field points. Their lengths are levelled in the units the inset is **drawn** in, dividing by the u
and v spans before the robust quantile: the domain is stretched to fill the box, so scaling by
|(u̇, v̇)| would come out long in whichever direction has the narrower range. The flow is drawn
there too, which is why `FlowState` carries a `chartTrail` alongside its image — two doubles per
point beside the six already stored, shifted in the same pass, against evaluating the surface again
downstairs. Both are drawn only for the patch the inset is **showing**, the rule every chart curve
already follows.

**A field's arrows are a frame decision, not a document one.** `Scene.fieldArrows` hands back the
very `LineGroup` that is also in `lines`, keyed by the field's row, so the app can leave it out of a
frame by identity — the arrows are hidden while the flow plays (a current read through a hedge of
arrows is neither) and whenever the row's own switch says so. Both cost a repaint instead of a
tessellation, which is what makes play and pause instant. Playing **overrides** the switch for as
long as it runs rather than editing it, so pausing brings the arrows back and a paused field is
never a blank surface. The switch itself is stored in the overlays record, which is already
snapshotted by undo, saved with the document and keyed by row.

**Arrows share one scale, from a robust quantile, and are planted at cell centres.** A field is a
picture of magnitudes as well as directions, so one scale is applied to all of them and their
relative lengths mean something — but scaling by the largest vector lets one sample near a chart
singularity (`1/sin u` at a pole, |V| ≈ 10¹²) shrink every other arrow to a dot, the same silent
failure `robustScale` exists to prevent for colour. Past the 98th percentile the arrows saturate at
twice the grid spacing instead. They sit at **cell centres** of the domain, never on its border,
which is exactly where a chart tends to be singular. `catalog/pieces.ts`-style discipline applies to
the examples too: every field in `CATALOG.fields` is a combination of the patch's own coordinate
fields, which is the only way to be tangent to an arbitrary surface, and the suite checks each one
against ⟨V, N⟩ = 0 rather than trusting the algebra. The **+ field** button seeds ∂X/∂v by
differentiating the row's own text through the CAS — tangent by construction, and the one default
that exists for any patch.

**The tangent square is orthonormal; X_u and X_v are drawn lying on it.** The frame comes from
Gram–Schmidt on (X_u, X_v) rather than being spanned by them — those two are almost never orthogonal
and almost never the same length (a torus's are in the ratio R/r), so a parallelogram would draw
the same plane as a different shape at every point, and a square that stays a square is what makes
it read as one object carried along the surface. The basis is drawn *on* the square at unit length,
because |X_v| = R sin u runs from nothing at a pole to R at the equator and a true-length arrow
would vanish and then overshoot the plane it is meant to lie in; the directions carry the angle
between them — that is F — and the lengths are what the row reports as E and G. Like every other
thing built by evaluating X it is owned by the **host's** row, so it moves with the surface, and it
is lifted by the same amount a curve on the surface is, since it touches the surface exactly where
the eye is looking. At a degenerate point it is not drawn at all: the plane does not exist there,
and a plausible square through a pole is a picture of nothing.

**The grid on a surface is curves off the mesh, not a fragment overlay.** It used to be
`fract(uv / spacing)` antialiased by `fwidth` in `shaders/surface.ts`. One decision, three
symptoms: a line was drawn wherever a *fragment* landed near a multiple of a fixed π/4 spacing, so
it followed the facets and a circle of constant u came back as a visible polygon; the domain
border was drawn only when the domain happened to end on a multiple of that spacing, which is to
say never; and with the face off the branch thresholded its own coverage and discarded, throwing
away the antialiasing it had just computed. `chart.ts`'s `surfaceGridLines` walks the tessellation's
own rows and columns instead — the lines *are* the surface's samples, so they are exactly as smooth
as it is, the border is the first and last row, and the thick-line pass draws them like any other
curve. They are built after `placeMesh` and carry **no `rowId`**, like the port handles, since the
vertices they are read from have already been moved. They live in `scene.gridLines`, apart from
`scene.lines`, because they are not a curve anyone drew: counting them would make every readout
about "what this document draws" answer with the tessellation. The mesh's `style` bit 2 survives as
the per-patch toggle; bit 1 is all the shader still reads.

**A curve pushed onto a surface takes the *surface's* placement.** It is built by evaluating X,
which knows nothing of arrangement, so its `LineGroup` is owned by the surface's row and not by the
row that defined the curve. Owned by the latter, the image of a moved surface's curve is drawn
where the formula alone would put it: exactly the right shape, hanging in space beside the object
it belongs to.

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

**Curvature is painted per surface, and the legend labels the selected one.** The scale used to be
pooled across the scene, so one object decided how every other looked: a sphere of radius 0.2 has
K = 25, which drags the shared 98th percentile up 25-fold and leaves a unit sphere beside it a
uniform grey — indistinguishable from a plane, which reads as a rendering failure rather than as a
comparison. Each patch is now coloured through `sampleCurvatureRange(...).scale` computed from its
own samples. The trade is real and is why it was the other way first: identical colours on two
surfaces no longer mean identical curvature. It is paid for by the legend, which shows
`scene.curvatureScale` — the scale of the *shown* patch — so the number on screen always belongs to
something on screen. The **lift** stays scene-wide (`liftScale`): being lifted a little too far
costs nothing, being lifted too little z-fights.

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
Four separate bugs, one root: replacing a focused `<input>`; reparenting a node containing one
(`append` on an existing child is a *move*, which detaches and reinserts); a parent click handler
stealing a child control's click; and a list reconciler that re-appended *every* row whenever the
order differed at all. Typing the first letter into the trailing cell creates the next one, so the
order differed on that keystroke and the focused input was detached out from under the caret — the
cell defocused as soon as you typed in it. `syncRows` walks the two lists together and inserts only
where they disagree, so appending a cell touches nothing else. A row-level handler must test
`event.target.closest("input, button, select, textarea, label, …")` before acting.

**A control the user might be typing in is built once, and the model is pushed back into it only
while it is not focused.** The row textarea and the domain bounds both do this: the field wins
while it has focus, the model wins otherwise. Undo, a template load and an opened file all rewrite
rows from outside, and without the push-back the cell goes on showing text the document no longer
holds.

**No control changes its own range as a side effect of a drag.** Sliders used to grow when the
thumb was pushed against an end and the pointer kept going. It reads well in a sentence and badly
in the hand: the same gesture does something different depending on where the thumb already was, a
drag that overshoots silently redefines what the whole track means, and a range set on purpose is
undone by the next fling of the mouse. So a drag moves the value and nothing else; a range changes
only when said so, by double-clicking a thumb and typing — past an end if need be, which widens the
track. **The sliders themselves stay.** Replacing the domain thumbs with typed fields and steppers
was tried and rejected: a bound is explored by dragging and only occasionally typed, and the
steppers turned the common case into clicking. Since a drag cannot say it, the range is said at the
**ends of the track**: two hairline fields, one per end (`trackEnds`), which is the one place a
range narrows as well as widens. The domain sliders carry the same pair, but for the two *bounds*
rather than the track's ends, and both boxes sit **together at the end of the track** — over u and
v they read as a 2 × 2 block, which is the domain rectangle written out, and a box on the left
would eat the width the track needs. A typed bound past the end of the track takes the track with
it on **both** thumbs, since the two share one scale. This is not the field-and-stepper form that
was tried and rejected: the thumbs still explore a bound, the boxes only *say* one — including the
bound whose thumb is sitting underneath the other, which double-clicking cannot reach. They carry the value into the new range rather than leaving it
outside, and the step follows the width or a range of 0…0.01 is dragged in jumps of the whole
track. A `<input type="number">` sanitizes what it cannot parse to `""` and `Number("")` is **0**,
so an emptied box has to be caught before it silently means an end at the origin. On a domain
slider the boxes are the ends of the **track**, never the two bounds: a box that followed a thumb
changes on every drag, which makes it a second readout of what the bubble already says and leaves
nowhere to state the one thing a drag deliberately cannot — how far the track reaches.

**A parameter belongs to the document, so every control for it moves together.** `k` used in two
surfaces is one number and the scene draws that one number, but each row that uses it shows a
slider of its own — and they drifted, one card reading 5.65 while the other read 8.06 for the same
`k`, which means at least one was lying about what is on screen. `paramControls` keys the live
controls by name and then by row, and a move broadcasts value *and* range to the others, skipping
any the pointer is holding. Rebuilding a cell's sliders deletes its entries first, or a dead
control keeps being pushed at. Related: `syncSliders` runs **before** the per-row loop in `refresh`
— building the controls from specs that do not exist yet meant a newly typed name had no slider
until something else was edited, and on the throttled parameter path nothing else ever is.

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

## The reference page is part of the build

`docs/index.md` is the manual, published at `/diff-geo/docs/`. It is rendered by `docs/plugin.ts`
during `vite build` — **not** by a script afterwards, because `vite build` empties `dist` and the
deploy workflow uploads whatever is there without looking, so a post-build step is one forgotten
command away from a deploy with no documentation. Four artifacts, one writer: the page, `index.md`,
`llms-full.txt` (byte-identical to it, same string emitted twice) and `llms.txt`.

Three things follow, and each is load-bearing:

- **`docs/render.ts` fails closed.** It accepts a small markdown subset and throws — naming the
  file, the line and the construct — on anything else. A parser that silently half-renders
  publishes a page with a paragraph missing and nobody notices. So a malformed table now breaks the
  app build; that is the intended trade.
- **What can rot is generated.** The function list, the constants, the catalog and the pieces come
  from live data. The row kinds, the diagnostics and the geodesic stop reasons are `Record`s over
  `ItemKind`, `DiagCode` and `StopReason` in `docs/tables.ts`, which is why `docs` is in
  `tsconfig.app.json`'s include: adding a member to any of those three unions fails `tsc -b` until
  somebody writes the sentence.
- **Every example is run.** `tests/docs/docs.test.ts` feeds each ` ```dg ` block to
  `createDocument`, and each ` ```dg-error CODE ` block must still produce that code. It also checks
  the page is one static file, that its internal links resolve, and that the plain-text twin has no
  relative links — a `.md` fetched on its own has no base to resolve them against.

`docs/render.ts` and `docs/tables.ts` are **pure**: the test suite imports them, and
`tsconfig.app.json` restricts `types`, so `node:fs` does not typecheck there. Reading files is
`plugin.ts`'s job alone. The palette is lifted out of `src/style.css`'s `:root` block rather than
restated, and the page links back to the app with `../`, so it stays path-independent like
everything else `base: "./"` buys.

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
