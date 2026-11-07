/**
 * Screenshot capture pipeline for the SnapDraw background service worker.
 *
 * Flow:
 *   active tab -> chrome.tabs.captureVisibleTab -> PNG blob -> IndexedDB
 *   -> editor tab
 *
 * Everything stays on this machine: the data URL is turned into a `Blob`,
 * stored in IndexedDB and never leaves the browser. The service worker can be
 * terminated between any two awaited calls, so no screenshot depends on module
 * state: every capture gets a fresh UUID and is written to storage before an
 * editor tab can reference it.
 *
 * The three pure helpers (`classifyTabUrl`, `buildScreenshotName`,
 * `toErrorPayload`) are exported so they can be unit tested without Chrome.
 */
import type {
  CaptureResponse,
  CaptureSource,
  ScreenshotRecord,
  SnapDrawErrorPayload,
} from "../types";
import { dataUrlToBlob, getImageDimensions } from "../utils/image-conversion";
import { SnapDrawError, buildEditorUrl, errorPayload } from "../utils/messaging";
import {
  deleteScreenshot,
  purgeExpiredScreenshots,
  putScreenshot,
  trimScreenshots,
} from "./storage.service";
import { createThumbnail } from "./thumbnail.service";

/**
 * Largest screenshot edge SnapDraw accepts. Chrome never produces a viewport
 * capture this large in practice; the guard protects the editor from corrupt
 * records.
 */
export const MAX_CAPTURE_EDGE = 8192;

/** Why a page cannot be captured. */
export type RestrictedPageReason =
  | "browser-internal"
  | "web-store"
  | "extension-page"
  | "devtools"
  | "unknown";

export interface TabUrlClassification {
  restricted: boolean;
  reason?: RestrictedPageReason;
}

/** Friendly copy shown for each restricted page type. */
const RESTRICTED_PAGE_COPY: Record<
  RestrictedPageReason,
  { message: string; hint: string }
> = {
  "browser-internal": {
    message: "Chrome doesn't allow capturing this page.",
    hint: "Open a normal website tab and try again.",
  },
  "web-store": {
    message: "Chrome doesn't allow capturing the Chrome Web Store.",
    hint: "Open a normal website tab and try again.",
  },
  "extension-page": {
    message: "Chrome doesn't allow capturing extension pages.",
    hint: "Switch to a normal website tab and try again.",
  },
  devtools: {
    message: "Chrome doesn't allow capturing DevTools.",
    hint: "Switch back to the page you're inspecting and try again.",
  },
  unknown: {
    message: "SnapDraw can't capture this page.",
    hint: "Open a normal website tab and try again.",
  },
};

/** URL schemes Chrome never lets extensions capture. */
const BROWSER_INTERNAL_PREFIXES: readonly string[] = [
  "chrome://",
  "chrome-untrusted://",
  "chrome-search://",
  "chrome-error://",
  "edge://",
  "brave://",
  "about:",
  "view-source:",
];

const CAPTURE_PERMISSION_HINT =
  "Click the SnapDraw toolbar icon on the page you want to capture, then try again.";

const CAPTURE_FAILED_HINT =
  "Make sure the tab is visible, then try again.";

const UNKNOWN_ERROR: SnapDrawErrorPayload = errorPayload(
  "UNKNOWN",
  "SnapDraw hit an unexpected error.",
  "Please try again, or reload SnapDraw from chrome://extensions.",
);

/**
 * True when the URL points at a Chrome Web Store page. The store blocks
 * `captureVisibleTab` as well as script injection.
 */
