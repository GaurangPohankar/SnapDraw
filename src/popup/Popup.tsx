import { useCallback, useEffect, useState } from "react";
import { Button } from "../components/Button";
import { ToastViewport, useToast } from "../components/Toast";
import { getTabCaptureStreamId } from "../services/recording.service";
import { classifyTabUrl } from "../services/screenshot.service";
import { formatDuration } from "../services/video.service";
import type { RecordingSource, RecordingStatus } from "../types";
import {
  getRecordingStatus,
  isExtensionContext,
  screenRecorderUrl,
  startRecording,
  stopRecording,
  buildBlankEditorUrl,
} from "../utils/messaging";
import { ErrorPanel } from "./components/ErrorPanel";
import { Header } from "./components/Header";
import { HistoryPanel } from "./components/HistoryPanel";
import { ShortcutRow } from "./components/ShortcutRow";
import {
  CameraIcon,
  CheckIcon,
  ClockIcon,
  ImageIcon,
  InfoIcon,
  PencilIcon,
  ScreenIcon,
  ShieldIcon,
  VideoIcon,
} from "./components/icons";
import { openScreenshotInEditor } from "./openScreenshot";
import { SHORTCUTS_URL } from "./shortcut";
import { useCapture } from "./useCapture";
import type { CapturePhase, CaptureStatus } from "./useCapture";
import { useRecentScreenshots } from "./useRecentScreenshots";

/** Version shown when the popup runs outside the extension (dev preview). */
const FALLBACK_VERSION = "1.0.0";

type PopupView = "capture" | "history";

const IDLE_RECORDING: RecordingStatus = {
  recording: false,
  source: null,
  startedAt: null,
};

function readExtensionVersion(): string {
  try {
    if (isExtensionContext()) {
      return chrome.runtime.getManifest().version;
    }
  } catch {
    // getManifest is unavailable in a plain browser; fall back below.
  }
  return FALLBACK_VERSION;
}

function statusCopy(status: CaptureStatus, phase: CapturePhase): string {
  if (status === "capturing") {
    return phase === "capturing"
      ? "Capturing your screen…"
      : "Opening the editor in a new tab…";
  }
  if (status === "success") {
    return "Editor opened — closing this popup.";
  }
  return "Captures the visible area of this tab, then opens it in the editor.";
}

/** True for elements that already handle Enter themselves. */
function isInteractiveTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest("button, a, input, textarea, select, [contenteditable='true']") !== null
  );
}

/**
 * SnapDraw popup: one-click screenshot capture, background tab/screen video
 * recording, a compact history preview and the full history view.
 */
