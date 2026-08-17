import { ctx, type Expr } from "../core/expr/ast.ts";
import { buildDiffMap, type DiffMap } from "../core/jets/compile.ts";
import { bishopFrames, createSpaceCurve, makeFrenetFrame } from "../core/geom/curve.ts";
import { createParametricSurface } from "../core/geom/parametric.ts";
import {
  detectPeriod,
  detectPeriodicity,
  detectPoles,
  type ChartPoles,
} from "../core/geom/periodic.ts";
import type { ColormapName } from "../core/geom/colormaps.ts";
import {
  QUAT_IDENTITY,
  isIdentity,
  quatRotate,
  type Quat,
} from "../core/num/quat.ts";
import {
  integrateCurvatureLine,
  integrateGeodesic,
  sprayDirections,
} from "../core/geom/geodesic.ts";
import {
  robustScale,
  sampleCurvatureRange,
  type CurvatureRange,
} from "../core/geom/curvatureColor.ts";
import {
  interval,
  makeChartData,
  makeSurfacePoint,
  sampleBounds,
  type Vec3,
} from "../core/geom/types.ts";
import { compileMany, compileScalar } from "../core/expr/eval.ts";
import { FLOW_TRAIL, createFlow, type FlowState } from "../core/geom/flow.ts";
import {
  DEFAULT_BASE_COLOR,
  tessellate,
  type TessellatedSurface,
} from "../core/mesh/tessellate.ts";
import { boundLevelSet, createImplicitSurface } from "../core/geom/implicit.ts";
import { marchImplicit } from "../core/mesh/marchingCubes.ts";
import { marchingSquares } from "../core/mesh/contour.ts";
import { gaussImage, meshArea } from "../core/mesh/gaussMap.ts";
import {
  IDENTITY_PLACEMENT,
  applyPlacement,
  detectPorts,
  handArrangement,
  placementAbout,
  transformPort,
  type Placement,
  type Port,
} from "../core/geom/ports.ts";
import { portOutline } from "../core/geom/ports.ts";
import { groupSurfaces } from "./surfaces.ts";
import { arrangedWith, spaceRoots } from "./spaces.ts";
import {
  occupiedSockets,
  resolveAssembly,
  sameSocket,
  socketKey,
  type Joint,
  type Socket,
} from "./assembly.ts";
import type { LineGroup, Polyline } from "../gl/passes/lines.ts";
import type { Item, RowId } from "./graph.ts";
import {
  chartGrid,
  chartLift,
  GRID_DIVISIONS,
  pushForward,
  sampleChartGraph,
  sampleChartRelation,
  meshSliceLines,
  surfaceGridLines,
  type ChartBounds,
} from "./chart.ts";

/**
 * Turning a resolved document into things on screen.
 *
 * Every row that classified into a drawable object is compiled, sampled and packed here.
 * Surfaces are **concatenated into one mesh** rather than drawn per-object: the surface
 * pass owns a single VAO, and one combined buffer keeps the draw count at one however many
 * surfaces the document holds. A shared curvature scale across all of them is a bonus
 * rather than a compromise — colours then mean the same thing on every surface at once.
 */

/** Default sampling domains, following do Carmo's variable conventions. */
export const DEFAULT_DOMAIN: Readonly<Record<string, readonly [number, number]>> = {
  u: [0, 2 * Math.PI],
  v: [0, 2 * Math.PI],
  t: [0, 2 * Math.PI],
  x: [-2, 2],
  y: [-2, 2],
  // The third side of the box a level set is searched in. Same width as the other two, because a
  // box that is not a cube makes a sphere look like an ellipsoid until you read the sliders.
  z: [-2, 2],
};

export interface DomainRange {
  min: number;
  max: number;
}

/** Per-row request to draw a moving frame at one parameter value. */
export interface FrameRequest {
  readonly show: boolean;
  /** position along the domain, as a fraction in [0, 1] */
  readonly at: number;
}

export interface SceneRequest {
  readonly items: readonly Item[];
  /** live slider values by name; these win */
  readonly parameters: ReadonlyMap<string, number>;
  /**
   * Values declared by numeric rows, used for any parameter the caller did not override.
   *
   * Without this, a document reading `R = 2` / `r = 0.6` would compile R and r as slots and
   * then fill them with an arbitrary default — the torus renders with R = r, self-intersects,
   * and loses a ring of triangles. Passing the declared values closes that gap.
   */
  readonly declaredParameters?: ReadonlyMap<string, number>;
  /** per-row, per-variable sampling ranges */
  readonly domains: ReadonlyMap<RowId, readonly DomainRange[]>;
  readonly resolution: number;
  /** which curve rows should show their Frenet trihedron, and where */
  readonly frames?: ReadonlyMap<RowId, FrameRequest>;
  /** per-surface overlays: geodesic sprays and lines of curvature */
  readonly overlays?: ReadonlyMap<RowId, SurfaceOverlay>;
  /**
   * Plane-curve rows to read as curves in the chart rather than in the z = 0 plane.
   *
   * Their two components become (u, v), and the curve is drawn twice: flat in the chart inset,
   * and pushed forward onto the surface in the same colour, so the parametrization itself
   * becomes visible.
   */
  readonly inChart?: ReadonlySet<RowId>;
  /**
   * Per-row colour, overriding the defaults for everything that row draws.
   *
   * Applies to a curve's polyline, a chart curve on both the inset and the surface, and a
   * surface's base colour — the shade shown when curvature painting is off. It deliberately does
   * NOT override the curvature colormap: that colour is a measurement, not a decoration, and
   * letting it be reassigned per object would make the legend meaningless.
   */
  readonly colors?: ReadonlyMap<RowId, Vec3>;
  /**
   * Where each object sits, as a translation applied after its formula.
   *
   * A parametrization already says where its points are, so this is not geometry — it is
   * ARRANGEMENT, which is why it is a rigid translation and nothing more. Moving a surface must
   * not change a single curvature: K, H and the principal directions are all built from
   * derivatives of X, and a constant offset differentiates away. So the translation is applied to
   * the drawn positions only, never to the map the geometry is computed from.
   */
  readonly translations?: ReadonlyMap<RowId, Vec3>;
  /**
   * How each object is turned, about its own centre.
   *
   * Rigid, like the translation, and for the same reason: a rotation preserves every derivative's
   * length and every angle between them, so K, H and the principal curvatures come out unchanged.
   * Applied to the drawn positions and normals only.
   */
  readonly rotations?: ReadonlyMap<RowId, Quat>;
  /**
   * Which objects are plugged into which, boundary to boundary.
   *
   * A jointed row's arrangement is **derived** rather than stored: its placement is recomputed
   * here from its parent's placement and the two measured port frames, so a joined piece cannot
   * drift out of alignment and the translation and rotation above are simply ignored for it. See
   * `assembly.ts`.
   */
  readonly joints?: ReadonlyMap<RowId, Joint>;
  /**
   * The socket a piece would be attached to next, drawn picked out from the rest.
   *
   * Passed in rather than decided here because it is a selection — a piece of interaction state —
   * and the scene's job is to draw the consequence of it. Setting it to null draws every free
   * boundary the same.
   */
  readonly activeSocket?: Socket | null;
  /**
   * Whose chart the inset shows, when it is not the first surface's.
   *
   * Clicking a patch is how you ask "what does *this* one look like flat", and the answer is its
   * domain with the rows stated in it drawn on top. Unset — nothing selected, or a curve selected
   * — falls back to the first surface, which is what a one-patch document always meant.
   */
  readonly chartRow?: RowId | null;
  /**
   * Show this row alone, in its own ambient space.
   *
   * Double-clicking an object asks "let me look at *this*", and the honest answer is a stage with
   * nothing else on it. Filtering here rather than by hiding every other row keeps the document
   * untouched — nothing is switched off, nothing has to be switched back on, and leaving the mode
   * is one field going null. Rows stated in the isolated row's chart come with it: a curve on a
   * surface is part of that surface's picture, not another object.
   */
  readonly isolate?: RowId | null;
  /**
   * Draw the coordinate axes.
   *
   * Off by default: a figure of a surface is about the surface, and three lines through it are
   * scaffolding. On while looking at one object in its ambient space, where the question is where
   * the thing sits rather than what shape it is.
   */
  readonly axes?: boolean;
  /**
   * Draw the free boundaries as handles.
   *
   * Off by default, and it matters that it is: a saddle patch has four open edges, and ringing
   * every one of them on a surface nobody is assembling would be noise drawn over the geometry
   * the figure is actually about. The app turns it on while the parts bin is in use.
   */
  readonly showPorts?: boolean;
}

/**
 * Intrinsic and extrinsic curves drawn on a surface.
 *
 * Both start from `start` if given and from the centre of the domain otherwise. The centre is
 * the honest default rather than a placeholder: it needs no interaction, so a surface shows its
 * geodesics the moment the overlay is switched on, and a figure in the eventual book is
 * reproducible from its formula alone. A click supplies `start` and nothing else changes.
 */
export interface SurfaceOverlay {
  /** fan this many geodesics from the start point; 0 for none */
  readonly geodesics: number;
  /** arc length of each geodesic, as a fraction of the surface's extent */
  readonly geodesicLength: number;
  /** draw the two lines of curvature through the start point */
  readonly curvatureLines: boolean;
  /**
   * The aim tool: while set, dragging on this surface shoots a geodesic instead of orbiting.
   *
   * Per surface rather than global, so the gesture is only stolen on the object the user armed —
   * dragging anywhere else still moves the camera, which is what keeps the tool from feeling
   * like a mode you get trapped in.
   */
  readonly aiming?: boolean;
  /** which colour map paints K on this surface; "solid" shows its own colour instead */
  readonly colormap?: ColormapName;
  /**
   * Draw the Gauss image on a sphere beside the surface.
   *
   * Side by side rather than in its own viewport: the two meshes share a colour scale and a vertex
   * correspondence, so having them in one scene under one camera is what lets you see which patch
   * went where as you orbit. A second viewport would break the shared framing that makes the
   * comparison legible.
   */
  readonly gaussMap?: boolean;
  /**
   * Draw this patch's shaded face. Off leaves its chart grid alone in space, which is how you
   * look at what is inside it — a geodesic running through a tube, the far wall of a cobordism.
   */
  readonly fill?: boolean;
  /** Draw the chart grid on this patch. Off with `fill` off draws nothing at all. */
  readonly grid?: boolean;
  /**
   * Draw this row at all.
   *
   * The dot on a row's cell turns it off — the object stays in the document and stops being on
   * screen, which is what you want while looking at what it was covering. A **patch** answers the
   * same click through `fill` instead, because a surface with its face off still has its grid,
   * and that outline is the more useful half of it.
   */
  readonly hidden?: boolean;
  /**
   * Find the box rather than being given it. On a **level set** row.
   *
   * The domain sliders of a level set are a window, not a domain — so "show me all of it" is a
   * different question from "show me here", and it can only be answered by searching for where
   * the surface is. While this is on, the sliders are ignored.
   */
  readonly autoBox?: boolean;
  /**
   * Draw this level set **flat**, as a curve in the z = 0 plane, rather than as a surface.
   *
   * `x² + y² = 1` is the cylinder; its section by that plane is the circle. Both are honest
   * readings of the same row and only the reader knows which was meant, so the surface is the
   * default and this is how the other one is asked for.
   */
  readonly inPlane?: boolean;
  /**
   * Draw a vector field's arrows. On a **field** row, not a patch's.
   *
   * Shares this record because it is the same kind of thing — what of an object is drawn — and
   * because the record is already captured by undo, saved with the document and keyed by row.
   * The scene does not read it: which groups reach a given frame is a decision about that frame
   * (see `Scene.fieldArrows`), and the flow replaces the arrows while it runs.
   */
  readonly arrows?: boolean;
  /**
   * Where both start, in chart coordinates. Defaults to the centre of the domain.
   *
   * Clamped to the sampled domain rather than rejected when outside it, because a pick lands on
   * a triangle whose interpolated (u, v) can sit a hair past the last sample row.
   */
  readonly start?: readonly [number, number];
  /**
   * Individually aimed geodesics, each with its own start and initial direction.
   *
   * Distinct from `geodesics`, which fans a symmetric spray from one point. A spray answers "what
   * do the geodesics through here look like"; these answer "what happens if I go THAT way", which
   * is the question you ask by dragging. They accumulate, so a surface can be explored one
   * direction at a time.
   */
  readonly shots?: readonly GeodesicShot[];
}

/** One aimed geodesic: where it starts and which way it leaves, both in chart coordinates. */
export interface GeodesicShot {
  readonly start: readonly [number, number];
  readonly direction: readonly [number, number];
}

/**
 * Polyline segments per unit of the scene's extent, for overlay curves.
 *
 * Sets how finely a geodesic is sampled: a segment spans extent/this, so the drawn curve stays
 * smooth no matter how long it is. High enough that a great circle reads as round rather than
 * faceted, low enough that a long spray stays a few tens of thousands of segments.
 */
const SEGMENTS_PER_EXTENT = 220;

/**
 * Ceiling on the segments one surface's whole geodesic spray may spend.
 *
 * Density has to be bounded twice, because the two limits guard different things.
 * `SEGMENTS_PER_EXTENT` sets the spacing needed for a curve to look round; this stops the *total*
 * from growing without limit as the length and ray count are both turned up. Twelve rays of forty
 * units cost 89k points and 0.9s of integration without it, which is well past interactive — so
 * past this point the spray trades smoothness for staying responsive, which is the right way round
 * when the alternative is a frozen UI.
 */
const MAX_SPRAY_SEGMENTS = 26000;

/**
 * The domain overlay curves may integrate through, widened across coordinate poles.
 *
 * Shared by the drawn curves and by the live preview, so an aimed geodesic cannot behave one way
 * while being dragged and another once released.
 */
function integrationBounds(
  surface: ReturnType<typeof createParametricSurface>,
  poles: ChartPoles,
) {
  const uWidth = surface.u.max - surface.u.min;
  const vWidth = surface.v.max - surface.v.min;
  const [uLo, uHi] = sampleBounds(surface.u);
  const [vLo, vHi] = sampleBounds(surface.v);
  return {
    u: [
      poles.uMin ? surface.u.min - uWidth : uLo,
      poles.uMax ? surface.u.max + uWidth : uHi,
    ] as const,
    v: [
      poles.vMin ? surface.v.min - vWidth : vLo,
      poles.vMax ? surface.v.max + vWidth : vHi,
    ] as const,
  };
}

/**
 * Where to put a Gauss image sphere so it sits clear of the surface it belongs to.
 *
 * Just past the surface's own +x extent, with a gap, and centred on the surface in y and z so the
 * two read as a pair at the same height rather than as two unrelated objects.
 */
function besideMesh(mesh: TessellatedSurface, radius: number): Vec3 {
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let k = 0; k < mesh.vertexCount; k++) {
    const x = mesh.positions[k * 3]!;
    const y = mesh.positions[k * 3 + 1]!;
    const z = mesh.positions[k * 3 + 2]!;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  if (!Number.isFinite(maxX)) return [0, 0, 0];
  return [maxX + radius * 1.35, (minY + maxY) / 2, (minZ + maxZ) / 2];
}

/** One note about a row, before notes are merged per row. */
interface RawReport {
  readonly rowId: RowId;
  readonly error?: string;
  readonly info?: string;
  readonly warning?: string;
}

/**
 * Everything to say about one row, as lists.
 *
 * Lists rather than single strings because a row genuinely can have several things to report at
 * once — a surface has its K and H, and separately how its geodesic spray ended. An earlier
 * version returned one entry per note and the UI keyed them by row into a Map, so the last note
 * silently erased the others: turning on geodesics made the curvature readout disappear.
 */
export interface RowReport {
  readonly rowId: RowId;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  readonly info: readonly string[];
}

/**
 * One boundary of one object, in world coordinates, ready to be joined to.
 *
 * Measured every build from the compiled parametrization, so editing a formula moves its ports
 * with it and a surface that stops having an edge stops offering one.
 */
export interface ScenePort {
  readonly rowId: RowId;
  /** the port, placed where the object is actually drawn */
  readonly port: Port;
  /** false when a joint already uses this boundary */
  readonly free: boolean;
}

/**
 * A surface: the whole object a set of joined coordinate patches makes.
 *
 * Derived from the joints every build (see `surfaces.ts`), so it is always what the document
 * currently says rather than something that has to be maintained alongside it.
 */