function isWebStoreUrl(normalizedUrl: string): boolean {
  const match = /^(?:https?:\/\/)?([^/?#]+)([^?#]*)/.exec(normalizedUrl);
  if (!match) {
    return false;
  }

  const host = match[1].replace(/^www\./, "").replace(/:\d+$/, "");
  const path = match[2] || "/";

  if (host === "chromewebstore.google.com") {
    return true;
  }
  return (
    host === "chrome.google.com" &&
    (path === "/webstore" || path.startsWith("/webstore/"))
  );
}

/**
 * Classifies a tab URL so the capture pipeline can fail early with a helpful
 * message instead of surfacing Chrome's raw `captureVisibleTab` error.
 *
 * `tab.url` is only populated when the extension holds the `activeTab` grant
 * (granted by the toolbar click or the keyboard command).
 */
export function classifyTabUrl(url: string | undefined): TabUrlClassification {
  const normalized = (url ?? "").trim().toLowerCase();

  if (normalized.length === 0) {
    // Chrome hides `url` until the activeTab grant is in place, and pages like
    // the new tab page report an empty URL.
    return { restricted: true, reason: "unknown" };
  }

  if (normalized.startsWith("chrome-extension://")) {
    return { restricted: true, reason: "extension-page" };
  }

  if (normalized.startsWith("devtools://")) {
    return { restricted: true, reason: "devtools" };
  }

  if (isWebStoreUrl(normalized)) {
    return { restricted: true, reason: "web-store" };
  }

  const isBrowserInternal = BROWSER_INTERNAL_PREFIXES.some((prefix) =>
    normalized.startsWith(prefix),
  );
  if (isBrowserInternal) {
    return { restricted: true, reason: "browser-internal" };
  }

  return { restricted: false };
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, "0");
}

/**
 * Builds the human readable document name, e.g.
 * `Screenshot 2026-11-07 at 21.55.12`.
 *
 * Uses the browser's local time and only characters that are legal in Windows
 * and macOS file names (no `:`, `/`, `\`, `*`, `?`, `"`, `<`, `>`, `|`).
 */
export function buildScreenshotName(date: Date = new Date()): string {
  const value = Number.isFinite(date.getTime()) ? date : new Date();
  const year = value.getFullYear();
  const month = pad(value.getMonth() + 1);
  const day = pad(value.getDate());
  const hours = pad(value.getHours());
  const minutes = pad(value.getMinutes());
  const seconds = pad(value.getSeconds());

  return `Screenshot ${year}-${month}-${day} at ${hours}.${minutes}.${seconds}`;
}

/** Extracts a readable message from anything that was thrown. */
function readableErrorMessage(error: unknown): string {
  if (typeof error === "string") {
    return error.trim();
  }
  if (error instanceof Error) {
    return error.message.trim();
  }
  if (typeof error === "object" && error !== null) {
    // Chrome's `runtime.lastError` is a plain `{ message }` object.
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") {
      return message.trim();
    }
  }
  return "";
}

