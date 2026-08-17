import type { Diagnostic } from "../core/expr/diagnostics.ts";
import type { Vec3 } from "../core/geom/types.ts";
import {
  COLORMAP_LABEL,
  COLORMAP_NAMES,
  type ColormapName,
} from "../core/geom/colormaps.ts";
import { toLatex } from "../core/expr/latex.ts";
import { parse, parseRow, splitHost, splitScope } from "../core/expr/parse.ts";
import { toSource } from "../core/expr/print.ts";
import { diff } from "../core/expr/diff.ts";
import { simplify } from "../core/expr/simplify.ts";
import {
  CURVE_NAMES,
  SPACE_NAMES,
  SURFACE_NAMES,
  nextName,
  rehost,
  renameDeclaration,
  usedNames,
} from "../state/naming.ts";
import type { DocumentStore, Item, Resolution, RowId } from "../state/graph.ts";
import {
  DEFAULT_DOMAIN,
  type DomainRange,
  type FrameRequest,
  type RowReport,
  type SurfaceOverlay,
} from "../state/scene.ts";
import type { Animator } from "./animate.ts";
import { el, formatValue, replace } from "./dom.ts";
import { tex } from "./tex.ts";

/**
 * The expression list: a Desmos-style stack of rows, plus sliders that appear on their own.
 *
 * ## The two rules this file exists to obey
 *
 * **A row's `<input>` is created once and never replaced.** Everything else in the row —
 * the typeset echo, the kind badge, the diagnostics, the readout — is refreshed in place
 * around it. Replacing the input would destroy focus and the caret on every keystroke.
 *
 * **Auto-sliders are the affordance that makes formula entry feel alive.** Typing `a u`
 * with no definition for `a` should produce a slider immediately, not an error telling you
 * to go and declare something. The document reports every undefined symbol as a free
 * parameter; this file materializes one slider per name and never asks.
 */

/** Short decimal for a slider-written literal; a full-precision float is unreadable in a row. */
function format(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toFixed(4)));
}

const KIND_LABEL: Readonly<Record<string, string>> = {
  scalar: "scalar",
  planeCurve: "plane curve",
  spaceCurve: "space curve",
  parametricSurface: "coordinate patch",
  graphSurface: "graph patch",
  implicitSurface: "level set",
  point: "point",
  vectorField: "vector field",
  functionDefinition: "definition",
  chartGraph: "chart graph",
  chartRelation: "chart relation",
  tangentPlane: "tangent plane",
  surfaceField: "vector field",
  unknown: "?",
};

/** Not yet drawn by the renderer; the badge says so rather than failing silently. */
/** Recognized, and not drawn: a field on all of R³ has no surface to live along. */
const NOT_YET_DRAWN = new Set(["vectorField"]);

export interface SliderSpec {
  value: number;
  min: number;
  max: number;
  step: number;
}

export interface ExprListOptions {
  readonly document: DocumentStore;
  /**
   * A row's text changed. Debounced by the caller: a half-typed formula should not render.
   */
  readonly onEdit: (refit: boolean) => void;
  /**
   * Only a parameter value changed — no text, no structure.
   *
   * Kept separate because it wants *throttling*, not debouncing. A slider must give
   * continuous feedback while it moves, whereas a debounce would show nothing until the drag
   * stopped and then jump.
   */
  readonly onParameterChange: () => void;
  /**
   * A field's flow advanced by `seconds`: draw the next frame of it.
   *
   * Deliberately NOT `onParameterChange`: nothing about the document has changed, and rebuilding
   * the scene sixty times a second to move some particles would cost a hundred times what moving
   * them does. The app owns the particles — like the aimed shots — so that a rebuild does not
   * empty the picture being watched.
   */
  readonly onFlowTick?: (rowId: RowId, seconds: number) => void;
  /** Start that flow again: fresh particles, spread over the domain. */
  readonly onFlowRewind?: (rowId: RowId) => void;
  /** A flow was played, paused or rewound: what is drawn has changed, repaint. */
  readonly onFlowToggle?: (rowId: RowId) => void;
  /** Per-row domain ranges, mutated in place by the domain inputs. */
  readonly domains: Map<RowId, DomainRange[]>;
  /** Slider state, mutated in place. */
  readonly sliders: Map<string, SliderSpec>;
  /** Which curve rows show a moving frame, and where along the curve. */
  readonly frames: Map<RowId, FrameRequest>;
  /** Slider bounds for rows that define a plain number, keyed by row. */
  readonly rowSliders: Map<RowId, SliderSpec>;
  /** Plane-curve rows to read as curves in the chart rather than in the z = 0 plane. */
  readonly inChart: Set<RowId>;
  /** Drives play / pause / rewind on any slider. */
  readonly animator: Animator;
  /** Per-surface overlays: geodesic sprays, lines of curvature, the Gauss map. */
  readonly overlays: Map<RowId, SurfaceOverlay>;
  /**
   * Per row, where each coordinate starts repeating itself — filled in by the app after every
   * scene build, since only the compiled surface can say.
   *
   * A domain wider than this does not show more surface, it shows the same surface twice drawn
   * over itself, so it is where the controls stop.
   */
  readonly periods?: Map<RowId, readonly [number | null, number | null]>;
  /** Per-row colour, for every part of the scene that row draws. */
  readonly colors: Map<RowId, Vec3>;
  /**
   * The selection changed.
   *
   * The scene depends on it — the chart inset shows the selected patch's own (u, v) plane — so
   * selecting a row has to be able to ask for a rebuild, exactly as editing one does.
   */
  readonly onSelect?: (id: RowId | null) => void;
  /**
   * Step into an ambient space, from the arrow on its own cell.
   *
   * A space is the one object with nothing on the stage to double-click, so the way in has to be
   * in the panel; the way out is the banner and the double right-click, as it is for every space.
   */
  readonly onEnterSpace?: (id: RowId) => void;
}

export interface ExprList {
  readonly root: HTMLElement;
  /** The floating properties card, for the caller to mount over the scene. */
  readonly card: HTMLElement;
  /** Show a row's properties, or `null` to close the card. Also driven by picking in 3D. */
  /**
   * Select a row, and say whether that also **opens** its controls.
   *
   * The two are different acts. Selecting decides what the inset charts and which cell is
   * highlighted — the answer to "which one am I looking at", which you want while still holding
   * the camera. Opening puts a panel of sliders under the pointer, over the object just pointed
   * at. So a click in the list passes false (the window would cover the cell being edited), a
   * single click on an object in 3D passes false, and a double click there passes true.
   */
  select(id: RowId | null, reveal?: boolean): void;
  selected(): RowId | null;
  /**
   * Where the properties live: the strip along the top, or a window at the pointer.
   *
   * Both are kept. They are the same DOM with a different class — no reparenting, which would
   * detach whatever control had focus — so switching between them costs nothing and neither
   * implementation has to be deleted to try the other.
   */
  setPlacement(mode: "bar" | "cursor"): void;
  /** Remember where to open the window, for the cursor placement. */
  placeAt(x: number, y: number): void;
  /**
   * Show only the rows belonging to one object, or all of them again.
   *
   * What belongs: the row itself, everything stated on it with the `X:` prefix, and everything it
   * is built from — a torus whose R and r were hidden would be a torus with half its controls
   * missing. Rows outside the scope stay in the document and in the DOM; only their visibility
   * changes, so leaving costs nothing and loses nothing.
   */
  setScope(scope: { readonly name: string; readonly rowId: RowId } | null): void;
  /**
   * Full refresh: echoes, badges, controls, diagnostics. For structural changes.
   *
   * `drawn` is the colour each row was actually rendered in, which the scene reports because the
   * defaults are not one rule — a curve takes a palette entry by document order, a patch the
   * shade under its curvature map. Without it the dot on the cell would be a guess.
   */
  refresh(reports: readonly RowReport[], drawn?: ReadonlyMap<RowId, Vec3>): void;
  /**
   * Update only the per-row readouts.
   *
   * Used on the throttled parameter path. Nothing structural can have changed there, so this
   * skips reparsing and re-typesetting every row — which is what a slider drag was paying for
   * on each frame.
   */
  refreshReports(reports: readonly RowReport[]): void;
  /**
   * Force the sliders to be rebuilt on the next refresh.
   *
   * The rebuild guard keys off the parameter *names*, which is what keeps a refresh from
   * replacing a range input mid-drag. Loading a template re-seeds the specs behind those same
   * names with different bounds, so it has to say so explicitly rather than relying on the
   * name list to have changed.
   */
  invalidateSliders(): void;
}

interface MovingSliderOptions {
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly value: number;
  /** How the bubble renders the number. */
  readonly format?: (value: number) => string;
  readonly title?: string;
  /** Continuous, while dragging. */
  readonly onInput: (value: number) => void;
}

interface MovingSlider {
  readonly root: HTMLElement;
  readonly input: HTMLInputElement;
  /** Push a value in from outside — the animator, or a reformat. */
  set(value: number): void;
  /** Move the ends of the track. The bubble rides on them, so they cannot be set on the input. */
  setRange(min: number, max: number, step: number): void;
}

/**
 * A slider whose value rides above the thumb, with no number box beside it.
 *
 * Two things bought at once. The readout used to sit in a fixed column and the exact-value box
 * in another, so on a toolbar the TRACK — the only part you actually manipulate — got whatever
 * was left, which was almost nothing. Putting the number on the thumb and dropping the box
 * gives the track the full width.
 *
 * Exact entry is double-click: the bubble becomes a field, and a value outside the current
 * range widens it rather than being refused. Since a drag no longer moves the track's ends,
 * this is the one place a range changes — deliberately, by typing a number, rather than as a
 * side effect of overshooting a drag.
 */

/**
 * The overlay a patch has before anything is switched on.
 *
 * The chips write into the same record the overlay controls own, so they need something to spread
 * over when a row has never had one — and it has to be the values those controls treat as "off",
 * or switching a face back on would silently arm a geodesic spray.
 */
const EMPTY_OVERLAY: SurfaceOverlay = {
  geodesics: 0,
  geodesicLength: 1.5,
  curvatureLines: false,
};

interface RowView {
  readonly id: RowId;
  readonly root: HTMLElement;
  readonly input: HTMLTextAreaElement;
  /** Swap this cell to its raw text and focus it, as a click on it does. */
  enterEdit(): void;
  readonly echo: HTMLElement;
  readonly badge: HTMLElement;
  readonly notes: HTMLElement;
  readonly domainHost: HTMLElement;
  readonly frameHost: HTMLElement;
  /** the variables the domain fields were built for, so they are not rebuilt needlessly */
  domainVars: string;
  /** the two thumbs per variable, min then max, for putting values back */
  domainThumbs: MovingSlider[];
  /** the two typed bounds per variable, min then max, in the same order */
  domainLimits: HTMLInputElement[];
  /** host for the inline slider a numeric row gets */
  readonly valueHost: HTMLElement;
  /** host for the chart toggle a plane-curve row gets */
  readonly chartHost: HTMLElement;
  /** host for the flat-drawing toggle a level set gets */
  readonly planeHost: HTMLElement;
  /** host for the geodesic and curvature-line controls a surface row gets */
  readonly overlayHost: HTMLElement;
  /** host for the transport a vector field gets, so its flow can be played */
  readonly flowHost: HTMLElement;
  /** whether that transport is built, so it is not rebuilt under a running flow */
  flowBuilt: boolean;
  /** the arrows switch, once a field row has one; the dot writes the same flag */
  arrowChip: HTMLButtonElement | null;
  /**
   * This row's properties, shown in the floating card when the row is selected.
   *
   * Every row's details block lives in the card the whole time; selection only toggles which one
   * is VISIBLE. Nothing is ever reparented, which matters because moving a DOM node detaches and
   * reinserts it — blurring any focused descendant — and because the sync functions can then go
   * on updating a row's controls whether or not it happens to be on screen.
   */
  readonly details: HTMLElement;
  readonly colorSwatch: HTMLInputElement;
  /** the dot on the cell that reports the colour the object is drawn in */
  readonly colorDot: HTMLElement;
  /** the eye that draws or stops drawing the whole row */
  readonly eye: HTMLButtonElement;
  /** the arrow that opens an ambient space, shown on that kind of row alone */
  readonly enterSpace: HTMLButtonElement;
  /** the pencil's colour input, opened by it and never shown */
  readonly colorField: HTMLInputElement;
  /** the gutter holding both, hidden on a row that draws nothing */
  readonly gutter: HTMLElement;
  /** the K toggle beside the colour, kept in step with the colour-map menu */
  readonly curvatureChip: HTMLButtonElement;
  /** what of this patch is drawn: its face and its chart grid */
  readonly fillChip: HTMLButtonElement;
  readonly gridChip: HTMLButtonElement;
  /** makes a relation in this patch's chart; shown only on rows that have one */
  readonly addRelation: HTMLButtonElement;
  /** makes a tangent plane at a point of this patch's chart, likewise */
  readonly addTangent: HTMLButtonElement;
  /** makes a vector field along this patch; only a parametric patch can seed one */
  readonly addField: HTMLButtonElement;
  /** frames the whole of a level set, ignoring its box sliders */
  readonly fitChip: HTMLButtonElement;
  /** this row's colour-map menu, once its surface controls exist */
  colormapSelect: HTMLSelectElement | null;
  readonly detailsTitle: HTMLElement;
  /** sliders for the free parameters THIS row uses */
  readonly paramHost: HTMLElement;
  /** the parameter names those sliders were built for */
  paramNames: string;
  overlayBuilt: boolean;
  /** the name the inline slider was built for, or "" if there is none */
  valueName: string;
}

/** The eye, open: this object is drawn. */
const EYE_OPEN =
  '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">' +
  '<path fill="none" stroke="currentColor" stroke-width="1.3" ' +
  'd="M1 8s2.6-4.2 7-4.2S15 8 15 8s-2.6 4.2-7 4.2S1 8 1 8z"/>' +
  '<circle cx="8" cy="8" r="1.9" fill="currentColor"/></svg>';

/** And shut: the same eye, struck through, so the two read as one control in two states. */
const EYE_SHUT =
  '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">' +
  '<path fill="none" stroke="currentColor" stroke-width="1.3" opacity="0.55" ' +
  'd="M1 8s2.6-4.2 7-4.2S15 8 15 8s-2.6 4.2-7 4.2S1 8 1 8z"/>' +
  '<circle cx="8" cy="8" r="1.9" fill="currentColor" opacity="0.55"/>' +
  '<path stroke="currentColor" stroke-width="1.4" d="M2.4 13.6 13.6 2.4"/></svg>';


