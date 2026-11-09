/**
 * Shared types for SnapDraw.
 *
 * Everything that crosses a boundary (popup <-> service worker <-> editor tab)
 * is defined here so the messaging contract stays in one place.
 */

/** Where a capture was initiated from. */
export type CaptureSource = "popup" | "command";

/** What a recording is capturing: the current tab or the whole screen. */
export type RecordingSource = "tab" | "desktop";

/** Request sent from the popup (or the service worker itself) to capture. */
export interface CaptureRequest {
  type: "CAPTURE_SCREENSHOT";
  source?: CaptureSource;
}

export interface StartRecordingRequest {
  type: "RECORDING_START";
  streamId: string;
  source: RecordingSource;
}

export interface StopRecordingRequest {
  type: "RECORDING_STOP";
  /** Discard the recording without saving it (cancel). */
  discard?: boolean;
}

export interface RecordingStatusRequest {
  type: "RECORDING_STATUS";
}

/** Any message the extension sends to the service worker. */
export type RuntimeRequest =
  | CaptureRequest
  | StartRecordingRequest
  | StopRecordingRequest
  | RecordingStatusRequest;

/** Live recording state, shared by the popup and the service worker. */
export interface RecordingStatus {
  recording: boolean;
  source: RecordingSource | null;
  /** Epoch ms when the recording started, `null` when idle. */
  startedAt: number | null;
}

export type StartRecordingResponse =
  | { ok: true; status: RecordingStatus }
  | { ok: false; error: SnapDrawErrorPayload };

export type StopRecordingResponse =
  | {
      ok: true;
      sessionId?: string;
      name?: string;
      discarded: boolean;
    }
  | { ok: false; error: SnapDrawErrorPayload };

export type RecordingStatusResponse =
  | { ok: true; status: RecordingStatus }
  | { ok: false; error: SnapDrawErrorPayload };

/** Target marker for messages addressed to the offscreen recorder document. */
export const OFFSCREEN_TARGET = "snapdraw-offscreen";

export type OffscreenCommand =
  | {
      target: typeof OFFSCREEN_TARGET;
      type: "offscreen:start";
      streamId: string;
      source: RecordingSource;
    }
  | {
      target: typeof OFFSCREEN_TARGET;
      type: "offscreen:stop";
      discard?: boolean;
    }
  | {
      target: typeof OFFSCREEN_TARGET;
      type: "offscreen:status";
    };

export type OffscreenStartResult =
  | { ok: true; startedAt: number; source: RecordingSource }
  | { ok: false; message: string };

export type OffscreenStopResult =
  | {
      ok: true;
      sessionId?: string;
      name?: string;
      discarded: boolean;
    }
  | { ok: false; message: string };

export type OffscreenStatusResult =
  | {
      ok: true;
      recording: boolean;
      startedAt: number | null;
      source: RecordingSource | null;
    }
  | { ok: false; message: string };

/** Event sent by the offscreen document when a recording is saved on its own. */
export interface RecordingSavedEvent {
  target: "snapdraw-sw";
  type: "recording:saved";
  sessionId: string;
  name: string;
}

/** Event sent by the visible screen-share recorder when it starts recording. */
export interface RecordingStartedEvent {
  target: "snapdraw-sw";
  type: "recording:started";
  source: RecordingSource;
}

/** Event sent by the screen-share recorder when the user cancels/discards. */
export interface RecordingCancelledEvent {
  target: "snapdraw-sw";
  type: "recording:cancelled";
}

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

/** What kind of capture a history record holds. */
export type CaptureKind = "image" | "video";

/** Metadata persisted alongside a captured screenshot or recording. */
export interface ScreenshotMeta {
  id: string;
  name: string;
  createdAt: number;
  width: number;
  height: number;
  mimeType: string;
  /** Byte size of the stored blob. */
  size: number;
  /**
   * Capture type. Older records omit this field and are treated as images.
   */
  kind?: CaptureKind;
  /** Recording length in milliseconds (videos only). */
  durationMs?: number;
  sourceUrl?: string;
  sourceTitle?: string;
}

/**
 * The record stored in IndexedDB. The blob is stored as a real `Blob` so no
 * base64 inflation happens on the transfer path.
 */
export interface ScreenshotRecord extends ScreenshotMeta {
  blob: Blob;
  /** Small preview generated at capture time for the history list. */
  thumbnail?: Blob;
}

/**
 * A history row: metadata plus the optional thumbnail, never the full blob, so
 * listing the history stays cheap even with multi-MB captures stored.
 */
export interface ScreenshotHistoryEntry extends ScreenshotMeta {
  thumbnail?: Blob;
}
