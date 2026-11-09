import type {
  CaptureErrorCode,
  CaptureResponse,
  CaptureSource,
  RecordingSource,
  RecordingStatusResponse,
  RuntimeRequest,
  SnapDrawErrorPayload,
  StartRecordingResponse,
  StopRecordingResponse,
} from "../types";

/** Bundled extension page paths (stable output paths of the Vite build). */
export const POPUP_PAGE_PATH = "src/popup/popup.html";
export const EDITOR_PAGE_PATH = "src/editor/editor.html";
export const VIDEO_EDITOR_PAGE_PATH = "src/video/video.html";
/** Visible screen-share window used for "Whole screen" recording. */
export const SCREEN_RECORDER_PAGE_PATH = "src/recorder/recorder.html";
/** Hidden document that keeps the recording alive while the popup is closed. */
export const OFFSCREEN_PAGE_PATH = "src/offscreen/offscreen.html";

/** Query parameter used to hand a screenshot session id to the editor tab. */
export const SESSION_QUERY_PARAM = "session";

/** Query parameter used to surface an error state in the editor tab. */
export const ERROR_QUERY_PARAM = "error";

/** Query parameter that opens the editor without a screenshot. */
export const BLANK_QUERY_PARAM = "blank";

/** Thrown by extension side helpers so the UI can show friendly copy. */
export class SnapDrawError extends Error {
  readonly code: CaptureErrorCode;
  readonly hint?: string;

  constructor(code: CaptureErrorCode, message: string, hint?: string) {
    super(message);
    this.name = "SnapDrawError";
    this.code = code;
    this.hint = hint;
  }
}

export function errorPayload(
  code: CaptureErrorCode,
  message: string,
  hint?: string,
): SnapDrawErrorPayload {
  return hint ? { code, message, hint } : { code, message };
}

/** True when the page runs inside the SnapDraw extension (and can use APIs). */
export function isExtensionContext(): boolean {
  return (
    typeof chrome !== "undefined" &&
    typeof chrome.runtime !== "undefined" &&
    typeof chrome.runtime.id === "string"
  );
}

/** Absolute URL of an extension page, throwing a helpful error outside Chrome. */
export function extensionPageUrl(pagePath: string): string {
  if (!isExtensionContext()) {
    throw new SnapDrawError(
      "UNKNOWN",
      "SnapDraw needs to run inside Chrome.",
      "Open this page from the SnapDraw extension tab.",
    );
  }
  return chrome.runtime.getURL(pagePath);
}

/** Builds the editor tab URL for a given capture session. */
export function buildEditorUrl(sessionId: string): string {
  const url = new URL(extensionPageUrl(EDITOR_PAGE_PATH));
  url.searchParams.set(SESSION_QUERY_PARAM, sessionId);
  return url.toString();
}

/** Builds the editor tab URL that renders an error state. */
export function buildEditorErrorUrl(
  code: string,
  message?: string,
): string {
  const url = new URL(extensionPageUrl(EDITOR_PAGE_PATH));
  url.searchParams.set(ERROR_QUERY_PARAM, code);
  if (message) {
    url.searchParams.set("message", message);
  }
  return url.toString();
}

/** Builds the editor tab URL for a blank canvas (no capture session). */
export function buildBlankEditorUrl(): string {
  const url = new URL(extensionPageUrl(EDITOR_PAGE_PATH));
  url.searchParams.set(BLANK_QUERY_PARAM, "1");
  return url.toString();
}

/** True when the editor was opened as a blank canvas rather than a capture. */
export function isBlankEditorRequest(
  search: string = window.location.search,
): boolean {
  try {
    const value = new URLSearchParams(search).get(BLANK_QUERY_PARAM);
    return value === "1" || value === "true";
  } catch {
    return false;
  }
}

/** Builds the URL of the video editor tab for a stored recording. */
export function buildVideoEditorUrl(sessionId: string): string {
  const url = new URL(extensionPageUrl(VIDEO_EDITOR_PAGE_PATH));
  url.searchParams.set(SESSION_QUERY_PARAM, sessionId);
  return url.toString();
}

/** Absolute URL of the screen-share recorder window page. */
export function screenRecorderUrl(): string {
  return extensionPageUrl(SCREEN_RECORDER_PAGE_PATH);
}

/** Reads the session id from an editor page URL. */
export function readSessionId(search: string = window.location.search): string | null {
  try {
    const value = new URLSearchParams(search).get(SESSION_QUERY_PARAM);
    return value && value.trim().length > 0 ? value.trim() : null;
  } catch {
    return null;
  }
}

export interface EditorErrorParam {
  code: string;
  message?: string;
}

