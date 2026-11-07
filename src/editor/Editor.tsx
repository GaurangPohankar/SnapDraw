import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { Button } from "../components/Button";
import { Logo } from "../components/Logo";
import { ToastViewport, useToast } from "../components/Toast";
import {
  MAX_SCREENSHOT_EDGE,
  isSupportedScreenshotSize,
  loadPreparedScreenshot,
  type PreparedScreenshot,
} from "../services/image.service";
import { deleteScreenshot } from "../services/storage.service";
import { readEditorErrorParam, readSessionId } from "../utils/messaging";
import { EditorCanvas } from "./EditorCanvas";
import { EditorHeader } from "./EditorHeader";
import { CloseIcon, WarningIcon } from "./icons";
import { useColorScheme } from "./useColorScheme";

/** Friendly copy for the loading and error screens. */
interface EditorScreenMessage {
  title: string;
  message: string;
  hint?: string;
}

const SESSION_MISSING: EditorScreenMessage = {
  title: "No screenshot to edit",
  message: "This editor tab wasn't opened from a SnapDraw capture.",
  hint: "Capture a screenshot from the SnapDraw toolbar icon and the editor opens with it ready to annotate.",
};

/** Maps the worker's `?error=` codes onto human copy. */
function describeCaptureError(code: string, message?: string): EditorScreenMessage {
  const provided = message?.trim() || undefined;

  switch (code) {
    case "RESTRICTED_PAGE":
      return {
        title: "This page can't be captured",
        message:
          provided ??
          "Chrome blocks screenshots of chrome:// pages, the Chrome Web Store, and other protected pages.",
        hint: "Open a regular website, then use the SnapDraw toolbar icon again.",
      };
    case "NO_ACTIVE_TAB":
      return {
        title: "No tab to capture",
        message: provided ?? "SnapDraw couldn't find an active tab to capture.",
        hint: "Focus a normal website tab and try again.",
      };
    case "CAPTURE_FAILED":
      return {
        title: "The screenshot couldn't be captured",
        message: provided ?? "Chrome didn't return a screenshot this time.",
        hint: "Try again, or reload the page you want to capture.",
      };
    case "STORAGE_FAILED":
      return {
        title: "The screenshot couldn't be saved locally",
        message:
          provided ??
          "SnapDraw stores captures in this browser's IndexedDB, and that write failed.",
        hint: "Check that Chrome isn't out of disk space, then try again.",
      };
    case "EDITOR_TAB_FAILED":
      return {
        title: "The editor tab couldn't open",
        message: provided ?? "Chrome blocked SnapDraw from opening the annotation tab.",
        hint: "Allow tabs for this extension, then capture again.",
      };
    default:
      return {
        title: "Something went wrong",
        message: provided ?? "SnapDraw couldn't prepare this capture.",
        hint: "Capture again from the SnapDraw toolbar icon.",
      };
  }
}

const SCREENSHOT_UNAVAILABLE: EditorScreenMessage = {
  title: "Screenshot not found",
  message:
    "This screenshot isn't in local storage anymore – it may have expired or already been used.",
  hint: "Capture again from the SnapDraw toolbar icon.",
};

const SCREENSHOT_TOO_LARGE: EditorScreenMessage = {
  title: "Screenshot is too large to edit",
  message: `SnapDraw supports screenshots up to ${MAX_SCREENSHOT_EDGE}px per side.`,
  hint: "Capture a smaller window and try again.",
};

/**
 * Closes the editor tab. Extension pages opened via `chrome.tabs.create` can be
 * closed by `window.close()`; the tab query is a fallback for cases where Chrome
 * ignores it (the page is already gone by then whenever the close succeeded).
 */
function closeEditorTab(): void {
  window.close();
  window.setTimeout(() => {
    try {
      if (typeof chrome === "undefined" || !chrome.tabs?.getCurrent) {
        return;
      }
      chrome.tabs.getCurrent((tab) => {
        if (tab?.id !== undefined) {
          chrome.tabs.remove(tab.id, () => {
            // Reading lastError prevents an unchecked runtime error console entry.
            void chrome.runtime.lastError;
          });
        }
      });
    } catch {
      // Not running as an extension page (dev preview) – nothing else to close.
    }
  }, 150);
}

function EditorLoadingScreen() {
  return (
    <div className="sd-screen sd-screen--loading" role="status" aria-live="polite">
      <div className="sd-screen__brand">
        <Logo size={46} withWordmark />
      </div>
      <span className="sd-screen__spinner" aria-hidden="true" />
      <p className="sd-screen__title">Preparing your screenshot…</p>
      <p className="sd-screen__text">
        Reading the capture from local storage. Large screenshots can take a moment.
      </p>
    </div>
  );
}

