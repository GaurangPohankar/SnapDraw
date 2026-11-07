import { useCallback, useEffect, useState } from "react";
import { Button } from "../components/Button";
import { ToastViewport, useToast } from "../components/Toast";
import { listScreenshots } from "../services/storage.service";
import { isExtensionContext } from "../utils/messaging";
import { ErrorPanel } from "./components/ErrorPanel";
import { Header } from "./components/Header";
import { HistoryPanel } from "./components/HistoryPanel";
import { ShortcutRow } from "./components/ShortcutRow";
import {
  CameraIcon,
  CheckIcon,
  ClockIcon,
  InfoIcon,
  ShieldIcon,
} from "./components/icons";
import { SHORTCUTS_URL } from "./shortcut";
import { useCapture } from "./useCapture";
import type { CapturePhase, CaptureStatus } from "./useCapture";

/** Version shown when the popup runs outside the extension (dev preview). */
const FALLBACK_VERSION = "1.0.0";

type PopupView = "capture" | "history";

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
 * SnapDraw popup: one obvious capture action, a live shortcut hint, a local
 * screenshot history and a friendly, inline failure state.
 */
export function Popup() {
  const { status, phase, error, isPreview, capture } = useCapture();
  const { toasts, showToast, dismissToast } = useToast();
  const [view, setView] = useState<PopupView>("capture");
  const [historyCount, setHistoryCount] = useState<number | null>(null);
  const version = readExtensionVersion();

  const refreshHistoryCount = useCallback(async (): Promise<void> => {
    if (!isExtensionContext()) {
      return;
    }
    try {
      const entries = await listScreenshots();
      setHistoryCount(entries.length);
    } catch {
      setHistoryCount(null);
    }
  }, []);

  useEffect(() => {
    void refreshHistoryCount();
  }, [refreshHistoryCount]);

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
  }, [capture, isPreview, status, view]);

  const actionLabel =
    status === "capturing"
      ? phase === "capturing"
        ? "Capturing…"
        : "Opening editor…"
      : "Capture Screenshot";

  const openHistory = (): void => {
    setView("history");
    void refreshHistoryCount();
  };

  const closeHistory = (): void => {
    setView("capture");
    void refreshHistoryCount();
  };

  return (
    <div className="sd-popup">
      <Header />

      {view === "history" ? (
        <HistoryPanel
          onBack={closeHistory}
          onChanged={() => void refreshHistoryCount()}
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
                  <Button
                    variant="primary"
                    size="lg"
                    fullWidth
                    className="sd-popup__capture"
                    leadingIcon={<CameraIcon size={19} />}
                    loading={status === "capturing"}
                    disabled={isPreview}
                    autoFocus={!isPreview && status === "idle"}
                    aria-describedby={isPreview ? undefined : "sd-popup-status"}
                    onClick={() => void capture()}
                  >
                    {actionLabel}
                  </Button>
                )}

                {status === "capturing" ? (
                  <div className="sd-popup__progress" aria-hidden="true">
                    <span className="sd-popup__progress-bar" />
                  </div>
                ) : null}

                {isPreview ? null : (
                  <p
                    id="sd-popup-status"
                    className="sd-popup__status"
                    role="status"
                    aria-live="polite"
                    aria-atomic="true"
                    data-tone={status}
                  >
                    {statusCopy(status, phase)}
                  </p>
                )}
              </div>
            )}

            <ShortcutRow onCopyResult={handleCopyResult} />

            <Button
              variant="secondary"
              size="sm"
              fullWidth
              leadingIcon={<ClockIcon size={16} />}
              aria-label="Open screenshot history"
              onClick={openHistory}
            >
              {historyCount === null || historyCount === 0
                ? "Screenshot history"
                : `Screenshot history · ${historyCount}`}
            </Button>

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