export function createExprList(options: ExprListOptions): ExprList {
  const { document: store } = options;

  const rowHost = el("div", { class: "rows" });

  /**
   * The floating properties card.
   *
   * Lives over the scene rather than in the panel, so the expression list stays what it says it
   * is — a list of inputs — and so properties appear next to the object they describe when it is
   * selected by clicking it in the scene.
   */
  const cardTitle = el("span", { class: "props__title", text: "properties" });
  const cardBody = el("div", { class: "props__slot" });
  /**
   * Shown when nothing is selected, so the strip keeps its height.
   *
   * The strip must never appear and disappear: doing so resizes the stage, which changes the
   * canvas aspect and shifts the camera — so clicking a surface to inspect it nudged the very
   * thing being inspected. Its height is reserved always, and this is what occupies it.
   */
  const cardPlaceholder = el("span", {
    class: "props__placeholder",
    text: "select an object to edit it",
  });
  const card = el("div", { class: "props props--empty" }, [
    el("div", { class: "props__head" }, [
      cardTitle,
      cardPlaceholder,
      el("button", {
        class: "props__close",
        title: "close",
        text: "\u00d7",
        onClick: () => select(null),
      }),
    ]),
    cardBody,
  ]);

  let selectedId: RowId | null = null;
  let placement: "bar" | "cursor" = "bar";
  /**
   * Whether the window is open, as distinct from whether something is selected.
   *
   * Clicking a cell selects it — that is what the highlight means — but must not pop a window
   * over the cell being typed into. Only a click in the SCENE asks to see an object's controls.
   */
  let revealed = false;
  let cursorX = 0;
  let cursorY = 0;

  /**
   * Keep the window on screen.
   *
   * Opening flush against the pointer puts it off the right or bottom edge whenever the click is
   * near one, which is exactly where a surface tends to be clicked when it fills the view.
   */
  const positionAtCursor = () => {
    if (placement !== "cursor") return;
    const margin = 8;
    const width = card.offsetWidth || 320;
    const height = card.offsetHeight || 220;

    /**
     * Never over the cell column.
     *
     * Selecting a row opens the window at the pointer, which is IN the column — so it landed on
     * top of the cell just clicked and made it impossible to edit the thing being inspected. The
     * window is pushed clear of the panel's right edge, which costs nothing when the click came
     * from the scene and fixes the case where it did not.
     */
    const panelRight = root.getBoundingClientRect().right;
    const minX = Math.max(margin, panelRight + margin);
    const maxX = globalThis.innerWidth - width - margin;
    const maxY = globalThis.innerHeight - height - margin;
    card.style.left = `${Math.max(minX, Math.min(Math.max(minX, maxX), cursorX + 12))}px`;
    card.style.top = `${Math.max(margin, Math.min(maxY, cursorY + 12))}px`;
  };

  /**
   * Show one row's properties, or none.
   *
   * Selection is a property of the LIST rather than of a row so that the scene and the list can
   * drive it interchangeably: clicking a surface in 3D and clicking its row are the same act, and
   * both have to land in one place or the highlight and the card can disagree.
   */
  const select = (id: RowId | null, reveal = true) => {
    const moved = selectedId !== id;
    selectedId = id;
    if (!reveal) revealed = false;
    else if (id !== null) revealed = true;
    for (const [rowId, view] of views) {
      const chosen = rowId === id;
      view.details.classList.toggle("props__body--hidden", !chosen);
      view.root.classList.toggle("row--selected", chosen);
      if (chosen) cardTitle.textContent = view.detailsTitle.textContent ?? "properties";
    }
    // The strip stays in the layout either way; only its CONTENTS change. See the placeholder.
    card.classList.toggle(
      "props--empty",
      id === null || !views.has(id) || (placement === "cursor" && !revealed),
    );
    positionAtCursor();
    // Only on a real change, and last, so the handler sees the selection it is being told about.
    // The scene reads it — the chart inset shows the selected patch — so a click on a cell and a
    // click on the object itself have to arrive the same way.
    if (moved) options.onSelect?.(id);
  };

  /**
   * The ambient space the list is showing, if any.
   *
   * Inside one, the panel is about that object: the row itself, everything stated on it, and the
   * parameters it is built from. Everything else is still in the document and still in the DOM —
   * hidden rather than removed, so leaving the space costs a class toggle and nothing has to be
   * rebuilt, refocused or re-registered.
   */
  let scope: { readonly name: string; readonly rowId: RowId } | null = null;

  /**
   * Which rows belong to the scoped object.
   *
   * Three things do: the row itself; every row stated on it, which is what the `X:` prefix says;
   * and every row it is **built from** — a torus whose R and r are elsewhere is not usable without
   * them, and hiding a slider the surface depends on would be hiding half the object. Followed to
   * a fixed point, since a parameter can be defined in terms of another.
   */
  const inScope = (resolution: Resolution): Set<RowId> => {
    const keep = new Set<RowId>();
    if (scope === null) return keep;
    keep.add(scope.rowId);

    /**
     * Membership is read off the **text**, not off the resolution.
     *
     * A row being typed has no item yet — `X: ` alone resolves to nothing, and neither does a
     * half-written formula — so a filter that asked the resolution would hide the cell at the
     * exact moment somebody is writing in it, which is what it did. The prefix is the binding and
     * the prefix is text, so the text is what decides. Blank cells stay for the same reason: the
     * empty one at the end is where the next expression goes.
     */
    for (const row of store.rows()) {
      const text = row.source();
      if (isBlank(text) || withinScope(splitScope(text).path, scope.name)) keep.add(row.id);
    }

    const items = [...resolution.items.values()];
    /**
     * Numbers and definitions are in scope everywhere, because they belong to the document rather
     * than to any object: one `k` is one number wherever it is used. Without this, adding a slider
     * inside a space would make it vanish until something referred to it.
     */
    for (const item of items) {
      if (item.kind === "parameter" || item.kind === "scalar" || item.kind === "functionDefinition") {
        keep.add(item.rowId);
      }
    }

    for (let pass = 0; pass < 8; pass++) {
      const wanted = new Set<string>();
      /**
       * What is stated *on* something in the space is in the space too.
       *
       * A surface written inside X's space is X's, and a field or a relation written on that
       * surface is X's by the same argument — the chain is what the prefix means. Without the
       * transitive step, loading a patch-with-field inside a space would show the patch and hide
       * the field stated on it.
       */
      const hosts = new Set<string>();
      for (const item of items) {
        if (!keep.has(item.rowId)) continue;
        for (const name of item.params) wanted.add(name);
        if (item.name !== null) hosts.add(item.name);
      }
      let grew = false;
      for (const item of items) {
        if (keep.has(item.rowId) || item.host == null) continue;
        if (!hosts.has(item.host)) continue;
        keep.add(item.rowId);
        grew = true;
      }
      for (const item of items) {
        if (keep.has(item.rowId) || item.name === null) continue;
        if (!wanted.has(item.name)) continue;
        keep.add(item.rowId);
        grew = true;
      }
      if (!grew) break;
    }
    return keep;
  };

  const views = new Map<RowId, RowView>();

  /**
   * Everything about a row that is not its text, copied onto another row.
   *
   * A copied surface that came back on the default domain in a different colour with its face
   * turned back on is not the object that was copied — the settings ARE half of what the user
   * built. Deep copies throughout: sharing a domain array would make the two rows one control
   * with two thumbs on screen.
   */
  const carryRowState = (from: RowId, to: RowId) => {
    const domain = options.domains.get(from);
    if (domain) options.domains.set(to, domain.map((range) => ({ ...range })));
    const color = options.colors.get(from);
    if (color) options.colors.set(to, [color[0], color[1], color[2]]);
    const overlay = options.overlays.get(from);
    if (overlay) options.overlays.set(to, { ...overlay });
    const frame = options.frames.get(from);
    if (frame) options.frames.set(to, { ...frame });
    if (options.inChart.has(from)) {
      options.inChart.add(to);
      // Marked as seen, or the next refresh would apply the classifier's default over the top of
      // what was just copied.
      seenChartRows.add(to);
    }
  };

  /** the parameter list the sliders were built for */
  let renderedSliders = "\u0000";
  /** Rows whose chart default has already been applied, so a later edit does not re-apply it. */
  const seenChartRows = new Set<RowId>();


  /**
   * Create and destroy row elements to match the document, leaving existing rows' DOM
   * untouched. This is the keyed-list reconciliation the design notes insisted on writing
   * before any feature UI: without it, editing row 1 rebuilds row 2 and steals its focus.
   */
  /**
   * Keep exactly one empty cell at the end.
   *
   * Typing into the last cell immediately opens another below it, so there is always somewhere to
   * write and never an "add" button to find. Trailing empties beyond the first are collapsed, so
   * the bar cannot grow a tail of blanks.
   */
  /**
   * What a new cell starts with: nothing, or the prefix of the space you are inside.
   *
   * In an ambient space every expression written belongs to that space, so the cell says so before
   * you type — the same thing the "+ relation" button does, applied to the empty cell that is
   * always there. A row that is only a prefix counts as empty, so trailing cells still collapse.
   */
  const blankRow = () => (scope === null ? "" : `${scope.name}: `);
  /**
   * The full address of the object a row declares — `sigma` at the top level, `A:sigma` inside A.
   *
   * Every button that writes a row *about* another one uses this rather than the bare name: a
   * relation written as `sigma:` while sigma lives in A would be a row at the top level naming
   * something inside a space, which resolves only by luck (one sigma in the document) and stops
   * resolving the moment there are two.
   */
  const addressOf = (id: RowId): string | null => {
    const named = store.resolution().items.get(id)?.name;
    if (named != null) return named;
    const parsed = parseRow(store.rows().find((row) => row.id === id)?.source() ?? "").row;
    return parsed && "name" in parsed ? parsed.name : null;
  };

  const isBlank = (text: string) => splitHost(text).body.trim() === "";

  /**
   * Whether a row written at `path` is inside the scope addressed by `address`.
   *
   * The address is the open object's **qualified** name — `A`, or `A:sigma` — which is exactly the
   * prefix its rows carry, so this is a question about one string being a scope-prefix of another.
   * `A` holds `A:sigma:` and does not hold `AB:`, which is why the test is segment-wise rather
   * than `startsWith`.
   */
  const withinScope = (path: readonly string[], address: string): boolean => {
    const outer = address.split(":");
    if (outer.length > path.length) return false;
    return outer.every((segment, index) => path[index] === segment);
  };

  const ensureTrailingCell = () => {
    const rows = store.rows();
    const trailing: RowId[] = [];
    for (let i = rows.length - 1; i >= 0; i--) {
      if (!isBlank(rows[i]!.source())) break;
      trailing.push(rows[i]!.id);
    }
    if (trailing.length === 0) {
      store.addRow(blankRow());
      return true;
    }
    let changed = false;
    // Keep the LAST empty cell rather than the first, so the one the user is looking at survives.
    for (const id of trailing.slice(1)) {
      /**
       * Never collapse the cell the caret is in.
       *
       * Without this, CLEARING a cell just above the trailing blank makes it a trailing blank
       * too — and it would be deleted mid-keystroke, out from under the user. Emptying a cell
       * has to be a survivable state, because it is on the way to retyping it.
       */
      if (views.get(id)?.input === globalThis.document.activeElement) continue;
      store.removeRow(id);
      dropView(id);
      changed = true;
    }
    return changed;
  };

  /**
   * Forget a row entirely: its DOM, its card, and anything it registered with the animator.
   *
   * The animator outlives the row list, so a ticker left behind goes on asking for frames for a
   * row that no longer exists — which keeps the frame loop running for nothing. Dropping a view
   * is the one place that can know, so it is the one place that does it.
   */
  const dropView = (id: RowId) => {
    const view = views.get(id);
    if (!view) return;
    view.root.remove();
    view.details.remove();
    views.delete(id);
    options.animator.unregisterTicker(`flow:${id}`);
    options.animator.unregister(`row:${id}`);
    if (selectedId === id) select(null);
  };

  const syncRows = () => {
    // Before laying anything out, so the new blank cell is created in the same pass and the list
    // is only walked once.
    ensureTrailingCell();
    const rows = store.rows();
    const seen = new Set<RowId>();

    for (const row of rows) {
      seen.add(row.id);
      if (!views.has(row.id)) {
        const view = createRowView(row.id);
        views.set(row.id, view);
        // Every row's details block joins the card immediately and stays there; only visibility
        // changes with selection, so nothing is ever reparented out from under a focused field.
        view.details.classList.add("props__body--hidden");
        cardBody.append(view.details);
      }
    }
    for (const id of [...views.keys()]) {
      if (!seen.has(id)) dropView(id);
    }
    /**
     * Move only the rows that are actually in the wrong place.
     *
     * `append` on an element that is already a child is a **move**: the browser detaches and
     * reinserts it, which blurs any focused descendant. An earlier version re-appended every view
     * whenever the order differed at all — and typing the first letter into the trailing cell
     * creates the next one, so the order differed on that keystroke and the focused input was
     * detached out from under the caret. That is the bug where a cell defocused as soon as you
     * typed in it.
     *
     * So this walks the two lists together and inserts only where they disagree. Appending a new
     * cell at the end now touches nothing else, which is the overwhelmingly common case.
     */
    const desired = rows.map((row) => views.get(row.id)).filter((view) => view !== undefined);
    let cursor = rowHost.firstChild;
    for (const view of desired) {
      if (cursor === view!.root) {
        cursor = cursor.nextSibling;
        continue;
      }
      rowHost.insertBefore(view!.root, cursor);
    }
  };

  function createRowView(id: RowId): RowView {
    const row = store.rows().find((candidate) => candidate.id === id)!;

    /**
     * A textarea, not an input, so a formula can be laid out over several lines.
     *
     * The lexer already skips newlines, so multi-line text was always parseable — the only thing
     * standing in the way was a single-line field to type it into. Enter therefore inserts a line
     * break rather than committing; Escape leaves the cell.
     */
    const input = el("textarea", {
      class: "field field--mono row__input",
      value: row.source(),
      spellcheck: "false",
      rows: 1,
      placeholder: "X(u,v) = (…, …, …)",
      onInput: () => {
        row.source.set(input.value);
        // Only this row's echo can have changed, so only this row's echo is re-typeset.
        // Re-rendering every row's KaTeX on each keystroke was a measurable cost for text
        // that did not move.
        refreshEcho(views.get(id));
        // Typing into the last cell opens the next one. `syncRows` is only called when that
        // actually changed something, so an ordinary keystroke costs nothing extra.
        if (ensureTrailingCell()) syncRows();
        autoSize(input);
        options.onEdit(false);
      },
    }) as HTMLTextAreaElement;

    const echo = el("div", { class: "formula__echo" });
    const badge = el("span", { class: "row__badge" });
    const notes = el("div", { class: "row__notes" });
    const domainHost = el("div", { class: "row__domain" });
    const frameHost = el("div", { class: "row__frame" });
    const valueHost = el("div", { class: "row__value" });
    const chartHost = el("div", { class: "row__chart" });
    const overlayHost = el("div", { class: "row__overlay" });
    const flowHost = el("div", { class: "row__flow" });
    const planeHost = el("div", { class: "row__chart" });

    /**
     * Step into this space.
     *
     * A space draws nothing of itself — the axes are what you see when you are in one — so it is
     * the one object that cannot be entered by double-clicking it on the stage. The button is on
     * the **cell**, where the row that declares the space is, and it is shown for no other kind:
     * every other object is entered by double-clicking the thing itself.
     */
    const enterSpace = el("button", {
      class: "row__move row__enter",
      title: "open this ambient space",
      text: "\u2197",
      hidden: true,
      onClick: (event: Event) => {
        event.stopPropagation();
        options.onEnterSpace?.(id);
      },
    }) as HTMLButtonElement;

    const remove = el("button", {
      class: "row__remove",
      title: "remove this expression",
      text: "×",
      onClick: (event: Event) => {
        // Removing is not selecting: without this the click would also open the card for a row
        // that is about to stop existing.
        event.stopPropagation();
        store.removeRow(id);
        dropView(id);
        options.onEdit(false);
      },
    });

    /**
     * Duplicate this cell, and everything that is drawn on it, right below itself.
     *
     * A surface is usually explored by variation — the same map with one component changed — and
     * retyping a parametrization to compare two of them is the slowest thing in the tool. So the
     * copy is a copy of the *object*, not of the line of text: its domain, its colour, what of it
     * is drawn, its overlays, and every row stated in its chart, re-pointed at the copy. A copy
     * that came back as a bare formula on the default domain was not the surface you were looking
     * at, and reproducing it by hand is the work this exists to avoid.
     *
     * What is deliberately NOT copied is the parameters. `X: (u − a)² + (v − b)² = r²` copied onto
     * the new patch still reads `a`, `b` and `r`, so one slider moves both circles — which is what
     * makes the two objects comparable, and is the reason for copying a surface in the first place.
     */
    const duplicate = el("button", {
      class: "row__move",
      title: "duplicate this expression and everything drawn on it",
      text: "\u29c9",
      onClick: (event: Event) => {
        event.stopPropagation();
        const source = store.rows().find((candidate) => candidate.id === id)?.source() ?? "";
        /**
         * The copy gets a name of its own.
         *
         * Two rows declaring `X` is one definition overwritten, not two objects — so a duplicate
         * that kept its name would look like a copy and behave like a typo. Which sequence to
         * draw from follows the row's arity: two arguments is a surface, one is a curve.
         */
        const parsed = parseRow(source).row;
        const isCurve = parsed?.kind === "vectorFunction" && parsed.args.length === 1;
        const named = parsed && "name" in parsed ? parsed.name : null;
        const newName = nextName(isCurve ? CURVE_NAMES : SURFACE_NAMES, usedNames(store));
        const copy = store.addRow(renameDeclaration(source, newName));
        carryRowState(id, copy.id);

        /**
         * The rows stated in this patch's chart, re-pointed at the copy.
         *
         * Found by the name they name, which is the whole binding — nothing else has to be kept in
         * step. Each keeps its own domain and colour, and one that declares a name gets a fresh
         * one, since two `alpha`s is one curve overwritten.
         */
        const drawn: RowId[] = [];
        if (named !== null) {
          for (const other of store.rows()) {
            if (other.id === id) continue;
            const text = other.source();
            if (parseRow(text).host !== named) continue;
            const body = parseRow(text).row;
            const renamed =
              body && "name" in body
                ? renameDeclaration(
                    text,
                    nextName(
                      body.kind === "vectorFunction" && body.args.length === 1
                        ? CURVE_NAMES
                        : SURFACE_NAMES,
                      usedNames(store),
                    ),
                  )
                : text;
            const made = store.addRow(rehost(renamed, newName));
            carryRowState(other.id, made.id);
            drawn.push(made.id);
          }
        }

        // Straight below the original rather than at the end, so a comparison stays side by side,
        // and its own curves straight below it in the order they were written.
        const index = store.rows().findIndex((candidate) => candidate.id === id);
        for (const [offset, moving] of [copy.id, ...drawn].entries()) {
          const at = store.rows().findIndex((candidate) => candidate.id === moving);
          store.moveRow(moving, index + 1 + offset - at);
        }
        syncRows();
        options.onEdit(false);
        select(copy.id);
      },
    });

    const shift = (delta: number, label: string, title: string) =>
      el("button", {
        class: "row__move",
        title,
        text: label,
        onClick: (event: Event) => {
          event.stopPropagation();
          store.moveRow(id, delta);
          syncRows();
          options.onEdit(false);
        },
      });

    /**
     * A cell is the input and its typeset echo, nothing else.
     *
     * The kind label and the diagnostics used to sit here; both moved to the card, so the bar
     * reads as a column of cells rather than as a stack of little reports. The echo stays,
     * because it is the only thing that shows how a formula was PARSED — implicit multiplication
     * and precedence stop being frightening exactly when you can see them resolved.
     *
     * The row tools appear on hover, so the resting state of the bar has no chrome at all.
     */
    /**
     * A cell shows its TYPESET form, and swaps to the raw text only while being edited.
     *
     * Showing both at once said everything twice. Which one is visible is driven by an explicit
     * class rather than by `:focus-within`, because CSS alone cannot work here: an input hidden
     * with `display: none` cannot be focused, so the click handler has to reveal it *before*
     * calling focus.
     */
    const paramHost = el("div", { class: "row__params" });

    const enterEdit = () => {
      /**
       * Lay a surface out before showing it, so the text being edited matches the shape of the
       * typeset form above it.
       *
       * Formatting only on blur left a gap: anything that arrived already written on one line —
       * a template, a pasted formula, a cell never yet edited — opened as a single dense line
       * even though its preview was the multi-line map. Doing it on the way IN as well means the
       * two views always agree, and since the formatter is idempotent this costs nothing for a
       * cell that has been edited before.
       */
      const formatted = formatSurfaceSource(input.value);
      if (formatted !== null && formatted !== input.value) {
        input.value = formatted;
        row.source.set(formatted);
      }
      root.classList.add("row--editing");
      autoSize(input);
      input.focus();
    };

    /**
     * Does this click belong to a control rather than to the cell?
     *
     * A cell contains sliders, transport buttons, number fields and toggles, and a click on any
     * of them was reaching the row's own handler and calling `enterEdit` — which focuses the text
     * input and takes the click with it. Pressing pause moved the caret instead of pausing, and
     * dragging a slider would have been stolen the same way.
     *
     * Checked with `closest` rather than by comparing against the target directly, because the
     * clickable thing is often a child: the glyph inside a button, the text inside a label.
     */
    const isControl = (target: EventTarget | null) =>
      target instanceof Element &&
      target.closest("input, button, select, textarea, label, .slider, .transport") !== null;
    input.addEventListener("keydown", (event: KeyboardEvent) => {
      /**
       * Shift+Enter runs the cell; plain Enter inserts a line break.
       *
       * That way round because a cell is now multi-line and laying a surface out over several
       * lines is the ordinary case — if Enter committed, writing the thing the format exists for
       * would need a modifier. Blur does the work: it reformats, re-renders and drops back to the
       * typeset view, so "run" is exactly "leave the cell".
       */
      if (event.key === "Enter" && event.shiftKey) {
        event.preventDefault();
        input.blur();
        return;
      }
      if (event.key === "Escape") input.blur();
    });

    input.addEventListener("blur", () => {
      root.classList.remove("row--editing");
      /**
       * Reformat on leaving the cell, never while typing.
       *
       * Rewriting the text under a caret would be hostile — the same reason the smart
       * constructors preserve term order rather than sorting. Blur is the moment the user has
       * finished saying what they meant, so it is the only safe place to say it back to them.
       */
      const formatted = formatSurfaceSource(input.value);
      if (formatted !== null && formatted !== input.value) {
        input.value = formatted;
        row.source.set(formatted);
        refreshEcho(views.get(id));
        options.onEdit(false);
      }
      autoSize(input);
      // An empty cell has no typeset form to fall back to, so it keeps showing its input.
      syncEditing(views.get(id));
    });

    /**
     * The colour the object is drawn in, shown on the cell that defines it.
     *
     * A dot in a gutter down the left, the way a graphing calculator does it — because the
     * question "which of these is the blue one" is asked constantly and answering it should not
     * require selecting a row and reading a panel. The dot is a **readout**: it shows the colour
     * the scene actually used, which for a curve is a palette entry decided by document order and
     * for a patch is the shade under the curvature map. Changing it is the pencil's job, so that
     * a stray click on a cell cannot repaint an object.
     */
    const colorDot = el("button", {
      class: "gutter__dot",
      title: "draw this object",
      onClick: (event: Event) => {
        event.stopPropagation();
        toggleDrawn(id);
      },
    }) as HTMLButtonElement;

    const colorField = el("input", {
      type: "color",
      class: "gutter__input",
      // Off-screen rather than `display: none`: a hidden input cannot be opened by `click()` in
      // every browser, and this one exists precisely to be opened by the pencil.
      value: toHex(options.colors.get(id) ?? defaultColorFor(id)),
      onInput: () => applyColor(id, fromHex(colorField.value)),
    }) as HTMLInputElement;

    /**
     * Drawn rather than typed.
     *
     * `✎` is a text glyph, and a text glyph is only there if the reader's font has it — which is
     * how this arrived as an invisible button. An inline SVG is the same fourteen pixels in every
     * font on every platform.
     */
    const pencil = el("button", {
      class: "gutter__pencil",
      title: "change this object's colour",
      html:
        '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">' +
        '<path fill="currentColor" d="M11.6 1.6a1.4 1.4 0 0 1 2 0l.8.8a1.4 1.4 0 0 1 0 2' +
        'l-.9.9-2.8-2.8.9-.9zM9.8 3.4l2.8 2.8-6.5 6.5-3.5.7.7-3.5 6.5-6.5z"/></svg>',
      onClick: (event: Event) => {
        event.stopPropagation();
        colorField.click();
      },
    }) as HTMLButtonElement;

    /**
     * The eye: whether this object is drawn at all.
     *
     * Distinct from the dot, which for a patch takes the **face** off and leaves the grid — the
     * outline is the half worth keeping when you are looking past a surface. The eye is the
     * blunt one: closed, the row draws nothing, whatever kind of thing it is. It exists because
     * everything a document holds is now on the stage at once, including what was built inside an
     * ambient space, and the answer to "there is too much on screen" has to be a switch the user
     * operates rather than a rule about which kinds of row are real.
     */
    const eye = el("button", {
      class: "gutter__eye",
      title: "hide this object",
      onClick: (event: Event) => {
        event.stopPropagation();
        toggleHidden(id);
      },
    }) as HTMLButtonElement;

    const gutter = el("div", { class: "row__gutter" }, [colorDot, pencil, eye, colorField]);

    const root = el("div", {
      class: "row row--editing",
      onClick: (event: Event) => {
        // Selecting is always right — clicking a row's slider is still a statement about which
        // object you are working on. Opening the window over it is not.
        select(id, false);
        if (isControl(event.target)) return;
        if (!root.classList.contains("row--editing")) enterEdit();
      },
    }, [
      gutter,
      el("div", { class: "row__body" }, [
      input,
      echo,
      el("div", { class: "row__tools" }, [
        enterSpace,
        duplicate,
        shift(-1, "\u2191", "move up"),
        shift(1, "\u2193", "move down"),
        remove,
      ]),
      /**
       * The flow transport lives **on the cell**, like the sliders.
       *
       * It was in the properties card first, which was wrong twice: the floating card hides its
       * tray on purpose, so the button was invisible in the default placement — and even in the
       * top bar it is a control you reach for while looking at the row it belongs to. A field's
       * flow is to that row what a slider is to a numeric one: the thing the row does, offered
       * where the row is. Only one copy exists, because a second would paint its own play/pause
       * state and the two would disagree the moment either was pressed.
       */
      flowHost,
      // Sliders belong to the cell that introduced them, directly beneath it.
      valueHost,
      paramHost,
      ]),
    ]);

    /**
     * The colour every drawn part of this row takes.
     *
     * A native colour input rather than a palette: it costs one element, it is keyboard and
     * screen-reader accessible for free, and it does not constrain the user to swatches we
     * happened to choose.
     */
    const colorSwatch = el("input", {
      type: "color",
      class: "props__color",
      title: "this object's colour; choosing one paints the surface solid",
      value: toHex(options.colors.get(id) ?? defaultColorFor(id)),
      onInput: () => applyColor(id, fromHex(colorSwatch.value)),
    }) as HTMLInputElement;

    /**
     * Paint K, or show the object's own colour.
     *
     * The colour map menu already expresses this and four other choices, but reaching for a menu
     * to answer "is this thing curved" is the wrong shape of interaction for the question people
     * ask most. The chip drives the MENU rather than the overlay directly — the overlay controls
     * rewrite all their state on every commit, so setting it behind the menu's back would leave
     * that local stale and the next slider drag would silently undo this.
     */
    const curvatureChip = el("button", {
      class: "chip",
      text: "K",
      title: "paint Gaussian curvature on the surface",
    }) as HTMLButtonElement;
    curvatureChip.addEventListener("click", (event: Event) => {
      event.stopPropagation();
      const select = views.get(id)?.colormapSelect;
      if (select) {
        // A patch has the colour-map menu, and the chip drives THAT rather than the record: the
        // overlay controls rewrite all their state from their own locals on every commit, so
        // setting the map behind the menu's back would be undone by the next slider drag.
        const turningOn = select.value === "solid";
        select.value = turningOn ? "curvature" : "solid";
        select.dispatchEvent(new Event("change"));
        curvatureChip.classList.toggle("chip--on", turningOn);
        return;
      }
      /**
       * A level set has no such menu — none of the overlay tools apply to it — so the chip is the
       * only control for its colour map and writes the record directly. Safe precisely because
       * there are no closure locals to go stale against.
       */
      const current = options.overlays.get(id) ?? EMPTY_OVERLAY;
      const turningOn = (current.colormap ?? "curvature") === "solid";
      options.overlays.set(id, {
        ...current,
        colormap: turningOn ? "curvature" : "solid",
      });
      curvatureChip.classList.toggle("chip--on", turningOn);
      options.onEdit(false);
    });

    /**
     * What of THIS patch is drawn: its shaded face, its chart grid.
     *
     * Per patch rather than per scene, which is the whole point: hiding one tube's face is how
     * you see the geodesic running inside it, or the far wall of a cobordism, while everything
     * around it stays solid. Both off draws nothing at all, and the patch's curves stay.
     */
    const styleChip = (
      key: "fill" | "grid",
      label: string,
      title: string,
    ): HTMLButtonElement => {
      const chip = el("button", {
        class: "chip chip--on",
        text: label,
        title,
      }) as HTMLButtonElement;
      chip.addEventListener("click", (event: Event) => {
        event.stopPropagation();
        const overlay = options.overlays.get(id) ?? EMPTY_OVERLAY;
        const next = !(overlay[key] ?? true);
        options.overlays.set(id, { ...overlay, [key]: next });
        chip.classList.toggle("chip--on", next);
        // Nothing reparses: only what is drawn changed, so this takes the throttled path.
        options.onParameterChange();
      });
      return chip;
    };

    /**
     * Glyphs, not words — a filled square for the face, a ruled one for the grid.
     *
     * The same rule the overlay tools follow: the symbol IS the label, and what makes that
     * legitimate rather than merely terse is that each carries its full description on hover. Two
     * short words either side of a coloured swatch read as a sentence fragment; two squares that
     * look like what they turn on read as a pair of switches, which is what they are.
     */
    const fillChip = styleChip(
      "fill",
      "\u25fc",
      "the face \u2014 draw this patch's surface; off leaves its grid alone, drawn through",
    );
    const gridChip = styleChip(
      "grid",
      "\u25a6",
      "the grid \u2014 draw the (u, v) grid, and the border of the domain, on this patch",
    );

    /**
     * A curve on this patch, written the way one is written: **a relation in (u, v)**.
     *
     * `(u − a)² + (v − b)² = 1` is a curve on the surface, and it is a curve *nothing else can
     * say* — a parametrized `t ↦ (u(t), v(t))` has to be solved for by hand, while a relation
     * lets you state the condition and drag its constants around. The level set is traced by
     * marching squares over the chart and pushed forward, so a relation with no closed form is no
     * harder than a circle.
     *
     * All the button does is open a cell with `X:` already in it, in edit mode. Which chart a
     * relation lives in is not something the formula can say — so the *row* says it, and the
     * button's whole job is writing the part that names this patch and leaving the caret after
     * it. Nothing is bound behind the scenes: the binding is the text, which means it is visible,
     * editable, saved with the document and undone with it.
     */
    const addRelation = el("button", {
      class: "chip",
      text: "+ relation",
      title: "a curve in this patch's chart, as a relation between u and v",
      onClick: (event: Event) => {
        event.stopPropagation();
        const name = addressOf(id);
        if (name === null) return;
        const opened = store.addRow(`${name}: `);
        syncRows();
        options.onEdit(false);
        select(opened.id);
        const view = views.get(opened.id);
        if (!view) return;
        view.enterEdit();
        // After the prefix, not over it: the patch is settled and the relation is what is being
        // written.
        view.input.setSelectionRange(view.input.value.length, view.input.value.length);
      },
    }) as HTMLButtonElement;

    /**
     * The tangent plane at a point of this patch, `T_(u₀, v₀) X`.
     *
     * Opened at the **centre of the domain**, for the same reason the geodesic spray starts
     * there: a control that needs a point picked before it shows anything is a control that shows
     * nothing, and the centre needs no interaction and is reproducible from the document alone.
     * Like the relation button, all this writes is text — the point is two numbers in the row, so
     * it can be edited, given a parameter to slide along, saved and undone like anything else.
     */
    const addTangent = el("button", {
      class: "chip",
      text: "+ tangent",
      title: "the tangent plane at a point of this patch's chart",
      onClick: (event: Event) => {
        event.stopPropagation();
        const name = addressOf(id);
        if (name === null) return;
        const ranges = options.domains.get(id);
        const centre = (index: number, fallback: readonly [number, number]) => {
          const range = ranges?.[index];
          const middle = range
            ? (range.min + range.max) / 2
            : (fallback[0] + fallback[1]) / 2;
          return Number(middle.toFixed(3));
        };
        /**
         * Written with the **prefix** spelling, `A:sigma: T_(u₀, v₀)`, rather than by naming the
         * patch after the parenthesis. Both spellings mean one row, but only the prefix can carry
         * an address: a trailing name is one identifier, and `A:sigma` is two.
         */
        const opened = store.addRow(
          `${name}: T_(${centre(0, DEFAULT_DOMAIN["u"]!)}, ${centre(1, DEFAULT_DOMAIN["v"]!)})`,
        );
        syncRows();
        options.onEdit(false);
        select(opened.id);
        const view = views.get(opened.id);
        if (!view) return;
        view.enterEdit();
        view.input.setSelectionRange(view.input.value.length, view.input.value.length);
      },
    }) as HTMLButtonElement;

    /**
     * A vector field along this patch, opened as its own **coordinate field** ∂X/∂v.
     *
     * A field has to be tangent to mean anything on a surface, and no generic default is: the
     * only vectors that are tangent to an arbitrary patch are the ones built from its own
     * derivatives. So the button differentiates the row's formula — symbolically, through the
     * same CAS the geometry runs on — and writes the result as ambient components. `∂X/∂v` is
     * exactly the coordinate field do Carmo calls X_v, it is tangent by construction, and it is
     * the field you want to see first on any patch: the v-curves it flows along are the chart's
     * own grid lines.
     *
     * What is written is ordinary text with no closed-form dependence on the row it came from —
     * edit either afterwards and they part company, which is the honest behaviour for something
     * the user is meant to take over.
     */
    const addField = el("button", {
      class: "chip",
      text: "+ field",
      title: "a vector field along this patch, written in the coordinates of R³",
      onClick: (event: Event) => {
        event.stopPropagation();
        const parsed = parseRow(row.source()).row;
        if (!parsed || parsed.kind !== "vectorFunction" || parsed.args.length !== 2) return;
        const along = parsed.args[1] ?? "v";
        const derivative = parsed.comps.map((comp) => toSource(simplify(diff(comp, along))));
        /**
         * A patch built on a user-defined function cannot be differentiated symbolically — the
         * CAS answers NaN there, keeping the non-finite contract — so rather than opening a row
         * that says NaN, the field falls back to a constant one. It is not tangent, and the
         * scene will say so, which is a better starting point than a formula that draws nothing.
         */
        const usable = derivative.every((text) => !text.includes("NaN"));
        const opened = store.addRow(
          `${addressOf(id) ?? parsed.name}: VectorField(${
            usable ? derivative.join(", ") : "0, 0, 1"
          })`,
        );
        syncRows();
        options.onEdit(false);
        select(opened.id);
        const view = views.get(opened.id);
        if (!view) return;
        view.enterEdit();
        view.input.setSelectionRange(view.input.value.length, view.input.value.length);
      },
    }) as HTMLButtonElement;

    /**
     * "Show me all of it", for a level set.
     *
     * Its domain sliders are a **window**, not a domain — the surface is wherever F vanishes, and
     * the box only says where to look. So the one request three sliders cannot express is "as far
     * as it goes, in every direction", and this is that request: the scene sweeps a wide reach,
     * finds where the surface crosses, and frames exactly that. A bounded surface comes back
     * framed; an unbounded one — a plane, a triply periodic minimal surface — fills the sweep, so
     * you see it spanning every direction rather than cut to a domain nobody chose.
     *
     * The sliders keep their values while it is on, so turning it off puts the old window back
     * rather than having overwritten it.
     */
    const fitChip = el("button", {
      class: "chip",
      title:
        "show the whole surface, spanning every direction \u2014 the box is found rather than " +
        "taken from the sliders",
      html:
        '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">' +
        '<path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" ' +
        'd="M2 5.5V2h3.5M10.5 2H14v3.5M14 10.5V14h-3.5M5.5 14H2v-3.5"/>' +
        '<circle cx="8" cy="8" r="2.4" fill="none" stroke="currentColor" stroke-width="1.4"/>' +
        "</svg>",
      onClick: (event: Event) => {
        event.stopPropagation();
        const current = options.overlays.get(id) ?? EMPTY_OVERLAY;
        const wanted = !(current.autoBox ?? false);
        options.overlays.set(id, { ...current, autoBox: wanted });
        fitChip.classList.toggle("chip--on", wanted);
        options.onEdit(false);
      },
    }) as HTMLButtonElement;

    const detailsTitle = el("span", { class: "props__kind", text: "expression" });

    /**
     * Split in two: the window holds the domain, everything else floats beside it.
     *
     * The sliders are what you reach for constantly and what needs room; the chips and menus are
     * occasional and already carry their own outlines, so they read as buttons without a panel
     * around them. Keeping them out of the box is what lets the box be small.
     */
    /**
     * Split in two, and in the window only the first half is shown.
     *
     * The domain is what you reach for constantly and what needs room. Everything else — the
     * readouts, the colour, the overlay tools — is occasional, and crowding it around two sliders
     * made the window worse at the one job it has. The tray still exists and is still built, so
     * the top-bar placement keeps every control; the window is deliberately the minimal form.
     */
    /**
     * Split in two: what floats at the pointer, and what does not.
     *
     * The domain and the colour are the two things you reach for while looking AT an object — one
     * changes what part of it you see, the other how you tell it from the one beside it. The rest
     * is occasional and stays in the tray, which the floating form hides and the top bar shows.
     */
    const details = el("div", { class: "props__body" }, [
      el("div", { class: "props__panel-body" }, [
        domainHost,
        /**
         * The buttons sit to the RIGHT of the sliders, in two rows of their own.
         *
         * The domain is two wide tracks stacked; beside them there is exactly the room for two
         * short rows, and putting them there costs no height at all — the block is shorter than
         * the sliders it stands next to. Below them it added a third line to a panel that floats
         * under the pointer, which is the one place height is expensive.
         */
        el("div", { class: "props__chips" }, [
          el("div", { class: "props__swatches" }, [colorSwatch, curvatureChip]),
          /**
           * What of the patch is drawn, on the second row rather than the first.
           *
           * They answer a different question from the two above them: those are how this object
           * looks, these are what there is to look at.
           */
          el("div", { class: "props__swatches props__tools" }, [
            fillChip,
            gridChip,
            addRelation,
            addTangent,
            addField,
            fitChip,
          ]),
        ]),
      ]),
      el("div", { class: "props__tray" }, [notes, chartHost, planeHost, overlayHost, frameHost]),
    ]);

    return {
      id,
      root,
      input,
      enterEdit,
      echo,
      badge,
      notes,
      domainHost,
      frameHost,
      valueHost,
      chartHost,
      planeHost,
      overlayHost,
      flowHost,
      flowBuilt: false,
      arrowChip: null,
      details,
      colorSwatch,
      colorDot,
      eye,
      enterSpace,
      colorField,
      gutter,
      curvatureChip,
      fillChip,
      gridChip,
      addRelation,
      addTangent,
      addField,
      fitChip,
      colormapSelect: null,
      detailsTitle,
      paramHost,
      overlayBuilt: false,
      paramNames: "\u0000",
      domainVars: "",
      domainLimits: [],
      domainThumbs: [],
      valueName: "",
    };
  }

  /**
   * Play, pause and rewind for one slider.
   *
   * The play button's label is the only state here that must be kept in step, and it is read
   * back from the animator rather than tracked separately — two copies of "is this playing" is
   * exactly the kind of thing that drifts apart.
   */
  /**
   * Every transport's speed menu, so setting one sets them all.
   *
   * The animator runs a single clock — two sweeps playing together keep their relative rates —
   * but the control has to appear beside each play button, because that is where anyone looks
   * for it. One value, several views of it, kept in step here.
   */
  const SPEEDS: readonly number[] = [0.25, 0.5, 1, 2, 4];

  /**
   * A toolbar chip: a short symbol that toggles, with its meaning in the tooltip.
   *
   * The audience reads mathematics, so the symbols ARE the labels — γ is a geodesic, s is arc
   * length, k₁k₂ are the lines of curvature, N is the Gauss map. Each is a few pixels where the
   * spelled-out phrase was a hundred, and none of them is a guess the reader has to make: the
   * full description is one hover away.
   */
  const chip = (
    symbol: string,
    title: string,
    pressed: boolean,
    onToggle: (next: boolean) => void,
  ): HTMLButtonElement => {
    const button = el("button", {
      class: `chip${pressed ? " chip--on" : ""}`,
      title,
      html: symbol,
    }) as HTMLButtonElement;
    button.addEventListener("click", () => {
      const next = !button.classList.contains("chip--on");
      button.classList.toggle("chip--on", next);
      onToggle(next);
    });
    return button;
  };

  /**
   * The dot turns the object's drawing off, and what that MEANS depends on the object.
   *
   * A patch answers by taking its face off and keeping its grid — the outline is the more useful
   * half of a surface, and it is what you want left behind while looking at whatever the face was
   * covering. A field takes its arrows off, which is the same switch the → chip holds. Everything
   * else — a curve, a point, a tangent plane — has nothing to keep, so it stops being drawn.
   *
   * Every one of these lands in the overlays record, which is keyed by row, snapshotted by undo
   * and saved with the document, so "switched off" is part of the figure rather than a mood the
   * session is in.
   */
  const toggleDrawn = (id: RowId) => {
    const kind = store.resolution().items.get(id)?.kind;
    const current = options.overlays.get(id) ?? EMPTY_OVERLAY;
    if (
      kind === "parametricSurface" ||
      kind === "graphSurface" ||
      kind === "implicitSurface"
    ) {
      options.overlays.set(id, { ...current, fill: !(current.fill ?? true) });
    } else if (kind === "surfaceField") {
      options.overlays.set(id, { ...current, arrows: !(current.arrows ?? true) });
    } else {
      options.overlays.set(id, { ...current, hidden: !(current.hidden ?? false) });
    }
    options.onEdit(false);
  };

  /**
   * Draw this row's object, or stop drawing it — the eye, for every kind of row.
   *
   * One flag (`hidden`) and one writer, so the cell's eye and anything else that ever offers it
   * cannot drift. It lands in the overlays record, which is snapshotted by undo and saved with
   * the document: being switched off is part of the figure rather than a mood the session is in.
   */
  const toggleHidden = (id: RowId) => {
    const current = options.overlays.get(id) ?? EMPTY_OVERLAY;
    options.overlays.set(id, { ...current, hidden: !(current.hidden ?? false) });
    options.onEdit(false);
  };

  /**
   * Give a row a colour, from whichever control asked.
   *
   * One function because there are two ways in — the pencil on the cell and the swatch in the
   * card — and a value with two controls has to be written in one place or they drift. Both are
   * pushed back afterwards, along with the dot that reports the result.
   */
  const applyColor = (id: RowId, color: Vec3) => {
    options.colors.set(id, color);
    const view = views.get(id);
    if (view) {
      const hex = toHex(color);
      if (view.colorField.value !== hex) view.colorField.value = hex;
      if (view.colorSwatch.value !== hex) view.colorSwatch.value = hex;
      view.colorDot.style.background = hex;
    }

    /**
     * Choosing a colour also switches the surface to the solid map.
     *
     * Otherwise the swatch appears broken: a surface is painted with its curvature by default,
     * and that colour is drawn OVER the object's own, so picking one changed something completely
     * hidden. Asking for a colour is a statement that you want to see that colour, and the map
     * menu is right there to go back to K.
     */
    const select = view?.colormapSelect;
    if (select && select.value !== "solid") {
      /**
       * Driven through the menu rather than written to the overlay directly.
       *
       * The overlay controls hold their state in closure locals and write ALL of them on every
       * commit, so setting the map behind the menu's back would leave that local stale and the
       * next slider drag would quietly put the old map back — the same staleness that already
       * cost the picked start point and the aimed shots.
       */
      select.value = "solid";
      select.dispatchEvent(new Event("change"));
      return;
    }
    options.onParameterChange();
  };

  const transport = (key: string): HTMLElement => {
    const play = el("button", {
      class: "transport__button",
      title: "play / pause",
      text: options.animator.playing(key) ? "\u275a\u275a" : "\u25b6",
    });
    const paint = () => {
      const active = options.animator.playing(key);
      play.textContent = active ? "\u275a\u275a" : "\u25b6";
      play.classList.toggle("transport__button--active", active);
    };
    play.addEventListener("click", () => {
      options.animator.toggle(key);
      paint();
    });
    paint();

    const rewind = el("button", {
      class: "transport__button",
      title: "back to the start of the range",
      text: "\u25c0\u25c0",
      onClick: () => options.animator.rewind(key),
    });

    const speed = el("select", {
      class: "transport__speed",
      title: "animation speed",
    }) as HTMLSelectElement;
    for (const value of SPEEDS) {
      speed.append(el("option", { value: String(value), text: `${value}\u00d7` }));
    }
    /**
     * The value is set as a **property**, after the options exist.
     *
     * `selected` through `setAttribute` sets an option's *default*, which is not the same thing
     * and is not honoured everywhere — the same trap as a textarea's `value`, which `dom.ts`
     * special-cases for exactly this reason. Assigning the select's value afterwards is the one
     * form that means "this is the current choice" in every environment.
     */
    speed.value = String(options.animator.speed(key));
    /**
     * Each transport sets its own rate.
     *
     * They were kept in step first, on the reasoning that two things playing together are being
     * compared. Usually they are not: a document has several sliders and several flows, about
     * different questions, and one dial made every choice a compromise between unrelated
     * animations.
     */
    speed.addEventListener("change", () => {
      options.animator.setSpeed(key, Number(speed.value));
    });

    return el("div", { class: "transport" }, [speed, rewind, play]);
  };

  /**
   * One slider per undefined symbol.
   *
   * Names *declared* by a numeric row are excluded: those already have a slider on the row
   * that declares them, and showing a second one for the same name would be two controls
   * fighting over one value.
   */
  /**
   * Where a new parameter's track should run, when the row using it says which chart it is in.
   *
   * `X: (u − a)² + (v − b)² = r²` puts `a` and `b` in X's chart, so ±5 is the wrong track twice
   * over: it hides most of a domain that runs to 2π and wastes most of one that runs to 1. The
   * reach past each end is a third of the smaller side — the size of a curve that fits the patch
   * — which is about where the last of such a curve leaves the chart and there is nothing more to
   * see. The first name gets the u range and the second the v range: right for a circle, a guess
   * for anything else, and a cheap guess now that both ends of a track can be typed.
   */
  const seededSpec = (name: string): SliderSpec | null => {
    for (const item of store.resolution().items.values()) {
      if (!item.host || !item.params.includes(name)) continue;
      const patch = [...store.resolution().items.values()].find(
        (candidate) => candidate.name === item.host,
      );
      const ranges = patch ? options.domains.get(patch.rowId) : undefined;
      const u = ranges?.[0];
      const v = ranges?.[1];
      if (!u || !v) return null;
      const range = item.params.indexOf(name) % 2 === 0 ? u : v;
      const reach = Math.min(Math.abs(u.max - u.min), Math.abs(v.max - v.min)) / 3 || 1;
      const lo = Math.min(range.min, range.max) - reach;
      const hi = Math.max(range.min, range.max) + reach;
      return { value: (range.min + range.max) / 2, min: lo, max: hi, step: (hi - lo) / 200 };
    }
    return null;
  };

  const syncSliders = (names: readonly string[]) => {
    for (const name of names) {
      if (!options.sliders.has(name)) {
        // A fresh parameter starts at 1 over a symmetric range — usable for a radius, a
        // pitch or a coefficient without asking the user to specify bounds first.
        options.sliders.set(
          name,
          seededSpec(name) ?? { value: 1, min: -5, max: 5, step: 0.01 },
        );
        store.setParameter(name, options.sliders.get(name)!.value);
      }
    }
    for (const name of [...options.sliders.keys()]) {
      if (!names.includes(name)) {
        options.sliders.delete(name);
        options.animator.unregister(`param:${name}`);
      }
    }

    // Rebuilt only when the set of parameters changes. Otherwise a refresh mid-drag would
    // replace the very range input being dragged.
    const signature = names.join(",");
    if (signature === renderedSliders) return;
    renderedSliders = signature;

  };

  /**
   * The sliders for the parameters ONE row uses, in that row's card.
   *
   * A parameter shared by two rows appears in both cards and drives the same value, which is the
   * honest presentation: it really is one number, and seeing it from either object that depends
   * on it is more useful than hiding it in a list far from both.
   */
  const syncRowParams = (view: RowView, item: Item | null) => {
    const names = item
      ? [...item.params].filter((name) => options.sliders.has(name)).sort()
      : [];
    const signature = names.join(",");
    // Rebuilt only when the set changes, or a refresh mid-drag would replace the very range
    // input being dragged.
    if (signature === view.paramNames) return;
    view.paramNames = signature;
    // This cell's old controls are about to be thrown away; nothing should keep pushing at them.
    for (const group of paramControls.values()) group.delete(view.id);
    replace(
      view.paramHost,
      names.map((name) => sliderRow(view.id, name, options.sliders.get(name)!)),
    );
  };

  const movingSlider = (config: MovingSliderOptions): MovingSlider => {
    const format = config.format ?? ((value: number) => formatValue(value));
    let min = config.min;
    let max = config.max;

    const bubble = el("span", { class: "vslider__bubble", text: format(config.value) });
    const input = el("input", {
      type: "range",
      class: "vslider__input",
      min,
      max,
      step: config.step,
      value: config.value,
      title: config.title,
    }) as HTMLInputElement;

    /**
     * Where the label sits.
     *
     * At rest it rides the thumb, so a glance reads the value. While the pointer is on the
     * control it follows the POINTER instead — it is a tag on the cursor, which is where the
     * eye already is during a drag, and the thumb can lag the cursor at the ends of the track
     * where a value is most often being aimed at precisely.
     *
     * The correction term is for the thumb case: a thumb's centre travels from half a
     * thumb-width in to half a thumb-width from the end, so a straight percentage drifts off it,
     * worst at exactly those extremes.
     */
    const THUMB = 15;
    const atThumb = (value: number) => {
      const span = max - min;
      const fraction = span > 0 ? (value - min) / span : 0.5;
      const clamped = Math.min(1, Math.max(0, fraction));
      return `calc(${clamped * 100}% + ${(0.5 - clamped) * THUMB}px)`;
    };
    let pointerAt: number | null = null;
    const place = (value: number) => {
      bubble.style.left = pointerAt === null ? atThumb(value) : `${pointerAt}px`;
    };
    place(config.value);

    /**
     * The track's ends are walls, and a drag stops at them.
     *
     * They used to move: pushing the thumb against an end and travelling further outward carried
     * the end along, so the range grew under the pointer. It reads well in a sentence and badly
     * in the hand — the same gesture does something different depending on where the thumb
     * happened to already be, a drag that overshoots silently redefines what the whole track
     * means, and the range you carefully set is undone by the next fling of the mouse. A range is
     * now changed only when you say so: double-click the bubble and type, past an end if you like.
     */
    const followPointer = (event: PointerEvent) => {
      const box = input.getBoundingClientRect();
      const raw = event.clientX - box.left;
      // Clamped to the track: past its ends the value has stopped changing, so a label that kept
      // travelling would point at nothing.
      pointerAt = Math.min(box.width, Math.max(0, raw));
      place(Number(input.value));
    };

    input.addEventListener("pointermove", followPointer);
    input.addEventListener("pointerdown", followPointer);
    /**
     * No pointer capture.
     *
     * It existed so that a drag leaving the track kept stretching the range, and the range does
     * not stretch any more. The browser's own range input already tracks a drag past its edges
     * for the VALUE, which is all that is left to track.
     */
    input.addEventListener("pointerleave", () => {
      pointerAt = null;
      place(Number(input.value));
    });

    input.addEventListener("input", () => {
      const value = Number(input.value);
      bubble.textContent = format(value);
      place(value);
      config.onInput(value);
    });

    const root = el("div", { class: "vslider" }, [bubble, input]);

    /** Double-click to type an exact value, in place of the box this replaced. */
    root.addEventListener("dblclick", (event: Event) => {
      event.preventDefault();
      const field = el("input", {
        type: "number",
        class: "vslider__exact",
        value: Number(input.value),
        step: "any",
      }) as HTMLInputElement;
      field.style.left = bubble.style.left;
      bubble.replaceWith(field);
      field.focus();
      field.select();

      const finish = (accept: boolean) => {
        const typed = Number(field.value);
        field.replaceWith(bubble);
        if (!accept || !Number.isFinite(typed)) return;
        // Typing past an end WIDENS the track. Refusing a value the user asked for is exactly
        // what the removed bounds boxes existed to prevent.
        if (typed < min) min = typed - Math.abs(typed) * 0.2 - 1e-9;
        if (typed > max) max = typed + Math.abs(typed) * 0.2 + 1e-9;
        input.min = String(min);
        input.max = String(max);
        input.value = String(typed);
        bubble.textContent = format(typed);
        place(typed);
        config.onInput(typed);
      };
      field.addEventListener("blur", () => finish(true));
      field.addEventListener("keydown", (keyEvent: KeyboardEvent) => {
        if (keyEvent.key === "Enter") finish(true);
        else if (keyEvent.key === "Escape") finish(false);
      });
    });

    return {
      root,
      input,
      set(value) {
        input.value = String(value);
        bubble.textContent = format(value);
        place(value);
      },
      setRange(nextMin, nextMax, step) {
        min = nextMin;
        max = nextMax;
        input.min = String(min);
        input.max = String(max);
        input.step = String(step);
        // The browser clamps a range input's value into its new bounds silently; reading it back
        // is what keeps the bubble on the thumb rather than beside it.
        const value = Number(input.value);
        bubble.textContent = format(value);
        place(value);
      },
    };
  };
  /** Short enough for a box at the end of a track: four figures, no trailing zeros. */
  const trimNumber = (value: number): string =>
    Number.isFinite(value) ? String(Number(value.toPrecision(4))) : "";

  /**
   * The two ends of a track, as fields.
   *
   * A drag moves the value and never the range — that is settled — so the range needs a place to
   * be *said*, and the honest place is the ends themselves. Typing into the bubble already widens
   * the track, but only far enough to hold the number typed; narrowing one, or setting a range
   * before touching the thumb, had nowhere to happen.
   *
   * The value is carried into the new range rather than left outside it, and the step follows the
   * width, so a range of 0…0.01 is not dragged in jumps of the whole track.
   */
  const trackEnds = (
    name: string,
    spec: SliderSpec,
    slider: MovingSlider,
    commit: (value: number) => void,
  ): {
    readonly min: HTMLInputElement;
    readonly max: HTMLInputElement;
    /** Put the spec's ends back in the boxes — for when something else changed them. */
    show(): void;
  } => {
    const fields = {} as { min: HTMLInputElement; max: HTMLInputElement };
    const show = () => {
      for (const end of ["min", "max"] as const) {
        const box = fields[end];
        if (box && globalThis.document.activeElement !== box) box.value = trimNumber(spec[end]);
      }
    };

    for (const which of ["min", "max"] as const) {
      const field = el("input", {
        type: "number",
        class: "slider__limit",
        step: "any",
        value: trimNumber(spec[which]),
        title: `${name} \u2014 ${which} of the track`,
      }) as HTMLInputElement;
      fields[which] = field;

      const apply = () => {
        // A number input sanitizes what it cannot read to the empty string, and `Number("")` is
        // zero — so an emptied box would silently mean an end at the origin.
        const text = field.value.trim();
        const typed = Number(text);
        const other = which === "min" ? spec.max : spec.min;
        // An empty box, a word, or an end laid exactly on the other one: put back what holds.
        if (text === "" || !Number.isFinite(typed) || typed === other) {
          field.value = trimNumber(spec[which]);
          return;
        }
        spec[which] = typed;
        if (spec.min > spec.max) [spec.min, spec.max] = [spec.max, spec.min];
        spec.step = (spec.max - spec.min) / 200;
        spec.value = Math.min(spec.max, Math.max(spec.min, spec.value));
        slider.setRange(spec.min, spec.max, spec.step);
        slider.set(spec.value);
        show();
        commit(spec.value);
      };
      field.addEventListener("change", apply);
      field.addEventListener("keydown", (event: KeyboardEvent) => {
        if (event.key === "Enter") apply();
      });
    }

    return { ...fields, show };
  };

  /**
   * Every control on screen for one parameter, by the row whose cell it sits in.
   *
   * A parameter belongs to the DOCUMENT, not to a row: `k` in two surfaces is one number, and the
   * two rows that use it each show a slider for it. Without this they drift — one card reads
   * 5.65 and the other 8.06 for the same `k` — and since the scene draws the single stored value,
   * at least one of them is lying about what is on screen.
   */
  const paramControls = new Map<
    string,
    Map<RowId, { slider: MovingSlider; ends: { show(): void } }>
  >();

  /** Push a parameter's value and range onto every OTHER control showing it. */
  const broadcastParam = (name: string, from: RowId) => {
    const spec = options.sliders.get(name);
    const group = paramControls.get(name);
    if (!spec || !group) return;
    for (const [rowId, entry] of group) {
      if (rowId === from) continue;
      // Never over a control being held: that is the one place the user is the source of truth.
      if (globalThis.document.activeElement === entry.slider.input) continue;
      entry.slider.setRange(spec.min, spec.max, spec.step);
      entry.slider.set(spec.value);
      entry.ends.show();
    }
  };

  function sliderRow(owner: RowId, name: string, spec: SliderSpec): HTMLElement {
    const slider = movingSlider({
      min: spec.min,
      max: spec.max,
      step: spec.step,
      value: spec.value,
      title: `${name} \u2014 drag, or double-click to type an exact value`,
      onInput: (value) => {
        spec.value = value;
        // A track widened by typing has to be recorded, or the next rebuild narrows it back.
        spec.min = Math.min(spec.min, Number(slider.input.min));
        spec.max = Math.max(spec.max, Number(slider.input.max));
        store.setParameter(name, value);
        broadcastParam(name, owner);
        // Parameters are compiled as slots, so this recompiles nothing.
        options.onParameterChange();
      },
    });

    store.setParameter(name, spec.value);

    // Registered so the animator can drive this slider's DOM directly.
    options.animator.register(`param:${name}`, spec, (value) => {
      slider.set(value);
      store.setParameter(name, value);
      broadcastParam(name, owner);
    });

    const ends = trackEnds(name, spec, slider, (value) => {
      store.setParameter(name, value);
      broadcastParam(name, owner);
      options.onParameterChange();
    });

    let group = paramControls.get(name);
    if (!group) {
      group = new Map();
      paramControls.set(name, group);
    }
    // Keyed by row, so rebuilding one cell's sliders replaces its entry instead of stacking a
    // second dead one behind it.
    group.set(owner, { slider, ends });

    return el("div", { class: "slider" }, [
      el("span", { class: "slider__name" }, [
        tex(name.length === 1 ? name : `\\mathrm{${name}}`),
      ]),
      ends.min,
      slider.root,
      ends.max,
      transport(`param:${name}`),
    ]);
  }

  /** Editable sampling range per parametrization variable. */
  const syncDomain = (view: RowView, item: Item | null) => {
    const vars = item?.vars ?? [];
    const drawable =
      item !== null &&
      (item.kind === "parametricSurface" ||
        item.kind === "graphSurface" ||
        item.kind === "spaceCurve" ||
        item.kind === "planeCurve" ||
        // A level set's "domain" is the box it is searched in — a window rather than something it
        // is a map from — but it is edited with the same two-thumbed sliders.
        item.kind === "implicitSurface");

    // Same rule as the row list: the number inputs are only rebuilt when the variables
    // change, so typing a domain bound is not interrupted by the next refresh.
    const signature = drawable ? vars.join(",") : "";
    if (view.domainVars === signature) return;
    view.domainVars = signature;

    if (!drawable || vars.length === 0) {
      replace(view.domainHost, []);
      return;
    }

    let ranges = options.domains.get(view.id);
    if (!ranges || ranges.length !== vars.length) {
      ranges = vars.map((name) => {
        const fallback = DEFAULT_DOMAIN[name] ?? [0, 2 * Math.PI];
        return { min: fallback[0], max: fallback[1] };
      });
      options.domains.set(view.id, ranges);
    }
    const stored = ranges;

    /**
     * ONE control per variable, with a thumb at each end.
     *
     * An interval is a single thing, and giving it two separate sliders made it look like two
     * unrelated numbers as well as taking twice the room. Two ranges are stacked on a shared
     * track: the inputs ignore the pointer and only their thumbs accept it, which is what lets
     * both be grabbed even though one lies on top of the other.
     *
     * The track spans twice the interval's width either side of it — a domain bound has no
     * natural range of its own, so some guess has to be made — and double-clicking a thumb types
     * an exact value, past the end of the track if need be. What it no longer does is move that
     * end by *dragging* against it: a drag that overshoots should not silently redefine what the
     * whole track means.
     */
    const thumbs: MovingSlider[] = [];
    const limits: HTMLInputElement[] = [];
    replace(
      view.domainHost,
      vars.map((name, index) => {
        const entry = stored[index]!;

        const span = Math.abs(entry.max - entry.min) || 1;
        const centre = (entry.min + entry.max) / 2;
        /**
         * The ends of the track, which are not the bounds the thumbs sit on.
         *
         * A domain bound has no natural range of its own, so some guess has to be made: twice the
         * interval's width either side of it. From then on they are a **static** pair of numbers
         * that only change when they are typed.
         */
        let lo = centre - span * 2;
        let hi = centre + span * 2;

        /**
         * Committed through the PARAMETER path, not the edit path.
         *
         * A domain bound changes nothing about the formula — no reparse, no recompile, only a
         * different sampling interval — so it belongs on the throttled route that renders once
         * per animation frame and upgrades to full resolution when the drag settles. `onEdit`
         * debounces, and a debounce waits for quiet: a held slider produced nothing at all until
         * release and then jumped.
         */
        /**
         * A bound stops where the surface starts overlapping itself.
         *
         * Past one period the parametrization returns to material it has already drawn, so a
         * wider domain tessellates the same surface twice — visibly, as z-fighting and doubled
         * grid lines. The limit is measured per coordinate (`detectPeriod`) and read at the
         * moment of the drag rather than captured, so editing the formula moves the wall with it.
         */
        const limit = (which: "min" | "max", value: number): number => {
          const period = options.periods?.get(view.id)?.[index] ?? null;
          if (period === null || !(period > 0)) return value;
          return which === "max"
            ? Math.min(value, entry.min + period)
            : Math.max(value, entry.max - period);
        };

        const thumb = (which: "min" | "max") => {
          const slider = movingSlider({
            min: lo,
            max: hi,
            step: (hi - lo) / 400,
            value: entry[which],
            title: `${name} ${which} \u2014 drag, or double-click to type an exact value`,
            onInput: (value) => {
              const limited = limit(which, value);
              entry[which] = limited;
              // Pushed back onto the thumb when it was stopped, so the control shows the bound
              // the surface actually has rather than the one the pointer asked for.
              if (limited !== value) slider.set(limited);
              options.onParameterChange();
            },
          });
          thumbs.push(slider);
          return slider;
        };

        const min = thumb("min");
        const max = thumb("max");

        /**
         * The ends of the track, typed — the same control the parameter sliders carry, meaning
         * the same thing in both places.
         *
         * Deliberately NOT the two bounds. A box that followed a thumb would change every time
         * the thumb was dragged, which makes it a second readout of what the bubble already says
         * and leaves nowhere to state the one thing a drag cannot: how far the track reaches. The
         * bounds are the thumbs; these are the scale they are read against.
         */
        const boxes = {} as Record<"min" | "max", HTMLInputElement>;
        const showEnds = () => {
          for (const [which, value] of [["min", lo], ["max", hi]] as const) {
            const field = boxes[which];
            if (field && globalThis.document.activeElement !== field) {
              field.value = trimNumber(value);
            }
          }
        };

        const box = (which: "min" | "max"): HTMLInputElement => {
          const field = el("input", {
            type: "number",
            class: "slider__limit",
            step: "any",
            value: trimNumber(which === "min" ? lo : hi),
            title: `${name} \u2014 ${which} of the track`,
          }) as HTMLInputElement;
          boxes[which] = field;
          limits.push(field);

          const apply = () => {
            // A number input sanitizes what it cannot read to "", and `Number("")` is zero, so an
            // emptied box would silently move an end to the origin.
            const text = field.value.trim();
            const typed = Number(text);
            if (text === "" || !Number.isFinite(typed) || typed === (which === "min" ? hi : lo)) {
              showEnds();
              return;
            }
            if (which === "min") lo = typed;
            else hi = typed;
            if (lo > hi) [lo, hi] = [hi, lo];

            // Both thumbs ride ONE track, so both take the new ends — and a bound left outside
            // them would be a thumb off its own scale, so it comes along.
            for (const [end, slider] of [["min", min], ["max", max]] as const) {
              const held = Math.min(hi, Math.max(lo, entry[end]));
              entry[end] = held;
              slider.setRange(lo, hi, (hi - lo) / 400);
              slider.set(held);
            }
            showEnds();
            options.onParameterChange();
          };
          field.addEventListener("change", apply);
          field.addEventListener("keydown", (event: KeyboardEvent) => {
            if (event.key === "Enter") apply();
          });
          return field;
        };

        /**
         * One box at each END of the row: the lower bound left, the upper bound right.
         *
         * Where a box sits is what says which bound it is — the same order as the thumbs it
         * belongs to, read left to right like the interval itself. Put together at one end they
         * become two numbers in a stack that have to be read to be told apart.
         */
        return el("div", { class: "domain" }, [
          el("span", { class: "domain__var" }, [tex(name)]),
          box("min"),
          el("div", { class: "domain__range" }, [min.root, max.root]),
          box("max"),
        ]);
      }),
    );
    view.domainThumbs = thumbs;
    view.domainLimits = limits;
  };

  /**
   * Put the stored bounds back on the thumbs when something else changed them.
   *
   * Undo, an opened file, a template load and a placed piece all rewrite a domain without
   * touching these controls. A value that no longer fits the track it was built for rebuilds the
   * control instead of being clamped to it silently — and neither happens while a thumb is being
   * held, which would fight the drag.
   */
  const syncDomainValues = (view: RowView) => {
    const ranges = options.domains.get(view.id);
    if (!ranges || view.domainThumbs.length !== ranges.length * 2) return;

    for (const [index, entry] of ranges.entries()) {
      for (const [offset, value] of [entry.min, entry.max].entries()) {
        const slider = view.domainThumbs[index * 2 + offset];
        if (!slider || globalThis.document.activeElement === slider.input) continue;
        if (Number(slider.input.value) === value) continue;
        if (value < Number(slider.input.min) || value > Number(slider.input.max)) {
          // Off the end of its own track: rebuilding is what re-centres it on the new interval.
          view.domainVars = "";
          return;
        }
        slider.set(value);
      }
    }
  };

  /**
   * The moving frame control, on curve rows only.
   *
   * Built once per row and then left alone, like the text input: rebuilding it on every
   * refresh would fight the user mid-drag. The `t` slider redraws immediately rather than
   * on the debounce, since only the three glyphs move.
   */
  /**
   * On a plane-curve row: read its two components as (u, v) instead of as a curve in z = 0.
   *
   * `(cos t, sin t)` is a circle in the plane and also a circle in the chart, and those are
   * completely different objects — the second one wraps around whatever surface the chart
   * belongs to. Only the user knows which they meant, so this is a choice rather than an
   * inference.
   */
  const syncChartToggle = (view: RowView, item: Item | null) => {
    const eligible = item?.kind === "planeCurve";
    if (!eligible) {
      if (view.chartHost.childElementCount > 0) replace(view.chartHost, []);
      options.inChart.delete(view.id);
      seenChartRows.delete(view.id);
      return;
    }
    if (view.chartHost.childElementCount > 0) return;

    // Honour the classifier's reading of intent the first time this row is seen. A curve
    // written in u or v was meant for the chart; one written in t was not.
    if (!seenChartRows.has(view.id)) {
      seenChartRows.add(view.id);
      if (item.chartByDefault) options.inChart.add(view.id);
    }

    const toggle = el("input", {
      type: "checkbox",
      checked: options.inChart.has(view.id),
      onChange: () => {
        if (toggle.checked) options.inChart.add(view.id);
        else options.inChart.delete(view.id);
        options.onEdit(false);
      },
    }) as HTMLInputElement;

    replace(view.chartHost, [
      el("label", { class: "toggle toggle--tight" }, [
        toggle,
        el("span", { text: "read as (u, v) — draw in the chart and on the surface" }),
      ]),
    ]);
  };

  /**
   * Geodesics, lines of curvature and the Gauss map, on surface rows.
   *
   * The curves shoot from `start` when a click has set one, and from the centre of the domain
   * otherwise. The centre is a defined, reproducible place to start from, and
   * moving to click-to-shoot later changes only where the start comes from.
   */
  /**
   * The transport a vector field gets, so its flow can be played.
   *
   * A field held still says where each point *would* go; played, it shows where the points
   * actually go — the one-parameter group the field generates, which is what a field is for.
   * The transport is the same one a slider sweep uses, keyed on the row, so one speed control
   * governs every animation on screen and a flow can be watched beside a parameter sweeping.
   *
   * Built once and left alone: rebuilding it would re-register the ticker mid-flow, and the
   * particles are not in the DOM but they are watching the same clock.
   */
  /**
   * Kinds that put a colour on the screen, and therefore get a dot.
   *
   * A parameter, a definition or a bare number draws nothing: a swatch beside one would offer to
   * paint something that does not exist. Stated as the set of things that DO draw, so a new kind
   * has to say so rather than inheriting a control by accident.
   */
  const DRAWN_KINDS: ReadonlySet<string> = new Set([
    "parametricSurface",
    "graphSurface",
    "implicitSurface",
    "planeCurve",
    "spaceCurve",
    "point",
    "chartGraph",
    "chartRelation",
    "tangentPlane",
    "surfaceField",
  ]);

  /**
   * The dot shows what the scene drew; the pencil says what to draw next time.
   *
   * `drawn` is the colour actually used this build, so an object nobody has chosen a colour for
   * still reports the palette entry it got. Once a colour IS chosen it wins, which is the same
   * order the scene resolves them in.
   */
  const syncColor = (view: RowView, item: Item | null, drawn: Vec3 | undefined) => {
    const shows = item !== null && DRAWN_KINDS.has(item.kind);
    view.gutter.hidden = !shows;
    if (!shows) return;
    const color = options.colors.get(view.id) ?? drawn ?? defaultColorFor(view.id);
    const hex = toHex(color);

    /**
     * Filled while the object is drawn, a hollow ring while it is not.
     *
     * The ring keeps the colour, because the row still owns it — the object is switched off, not
     * decoloured, and it comes back in the same colour it left in.
     */
    const overlay = options.overlays.get(view.id);
    const on =
      item.kind === "parametricSurface" ||
      item.kind === "graphSurface" ||
      item.kind === "implicitSurface"
        ? overlay?.fill ?? true
        : item.kind === "surfaceField"
          ? overlay?.arrows ?? true
          : !(overlay?.hidden ?? false);
    view.colorDot.style.borderColor = hex;
    view.colorDot.style.background = on ? hex : "transparent";
    view.colorDot.classList.toggle("gutter__dot--off", !on);
    /**
     * Open or struck through, drawn as SVG for the reason the pencil is: a glyph is only there if
     * the reader's font has it, and this one has to be legible at thirteen pixels.
     */
    const shut = overlay?.hidden ?? false;
    view.eye.innerHTML = shut ? EYE_SHUT : EYE_OPEN;
    view.eye.title = shut ? "draw this object" : "hide this object";
    view.eye.classList.toggle("gutter__eye--off", shut);

    view.colorDot.title = on
      ? item.kind === "parametricSurface" ||
        item.kind === "graphSurface" ||
        item.kind === "implicitSurface"
        ? "hide this patch's face, keeping its grid"
        : "stop drawing this"
      : "draw this again";
    // The input is only pushed while nobody is holding it open, the same rule every other
    // control in this file follows.
    if (view.colorField !== globalThis.document.activeElement) view.colorField.value = hex;
  };

  /**
   * A level set can ask to be drawn **flat**.
   *
   * `x² + y² = 1` is the cylinder — that is what the regular value theorem says, and it is the
   * default — while its section by the plane it is drawn in is the circle. Both are honest
   * readings of one row and only the reader knows which was meant, so this is a choice rather
   * than an inference, offered exactly where the equation could mean either.
   */
  const syncPlaneToggle = (view: RowView, item: Item | null) => {
    const eligible = item?.kind === "implicitSurface";
    if (!eligible) {
      if (view.planeHost.childElementCount > 0) replace(view.planeHost, []);
      return;
    }
    if (view.planeHost.childElementCount > 0) {
      const box = view.planeHost.querySelector("input");
      if (box instanceof HTMLInputElement && box !== globalThis.document.activeElement) {
        box.checked = options.overlays.get(view.id)?.inPlane ?? false;
      }
      return;
    }

    const toggle = el("input", {
      type: "checkbox",
      checked: options.overlays.get(view.id)?.inPlane ?? false,
      onChange: () => {
        const current = options.overlays.get(view.id) ?? EMPTY_OVERLAY;
        options.overlays.set(view.id, { ...current, inPlane: toggle.checked });
        options.onEdit(false);
      },
    }) as HTMLInputElement;

    replace(view.planeHost, [
      el("label", { class: "toggle toggle--tight" }, [
        toggle,
        el("span", { text: "draw flat — the curve this cuts on the z = 0 plane" }),
      ]),
    ]);
  };

  const syncFlowControl = (view: RowView, item: Item | null) => {
    const isField = item?.kind === "surfaceField";
    if (!isField) {
      if (view.flowBuilt) {
        replace(view.flowHost, []);
        options.animator.unregisterTicker(`flow:${view.id}`);
        view.flowBuilt = false;
      }
      return;
    }
    // Re-registered on every refresh so the callbacks close over nothing stale, which the
    // animator supports precisely because play state survives it.
    options.animator.registerTicker(`flow:${view.id}`, {
      advance: (seconds) => options.onFlowTick?.(view.id, seconds),
      rewind: () => options.onFlowRewind?.(view.id),
    });
    if (view.flowBuilt) {
      // Built once, but its state is pushed back on every refresh: the dot writes the same flag,
      // and a chip showing the opposite of what is drawn is worse than no chip.
      view.arrowChip?.classList.toggle(
        "chip--on",
        options.overlays.get(view.id)?.arrows ?? true,
      );
      return;
    }
    view.flowBuilt = true;

    /**
     * The arrows switch, beside the transport that replaces them.
     *
     * A field is two pictures of one object: the arrows say where each point *would* go, the flow
     * shows where the points do go. Playing already stands in for the arrows — they are hidden
     * while the flow runs, because a current read through a hedge of arrows is neither — so this
     * is for the other case: turning them off while the field is still, to look at the surface
     * under them. The chip is the user's standing preference and playing overrides it for as long
     * as it lasts, rather than editing it.
     */
    const arrowChip = el("button", {
      class: "chip",
      title: "the arrows \u2014 draw this field's vectors; the flow replaces them while it plays",
      text: "\u2192",
      onClick: (event: Event) => {
        event.stopPropagation();
        const current = options.overlays.get(view.id);
        const wanted = !(current?.arrows ?? true);
        options.overlays.set(view.id, { ...(current ?? EMPTY_OVERLAY), arrows: wanted });
        arrowChip.classList.toggle("chip--on", wanted);
        options.onEdit(false);
      },
    }) as HTMLButtonElement;
    arrowChip.classList.toggle("chip--on", options.overlays.get(view.id)?.arrows ?? true);
    view.arrowChip = arrowChip;

    const control = transport(`flow:${view.id}`);
    /**
     * Any press in the transport repaints, because play and pause change what is drawn.
     *
     * The arrows are hidden while a flow runs and come back when it stops, and neither is a
     * rebuild — the app leaves a group out of the frame. Listening on the container rather than
     * on the play button keeps this true of rewind as well, which reseeds and wants the same
     * repaint.
     */
    control.addEventListener("click", () => options.onFlowToggle?.(view.id));

    replace(view.flowHost, [
      el("div", { class: "flow" }, [
        el("span", { class: "flow__label", text: "flow" }),
        arrowChip,
        control,
      ]),
    ]);
  };

  /**
   * The parts of an overlay record that belong to **any** row, not just to a patch.
   *
   * `hidden` and `arrows` are answers to the dot and the arrow switch, which exist on curves and
   * fields as much as on surfaces. Everything else in the record is a patch's business. Pulled
   * out because two places rewrite the record wholesale — the controls below, from their own
   * closure locals — and both have to carry these across or a refresh erases them. That is the
   * same staleness `start` is read back from the map to avoid, and it is what made the arrow
   * switch turn itself off again on the next rebuild.
   */
  const sharedOverlay = (id: RowId) => {
    const current = options.overlays.get(id);
    return {
      hidden: current?.hidden,
      arrows: current?.arrows,
      fill: current?.fill,
      grid: current?.grid,
      colormap: current?.colormap,
      autoBox: current?.autoBox,
      inPlane: current?.inPlane,
    };
  };
  const hasShared = (shared: ReturnType<typeof sharedOverlay>) =>
    Object.values(shared).some((value) => value !== undefined);

  const syncOverlayControl = (view: RowView, item: Item | null) => {
    const isSurface = item?.kind === "parametricSurface" || item?.kind === "graphSurface";
    if (!isSurface) {
      if (view.overlayBuilt) {
        replace(view.overlayHost, []);
        view.overlayBuilt = false;
      }
      // A row that is not a patch keeps no patch settings — and keeps the ones that are not
      // about patches at all.
      const shared = sharedOverlay(view.id);
      if (hasShared(shared)) options.overlays.set(view.id, { ...EMPTY_OVERLAY, ...shared });
      else options.overlays.delete(view.id);
      return;
    }
    if (view.overlayBuilt) return;
    view.overlayBuilt = true;

    const state: SurfaceOverlay = options.overlays.get(view.id) ?? {
      geodesics: 0,
      geodesicLength: 1.5,
      curvatureLines: false,
    };
    let geodesics = state.geodesics;
    let geodesicLength = state.geodesicLength;
    let curvatureLines = state.curvatureLines;
    let gaussMap = state.gaussMap ?? false;
    let aiming = state.aiming ?? false;
    let colormap: ColormapName = state.colormap ?? "curvature";

    const commit = () => {
      const drawn = options.overlays.get(view.id);
      if (
        geodesics === 0 &&
        !curvatureLines &&
        !gaussMap &&
        !aiming &&
        colormap === "curvature" &&
        shotCount() === 0 &&
        (drawn?.fill ?? true) &&
        (drawn?.grid ?? true)
      ) {
        // Nothing is drawn, so there is no start point to remember either — but the dot's own
        // answer is not part of "nothing is drawn", and outlives it.
        const shared = sharedOverlay(view.id);
        if (hasShared(shared)) options.overlays.set(view.id, { ...EMPTY_OVERLAY, ...shared });
        else options.overlays.delete(view.id);
      } else {
        /**
         * `start` is read back from the map rather than captured in a local.
         *
         * It is owned by the click handler on the canvas, not by these controls, so building a
         * fresh object from the local state alone would silently reset the picked point to the
         * domain centre the next time any slider here moved.
         */
        const start = options.overlays.get(view.id)?.start;
        options.overlays.set(view.id, {
          ...sharedOverlay(view.id),
          geodesics,
          geodesicLength,
          curvatureLines,
          gaussMap,
          aiming,
          colormap,
          start,
          // Owned by the canvas, like `start`, so read back rather than captured.
          shots: options.overlays.get(view.id)?.shots,
          // Owned by the chips beside the colour, and read back for the same reason: building a
          // fresh object from these controls' own state would switch a hidden patch back on the
          // next time any slider here moved.
          fill: options.overlays.get(view.id)?.fill,
          grid: options.overlays.get(view.id)?.grid,
        });
      }
      /**
       * Also the throttled path: an overlay change re-integrates curves and re-tessellates, but
       * it never reparses, so the spray-count and arc-length sliders should give continuous
       * feedback rather than waiting for the drag to stop.
       */
      options.onParameterChange();
    };

    const count = el("input", {
      type: "range",
      class: "slider__input",
      min: 0,
      max: 24,
      step: 1,
      value: geodesics,
    }) as HTMLInputElement;
    const countReadout = el("span", { class: "slider__value", text: String(geodesics) });
    count.addEventListener("input", () => {
      geodesics = Number(count.value);
      countReadout.textContent = String(geodesics);
      commit();
    });

    /**
     * The ceiling matters more than it looks: a great circle on a sphere of radius R has length
     * 2πR, and the extent this multiplies is R — so a maximum of 6 stopped every geodesic just
     * short of closing up, which is the one length worth being able to reach.
     */
    const length = el("input", {
      type: "range",
      class: "slider__input",
      min: 0.2,
      max: 40,
      step: 0.1,
      value: geodesicLength,
    }) as HTMLInputElement;
    const lengthReadout = el("span", {
      class: "slider__value",
      text: geodesicLength.toFixed(1),
    });
    length.addEventListener("input", () => {
      geodesicLength = Number(length.value);
      lengthReadout.textContent = geodesicLength.toFixed(1);
      commit();
    });

    const curvature = chip(
      "k<sub>1</sub>k<sub>2</sub>",
      "lines of curvature through the start point",
      curvatureLines,
      (next) => {
        curvatureLines = next;
        commit();
      },
    );

    const gauss = chip(
      "N",
      "Gauss map: N: S \u2192 S\u00b2 drawn beside the surface, in the same colours \u2014 " +
        "its image folds where K = 0",
      gaussMap,
      (next) => {
        gaussMap = next;
        commit();
      },
    );

    const shotCount = () => options.overlays.get(view.id)?.shots?.length ?? 0;

    /**
     * Which colour map paints K on this surface.
     *
     * Per surface rather than global, because two surfaces in one scene can be asked different
     * questions — one showing the sign of K, another its magnitude — while still sharing the one
     * robust scale that makes their colours comparable.
     */
    const colormapSelect = el("select", { class: "props__select" }) as HTMLSelectElement;
    for (const name of COLORMAP_NAMES) {
      colormapSelect.append(
        el("option", { value: name, text: COLORMAP_LABEL[name], selected: name === colormap }),
      );
    }
    view.colormapSelect = colormapSelect;
    colormapSelect.addEventListener("change", () => {
      colormap = colormapSelect.value as ColormapName;
      commit();
    });

    /**
     * The aim tool.
     *
     * While armed, a drag on THIS surface shoots a geodesic along the direction dragged instead
     * of orbiting. Armed per surface rather than globally so the gesture is only taken on the
     * object the user pointed at — dragging anywhere else still moves the camera, which is what
     * keeps this from being a mode you get stuck in.
     */
    const aim = chip(
      "\u2197",
      "aim: drag on this surface to shoot a geodesic in the direction dragged",
      aiming,
      (next) => {
        aiming = next;
        commit();
      },
    );

    const clearShots = el("button", {
      class: "chip",
      text: "\u232b",
      title: "remove every aimed geodesic",
      onClick: () => {
        const overlay = options.overlays.get(view.id);
        if (!overlay?.shots?.length) return;
        options.overlays.set(view.id, { ...overlay, shots: [] });
        options.onEdit(false);
      },
    });

    replace(view.overlayHost, [
      colormapSelect,
      el("div", { class: "slider" }, [
        el("label", { class: "slider__label" }, [
          el("span", { text: "\u03b3", title: "geodesics fanned from the start point" }),
          countReadout,
        ]),
        count,
      ]),
      el("div", {
        class: "overlay__hint",
        text: "click the surface to move where these start",
      }),
      el("div", { class: "slider" }, [
        el("label", { class: "slider__label" }, [
          el("span", { text: "s", title: "arc length of each geodesic" }),
          lengthReadout,
        ]),
        length,
      ]),
      curvature,
      aim,
      clearShots,
      gauss,
    ]);
  };

  const syncFrameControl = (view: RowView, item: Item | null) => {
    const isCurve = item?.kind === "spaceCurve" || item?.kind === "planeCurve";
    if (!isCurve) {
      if (view.frameHost.childElementCount > 0) replace(view.frameHost, []);
      options.frames.delete(view.id);
      return;
    }
    if (view.frameHost.childElementCount > 0) return;

    const state: FrameRequest = options.frames.get(view.id) ?? { show: false, at: 0.5 };
    let show = state.show;
    let at = state.at;
    const commit = () => options.frames.set(view.id, { show, at });
    commit();

    const readout = el("span", { class: "slider__value", text: at.toFixed(2) });

    const position = el("input", {
      type: "range",
      class: "slider__input",
      min: 0,
      max: 1,
      step: 0.002,
      value: at,
      onInput: () => {
        at = Number(position.value);
        readout.textContent = at.toFixed(2);
        commit();
        options.onParameterChange();
      },
    }) as HTMLInputElement;

    const toggle = el("input", {
      type: "checkbox",
      checked: show,
      onChange: () => {
        show = toggle.checked;
        commit();
        position.disabled = !show;
        options.onParameterChange();
      },
    }) as HTMLInputElement;
    position.disabled = !show;

    replace(view.frameHost, [
      el("label", { class: "toggle toggle--tight" }, [
        toggle,
        el("span", { text: "moving frame" }),
        el("span", { class: "frame-key" }, [
          el("span", { class: "frame-key__t", text: "T" }),
          el("span", { class: "frame-key__n", text: "N" }),
          el("span", { class: "frame-key__b", text: "B" }),
        ]),
      ]),
      el("div", { class: "frame-position" }, [position, readout]),
    ]);
  };


  /**
   * A slider on any row that defines a plain number.
   *
   * This is the Desmos model, and it is what makes `R = 2` immediately adjustable rather than
   * something you have to retype. Dragging rewrites the row's own text, so the document stays
   * the single source of truth — the row still says exactly what it means, and undo, sharing
   * and reloading all keep working without a parallel store of "current values".
   *
   * Built once per row and only rebuilt when the declared name changes, for the same reason
   * everything else here is: replacing an input the user is holding is what steals focus.
   */
  const syncValueSlider = (view: RowView, item: Item | null) => {
    /**
     * A plain number gets a slider under its cell.
     *
     * The kind to test is `parameter`, not `scalar`: `R = 2` is classified as a parameter
     * precisely BECAUSE it is a bare number the user will want to drag — keeping it symbolic
     * downstream is what makes dragging it free. Testing for `scalar` here meant the one kind of
     * row that exists to be dragged was the one kind that never got a slider.
     */
    const numeric =
      item !== null &&
      item.kind === "parameter" &&
      item.name !== null &&
      item.comps[0]?.kind === "num";

    const name = numeric ? item.name! : "";
    if (view.valueName === name) return;
    view.valueName = name;

    if (!numeric) {
      replace(view.valueHost, []);
      options.rowSliders.delete(view.id);
      options.animator.unregister(`row:${view.id}`);
      return;
    }

    const current = (item.comps[0] as { value: number }).value;
    let spec = options.rowSliders.get(view.id);
    if (!spec) {
      // A symmetric range around twice the declared magnitude covers a radius, a pitch or a
      // coefficient without asking for bounds up front; both ends stay editable.
      const reach = Math.max(1, Math.abs(current) * 2);
      spec = {
        value: current,
        min: -reach,
        max: reach,
        step: Math.abs(current) > 10 ? 0.1 : 0.01,
      };
      options.rowSliders.set(view.id, spec);
    }
    spec.value = current;
    store.setParameter(name, current);

    let lastTypeset = format(current);

    const slider = movingSlider({
      min: spec.min,
      max: spec.max,
      step: spec.step,
      value: spec.value,
      format,
      title: `${name} \u2014 drag, or double-click to type an exact value`,
      /**
       * While dragging, only the parameter *value* moves — never the row's text.
       *
       * The row declares a number, and that number compiles to a **slot**, so changing it leaves
       * every expression in the document byte-identical and the compiled jet is reused straight
       * from cache. Rewriting `R = 2` to `R = 2.01` on each frame would build a whole new
       * interned tree and re-differentiate the surface sixty times a second, which is exactly
       * the jank this replaced. The text is reconciled once, when the drag ends.
       */
      onInput: (next) => {
        spec!.value = next;
        spec!.min = Math.min(spec!.min, Number(slider.input.min));
        spec!.max = Math.max(spec!.max, Number(slider.input.max));
        store.setParameter(name, next);
        const shown = format(next);
        // Keep the typeset view honest while dragging: without this the cell reads `R = 2`
        // while its slider reads 1.95. Guarded on the displayed string, so a move within one
        // rounding step costs no typesetting.
        if (shown !== lastTypeset) {
          lastTypeset = shown;
          refreshEcho(views.get(view.id));
        }
        options.onParameterChange();
      },
    });

    slider.input.addEventListener("change", () => {
      // On release, reconcile the row's text with where the slider ended up, so the document
      // still says what it means. Once per drag, not once per frame.
      const next = Number(slider.input.value);
      const row = store.rows().find((candidate) => candidate.id === view.id);
      if (!row) return;
      row.source.set(`${name} = ${format(next)}`);
      refreshEcho(views.get(view.id));
      options.onEdit(false);
    });

    options.animator.register(
      `row:${view.id}`,
      spec,
      (value) => {
        slider.set(value);
        store.setParameter(name, value);
      },
      (value) => {
        const row = store.rows().find((candidate) => candidate.id === view.id);
        if (row) row.source.set(`${name} = ${format(value)}`);
        options.onEdit(false);
      },
    );

    // Retyping an end also rewrites the row, since the value may have been carried in with it —
    // the same reconciliation a released drag does.
    const ends = trackEnds(name, spec, slider, (value) => {
      const row = store.rows().find((candidate) => candidate.id === view.id);
      if (row) row.source.set(`${name} = ${format(value)}`);
      store.setParameter(name, value);
      refreshEcho(views.get(view.id));
      options.onEdit(false);
    });

    replace(view.valueHost, [
      el("div", { class: "slider" }, [
        el("span", { class: "slider__name" }, [tex(name.length === 1 ? name : `\\mathrm{${name}}`)]),
        ends.min,
        slider.root,
        ends.max,
        transport(`row:${view.id}`),
      ]),
    ]);

  };

  /** Re-typeset one row's echo. KaTeX is the expensive part, so this is called sparingly. */
  /**
   * Decide whether a cell shows its typeset form or its raw text.
   *
   * An empty or unparseable cell has no typeset form worth showing, so it stays in edit mode —
   * otherwise a mistyped formula would vanish behind a dash with no way to see what was typed.
   */
  const syncEditing = (view: RowView | undefined) => {
    if (!view) return;
    if (globalThis.document.activeElement === view.input) return;
    const source = store.rows().find((row) => row.id === view.id)?.source() ?? "";
    // parseRow, not parse: a declaration like `X(u,v) = (…)` is not a bare expression, and
    // testing it with the wrong parser would leave every surface cell stuck in edit mode.
    const typeset = source.trim() !== "" && parseRow(source).row !== null;
    const editing = view.root.classList.contains("row--editing");
    view.root.classList.toggle("row--editing", !typeset);
    // Just revealed: the field could not be measured while it was hidden, so measure it now.
    if (!typeset && !editing) autoSize(view.input);
  };

  /**
   * Put the model's text back in the field when something other than typing changed it.
   *
   * The field is the source of truth while it is being typed in, and the model is the source of
   * truth otherwise — undo, and anything else that rewrites a row, changes the signal and the
   * field has to follow or the cell would show text the document no longer holds. Never while it
   * is focused: that would fight the caret, which is the mistake this file keeps being written
   * around.
   */
  const syncText = (view: RowView | undefined) => {
    if (!view) return;
    if (globalThis.document.activeElement === view.input) return;
    const source = store.rows().find((row) => row.id === view.id)?.source() ?? "";
    if (view.input.value === source) return;
    view.input.value = source;
    autoSize(view.input);
  };

  const refreshEcho = (view: RowView | undefined) => {
    if (!view) return;
    const row = store.rows().find((candidate) => candidate.id === view.id);
    if (!row) return;
    replace(view.echo, [echoFor(row.source(), liveValueOf(view.id), currentValues())]);
  };

  /**
   * What a numeric cell is worth RIGHT NOW, if it is being dragged away from what it says.
   *
   * A row like `R = 2` is a definition and a control at once, and dragging its slider deliberately
   * does not rewrite the text — rebuilding the interned tree on every frame is what made the whole
   * thing janky once. The consequence is that the cell can read `R = 2` while its slider reads
   * 1.95, which is the definition disagreeing with the object on screen. The typeset view shows
   * the live number instead; the text is reconciled when the drag ends.
   */
  /**
   * Every parameter's current value, for the typeset view.
   *
   * Read from the document's own parameter store rather than from the sliders, because both kinds
   * of slider — a free parameter's and a numeric row's — write there, so one lookup covers them
   * uniformly and cannot fall out of step with a second copy.
   */
  const currentValues = (): ReadonlyMap<string, number> => new Map(store.parameters());

  const liveValueOf = (id: RowId): number | null => {
    const spec = options.rowSliders.get(id);
    return spec ? spec.value : null;
  };

  /** The per-row notes: diagnostics, compile errors, readouts. Cheap; no typesetting. */
  const renderNotes = (view: RowView, report: RowReport | undefined) => {
    const resolution = store.resolution();
    const diagnostics = resolution.diagnostics.get(view.id) ?? [];
    const item = resolution.items.get(view.id) ?? null;
    const notes: HTMLElement[] = [];

    for (const diagnostic of diagnostics) notes.push(diagnosticNode(diagnostic));
    // Every line, not just the last: a surface reports its curvature and, separately, how its
    // geodesic spray ended.
    for (const message of report?.errors ?? []) {
      notes.push(el("div", { class: "diag diag--error", text: message }));
    }
    for (const message of report?.warnings ?? []) {
      notes.push(el("div", { class: "diag diag--warning", text: message }));
    }
    for (const message of report?.info ?? []) {
      /**
       * A readout is only useful if its symbols can be looked up.
       *
       * `K = -1.190  H = 0.476` is opaque unless you already know the convention, and the panel
       * has no room to spell it out — so the definition rides along as a tooltip on the line that
       * shows it. K is the one that survives bending the surface without stretching it, which is
       * the fact worth knowing about it.
       */
      notes.push(
        el("div", {
          class: "row__info",
          text: message,
          title: message.startsWith("K =") ? CURVATURE_TOOLTIP : undefined,
        }),
      );
    }
    if (item && NOT_YET_DRAWN.has(item.kind)) {
      notes.push(
        el("div", {
          class: "diag diag--hint",
          text: `recognized as a ${KIND_LABEL[item.kind] ?? item.kind}, but drawing these is not implemented yet`,
        }),
      );
    }
    replace(view.notes, notes);
  };

  const refreshReports = (reports: readonly RowReport[]) => {
    const reportById = new Map(reports.map((report) => [report.rowId, report]));
    for (const [id, view] of views) renderNotes(view, reportById.get(id));
  };

  const refresh = (reports: readonly RowReport[], drawn?: ReadonlyMap<RowId, Vec3>) => {
    syncRows();
    const resolution = store.resolution();
    const scoped = scope === null ? null : inScope(resolution);
    /**
     * Before the per-row loop, not after it.
     *
     * A row's sliders are built from the names that already have specs, so creating the specs
     * afterwards meant a brand-new parameter got no control until the NEXT refresh — and on the
     * parameter path there is no next refresh, so a formula that introduced a name appeared to
     * have no slider at all until something else was edited.
     */
    syncSliders(
      resolution.freeParameters.filter((name) => !resolution.declaredParameters.has(name)),
    );
    const reportById = new Map(reports.map((report) => [report.rowId, report]));

    for (const [id, view] of views) {
      const row = store.rows().find((candidate) => candidate.id === id);
      if (!row) continue;

      // Through the same helper as a live update, so a full refresh and a drag cannot disagree
      // about whether parameters are shown by name or by value.
      refreshEcho(view);

      const item = resolution.items.get(id) ?? null;
      const label = item ? (KIND_LABEL[item.kind] ?? item.kind) : "";
      view.badge.textContent = label;
      // The card's heading names the same thing the row's badge does, so a selected object is
      // identifiable from the card alone once the list scrolls away from it.
      view.detailsTitle.textContent = label === "" ? "expression" : label;
      if (selectedId === id) cardTitle.textContent = view.detailsTitle.textContent;
      view.badge.className =
        "row__badge" +
        (item && NOT_YET_DRAWN.has(item.kind) ? " row__badge--pending" : "") +
        (label === "" ? " row__badge--empty" : "");

      // Hidden, never removed: leaving an ambient space is a class toggle, and a row that was
      // rebuilt would lose its caret, its focus and its registered controls on the way out.
      view.root.classList.toggle("row--out-of-scope", scoped !== null && !scoped.has(id));

      syncColor(view, item, drawn?.get(id));
      syncValueSlider(view, item);
      syncChartToggle(view, item);
      syncPlaneToggle(view, item);
      syncFlowControl(view, item);
      syncOverlayControl(view, item);
      syncDomain(view, item);
      syncDomainValues(view);
      syncFrameControl(view, item);
      syncRowParams(view, item);
      // Read back from the overlay rather than remembered, so the chip and the menu cannot drift.
      /**
       * Three different questions, and they were one flag until level sets arrived.
       *
       * A level set has a **face and a grid** — its grid is where the ambient coordinates cut it —
       * so the two switches apply. It has no **chart**, so nothing can be stated in its (u, v):
       * no relation, no tangent plane at a chart point. And only a parametric patch can seed a
       * field, since the seed is ∂X/∂v read off its own formula.
       */
      const hasFace =
        item?.kind === "parametricSurface" ||
        item?.kind === "graphSurface" ||
        item?.kind === "implicitSurface";
      const hasChart = item?.kind === "parametricSurface" || item?.kind === "graphSurface";
      view.enterSpace.hidden = item?.kind !== "ambientSpace";
      view.addRelation.hidden = !hasChart;
      view.addTangent.hidden = !hasChart;
      view.addField.hidden = item?.kind !== "parametricSurface";
      view.fillChip.hidden = !hasFace;
      view.gridChip.hidden = !hasFace;
      // Only a level set has a box to fit: a patch's domain is part of what the surface IS.
      view.fitChip.hidden = item?.kind !== "implicitSurface";
      view.fitChip.classList.toggle("chip--on", options.overlays.get(id)?.autoBox ?? false);
      // While it is on, the sliders are inert, and saying so is cheaper than being asked why.
      view.domainHost.classList.toggle(
        "row__domain--ignored",
        item?.kind === "implicitSurface" && (options.overlays.get(id)?.autoBox ?? false),
      );
      view.fillChip.classList.toggle("chip--on", options.overlays.get(id)?.fill ?? true);
      view.gridChip.classList.toggle("chip--on", options.overlays.get(id)?.grid ?? true);
      view.curvatureChip.classList.toggle(
        "chip--on",
        (options.overlays.get(id)?.colormap ?? "curvature") !== "solid",
      );
      syncText(view);
      syncEditing(view);

      renderNotes(view, reportById.get(id));
    }

  };

  /**
   * The bar is nothing but cells.
   *
   * No headings, no add button, no parameter section — a new cell appears as soon as the last one
   * is used, and everything about an object lives in its card. What is left is the one thing the
   * bar is for.
   */
  /**
   * Make a new slider: a numeric cell, which renders its own slider directly beneath itself.
   *
   * A slider IS a row here — `a = 1` is a definition and a control at once — so this needs no
   * separate concept, only an unused name. Walking the alphabet skips anything the document
   * already uses, so pressing it twice gives two independent sliders rather than a collision.
   */
  const createSlider = el("button", {
    class: "cells__action",
    text: "+ slider",
    title: "add a named value with a slider",
    onClick: () => {
      const used = new Set<string>();
      for (const row of store.rows()) {
        const parsed = parseRow(row.source());
        if (parsed.row && "name" in parsed.row) used.add(parsed.row.name);
      }
      // u, v, t, x, y and z name coordinates rather than values, so they are never offered.
      const candidates = "abcdefghijklmnopqrsw".split("").filter((name) => !used.has(name));
      const name = candidates[0] ?? `a${store.rows().length}`;
      const row = store.addRow(`${name} = 1`);
      syncRows();
      options.onEdit(false);
      select(row.id);
    },
  });

  /**
   * A new ambient space: `A_1 = AmbientSpace`, then `A_2`, and so on as they are made.
   *
   * A space is where things are built, so this is the row that comes before the others rather
   * than a view of one of them. It is created at the **top level** even while a space is open —
   * spaces do not nest, and a space inside a space would be a hierarchy this document does not
   * have — and opening it is left to the same double-click every other object answers, so there
   * is one way in.
   */
  const createSpace = el("button", {
    class: "cells__action",
    text: "+ space",
    title: "add an ambient space to build in",
    onClick: () => {
      const row = store.addRow(`${nextName(SPACE_NAMES, usedNames(store))} = AmbientSpace`);
      syncRows();
      options.onEdit(false);
      select(row.id);
    },
  });

  const root = el("div", { class: "cells" }, [rowHost, createSpace, createSlider]);

  syncRows();

  return {
    root,
    card,
    select,
    selected: () => selectedId,
    setPlacement(mode) {
      placement = mode;
      card.classList.toggle("props--at-cursor", mode === "cursor");
      if (mode === "bar") {
        card.style.left = "";
        card.style.top = "";
      }
      positionAtCursor();
    },
    placeAt(x, y) {
      cursorX = x;
      cursorY = y;
      positionAtCursor();
    },
    setScope(next) {
      scope = next;
      // The trailing cell was made for the space it was in, so it is remade for this one.
      const rows = store.rows();
      const last = rows[rows.length - 1];
      if (last && isBlank(last.source()) && last.source() !== blankRow()) {
        last.source.set(blankRow());
      }
      syncRows();
    },

    refresh,
    refreshReports,
    invalidateSliders: () => {
      renderedSliders = "\u0000";
    },
  };
}

