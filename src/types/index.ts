/**
 * Shared types for SnapDraw.
 *
 * Everything that crosses a boundary (popup <-> service worker <-> editor tab)
 * is defined here so the messaging contract stays in one place.
 */

/** Where a capture was initiated from. */
export type CaptureSource = "popup" | "command";

/** Request sent from the popup (or the service worker itself) to capture. */
export interface CaptureRequest {
  type: "CAPTURE_SCREENSHOT";
  source?: CaptureSource;
}

/** Any message the extension sends to the service worker. */
export type RuntimeRequest = CaptureRequest;

/** Stable, machine readable error codes. */
export type CaptureErrorCode =
  | "RESTRICTED_PAGE"
  | "NO_ACTIVE_TAB"
  | "CAPTURE_FAILED"
  | "STORAGE_FAILED"
  | "EDITOR_TAB_FAILED"
  | "UNKNOWN";

export interface SnapDrawErrorPayload {
  code: CaptureErrorCode;
  /** A short, human friendly sentence shown directly in the UI. */
  message: string;
  /** Optional secondary line with a suggested fix. */
  hint?: string;
}

/** Result of a `CAPTURE_SCREENSHOT` request. */
export type CaptureResponse =
  | {
      ok: true;
      sessionId: string;
      /** Suggested document name, e.g. `Screenshot 2026-11-07 21-55`. */
      name: string;
      width: number;
      height: number;
      /** Id of the editor tab that was opened. */
      editorTabId?: number;
    }
  | {
      ok: false;
      error: SnapDrawErrorPayload;
    };

/** Metadata persisted alongside a captured screenshot. */
export interface ScreenshotMeta {
  id: string;
  name: string;
  createdAt: number;
  width: number;
  height: number;
  mimeType: string;
  /** Byte size of the stored blob. */
  size: number;
  sourceUrl?: string;
  sourceTitle?: string;
}

/**
 * The record stored in IndexedDB. The blob is stored as a real `Blob` so no
 * base64 inflation happens on the transfer path.
 */
export interface ScreenshotRecord extends ScreenshotMeta {
  blob: Blob;
}
