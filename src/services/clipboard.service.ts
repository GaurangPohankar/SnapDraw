/**
 * Clipboard helpers for the editor.
 *
 * Only the async Clipboard API is used – no `document.execCommand` fallback,
 * because it can silently no-op and would leave the user thinking the image was
 * copied when it was not.
 */

/** Stable, machine readable clipboard failure codes. */
export type ClipboardErrorCode =
  | "UNSUPPORTED"
  | "NOT_FOCUSED"
  | "PERMISSION_DENIED"
  | "WRITE_FAILED";

/** A typed, friendly clipboard failure with actionable guidance. */
export class ClipboardError extends Error {
  readonly code: ClipboardErrorCode;
  readonly hint?: string;

  constructor(code: ClipboardErrorCode, message: string, hint?: string) {
    super(message);
    this.name = "ClipboardError";
    this.code = code;
    this.hint = hint;
  }
}

/** True when this browser context can write PNG images to the clipboard. */
export function isClipboardImageCopySupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.clipboard !== "undefined" &&
    typeof navigator.clipboard.write === "function" &&
    typeof ClipboardItem !== "undefined"
  );
}

/**
 * Copies a PNG blob to the system clipboard.
 *
 * Rejects with a `ClipboardError` for every failure mode the UI needs to
 * explain: unsupported context, unfocused document, denied permission, or a
 * generic write failure.
 */
export async function copyImageBlobToClipboard(blob: Blob): Promise<void> {
  if (!isClipboardImageCopySupported()) {
    throw new ClipboardError(
      "UNSUPPORTED",
      "Clipboard access is not available in this context.",
      "Use Download PNG instead.",
    );
  }

  // ClipboardItem only accepts image/png for image data; keep the bytes as-is.
  const pngBlob =
    blob.type === "image/png" ? blob : new Blob([blob], { type: "image/png" });

  try {
    await navigator.clipboard.write([
      new ClipboardItem({ "image/png": pngBlob }),
    ]);
  } catch (error) {
    throw toClipboardError(error);
  }
}

function toClipboardError(error: unknown): ClipboardError {
  const name = error instanceof Error ? error.name : "";
  const detail = error instanceof Error ? error.message : String(error);

  if (typeof document !== "undefined" && !document.hasFocus()) {
    return new ClipboardError(
      "NOT_FOCUSED",
      "The editor window isn't focused.",
      "Click anywhere in the editor, then try again.",
    );
  }

  if (
    name === "NotAllowedError" ||
    name === "SecurityError" ||
    /permission|denied|not allowed/i.test(detail)
  ) {
    return new ClipboardError(
      "PERMISSION_DENIED",
      "Chrome blocked clipboard access.",
      "Click the editor and try again, or use Download PNG instead.",
    );
  }

  return new ClipboardError(
    "WRITE_FAILED",
    "The image could not be copied to the clipboard.",
    "Use Download PNG instead.",
  );
}