function EditorErrorScreen({ screen }: { screen: EditorScreenMessage }) {
  return (
    <div className="sd-screen sd-screen--error">
      <div className="sd-screen__brand">
        <Logo size={40} withWordmark />
      </div>

      <div className="sd-screen__card" role="alert">
        <span className="sd-screen__icon" aria-hidden="true">
          <WarningIcon size={20} />
        </span>
        <div className="sd-screen__card-body">
          <h1 className="sd-screen__title">{screen.title}</h1>
          <p className="sd-screen__text">{screen.message}</p>
          {screen.hint ? <p className="sd-screen__hint">{screen.hint}</p> : null}
        </div>
      </div>

      <Button
        variant="primary"
        leadingIcon={<CloseIcon />}
        onClick={closeEditorTab}
      >
        Close tab
      </Button>
    </div>
  );
}

/**
 * The SnapDraw editor tab.
 *
 * Flow: read the URL (worker error or capture session) → load the prepared
 * screenshot from IndexedDB → delete the temporary record once the data URL is
 * in memory → mount the Excalidraw canvas plus our header.
 */
export function Editor() {
  const [prepared, setPrepared] = useState<PreparedScreenshot | null>(null);
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  // Small mirror of the Excalidraw scene that the header needs (lock state,
  // annotation count) plus the accessible status rendered inside the canvas.
  const [imagesLocked, setImagesLocked] = useState(true);
  const [annotationCount, setAnnotationCount] = useState(0);
  const [sceneReady, setSceneReady] = useState(false);

  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const theme = useColorScheme();
  const { toasts, showToast, dismissToast } = useToast();

  const captureError = useMemo(() => readEditorErrorParam(), []);
  const sessionId = useMemo(() => readSessionId(), []);

  const initialError = useMemo<EditorScreenMessage | null>(() => {
    if (captureError) {
      return describeCaptureError(captureError.code, captureError.message);
    }
    return sessionId ? null : SESSION_MISSING;
  }, [captureError, sessionId]);

  const [screenError, setScreenError] = useState<EditorScreenMessage | null>(
    initialError,
  );

  useEffect(() => {
    if (initialError || !sessionId) {
      return;
    }

    let cancelled = false;

    const load = async (): Promise<void> => {
      try {
        const loaded = await loadPreparedScreenshot(sessionId);
        if (cancelled) {
          return;
        }

        if (!isSupportedScreenshotSize(loaded)) {
          setScreenError(SCREENSHOT_TOO_LARGE);
          return;
        }

        setPrepared(loaded);

        // The capture record is only a hand-off to this tab: the data URL is in
        // memory now (and inside the Excalidraw scene), so remove the temp entry.
        try {
          await deleteScreenshot(sessionId);
        } catch (cleanupError) {
          console.warn(
            "SnapDraw could not remove the temporary screenshot record.",
            cleanupError,
          );
        }
      } catch (loadError) {
        if (cancelled) {
          return;
        }
        console.warn("SnapDraw could not load the screenshot.", loadError);
        setScreenError(SCREENSHOT_UNAVAILABLE);
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [initialError, sessionId]);

  const handleApiReady = useCallback((nextApi: ExcalidrawImperativeAPI) => {
    setApi(nextApi);
  }, []);

  // Keep the mirrored scene state in sync. The initial scene is restored
  // asynchronously, so poll briefly until the image element exists and only
  // then rely on Excalidraw's onChange emitter.
  useEffect(() => {
    if (!api) {
      return;
    }

    const sync = (elements: readonly ExcalidrawElement[]): void => {
      const liveElements = elements.filter((element) => !element.isDeleted);
      const imageElements = liveElements.filter((element) => element.type === "image");
      setImagesLocked(
        imageElements.length > 0 && imageElements.every((element) => element.locked),
      );
      setAnnotationCount(
        liveElements.filter((element) => element.type !== "image").length,
      );
      if (imageElements.length > 0) {
        setSceneReady(true);
      }
    };

    let disposed = false;
    let timer = 0;
    let attempts = 0;
    const MAX_ATTEMPTS = 20;

    const syncFromApi = (): void => {
      if (disposed) {
        return;
      }
      const elements = api.getSceneElements();
      sync(elements);
      const hasImage = elements.some(
        (element) => element.type === "image" && !element.isDeleted,
      );
      if (hasImage || attempts >= MAX_ATTEMPTS) {
        return;
      }
      attempts += 1;
      timer = window.setTimeout(syncFromApi, 100);
    };

    syncFromApi();
    const unsubscribe = api.onChange((elements) => sync(elements));

    return () => {
      disposed = true;
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, [api]);

  if (screenError) {
    return <EditorErrorScreen screen={screenError} />;
  }

  if (!prepared) {
    return <EditorLoadingScreen />;
  }

  return (
    <div className="sd-editor">
      <EditorHeader
        prepared={prepared}
        api={api}
        workspaceRef={workspaceRef}
        showToast={showToast}
        imagesLocked={imagesLocked}
        annotationCount={annotationCount}
        sceneReady={sceneReady}
      />

      <div className="sd-editor__workspace" ref={workspaceRef}>
        <EditorCanvas
          prepared={prepared}
          theme={theme}
          imagesLocked={imagesLocked}
          onApiReady={handleApiReady}
        />
      </div>

      <ToastViewport
        toasts={toasts}
        onDismiss={dismissToast}
        placement="bottom-left"
      />
    </div>
  );
}
