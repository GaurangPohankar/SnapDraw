import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CaptureUpdateAction, MainMenu } from "@excalidraw/excalidraw";
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
import { isBlankEditorRequest, readEditorErrorParam, readSessionId } from "../utils/messaging";
import { AboutDialog } from "./AboutDialog";
import { EditorCanvas } from "./EditorCanvas";
import { EditorHeader } from "./EditorHeader";
import {
  CloseIcon,
  ClockIcon,
  GitHubIcon,
  InfoIcon,
  SettingsIcon,
  TrashIcon,
  WarningIcon,
} from "./icons";
import { SNAPDRAW_REPO_URL } from "./links";
import { useCanvasPreferences } from "./useCanvasPreferences";
import { CanvasPreferencesDialog } from "./CanvasPreferencesDialog";

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
  const [aboutOpen, setAboutOpen] = useState(false);
  const [preferencesOpen, setPreferencesOpen] = useState(false);

  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const {
    preferences,
    theme,
    background,
    setTheme,
    setBackground,
  } = useCanvasPreferences();
  const { toasts, showToast, dismissToast } = useToast();

  const blankCanvas = useMemo(() => isBlankEditorRequest(), []);
  const captureError = useMemo(() => readEditorErrorParam(), []);
  const sessionId = useMemo(() => readSessionId(), []);

  const initialError = useMemo<EditorScreenMessage | null>(() => {
    if (blankCanvas) {
      return null;
    }
    if (captureError) {
      return describeCaptureError(captureError.code, captureError.message);
    }
    return sessionId ? null : SESSION_MISSING;
  }, [blankCanvas, captureError, sessionId]);

  const [screenError, setScreenError] = useState<EditorScreenMessage | null>(
    initialError,
  );

  useEffect(() => {
    if (blankCanvas || initialError || !sessionId) {
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

        // The capture record intentionally stays in IndexedDB: refreshing this
        // tab, reopening it from the history list, and re-opening the same
        // session URL all keep working. Storage is bounded by the history
        // limit/retention in storage.service.ts.
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
  }, [blankCanvas, initialError, sessionId]);

  const handleApiReady = useCallback((nextApi: ExcalidrawImperativeAPI) => {
    setApi(nextApi);
  }, []);

  // Apply persisted canvas preferences to the live scene: a blank canvas is
  // ready immediately, and changing the background in the preferences dialog
  // updates the scene (and the PNG padding) without losing annotations.
  useEffect(() => {
    if (!api) {
      return;
    }
    if (blankCanvas) {
      setSceneReady(true);
    }
    api.updateScene({ appState: { viewBackgroundColor: background } });
  }, [api, background, blankCanvas]);

  /** Removes every annotation, keeping a screenshot element untouched. */
  const handleClearAnnotations = useCallback((): void => {
    if (!api) {
      return;
    }

    const elements = api.getSceneElements();
    const imageElements = elements.filter((element) => element.type === "image");
    const annotationElements = elements.filter((element) => element.type !== "image");
    if (annotationElements.length === 0) {
      showToast({
        tone: "info",
        title: "Nothing to clear",
        description: blankCanvas
          ? "The canvas is already empty."
          : "There are no annotations on this screenshot yet.",
        duration: 2400,
      });
      return;
    }

    api.updateScene({
      elements: imageElements,
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    showToast({
      tone: "success",
      title: "Annotations cleared",
      description:
        imageElements.length > 0
          ? "The screenshot is untouched – undo brings your notes back."
          : "Undo brings your drawing back.",
    });
  }, [api, blankCanvas, showToast]);

  /**
   * The history lives in the popup (it owns the capture list). Chrome 127+
   * can open the action popup programmatically from a user gesture; elsewhere
   * the user gets a toast telling them where to find it.
   */
  const handleShowHistory = useCallback((): void => {
    const historyHint =
      "Click the SnapDraw icon in the toolbar, then Screenshot history.";
    const action = typeof chrome !== "undefined" ? chrome.action : undefined;
    const openPopup = (
      action as unknown as { openPopup?: () => Promise<void> } | undefined
    )?.openPopup;

    if (typeof openPopup === "function") {
      openPopup.call(action).catch(() => {
        showToast({
          tone: "info",
          title: "Screenshot history",
          description: historyHint,
          duration: 5000,
        });
      });
      return;
    }

    showToast({
      tone: "info",
      title: "Screenshot history",
      description: historyHint,
      duration: 5000,
    });
  }, [showToast]);

  // Excalidraw's "?" shortcut opens its built-in help dialog, which links to
  // third-party Excalidraw pages. SnapDraw replaces those links, so the dialog is
  // kept out of reach – without breaking "?" typed into a text annotation.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "?" || event.ctrlKey || event.metaKey || event.altKey) {
        return;
      }
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest("textarea, input, [contenteditable='true']")
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    };

    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
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

  if (!prepared && !blankCanvas) {
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
        sceneReady={sceneReady}
      />

      <div className="sd-editor__workspace" ref={workspaceRef}>
        <EditorCanvas
          prepared={prepared}
          theme={theme}
          background={background}
          imagesLocked={imagesLocked}
          onApiReady={handleApiReady}
        >
          {/*
            Replaces Excalidraw's default main menu so its Help / GitHub /
            "Follow us" / Discord links are gone. Everything here is SnapDraw's.
          */}
          <MainMenu>
            <MainMenu.DefaultItems.SearchMenu />
            <MainMenu.Separator />
            <MainMenu.Item
              icon={<TrashIcon />}
              disabled={annotationCount === 0}
              onSelect={handleClearAnnotations}
            >
              Clear annotations
            </MainMenu.Item>
            <MainMenu.Separator />
            <MainMenu.Item
              icon={<SettingsIcon />}
              onSelect={() => setPreferencesOpen(true)}
            >
              Canvas preferences
            </MainMenu.Item>
            <MainMenu.Separator />
            <MainMenu.Item
              icon={<ClockIcon />}
              onSelect={handleShowHistory}
            >
              Screenshot history
            </MainMenu.Item>
            <MainMenu.ItemLink
              icon={<GitHubIcon />}
              href={SNAPDRAW_REPO_URL}
              target="_blank"
              rel="noreferrer noopener"
            >
              SnapDraw on GitHub
            </MainMenu.ItemLink>
            <MainMenu.Item
              icon={<InfoIcon />}
              onSelect={() => setAboutOpen(true)}
            >
              About SnapDraw
            </MainMenu.Item>
          </MainMenu>
        </EditorCanvas>
      </div>

      <ToastViewport
        toasts={toasts}
        onDismiss={dismissToast}
        placement="bottom-left"
      />

      <AboutDialog open={aboutOpen} onClose={() => setAboutOpen(false)} />

      <CanvasPreferencesDialog
        open={preferencesOpen}
        onClose={() => setPreferencesOpen(false)}
        preferences={preferences}
        onChange={(patch) => {
          if (patch.theme !== undefined) {
            setTheme(patch.theme);
          }
          if (patch.background !== undefined) {
            setBackground(patch.background);
          }
        }}
      />
    </div>
  );
}
