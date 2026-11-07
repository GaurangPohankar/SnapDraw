/**
 * Thumbnail generation for the screenshot history.
 *
 * Thumbnails are stored alongside each capture so the popup preview/history can
 * render instantly without decoding multi-MB screenshots. Captures saved by
 * older SnapDraw versions (or any record whose thumbnail is missing) are
 * backfilled on demand and the result is persisted.
 */
import { getScreenshot, putScreenshot } from "./storage.service";

/** Longest edge of a stored history thumbnail. */
export const THUMBNAIL_MAX_EDGE = 320;

/** A minimal shape needed to generate a thumbnail for a history row. */
export interface ThumbnailSource {
  id: string;
  width: number;
  height: number;
}

/**
 * Renders a small PNG preview from a screenshot blob.
 *
 * Works in both the service worker (OffscreenCanvas) and extension pages
 * (regular canvas fallback). Returns `undefined` when the environment cannot
 * decode/render — the caller then keeps a placeholder.
 */
export async function createThumbnail(
  blob: Blob,
  width: number,
  height: number,
): Promise<Blob | undefined> {
  try {
    if (typeof createImageBitmap !== "function") {
      return undefined;
    }

    const safeWidth = width > 0 ? width : 1;
    const safeHeight = height > 0 ? height : 1;
    const scale = Math.min(
      1,
      THUMBNAIL_MAX_EDGE / Math.max(safeWidth, safeHeight),
    );
    const thumbnailWidth = Math.max(1, Math.round(safeWidth * scale));
    const thumbnailHeight = Math.max(1, Math.round(safeHeight * scale));

    const bitmap = await createImageBitmap(blob);
    try {
      if (typeof OffscreenCanvas !== "undefined") {
        const canvas = new OffscreenCanvas(thumbnailWidth, thumbnailHeight);
        const context = canvas.getContext("2d");
        if (!context) {
          return undefined;
        }
        context.drawImage(bitmap, 0, 0, thumbnailWidth, thumbnailHeight);
        return await canvas.convertToBlob({ type: "image/png" });
      }

      if (typeof document === "undefined") {
        return undefined;
      }

      const canvas = document.createElement("canvas");
      canvas.width = thumbnailWidth;
      canvas.height = thumbnailHeight;
      const context = canvas.getContext("2d");
      if (!context) {
        return undefined;
      }
      context.drawImage(bitmap, 0, 0, thumbnailWidth, thumbnailHeight);

      return await new Promise<Blob | undefined>((resolve) => {
        canvas.toBlob((result) => resolve(result ?? undefined), "image/png");
      });
    } finally {
      if (typeof bitmap.close === "function") {
        bitmap.close();
      }
    }
  } catch {
    return undefined;
  }
}

/**
 * Returns the thumbnail for a saved capture, generating and persisting one from
 * the stored full-size blob when it is missing (legacy records).
 */
export async function ensureThumbnailFor(
  source: ThumbnailSource,
): Promise<Blob | undefined> {
  const record = await getScreenshot(source.id);
  if (!record) {
    return undefined;
  }

  if (record.thumbnail instanceof Blob) {
    return record.thumbnail;
  }

  const thumbnail = await createThumbnail(
    record.blob,
    record.width || source.width,
    record.height || source.height,
  );
  if (!thumbnail) {
    return undefined;
  }

  try {
    // Persist it so later popup opens are instant (and reflect the healing).
    await putScreenshot({ ...record, thumbnail });
  } catch {
    // Displaying the thumbnail still works even if the write failed.
  }

  return thumbnail;
}