export interface SceneSurface {
  readonly name: string;
  readonly root: RowId;
  readonly patches: readonly RowId[];
  /** boundaries of its patches that are not joined to anything */
  readonly freeBoundaries: number;
  /**
   * No boundary anywhere: a **closed** surface.
   *
   * True of a sphere or a torus written as one patch, and of a tube capped at both ends — which
   * is the thing a cobordism is being built out of, so it is worth reporting rather than left for
   * the eye to judge.
   */
  readonly closed: boolean;
}

/**
 * One field's flow: how to make particles, how to move them, and where they are.
 *
 * Split this way because the three have different owners. Seeding needs the domain, advancing
 * needs the surface and the field, and both live in the scene; the particles themselves belong to
 * whoever is playing the animation, and the polylines belong to the frame being drawn.
 */
export interface SceneFlow {
  /** the field row this belongs to, and the patch it is drawn on */
  readonly rowId: RowId;
  readonly hostRow: RowId;
  /** particles spread over the host's domain; the seed makes a flow replay exactly */
  seed(count?: number, seed?: number): FlowState;
  /** move every particle by `dt` seconds of wall time */
  advance(state: FlowState, dt: number): void;
  /**
   * The streaks as they now are, lifted off the mesh and placed where the object is.
   *
   * Several groups rather than one, layered: see `FLOW_BANDS`.
   */
  lines(state: FlowState): LineGroup[];
  /**
   * The same streaks flat, in (u, v), for the inset.
   *
   * Empty unless the inset is showing this field's own patch: two patches have two different
   * charts, and drawing both in one square would be a picture of neither — the rule every chart
   * curve already follows. One group rather than three, because a taper says nothing at that size
   * and the inset re-uploads every segment each frame.
   */
  chartLines(state: FlowState): LineGroup[];
}

export interface Scene {
  readonly mesh: TessellatedSurface | null;
  readonly lines: readonly LineGroup[];
  /**
   * The chart grid drawn on every patch that asks for one, and the borders of their domains.
   *
   * Kept apart from `lines` because it is not a curve anyone drew: it is part of how a surface is
   * rendered, the way its shading is, and counting it among the curves would make every readout
   * and every test about "what this document draws" answer with the tessellation instead. Already
   * in world coordinates — read off the placed meshes — so it takes no further placement.
   */
  readonly gridLines: readonly LineGroup[];
  /** polylines for the chart inset, in (u, v) */
  readonly chartLines: readonly LineGroup[];
  /** the domain the inset shows, or null when there is no surface to chart */
  readonly chartBounds: ChartBounds | null;
  /**
   * The rectangle the inset should show: the domain, widened to include the curves drawn in it.
   *
   * Distinct from `chartBounds`, which stays the domain — the grid and the border are drawn from
   * that, so the surface's own extent remains visible as a frame inside a larger view.
   */
  readonly chartView: ChartBounds | null;
  readonly reports: readonly RowReport[];
  readonly bounds: { center: Vec3; radius: number } | null;
  /**
   * The colour scale the legend labels: the shown patch's own, not the scene's.
   *
   * Curvature is painted per surface, so there is no one scale — and a legend showing a number no
   * object on screen is drawn through would be worse than no legend. Click a patch and the legend
   * says what that patch's colours mean.
   */
  readonly curvatureScale: number;
  /** the scale each patch is painted through, keyed by row */
  readonly curvatureScales: ReadonlyMap<RowId, number>;
  /**
   * The colour each row was actually drawn in.
   *
   * Reported rather than left to be guessed, because the defaults are not one rule: a curve takes
   * the next entry of a palette by document order, a field its own blue, a chart curve a third
   * palette. A swatch that showed anything else would be a swatch that lies about the object next
   * to it — and the whole point of putting one on the row is that it says what you are looking at.
   */
  readonly usedColors: ReadonlyMap<RowId, Vec3>;
  /**
   * Each field's arrows, keyed by the FIELD's row, as the very group that is also in `lines`.
   *
   * Handed out by identity so the app can leave a group out of a frame without rebuilding the
   * scene: hiding the arrows, or replacing them with the flow while it plays, is a decision about
   * this frame, not about the document. Keeping them in `lines` as well is what keeps them moving
   * with their surface — arrangement is applied there, in one pass, to everything a row draws.
   */
  readonly fieldArrows: ReadonlyMap<RowId, LineGroup>;
  /**
   * The same field's arrows in the inset, keyed the same way, for the same reason: they come and
   * go with the ones on the surface, and neither is a rebuild.
   */
  readonly fieldChartArrows: ReadonlyMap<RowId, LineGroup>;
  /** every patch boundary that can be joined to, placed in the world */
  readonly ports: readonly ScenePort[];
  /** the whole objects the patches make, one per connected set of joints */
  readonly surfaces: readonly SceneSurface[];
  /**
   * Per surface row, the width of chart after which each coordinate repeats itself.
   *
   * Null where it never does. This is the point past which a domain stops showing more surface
   * and starts showing the same surface twice, drawn over itself — which is what a domain control
   * has to stop at.
   */
  readonly periods: ReadonlyMap<RowId, readonly [number | null, number | null]>;
  /**
   * This row's current placement written as a hand arrangement: a turn about its own centre and
   * a shift. What unplugging a piece needs, so it stays exactly where it was instead of falling
   * back to whatever translation it happened to be created with.
   */
  arrangementOf(rowId: RowId): { rotation: Quat; offset: Vec3 } | null;
  /**
   * Where a surface's chart point sits in space, or null if that row is not a surface.
   *
   * Exists so an interaction can turn a picked (u, v) back into a 3D position without rebuilding
   * the scene — aiming a geodesic needs a point per pointer move, and a rebuild is ~150 ms.
   */
  positionOf(rowId: RowId, u: number, v: number): Vec3 | null;
  /**
   * The grid square of the shown chart containing (u, v), outlined flat and on the surface.
   *
   * For the hover: moving over the inset picks out one square there and the patch of surface it
   * maps to, which is the parametrization made visible one cell at a time — the thing the two
   * pictures are side by side to show. Answered from the compiled surface without a rebuild, like
   * the aimed geodesic, because it has to keep up with a pointer.
   */
  chartCellAt(u: number, v: number): { chart: Polyline; surface: Polyline | null } | null;
  /**
   * The flow of a field row, ready to be played, or null if that row is not a field.
   *
   * Exposed on the Scene for the same reason `geodesicFrom` is: the surface and the field are
   * already compiled here, and rebuilding to advance an animation by a sixtieth of a second is
   * not a thing that can happen at sixty frames a second. What is NOT here is the particles —
   * they are state belonging to the app, like the aimed shots, so that a rebuild does not empty
   * the picture the user is watching.
   */
  flowFor(rowId: RowId): SceneFlow | null;
  /**
   * Integrate one geodesic on a surface already compiled for this scene.
   *
   * For the live preview while aiming: rebuilding the scene costs ~150 ms and integrating a
   * single curve costs a few, so the drag can show the ACTUAL geodesic rather than a straight
   * arrow standing in for its initial velocity.
   */
  geodesicFrom(
    rowId: RowId,
    start: readonly [number, number],
    direction: readonly [number, number],
    length: number,
  ): Polyline | null;
}

/**
 * Kinds that, when stated on a surface, belong to its **ambient space** rather than to its chart.
 *
 * A point, a curve in space, a graph, another surface: each is a thing in R³ written while looking
 * at one object, and each is drawn when that object's ambient space is open. Everything else a row
 * can say on a surface — a relation in u and v, a tangent plane, a field along it — is part of the
 * surface's own picture and is drawn wherever the surface is.
 */


/** No translation, shared so the common case allocates nothing. */
const ZERO_OFFSET: Vec3 = [0, 0, 0];

/**
 * Move a mesh into place, in place: `p ↦ R·p + t`.
 *
 * One affine map rather than "turn about the centre, then shift", because arrangement and
 * assembly have to compose. Hand arrangement turns an object about its own bounding centre — a
 * surface parametrized off in a corner of its domain should spin where it sits rather than swing
 * on a long arm — while a joined piece turns about the frame it is joined by. `placementAbout`
 * converts the first into the second's algebra, so there is one code path and a piece attached to
 * a hand-turned object follows it exactly.
 *
 * Normals are rotated too, and are NOT re-normalised: a unit quaternion preserves length exactly,
 * so anything that came in unit comes out unit, and a zero normal — the mesh builder's mark for a
 * degenerate vertex — stays zero, which is what the shader tests for.
 */
function placeMesh(mesh: TessellatedSurface, placement: Placement): void {
  const { rotation, translation } = placement;
  const turns = !isIdentity(rotation);
  const shifts = translation[0] !== 0 || translation[1] !== 0 || translation[2] !== 0;
  if ((!turns && !shifts) || mesh.vertexCount === 0) return;

  const out: Vec3 = [0, 0, 0];
  for (let k = 0; k < mesh.vertexCount; k++) {
    if (turns) {
      quatRotate(
        rotation,
        mesh.positions[k * 3]!,
        mesh.positions[k * 3 + 1]!,
        mesh.positions[k * 3 + 2]!,
        out,
      );
    } else {
      out[0] = mesh.positions[k * 3]!;
      out[1] = mesh.positions[k * 3 + 1]!;
      out[2] = mesh.positions[k * 3 + 2]!;
    }
    mesh.positions[k * 3] = out[0] + translation[0];
    mesh.positions[k * 3 + 1] = out[1] + translation[1];
    mesh.positions[k * 3 + 2] = out[2] + translation[2];

    if (!turns) continue;
    quatRotate(
      rotation,
      mesh.normals[k * 3]!,
      mesh.normals[k * 3 + 1]!,
      mesh.normals[k * 3 + 2]!,
      out,
    );
    mesh.normals[k * 3] = out[0];
    mesh.normals[k * 3 + 1] = out[1];
    mesh.normals[k * 3 + 2] = out[2];
  }
}

/** Move a polyline by the same placement its object took, in place. */
function placePolyline(line: Polyline, placement: Placement): void {
  const { rotation, translation } = placement;
  const turns = !isIdentity(rotation);
  if (!turns && translation[0] === 0 && translation[1] === 0 && translation[2] === 0) return;
  const out: Vec3 = [0, 0, 0];
  for (let k = 0; k < line.count; k++) {
    if (turns) {
      const base = k * 3;
      quatRotate(rotation, line.points[base]!, line.points[base + 1]!, line.points[base + 2]!, out);
    } else {
      out[0] = line.points[k * 3]!;
      out[1] = line.points[k * 3 + 1]!;
      out[2] = line.points[k * 3 + 2]!;
    }
    line.points[k * 3] = out[0] + translation[0];
    line.points[k * 3 + 1] = out[1] + translation[1];
    line.points[k * 3 + 2] = out[2] + translation[2];
  }
}

/** The centre of a mesh's bounding box, ignoring non-finite vertices. */
function meshCentre(mesh: TessellatedSurface): Vec3 {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let k = 0; k < mesh.vertexCount; k++) {
    const x = mesh.positions[k * 3]!;
    const y = mesh.positions[k * 3 + 1]!;
    const z = mesh.positions[k * 3 + 2]!;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  if (!Number.isFinite(minX)) return [0, 0, 0];
  return [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];
}

/** Distinct colours for curves, cycled by row order. */
const CURVE_PALETTE: readonly Vec3[] = [
  [0.45, 0.78, 1.0],
  [1.0, 0.78, 0.35],
  [0.55, 1.0, 0.65],
  [1.0, 0.55, 0.75],
  [0.75, 0.65, 1.0],
];

const CURVE_SAMPLES = 700;

/**
 * Compiled jets, keyed by the interned identity of their inputs.
 *
 * Differentiating and simplifying a surface costs a few milliseconds — fine once, ruinous at
 * 60 frames a second while a slider moves. Because expressions are interned, a node's id *is*
 * its structural identity, so the key is exact and cheap to build: same mathematics, same
 * entry, no re-differentiation.
 *
 * Parameter *values* are deliberately absent from the key. They are compiled as slots, so a
 * slider changes the numbers fed to an unchanged program — which is the whole reason dragging
 * one can be free.
 */
const diffMapCache = new Map<string, DiffMap>();
const DIFF_MAP_CACHE_LIMIT = 64;

function cachedDiffMap(request: {
  id: string;
  comps: readonly Expr[];
  vars: readonly string[];
  params: readonly string[];
  order: number;
}): DiffMap {
  const key =
    `${request.order}|${request.vars.join(",")}|${request.params.join(",")}|` +
    request.comps.map((comp) => comp.id).join(",");

  const hit = diffMapCache.get(key);
  if (hit) return hit;

  const built = buildDiffMap({
    id: request.id,
    comps: request.comps,
    vars: [...request.vars],
    params: [...request.params],
    order: request.order,
  });

  if (diffMapCache.size >= DIFF_MAP_CACHE_LIMIT) {
    // Plain FIFO eviction. The working set is the handful of rows on screen, so anything
    // fancier would be complexity without a payoff.
    const oldest = diffMapCache.keys().next().value;
    if (oldest !== undefined) diffMapCache.delete(oldest);
  }
  diffMapCache.set(key, built);
  return built;
}

/** Colours for the moving frame, shared with the row legend. */
const GEODESIC_COLOR: Vec3 = [0.85, 0.55, 0.0];
/** k1 and k2 get distinct colours; they are different curves through the same point. */
const CURVATURE_LINE_1: Vec3 = [0.80, 0.15, 0.15];
const CURVATURE_LINE_2: Vec3 = [0.10, 0.40, 0.85];
const T_COLOR: Vec3 = [0.10, 0.60, 0.32];
const N_COLOR: Vec3 = [0.85, 0.55, 0.0];
const B_COLOR: Vec3 = [0.80, 0.15, 0.15];
const POINT_COLOR: Vec3 = [0.85, 0.45, 0.0];

/**
 * The tangent plane, and the basis that spans it.
 *
 * X_u and X_v are drawn in two colours because they are two different vectors, and the plane in a
 * third because it is not a vector at all — it is everything they span, which is the point of
 * drawing it rather than just the pair.
 */
const TANGENT_PLANE_COLOR: Vec3 = [0.25, 0.50, 0.85];
const TANGENT_U_COLOR: Vec3 = [0.10, 0.60, 0.32];
const TANGENT_V_COLOR: Vec3 = [0.80, 0.15, 0.15];
const TANGENT_NORMAL_COLOR: Vec3 = [0.85, 0.55, 0.0];

/**
 * The square under the pointer, in both pictures.
 *
 * A warm colour that no measurement uses: curvature is the diverging blue-red, curves take the
 * palette, the grid is slate. A highlight has to be reportable as *not* data.
 */
const HOVER_COLOR: Vec3 = [0.95, 0.45, 0.05];
/** Samples per side of the highlighted square, so its image is a curve rather than four chords. */
const HOVER_SAMPLES = 14;

/** A vector field's arrows, when the row has not been given a colour of its own. */
const FIELD_COLOR: Vec3 = [0.15, 0.45, 0.75];

/**
 * Arrows per direction across the domain, at cell centres.
 *
 * Cell centres rather than grid points, so no arrow is planted on the domain border — which is
 * exactly where a chart tends to be singular (a sphere's poles, a cone's tip) and where an arrow
 * would be either dropped or wrong. 12 × 12 reads as a field rather than as a hedge, and costs
 * 144 evaluations of X.
 */
const FIELD_DIVISIONS = 12;

/**
 * Particles in a flow, and how long a typical one takes to cross its patch.
 *
 * The count is what reads as a *current* rather than as a handful of dots; the crossing time is
 * the tempo, and it is stated as a time rather than as a speed so that a field on a small
 * sphere and one on a large torus animate at the same *apparent* rate. The field's own magnitudes
 * still set the relative speeds within one flow.
 */
const FLOW_PARTICLES = 800;
const FLOW_CROSSING_SECONDS = 6;

/**
 * A streak is drawn three times, at three lengths — which is how the tail fades.
 *
 * The line pass takes one opacity per group, so a taper along a single polyline is not something
 * it can express. Layering says the same thing in the medium it does have: the whole streak drawn
 * faint, its newer half over that, its head over both. Alpha accumulates where they overlap, so
 * brightness climbs toward the particle and falls off behind it — the look a p5 sketch gets for
 * free by painting a translucent background over the last frame, which a 3D scene cannot do
 * because the camera moves and the smear would be in screen space.
 *
 * Widths climb with the layers for the same reason: a head that is both brighter and slightly
 * fatter reads as the particle, and the tail thins into the surface behind it.
 */