export function Popup() {
  const { status, phase, error, isPreview, capture } = useCapture();
  const { toasts, showToast, dismissToast } = useToast();
  const [view, setView] = useState<PopupView>("capture");
  const [recordError, setRecordError] = useState<string | null>(null);
  const [startingSource, setStartingSource] = useState<RecordingSource | null>(null);
  const [recording, setRecording] = useState<RecordingStatus>(IDLE_RECORDING);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [stopping, setStopping] = useState(false);
  const [screenRecordingActive, setScreenRecordingActive] = useState(false);
  const {
    recent,
    total: historyTotal,
    refresh: refreshHistory,
  } = useRecentScreenshots();
  const version = readExtensionVersion();

  // Restore the recording state when the popup is reopened during a recording.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const response = await getRecordingStatus();
      if (cancelled) {
        return;
      }
      if (response.ok) {
        setRecording(response.status);
        if (!response.status.recording) {
          try {
            const badge = await chrome.action.getBadgeText({});
            if (!cancelled) {
              setScreenRecordingActive(badge === "REC");
            }
          } catch {
            // Badge API unavailable in preview mode.
          }
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!recording.recording || recording.startedAt === null) {
      setElapsedMs(0);
      return undefined;
    }

    const startedAt = recording.startedAt;
    setElapsedMs(Date.now() - startedAt);
    const timer = window.setInterval(() => {
      setElapsedMs(Date.now() - startedAt);
    }, 250);

    return () => window.clearInterval(timer);
  }, [recording]);

  const handleCopyResult = useCallback(
    (copied: boolean) => {
      showToast(
        copied
          ? {
              tone: "success",
              title: "Shortcut page copied",
              description: `Paste ${SHORTCUTS_URL} into Chrome's address bar.`,
            }
          : {
              tone: "error",
              title: "Copy didn't work",
              description: `Type ${SHORTCUTS_URL} into Chrome's address bar instead.`,
            },
      );
    },
    [showToast],
  );

  // Enter anywhere in the popup triggers the primary action. Interactive
  // controls keep their native behaviour so buttons and links never fire twice.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || event.defaultPrevented || event.isComposing) {
        return;
      }
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
        return;
      }
      if (
        view !== "capture" ||
        isPreview ||
        recording.recording ||
        status === "capturing" ||
        status === "success"
      ) {
        return;
      }
      if (isInteractiveTarget(event.target)) {
        return;
      }
      event.preventDefault();
      void capture();
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [capture, isPreview, recording.recording, status, view]);

  /**
   * Starts a background tab recording. The popup only hands over a tab-capture
   * stream id; the service worker + offscreen document keep recording after the
   * popup closes, so the recorded tab does not need to stay open.
   */
  const beginTabRecording = useCallback(async (): Promise<void> => {
    if (isPreview || startingSource !== null) {
      return;
    }

    setStartingSource("tab");
    setRecordError(null);

    try {
      if (!isExtensionContext()) {
        throw new Error("Video recording needs the SnapDraw extension.");
      }

      const tabs = await chrome.tabs.query({
        active: true,
        lastFocusedWindow: true,
      });
      const tab = tabs[0];
      if (!tab?.id) {
        throw new Error("SnapDraw couldn't find the active tab.");
      }

      const classification = classifyTabUrl(tab.url);
      if (classification.restricted) {
        throw new Error(
          "Chrome doesn't allow recording this page. Switch to a normal website tab and try again.",
        );
      }

      const streamId = await getTabCaptureStreamId(tab.id);
      const response = await startRecording(streamId, "tab");
      if (!response.ok) {
        throw new Error(
          response.error.hint
            ? `${response.error.message} ${response.error.hint}`
            : response.error.message,
        );
      }

      setRecording(response.status);
      // Recording continues in the background once the popup closes.
      window.close();
    } catch (startError) {
      setRecordError(
        startError instanceof Error
          ? startError.message
          : "Couldn't start recording.",
      );
    } finally {
      setStartingSource(null);
    }
  }, [isPreview, startingSource]);

  /**
   * Opens the compact screen-share window for "Whole screen".
   *
   * Chrome requires a visible extension page to call `getDisplayMedia()` (the
   * screen-share system picker answers there), and the recording must outlive
   * the popup. The recorder window immediately opens Chrome's picker — there is
   * no intermediate confirmation step — and closes itself after saving.
   */
  const openScreenRecorder = useCallback(async (): Promise<void> => {
    if (isPreview || startingSource !== null) {
      return;
    }

    setStartingSource("desktop");
    setRecordError(null);

    try {
      if (!isExtensionContext()) {
        throw new Error("Screen recording needs the SnapDraw extension.");
      }

      await chrome.windows.create({
        url: screenRecorderUrl(),
        type: "popup",
        width: 460,
        height: 400,
        focused: true,
      });
      window.close();
    } catch (startError) {
      setRecordError(
        startError instanceof Error
          ? startError.message
          : "Couldn't open the screen recorder.",
      );
    } finally {
      setStartingSource(null);
    }
  }, [isPreview, startingSource]);

  /** Opens a fresh Excalidraw canvas with no captured screenshot behind it. */
  const openBlankCanvas = useCallback((): void => {
    if (isPreview) {
      const previewUrl = new URL("../editor/editor.html?blank=1", window.location.href);
      window.open(previewUrl.toString(), "_blank", "noopener");
      return;
    }

    try {
      if (!isExtensionContext()) {
        throw new Error("Blank canvas needs the SnapDraw extension.");
      }
      chrome.tabs.create({ url: buildBlankEditorUrl() });
      window.close();
    } catch (openError) {
      showToast({
        tone: "error",
        title: "Couldn't open a blank canvas",
        description:
          openError instanceof Error ? openError.message : "Please try again.",
      });
    }
  }, [isPreview, showToast]);

  const finishRecording = useCallback(
    async (discard: boolean): Promise<void> => {
      if (stopping) {
        return;
      }

      setStopping(true);
      setRecordError(null);

      const response = await stopRecording(discard);
      setStopping(false);

      if (!response.ok) {
        setRecordError(
          response.error.hint
            ? `${response.error.message} ${response.error.hint}`
            : response.error.message,
        );
        return;
      }

      setRecording(IDLE_RECORDING);
      window.close();
    },
    [stopping],
  );

  const openHistory = (): void => {
    setView("history");
    void refreshHistory();
  };

  const closeHistory = (): void => {
    setView("capture");
    void refreshHistory();
  };

  const actionLabel =
    status === "capturing"
      ? phase === "capturing"
        ? "Capturing…"
        : "Opening editor…"
      : "Capture";

  const blankDisabled =
    startingSource !== null ||
    stopping ||
    screenRecordingActive ||
    status === "capturing" ||
    status === "success";

  const recordDisabled =
    isPreview ||
    startingSource !== null ||
    stopping ||
    screenRecordingActive ||
    status === "capturing" ||
    status === "success";

  return (
    <div className="sd-popup">
      <Header />

      {view === "history" ? (
        <HistoryPanel
          onBack={closeHistory}
          onChanged={() => void refreshHistory()}
          showToast={showToast}
        />
      ) : (
        <>
          <main className="sd-popup__main">
            {isPreview ? (
              <div className="sd-popup__notice" role="note">
                <span className="sd-popup__notice-icon">
                  <InfoIcon size={15} />
                </span>
                <span>
                  <strong>Preview mode.</strong> Chrome extension APIs are unavailable here.
                  Load SnapDraw from chrome://extensions to capture.
                </span>
              </div>
            ) : null}

            {screenRecordingActive && !recording.recording ? (
              <div className="sd-popup__notice" role="note">
                <span className="sd-popup__notice-icon">
                  <InfoIcon size={15} />
                </span>
                <span>
                  <strong>Screen recording in progress.</strong> Stop it from the SnapDraw
                  recorder window.
                </span>
              </div>
            ) : null}

            {recording.recording ? (
              <section className="sd-popup__recording" aria-label="Recording in progress">
                <div className="sd-popup__recording-status">
                  <span className="sd-popup__recording-dot" aria-hidden="true" />
                  <span className="sd-popup__recording-label">
                    {recording.source === "desktop"
                      ? "Recording your screen"
                      : "Recording this tab"}
                  </span>
                  <span className="sd-popup__recording-timer" aria-live="off">
                    {formatDuration(elapsedMs)}
                  </span>
                </div>
                <p className="sd-popup__recording-note">
                  Recording continues in the background — you can use other tabs. Stop
                  whenever you are done to open the editor.
                </p>
                <Button
                  variant="primary"
                  size="md"
                  fullWidth
                  loading={stopping}
                  aria-label="Stop recording"
                  onClick={() => void finishRecording(false)}
                >
                  Stop and open editor
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  fullWidth
                  disabled={stopping}
                  aria-label="Cancel recording"
                  onClick={() => void finishRecording(true)}
                >
                  Cancel recording
                </Button>
              </section>
            ) : (
              <>
                {status === "error" && error ? (
                  <ErrorPanel error={error} onRetry={() => void capture()} />
                ) : (
                  <div className="sd-popup__action">
                    {status === "success" ? (
                      <div className="sd-popup__success" aria-hidden="true">
                        <span className="sd-popup__success-icon">
                          <CheckIcon size={15} />
                        </span>
                        <span className="sd-popup__success-label">Editor opened</span>
                      </div>
                    ) : (
                      <>
                        <div
                          className="sd-popup__cards"
                          role="group"
                          aria-label="SnapDraw actions"
                        >
                          <button
                            type="button"
                            className="sd-popup__card sd-popup__card--capture sd-popup__capture"
                            disabled={isPreview || status === "capturing"}
                            aria-busy={status === "capturing"}
                            aria-label="Capture Screenshot"
                            aria-describedby={isPreview ? undefined : "sd-popup-status"}
                            onClick={() => void capture()}
                          >
                            <span className="sd-popup__card-icon" aria-hidden="true">
                              <CameraIcon size={21} />
                            </span>
                            <span className="sd-popup__card-label">{actionLabel}</span>
                            {status === "capturing" ? (
                              <span
                                className="sd-popup__card-spinner"
                                aria-hidden="true"
                              />
                            ) : null}
                          </button>

                          <button
                            type="button"
                            className="sd-popup__card sd-popup__card--tab"
                            disabled={recordDisabled}
                            aria-busy={startingSource === "tab"}
                            aria-label="Record this tab"
                            title="Record this tab, then annotate the video in Excalidraw"
                            onClick={() => void beginTabRecording()}
                          >
                            <span className="sd-popup__card-icon" aria-hidden="true">
                              <VideoIcon size={20} />
                            </span>
                            <span className="sd-popup__card-label">Tab recording</span>
                            {startingSource === "tab" ? (
                              <span
                                className="sd-popup__card-spinner"
                                aria-hidden="true"
                              />
                            ) : null}
                          </button>

                          <button
                            type="button"
                            className="sd-popup__card sd-popup__card--screen"
                            disabled={recordDisabled}
                            aria-busy={startingSource === "desktop"}
                            aria-label="Record whole screen"
                            title="Open Chrome's picker and record your whole screen — every tab and app"
                            onClick={() => void openScreenRecorder()}
                          >
                            <span className="sd-popup__card-icon" aria-hidden="true">
                              <ScreenIcon size={20} />
                            </span>
                            <span className="sd-popup__card-label">
                              Whole screen recording
                            </span>
                            {startingSource === "desktop" ? (
                              <span
                                className="sd-popup__card-spinner"
                                aria-hidden="true"
                              />
                            ) : null}
                          </button>

                          <button
                            type="button"
                            className="sd-popup__card sd-popup__card--blank"
                            disabled={blankDisabled}
                            aria-label="Open blank canvas"
                            title="Open a fresh Excalidraw canvas with no screenshot"
                            onClick={openBlankCanvas}
                          >
                            <span className="sd-popup__card-icon" aria-hidden="true">
                              <PencilIcon size={20} />
                            </span>
                            <span className="sd-popup__card-label">Blank canvas</span>
                          </button>
                        </div>

                        {status === "capturing" ? (
                          <div className="sd-popup__progress" aria-hidden="true">
                            <span className="sd-popup__progress-bar" />
                          </div>
                        ) : null}
                      </>
                    )}
                  </div>
                )}

                {recordError ? (
                  <p className="sd-popup__record-error" role="alert">
                    {recordError}
                  </p>
                ) : null}

                <p
                  id="sd-popup-status"
                  className="sd-sr-only"
                  role="status"
                  aria-live="polite"
                  aria-atomic="true"
                >
                  {statusCopy(status, phase)}
                </p>
              </>
            )}

            <ShortcutRow onCopyResult={handleCopyResult} />

            {historyTotal === 0 ? (
              <Button
                variant="secondary"
                size="sm"
                fullWidth
                leadingIcon={<ClockIcon size={16} />}
                aria-label="Open screenshot history"
                onClick={openHistory}
              >
                Screenshot history
              </Button>
            ) : (
              <section className="sd-recent" aria-label="Recent screenshots">
                <div className="sd-recent__header">
                  <span className="sd-recent__title">Recent</span>
                  <button
                    type="button"
                    className="sd-recent__all"
                    aria-label="Open screenshot history"
                    onClick={openHistory}
                  >
                    View all · {historyTotal}
                  </button>
                </div>

                <div className="sd-recent__strip">
                  {recent.map((item) => (
                    <button
                      key={item.entry.id}
                      type="button"
                      className="sd-recent__thumb"
                      aria-label={`Open ${item.entry.name}`}
                      title={`Open ${item.entry.name}`}
                      onClick={() =>
                        void openScreenshotInEditor(item.entry, showToast)
                      }
                    >
                      {item.thumbnailUrl ? (
                        <img src={item.thumbnailUrl} alt="" />
                      ) : (
                        <ImageIcon size={16} />
                      )}
                      <span
                        className={
                          item.entry.kind === "video"
                            ? "sd-recent__type sd-recent__type--video"
                            : "sd-recent__type"
                        }
                        aria-hidden="true"
                      >
                        {item.entry.kind === "video" ? (
                          <VideoIcon size={11} />
                        ) : (
                          <ImageIcon size={11} />
                        )}
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            )}

            <p className="sd-popup__trust">
              <ShieldIcon size={14} />
              <span>Runs 100% locally · nothing is uploaded</span>
            </p>
          </main>

          <footer className="sd-popup__footer">
            <span className="sd-popup__footer-note">Screenshots stay in your browser</span>
            <span className="sd-popup__version">v{version}</span>
          </footer>
        </>
      )}

      <ToastViewport toasts={toasts} onDismiss={dismissToast} placement="bottom" />
    </div>
  );
}
