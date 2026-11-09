/**
 * PNG export helpers for the editor tab.
 *
 * The whole scene (locked screenshot + annotations) is rendered locally by
 * Excalidraw into a canvas and handed back as a `Blob`. Nothing is uploaded and
 * nothing is written to disk unless the user explicitly downloads the file.
 */
import { exportToBlob, getCommonBounds } from "@excalidraw/excalidraw";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";

/** Stable, machine readable error codes used to pick the right toast copy. */
export type ExportErrorCode = "EMPTY_SCENE" | "CANVAS_TOO_LARGE" | "EXPORT_FAILED";

/** A typed, friendly export failure – the raw canvas errors never reach the UI. */
export class ExportError extends Error {
  readonly code: ExportErrorCode;
  readonly hint?: string;

  constructor(code: ExportErrorCode, message: string, hint?: string) {
    super(message);
    this.name = "ExportError";
    this.code = code;
    this.hint = hint;
  }
}

export interface ExportSceneOptions {
  /** All scene elements (deleted elements are filtered out internally). */
  elements: readonly ExcalidrawElement[];
  /** Excalidraw binary files map, keyed by file id. */
  files: BinaryFiles;
  /** Current editor app state; export specific fields are overridden below. */
  appState: AppState | null;
  /** Padding around the content in scene pixels. */
  padding?: number;
  /** `1` keeps the screenshot at its native pixel resolution. */
  scale?: number;
}

/** Breathing room around the annotated screenshot in exported PNGs. */
export const DEFAULT_EXPORT_PADDING = 16;
/** 1:1 pixels – no artificial downscaling of the capture. */
export const DEFAULT_EXPORT_SCALE = 1;
/** Chrome's safe upper bound for a single canvas edge. */
const MAX_EXPORT_EDGE = 16384;

/**
 * Renders the complete scene to a full-quality PNG.
 *
 * The export intentionally ignores the editor theme: the PNG always uses a
 * white background without the dark-mode canvas filter, so the result matches
 * what the user would get in Excalidraw's own light-mode export.
 */
export async function exportSceneToPngBlob({
  elements,
  files,
  appState,
  padding = DEFAULT_EXPORT_PADDING,
  scale = DEFAULT_EXPORT_SCALE,
}: ExportSceneOptions): Promise<Blob> {
  const liveElements = elements.filter((element) => !element.isDeleted);

  if (liveElements.length === 0) {
    throw new ExportError(
      "EMPTY_SCENE",
      "There is nothing to export yet.",
      "The screenshot or your annotations are missing – capture a new screenshot and try again.",
    );
  }

  assertExportSize(liveElements, padding, scale);

  // Canvas preferences may pick a solid scene background. Transparent keeps the
  // existing behaviour (white export) because a transparent PNG has no useful
  // backdrop for the annotation padding.
  const sceneBackground =
    typeof appState?.viewBackgroundColor === "string" &&
    appState.viewBackgroundColor !== "transparent"
      ? appState.viewBackgroundColor
      : "#ffffff";

  try {
    return await exportToBlob({
      elements: liveElements,
      appState: {
        ...(appState ?? {}),
        exportBackground: true,
        exportWithDarkMode: false,
        viewBackgroundColor: sceneBackground,
        exportScale: scale,
      },
      files,
      mimeType: "image/png",
      exportPadding: padding,
    });
  } catch (error) {
    if (error instanceof ExportError) {
      throw error;
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new ExportError(
      "EXPORT_FAILED",
      "The annotated screenshot could not be rendered.",
      /too large|invalid state|canvas/i.test(detail)
        ? "Try again, or capture a smaller window."
        : detail || "Please try again.",
    );
  }
}

/** Pre-flight guard so a huge scene fails with friendly copy, not a canvas error. */
function assertExportSize(
  elements: readonly ExcalidrawElement[],
  padding: number,
  scale: number,
): void {
  const [minX, minY, maxX, maxY] = getCommonBounds(elements);
  const width = Math.max(1, Math.ceil((maxX - minX + padding * 2) * scale));
  const height = Math.max(1, Math.ceil((maxY - minY + padding * 2) * scale));

  if (width > MAX_EXPORT_EDGE || height > MAX_EXPORT_EDGE) {
    throw new ExportError(
      "CANVAS_TOO_LARGE",
      `This scene is too large to export as one PNG (${width} × ${height}px).`,
      `Keep each side below ${MAX_EXPORT_EDGE}px – zoom out and move annotations closer together, or capture a smaller window.`,
    );
  }
}

/**
 * Saves a blob through a temporary object URL.
 *
 * The anchor is programmatic (the user already clicked a button) and the object
 * URL is revoked once Chrome has had time to start the download.
 */
export function downloadBlob(blob: Blob, filename: string): void {
  if (typeof document === "undefined" || typeof URL === "undefined") {
    throw new ExportError(
      "EXPORT_FAILED",
      "Downloads are not available in this context.",
      "Use Copy Image instead.",
    );
  }

  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.style.display = "none";

  document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    // Revoking immediately can cancel the download in some Chrome versions.
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
  }
}

const UNSAFE_FILENAME_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;
const MAX_FILENAME_LENGTH = 120;

/**
 * Builds a filesystem safe `.png` name.
 *
 * `name` is the suggested document name from the capture record (e.g.
 * `Screenshot 2026-11-07 21-55`). When it sanitises to nothing, a timestamp
 * based fallback such as `screenshot-2026-11-07-at-21-55-12.png` is used.
 */
export function buildExportFilename(name: string, date: Date = new Date()): string {
  const base = sanitizeExportName(name) || `screenshot-${formatTimestamp(date)}`;
  return `${base}.png`;
}

function sanitizeExportName(name: string): string {
  const withoutExtension = name.trim().replace(/\.png$/i, "");
  const safe = withoutExtension
    .replace(UNSAFE_FILENAME_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");

  return safe
    .replace(/\s/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, MAX_FILENAME_LENGTH)
    .replace(/[-.]+$/g, "");
}

function formatTimestamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `at-${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`,
  ].join("-");
}