const FLOW_BANDS: readonly { fraction: number; widthPx: number; opacity: number }[] = [
  { fraction: 1, widthPx: 1.5, opacity: 0.28 },
  { fraction: 0.5, widthPx: 2.3, opacity: 0.34 },
  { fraction: 0.2, widthPx: 3.2, opacity: 0.5 },
];

/**
 * How far from the tangent plane a field may lean before it is called untangent, as |⟨V,N⟩|/|V|.
 *
 * Analytic derivatives, so a genuinely tangent field lands at 1e-15 and anything meant to be
 * tangent and failing is off by degrees, not by rounding. 1e-3 is a quarter of a degree: past it
 * the field is not a field on the surface, however close it looks.
 */
const FIELD_TANGENT_EPS = 1e-3;

/** How the tangent plane's square is ruled: enough to read as a plane, few enough to see through. */
const TANGENT_DIVISIONS = 6;
/** Its half-width, as a fraction of the patch's own extent. */
const TANGENT_SIZE = 0.42;

/**
 * x, y, z — red, green, blue, as every 3D tool has drawn them since the first one.
 *
 * Muted rather than saturated: the axes are scaffolding, and scaffolding that competes with the
 * object is scaffolding in the way.
 */
/**
 * How far the ticks run, and how far the line goes on after them.
 *
 * The ticked stretch is about the object; the tail is about not putting an edge on space. A
 * horizon of ten thousand steps is past anything a camera framed on the object will ever reach,
 * and costs twenty segments to get to because they double.
 */
const AXIS_TICKS = 24;
const AXIS_HORIZON = 10000;

const AXIS_COLORS: readonly Vec3[] = [
  [0.78, 0.28, 0.28],
  [0.26, 0.62, 0.32],
  [0.25, 0.42, 0.80],
];

/** A free boundary, waiting to be joined to. */
const SOCKET_COLOR: Vec3 = [0.10, 0.62, 0.68];
/** The one a piece would attach to next. */
const SOCKET_ACTIVE_COLOR: Vec3 = [0.95, 0.45, 0.05];

/** A polyline through a list of points, in one colour. */
function polylineOf(points: readonly Vec3[], color: Vec3): Polyline {
  const flat = new Float64Array(points.length * 3);
  const arcLength = new Float64Array(points.length);
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    flat[i * 3] = p[0];
    flat[i * 3 + 1] = p[1];
    flat[i * 3 + 2] = p[2];
    if (i > 0) {
      const q = points[i - 1]!;
      arcLength[i] = arcLength[i - 1]! + Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
    }
  }
  return { points: flat, count: points.length, color, arcLength };
}

/** A two-point polyline standing in for one frame vector. */
export function arrow(from: Vec3, direction: Vec3, length: number, color: Vec3): Polyline {
  return {
    points: new Float64Array([
      from[0],
      from[1],
      from[2],
      from[0] + direction[0] * length,
      from[1] + direction[1] * length,
      from[2] + direction[2] * length,
    ]),
    count: 2,
    color,
    arcLength: new Float64Array([0, length]),
  };
}

/**
 * One arrow of a vector field: a shaft with a head lying flat on the surface.
 *
 * A single polyline rather than three, retracing the tip between the two barbs. The line pass
 * draws per-segment instances with round caps, so the retrace costs one extra segment and no
 * seam, and the whole arrow stays one object that the group's colour and width apply to.
 *
 * The head is laid in the plane of the direction and `perp` — which is N × d, tangent to the
 * surface — so it reads as painted on the object rather than standing off it. Barbs scale with
 * the arrow, so a short vector keeps a head in proportion instead of becoming a blob.
 */
function fieldArrow(
  base: Vec3,
  direction: Vec3,
  normal: Vec3,
  length: number,
  color: Vec3,
): Polyline {
  const tip: Vec3 = [
    base[0] + direction[0] * length,
    base[1] + direction[1] * length,
    base[2] + direction[2] * length,
  ];
  const perp: Vec3 = [
    normal[1] * direction[2] - normal[2] * direction[1],
    normal[2] * direction[0] - normal[0] * direction[2],
    normal[0] * direction[1] - normal[1] * direction[0],
  ];
  const head = length * 0.3;
  const spread = head * 0.55;
  const barb = (sign: number): Vec3 => [
    tip[0] - direction[0] * head + sign * perp[0] * spread,
    tip[1] - direction[1] * head + sign * perp[1] * spread,
    tip[2] - direction[2] * head + sign * perp[2] * spread,
  ];
  return polylineOf([base, tip, barb(1), tip, barb(-1)], color);
}

/**
 * The tangent plane at a point, drawn: a ruled square of the plane, and the basis spanning it.
 *
 * `T_p(S)` is the image of `dX_q`, so the square is laid out in an **orthonormal** frame got by
 * Gram–Schmidt from (X_u, X_v) rather than along X_u and X_v themselves. Those two are almost
 * never orthogonal and almost never the same length — a torus's are in the ratio R/r — so a
 * parallelogram spanned by them would draw the same plane as a different shape at every point,
 * and a square that stays a square is what makes it read as one object being carried along the
 * surface. The vectors themselves are then drawn *on* it, which is where the chart's own basis
 * belongs: inside the plane it spans, at whatever angle it actually makes.
 *
 * Everything is lifted along N by the same amount a curve on the surface is, because the plane
 * touches the surface exactly at p and would otherwise z-fight with it precisely where the eye
 * is looking.
 */
function tangentPlaneFigure(
  p: Vec3,
  N: Vec3,
  Xu: Vec3,
  Xv: Vec3,
  size: number,
  lift: number,
  color: Vec3,
): { interior: Polyline[]; border: Polyline[]; frame: Polyline[] } | null {
  const norm = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
  const lengthU = norm(Xu);
  if (!(lengthU > 0)) return null;
  const t1: Vec3 = [Xu[0] / lengthU, Xu[1] / lengthU, Xu[2] / lengthU];
  const along = Xv[0] * t1[0] + Xv[1] * t1[1] + Xv[2] * t1[2];
  const w: Vec3 = [Xv[0] - along * t1[0], Xv[1] - along * t1[1], Xv[2] - along * t1[2]];
  const lengthW = norm(w);
  if (!(lengthW > 0)) return null;
  const t2: Vec3 = [w[0] / lengthW, w[1] / lengthW, w[2] / lengthW];

  const centre: Vec3 = [p[0] + N[0] * lift, p[1] + N[1] * lift, p[2] + N[2] * lift];
  const at = (s: number, t: number): Vec3 => [
    centre[0] + s * t1[0] + t * t2[0],
    centre[1] + s * t1[1] + t * t2[1],
    centre[2] + s * t1[2] + t * t2[2],
  ];

  const interior: Polyline[] = [];
  for (let i = 1; i < TANGENT_DIVISIONS; i++) {
    const offset = -size + (2 * size * i) / TANGENT_DIVISIONS;
    interior.push(polylineOf([at(offset, -size), at(offset, size)], color));
    interior.push(polylineOf([at(-size, offset), at(size, offset)], color));
  }

  const border: Polyline[] = [
    polylineOf(
      [at(-size, -size), at(size, -size), at(size, size), at(-size, size), at(-size, -size)],
      color,
    ),
  ];

  /**
   * The basis, drawn at a length that keeps it on the square rather than at |X_u|.
   *
   * True lengths would be honest and unusable: |X_v| = R sin u on a sphere runs from nothing at
   * the pole to R at the equator, so the same arrow would vanish and then overshoot the plane it
   * is meant to lie in. The DIRECTIONS carry what the picture is for — the angle between them is
   * F, and it is visible — while the lengths are what the readout states as E and G.
   */
  const reach = size * 0.86;
  const unit = (a: Vec3): Vec3 => {
    const length = norm(a);
    return [a[0] / length, a[1] / length, a[2] / length];
  };
  const frame: Polyline[] = [
    arrow(centre, unit(Xu), reach, TANGENT_U_COLOR),
    arrow(centre, unit(Xv), reach, TANGENT_V_COLOR),
    arrow(centre, N, size * 0.8, TANGENT_NORMAL_COLOR),
  ];

  return { interior, border, frame };
}

