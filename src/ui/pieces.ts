import { PIECES, type PieceSpec } from "../core/catalog/pieces.ts";
import { sampleBounds } from "../core/geom/types.ts";
import type { DocumentStore, RowId } from "../state/graph.ts";
import { absoluteRoll, normalizeRoll, type Joint, type Socket } from "../state/assembly.ts";
import type { DomainRange, ScenePort, SceneSurface } from "../state/scene.ts";
import { SURFACE_NAMES, nextName, usedNames } from "../state/naming.ts";
import { el, replace } from "./dom.ts";

/**
 * The parts bin, as a panel: click a socket, then click a piece.
 *
 * The interaction is the one a track builder has. A **socket** — a free boundary of something
 * already in the scene, drawn as a ring on the stage — is selected, and every piece placed after
 * that is generated at *that socket's size* and joined to it. The new piece's far end becomes the
 * next socket, so clicking Tube four times lays four tubes end to end without ever touching a
 * transform.
 *
 * With no socket selected a piece is simply dropped into the scene at its default size, which is
 * how a chain gets started.
 *
 * Nothing here is a new kind of object: a piece is a row of source text like any other, and once
 * placed it can be edited, recoloured, painted with K or shot with geodesics. What the joint adds
 * is that its **placement is derived** rather than stored — see `state/assembly.ts`.
 */

export interface PieceOptions {
  readonly document: DocumentStore;
  readonly domains: Map<RowId, DomainRange[]>;
  /** child row → the joint holding it; owned by the app and read by the scene builder */
  readonly joints: Map<RowId, Joint>;
  /** the socket a new piece will attach to, as the last built scene measured it */
  readonly socket: () => ScenePort | null;
  readonly setSocket: (socket: Socket | null) => void;
  /** which row's properties are open, so its joint can be adjusted or released */
  readonly selected: () => RowId | null;
  /** the whole object a patch belongs to, for the panel to name what is being built */
  readonly surfaceOf: (rowId: RowId | null) => SceneSurface | null;
  /** release a joint, leaving the piece where it currently sits */
  readonly detach: (rowId: RowId) => void;
  /** a full rebuild: the document gained a row */
  readonly requestRender: (refit: boolean) => void;
  /** a placement changed but no formula did: the throttled path */
  readonly onParameterChange: () => void;
  /** put a piece that could not be joined somewhere with room */
  readonly onCreated?: (rowId: RowId) => void;
}

export interface PiecePicker {
  readonly root: HTMLElement;
  /** redraw the socket status and joint controls after a scene rebuild */
  refresh(): void;
}

/** Degrees, for a control a person reads; radians everywhere else. */
const ROLL_STEP = 5;

