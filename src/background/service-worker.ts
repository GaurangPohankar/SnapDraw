/**
 * SnapDraw background service worker (Manifest V3).
 *
 * Responsibilities:
 *   - answer `CAPTURE_SCREENSHOT` messages from the popup,
 *   - run the same capture for the `capture-screenshot` keyboard command and
 *     surface failures through the toolbar badge/title (no popup is open on
 *     that path),
 *   - purge expired screenshot sessions on install/startup.
 *
 * The worker is stateless between events: Chrome may terminate it at any time.
 * The only module state is short lived UI feedback (the in-flight guard lives
 * in the capture service).
 */
import type {
  CaptureResponse,
  CaptureSource,
  RuntimeRequest,
  SnapDrawErrorPayload,
} from "../types";
import {
  captureVisibleViewport,
  purgeExpiredSessions,
  toErrorPayload,
} from "../services/screenshot.service";
import {
  buildEditorErrorUrl,
  onRuntimeMessage,
} from "../utils/messaging";

const CAPTURE_COMMAND = "capture-screenshot";

/** Mirrors the action title declared in `public/manifest.json`. */
const DEFAULT_ACTION_TITLE = "SnapDraw – capture & annotate";
const ERROR_BADGE_TEXT = "!";
const ERROR_BADGE_COLOR = "#ef4444";
/** How long the error title/badge stays visible after a failed capture. */
const ERROR_FEEDBACK_MS = 5_000;
const ERROR_TITLE_MAX_LENGTH = 90;
/** Debounce for the explanation tab opened after a failed keyboard capture. */
const ERROR_TAB_DEBOUNCE_MS = 5_000;

let lastCommandErrorTabAt = 0;

/** Reads the manifest title so the tooltip always matches the manifest. */
function defaultActionTitle(): string {
  try {
    const manifest = chrome.runtime.getManifest();
    if (manifest.manifest_version === 3) {
      return manifest.action?.default_title ?? DEFAULT_ACTION_TITLE;
    }
  } catch {
    // Fall through to the bundled title.
  }
  return DEFAULT_ACTION_TITLE;
}

/** Logs a chrome.action rejection without leaking anything sensitive. */
function logActionError(operation: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  console.debug(`[SnapDraw] chrome.action ${operation} failed: ${detail}`);
}

let feedbackResetTimer: ReturnType<typeof setTimeout> | undefined;

function cancelFeedbackReset(): void {
  if (feedbackResetTimer !== undefined) {
    clearTimeout(feedbackResetTimer);
    feedbackResetTimer = undefined;
  }
}

/** Clears the badge and restores the normal action title. */
async function resetActionFeedback(): Promise<void> {
  try {
    await chrome.action.setTitle({ title: defaultActionTitle() });
    await chrome.action.setBadgeText({ text: "" });
  } catch (error) {
    logActionError("reset", error);
  }
}

function shortTitle(message: string): string {
  const compact = message.replace(/\s+/g, " ").trim();
  return compact.length > ERROR_TITLE_MAX_LENGTH
    ? `${compact.slice(0, ERROR_TITLE_MAX_LENGTH - 1)}…`
    : compact;
}

/** Shows the error through the only channel available when no popup is open. */
async function showErrorFeedback(error: SnapDrawErrorPayload): Promise<void> {
  try {
    await chrome.action.setBadgeBackgroundColor({ color: ERROR_BADGE_COLOR });
    await chrome.action.setBadgeText({ text: ERROR_BADGE_TEXT });
    await chrome.action.setTitle({
      title: `SnapDraw: ${shortTitle(error.message)}`,
    });
  } catch (actionError) {
    logActionError("show error", actionError);
  }

  cancelFeedbackReset();
  feedbackResetTimer = setTimeout(() => {
    feedbackResetTimer = undefined;
    void resetActionFeedback();
  }, ERROR_FEEDBACK_MS);
}

function captureSourceOf(message: RuntimeRequest): CaptureSource {
  return message.source === "command" ? "command" : "popup";
}

/** Shared by the popup and the command: capture and open the editor. */
async function runCapture(source: CaptureSource): Promise<CaptureResponse> {
  try {
    return await captureVisibleViewport(source);
  } catch (error) {
    // `captureVisibleViewport` is documented never to throw; this keeps the
    // message contract safe even if that ever changes.
    return { ok: false, error: toErrorPayload(error) };
  }
}

// ---------------------------------------------------------------------------
// Popup -> service worker messages
// ---------------------------------------------------------------------------

onRuntimeMessage(async (message) => {
  // Failures come back typed, so the popup always has a friendly message.
  return runCapture(captureSourceOf(message));
});

// ---------------------------------------------------------------------------
// Keyboard command (Ctrl+Shift+S / Command+Shift+S)
// ---------------------------------------------------------------------------

async function handleCommandCapture(): Promise<void> {
  cancelFeedbackReset();

  const response = await runCapture("command");
  if (response.ok) {
    console.log(
      `[SnapDraw] command capture stored ${response.width}x${response.height}`,
    );
    await resetActionFeedback();
    return;
  }

  console.warn(`[SnapDraw] command capture failed: ${response.error.code}`);
  await showErrorFeedback(response.error);
  await openCommandErrorTab(response.error);
}

/**
 * The keyboard command has no popup to render an error into, so a short-lived
 * explanation tab is opened instead (the badge/title alone is easy to miss).
 * Debounced so a stuck shortcut cannot stack tabs.
 */
async function openCommandErrorTab(error: SnapDrawErrorPayload): Promise<void> {
  const now = Date.now();
  if (now - lastCommandErrorTabAt < ERROR_TAB_DEBOUNCE_MS) {
    return;
  }
  lastCommandErrorTabAt = now;

  try {
    await chrome.tabs.create({
      url: buildEditorErrorUrl(error.code, error.message),
      active: true,
    });
  } catch (tabError) {
    logActionError("open error tab", tabError);
  }
}

chrome.commands.onCommand.addListener((command) => {
  if (command !== CAPTURE_COMMAND) {
    return;
  }
  // The listener cannot be async; keep the promise alive with `void`.
  void handleCommandCapture();
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/** Restores the normal toolbar state and removes stale sessions. */
async function initialise(): Promise<void> {
  cancelFeedbackReset();
  await resetActionFeedback();
  await purgeExpiredSessions();
}

chrome.runtime.onInstalled.addListener((details) => {
  console.log(`[SnapDraw] background ready (${details.reason})`);
  void initialise();
});

chrome.runtime.onStartup.addListener(() => {
  console.log("[SnapDraw] background ready (browser start)");
  void initialise();
});