export function buildScene(request: SceneRequest): Scene {
  const { parameters, domains, resolution } = request;
  /**
   * Everything the document draws, or one object and what belongs to it.
   *
   * "What belongs to it" is the rows stated in its chart — a relation, a tangent plane, a field —
   * because those are parts of its picture rather than other objects. Parameters and definitions
   * are kept whatever happens: they draw nothing and dropping them would break the rows that use
   * them.
   */
  const owner =
    request.isolate == null
      ? null
      : request.items.find((item) => item.rowId === request.isolate) ?? null;
  /**
   * The names an open space contains: the surface it belongs to, and everything written on
   * something already in it.
   *
   * The closure is what makes a space usable rather than a single-object viewer. Writing a second
   * surface inside X's space puts it there — and a field, a relation or a tangent plane stated on
   * *that* surface is in the same space, because it is stated on something that is. One level of
   * host would draw the new surface and silently drop everything drawn on it.
   */
  const inSpace = new Set<string>();
  if (owner?.name != null) {
    inSpace.add(owner.name);
    for (let pass = 0; pass < 8; pass++) {
      let grew = false;
      for (const item of request.items) {
        if (item.name === null || inSpace.has(item.name)) continue;
        if (item.host != null && inSpace.has(item.host)) {
          inSpace.add(item.name);
          grew = true;
        }
      }
      if (!grew) break;
    }
  }
  const items = request.items.filter((item) => {
    /**
     * Everything a space holds is drawn outside it too; ambient space only ever **narrows**.
     *
     * A point, a curve or a graph written inside X's space is a thing the user made, with a place
     * in the same R³ as everything else, and it goes on being there when nobody is inside looking
     * at it. Hiding those on the way out was the first design, and it read as the document
     * throwing the work away — you build something, step out, and it is gone. What is wanted
     * instead is a switch: the eye on each row says whether that object is drawn, one decision
     * per object, made by hand and remembered.
     *
     * So the filter is empty at the top level and selective only while a space is open, where it
     * keeps the object whose space it is and everything written in it, to any depth.
     */
    if (request.isolate == null) return true;
    if (item.rowId === request.isolate) return true;
    return item.host != null && inSpace.has(item.host);
  });
  const frameRequests = request.frames ?? new Map<RowId, FrameRequest>();
  const declared = request.declaredParameters ?? new Map<string, number>();
  const inChart = request.inChart ?? new Set<RowId>();
  const overlays = request.overlays ?? new Map<RowId, SurfaceOverlay>();
  const rowColors = request.colors ?? new Map<RowId, Vec3>();
  const translations = request.translations ?? new Map<RowId, Vec3>();
  const rotations = request.rotations ?? new Map<RowId, Quat>();
  /**
   * Arrangement belongs to a **space**, not to each object in it.
   *
   * A point written inside X's ambient space is at (1, 2, 3) *of that space*, and the sentence
   * stops being true the moment the point and the torus can be dragged apart. So every row
   * written in a space reads its host's placement — the same rotation, about the same centre, by
   * the same offset — and the whole space moves as one rigid thing. The gesture end of this is in
   * `main.ts`, where a drag on any member is redirected to the row that holds the placement; both
   * ends go through `spaceRoots` so they cannot disagree about who moves.
   */
  const spaces = spaceRoots(items);
  const holder = (rowId: RowId): RowId => arrangedWith(rowId, spaces);
  const offsetOf = (rowId: RowId): Vec3 => translations.get(holder(rowId)) ?? ZERO_OFFSET;
  const rotationOf = (rowId: RowId): Quat => rotations.get(holder(rowId)) ?? QUAT_IDENTITY;
  /**
   * Rows the user has switched off with the dot on their cell.
   *
   * Still resolved, still classified, simply not drawn — the object stays in the document while
   * you look at what it was covering. A **patch** answers the same click through `fill` instead,
   * because a surface with its face off still has its grid, and that outline is the more useful
   * half of it.
   */
  const hiddenRow = (rowId: RowId): boolean => overlays.get(rowId)?.hidden === true;
  /**
   * This row's chosen colour, or the built-in default for whatever it draws — and a note of which,
   * so the row list can show the colour the object is *actually* drawn in.
   */
  const usedColors = new Map<RowId, Vec3>();
  const colorOf = (rowId: RowId, fallback: Vec3): Vec3 => {
    const color = rowColors.get(rowId) ?? fallback;
    usedColors.set(rowId, color);
    return color;
  };

  const reports: RawReport[] = [];
  /** Where each coordinate starts repeating itself; the domain controls stop there. */
  const periods = new Map<RowId, readonly [number | null, number | null]>();
  const meshes: TessellatedSurface[] = [];
  const lines: LineGroup[] = [];
  const curvatureSamples: number[] = [];

  let curveIndex = 0;

  // Surfaces first, in two passes: sample every one to agree on a colour scale, then
  // tessellate. Without the shared pass each surface would get its own scale and identical
  // curvatures would paint differently on different objects.
  const surfaceItems = items.filter(
    (item) => item.kind === "parametricSurface" || item.kind === "graphSurface",
  );

  const compiledSurfaces: Array<{
    item: Item;
    surface: ReturnType<typeof createParametricSurface>;
    params: Float64Array;
    poles: ChartPoles;
    /**
     * The tessellated mesh, filled in by the tessellation pass below.
     *
     * Held on the entry rather than looked up by index in the parallel `meshes` array, because the
     * two only stay aligned while every tessellation succeeds — one throw and every later surface's
     * Gauss image would be built from its neighbour's normals.
     */
    mesh?: TessellatedSurface;
    /** the boundaries this surface offers, in its own coordinates */
    ports?: readonly Port[];
    /** where it ended up, joints resolved; the same motion its curves take */
    placement?: Placement;
    /** the colour scale THIS surface's curvature is painted through, from its own samples */
    curvature?: CurvatureRange;
  }> = [];

  for (const item of surfaceItems) {
    try {
      const comps = surfaceComponents(item);
      const paramNames = [...item.params];
      const map = cachedDiffMap({
        id: `row-${item.rowId}`,
        comps,
        vars: surfaceVars(item),
        params: paramNames,
        order: 2,
      });
      const [uRange, vRange] = surfaceRanges(item, domains);
      const params = packParameters(paramNames, parameters, declared);

      /**
       * Built twice, because periodicity can only be measured and only matters once measured.
       *
       * Whether a chart boundary is a wall or a seam decides where geodesics stop, whether the
       * mesh welds its normals across it, and whether curves in the chart wrap — but the test
       * needs to evaluate X, which needs the parameters, which are not available when a surface
       * is compiled. So a provisional surface answers the question and a second one carries the
       * answer. Both share the cached DiffMap, so the only repeated cost is a few field copies.
       *
       * The alternative — declaring periodicity per template — does not survive loading one,
       * since a template is inserted as source text and a hand-typed sphere has no declaration
       * at all. Measuring it treats both the same.
       */
      const provisional = createParametricSurface({
        id: `row-${item.rowId}`,
        map,
        u: uRange,
        v: vRange,
      });
      const periodic = detectPeriodicity(provisional, params);
      const poles = detectPoles(provisional, params);
      const surface = createParametricSurface({
        id: `row-${item.rowId}`,
        map,
        u: uRange,
        v: vRange,
        periodicU: periodic.u,
        periodicV: periodic.v,
      });
      const entry = { item, surface, params, poles } as (typeof compiledSurfaces)[number];
      compiledSurfaces.push(entry);
      periods.set(item.rowId, [
        detectPeriod(surface, params, true),
        detectPeriod(surface, params, false),
      ]);

      const range = sampleCurvatureRange(surface, params, 24);
      entry.curvature = range;
      if (Number.isFinite(range.minK)) curvatureSamples.push(range.minK, range.maxK);
    } catch (thrown) {
      reports.push({ rowId: item.rowId, error: messageOf(thrown) });
    }
  }

  /**
   * The scale the LIFT is sized by, which is the one thing that stays scene-wide.
   *
   * A curve is lifted clear of the triangles under it by an amount that grows with curvature, and
   * a single generous figure for the whole scene is right there — being lifted a little too far
   * costs nothing, being lifted too little z-fights. Colour is the opposite: it is a measurement
   * being read off a legend, so it is per surface.
   */
  const liftScale = robustScale(curvatureSamples, 1);

  for (const entry of compiledSurfaces) {
    const { item, surface, params } = entry;
    try {
      /**
       * A patch's swatch is its base colour — the shade it is painted when the curvature map is
       * off — and `DEFAULT_BASE_COLOR` is what the tessellator uses when nobody has chosen one.
       * Taken from there rather than restated, so the row list and the mesh cannot drift.
       */
      usedColors.set(item.rowId, rowColors.get(item.rowId) ?? DEFAULT_BASE_COLOR);
      const mesh = tessellate(surface, params, {
        resU: resolution,
        resV: resolution,
        /**
         * Each surface is painted through ITS OWN curvature scale.
         *
         * Pooled across the scene, one object decides how every other one looks: a torus with
         * K ≈ ±1 beside a sphere of radius 100 (K = 10⁻⁴) drives the shared 98th percentile to 1,
         * and the sphere comes back uniform grey — which reads as a rendering failure rather than
         * as "this surface is nearly flat compared to that one". Per surface, each object's own
         * variation is visible, and the legend says which scale is being read.
         */
        range: entry.curvature ?? {
          scale: liftScale,
          minK: Number.NaN,
          maxK: Number.NaN,
          invalidFraction: 0,
        },
        // The row id travels into the mesh so a pick can name the row it landed on.
        objectId: item.rowId,
        baseColor: rowColors.get(item.rowId),
        colormap: overlays.get(item.rowId)?.colormap,
        // What of this patch is drawn, per patch: both by default, so a surface nobody has
        // touched looks the way it always has.
        fill: overlays.get(item.rowId)?.fill ?? true,
        grid: overlays.get(item.rowId)?.grid ?? true,
      });
      /**
       * The eye on the row: hidden means *nothing* of this patch is drawn.
       *
       * Not the face and not the grid, which is what separates it from the dot — that takes the
       * face off and leaves the outline, the more useful half of a surface you are looking past.
       * The mesh is still built and kept on the entry, because the chart, the ports and every
       * curve pushed onto this surface are read off it; it is simply never handed to the
       * renderer, so a hidden object is not drawn and not pickable either.
       */
      if (!hiddenRow(item.rowId)) meshes.push(mesh);
      entry.mesh = mesh;
      /**
       * Where this surface ends, measured while it is still where its formula put it.
       *
       * Ports have to be local: a joint is resolved by carrying the parent's port into the world
       * through the parent's own placement, which is only possible if the port was recorded
       * before any placement was applied.
       */
      entry.ports = detectPorts(surface, params, entry.poles);

      const point = makeSurfacePoint();
      const uMid = (surface.u.min + surface.u.max) / 2;
      const vMid = (surface.v.min + surface.v.max) / 2;
      surface.at(uMid, vMid, params, point);
      reports.push({
        rowId: item.rowId,
        info: point.degenerate
          ? "no tangent plane at the domain centre"
          : `K = ${point.K.toFixed(3)}   H = ${point.H.toFixed(3)}`,
        warning:
          mesh.droppedTriangles > mesh.triangleCount
            ? `${mesh.droppedTriangles} triangles dropped — check the domain`
            : undefined,
      });
    } catch (thrown) {
      reports.push({ rowId: item.rowId, error: messageOf(thrown) });
    }
  }

  /**
   * ---- level sets ----
   *
   * `F(x, y, z) = 0` is the second representation, and it arrives here as an equation whose two
   * sides the classifier kept apart: F is their difference. Everything downstream is shared with
   * the parametric path — the mesh has the same shape, so the surface pass, the picking pass and
   * the colour scale take it without a branch — because the geometry itself is shared:
   * `implicit.ts` fills the same `SurfacePoint`, through the same eigensolver, with N = ∇F/|∇F|.
   *
   * Meshed **before** the arrangement below, so a level set can be dragged and turned about its
   * own centre like anything else: `resolveAssembly` needs its bounding centre, and that needs
   * its mesh.
   */
  const implicitMeshes = new Map<RowId, TessellatedSurface>();
  for (const item of items) {
    if (item.kind !== "implicitSurface") continue;
    try {
      const field = ctx.sub(item.comps[0]!, item.comps[1] ?? ctx.zero);
      const paramNames = [...item.params];
      const map = cachedDiffMap({
        id: `row-${item.rowId}`,
        comps: [field],
        vars: ["x", "y", "z"],
        params: paramNames,
        order: 2,
      });
      const [xRange, yRange, zRange] = implicitRanges(item, domains);
      const params = packParameters(paramNames, parameters, declared);
      const asked = createImplicitSurface({
        id: `row-${item.rowId}`,
        map,
        x: xRange,
        y: yRange,
        z: zRange,
      });

      /**
       * "Show me all of it": look for the surface instead of being told where to look.
       *
       * A level set has no domain, so the box is a choice — and the one choice the sliders cannot
       * express is "wherever it happens to be". The search is coarse and cheap, and its answer is
       * a **second surface** over the found box; the sliders keep whatever they said, so turning
       * this off puts the old window back rather than having overwritten it.
       */
      let fitted: string | null = null;
      let surface = asked;
      if (overlays.get(item.rowId)?.autoBox) {
        const box = boundLevelSet(asked, params);
        if (box) {
          surface = createImplicitSurface({ id: `row-${item.rowId}`, map, ...box });
          fitted =
            `fitted to [${box.x.min.toFixed(2)}, ${box.x.max.toFixed(2)}] × ` +
            `[${box.y.min.toFixed(2)}, ${box.y.max.toFixed(2)}] × ` +
            `[${box.z.min.toFixed(2)}, ${box.z.max.toFixed(2)}]`;
        } else {
          fitted = "nothing found within ±12, so the sliders still decide the box";
        }
      }

      // Before the marching, not after it: a level set switched off with its own dot would
      // otherwise cost a whole volume of evaluations to produce a mesh nothing draws. The colour
      // is still reported, because the dot has to keep showing what it would come back as.
      usedColors.set(item.rowId, rowColors.get(item.rowId) ?? DEFAULT_BASE_COLOR);
      if (hiddenRow(item.rowId) || overlays.get(item.rowId)?.inPlane) continue;

      const mesh = marchImplicit(surface, params, {
        res: marchResolution(resolution),
        objectId: item.rowId,
        baseColor: rowColors.get(item.rowId),
        colormap: overlays.get(item.rowId)?.colormap,
        fill: overlays.get(item.rowId)?.fill ?? true,
      });

      meshes.push(mesh);
      implicitMeshes.set(item.rowId, mesh);
      if (Number.isFinite(mesh.range.minK)) {
        curvatureSamples.push(mesh.range.minK, mesh.range.maxK);
      }

      /**
       * An empty box is the commonest way an implicit surface looks broken, and it is not broken
       * — the level set is simply somewhere else, or nowhere. Saying which is the difference
       * between a blank stage and a diagnosis.
       */
      reports.push({
        rowId: item.rowId,
        info:
          mesh.triangleCount === 0
            ? "no surface inside this box"
            : `${mesh.triangleCount} triangles · K ∈ [${mesh.range.minK.toFixed(3)}, ` +
              `${mesh.range.maxK.toFixed(3)}]${fitted === null ? "" : ` · ${fitted}`}`,
        warning:
          mesh.triangleCount === 0
            ? "widen the domain, or check that the equation has solutions"
            : mesh.droppedVertices > mesh.vertexCount
              ? `${mesh.droppedVertices} samples were not finite — check the equation`
              : undefined,
      });
    } catch (thrown) {
      reports.push({ rowId: item.rowId, error: messageOf(thrown) });
    }
  }

  /**
   * ---- arrangement and assembly ----
   *
   * Applied to the DRAWN geometry only, never to the map it came from: every curvature is a
   * derivative of X, and a rigid motion leaves all of them exactly as they were. Placing after
   * the geometry is computed is what guarantees that, rather than hoping for it.
   *
   * Two ways an object can be placed, resolved together here. By **hand**, turning about its own
   * bounding centre and shifting; or by a **joint**, which derives its placement from its parent's
   * and the two measured port frames. `resolveAssembly` walks joints to their roots, so a chain of
   * pieces follows whichever object at the top of it was moved by hand.
   */
  const joints = request.joints ?? new Map<RowId, Joint>();
  const localPorts = new Map<RowId, readonly Port[]>();
  const handCentres = new Map<RowId, Vec3>();
  for (const entry of compiledSurfaces) {
    if (entry.ports) localPorts.set(entry.item.rowId, entry.ports);
    if (entry.mesh) handCentres.set(entry.item.rowId, meshCentre(entry.mesh));
  }
  /**
   * A level set is arranged by hand like anything else, and offers no ports.
   *
   * Ports are measured from a chart's boundary, and a level set has neither — what bounds it here
   * is the box it was searched in, which is a window rather than an edge of the surface. So it
   * takes a hand placement and nothing can be joined to it.
   */
  for (const [rowId, mesh] of implicitMeshes) handCentres.set(rowId, meshCentre(mesh));
  const assembly = resolveAssembly(
    [...compiledSurfaces.map((entry) => entry.item.rowId), ...implicitMeshes.keys()],
    {
      joints,
      localPorts,
      free: (rowId) =>
        placementAbout(
          rotationOf(rowId),
          // The centre turned about is the *space's*, so every member takes the identical rigid
          // motion. Each about its own centre would spin the parts of one space apart.
          handCentres.get(holder(rowId)) ?? handCentres.get(rowId) ?? ZERO_OFFSET,
          offsetOf(rowId),
        ),
    },
  );
  for (const [rowId, why] of assembly.broken) reports.push({ rowId, warning: why });

  /**
   * Where a row's drawn geometry went.
   *
   * A row with no surface — a curve, a point — has no mesh whose centre it could have turned
   * about, so it takes its hand offset and nothing else. That is the behaviour curves have always
   * had; stating it here keeps every drawn thing going through one function.
   */
  const placementOf = (rowId: RowId): Placement => {
    const own = assembly.placements.get(rowId);
    if (own) return own;
    // A point or a curve has no mesh and so no resolved placement of its own; written inside a
    // space, what it takes is the space's, rotation included.
    const root = holder(rowId);
    if (root !== rowId) {
      const shared = assembly.placements.get(root);
      if (shared) return shared;
    }
    return { rotation: QUAT_IDENTITY, translation: offsetOf(rowId) };
  };

  for (const entry of compiledSurfaces) {
    const placement = assembly.placements.get(entry.item.rowId) ?? IDENTITY_PLACEMENT;
    entry.placement = placement;
    if (entry.mesh) placeMesh(entry.mesh, placement);
  }
  for (const [rowId, mesh] of implicitMeshes) {
    placeMesh(mesh, assembly.placements.get(rowId) ?? IDENTITY_PLACEMENT);
  }

  const occupied = occupiedSockets(joints);
  const scenePorts: ScenePort[] = [];
  for (const entry of compiledSurfaces) {
    const rowId = entry.item.rowId;
    for (const port of entry.ports ?? []) {
      scenePorts.push({
        rowId,
        port: transformPort(port, entry.placement ?? IDENTITY_PLACEMENT),
        free: !occupied.has(socketKey({ rowId, boundary: port.boundary })),
      });
    }
  }

  /**
   * The surfaces themselves: patches grouped by what they are joined to.
   *
   * Reported on every patch that is part of a larger whole, because from a single row's card
   * there is otherwise no way to tell that this cylinder is a third of a capped tube. A lone
   * patch says nothing — it is a surface with one chart, and saying so on every row in a document
   * that is not being assembled would be noise.
   */
  const surfaces: SceneSurface[] = groupSurfaces(
    compiledSurfaces.map((entry) => entry.item.rowId),
    joints,
  ).map((surface) => {
    const freeBoundaries = scenePorts.filter(
      (entry) => entry.free && surface.patches.includes(entry.rowId),
    ).length;
    return { ...surface, freeBoundaries, closed: freeBoundaries === 0 };
  });

  for (const surface of surfaces) {
    if (surface.patches.length < 2) continue;
    for (const rowId of surface.patches) {
      reports.push({
        rowId,
        info:
          `${surface.name} · ${surface.patches.length} patches · ` +
          (surface.closed
            ? "closed"
            : `${surface.freeBoundaries} open ` +
              `${surface.freeBoundaries === 1 ? "boundary" : "boundaries"}`),
      });
    }
  }

  // ---- geodesics and lines of curvature ----
  //
  // Placed after tessellation because the lift and the arc length both scale with the surface's
  // own size, which is only known once its mesh exists.
  const sceneExtent = meshes.length > 0 ? extentOfMeshes(meshes) : 1;
  const overlayLift = chartLift(sceneExtent, resolution, liftScale);

  /**
   * The chart grid on each patch, drawn as curves off the mesh rather than painted per fragment.
   *
   * Built HERE, after `placeMesh`, and pushed with **no `rowId`** — the vertices these lines are
   * read from have already been moved, so an owner would apply the object's motion a second time.
   * That is the same reason the port handles carry no owner.
   *
   * Two weights: the four edges of the domain are the surface's border and are drawn heavier than
   * the lines inside it, which is what makes a patch read as a piece of a surface rather than as
   * a hatching. On a shaded face the grid steps back to a hairline; with the face off it is the
   * only thing carrying the shape, so it comes forward.
   */
  const gridLines: LineGroup[] = [];
  for (const entry of compiledSurfaces) {
    const mesh = entry.mesh;
    if (!mesh) continue;
    if (hiddenRow(entry.item.rowId)) continue;
    const overlay = overlays.get(entry.item.rowId);
    if (!(overlay?.grid ?? true)) continue;
    const filled = overlay?.fill ?? true;
    const { interior, border } = surfaceGridLines(mesh, resolution, resolution, overlayLift);
    if (interior.length > 0) {
      gridLines.push({
        polylines: interior,
        style: { widthPx: filled ? 1.0 : 1.3, opacity: filled ? 0.5 : 0.85 },
      });
    }
    if (border.length > 0) {
      gridLines.push({
        polylines: border,
        style: { widthPx: filled ? 1.8 : 2.2, opacity: filled ? 0.75 : 1 },
      });
    }
  }

  /**
   * The same for a level set, where the "grid" is where the ambient coordinates cut it.
   *
   * Built here for the same reason the parametric grid is: the vertices these lines are read from
   * have already been placed, so the group carries no `rowId` and takes no further motion. With
   * the face off, this is what is left — which is the point of being able to turn the face off.
   */
  for (const [rowId, mesh] of implicitMeshes) {
    const overlay = overlays.get(rowId);
    if (!(overlay?.grid ?? true)) continue;
    const filled = overlay?.fill ?? true;
    const { interior, border } = meshSliceLines(mesh, overlayLift);
    if (interior.length > 0) {
      gridLines.push({
        polylines: interior,
        style: { widthPx: filled ? 1.0 : 1.3, opacity: filled ? 0.42 : 0.8 },
      });
    }
    if (border.length > 0) {
      gridLines.push({
        polylines: border,
        style: { widthPx: filled ? 1.8 : 2.2, opacity: filled ? 0.75 : 1 },
      });
    }
  }

  for (const { item, surface, params, poles, mesh: sourceMesh } of compiledSurfaces) {
    const overlay = overlays.get(item.rowId);
    if (!overlay) continue;

    /**
     * The domain the overlay curves may integrate through, widened across coordinate poles.
     *
     * A pole is not an edge of the surface: the sphere's u = 0 collapses to a single point and the
     * parametrization runs straight through it, so a great circle reaching it has left nothing and
     * stopping there is an artifact of the chart. Extending by the interval's own width is exactly
     * enough for one crossing on each side — for the sphere that turns u ∈ [0, π] into [-π, 2π],
     * and since X(u + 2π, v) = X(u, v) a meridian traverses a whole great circle within it.
     *
     * A REGULAR boundary is left alone: a cylinder's rim really is where the surface ends, and a
     * geodesic must stop with it rather than run off into the analytic continuation.
     */
    const bounds = integrationBounds(surface, poles);

    /**
     * Cap the step so density is geometric, not a fixed sample count.
     *
     * `minSamples` alone divides the requested arc length, so a geodesic wrapping a sphere nine
     * times got the same 242 points as one crossing it once and was drawn as a visible polygon.
     * Tying the spacing to the surface's own extent keeps the curve smooth however far it runs.
     */
    const sprayArc = Math.max(sceneExtent * overlay.geodesicLength * overlay.geodesics, 1e-9);
    const maxStepArc = Math.max(
      sceneExtent / SEGMENTS_PER_EXTENT,
      sprayArc / MAX_SPRAY_SEGMENTS,
    );

    if (overlay.gaussMap && sourceMesh) {
      {
        const source = sourceMesh;
        /**
         * Placed to the right of everything drawn so far, at a radius that reads as comparable to
         * the surface rather than dwarfed by it. The true Gauss map has radius 1, so this is a
         * presentation scale — the shape of the image and its area RATIO are what carry meaning,
         * and both are preserved.
         */
        const radius = sceneExtent * 0.55;
        const center = besideMesh(source, radius);
        const image = gaussImage(source, { radius, center });
        meshes.push(image);
        /**
         * And the same grid on the image, which is the whole point of drawing it.
         *
         * The Gauss image is the source mesh with positions and normals exchanged, so it is still
         * a grid of the same shape and the same walk over it traces the *image* of each chart
         * line. Seeing where those lines bunch up is seeing where |K| is large — the picture the
         * area identity states as a number.
         */
        if (overlay.grid ?? true) {
          const grid = surfaceGridLines(image, resolution, resolution, overlayLift);
          if (grid.interior.length > 0) {
            gridLines.push({ polylines: grid.interior, style: { widthPx: 1.0, opacity: 0.5 } });
          }
          if (grid.border.length > 0) {
            gridLines.push({ polylines: grid.border, style: { widthPx: 1.8, opacity: 0.75 } });
          }
        }
        // Reported as a ratio, which is the one number that means something: the image's area over
        // the surface's is the average |K|, and equals it exactly in the limit.
        const imageArea = meshArea(image) / (radius * radius);
        reports.push({
          rowId: item.rowId,
          info: `Gauss image area ${imageArea.toFixed(3)} = ∫|K| dA`,
        });
      }
    }
    const clamp = (value: number, min: number, max: number) =>
      Math.min(max, Math.max(min, value));
    const uMid = overlay.start
      ? clamp(overlay.start[0], surface.u.min, surface.u.max)
      : (surface.u.min + surface.u.max) / 2;
    const vMid = overlay.start
      ? clamp(overlay.start[1], surface.v.min, surface.v.max)
      : (surface.v.min + surface.v.max) / 2;

    try {
      if (overlay.geodesics > 0) {
        const point = makeSurfacePoint();
        const chart = makeChartData();
        surface.at(uMid, vMid, params, point, chart);

        if (point.degenerate) {
          reports.push({
            rowId: item.rowId,
            warning: "no tangent plane at the domain centre, so no geodesics were shot",
          });
        } else {
          const length = sceneExtent * overlay.geodesicLength;
          const polylines: Polyline[] = [];
          const stops = new Map<string, number>();

          for (const direction of sprayDirections(chart.I, overlay.geodesics)) {
            const geodesic = integrateGeodesic(surface, params, [uMid, vMid], direction, length, {
              bounds,
              maxStepArc,
            });
            stops.set(geodesic.stop, (stops.get(geodesic.stop) ?? 0) + 1);
            if (geodesic.chart.length < 2) continue;
            polylines.push(
              liftedPolyline(surface, params, geodesic.chart, overlayLift, GEODESIC_COLOR),
            );
          }
          if (polylines.length > 0) {
            lines.push({ rowId: item.rowId, polylines, style: { widthPx: 2.6 } });
          }
          // Reporting WHY each ray ended is the difference between a picture and a diagnosis.
          reports.push({
            rowId: item.rowId,
            info: `${polylines.length} geodesics · ${[...stops]
              .map(([reason, count]) => `${count} ${reason}`)
              .join(", ")}`,
          });
        }
      }

      /**
       * Aimed geodesics, one per drag.
       *
       * Each carries its own start, so they are integrated independently of the spray's centre
       * and of each other — dragging somewhere else does not disturb the ones already shot.
       */
      const shots = overlay.shots ?? [];
      if (shots.length > 0) {
        const aimed: Polyline[] = [];
        const shotStops = new Map<string, number>();
        for (const shot of shots) {
          const geodesic = integrateGeodesic(
            surface,
            params,
            [shot.start[0], shot.start[1]],
            [shot.direction[0], shot.direction[1]],
            sceneExtent * overlay.geodesicLength,
            { bounds, maxStepArc },
          );
          shotStops.set(geodesic.stop, (shotStops.get(geodesic.stop) ?? 0) + 1);
          if (geodesic.chart.length < 2) continue;
          aimed.push(
            liftedPolyline(
              surface,
              params,
              geodesic.chart,
              overlayLift,
              colorOf(item.rowId, GEODESIC_COLOR),
            ),
          );
        }
        if (aimed.length > 0) lines.push({ rowId: item.rowId, polylines: aimed, style: { widthPx: 3.0 } });
        reports.push({
          rowId: item.rowId,
          info: `${aimed.length} aimed · ${[...shotStops]
            .map(([reason, count]) => `${count} ${reason}`)
            .join(", ")}`,
        });
      }

      if (overlay.curvatureLines) {
        const point = makeSurfacePoint();
        surface.at(uMid, vMid, params, point);
        if (point.degenerate) {
          // Checked before `umbilic`, because a degenerate point is not umbilic — the flags are
          // cleared there — so testing only for umbilic left this case drawing nothing at all
          // and saying nothing either.
          reports.push({
            rowId: item.rowId,
            warning: "no tangent plane at the domain centre, so no lines of curvature",
          });
        } else if (point.umbilic) {
          reports.push({
            rowId: item.rowId,
            warning: point.planar
              ? "planar point at the centre: every direction is principal"
              : "umbilic point at the centre: the principal directions are arbitrary here",
          });
        } else {
          const polylines: Polyline[] = [];
          for (const which of [1, 2] as const) {
            const colour = which === 1 ? CURVATURE_LINE_1 : CURVATURE_LINE_2;
            // Both ways from the centre, so the curve is not a one-sided half.
            for (const sign of [1, -1] as const) {
              const run = integrateCurvatureLine(
                surface,
                params,
                [uMid, vMid],
                which,
                sign * sceneExtent * 1.2,
                { bounds },
              );
              if (run.chart.length < 2) continue;
              polylines.push(
                liftedPolyline(surface, params, run.chart, overlayLift, colour),
              );
            }
          }
          if (polylines.length > 0) lines.push({ rowId: item.rowId, polylines, style: { widthPx: 3 } });
        }
      }
    } catch (thrown) {
      reports.push({ rowId: item.rowId, error: messageOf(thrown) });
    }
  }

  // Curves.
  for (const item of items) {
    if (item.kind !== "spaceCurve" && item.kind !== "planeCurve") continue;
    // Chart curves take the push-forward path below instead.
    if (item.kind === "planeCurve" && inChart.has(item.rowId)) continue;
    if (hiddenRow(item.rowId)) continue;
    try {
      // A plane curve is drawn in the z = 0 plane. Its signed curvature remains a
      // separate quantity computed from the genuine two-component map — see curve.ts on
      // why the 3D kappa is not a substitute.
      const comps = [...item.comps];
      if (item.kind === "planeCurve") comps.push(ctx.zero);
      const paramNames = [...item.params];
      const map = cachedDiffMap({
        id: `row-${item.rowId}`,
        comps,
        vars: [item.vars[0] ?? "t"],
        params: paramNames,
        order: 3,
      });
      const range = domains.get(item.rowId)?.[0];
      const curve = createSpaceCurve({
        id: `row-${item.rowId}`,
        map,
        t: interval(
          range?.min ?? DEFAULT_DOMAIN["t"]![0],
          range?.max ?? DEFAULT_DOMAIN["t"]![1],
        ),
      });
      const params = packParameters(paramNames, parameters, declared);
      const frames = bishopFrames(curve, params, CURVE_SAMPLES);

      const polyline: Polyline = {
        points: frames.points,
        count: frames.count,
        valid: frames.valid,
        arcLength: frames.arcLength,
        color: colorOf(item.rowId, CURVE_PALETTE[curveIndex % CURVE_PALETTE.length]!),
      };
      lines.push({ rowId: item.rowId, polylines: [polyline], style: { widthPx: 3.5 } });
      curveIndex++;

      // The moving frame, if this row asked for one. Its position along the domain is
      // where kappa and tau are reported too, so the readout follows the glyphs.
      const wanted = frameRequests.get(item.rowId);
      const at = wanted?.show ? Math.min(Math.max(wanted.at, 0), 1) : 0.5;
      const t = curve.t.min + (curve.t.max - curve.t.min) * at;

      const frame = makeFrenetFrame();
      curve.frenet(t, params, frame);

      if (wanted?.show) {
        // Glyph length tracks the curve's own extent, so the frame stays legible whether
        // the curve is a unit circle or a hundred units across.
        const extent = extentOf(frames);
        const glyphLength = Math.max(extent * 0.22, 1e-3);
        const glyphs: Polyline[] = [];
        // T exists wherever the parametrization is regular.
        if (frame.status !== "singular") {
          glyphs.push(arrow(frame.p, frame.T, glyphLength, T_COLOR));
        }
        // N and B exist only where the osculating plane does. Refusing to draw them at an
        // inflection is the whole point of tracking `status`.
        if (frame.status === "regular") {
          glyphs.push(arrow(frame.p, frame.N, glyphLength, N_COLOR));
          glyphs.push(arrow(frame.p, frame.B, glyphLength, B_COLOR));
        }
        if (glyphs.length > 0) {
          lines.push({ rowId: item.rowId, polylines: glyphs, style: { widthPx: 5 } });
        }
      }

      reports.push({
        rowId: item.rowId,
        info:
          frame.status === "regular"
            ? `t = ${t.toFixed(3)}   κ = ${frame.kappa.toFixed(3)}` +
              (frame.tauValid ? `   τ = ${frame.tau.toFixed(3)}` : "   τ undefined")
            : frame.status === "inflection"
              ? `t = ${t.toFixed(3)}   κ = 0 — N and B undefined here`
              : `t = ${t.toFixed(3)}   singular parametrization here`,
      });
    } catch (thrown) {
      reports.push({ rowId: item.rowId, error: messageOf(thrown) });
    }
  }

  /**
   * A level set drawn **flat**: `{ (x, y) : F(x, y, 0) = 0 }`, in the z = 0 plane.
   *
   * `x² + y² = 1` is the cylinder, and its section is the circle — two different objects, and only
   * the reader knows which was meant. So the surface is the default and this is the row's own
   * choice, through the same marching squares the chart relations use: the level set of a relation
   * is the level set of a relation, and the only difference is where the segments are put.
   */
  for (const item of items) {
    if (item.kind !== "implicitSurface") continue;
    if (!overlays.get(item.rowId)?.inPlane) continue;
    if (hiddenRow(item.rowId)) continue;
    try {
      const paramNames = [...item.params];
      // z is bound to 0: the flat reading is the surface's section by the plane it is drawn in.
      const compiled = compileMany([...item.comps], { vars: ["x", "y", "z"], params: paramNames });
      const values = packParameters(paramNames, parameters, declared);
      const out = new Float64Array(item.comps.length);
      const argument = new Float64Array(3);

      const [xRange, yRange] = implicitRanges(item, domains);
      const contour = marchingSquares(
        (x, y) => {
          argument[0] = x;
          argument[1] = y;
          compiled.evaluate(argument, values, out);
          return (out[0] ?? Number.NaN) - (out[1] ?? 0);
        },
        { u: [xRange.min, xRange.max], v: [yRange.min, yRange.max] },
        { resU: Math.max(resolution, 120), resV: Math.max(resolution, 120) },
      );

      const color = colorOf(item.rowId, CURVE_PALETTE[curveIndex % CURVE_PALETTE.length]!);
      curveIndex++;
      const polylines: Polyline[] = [];
      for (let i = 0; i < contour.segmentCount; i++) {
        polylines.push({
          points: new Float64Array([
            contour.segments[i * 4]!,
            contour.segments[i * 4 + 1]!,
            0,
            contour.segments[i * 4 + 2]!,
            contour.segments[i * 4 + 3]!,
            0,
          ]),
          count: 2,
          color,
        });
      }
      if (polylines.length > 0) {
        lines.push({ rowId: item.rowId, polylines, style: { widthPx: 3 } });
      }
      reports.push({
        rowId: item.rowId,
        info:
          contour.segmentCount === 0
            ? "no solutions in this window"
            : `${contour.segmentCount} contour segments`,
        warning:
          contour.invalidSamples > 0
            ? `${contour.invalidSamples} samples were not finite`
            : undefined,
      });
    } catch (thrown) {
      reports.push({ rowId: item.rowId, error: messageOf(thrown) });
    }
  }

  // ---- the chart view ----
  //
  // Two different questions, deliberately answered by two different patches. `primary` is where a
  // row that names no chart is drawn — the first surface, a stated convention that only has to
  // hold still. `shown` is whose chart the INSET displays, and that follows the selection: click a
  // surface and the corner shows its (u, v) plane, with the curves stated in it. Tying the
  // fallback to the selection instead would move every unprefixed curve to another surface the
  // moment you clicked one, which is a document that changes meaning when you look at it.
  const primary = compiledSurfaces[0] ?? null;
  const wanted =
    request.chartRow === undefined || request.chartRow === null
      ? undefined
      : compiledSurfaces.find((entry) => entry.item.rowId === request.chartRow);
  const shown = wanted ?? primary;
  const chartBounds: ChartBounds | null = shown
    ? {
        u: [shown.surface.u.min, shown.surface.u.max],
        v: [shown.surface.v.min, shown.surface.v.max],
      }
    : null;

  /**
   * What each field row needs to be played, kept from the pass that drew its arrows.
   *
   * The compiled program and the host are exactly what a flow integrates with, and both were
   * built once already — so playing costs a jet buffer rather than a recompile.
   */
  const playable = new Map<
    RowId,
    {
      host: (typeof compiledSurfaces)[number];
      field: (u: number, v: number, out: Vec3) => void;
      /** whether the inset is showing this field's patch, and so can draw its flow flat */
      shown: boolean;
      timeScale: number;
      color: Vec3;
    }
  >();

  const fieldArrows = new Map<RowId, LineGroup>();
  const fieldChartArrows = new Map<RowId, LineGroup>();
  const chartLines: LineGroup[] = chartBounds ? [...chartGrid(chartBounds)] : [];
  const chartCurves: Polyline[] = [];
  /** The parts of those curves that lie outside the domain: chart only, never on the surface. */
  const chartBeyond: Polyline[] = [];
  /**
   * Single points marked in the chart — where each tangent plane is attached.
   *
   * Their own group, drawn as discs: a zero-length segment with round caps is a dot, the same way
   * a `point` row is drawn in space. Kept apart from the curves because they take a width of
   * their own, and a dot at the width of a stroke is invisible.
   */
  const chartMarks: Polyline[] = [];
  /**
   * The patch a chart row is stated in, and everything that follows from it.
   *
   * Named by the row itself, with an `X:` prefix — nothing in a relation between u and v can say
   * whose u and v those are, and with several patches on screen the first one is a bad guess. A
   * row that names nobody falls back to the first surface, which is what a document with one
   * patch means and always meant.
   *
   * The host owns the domain the curve is sampled over, the parameters X is evaluated with, and
   * the placement its image takes — a curve pushed onto a surface moves with the SURFACE, not
   * with the row that defined it, since it is built by evaluating X and X knows nothing about
   * arrangement. Owning it by the curve's row left the image of a moved surface's curve floating
   * in space where the formula alone would have put it.
   */
  type CompiledSurface = (typeof compiledSurfaces)[number];
  const hostOf = (item: Item): CompiledSurface | null => {
    if (!item.host) return primary;
    const found = compiledSurfaces.find((entry) => entry.item.name === item.host);
    if (!found) {
      reports.push({
        rowId: item.rowId,
        warning: `there is no patch called ${item.host}, so this is drawn on ${
          primary?.item.name ?? "the first surface"
        }`,
      });
    }
    return found ?? primary;
  };
  const boundsOf = (host: CompiledSurface): ChartBounds => ({
    u: [host.surface.u.min, host.surface.u.max],
    v: [host.surface.v.min, host.surface.v.max],
  });
  let chartColorIndex = 0;

  if (chartBounds && shown && primary) {
    // The lift needs the scene's size, which is only known once the meshes exist.
    const provisional = meshes.length > 0 ? extentOfMeshes(meshes) : 1;
    const lift = chartLift(provisional, resolution, liftScale);

    // Graphs v = f(u) and relations F(u,v) = 0 are chart objects by construction — no toggle
    // needed, because there is nothing else they could mean.
    for (const item of items) {
      if (item.kind !== "chartGraph") continue;
      if (hiddenRow(item.rowId)) continue;
      try {
        const host: CompiledSurface = hostOf(item) ?? primary;
        const paramNames = [...item.params];
        const result = sampleChartGraph(
          {
            rowId: item.rowId,
            body: item.comps[0]!,
            params: paramNames,
            variable: (item.vars[0] === "v" ? "v" : "u") as "u" | "v",
            colorIndex: chartColorIndex++,
            color: rowColors.get(item.rowId),
          },
          boundsOf(host),
          host.surface,
          packParameters(paramNames, parameters, declared),
          host.params,
          lift,
        );
        // Only the chart being SHOWN gets its curves in the inset: two patches have two different
        // (u, v) planes, and drawing both in one square would be a picture of neither.
        // The palette decided this one, so the swatch is told what it decided.
        usedColors.set(item.rowId, [...result.chart.color] as Vec3);
        if (host === shown) {
          chartCurves.push(result.chart);
          if (result.chartBeyond) chartBeyond.push(result.chartBeyond);
        }
        if (result.surface) {
          lines.push({
            rowId: host.item.rowId,
            polylines: [result.surface],
            style: { widthPx: 4 },
          });
        }
        reports.push({
          rowId: item.rowId,
          info:
            item.vars[0] === "v"
              ? `u = ${item.name ?? "f"}(v) in the chart`
              : `v = ${item.name ?? "f"}(u) in the chart`,
          warning:
            result.outsideFraction > 0.02
              ? `${Math.round(result.outsideFraction * 100)}% of the graph leaves the domain`
              : undefined,
        });
      } catch (thrown) {
        reports.push({ rowId: item.rowId, error: messageOf(thrown) });
      }
    }

    for (const item of items) {
      if (item.kind !== "chartRelation") continue;
      if (hiddenRow(item.rowId)) continue;
      try {
        const host: CompiledSurface = hostOf(item) ?? primary;
        const paramNames = [...item.params];
        const result = sampleChartRelation(
          {
            rowId: item.rowId,
            comps: item.comps,
            params: paramNames,
            colorIndex: chartColorIndex++,
            color: rowColors.get(item.rowId),
          },
          boundsOf(host),
          host.surface,
          packParameters(paramNames, parameters, declared),
          host.params,
          lift,
          Math.max(resolution, 120),
        );
        const drawn = result.chart[0]?.color ?? result.surface[0]?.color;
        if (drawn) usedColors.set(item.rowId, [...drawn] as Vec3);
        if (host === shown) chartCurves.push(...result.chart);
        if (result.surface.length > 0) {
          lines.push({
            rowId: host.item.rowId,
            polylines: result.surface,
            style: { widthPx: 4 },
          });
        }
        reports.push({
          rowId: item.rowId,
          info:
            result.segmentCount === 0
              ? "no solutions in this domain"
              : `${result.segmentCount} contour segments`,
        });
      } catch (thrown) {
        reports.push({ rowId: item.rowId, error: messageOf(thrown) });
      }
    }

    for (const item of items) {
      if (item.kind !== "planeCurve" || !inChart.has(item.rowId)) continue;
      if (hiddenRow(item.rowId)) continue;
      try {
        const host: CompiledSurface = hostOf(item) ?? primary;
        const range = domains.get(item.rowId)?.[0] ?? {
          min: DEFAULT_DOMAIN["t"]![0],
          max: DEFAULT_DOMAIN["t"]![1],
        };
        const paramNames = [...item.params];
        const result = pushForward(
          {
            rowId: item.rowId,
            comps: item.comps,
            params: paramNames,
            variable: item.vars[0] ?? "t",
            range,
            colorIndex: chartColorIndex++,
            color: rowColors.get(item.rowId),
          },
          host.surface,
          packParameters(paramNames, parameters, declared),
          host.params,
          lift,
        );

        usedColors.set(item.rowId, [...result.chart.color] as Vec3);
        if (host === shown) {
          chartCurves.push(result.chart);
          if (result.chartBeyond) chartBeyond.push(result.chartBeyond);
        }
        if (result.surface) {
          lines.push({
            rowId: host.item.rowId,
            polylines: [result.surface],
            style: { widthPx: 4 },
          });
        }

        reports.push({
          rowId: item.rowId,
          info: `in the chart of ${host.item.name ?? "the first surface"}`,
          warning:
            result.outsideFraction > 0.02
              ? `${Math.round(result.outsideFraction * 100)}% of this curve lies outside the domain`
              : undefined,
        });
      } catch (thrown) {
        reports.push({ rowId: item.rowId, error: messageOf(thrown) });
      }
    }

    /**
     * ---- vector fields along a patch ----
     *
     * `X: VectorField(a, b, c)` — three **ambient** components, as functions of X's own u and v.
     * Ambient because that is how a field is written when it is the restriction of something
     * defined on all of space: a rotation, a gradient, a constant wind. Whether the result is
     * tangent to the surface is then a question with an answer, measured here as |⟨V,N⟩|/|V| and
     * reported, rather than a property the notation quietly assumes.
     */
    for (const item of items) {
      if (item.kind !== "surfaceField") continue;
      if (hiddenRow(item.rowId)) continue;
      try {
        const host: CompiledSurface = hostOf(item) ?? primary;
        const paramNames = [...item.params];
        const compiled = compileMany([...item.comps], {
          vars: ["u", "v"],
          params: paramNames,
        });
        const values = packParameters(paramNames, parameters, declared);

        const [uLo, uHi] = sampleBounds(host.surface.u);
        const [vLo, vHi] = sampleBounds(host.surface.v);
        const point = makeSurfacePoint();
        const argument = new Float64Array(2);
        const out = new Float64Array(3);

        /**
         * The field as a function, defined once and used three times: by the tangency check
         * below, by the chart arrows, and by the flow when the row is played.
         */
        const scratch = new Float64Array(3);
        const field = (u: number, v: number, target: Vec3) => {
          argument[0] = u;
          argument[1] = v;
          compiled.evaluate(argument, values, scratch);
          target[0] = scratch[0]!;
          target[1] = scratch[1]!;
          target[2] = scratch[2]!;
        };

        const bases: Vec3[] = [];
        const normals: Vec3[] = [];
        const directions: Vec3[] = [];
        const lengths: number[] = [];
        let leaning = 0;
        let skipped = 0;

        /**
         * The same field, read downstairs.
         *
         * A field written in ambient components has a chart representation — the (u̇, v̇) solving
         * `[E F; F G](u̇, v̇)ᵀ = (⟨V,X_u⟩, ⟨V,X_v⟩)ᵀ` — and that is what an arrow in the inset
         * means: components in the basis {∂/∂u, ∂/∂v}. It is taken from `createFlow` rather than
         * written again here, so the arrows in the chart and the flow that runs along them cannot
         * disagree about which way the field points.
         */
        const inChartOf = host === shown ? createFlow(host.surface, host.params, field) : null;
        const chartAt: Array<[number, number]> = [];
        const chartVectors: Array<[number, number]> = [];
        const chartLengths: number[] = [];
        const uSpan = uHi - uLo || 1;
        const vSpan = vHi - vLo || 1;
        const velocity: [number, number] = [0, 0];

        for (let i = 0; i < FIELD_DIVISIONS; i++) {
          // Cell centres: an arrow planted on the border is an arrow at a pole.
          const u = uLo + ((uHi - uLo) * (i + 0.5)) / FIELD_DIVISIONS;
          for (let j = 0; j < FIELD_DIVISIONS; j++) {
            const v = vLo + ((vHi - vLo) * (j + 0.5)) / FIELD_DIVISIONS;
            host.surface.at(u, v, host.params, point);
            if (point.degenerate) {
              skipped++;
              continue;
            }
            argument[0] = u;
            argument[1] = v;
            compiled.evaluate(argument, values, out);
            const [x = Number.NaN, y = Number.NaN, z = Number.NaN] = out;
            const length = Math.hypot(x, y, z);
            if (!Number.isFinite(length) || length === 0) {
              // A zero vector has no direction to draw, and a non-finite one is the non-finite
              // contract: dropped here rather than sent to a buffer as a smear.
              skipped++;
              continue;
            }
            bases.push([
              point.p[0] + point.N[0] * lift,
              point.p[1] + point.N[1] * lift,
              point.p[2] + point.N[2] * lift,
            ]);
            normals.push([point.N[0], point.N[1], point.N[2]]);
            directions.push([x / length, y / length, z / length]);
            lengths.push(length);
            const off = Math.abs(x * point.N[0] + y * point.N[1] + z * point.N[2]) / length;
            if (off > leaning) leaning = off;

            if (inChartOf && inChartOf.velocity(u, v, velocity)) {
              chartAt.push([u, v]);
              chartVectors.push([velocity[0], velocity[1]]);
              /**
               * Measured in the units the inset is DRAWN in, not in chart units.
               *
               * The domain is stretched to fill the box, so u and v are not to the same scale on
               * screen: an arrow scaled by |(u̇, v̇)| would come out long in whichever direction
               * happens to have the narrower range. Dividing by the spans first makes "how long
               * does this look" the thing being levelled, which is what the eye is comparing.
               */
              chartLengths.push(Math.hypot(velocity[0] / uSpan, velocity[1] / vSpan));
            }
          }
        }

        if (bases.length === 0) {
          reports.push({
            rowId: item.rowId,
            warning: `nothing to draw: this field is zero or undefined all over ${
              host.item.name ?? "the surface"
            }`,
          });
          continue;
        }

        /**
         * One scale for the whole field, from a **robust quantile** rather than the maximum.
         *
         * A field is a picture of magnitudes as well as directions, so the arrows share a scale
         * and their relative lengths mean something. Scaling by the largest vector lets one
         * sample near a chart singularity — where |V| can be 10¹² — shrink every other arrow to
         * a dot, which is the same failure `robustScale` exists to prevent for colour. Past the
         * 98th percentile the arrows saturate instead, at twice the grid spacing, so an outlier
         * is visibly long without shooting across the scene.
         */
        const hostExtent = host.mesh ? extentOfMeshes([host.mesh]) : sceneExtent;
        const spacing = (2 * hostExtent) / FIELD_DIVISIONS;
        const scale = robustScale(lengths, 1);
        const color = colorOf(item.rowId, FIELD_COLOR);
        const arrows: Polyline[] = [];
        for (let k = 0; k < bases.length; k++) {
          const drawn = Math.min((spacing * 0.85 * lengths[k]!) / scale, spacing * 2);
          arrows.push(fieldArrow(bases[k]!, directions[k]!, normals[k]!, drawn, color));
        }
        const arrowGroup: LineGroup = {
          rowId: host.item.rowId,
          polylines: arrows,
          style: { widthPx: 2.4 },
        };
        lines.push(arrowGroup);
        // Kept by identity as well, so a frame can leave them out — see `Scene.fieldArrows`.
        fieldArrows.set(item.rowId, arrowGroup);

        /**
         * And the same arrows in the inset, in the chart's own coordinates.
         *
         * Drawn only for the patch the inset is showing — two patches have two different (u, v)
         * planes, and drawing both in one square would be a picture of neither, which is the rule
         * every chart curve already follows.
         */
        if (chartAt.length > 0) {
          const chartScale = robustScale(chartLengths, 1);
          const reach = 0.85 / FIELD_DIVISIONS;
          const chartArrows: Polyline[] = [];
          for (let k = 0; k < chartAt.length; k++) {
            const [u, v] = chartAt[k]!;
            const [du, dv] = chartVectors[k]!;
            const scaled = Math.min(chartLengths[k]! / chartScale, 2) * reach;
            if (!(scaled > 0)) continue;
            // Direction in the units the inset is drawn in, so the head sits square on the shaft.
            const nu = du / uSpan;
            const nv = dv / vSpan;
            const norm = Math.hypot(nu, nv);
            if (!(norm > 0)) continue;
            const dirU = nu / norm;
            const dirV = nv / norm;
            const tipU = u + dirU * scaled * uSpan;
            const tipV = v + dirV * scaled * vSpan;
            const head = scaled * 0.3;
            const barb = (sign: number): Vec3 => [
              tipU + (-dirU * head + sign * -dirV * head * 0.55) * uSpan,
              tipV + (-dirV * head + sign * dirU * head * 0.55) * vSpan,
              0,
            ];
            chartArrows.push(
              polylineOf(
                [[u, v, 0], [tipU, tipV, 0], barb(1), [tipU, tipV, 0], barb(-1)],
                color,
              ),
            );
          }
          if (chartArrows.length > 0) {
            const group: LineGroup = { polylines: chartArrows, style: { widthPx: 1.6 } };
            chartLines.push(group);
            fieldChartArrows.set(item.rowId, group);
          }
        }

        /**
         * The same field, kept so it can be *played*.
         *
         * The tempo is set here rather than in the integrator because it is the one quantity that
         * depends on how big the object is rather than on the field: a typical particle — the one
         * moving at the robust scale, not the fastest — should cross the patch in a few seconds,
         * whether the patch is a unit sphere or a torus ten across.
         */
        playable.set(item.rowId, {
          host,
          field,
          shown: host === shown,
          timeScale: (2 * hostExtent) / (scale * FLOW_CROSSING_SECONDS),
          color,
        });

        const mean = lengths.reduce((sum, value) => sum + value, 0) / lengths.length;
        reports.push({
          rowId: item.rowId,
          info:
            `${arrows.length} arrows on ${host.item.name ?? "the first surface"} · ` +
            `mean |V| = ${mean.toPrecision(3)}`,
          /**
           * The tangency check, which is the whole reason ambient components need one.
           *
           * `(0, 0, 1)` is a perfectly good field on R³ and a perfectly bad one on a sphere: it
           * is drawn, because seeing it lean off the surface is how the failure is understood,
           * and it is named, because a field that is not tangent is not a field ON the surface —
           * nothing intrinsic can be read off it, and the arrows would silently mean something
           * else.
           */
          warning:
            leaning > FIELD_TANGENT_EPS
              ? `not tangent to ${host.item.name ?? "the surface"} — up to ` +
                `${((Math.asin(Math.min(leaning, 1)) * 180) / Math.PI).toFixed(1)}° off the ` +
                `tangent plane`
              : skipped > 0
                ? `${skipped} of ${skipped + arrows.length} arrows dropped — the field is ` +
                  `undefined or zero there`
                : undefined,
        });
      } catch (thrown) {
        reports.push({ rowId: item.rowId, error: messageOf(thrown) });
      }
    }

    /**
     * ---- tangent planes ----
     *
     * `T_(u₀, v₀) X` attaches the plane at a point named in **X's chart**, which is the only place
     * it can be named without solving anything: a point of R³ is on the surface or it is not, and
     * asking which (u, v) it came from is inverting X. Downstairs the question does not arise, and
     * the same two numbers also say where to mark the inset.
     */
    for (const item of items) {
      if (item.kind !== "tangentPlane") continue;
      if (hiddenRow(item.rowId)) continue;
      try {
        const host: CompiledSurface = hostOf(item) ?? primary;
        const paramNames = [...item.params];
        const values = packParameters(paramNames, parameters, declared);
        const coordinates = item.comps.map((comp) =>
          compileScalar(comp, { vars: [], params: paramNames }).call([], values),
        );
        const u = coordinates[0] ?? Number.NaN;
        const v = coordinates[1] ?? Number.NaN;
        if (!Number.isFinite(u) || !Number.isFinite(v)) {
          reports.push({ rowId: item.rowId, error: "this tangent point is not a finite (u, v)" });
          continue;
        }

        const point = makeSurfacePoint();
        const chart = makeChartData();
        host.surface.at(u, v, host.params, point, chart);

        const where = `(${u.toFixed(3)}, ${v.toFixed(3)})`;
        if (point.degenerate) {
          /**
           * A pole, a cone point, or a formula that blew up. Reported rather than drawn: the
           * tangent plane genuinely does not exist there, and a plausible square through the
           * point would be a picture of something that is not true.
           */
          reports.push({
            rowId: item.rowId,
            warning: `no tangent plane at ${where} — the chart is singular there`,
          });
          continue;
        }

        // Sized by the patch it belongs to, not by the scene: a tangent plane to a small sphere
        // beside a large one has to look like it belongs to the small one.
        const hostExtent = host.mesh ? extentOfMeshes([host.mesh]) : sceneExtent;
        const figure = tangentPlaneFigure(
          point.p,
          point.N,
          chart.Xu,
          chart.Xv,
          hostExtent * TANGENT_SIZE,
          lift,
          colorOf(item.rowId, TANGENT_PLANE_COLOR),
        );
        if (!figure) {
          reports.push({ rowId: item.rowId, warning: `no tangent plane at ${where}` });
          continue;
        }

        /**
         * Owned by the HOST's row, like every other thing built by evaluating X.
         *
         * The plane is read off the surface's own derivatives, which know nothing of arrangement,
         * so it takes the surface's placement. Owned by the tangent row instead, moving the
         * surface would leave its tangent plane behind at the origin.
         */
        lines.push({
          rowId: host.item.rowId,
          polylines: figure.interior,
          style: { widthPx: 1.1, opacity: 0.45 },
        });
        lines.push({
          rowId: host.item.rowId,
          polylines: figure.border,
          style: { widthPx: 2.2, opacity: 0.9 },
        });
        lines.push({
          rowId: host.item.rowId,
          polylines: figure.frame,
          style: { widthPx: 4.5 },
        });

        // The same point marked downstairs, so the inset says where in the domain this is.
        if (host === shown) {
          chartMarks.push({
            points: new Float64Array([u, v, 0, u, v, 0]),
            count: 2,
            color: colorOf(item.rowId, TANGENT_PLANE_COLOR),
          });
        }

        const E = chart.I[0][0];
        const F = chart.I[0][1];
        const G = chart.I[1][1];
        /**
         * Outside the domain the plane is still perfectly well defined — X is — but it is tangent
         * to surface that is not being drawn, so it hangs in space beside the patch. Said in
         * words rather than refused, for the same reason a chart curve that leaves the domain is
         * drawn dashed instead of cropped: the domain is a choice, not the edge of the world.
         */
        const outside =
          u < host.surface.u.min ||
          u > host.surface.u.max ||
          v < host.surface.v.min ||
          v > host.surface.v.max;
        reports.push({
          rowId: item.rowId,
          info:
            `T_p${host.item.name ?? ""} at ${where} · ` +
            `K = ${point.K.toFixed(3)}   H = ${point.H.toFixed(3)}`,
          warning: outside ? `${where} is outside the domain of ${host.item.name ?? "it"}` : undefined,
        });
        // The first fundamental form is what the tangent plane carries, so it is what the row
        // says: E and G are the squared lengths of the two arrows drawn, F the angle between them.
        reports.push({
          rowId: item.rowId,
          info: `E = ${E.toFixed(3)}   F = ${F.toFixed(3)}   G = ${G.toFixed(3)}`,
        });
      } catch (thrown) {
        reports.push({ rowId: item.rowId, error: messageOf(thrown) });
      }
    }
  }

  if (chartCurves.length > 0) {
    chartLines.push({ polylines: chartCurves, style: { widthPx: 2.5 } });
  }
  if (chartMarks.length > 0) {
    chartLines.push({ polylines: chartMarks, style: { widthPx: 9 } });
  }
  /**
   * Off the domain: same colour, dashed and faint.
   *
   * The curve is still perfectly well defined there — it is the *surface* that is not — so the
   * chart shows it and the difference is carried by the stroke rather than by cropping. Dashed
   * rather than merely dimmed, because a fainter solid line reads as "further away" and this is
   * not a depth cue.
   */
  if (chartBeyond.length > 0) {
    chartLines.push({
      polylines: chartBeyond,
      style: { widthPx: 2, opacity: 0.55, dashPeriod: chartDash(chartBounds), dashDuty: 0.5 },
    });
  }

  /**
   * What the inset frames: the domain, widened to hold whatever was drawn in it.
   *
   * The domain rectangle is a choice, not the extent of the plane, and a curve that leaves it
   * used to be cropped at the border — so the chart always looked exactly as big as the surface
   * and there was nowhere to see where the curve had gone. Widening is capped, or one sample at
   * v = 10⁶ would shrink the domain to a dot.
   */
  const chartView = chartBounds
    ? widenToFit(chartBounds, [...chartCurves, ...chartBeyond, ...chartMarks])
    : null;

  // Points come free from the lines pass: a zero-length segment with round caps renders
  // as a disc, so no separate billboard pass is needed for them.
  for (const item of items) {
    if (item.kind !== "point") continue;
    if (hiddenRow(item.rowId)) continue;
    try {
      const coords = item.comps.map((comp) => {
        const compiled = compileScalar(comp, { vars: [], params: [...item.params] });
        return compiled.call([], packParameters([...item.params], parameters, declared));
      });
      const position: Vec3 = [coords[0] ?? 0, coords[1] ?? 0, coords[2] ?? 0];
      if (!position.every((value) => Number.isFinite(value))) {
        reports.push({ rowId: item.rowId, error: "this point is not finite" });
        continue;
      }
      /**
       * One group per point, carrying its row — not one pooled group for all of them.
       *
       * Pooled, the group has no owner, and the pass that applies arrangement skips exactly the
       * groups with no owner. A point written in a torus's ambient space would then stay behind
       * when the torus was dragged, which is the one thing a point beside an object must never
       * do: it is at (1, 2, 3) *of that space*, and the sentence has to survive the space moving.
       */
      lines.push({
        polylines: [{
          points: new Float64Array([...position, ...position]),
          count: 2,
          color: colorOf(item.rowId, POINT_COLOR),
        }],
        style: { widthPx: 11 },
        rowId: item.rowId,
      });
      reports.push({
        rowId: item.rowId,
        info: `(${position.map((v) => v.toFixed(3)).join(", ")})`,
      });
    } catch (thrown) {
      reports.push({ rowId: item.rowId, error: messageOf(thrown) });
    }
  }

  /**
   * Curves are shifted at the end, in one pass over the finished groups.
   *
   * Doing it here rather than at each construction site means every polyline a row produces —
   * its own curve, its geodesics, its lines of curvature, its frame glyphs, its chart curve
   * pushed onto a surface — moves with the object automatically, and a new kind of curve added
   * later cannot forget to.
   */
  for (const group of lines) {
    if (group.rowId === undefined) continue;
    /**
     * Curves are built from the untouched parametrization, so they take **exactly** the placement
     * their surface took — the same affine map, not a reconstruction of it. A curve row that owns
     * no surface has only its hand offset, since there is no mesh to have turned about.
     */
    const placement = placementOf(group.rowId);
    for (const polyline of group.polylines) placePolyline(polyline, placement);
  }

  /**
   * The free boundaries, drawn as handles.
   *
   * Added **after** the pass above, and with no `rowId`, because they are already in world
   * coordinates — they were measured from ports that had been placed. Giving them an owner would
   * apply their object's motion a second time.
   *
   * Each is its boundary curve exactly, plus a short stub along the axis so which way the port
   * faces is visible: two rims can look alike and join in opposite directions.
   */
  const freeHandles: Polyline[] = [];
  const activeHandles: Polyline[] = [];
  for (const entry of request.showPorts ? scenePorts : []) {
    if (!entry.free) continue;
    const active = sameSocket(request.activeSocket ?? null, {
      rowId: entry.rowId,
      boundary: entry.port.boundary,
    });
    const target = active ? activeHandles : freeHandles;
    const color = active ? SOCKET_ACTIVE_COLOR : SOCKET_COLOR;
    target.push(polylineOf(portOutline(entry.port), color));
    target.push(arrow(entry.port.origin, entry.port.axis, entry.port.size * 0.55, color));
  }
  if (freeHandles.length > 0) lines.push({ polylines: freeHandles, style: { widthPx: 2.2 } });
  if (activeHandles.length > 0) lines.push({ polylines: activeHandles, style: { widthPx: 4.5 } });

  // Per row, so a readout or a legend can say which scale a given object is painted through.
  const curvatureScales = new Map<RowId, number>();
  for (const entry of compiledSurfaces) {
    if (entry.curvature) curvatureScales.set(entry.item.rowId, entry.curvature.scale);
  }
  // A level set's scale comes from its own mesh: there is no domain to sample independently of
  // it, since the surface is wherever F vanishes.
  for (const [rowId, mesh] of implicitMeshes) curvatureScales.set(rowId, mesh.range.scale);

  const mesh = meshes.length === 0 ? null : concatenate(meshes);
  /**
   * The bounds are taken **before** the axes are added, and that ordering is the whole point.
   *
   * The camera frames these bounds, so axes long enough to hold the scene would be what it framed
   * — every object shown at the scale of its own scaffolding, shrinking into the middle of a
   * cross. Framing the object and letting the axes run off the edges is what every 3D graphing
   * tool does, and it is why this line sits here rather than at the end.
   */
  const bounds = computeBounds(mesh, lines);

  /**
   * The coordinate axes: ticked near the object, and running off to the horizon past it.
   *
   * Three lines through the origin, each in its own colour, with a tick every round unit — the
   * convention every 3D graphing tool uses, and the one thing that turns "a shape floating in
   * space" into "a shape at these coordinates".
   *
   * They do not stop. An axis that ended a little past the object would put a visible edge on
   * space itself, and zooming out would show three short sticks rather than a coordinate system,
   * so past the ticked stretch each axis continues in **geometrically growing** steps out to a
   * distance nothing will be looking from. Growing rather than uniform because the cost of
   * uniform is unbounded: a tick every unit out to a million units is a million segments, while
   * doubling gets there in twenty and looks identical, every one of them off screen.
   *
   * The line is built as a **chain** rather than as one enormous segment. The lines pass turns
   * each pair of points into a screen-space quad, and a single segment spanning the camera would
   * have one endpoint behind the eye — where the projection turns inside out and the quad wraps
   * across the screen.
   */
  if (request.axes) {
    const near = Math.max(sceneExtent * 1.6, 1e-6);
    const step = tickStep(near);
    const reach = step * AXIS_TICKS;

    /** The points along one axis, from the origin out: ticked, then doubling to the horizon. */
    const stations: number[] = [];
    for (let t = step; t <= reach + step / 2; t += step) stations.push(t);
    for (let t = reach * 2; t < step * AXIS_HORIZON; t *= 2) stations.push(t);
    stations.push(step * AXIS_HORIZON);

    const axisLines: Polyline[] = [];
    const tickLines: Polyline[] = [];
    for (let axis = 0; axis < 3; axis++) {
      const along = (t: number): Vec3 => [
        axis === 0 ? t : 0,
        axis === 1 ? t : 0,
        axis === 2 ? t : 0,
      ];
      const color = AXIS_COLORS[axis]!;

      const chain: Vec3[] = [];
      for (let i = stations.length - 1; i >= 0; i--) chain.push(along(-stations[i]!));
      chain.push(along(0));
      for (const t of stations) chain.push(along(t));
      axisLines.push(polylineOf(chain, color));

      // Ticks across the two other directions, so a tick reads from any angle. Only over the
      // ticked stretch: out in the tail they would be a picket fence at one pixel a post.
      const size = near * 0.012;
      for (let t = step; t <= reach + step / 2; t += step) {
        for (const sign of [1, -1] as const) {
          for (let other = 0; other < 3; other++) {
            if (other === axis) continue;
            const a = along(sign * t);
            const b = along(sign * t);
            a[other as 0 | 1 | 2] -= size;
            b[other as 0 | 1 | 2] += size;
            tickLines.push(polylineOf([a, b], color));
          }
        }
      }
    }
    lines.push({ polylines: axisLines, style: { widthPx: 1.6, opacity: 0.75 } });
    if (tickLines.length > 0) {
      lines.push({ polylines: tickLines, style: { widthPx: 1.4, opacity: 0.55 } });
    }
  }

  return {
    mesh,
    lines,
    gridLines,
    chartLines,
    chartBounds,
    chartView,
    reports: mergeReports(reports),
    bounds,
    curvatureScale: shown?.curvature?.scale ?? liftScale,
    curvatureScales,
    usedColors,
    fieldArrows,
    fieldChartArrows,
    ports: scenePorts,
    surfaces,
    periods,

    arrangementOf(rowId) {
      const centre = handCentres.get(rowId);
      if (!centre) return null;
      return handArrangement(placementOf(rowId), centre);
    },

    chartCellAt(u, v) {
      if (!shown || !chartBounds) return null;
      const [u0, u1] = chartBounds.u;
      const [v0, v1] = chartBounds.v;
      const spanU = u1 - u0;
      const spanV = v1 - v0;
      if (!(spanU > 0) || !(spanV > 0)) return null;
      // Outside the domain there is no square: the inset shows a wider view than the surface has,
      // and the margin is chart the parametrization says nothing about.
      if (u < u0 || u > u1 || v < v0 || v > v1) return null;

      /**
       * The same lattice the grid is drawn on, in both pictures.
       *
       * `chartGrid` divides the domain into `GRID_DIVISIONS` and `surfaceGridLines` walks the
       * mesh at the same count, so a square in the corner and a square on the object are the same
       * square. Snapping the hover to anything else would highlight two different things.
       */
      const i = Math.min(GRID_DIVISIONS - 1, Math.floor(((u - u0) / spanU) * GRID_DIVISIONS));
      const j = Math.min(GRID_DIVISIONS - 1, Math.floor(((v - v0) / spanV) * GRID_DIVISIONS));
      const a = u0 + (spanU * i) / GRID_DIVISIONS;
      const b = u0 + (spanU * (i + 1)) / GRID_DIVISIONS;
      const c = v0 + (spanV * j) / GRID_DIVISIONS;
      const d = v0 + (spanV * (j + 1)) / GRID_DIVISIONS;

      // The square's boundary, sampled so its image is a curve rather than four chords.
      const path: Array<[number, number]> = [];
      const edge = (fromU: number, fromV: number, toU: number, toV: number) => {
        for (let k = 0; k < HOVER_SAMPLES; k++) {
          const t = k / HOVER_SAMPLES;
          path.push([fromU + (toU - fromU) * t, fromV + (toV - fromV) * t]);
        }
      };
      edge(a, c, b, c);
      edge(b, c, b, d);
      edge(b, d, a, d);
      edge(a, d, a, c);
      path.push([a, c]);

      const flat = new Float64Array(path.length * 3);
      for (let k = 0; k < path.length; k++) {
        flat[k * 3] = path[k]![0];
        flat[k * 3 + 1] = path[k]![1];
      }

      const onSurface = liftedPolyline(
        shown.surface,
        shown.params,
        path,
        chartLift(sceneExtent, resolution, liftScale) * 2.2,
        HOVER_COLOR,
      );
      // Twice the usual lift: this line sits on top of the grid it is picking out, and a highlight
      // that z-fights with the line it is highlighting reads as flicker rather than as emphasis.
      placePolyline(onSurface, placementOf(shown.item.rowId));

      let anyValid = false;
      for (let k = 0; k < onSurface.count; k++) {
        if (onSurface.valid?.[k]) {
          anyValid = true;
          break;
        }
      }

      return {
        chart: { points: flat, count: path.length, color: HOVER_COLOR },
        surface: anyValid ? onSurface : null,
      };
    },

    flowFor(rowId) {
      const entry = playable.get(rowId);
      if (!entry) return null;
      const { host } = entry;
      const flow = createFlow(host.surface, host.params, entry.field, {
        timeScale: entry.timeScale,
      });
      const placement = placementOf(host.item.rowId);
      // Grown on demand and kept: the streaks are rebuilt every frame, and allocating a megabyte
      // sixty times a second is the one cost this drawing path cannot afford.
      let world = new Float64Array(0);

      return {
        rowId,
        hostRow: host.item.rowId,
        seed: (count = FLOW_PARTICLES, seed = 1) => flow.seed(count, seed),
        advance: (state, dt) => flow.advance(state, dt),
        lines(state) {
          /**
           * The whole swarm is lifted and placed **once**, into a buffer this flow keeps.
           *
           * The bands below are then `subarray` views into it — the same memory read three times
           * at three lengths — so the layering costs no copies and the placement is applied
           * exactly once. Placing per band would move the shared points two extra times, and the
           * streaks would fly off toward the object's own translation.
           */
          const needed = state.count * FLOW_TRAIL * 3;
          if (world.length < needed) world = new Float64Array(needed);
          for (let i = 0; i < state.count; i++) {
            const base = i * FLOW_TRAIL * 3;
            for (let s = 0; s < (state.filled[i] ?? 0); s++) {
              for (let c = 0; c < 3; c++) {
                world[base + s * 3 + c] =
                  state.point[base + s * 3 + c]! + state.normal[base + s * 3 + c]! * overlayLift;
              }
            }
          }
          // Placed like everything else built by evaluating X: the flow of a field on a moved
          // surface has to be on the moved surface.
          placePolyline({ points: world, count: state.count * FLOW_TRAIL, color: entry.color }, placement);

          const groups: LineGroup[] = [];
          for (const band of FLOW_BANDS) {
            const polylines: Polyline[] = [];
            for (let i = 0; i < state.count; i++) {
              const filled = state.filled[i] ?? 0;
              // One point is a particle just born: there is no streak yet, and a single-point
              // polyline draws nothing.
              if (filled < 2) continue;
              const length = Math.max(2, Math.round(filled * band.fraction));
              if (length > filled) continue;
              const base = i * FLOW_TRAIL * 3;
              polylines.push({
                points: world.subarray(base, base + length * 3),
                count: length,
                color: entry.color,
              });
            }
            if (polylines.length > 0) {
              groups.push({
                polylines,
                style: { widthPx: band.widthPx, opacity: band.opacity },
              });
            }
          }
          return groups;
        },

        chartLines(state: FlowState) {
          if (!entry.shown) return [];
          const polylines: Polyline[] = [];
          for (let i = 0; i < state.count; i++) {
            const filled = state.filled[i] ?? 0;
            if (filled < 2) continue;
            const base = i * FLOW_TRAIL * 2;
            const points = new Float64Array(filled * 3);
            for (let s = 0; s < filled; s++) {
              points[s * 3] = state.chartTrail[base + s * 2]!;
              points[s * 3 + 1] = state.chartTrail[base + s * 2 + 1]!;
            }
            polylines.push({ points, count: filled, color: entry.color });
          }
          return polylines.length === 0
            ? []
            : [{ polylines, style: { widthPx: 1.6, opacity: 0.75 } }];
        },
      };
    },

    geodesicFrom(rowId, start, direction, length) {
      const found = compiledSurfaces.find((entry) => entry.item.rowId === rowId);
      if (!found) return null;
      const geodesic = integrateGeodesic(
        found.surface,
        found.params,
        [start[0], start[1]],
        [direction[0], direction[1]],
        length,
        {
          bounds: integrationBounds(found.surface, found.poles),
          maxStepArc: sceneExtent / SEGMENTS_PER_EXTENT,
        },
      );
      if (geodesic.chart.length < 2) return null;
      const preview = liftedPolyline(
        found.surface,
        found.params,
        geodesic.chart,
        chartLift(sceneExtent, resolution, liftScale),
        colorOf(rowId, GEODESIC_COLOR),
      );
      // Placed like everything else this row draws, or the preview would trail off toward the
      // origin while the surface it belongs to sits somewhere else.
      placePolyline(preview, placementOf(rowId));
      return preview;
    },

    positionOf(rowId, u, v) {
      const found = compiledSurfaces.find((entry) => entry.item.rowId === rowId);
      if (!found) return null;
      const local: Vec3 = [0, 0, 0];
      found.surface.position(u, v, found.params, local);
      if (!local.every((value) => Number.isFinite(value))) return null;
      // In the place the object is actually DRAWN. The parametrization knows nothing about
      // arrangement, so a moved or joined surface would otherwise report a phantom at the origin.
      const out: Vec3 = [0, 0, 0];
      return applyPlacement(found.placement ?? IDENTITY_PLACEMENT, local, out);
    },
  };
}

