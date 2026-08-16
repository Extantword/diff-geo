import { readSceneFile } from "../state/session.ts";
import { el, replace } from "./dom.ts";

/**
 * Save the scene to a file, and open one back.
 *
 * A download and a file input, which is the whole of it — no server, no storage permissions, and
 * a file the user owns and can put in a repository next to the figure it produces. That last part
 * is the point rather than a side effect: the eventual book needs figures that are reproducible,
 * and a scene is exactly the input that reproduces one.
 *
 * Saving without opening would be a dead end, so both live here together.
 */

export interface SceneFileOptions {
  /** the whole scene as JSON-able data, tagged and versioned by `makeSceneFile` */
  readonly capture: () => unknown;
  /** put a scene back; returns a message to show, or null when it worked */
  readonly restore: (file: { scene: unknown; camera?: unknown }) => void;
  /** what to call the file, without the extension */
  readonly name?: string;
}

export interface SceneFileControls {
  readonly root: HTMLElement;
}

/** `diffgeo-2026-08-14-2312`, so saves from one session sort and do not collide. */
function stamp(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}`
  );
}

export function createSceneFile(options: SceneFileOptions): SceneFileControls {
  const status = el("div", { class: "file-status" });

  const say = (message: string, bad = false) => {
    replace(status, [
      el("span", { class: bad ? "file-status__bad" : "file-status__ok", text: message }),
    ]);
  };

  const save = () => {
    const text = JSON.stringify(options.capture(), null, 2);
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    const link = el("a", {
      href: url,
      download: `${options.name ?? "diffgeo"}-${stamp()}.json`,
    });
    // Not attached to the document: a click on a detached anchor still starts the download, and
    // nothing is left behind to be styled, focused or tripped over.
    link.click();
    // Freed on the next turn of the event loop rather than immediately — revoking synchronously
    // races the download in some browsers, and the object is small.
    setTimeout(() => URL.revokeObjectURL(url), 0);
    say(`saved ${Math.round(text.length / 1024)} kB`);
  };

  /**
   * The file input is hidden behind a button of our own.
   *
   * A bare `<input type="file">` cannot be styled and reads as a form control in a panel that has
   * none. Its value is cleared after every read so that opening the *same* file twice still
   * fires — the second change event never arrives otherwise, which reads as the button being
   * broken.
   */
  const picker = el("input", {
    type: "file",
    accept: "application/json,.json",
    style: "display:none",
  }) as HTMLInputElement;

  picker.addEventListener("change", () => {
    const file = picker.files?.[0];
    picker.value = "";
    if (!file) return;
    file
      .text()
      .then((text) => {
        const result = readSceneFile(text);
        if ("error" in result) {
          say(result.error, true);
          return;
        }
        options.restore(result);
        say(`opened ${file.name}`);
      })
      .catch(() => say("that file could not be read", true));
  });

  const root = el("div", { class: "file-actions" }, [
    el("button", {
      class: "chip",
      text: "save",
      title: "download this scene as a file",
      onClick: save,
    }),
    el("button", {
      class: "chip",
      text: "open",
      title: "replace this scene with one from a file",
      onClick: () => picker.click(),
    }),
    picker,
    status,
  ]);

  return { root };
}
