/**
 * Deferred hot reload: apply an edit when you ask for it, not the moment it lands.
 *
 * Vite's default is to reload the page whenever a module it cannot hot-swap changes. That is the
 * right default for most apps and the wrong one here: a scene takes real work to set up — a
 * parametrization typed in, sliders dragged to interesting values, a camera angle found, geodesics
 * aimed — and a reload discards all of it, often mid-sentence.
 *
 * So the reload is intercepted and a button offered instead. Pressing it saves the session, lets
 * the reload happen, and puts everything back. The page does technically reload; what matters is
 * that it happens when you choose and that you land where you left off.
 *
 * ## Why interception looks like this
 *
 * Vite has no supported way to cancel a full reload, so the handler THROWS. An exception in a
 * listener stops the rest of that event's chain, which is what prevents the reload — a deliberate
 * abuse of the event system, and the reason it is confined to this file behind `import.meta.hot`,
 * which is stripped from a production build entirely.
 *
 * Nothing here ships. If the trick stops working after a Vite upgrade the failure is loud and
 * harmless: the page reloads as it used to.
 */

/** Everything worth carrying across a reload, as plain JSON. */
export type Session = Record<string, unknown>;

const STORAGE_KEY = "diffgeo:hot-session";

export interface HotReloadGate {
  /** Whether an edit is waiting to be applied. */
  pending(): boolean;
}

/**
 * Install the gate. Does nothing outside the dev server.
 *
 * `capture` is called at the moment the user asks to apply, not when the edit arrives, so the
 * session saved is the one they were in when they pressed the button.
 */
export function installHotReloadGate(capture: () => Session): HotReloadGate {
  let pending = false;

  if (!import.meta.hot) return { pending: () => false };

  const button = document.createElement("button");
  button.className = "hot-apply";
  button.type = "button";
  button.textContent = "apply changes";
  button.title = "reload with the new code, keeping this scene";
  button.hidden = true;
  button.addEventListener("click", () => {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(capture()));
    } catch {
      // A session that cannot be serialised is not worth blocking the reload over; losing the
      // scene is bad, refusing to pick up the fix is worse.
    }
    location.reload();
  });
  document.body.append(button);

  import.meta.hot.on("vite:beforeFullReload", () => {
    pending = true;
    button.hidden = false;
    // See the note above: this is what stops the reload.
    throw new Error("diffgeo: full reload deferred until you press apply");
  });

  return { pending: () => pending };
}

/**
 * The session saved by the last apply, if there is one.
 *
 * Read once and cleared, so a later manual reload starts fresh — a saved scene that outlived the
 * edit it was saved for would be a state you cannot get out of.
 */
export function takeHotSession(): Session | null {
  if (!import.meta.hot) return null;
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    sessionStorage.removeItem(STORAGE_KEY);
    return JSON.parse(raw) as Session;
  } catch {
    return null;
  }
}