/**
 * How much bigger than the domain the inset may get.
 *
 * A curve that shoots off to v = 10⁶ must not shrink the domain to a dot: past this the view
 * stops following it, the stroke runs off the edge, and the domain stays legible — which is the
 * thing the inset exists to show.
 */
const CHART_VIEW_LIMIT = 3;

/** Dash period for the off-domain stroke, in chart units: short enough to read as dashed. */
function chartDash(bounds: ChartBounds | null): number {
  if (!bounds) return 0.1;
  const span = Math.max(bounds.u[1] - bounds.u[0], bounds.v[1] - bounds.v[0]);
  return Math.max(span / 24, 1e-6);
}

/**
 * The domain, grown to contain the curves drawn over it, and capped.
 *
 * Only ever grows: the domain is always fully visible, so the border and the grid keep meaning
 * what they meant, and the extra room is where the part of the curve that is not on the surface
 * gets drawn.
 */
function widenToFit(bounds: ChartBounds, curves: readonly Polyline[]): ChartBounds {
  const uSpan = bounds.u[1] - bounds.u[0] || 1;
  const vSpan = bounds.v[1] - bounds.v[0] || 1;
  let [uMin, uMax] = bounds.u;
  let [vMin, vMax] = bounds.v;

  for (const curve of curves) {
    for (let i = 0; i < curve.count; i++) {
      if (curve.valid && !curve.valid[i]) continue;
      const u = curve.points[i * 3]!;
      const v = curve.points[i * 3 + 1]!;
      if (!Number.isFinite(u) || !Number.isFinite(v)) continue;
      if (u < uMin) uMin = u;
      if (u > uMax) uMax = u;
      if (v < vMin) vMin = v;
      if (v > vMax) vMax = v;
    }
  }

  const uRoom = uSpan * CHART_VIEW_LIMIT;
  const vRoom = vSpan * CHART_VIEW_LIMIT;
  return {
    u: [Math.max(uMin, bounds.u[0] - uRoom), Math.min(uMax, bounds.u[1] + uRoom)],
    v: [Math.max(vMin, bounds.v[0] - vRoom), Math.min(vMax, bounds.v[1] + vRoom)],
  };
}