/**
 * A distinct starting colour per row, walked around the hue circle.
 *
 * Golden-ratio spacing rather than even division, because the number of rows is not known in
 * advance: each new row lands in the largest remaining gap, so any prefix of the sequence is
 * well separated instead of only a full set being so.
 */
function defaultColorFor(id: RowId): Vec3 {
  const hue = (id * 0.61803398875) % 1;
  return hslToRgb(hue, 0.62, 0.42);
}

function hslToRgb(h: number, s: number, l: number): Vec3 {
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const sector = h * 6;
  const second = chroma * (1 - Math.abs((sector % 2) - 1));
  const base = l - chroma / 2;
  const table: ReadonlyArray<readonly [number, number, number]> = [
    [chroma, second, 0],
    [second, chroma, 0],
    [0, chroma, second],
    [0, second, chroma],
    [second, 0, chroma],
    [chroma, 0, second],
  ];
  const picked = table[Math.min(5, Math.floor(sector))]!;
  return [picked[0] + base, picked[1] + base, picked[2] + base];
}

const channel = (value: number) =>
  Math.max(0, Math.min(255, Math.round(value * 255)))
    .toString(16)
    .padStart(2, "0");

/** Vec3 in [0,1] to the `#rrggbb` a colour input needs. */
export function toHex(color: Vec3): string {
  return `#${channel(color[0])}${channel(color[1])}${channel(color[2])}`;
}

