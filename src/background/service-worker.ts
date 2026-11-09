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
  CaptureRequest,
  CaptureResponse,
  CaptureSource,
  OffscreenCommand,
  OffscreenStartResult,
  OffscreenStatusResult,
  OffscreenStopResult,
  RecordingSource,
  RecordingStartedEvent,
  RecordingStatus,
  RecordingStatusResponse,
  SnapDrawErrorPayload,
  StartRecordingRequest,
  StartRecordingResponse,
  StopRecordingRequest,
  StopRecordingResponse,
} from "../types";
import { OFFSCREEN_TARGET } from "../types";
import {
  captureVisibleViewport,
  purgeExpiredSessions,
  toErrorPayload,
} from "../services/screenshot.service";
import {
  buildEditorErrorUrl,
  buildVideoEditorUrl,
  errorPayload,
  OFFSCREEN_PAGE_PATH,
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

function captureSourceOf(message: CaptureRequest): CaptureSource {
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
  return runCapture(captureSourceOf(message as CaptureRequest));
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

  // Keep the REC badge when the worker restarts mid-recording; otherwise clear
  // any stale recorder document/badge from a previous browser session.
  const status = await readRecordingStatus();
  if (status.recording) {
    await setRecordingBadge(true, status.source ?? undefined);
  } else {
    await closeOffscreenSafely();
    await resetActionFeedback();
  }

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

// ---------------------------------------------------------------------------
// Video recording (offscreen MediaRecorder)
// ---------------------------------------------------------------------------

const RECORDING_BADGE_TEXT = "REC";
const RECORDING_BADGE_COLOR = "#ef4444";

/** Offscreen documents expose a small, partially-typed Chrome surface. */
interface OffscreenApi {
  hasDocument?: () => Promise<boolean>;
  createDocument: (options: {
    url: string;
    reasons: string[];
    justification: string;
  }) => Promise<void>;
  closeDocument: () => Promise<void>;
}

function offscreenApi(): OffscreenApi {
  const api = chrome.offscreen as unknown as OffscreenApi | undefined;
  if (!api?.createDocument) {
    throw new Error("The offscreen API is unavailable in this browser.");
  }
  return api;
}

async function hasOffscreenDocument(): Promise<boolean> {
  try {
    const api = offscreenApi();
    if (typeof api.hasDocument !== "function") {
      return false;
    }
    return await api.hasDocument();
  } catch {
    return false;
  }
}

async function ensureOffscreenDocument(): Promise<void> {
  const api = offscreenApi();
  if (await hasOffscreenDocument()) {
    return;
  }

  try {
    await api.createDocument({
      url: chrome.runtime.getURL(OFFSCREEN_PAGE_PATH),
      reasons: ["USER_MEDIA"],
      justification:
        "Keeps the MediaRecorder alive while the SnapDraw popup is closed.",
    });
  } catch (error) {
    // `createDocument` rejects if a document already exists (race with another
    // event) – only surface the error when no document exists afterwards.
    if (!(await hasOffscreenDocument())) {
      throw error;
    }
  }
}

async function closeOffscreenDocument(): Promise<void> {
  try {
    const api = offscreenApi();
    if (await hasOffscreenDocument()) {
      await api.closeDocument();
    }
  } catch (error) {
    console.debug(
      `[SnapDraw] could not close the offscreen recorder: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** Rejects a promise that never settles so UI messages always get an answer. */
function withPromiseTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function closeOffscreenSafely(): Promise<void> {
  await withPromiseTimeout(closeOffscreenDocument(), 2_000, "close timeout").catch(
    () => undefined,
  );
}

async function sendToOffscreen<T>(command: OffscreenCommand): Promise<T> {
  // The recorder should answer immediately; a missing response means the
  // document failed to load or a media request is stuck, so fail cleanly.
  return withPromiseTimeout(
    chrome.runtime.sendMessage(command) as Promise<T>,
    8_000,
    "The recorder didn't respond. Please try again.",
  );
}

async function setRecordingBadge(
  recording: boolean,
  source?: RecordingSource,
): Promise<void> {
  try {
    await chrome.action.setBadgeBackgroundColor({ color: RECORDING_BADGE_COLOR });
    await chrome.action.setBadgeText({ text: recording ? RECORDING_BADGE_TEXT : "" });
    await chrome.action.setTitle({
      title: recording
        ? `SnapDraw is recording ${
            source === "desktop" ? "your screen" : "this tab"
          } – click the icon to stop`
        : defaultActionTitle(),
    });
  } catch (error) {
    logActionError(recording ? "set recording badge" : "clear recording badge", error);
  }
}

async function readRecordingStatus(): Promise<RecordingStatus> {
  if (!(await hasOffscreenDocument())) {
    return { recording: false, source: null, startedAt: null };
  }

  try {
    const result = await sendToOffscreen<OffscreenStatusResult>({
      target: OFFSCREEN_TARGET,
      type: "offscreen:status",
    });
    if (result?.ok) {
      return {
        recording: result.recording,
        source: result.source,
        startedAt: result.startedAt,
      };
    }
  } catch {
    // Treat an unreachable recorder as idle; the popup will offer a fresh start.
  }

  return { recording: false, source: null, startedAt: null };
}

async function handleStartRecording(
  request: StartRecordingRequest,
): Promise<StartRecordingResponse> {
  try {
    await withPromiseTimeout(
      ensureOffscreenDocument(),
      5_000,
      "The recorder could not start in this browser.",
    );
    const result = await sendToOffscreen<OffscreenStartResult>({
      target: OFFSCREEN_TARGET,
      type: "offscreen:start",
      streamId: request.streamId,
      source: request.source,
    });

    if (!result?.ok) {
      await setRecordingBadge(false);
      await closeOffscreenSafely();
      const failedMessage = result?.message ?? "";
      const friendlyMessage =
        request.source === "desktop" &&
        /error starting tab capture|could not start|not supported/i.test(failedMessage)
          ? "Chrome couldn't start the screen recording."
          : failedMessage || "SnapDraw couldn't start recording.";
      return {
        ok: false,
        error: errorPayload(
          "CAPTURE_FAILED",
          friendlyMessage,
          request.source === "desktop"
            ? "Answer Chrome's screen picker (choose a window if the whole screen fails), then try again."
            : "Make sure the source is a normal website/tab, then try again.",
        ),
      };
    }

    await setRecordingBadge(true, result.source);
    return {
      ok: true,
      status: {
        recording: true,
        source: result.source,
        startedAt: result.startedAt,
      },
    };
  } catch (error) {
    await setRecordingBadge(false);
    await closeOffscreenSafely();
    return { ok: false, error: toErrorPayload(error) };
  }
}

async function handleStopRecording(
  request: StopRecordingRequest,
): Promise<StopRecordingResponse> {
  try {
    if (!(await hasOffscreenDocument())) {
      await setRecordingBadge(false);
      return { ok: true, discarded: Boolean(request.discard) };
    }

    const result = await sendToOffscreen<OffscreenStopResult>({
      target: OFFSCREEN_TARGET,
      type: "offscreen:stop",
      discard: Boolean(request.discard),
    });

    await closeOffscreenSafely();
    await setRecordingBadge(false);

    if (!result?.ok) {
      return {
        ok: false,
        error: errorPayload(
          "CAPTURE_FAILED",
          result?.message ?? "The recording could not be saved.",
          "Try recording again from the popup.",
        ),
      };
    }

    if (result.sessionId) {
      await chrome.tabs.create({
        url: buildVideoEditorUrl(result.sessionId),
        active: true,
      });
      return {
        ok: true,
        sessionId: result.sessionId,
        name: result.name,
        discarded: false,
      };
    }

    return { ok: true, discarded: true };
  } catch (error) {
    await setRecordingBadge(false);
    await closeOffscreenSafely();
    return { ok: false, error: toErrorPayload(error) };
  }
}

async function handleRecordingStatus(): Promise<RecordingStatusResponse> {
  return { ok: true, status: await readRecordingStatus() };
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (typeof message !== "object" || message === null) {
    return undefined;
  }

  const envelope = message as {
    target?: unknown;
    type?: unknown;
    sessionId?: unknown;
  };

  // A recording finished on its own (source tab closed / sharing stopped).
  if (envelope.target === "snapdraw-sw") {
    // A recording finished on its own or was stopped in the screen recorder.
    if (envelope.type === "recording:saved" && typeof envelope.sessionId === "string") {
      void (async () => {
        await closeOffscreenSafely();
        await setRecordingBadge(false);
        try {
          await chrome.tabs.create({
            url: buildVideoEditorUrl(envelope.sessionId as string),
            active: true,
          });
        } catch (error) {
          logActionError("open video editor", error);
        }
      })();
      return undefined;
    }

    // The visible screen-share window started recording.
    if (envelope.type === "recording:started") {
      const started = message as RecordingStartedEvent;
      void setRecordingBadge(true, started.source);
      return undefined;
    }

    // The screen recorder was cancelled before anything was saved.
    if (envelope.type === "recording:cancelled") {
      void setRecordingBadge(false);
      return undefined;
    }

    return undefined;
  }

  if (envelope.target === OFFSCREEN_TARGET) {
    return undefined;
  }

  switch (envelope.type) {
    case "RECORDING_START":
      void handleStartRecording(message as StartRecordingRequest).then(sendResponse);
      return true;
    case "RECORDING_STOP":
      void handleStopRecording(message as StopRecordingRequest).then(sendResponse);
      return true;
    case "RECORDING_STATUS":
      void handleRecordingStatus().then(sendResponse);
      return true;
    default:
      return undefined;
  }
});