/** Messages produced by Chrome's capture API (sometimes without a typed class). */
const CHROME_CAPTURE_ERROR_PATTERNS: readonly RegExp[] = [
  /capture/i,
  /activeTab|active tab/i,
  /permission|not granted|forbidden|denied/i,
  /chrome:\/\/|chrome-extension:\/\/|chrome-untrusted:\/\/|edge:\/\/|devtools:\/\//i,
  /no (?:active|visible) tab|tab (?:is )?(?:not|can't|cannot) (?:be )?(?:captured|visible)/i,
  /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND|quota/i,
];

function looksLikeChromeCaptureError(message: string): boolean {
  return CHROME_CAPTURE_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

/** Maps a raw Chrome capture failure to a friendly, user facing payload. */
function describeCaptureError(rawMessage: string): SnapDrawErrorPayload {
  if (/MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND|too (?:many|often)|quota/i.test(rawMessage)) {
    return errorPayload(
      "CAPTURE_FAILED",
      "SnapDraw is capturing too quickly.",
      "Wait a second, then try again.",
    );
  }

  if (/chrome:\/\/|chrome-extension:\/\/|chrome-untrusted:\/\/|edge:\/\/|devtools:\/\/|extension page|browser page|internal page/i.test(rawMessage)) {
    return errorPayload(
      "CAPTURE_FAILED",
      "Chrome doesn't allow capturing this page.",
      "Open a normal website tab and try again.",
    );
  }

  if (/activeTab|active tab|permission|not granted|forbidden|denied|access/i.test(rawMessage)) {
    return errorPayload(
      "CAPTURE_FAILED",
      "SnapDraw doesn't have permission to capture this page.",
      CAPTURE_PERMISSION_HINT,
    );
  }

  if (/visible|foreground|minimi[sz]ed|hidden|window/i.test(rawMessage)) {
    return errorPayload(
      "CAPTURE_FAILED",
      "SnapDraw couldn't capture the page.",
      "Bring the tab to the front, then try again.",
    );
  }

  return errorPayload(
    "CAPTURE_FAILED",
    "SnapDraw couldn't capture the page.",
    CAPTURE_FAILED_HINT,
  );
}

/**
 * Normalises anything the capture pipeline throws into the shared typed error
 * payload. `SnapDrawError`s keep their code/message/hint; Chrome capture
 * failures become `CAPTURE_FAILED` with cleaned up copy; everything else is
 * `UNKNOWN`.
 */
export function toErrorPayload(error: unknown): SnapDrawErrorPayload {
  if (error instanceof SnapDrawError) {
    return errorPayload(error.code, error.message, error.hint);
  }

  const rawMessage = readableErrorMessage(error);
  if (rawMessage.length > 0 && looksLikeChromeCaptureError(rawMessage)) {
    return describeCaptureError(rawMessage);
  }

  return UNKNOWN_ERROR;
}

/** Logs a short, non sensitive description of an error (never the image). */
function describeErrorForLog(error: unknown): string {
  const message = readableErrorMessage(error) || "unknown error";
  return message.length > 200 ? `${message.slice(0, 199)}…` : message;
}

/** Deletes a record after a failed editor launch – never leave orphans behind. */
async function discardStoredScreenshot(sessionId: string): Promise<void> {
  try {
    await deleteScreenshot(sessionId);
  } catch (error) {
    console.warn(
      `[SnapDraw] could not clean up screenshot ${sessionId}: ${describeErrorForLog(error)}`,
    );
  }
}

/**
 * Prunes the local screenshot history: drops captures older than the retention
 * window and keeps only the newest `HISTORY_LIMIT` entries. Never throws.
 */
export async function purgeExpiredSessions(): Promise<number> {
  try {
    const expired = await purgeExpiredScreenshots();
    const trimmed = await trimScreenshots();
    const removed = expired + trimmed;
    if (removed > 0) {
      console.log(
        `[SnapDraw] pruned ${removed} old screenshot(s) (${expired} expired, ${trimmed} over the history limit)`,
      );
    }
    return removed;
  } catch (error) {
    console.warn(
      `[SnapDraw] could not prune the screenshot history: ${describeErrorForLog(error)}`,
    );
    return 0;
  }
}

// A single boolean in-flight guard: it makes rapid double invocations fail
// politely instead of racing `captureVisibleTab`. The `finally` block always
// releases it, so a failed capture can never permanently block retries.
let captureInFlight = false;

function findActiveTab(): Promise<chrome.tabs.Tab> {
  return chrome.tabs
    .query({ active: true, lastFocusedWindow: true })
    .then((tabs) => {
      const tab = tabs[0];
      if (!tab) {
        throw new SnapDrawError(
          "NO_ACTIVE_TAB",
          "SnapDraw couldn't find an active tab to capture.",
          "Open a website in Chrome, then try again.",
        );
      }
      return tab;
    })
    .catch((error: unknown) => {
      if (error instanceof SnapDrawError) {
        throw error;
      }
      throw new SnapDrawError(
        "NO_ACTIVE_TAB",
        "SnapDraw couldn't tell which tab to capture.",
        "Make sure a Chrome window is focused, then try again.",
      );
    });
}

/** Re-wraps an arbitrary failure at the capture step as CAPTURE_FAILED. */
function asCaptureFailure(error: unknown): SnapDrawError {
  if (error instanceof SnapDrawError) {
    return error;
  }

  const payload = toErrorPayload(error);
  if (payload.code === "CAPTURE_FAILED") {
    return new SnapDrawError(
      "CAPTURE_FAILED",
      payload.message,
      payload.hint ?? CAPTURE_PERMISSION_HINT,
    );
  }
  return new SnapDrawError(
    "CAPTURE_FAILED",
    "SnapDraw couldn't capture this page.",
    CAPTURE_PERMISSION_HINT,
  );
}

async function capturePng(windowId: number): Promise<string> {
  let dataUrl: string;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
  } catch (error) {
    throw asCaptureFailure(error);
  }

  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) {
    throw new SnapDrawError(
      "CAPTURE_FAILED",
      "Chrome returned an empty screenshot.",
      "Make sure the page is fully loaded, then try again.",
    );
  }
  return dataUrl;
}

function decodeScreenshot(dataUrl: string): Blob {
  try {
    return dataUrlToBlob(dataUrl);
  } catch {
    throw new SnapDrawError(
      "CAPTURE_FAILED",
      "The captured screenshot could not be decoded.",
      "Please try the capture again.",
    );
  }
}

async function readScreenshotSize(
  blob: Blob,
): Promise<{ width: number; height: number }> {
  try {
    return await getImageDimensions(blob);
  } catch {
    throw new SnapDrawError(
      "CAPTURE_FAILED",
      "The captured screenshot could not be read.",
      "Please try the capture again.",
    );
  }
}

function assertSupportedSize(width: number, height: number): void {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new SnapDrawError(
      "CAPTURE_FAILED",
      "Chrome returned an empty screenshot.",
      "Make sure the page is fully loaded, then try again.",
    );
  }

  if (width > MAX_CAPTURE_EDGE || height > MAX_CAPTURE_EDGE) {
    throw new SnapDrawError(
      "CAPTURE_FAILED",
      "The captured screenshot is too large for SnapDraw.",
      `Resize the browser window so each side is at most ${MAX_CAPTURE_EDGE}px, then try again.`,
    );
  }
}