/**
 * A tick spacing that is a round number and gives a readable count.
 *
 * 1, 2 or 5 times a power of ten — the choice every axis in every plotting library makes, because
 * the alternative is ticks at 0.37 and a reader doing arithmetic to place the object.
 */
function tickStep(reach: number): number {
  const raw = reach / 6;
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(raw, 1e-9)));
  const normalized = raw / magnitude;
  const step = normalized >= 5 ? 5 : normalized >= 2 ? 2 : 1;
  return step * magnitude;
}

/** Half the largest span across a set of meshes — a stand-in for scene size. */
function extentOfMeshes(meshes: readonly TessellatedSurface[]): number {
  let min = [Infinity, Infinity, Infinity];
  let max = [-Infinity, -Infinity, -Infinity];
  for (const mesh of meshes) {
    for (let i = 0; i < mesh.vertexCount; i++) {
      for (let c = 0; c < 3; c++) {
        const value = mesh.positions[i * 3 + c]!;
        if (!Number.isFinite(value)) continue;
        if (value < min[c]!) min[c] = value;
        if (value > max[c]!) max[c] = value;
      }
    }
  }
  let span = 0;
  for (let c = 0; c < 3; c++) {
    const width = max[c]! - min[c]!;
    if (Number.isFinite(width)) span = Math.max(span, width);
  }
  return Math.max(span / 2, 1e-3);
}

