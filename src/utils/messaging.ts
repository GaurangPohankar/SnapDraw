import type {
  CaptureErrorCode,
  CaptureResponse,
  CaptureSource,
  RuntimeRequest,
  SnapDrawErrorPayload,
} from "../types";

/** Bundled extension page paths (stable output paths of the Vite build). */
export const POPUP_PAGE_PATH = "src/popup/popup.html";
export const EDITOR_PAGE_PATH = "src/editor/editor.html";

/** Query parameter used to hand a screenshot session id to the editor tab. */
export const SESSION_QUERY_PARAM = "session";

/** Query parameter used to surface an error state in the editor tab. */
export const ERROR_QUERY_PARAM = "error";

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

    // Start from a resolved promise so a synchronous throw inside `handler` is
    // routed to the typed error response instead of escaping the listener.
    Promise.resolve()
      .then(() => handler(message as RuntimeRequest))
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

    // Keep the message channel open for the async response.
    return true;
  });
}