export function createPiecePicker(options: PieceOptions): PiecePicker {
  const { document: store } = options;

  const status = el("div", { class: "socket-status" });
  const blurb = el("p", { class: "blurb" });
  const jointControls = el("div", { class: "joint-controls" });

  /**
   * The roll new pieces are placed at, in radians, measured **from the root of the surface**.
   *
   * Set it once and every piece placed afterwards lands at that twist — including the ones snapped
   * onto pieces that already carry it, because what goes into the joint is the *difference* from
   * what the parent has already accumulated. Leaving the dial alone therefore lays a run that
   * keeps its banking rather than one that spirals, which is the difference between a dial that
   * says "how twisted" and one that says "twist some more".
   */
  let placementRoll = 0;
  const rollReadout = el("span", { class: "slider__value", text: "0°" });
  const rollDial = el("input", {
    type: "range",
    class: "slider__input",
    min: "0",
    max: "360",
    step: String(ROLL_STEP),
    value: "0",
    // Built once and kept: a control being dragged must never be replaced under the pointer.
    onInput: (event: Event) => {
      const degrees = Number((event.target as HTMLInputElement).value);
      rollReadout.textContent = `${degrees}°`;
      placementRoll = (degrees * Math.PI) / 180;
    },
  });
  const rollRow = el("div", { class: "slider" }, [
    el("div", { class: "slider__label" }, [
      el("span", { text: "roll of new pieces" }),
      rollReadout,
    ]),
    rollDial,
  ]);

  const place = (piece: PieceSpec) => {
    const socket = options.socket();
    /**
     * The piece is generated **at the socket's size**, not scaled to it afterwards.
     *
     * Scaling the drawn geometry would change every curvature on it, which is the one thing
     * arrangement is not allowed to do. Writing the size into the formula instead means the two
     * boundaries agree because they are literally the same number.
     */
    const joinable = socket !== null && socket.port.kind === piece.plug;
    const size = joinable ? socket.port.size : 1;
    const build = piece.build(size);

    const name = nextName(SURFACE_NAMES, usedNames(store));
    const rowId = store.addRow(`${name}(u,v) = (${build.components.join(", ")})`).id;

    // The domain travels with the piece, insets applied — a cap's chart is singular at its tip.
    const [u0, u1] = sampleBounds(build.u);
    const [v0, v1] = sampleBounds(build.v);
    options.domains.set(rowId, [
      { min: u0, max: u1 },
      { min: v0, max: v1 },
    ]);

    if (joinable) {
      /**
       * The joint carries the **difference**, so the piece lands at the dial's roll.
       *
       * Its parent may already be twisted — every piece before it in the chain contributed — and
       * a joint's own roll is relative to that. Subtracting what has accumulated is what makes
       * "place at 30°" mean the same thing on the first piece and on the tenth.
       */
      const roll = normalizeRoll(placementRoll - absoluteRoll(socket.rowId, options.joints));
      options.joints.set(rowId, {
        parent: socket.rowId,
        parentBoundary: socket.port.boundary,
        childBoundary: piece.entry,
        roll,
      });
      blurb.textContent =
        `${piece.name} joined at radius ${size.toPrecision(3)}` +
        (placementRoll === 0 ? "." : `, rolled ${Math.round((placementRoll * 180) / Math.PI)}°.`);
    } else {
      options.onCreated?.(rowId);
      blurb.textContent = socket
        ? `${piece.name} needs ${piece.plug === "circle" ? "a rim" : "a straight edge"}, ` +
          `and that socket is ${socket.port.kind === "circle" ? "a rim" : "an edge"}` +
          " — dropped loose."
        : `${piece.name} dropped into the scene. Click one of its rings to build on.`;
    }

    // Chain: the far end becomes the next socket, so clicking the same piece again extends it.
    options.setSocket(piece.exit ? { rowId, boundary: piece.exit } : null);
    options.requestRender(false);
  };

  /**
   * The buttons, built once and kept.
   *
   * Which are usable changes with the socket, and that is a **disabled** state rather than a
   * filtered list: a bin whose contents rearrange every time a ring is clicked is a bin you have
   * to re-read, and a greyed button with a reason on it says why a tube cannot go on a plate's
   * edge, where a vanished one just leaves you wondering where the tube went.
   */
  const buttons = new Map<string, HTMLButtonElement>();
  const grid = el(
    "div",
    { class: "templates__grid" },
    PIECES.map((piece) => {
      const button = el("button", {
        class: "template",
        title: piece.blurb,
        onClick: () => {
          place(piece);
          blurb.title = piece.blurb;
        },
      }, [el("span", { class: "template__name", text: piece.name })]);
      buttons.set(piece.id, button);
      return button;
    }),
  );

  /**
   * The socket line and the joint controls, rebuilt on every scene change.
   *
   * Rebuilt rather than updated in place because neither holds text being typed — the one control
   * with state is the roll slider, and it is only shown while a jointed row is selected. Anything
   * a user could be mid-edit in has to be built once and left alone; these are not that.
   */
  const refresh = () => {
    const socket = options.socket();

    /**
     * Only what can actually be joined here.
     *
     * A tube plugs into a rim and a plate into a straight edge, and offering the other pairing
     * would mean either a join that does not meet or a piece silently dropped somewhere else.
     * With no socket chosen everything is available, because then nothing is being joined at all
     * and a piece is simply being added to the scene.
     */
    for (const piece of PIECES) {
      const button = buttons.get(piece.id);
      if (!button) continue;
      const usable = !socket || socket.port.kind === piece.plug;
      button.disabled = !usable;
      button.classList.toggle("template--unusable", !usable);
      button.title = usable
        ? piece.blurb
        : `${piece.name} joins ${piece.plug === "circle" ? "a rim" : "a straight edge"}, ` +
          `and this socket is ${socket!.port.kind === "circle" ? "a rim" : "an edge"}`;
    }

    const surface = options.surfaceOf(socket?.rowId ?? null);
    replace(status, [
      socket
        ? el("span", {
            class: "socket-status__on",
            text:
              `attaching to ${socket.port.kind === "circle" ? "a rim" : "an edge"} ` +
              `of size ${socket.port.size.toPrecision(3)}`,
          })
        : el("span", {
            class: "socket-status__off",
            text: "no socket — click a ring on the stage, or drop a piece loose",
          }),
      /**
       * What the socket belongs to, as a whole object.
       *
       * The point of joining patches is that they stop being separate things, so the panel names
       * the surface being built and how much of its boundary is still open — which is the number
       * that says whether a cobordism has been closed off yet.
       */
      surface
        ? el("span", {
            class: "socket-status__surface",
            text:
              `${surface.name}: ${surface.patches.length} ` +
              `${surface.patches.length === 1 ? "patch" : "patches"}, ` +
              (surface.closed
                ? "closed"
                : `${surface.freeBoundaries} open`),
          })
        : null,
    ]);

    const selected = options.selected();
    const joint = selected === null ? undefined : options.joints.get(selected);
    if (selected === null || !joint) {
      replace(jointControls, []);
      return;
    }

    const degrees = Math.round((joint.roll * 180) / Math.PI);
    const readout = el("span", { class: "slider__value", text: `${degrees}°` });
    const roll = el("input", {
      type: "range",
      class: "slider__input",
      min: "0",
      max: "360",
      step: String(ROLL_STEP),
      value: String(degrees),
      onInput: (event: Event) => {
        const turned = Number((event.target as HTMLInputElement).value);
        readout.textContent = `${turned}°`;
        options.joints.set(selected, {
          ...options.joints.get(selected) ?? joint,
          roll: (turned * Math.PI) / 180,
        });
        // A joint is a placement, not a formula: nothing reparses, so this takes the throttled
        // path and stays smooth while the slider is held.
        options.onParameterChange();
      },
    });

    replace(jointControls, [
      el("h2", { class: "section-title", text: "Joint" }),
      el("div", { class: "slider" }, [
        el("div", { class: "slider__label" }, [
          el("span", { text: "roll at this joint" }),
          readout,
        ]),
        roll,
      ]),
      el("button", {
        class: "chip",
        text: "detach",
        title: "release this joint, leaving the piece where it is",
        onClick: () => options.detach(selected),
      }),
    ]);
  };

  refresh();

  return {
    root: el("div", { class: "templates" }, [
      el("h2", { class: "section-title", text: "Pieces" }),
      status,
      grid,
      rollRow,
      blurb,
      jointControls,
    ]),
    refresh,
  };
}