/** Largest span of a sampled curve, used to scale frame glyphs to the object. */
function extentOf(frames: {
  points: Float64Array;
  valid: Uint8Array;
  count: number;
}): number {
  let min = [Infinity, Infinity, Infinity];
  let max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < frames.count; i++) {
    if (!frames.valid[i]) continue;
    for (let c = 0; c < 3; c++) {
      const value = frames.points[i * 3 + c]!;
      if (!Number.isFinite(value)) continue;
      if (value < min[c]!) min[c] = value;
      if (value > max[c]!) max[c] = value;
    }
  }
  let span = 0;
  for (let c = 0; c < 3; c++) {
    const width = max[c]! - min[c]!;
    if (Number.isFinite(width)) span = Math.max(span, width);
  }
  return span;
}

/**
 * A chart polyline as a 3D one, lifted clear of the mesh.
 *
 * Degenerate samples are marked invalid rather than dropped, so the line pass breaks the stroke
 * there instead of connecting across a pole.
 */
function liftedPolyline(
  surface: ReturnType<typeof createParametricSurface>,
  params: ArrayLike<number>,
  chart: readonly (readonly [number, number])[],
  lift: number,
  color: Vec3,
): Polyline {
  const count = chart.length;
  const points = new Float64Array(count * 3);
  const valid = new Uint8Array(count);
  const arcLength = new Float64Array(count);
  const point = makeSurfacePoint();

  for (let i = 0; i < count; i++) {
    const [u, v] = chart[i]!;
    surface.at(u, v, params, point);
    if (point.degenerate) continue;
    points[i * 3] = point.p[0] + point.N[0] * lift;
    points[i * 3 + 1] = point.p[1] + point.N[1] * lift;
    points[i * 3 + 2] = point.p[2] + point.N[2] * lift;
    valid[i] = 1;
    if (i > 0) {
      arcLength[i] =
        arcLength[i - 1]! +
        Math.hypot(
          points[i * 3]! - points[(i - 1) * 3]!,
          points[i * 3 + 1]! - points[(i - 1) * 3 + 1]!,
          points[i * 3 + 2]! - points[(i - 1) * 3 + 2]!,
        );
    }
  }

  return { points, count, valid, arcLength, color };
}