/** `#rrggbb` back to a Vec3 in [0,1]. */
export function fromHex(hex: string): Vec3 {
  const n = Number.parseInt(hex.replace("#", ""), 16);
  if (!Number.isFinite(n)) return [0.5, 0.5, 0.5];
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/**
 * Grow a cell to fit its text.
 *
 * Height is reset to `auto` first: `scrollHeight` reports the content height only when the box is
 * not already constraining it, so measuring without the reset makes a cell that can grow but
 * never shrink.
 *
 * A **hidden** field reports `scrollHeight` 0, and writing that back pins the cell at zero height
 * — which survives being shown again, because an inline height beats anything the stylesheet
 * says. That is the collapsed cell: a row shows its typeset form (input hidden), something
 * measures it, and the next time the row has no typeset form to show, the field it falls back to
 * is a sliver. Measuring a box that is not laid out answers nothing, so nothing is recorded.
 */
function autoSize(field: HTMLTextAreaElement): void {
  field.style.height = "auto";
  const height = field.scrollHeight;
  if (height > 0) field.style.height = `${height}px`;
  else field.style.removeProperty("height");
}

/**
 * What the curvature readout means, for the tooltip.
 *
 * Both are built from the principal curvatures k₁ and k₂ — the largest and smallest amounts the
 * surface bends at a point. K is intrinsic and H is not, which is the distinction the whole of do
 * Carmo's chapter 4 rests on.
 */
const CURVATURE_TOOLTIP =
  "K = k\u2081k\u2082 is the Gaussian curvature: > 0 dome-like, < 0 saddle-like, 0 flat in one " +
  "direction. It is intrinsic \u2014 unchanged by bending the surface without stretching it.\n" +
  "H = (k\u2081 + k\u2082)/2 is the mean curvature. It depends on the choice of unit normal and " +
  "flips sign with it; H = 0 everywhere means a minimal surface.";

/**
 * Typeset a parameter as its symbol with the current value tucked underneath.
 *
 * Substituting the number outright — which is what this replaced — showed the value but destroyed
 * the structure that makes a parametrization readable as a map: `((R + r cos u) cos v, …)` says
 * what a torus IS, and `((1.95 + 0.9 cos u) cos v, …)` says what one particular torus measures.
 * Both are wanted, and they do not compete for the same space: the symbol keeps its place in the
 * formula and the number sits below it, small.
 *
 * Rounded to six significant figures, because a slider step of 0.0001 lands on values like
 * 1.0487039999999947 and printing that trades one unreadable thing for another. Display only; the
 * scene is built from the unrounded parameter.
 */
function annotatedVariable(values: ReadonlyMap<string, number>) {
  return (name: string): string | undefined => {
    const value = values.get(name);
    if (value === undefined) return undefined;
    const shown = String(Number(value.toPrecision(6)));
    return `\\underset{\\scriptsize ${shown}}{${name.length === 1 ? name : `\\mathrm{${name}}`}}`;
  };
}

/** Coordinate names for the components of a map into R³, in order. */
const COMPONENT_NAMES = ["x", "y", "z"];

/**
 * Lay a surface definition out over several lines, one named coordinate each.
 *
 * `X(u,v) = ((R + r cos u) cos v, (R + r cos u) sin v, r sin u)` is a single line in which the
 * three components have to be told apart by counting commas through nested parentheses. Naming
 * them and putting them on their own lines is how the same map is written on paper, and it is
 * what makes the third component editable without first working out where it starts.
 *
 * Returns null when the row is not a surface, so the caller leaves everything else alone. The
 * labels are dropped again on the way back in — they restate the position — so this is purely a
 * presentation of the same expression, and reformatting an already-formatted cell is a no-op.
 */
export function formatSurfaceSource(source: string): string | null {
  if (source.trim() === "") return null;
  const { row, host } = parseRow(source);
  // Re-emitting the row would drop the `X:` it is stated in, and a prefix silently deleted by
  // opening a cell is worse than a surface left on one line.
  if (host !== undefined) return null;
  if (!row || row.kind !== "vectorFunction") return null;
  if (row.args.length !== 2 || row.comps.length !== COMPONENT_NAMES.length) return null;

  const body = row.comps
    .map((comp, index) => `  ${COMPONENT_NAMES[index]} = ${toSource(comp)}`)
    .join(",\n");
  return `${row.name}(${row.args.join(", ")}) = (\n${body}\n)`;
}

function diagnosticNode(diagnostic: Diagnostic): HTMLElement {
  return el("div", {
    class: `diag diag--${diagnostic.severity}`,
    text: diagnostic.message,
  });
}

/**
 * Typeset whatever the row currently says, including which chart it says it is in.
 *
 * A declaration is echoed as `name(args) = body` so the user can see their own left-hand
 * side; a bare expression is echoed directly. An unparseable row shows a dash rather than
 * clearing, so the panel does not flicker mid-word.
 *
 * The `X:` prefix is echoed too. It is not decoration — it is the row's statement of which
 * patch's u and v these are, and a typeset view that dropped it would show two rows on two
 * different surfaces as the same formula.
 */
function echoFor(
  source: string,
  liveValue: number | null = null,
  values: ReadonlyMap<string, number> = new Map(),
): HTMLElement {
  const { path, body } = splitScope(source);
  if (path.length === 0) return echoBody(source, liveValue, values);
  // The whole address, not its last segment: `A:sigma: u + v = 1` is stated in a chart *and* in a
  // space, and an echo that dropped either would show two rows in two places as the same formula.
  return el("span", { class: "echo-chart" }, [
    tex(`${path.map(nameTex).join("\\colon")}\\colon`),
    // A prefix with nothing after it yet is the state the "+ relation" button opens in.
    body.trim() === ""
      ? el("span", { class: "echo-empty", text: "\u2026" })
      : echoBody(body, liveValue, values),
  ]);
}

function echoBody(
  source: string,
  liveValue: number | null = null,
  values: ReadonlyMap<string, number> = new Map(),
): HTMLElement {
  if (source.trim() === "") return el("span", { class: "echo-empty", text: " " });

  const { row } = parseRow(source);
  if (row) {
    switch (row.kind) {
      case "value":
        return tex(
          `${nameTex(row.name)} = ${
            liveValue === null ? toLatex(row.body) : formatValue(liveValue)
          }`,
        );
      case "function":
        return tex(
          `${nameTex(row.name)}\\left(${row.args.map(nameTex).join(", ")}\\right) = ${toLatex(row.body)}`,
        );
      case "vectorFunction": {
        const head = `${nameTex(row.name)}\\left(${row.args.map(nameTex).join(", ")}\\right)`;
        // The map's own arguments carry no annotation: u and v are what it is a function OF,
        // and a number under them would suggest they had been evaluated at a point.
        const bound = new Map(values);
        for (const arg of row.args) bound.delete(arg);
        const variable = annotatedVariable(bound);
        /**
         * A surface is typeset the way it is written: stacked, one named coordinate per line.
         *
         * The preview and the editable text are two views of one thing, so they have to agree on
         * SHAPE as well as content — reading a formula laid out over three lines and then seeing
         * it typeset as one long row means re-finding your place every time. It also fixes the
         * overflow: three components of a torus on one line simply run off the panel.
         *
         * Matched to `formatSurfaceSource` exactly — two arguments, three components — so the
         * two never disagree about which rows get the treatment.
         */
        if (row.args.length === 2 && row.comps.length === COMPONENT_NAMES.length) {
          const rows = row.comps
            .map((c, index) => `${COMPONENT_NAMES[index]} &= ${toLatex(c, { variable })}`)
            .join(" \\\\ ");
          return tex(`${head} = \\left(\\begin{aligned} ${rows} \\end{aligned}\\right)`);
        }
        return tex(
          `${head} = \\left(${row.comps.map((c) => toLatex(c, { variable })).join(",\\; ")}\\right)`,
        );
      }
      case "equation":
        return tex(`${toLatex(row.lhs)} = ${toLatex(row.rhs)}`);
      case "surfaceField": {
        // `V⃗ = (a, b, c)`, with the patch as a subscript when the row names it after the
        // components rather than in front of them.
        const variable = annotatedVariable(values);
        const comps = row.comps.map((c) => toLatex(c, { variable })).join(",\\; ");
        const head = row.surface === null ? "\\vec{V}" : `\\vec{V}_{${nameTex(row.surface)}}`;
        return tex(`${head} = \\left(${comps}\\right)`);
      }
      case "tangentPlane": {
        // `T_{(1,2)}X`, the way do Carmo writes `T_p(S)` with the point named downstairs. The
        // coordinates carry their live values, so dragging the parameter that moves the plane
        // shows where it has got to.
        const variable = annotatedVariable(values);
        const at = row.at.map((c) => toLatex(c, { variable })).join(",\\; ");
        return tex(`T_{\\left(${at}\\right)}${row.surface === null ? "" : nameTex(row.surface)}`);
      }
      case "tuple":
        return tex(`\\left(${row.comps.map((c) => toLatex(c)).join(",\\; ")}\\right)`);
      case "expr":
        return tex(toLatex(row.body));
    }
  }

  const { expr } = parse(source);
  if (expr) return tex(toLatex(expr));
  return el("span", { class: "echo-empty", text: "—" });
}

function nameTex(name: string): string {
  const underscore = name.indexOf("_");
  if (underscore > 0) {
    return `${nameTex(name.slice(0, underscore))}_{${name.slice(underscore + 1).replace(/[{}]/g, "")}}`;
  }
  return name.length === 1 ? name : `\\mathrm{${name}}`;
}
