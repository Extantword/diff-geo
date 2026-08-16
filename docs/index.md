# DiffGeo — reference

DiffGeo is an interactive differential geometry engine for curves and surfaces in R³, following
do Carmo's *Differential Geometry of Curves and Surfaces*. You write formulas into cells and the
objects appear: coordinate patches, curves, tangent planes, vector fields and their flows — with
curvature, geodesics and the Gauss map computed from a real computer algebra system rather than
sampled and smoothed.

It runs in the browser and there is nothing to install: [open the app](../). This page is the
manual. The same text is served as [plain markdown](./index.md) for anyone — or anything — that
would rather read it that way; see [for agents](#for-agents).

> Conventions throughout are do Carmo's. In particular N = X_u × X_v / |X_u × X_v|, which makes
> K = 1/R² and H = −1/R on the sphere of radius R. K does not depend on that choice; H, k₁ and k₂
> all change sign with it.

---

## Quick start

Every object is one row of text. Type into the empty cell at the bottom of the left panel; a new
empty cell appears under whatever you write. Press **Shift+Enter** to commit a cell, or click
away — plain Enter inserts a line break, because a surface is easier to read over three lines.

A sphere, with a slider for its radius:

```dg
R = 2
X(u,v) = (R sin u cos v, R sin u sin v, R cos u)
```

The first row declares a number, so it gets a slider. The second is a map from a rectangle of
(u, v) to R³ — a **coordinate patch** — so it is drawn as a surface, painted with its Gaussian
curvature.

A curve, in its own parameter:

```dg
alpha(t) = (cos t, sin t, t/3)
```

And a vector field on a surface, which can be played as a flow:

```dg
X(u,v) = (sin u cos v, sin u sin v, cos u)
X: VectorField(-sin u sin v, sin u cos v, 0)
```

Nothing above is special-cased. Everything in the [catalog](#the-catalog) is the same kind of text,
and loading a template inserts exactly what you could have typed.

---

## The formula language

### Names

An identifier is **one character**, unless the text greedily matches a name the lexer knows — a
built-in function, a spelled-out Greek letter, or a constant. So `uv` is u·v, `Rcos v` is R·cos(v),
and `theta` is one variable rather than five.

This is the compromise every plain-text formula language has to make, and it is the same one Desmos
makes. It is what lets a parametrization be typed the way do Carmo writes it.

A **subscript binds into the name**: `k_1` and `k_2` are single variables, which matters because
the principal curvatures are called exactly that. Braces work for longer subscripts: `a_{max}`.

<!-- generated: greek -->

Single-codepoint Greek is accepted directly too, so pasted formulas work: `α`, `θ`, `Ω`.

Four names are **coordinates** and can never be redefined or given a slider: `u` and `v` chart a
surface, `t` parametrizes a curve, and `x`, `y`, `z` are the ambient coordinates. Writing `t = 3`
is an error rather than a definition, because the whole point of t is that it varies.

### Numbers and constants

Digits, an optional decimal point, and scientific notation when digits actually follow — `2e-3` is
a number, while `2e` stays 2·e.

<!-- generated: constants -->

`e` is deliberately **not** reserved for Euler's number: in do Carmo, `e`, `f` and `g` are the
coefficients of the second fundamental form, and shadowing them would be a constant irritation for
the sake of something `exp(1)` already says. `tau` is not reserved either — τ is torsion throughout
Chapter 1.

Pasted operators are normalised: `−` `–` `—` become `-`, and `×` `·` `⋅` become `*`.

### Operators

Binding powers, loosest first:

| operator | binds | direction |
| --- | --- | --- |
| `+` `-` | 10 | left |
| `*` `/` | 20 | left |
| implicit multiplication | 25 | left |
| unary `-` | 30 | prefix |
| `^` | 40 | right |

Two consequences worth knowing. `-x^2` is −(x²), never (−x)²; and `2^3^2` is 2⁹, because `^` is
right-associative.

The third is the one that surprises programmers: **implicit multiplication binds tighter than
division**, so `1/2u` reads as 1/(2u). That is how `1/2π` is universally read on paper. Picking a
convention silently would be the wrong thing to do, so the row says so with a warning
(`W_AMBIGUOUS_IMPLICIT_MUL`) whenever an implicit product is swallowed into a denominator. Write
`(1/2)u` or `1/(2u)` to say which you meant.

### Bare function arguments

A function used without parentheses takes **a maximal run of implicitly multiplied atoms, stopping
at the next function name**. That one rule resolves the conflict between the two readings people
expect:

| written | read as |
| --- | --- |
| `sin 2u` | sin(2u) |
| `cos u cos v` | cos(u)·cos(v) |
| `(2 + cos u)cos v` | (2 + cos u)·cos v |
| `sin u^2` | sin(u²) |
| `sin^2 u` | (sin u)² |

Both of the first two are everywhere in do Carmo — the second especially, since every surface of
revolution looks like it — and a rule that handled only one of them would silently misparse real
input.

A function of two arguments always needs its parentheses: `atan2(y, x)`.

### Built-in functions

<!-- generated: functions -->

`min`, `max`, `floor`, `ceil` and `mod` are **deliberately absent**. Their derivatives are indicator
functions, and every quantity this engine computes is a derivative of what you type — so admitting
them would mean admitting curvatures that are wrong at every corner without saying so. Everything
in the table above is closed under differentiation.

Absolute value is `abs(x)`; bars are not supported, because `|x|` has no distinct opening and
closing form and is genuinely ambiguous to parse.

---

## Rows

A row's **shape** — how many arguments it declares, how many components it has, which coordinates
appear free in it — decides what it is. Nothing has to be chosen from a menu.

<!-- generated: rowKinds -->

Rows resolve **by name, not by position**: a row may use something defined below it, and moving
rows up and down never changes what the document means. Order is presentation.

Any name that nothing defines and that is not a coordinate becomes a **parameter** with a slider,
immediately. That is how `R` above got one, and it is why `X(u,v) = (a u, v, 0)` is drawable the
moment you type it.

### What each row draws

A few readings are worth stating because they are decisions rather than deductions:

- `z = x^2 - y^2` and `f(x,y) = x^2 - y^2` are the same graph over the ambient plane.
- `v = sin u` is a graph **in the chart** — the curve v = f(u) drawn in the (u, v) plane and pushed
  onto the surface — and so is `f(u) = 2 + cos u`, which stays usable as a definition as well.
- `u = 3` and `v = 2` are coordinate curves, for the same reason.
- A one-parameter row with two components is a plane curve. Written in `t` it is drawn in the z = 0
  plane; written in `u` or `v` it is read as a curve in the chart. The row's card carries a
  checkbox to say which you meant, since only you know.
- A tuple with no free coordinate at all is a point: `(1, 2, 3)`.

### Naming a chart with `X:`

`(u − a)² + (v − b)² = r²` is a curve on a surface that no parametrized `t ↦ (u, v)` can state
without being solved for first. What the formula cannot say is **whose** u and v those are, and
with several patches on screen the first one is a bad guess. So the row says it, with a prefix:

```dg
X(u,v) = ((2 + 0.7 cos u) cos v, (2 + 0.7 cos u) sin v, 0.7 sin u)
X: (u - 1)^2 + (v - 2)^2 = 1
```

The relation's level set is traced in the chart and pushed forward onto the surface, so a curve
with no closed form costs the same as a circle.

The prefix is the **whole binding**: it is visible, editable, saved with the document and undone
with the text. Naming a chart also *means* the row is stated in one, so a two-component curve
written in `t` is read as a curve in (u, v) without any toggle being found first:

```dg
X(u,v) = (sin u cos v, sin u sin v, cos u)
X: beta(t) = (t, 2t)
```

Duplicating a patch (the `⧉` button on its cell) copies every row stated in its chart along with
it, re-pointed at the copy, so the copy is the object rather than the line of text.

### Tangent planes

`T_(u₀, v₀) X` attaches the tangent plane at a point of X's chart:

```dg
X(u,v) = (sin u cos v, sin u sin v, cos u)
T_(1.5, 0) X
```

The point is given **downstairs**, in the chart, which is the only place it can be named without
solving anything: a point of R³ either is on the surface or is not, and asking which (u, v) it came
from means inverting X.

The plane is drawn as a ruled square with X_u, X_v and the unit normal on it, and the row reports
K, H, E, F and G there. The coordinates are expressions, so a slider can carry the plane along the
surface:

```dg
X(u,v) = (sin u cos v, sin u sin v, cos u)
T_(a, 0) X
```

`X: T_(1.5, 0)` means the same thing. Writing a point in terms of `u` or `v` is an error: those are
what vary over the domain, and a plane is attached at one value of them.

### Vector fields

`X: VectorField(a, b, c)` is a vector field along a patch, given by its three **ambient**
components as functions of that patch's u and v:

```dg
X(u,v) = (sin u cos v, sin u sin v, cos u)
X: VectorField(-sin u sin v, sin u cos v, 0)
```

Ambient components rather than chart components, because that is how a field is written when it is
the restriction of something defined on all of space — a rotation, a gradient, a constant wind —
and because it makes tangency a **question with an answer** rather than something the notation
assumes. The row measures |⟨V, N⟩| / |V| at every arrow and names the worst in degrees:

```dg
X(u,v) = (sin u cos v, sin u sin v, cos u)
X: VectorField(0, 0, 1)
```

That field is tangent to a cylinder everywhere and to a sphere almost nowhere, and the row says so.
It is still drawn, because seeing a field lean off the surface is how the failure is understood.

To write a tangent field by hand, take any combination f(u,v)·X_u + g(u,v)·X_v — that is what every
example in the catalog is. The **+ field** button on a patch does it for you: it differentiates the
patch's own formula and writes ∂X/∂v, which is tangent by construction.

`VectorField(…) X` is the same row said the other way round.

### Diagnostics

Errors, warnings and hints appear under the row that caused them. Nothing throws: a formula that
blows up produces non-finite numbers, and everything downstream branches on them — the mesh drops
triangles it cannot place, readouts show a dash, integrators stop and say why.

<!-- generated: diagnostics -->

Two of those are worth expanding. `E_DUPLICATE` **fails closed**: two rows declaring one name means
the name resolves to *neither*, because resolving to the first would make editing order silently
significant. And a cycle is **data, not a crash** — the rows in it get a diagnostic and the rest of
the document goes on working.

Here is a row that is wrong on purpose, and the code it produces:

```dg-error E_ARITY
X(u,v) = (u, v, 0)
T_(1) X
```

```dg-error E_CLASSIFY
X(u,v) = (u, v, 0)
T_(u, 0) X
```

---

## The interface

### Cells

The left panel is a list of cells, one per row. A cell shows its formula typeset while you are not
editing it and its text while you are. Clicking a cell opens it; **Shift+Enter** or clicking away
commits; **Escape** leaves it. There is always exactly one empty cell at the end.

A surface is reformatted when you leave the cell, one named coordinate per line:

```text
X(u, v) = (
  x = (R + r cos u) cos v,
  y = (R + r cos u) sin v,
  z = r sin u
)
```

The labels are dropped again when the row is read — position already says which component is
which — so this is a presentation of the same map, and reformatting an already-formatted cell does
nothing.

Each cell carries, on hover: `⧉` duplicate, `↑` and `↓` to move it, and `×` to remove it. A badge
names what the row was recognised as.

### The colour dot and the pencil

Down the left of every cell that draws something is a **dot** in the colour the object is actually
drawn in — a curve's palette entry, a patch's shade under the curvature map. It is a readout, not a
guess: the scene reports the colour it used.

Clicking the dot **switches the object off**, and what that means depends on the object. A patch
loses its face and keeps its grid, which is the half worth leaving behind while you look at what it
was covering. A field loses its arrows. Everything else stops being drawn. The dot goes hollow,
keeping its colour, and clicking it again brings the object back.

Under the dot is a **pencil**, which opens a colour picker. Changing a surface's colour also
switches it to a solid colour map — otherwise the swatch would appear broken, since curvature is
painted over the object's own colour.

### Sliders

A parameter's slider carries its value on the thumb.

- **Drag** the thumb to change the value. A drag changes the value and nothing else: the ends of
  the track are walls, and no gesture may silently redefine what a track means.
- **Double-click the bubble** to type an exact value. A value outside the current range widens the
  range to hold it.
- The two small boxes at either end of the row are the **ends of the track**. Type in them to
  narrow or widen it. They are the one place a range can be made smaller, and they never move on
  their own.

A parameter belongs to the document, not to a row: `k` used by two surfaces is one number, and
every control for it moves together.

The **+ slider** button under the list adds a fresh parameter under the first unused single letter.

### The domain

Every patch and every curve has a domain — the rectangle of parameters it is sampled over — with
one two-thumbed slider per variable in the properties card. Defaults are 0…2π for `u`, `v` and `t`,
and −2…2 for `x` and `y`.

Domain sliders carry the same pair of typed boxes as parameter sliders, and they mean the same
thing: the ends of the **track**, not the two bounds. A bound stops where the parametrization
starts repeating itself, since past that point a domain is drawing the same surface twice.

Chart quantities routinely blow up exactly at a coordinate boundary — `1/tan(u)` at a sphere's
pole — so catalog domains arrive pulled slightly inside theirs.

### Chips

Selecting an object opens its properties. Beside the colour swatch:

| chip | what it does |
| --- | --- |
| `K` | paint Gaussian curvature, or show the object's own colour |
| `◼` | the face: draw this patch's surface |
| `▦` | the grid: draw its (u, v) grid and the border of its domain |
| `+ relation` | open a new cell that already names this patch, ready for a relation |
| `+ tangent` | a tangent plane at the centre of this patch's domain |
| `+ field` | this patch's own coordinate field ∂X/∂v, tangent by construction |
| `→` | a field's arrows; the flow replaces them while it plays |

A surface's card also carries the overlay tools: a colour-map menu (signed curvature, viridis,
plasma, greyscale, solid), `γ` for how many geodesics to fan from the start point, `s` for how far
they run, `k₁k₂` for the two lines of curvature, `↗` to aim a geodesic by dragging, `⌫` to clear
the aimed ones, and `N` for the Gauss map.

Curves get a moving-frame checkbox and a slider for where along the curve to draw T, N and B.

### Flows

A vector field's cell carries a transport: **▶** plays the flow, **◀◀** reseeds the particles, and
the dial sets the speed. Each transport has its own speed, so a flow can run fast while a radius
creeps.

What moves are particles carried along their integral curves, leaving short streaks. The
integration happens **in the chart**, on the field's tangential part, which is why the particles
stay on the surface instead of spiralling off it — and why a field that is not tangent still flows,
along the part of it that is. Particles are reseeded continuously, so the picture is about the
field rather than about how long you have been watching.

While a flow plays, the field's arrows step aside: a current read through a hedge of arrows is
neither. Pausing brings them back.

### The chart inset

The corner of the stage shows the selected patch's (u, v) plane — its grid, its domain border, any
relations and graphs stated in it, and a field's arrows in the basis {∂/∂u, ∂/∂v}. A flow runs
there too.

**The chart is the whole plane; the domain is a rectangle in it.** A curve defined in the chart is
drawn wherever it is finite, dashed past the domain's border, and has an image on the surface only
inside it. That is what makes the domain readable as a choice rather than as the edge of the world.

The inset follows the last patch you selected, and is toggled from the scene card.

### Selecting and moving objects

- **Click** an object to focus it: its row highlights, and if it is a patch the inset shows its
  chart. Nothing else moves.
- **Double-click** it to open its properties at the pointer.
- **Drag** an object to move it. The point you grabbed stays under the pointer.
- **Right-drag** an object to turn it about the camera's axes.
- Click empty space to deselect.

Arrangement is a rigid motion applied to what is drawn, never to the map it came from, so moving or
turning an object changes no curvature at all.

The camera: **left-drag** orbits, **wheel** zooms, **Shift-drag** (or the middle button) pans, and
`W A S D Q E` fly the view when you are not typing.

**Right-click empty space** for a formula box and the whole gallery, at the point you clicked.

### The gallery and the parts bin

The button at the top right of the stage opens the **gallery**: coordinate patches, curves, and
vector fields. Loading one *adds* to the document rather than replacing it — comparing a sphere
with a pseudosphere is the ordinary thing to want — with an unused name, the catalog's parameter
ranges as sliders, its domain, and a place beside whatever is already there. Loading a field brings
its surface with it, since a field has nowhere to live without one.

The second button opens the **parts bin**, which is for building a surface out of joined patches.
Opening it makes every free boundary appear on the stage as a ring; click one to choose it, then
click a piece to attach it. The far end of the new piece becomes the next socket, so clicking Tube
repeatedly lays a chain. Pieces are generated *at the socket's size* rather than scaled to it —
scaling drawn geometry would change every curvature. A joined piece's placement is derived from its
parent every rebuild, so a chain cannot drift out of alignment, and detaching leaves a piece
exactly where it was.

### Undo, saving and opening

**Ctrl/Cmd+Z** undoes, **Ctrl+Y** or **Ctrl+Shift+Z** redoes. A snapshot covers everything you
made: row text, parameters, sliders, domains, colours, arrangement, joints and overlays. Changes
within about half a second merge into one step, so a drag is one undo, and a change in the number
of rows is always its own step.

The scene card at the bottom left holds **save** and **open**. A saved file is the whole document
plus the camera, as JSON.

---

## What the engine computes

Everything below is computed from the formula you typed, by differentiating it symbolically and
compiling the result — not by finite differences on a mesh.

### The fundamental forms

E = ⟨X_u, X_u⟩, F = ⟨X_u, X_v⟩, G = ⟨X_v, X_v⟩ and, with N = X_u × X_v / |X_u × X_v|,
e = ⟨N, X_uu⟩, f = ⟨N, X_uv⟩, g = ⟨N, X_vv⟩.

### Curvature

K, H and the principal curvatures come from the shape operator A = −dN, by eigendecomposition in an
**orthonormal** tangent basis. `I⁻¹·II` in the chart basis is not symmetric whenever F ≠ 0, so
eigendecomposing it directly is wrong; Gram–Schmidt first, then decompose. So k₁k₂ = K and
k₁ + k₂ = 2H hold by construction, and an umbilic point does not produce a NaN — it is flagged, and
the lines of curvature are refused there rather than drawn in an arbitrary direction.

Surfaces are painted through a **robust quantile** of |K| rather than its maximum: one sample near
a chart singularity can be 10¹², and scaling by that paints everything a uniform grey. Each patch
has its own scale, so a small sphere beside a large one still shows its own variation; the legend
names the scale of the patch you have selected.

### Geodesics

γ̈ᵏ = −Γᵏᵢⱼ γ̇ⁱ γ̇ʲ, integrated in the chart from the Christoffel symbols of the first fundamental
form. A spray fans rays of equal length from a point — the centre of the domain unless you click
elsewhere — and each ray reports why it stopped:

<!-- generated: geodesicStops -->

A **seam is not a wall**: a sphere's v closes up at 2π, so a geodesic crossing there has gone
around rather than left the surface. Which boundaries are seams is measured from the parametrization
itself, not declared, so a hand-typed sphere behaves like a catalog one. A **pole** is not an edge
either: the parametrization runs straight through it, so a great circle reaching a sphere's pole
carries on.

### The Gauss map

The Gauss image is the same mesh with positions and normals exchanged, drawn on a sphere beside the
surface in the same colours — so you can see which patch went where. Its area is ∫|K| dA exactly,
per triangle, which is reported on the row and is what the test suite checks the normals against.

### Frames on a curve

T, κ, N, B and τ from an order-3 jet, for an arbitrary parametrization rather than an
arc-length one. Where |α′| = 0 the parametrization is singular and only the point is drawn; at an
inflection κ = 0, and N and B are undefined and refused rather than invented.

### Fields and flows

A field's tangency is measured, not assumed. Its flow is the field's tangential part integrated in
the chart, which is what keeps the particles on the surface.

### Assembly

Each boundary that is neither a seam nor a pole becomes a **port**: a circle or a segment, with a
rigid frame measured from the parametrization. Joining is bringing two frames into opposition, one
rotation fixed up to a roll. A **surface** is then a connected component of the joint graph, derived
every rebuild — attaching a piece extends one, detaching splits one — and it reports how many open
boundaries it has left, because being closed is the condition an assembly is usually working
toward.

---

## The catalog

Every entry is source text pushed through the same pipeline your typing goes through. The ground
truth suite verifies these nine surfaces against their closed forms, so they double as the engine's
own tests.

### Surfaces

<!-- generated: catalog.surfaces -->

### Curves

<!-- generated: catalog.curves -->

### Fields on those surfaces

Each is a combination of its patch's own coordinate fields, which is the only way to be tangent to
an arbitrary surface; the suite checks every one of them against ⟨V, N⟩ = 0.

<!-- generated: catalog.fields -->

### Assembly pieces

<!-- generated: catalog.pieces -->

---

## Recipes

**Watch a family deform.** Give a surface a parameter and play its slider:

```dg
r = 0.6
X(u,v) = ((2 + r cos u) cos v, (2 + r cos u) sin v, r sin u)
```

As r → 2 the torus becomes a horn torus. The `▶` beside the slider sweeps it; the sweep ping-pongs
rather than looping, because a jump discards the continuity that makes it informative.

**Compare two surfaces side by side.** Load two templates from the gallery. Each is painted through
its own curvature scale, so each shows its own variation; the legend follows the selected one.

**Read a geodesic.** Turn `γ` up on a surface's card, then click the surface to move where the rays
start, or arm `↗` and drag to aim one. The row reports how each ray ended.

**Look inside something.** Click the colour dot of a patch to take its face off. The grid stays, so
the shape is still legible and you can see the geodesic running through it.

**Put a curve on a surface without solving for it.** Use a relation in the chart:

```dg
X(u,v) = (sin u cos v, sin u sin v, cos u)
X: v = u + sin(3u)
```

**See a field and its flow together.** Load a field from the gallery, press `▶` on its cell, and
watch the inset as well: the same flow runs there, over the domain it actually lives on.

---

## Limits

- **Implicit surfaces are not drawn yet.** `x² + y² + z² = 1` classifies as one and says so; the
  marching-cubes path is the next milestone. A field on all of R³, `V(x,y,z) = (…)`, is recognised
  and not drawn for the same reason.
- **Identifiers are one character** unless they are a name the lexer knows. `radius` is r·a·d·i·u·s
  until something declares it.
- `min`, `max`, `floor`, `ceil` and `mod` do not exist, and will not: see
  [built-in functions](#built-in-functions).
- Parallel transport, and closed geodesics as objects in their own right, are not implemented.

---

## For agents

Three documents, with different jobs:

- **This page** — behaviour. What to type, what appears, what the controls do, what is computed.
  Also served as [plain markdown](./index.md), and mirrored at `/llms-full.txt`.
- **`/llms.txt`** — a short index of the above, following the llms.txt convention.
- **[CLAUDE.md](https://github.com/Extantword/diff-geo/blob/main/CLAUDE.md)** — the architecture and
  the invariants, for changing the code rather than using it. It is where the reasoning behind the
  decisions on this page is written down, at length.

If you are producing a document for someone: one object per row, name every patch, and state which
chart a curve lives in with the `X:` prefix. Rows resolve by name, so order is free.

---

## Colophon

This page is generated at build time from one markdown file in the repository, by about two hundred
lines of renderer that accepts a deliberately small subset of markdown and **throws on anything
else**, naming the file and the line. A parser that silently half-renders publishes a page with a
paragraph missing and nobody notices.

The parts of it that could go stale are not written by hand. The function list, the constants, the
catalog and the pieces are generated from the code itself. The tables of row kinds, diagnostics and
geodesic stop reasons are `Record`s over the unions the code exports, so adding a new one fails the
build until it is documented. And the test suite runs every example on this page through the real
document layer, checks that the deliberately-wrong ones still produce the diagnostic they claim, and
verifies that this page is a single static file with no external requests and no broken links to
itself.