/** Collapse the raw notes into one entry per row, preserving every line. */
function mergeReports(raw: readonly RawReport[]): RowReport[] {
  const byRow = new Map<RowId, { errors: string[]; warnings: string[]; info: string[] }>();
  for (const note of raw) {
    let entry = byRow.get(note.rowId);
    if (!entry) {
      entry = { errors: [], warnings: [], info: [] };
      byRow.set(note.rowId, entry);
    }
    if (note.error) entry.errors.push(note.error);
    if (note.warning) entry.warnings.push(note.warning);
    if (note.info) entry.info.push(note.info);
  }
  return [...byRow].map(([rowId, entry]) => ({ rowId, ...entry }));
}

function messageOf(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}

/** A graph `z = f(x,y)` is the parametric surface (x, y, f) — nothing more. */
function surfaceComponents(item: Item): Expr[] {
  if (item.kind !== "graphSurface") return [...item.comps];
  const [first = "x", second = "y"] = item.vars;
  return [ctx.variable(first), ctx.variable(second), item.comps[0]!];
}

function surfaceVars(item: Item): string[] {
  if (item.kind === "graphSurface") return [item.vars[0] ?? "x", item.vars[1] ?? "y"];
  return [item.vars[0] ?? "u", item.vars[1] ?? "v"];
}

function surfaceRanges(
  item: Item,
  domains: ReadonlyMap<RowId, readonly DomainRange[]>,
) {
  const vars = surfaceVars(item);
  const stored = domains.get(item.rowId);
  const rangeFor = (index: number) => {
    const explicit = stored?.[index];
    if (explicit) return interval(explicit.min, explicit.max);
    const fallback = DEFAULT_DOMAIN[vars[index]!] ?? [0, 2 * Math.PI];
    return interval(fallback[0], fallback[1]);
  };
  return [rangeFor(0), rangeFor(1)] as const;
}

/**
 * The box a level set is looked for in, per row.
 *
 * Three sides always, whichever coordinates the formula happens to mention: a level set is a
 * subset of R³ and the box is a window onto it, not a domain the surface is a map from.
 */
function implicitRanges(item: Item, domains: ReadonlyMap<RowId, readonly DomainRange[]>) {
  const stored = domains.get(item.rowId);
  const rangeFor = (index: number, name: string) => {
    const explicit = stored?.[index];
    if (explicit) return interval(explicit.min, explicit.max);
    const fallback = DEFAULT_DOMAIN[name] ?? [-2, 2];
    return interval(fallback[0], fallback[1]);
  };
  return [rangeFor(0, "x"), rangeFor(1, "y"), rangeFor(2, "z")] as const;
}

/**
 * Cells per axis for the marching grid, from the parametric resolution.
 *
 * They cannot be the same number. A parametric surface samples a rectangle — 150² is 23k points —
 * while a level set samples a **volume**, so the same figure would be 3.4 million evaluations and
 * a frozen tab. The cap is what keeps a draft render honest about being cheap; past it, a surface
 * gets smoother by having its box tightened rather than by grinding the whole volume finer.
 */
function marchResolution(resolution: number): number {
  return Math.max(16, Math.min(60, Math.round(resolution * 0.55)));
}

function packParameters(
  names: readonly string[],
  values: ReadonlyMap<string, number>,
  declared: ReadonlyMap<string, number> = new Map(),
): Float64Array {
  return Float64Array.from(
    names.map((name) => values.get(name) ?? declared.get(name) ?? 1),
  );
}

/**
 * Pack several tessellated surfaces into one set of buffers.
 *
 * Index offsets shift per mesh; everything else concatenates directly, since all surfaces
 * share one shader and one colour scale.
 */
function concatenate(meshes: readonly TessellatedSurface[]): TessellatedSurface {
  if (meshes.length === 1) return meshes[0]!;

  let vertexCount = 0;
  let indexCount = 0;
  let droppedVertices = 0;
  let droppedTriangles = 0;
  for (const mesh of meshes) {
    vertexCount += mesh.vertexCount;
    indexCount += mesh.indices.length;
    droppedVertices += mesh.droppedVertices;
    droppedTriangles += mesh.droppedTriangles;
  }

  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const colors = new Float32Array(vertexCount * 3);
  const baseColors = new Float32Array(vertexCount * 3);
  const chart = new Float32Array(vertexCount * 2);
  const ids = new Float32Array(vertexCount);
  const style = new Float32Array(vertexCount);
  const curvature = new Float64Array(vertexCount);
  const indices = new Uint32Array(indexCount);

  let vertexOffset = 0;
  let indexOffset = 0;
  for (const mesh of meshes) {
    positions.set(mesh.positions, vertexOffset * 3);
    normals.set(mesh.normals, vertexOffset * 3);
    colors.set(mesh.colors, vertexOffset * 3);
    baseColors.set(mesh.baseColors, vertexOffset * 3);
    chart.set(mesh.chart, vertexOffset * 2);
    ids.set(mesh.ids, vertexOffset);
    style.set(mesh.style, vertexOffset);
    curvature.set(mesh.curvature, vertexOffset);
    for (let i = 0; i < mesh.indices.length; i++) {
      indices[indexOffset + i] = mesh.indices[i]! + vertexOffset;
    }
    vertexOffset += mesh.vertexCount;
    indexOffset += mesh.indices.length;
  }

  return {
    positions,
    normals,
    colors,
    baseColors,
    chart,
    ids,
    style,
    curvature,
    indices,
    vertexCount,
    triangleCount: indexCount / 3,
    droppedVertices,
    droppedTriangles,
    /**
     * The first mesh's range, which is the first PATCH's — not the concatenation's.
     *
     * Each surface is painted through its own curvature scale, so there is no single range for a
     * merged mesh to report. Nothing downstream reads this for colour; the legend takes
     * `scene.curvatureScale`, which is the scale of the patch you have selected, so it always
     * labels something on screen. Kept here because a mesh has always carried the scale it was
     * built with, and a lie would be worse than a partial answer.
     */
    range: meshes[0]!.range,
  };
}

function computeBounds(
  mesh: TessellatedSurface | null,
  lines: readonly LineGroup[],
): { center: Vec3; radius: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  const include = (x: number, y: number, z: number) => {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  };

  if (mesh) {
    for (let i = 0; i < mesh.vertexCount; i++) {
      include(mesh.positions[i * 3]!, mesh.positions[i * 3 + 1]!, mesh.positions[i * 3 + 2]!);
    }
  }
  for (const group of lines) {
    for (const line of group.polylines) {
      for (let i = 0; i < line.count; i++) {
        if (line.valid && !line.valid[i]) continue;
        include(line.points[i * 3]!, line.points[i * 3 + 1]!, line.points[i * 3 + 2]!);
      }
    }
  }

  if (!Number.isFinite(minX)) return null;
  const center: Vec3 = [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];

  // Robust radius: the far corner of the box would over-frame a flat object badly.
  let maxDistanceSquared = 0;
  const consider = (x: number, y: number, z: number) => {
    const dx = x - center[0];
    const dy = y - center[1];
    const dz = z - center[2];
    const d = dx * dx + dy * dy + dz * dz;
    if (Number.isFinite(d) && d > maxDistanceSquared) maxDistanceSquared = d;
  };
  if (mesh) {
    for (let i = 0; i < mesh.vertexCount; i++) {
      consider(mesh.positions[i * 3]!, mesh.positions[i * 3 + 1]!, mesh.positions[i * 3 + 2]!);
    }
  }
  for (const group of lines) {
    for (const line of group.polylines) {
      for (let i = 0; i < line.count; i++) {
        if (line.valid && !line.valid[i]) continue;
        consider(line.points[i * 3]!, line.points[i * 3 + 1]!, line.points[i * 3 + 2]!);
      }
    }
  }

  return { center, radius: Math.max(Math.sqrt(maxDistanceSquared), 0.05) };
}