/** Reads the error parameters from an editor page URL. */
export function readEditorErrorParam(
  search: string = window.location.search,
): EditorErrorParam | null {
  try {
    const params = new URLSearchParams(search);
    const code = params.get(ERROR_QUERY_PARAM);
    if (!code) {
      return null;
    }
    const message = params.get("message") ?? undefined;
    return { code, message };
  } catch {
    return null;
  }
}

/**
 * Sends a message to the background service worker.
 *
 * `chrome.runtime.sendMessage` rejects when the worker is unreachable (for
 * example right after the extension was reloaded), so the rejection is
 * normalised into a `SnapDrawError`.
 */
export async function sendRuntimeMessage<TResponse>(
  message: RuntimeRequest,
): Promise<TResponse> {
  if (!isExtensionContext()) {
    throw new SnapDrawError(
      "UNKNOWN",
      "The SnapDraw extension is not available.",
      "Reload the extension from chrome://extensions and try again.",
    );
  }

  try {
    return (await chrome.runtime.sendMessage(message)) as TResponse;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (/Receiving end does not exist|Could not establish connection/i.test(detail)) {
      throw new SnapDrawError(
        "UNKNOWN",
        "SnapDraw's background worker is not responding.",
        "Reload the extension from chrome://extensions and try again.",
      );
    }
    throw new SnapDrawError(
      "UNKNOWN",
      detail || "SnapDraw could not reach its background worker.",
    );
  }
}

/** Requests a viewport capture and never throws – failures come back typed. */
export async function requestCapture(
  source: CaptureSource = "popup",
): Promise<CaptureResponse> {
  try {
    const response = await sendRuntimeMessage<CaptureResponse>({
      type: "CAPTURE_SCREENSHOT",
      source,
    });
    if (!response || typeof response !== "object" || !("ok" in response)) {
      return {
        ok: false,
        error: errorPayload(
          "UNKNOWN",
          "SnapDraw received an unexpected response.",
          "Please try again.",
        ),
      };
    }
    return response;
  } catch (error) {
    if (error instanceof SnapDrawError) {
      return { ok: false, error: errorPayload(error.code, error.message, error.hint) };
    }
    return {
      ok: false,
      error: errorPayload(
        "UNKNOWN",
        error instanceof Error ? error.message : "Screenshot capture failed.",
        "Please try again.",
      ),
    };
  }
}

/**
 * Registers a service worker message handler.
 *
 * Keeps the async response channel open and makes sure the promise always
 * resolves to a serialisable value.
 */
export function onRuntimeMessage(
  handler: (message: RuntimeRequest) => Promise<unknown> | undefined,
): void {
  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (
      typeof message !== "object" ||
      message === null ||
      (message as { type?: unknown }).type !== "CAPTURE_SCREENSHOT"
    ) {
      return undefined;
    }

    respondSafely(handler, message as RuntimeRequest, sendResponse);
    return true;
  });
}

function respondSafely(
  handler: (message: RuntimeRequest) => Promise<unknown> | undefined,
  message: RuntimeRequest,
  sendResponse: (response: unknown) => void,
): void {
  // Start from a resolved promise so a synchronous throw inside `handler` is
  // routed to the typed error response instead of escaping the listener.
  Promise.resolve()
    .then(() => handler(message))
    .then((result) => sendResponse(result))
    .catch((error: unknown) => {
      sendResponse({
        ok: false,
        error: errorPayload(
          "UNKNOWN",
          error instanceof Error ? error.message : "Capture failed unexpectedly.",
        ),
      });
    });
}

/** Normalises a thrown error into the typed response shape used by the UI. */
function toFailurePayload(error: unknown): SnapDrawErrorPayload {
  if (error instanceof SnapDrawError) {
    return errorPayload(error.code, error.message, error.hint);
  }
  return errorPayload(
    "UNKNOWN",
    error instanceof Error ? error.message : "Something unexpected happened.",
  );
}

/** Asks the service worker to start a recording. Never throws. */
export async function startRecording(
  streamId: string,
  source: RecordingSource,
): Promise<StartRecordingResponse> {
  try {
    return await sendRuntimeMessage<StartRecordingResponse>({
      type: "RECORDING_START",
      streamId,
      source,
    });
  } catch (error) {
    return { ok: false, error: toFailurePayload(error) };
  }
}

/** Asks the service worker to stop the active recording. Never throws. */
export async function stopRecording(
  discard = false,
): Promise<StopRecordingResponse> {
  try {
    return await sendRuntimeMessage<StopRecordingResponse>({
      type: "RECORDING_STOP",
      discard,
    });
  } catch (error) {
    return { ok: false, error: toFailurePayload(error) };
  }
}

/** Reads the current recording state. Never throws. */
export async function getRecordingStatus(): Promise<RecordingStatusResponse> {
  try {
    return await sendRuntimeMessage<RecordingStatusResponse>({
      type: "RECORDING_STATUS",
    });
  } catch (error) {
    return { ok: false, error: toFailurePayload(error) };
  }
}
