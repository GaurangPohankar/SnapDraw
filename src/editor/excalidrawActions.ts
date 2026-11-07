/**
 * Imperative helpers for the Excalidraw 0.18 canvas.
 *
 * The published `ExcalidrawImperativeAPI` exposes no `undo()` / `redo()` method
 * in 0.18 (only `history.clear`), so the header buttons replay the keyboard
 * shortcut Excalidraw itself listens for. The synthetic `keydown` is dispatched
 * on the `.excalidraw` element found under our own workspace wrapper – never on
 * `document` – so the event goes through Excalidraw's React `onKeyDown` handler
 * and its action manager exactly like a real key press. Side effect: undo/redo
 * is captured in Excalidraw's normal history stack, so users can also press
 * Ctrl/Cmd+Z directly.
 */
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";

export type HistoryDirection = "undo" | "redo";

const HISTORY_KEYS: Record<HistoryDirection, { shiftKey: boolean }> = {
  undo: { shiftKey: false },
  redo: { shiftKey: true },
};

/** Finds the Excalidraw root inside our workspace wrapper. */
export function findExcalidrawContainer(
  root: HTMLElement | null,
): HTMLElement | null {
  return root?.querySelector<HTMLElement>(".excalidraw") ?? null;
}

/**
 * Replays Ctrl/Cmd+Z (Shift for redo) against the editor.
 *
 * Returns `false` when the editor is not mounted yet.
 */
export function dispatchHistoryShortcut(
  root: HTMLElement | null,
  direction: HistoryDirection,
): boolean {
  const container = findExcalidrawContainer(root);
  if (!container) {
    return false;
  }

  // Focus first so any follow-up keyboard interaction lands in the editor.
  container.focus({ preventScroll: true });

  const { shiftKey } = HISTORY_KEYS[direction];
  container.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "z",
      code: "KeyZ",
      ctrlKey: true,
      metaKey: true,
      shiftKey,
      altKey: false,
      bubbles: true,
      cancelable: true,
      composed: true,
    }),
  );

  return true;
}

export interface SceneSnapshot {
  elements: readonly ExcalidrawElement[];
  files: BinaryFiles;
  appState: AppState;
}

/** Reads everything the export helpers need from the live editor. */
export function readScene(api: ExcalidrawImperativeAPI): SceneSnapshot {
  return {
    elements: api.getSceneElements(),
    files: api.getFiles(),
    appState: api.getAppState(),
  };
}

/**
 * Centres and fits the whole scene. Used once on mount and by "Reset view".
 */
export function fitSceneToContent(
  api: ExcalidrawImperativeAPI,
  options: { animate?: boolean } = {},
): boolean {
  const elements = api.getSceneElements();
  if (elements.length === 0) {
    return false;
  }

  api.scrollToContent(elements, {
    fitToContent: true,
    animate: options.animate ?? false,
  });
  return true;
}
