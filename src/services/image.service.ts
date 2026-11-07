/**
 * Turns a locally stored screenshot into the pieces Excalidraw needs.
 */
import type { ScreenshotRecord } from "../types";
import {
  fitWithin,
  formatBytes,
  getImageDimensions,
  blobToDataUrl,
  type ImageDimensions,
} from "../utils/image-conversion";
import { getScreenshot } from "./storage.service";

export interface PreparedScreenshot {
  record: ScreenshotRecord;
  /** `data:image/png;base64,...` – required by Excalidraw's BinaryFiles map. */
  dataUrl: string;
  /** Natural pixel size of the screenshot. */
  width: number;
  height: number;
  /** Human readable size, shown in the editor header. */
  sizeLabel: string;
}

/** Loads the capture created by the service worker. */
export async function loadScreenshot(sessionId: string): Promise<ScreenshotRecord> {
  const record = await getScreenshot(sessionId);
  if (!record || !record.blob) {
    throw new Error("This screenshot is no longer available in local storage.");
  }
  return record;
}

/**
 * Decodes the capture and prepares the Excalidraw payload.
 *
 * The element keeps the original pixel dimensions – Excalidraw's zoom handles
 * fitting it on screen, so the exported PNG keeps full resolution.
 */
export async function prepareScreenshot(
  record: ScreenshotRecord,
): Promise<PreparedScreenshot> {
  const dimensions = await getImageDimensions(record.blob);
  const dataUrl = await blobToDataUrl(record.blob);
  const width = dimensions.width || record.width;
  const height = dimensions.height || record.height;

  return {
    record,
    dataUrl,
    width,
    height,
    sizeLabel: formatBytes(record.size || record.blob.size),
  };
}

/** Convenience: load + prepare in one call. */
export async function loadPreparedScreenshot(
  sessionId: string,
): Promise<PreparedScreenshot> {
  return prepareScreenshot(await loadScreenshot(sessionId));
}

/**
 * Size used when the screenshot is drawn 1:1 in scene coordinates. Kept as a
 * helper (rather than inlining the numbers) so future features – e.g. a
 * resizable "canvas preset" – can reuse it.
 */
export function screenshotElementSize(
  prepared: Pick<PreparedScreenshot, "width" | "height">,
): ImageDimensions {
  return { width: prepared.width, height: prepared.height };
}

/**
 * Largest screenshot we accept into the editor (Chrome caps the captured
 * viewport well below this; the guard protects against corrupt records).
 */
export const MAX_SCREENSHOT_EDGE = 8192;

export function isSupportedScreenshotSize(size: ImageDimensions): boolean {
  return (
    size.width > 0 &&
    size.height > 0 &&
    size.width <= MAX_SCREENSHOT_EDGE &&
    size.height <= MAX_SCREENSHOT_EDGE
  );
}

/** Fits the screenshot into a preview box without upscaling. */
export function previewSize(
  size: ImageDimensions,
  box: ImageDimensions,
): ImageDimensions {
  return fitWithin(size, box);
}