async function saveScreenshot(record: ScreenshotRecord): Promise<void> {
  try {
    await putScreenshot(record);
  } catch (error) {
    console.warn(
      `[SnapDraw] local storage failed: ${describeErrorForLog(error)}`,
    );
    throw new SnapDrawError(
      "STORAGE_FAILED",
      "SnapDraw couldn't save the screenshot locally.",
      "Check that Chrome has enough disk space, then try again.",
    );
  }
}

async function openEditorTab(sessionId: string): Promise<number | undefined> {
  try {
    const tab = await chrome.tabs.create({
      url: buildEditorUrl(sessionId),
      active: true,
    });
    return tab.id;
  } catch (error) {
    // The screenshot is useless without its editor: remove it so storage never
    // accumulates orphans.
    await discardStoredScreenshot(sessionId);
    console.warn(
      `[SnapDraw] could not open the editor tab: ${describeErrorForLog(error)}`,
    );
    throw new SnapDrawError(
      "EDITOR_TAB_FAILED",
      "SnapDraw couldn't open the editor tab.",
      "Check that Chrome is allowed to open new tabs, then try again.",
    );
  }
}

function restrictedPageError(
  reason: RestrictedPageReason | undefined,
): SnapDrawError {
  const copy = RESTRICTED_PAGE_COPY[reason ?? "unknown"];
  return new SnapDrawError("RESTRICTED_PAGE", copy.message, copy.hint);
}

async function runCapture(source: CaptureSource): Promise<CaptureResponse> {
  console.debug(`[SnapDraw] capture started (${source})`);

  // 1. Resolve the active tab of the last focused window.
  const tab = await findActiveTab();

  // 2. Reject pages Chrome never allows extensions to capture.
  const classification = classifyTabUrl(tab.url);
  if (classification.restricted) {
    throw restrictedPageError(classification.reason);
  }

  // 3. Capture the visible viewport as a PNG data URL.
  const dataUrl = await capturePng(tab.windowId);

  // 4. Decode it and validate the pixel size.
  const blob = decodeScreenshot(dataUrl);
  const { width, height } = await readScreenshotSize(blob);
  assertSupportedSize(width, height);

  // 5. Persist the record (and a small preview) under a fresh UUID session.
  //    The record is kept afterwards: the editor can be refreshed, and the
  //    capture stays available from the history list.
  const sessionId = crypto.randomUUID();
  const thumbnail = await createThumbnail(blob, width, height);
  const record: ScreenshotRecord = {
    id: sessionId,
    name: buildScreenshotName(),
    createdAt: Date.now(),
    width,
    height,
    mimeType: "image/png",
    size: blob.size,
    blob,
    ...(thumbnail ? { thumbnail } : {}),
    ...(tab.url ? { sourceUrl: tab.url } : {}),
    ...(tab.title ? { sourceTitle: tab.title } : {}),
  };
  await saveScreenshot(record);

  // 6. Hand the session to a foreground editor tab. On failure the stored
  //    record is deleted inside `openEditorTab`.
  const editorTabId = await openEditorTab(sessionId);

  // 7. Opportunistically prune old captures so history stays bounded.
  void purgeExpiredSessions();

  console.debug(
    `[SnapDraw] capture stored ${width}x${height} (${blob.size} bytes)`,
  );

  return {
    ok: true,
    sessionId,
    name: record.name,
    width,
    height,
    ...(editorTabId !== undefined ? { editorTabId } : {}),
  };
}

/**
 * Captures the visible viewport of the active tab and opens the SnapDraw
 * editor with it. Never throws: every failure is returned as a typed
 * `SnapDrawErrorPayload` the popup can display directly.
 */
export async function captureVisibleViewport(
  source: CaptureSource = "popup",
): Promise<CaptureResponse> {
  if (captureInFlight) {
    return {
      ok: false,
      error: errorPayload(
        "CAPTURE_FAILED",
        "A screenshot capture is already in progress.",
        "Wait a moment, then try again.",
      ),
    };
  }

  captureInFlight = true;
  try {
    return await runCapture(source);
  } catch (error) {
    const payload = toErrorPayload(error);
    console.warn(`[SnapDraw] capture failed (${payload.code}): ${payload.message}`);
    return { ok: false, error: payload };
  } finally {
    captureInFlight = false;
  }
}
