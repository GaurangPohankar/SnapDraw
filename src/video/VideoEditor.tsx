/**
 * The SnapDraw video editor tab.
 *
 * Flow: read `?session=<id>` → load the recorded WebM from IndexedDB → create an
 * object URL → mount the video stage (video + transparent Excalidraw overlay) and
 * the transport bar. Everything stays local; export renders the annotated video
 * in the page with `MediaRecorder`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { ScreenshotRecord } from "../types";
import { Button } from "../components/Button";
import { Logo } from "../components/Logo";
import { ToastViewport, useToast } from "../components/Toast";
import { AboutDialog } from "../editor/AboutDialog";
import { CloseIcon, WarningIcon } from "../editor/icons";
import { useColorScheme } from "../editor/useColorScheme";
import {
  ClipboardError,
  copyImageBlobToClipboard,
} from "../services/clipboard.service";
import { downloadBlob, ExportError } from "../services/export.service";
import {
  createAnnotatedFrameBlob,
  disposeVideoExportAudio,
  exportAnnotatedVideo,
  isVideoExportCancelled,
  VideoExportError,
} from "../services/video-export.service";
import {
  buildVideoFilename,
  formatDuration,
  loadVideoRecord,
  pickVideoMimeType,
} from "../services/video.service";
import { readSessionId } from "../utils/messaging";
import { TransportBar } from "./TransportBar";
import { VideoHeader } from "./VideoHeader";
import { VideoStage } from "./VideoStage";

/** Friendly copy for the loading and error screens. */
interface VideoScreenMessage {
  title: string;
  message: string;
  hint?: string;
}

const SESSION_MISSING: VideoScreenMessage = {
  title: "No recording to edit",
  message: "This tab wasn't opened from a SnapDraw recording.",
  hint: "Record your tab from the SnapDraw toolbar icon and the editor opens with the video ready to annotate.",
};

const RECORDING_UNAVAILABLE: VideoScreenMessage = {
  title: "Recording not found",
  message:
    "This recording isn't in local storage anymore – it may have expired or already been deleted.",
  hint: "Record again from the SnapDraw toolbar icon.",
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

/** Turns any export/clipboard/download failure into readable toast copy. */
function describeActionError(error: unknown): string {
  if (
    error instanceof VideoExportError ||
    error instanceof ClipboardError ||
    error instanceof ExportError
  ) {
    return error.hint ? `${error.message} ${error.hint}` : error.message;
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "Something unexpected happened.";
}

function VideoLoadingScreen() {
  return (
    <div className="sd-screen sd-screen--loading" role="status" aria-live="polite">
      <div className="sd-screen__brand">
        <Logo size={46} withWordmark />
      </div>
      <span className="sd-screen__spinner" aria-hidden="true" />
      <p className="sd-screen__title">Preparing your recording…</p>
      <p className="sd-screen__text">
        Reading the recording from local storage. Longer clips can take a moment.
      </p>
    </div>
  );
}

function VideoErrorScreen({ screen }: { screen: VideoScreenMessage }) {
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

      <Button variant="primary" leadingIcon={<CloseIcon />} onClick={closeEditorTab}>
        Close tab
      </Button>
    </div>
  );
}

interface ExportProgressOverlayProps {
  ratio: number;
  onCancel: () => void;
}

/** Blocking overlay shown while the annotated video is being rendered. */
function ExportProgressOverlay({ ratio, onCancel }: ExportProgressOverlayProps) {
  const percent = Math.round(Math.min(1, Math.max(0, ratio)) * 100);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  // Move focus to Cancel so the blocking overlay stays keyboard operable.
  useEffect(() => {
    dialogRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, []);

  return (
    <div
      ref={dialogRef}
      className="sd-video__progress"
      role="dialog"
      aria-modal="true"
      aria-labelledby="sd-video-export-title"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
      }}
    >
      <div className="sd-video__progress-card">
        <span className="sd-video__progress-spinner" aria-hidden="true" />
        <h2 id="sd-video-export-title" className="sd-video__progress-title">
          Rendering annotated video… {percent}%
        </h2>
        <p className="sd-video__progress-text">
          Playback runs in real time so the audio stays in sync. You can keep
          working when it's done.
        </p>
        <div
          className="sd-video__progress-track"
          role="progressbar"
          aria-label="Rendering progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <span
            className="sd-video__progress-fill"
            style={{ width: `${percent}%` }}
          />
        </div>
        <Button variant="secondary" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

export function VideoEditor() {
  const [record, setRecord] = useState<ScreenshotRecord | null>(null);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [annotationCount, setAnnotationCount] = useState(0);
  const [elementDurationMs, setElementDurationMs] = useState(0);
  const [exportRatio, setExportRatio] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);

  const sessionId = useMemo(() => readSessionId(), []);
  const [screenError, setScreenError] = useState<VideoScreenMessage | null>(() =>
    sessionId ? null : SESSION_MISSING,
  );

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const theme = useColorScheme();
  const { toasts, showToast, dismissToast } = useToast();

  // Load the recording once; the record (and its blob) stays in IndexedDB so
  // refreshing or reopening this tab keeps working.
  useEffect(() => {
    if (!sessionId) {
      return undefined;
    }

    let cancelled = false;

    const load = async (): Promise<void> => {
      try {
        const loaded = await loadVideoRecord(sessionId);
        if (!cancelled) {
          setRecord(loaded);
        }
      } catch (loadError) {
        if (cancelled) {
          return;
        }
        console.warn("SnapDraw could not load the recording.", loadError);
        setScreenError(RECORDING_UNAVAILABLE);
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // Object URL for the stored blob – revoked when the record changes/unmounts.
  useEffect(() => {
    if (!record) {
      return undefined;
    }
    const url = URL.createObjectURL(record.blob);
    setObjectUrl(url);
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [record]);

  // The export audio graph is cached per element (one source node per <video>),
  // so it is released explicitly here instead of after every export.
  useEffect(() => {
    if (!objectUrl) {
      return undefined;
    }
    const video = videoRef.current;
    return () => {
      if (video) {
        void disposeVideoExportAudio(video);
      }
    };
  }, [objectUrl]);

  // Duration fallback for progress/transport when Chrome reports `Infinity`
  // for the recorded WebM (the stored metadata is preferred over this).
  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return undefined;
    }

    const sync = (): void => {
      if (Number.isFinite(video.duration) && video.duration > 0) {
        setElementDurationMs(video.duration * 1000);
      }
    };

    sync();
    video.addEventListener("loadedmetadata", sync);
    video.addEventListener("durationchange", sync);
    return () => {
      video.removeEventListener("loadedmetadata", sync);
      video.removeEventListener("durationchange", sync);
    };
  }, [objectUrl]);

  // Mirror the Excalidraw scene so the header can enable "Clear annotations".
  useEffect(() => {
    if (!api) {
      return undefined;
    }

    const sync = (elements: readonly ExcalidrawElement[]): void => {
      setAnnotationCount(elements.filter((element) => !element.isDeleted).length);
    };

    sync(api.getSceneElements());
    return api.onChange((elements) => sync(elements));
  }, [api]);

  // Abort an in-flight export when the tab goes away.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const effectiveDurationMs = useMemo(() => {
    if (record?.durationMs && record.durationMs > 0) {
      return record.durationMs;
    }
    return Math.round(elementDurationMs);
  }, [record, elementDurationMs]);

  const handleApiReady = useCallback((nextApi: ExcalidrawImperativeAPI) => {
    setApi(nextApi);
  }, []);

  /** Excalidraw's static canvas inside the overlay (annotations only). */
  const getOverlayCanvas = useCallback((): HTMLCanvasElement | null => {
    const container = overlayRef.current;
    if (!container) {
      return null;
    }
    return container.querySelector<HTMLCanvasElement>("canvas.excalidraw__canvas.static");
  }, []);

  const handleCopyFrame = useCallback(async (): Promise<void> => {
    const video = videoRef.current;
    const overlayCanvas = getOverlayCanvas();
    if (!video || !overlayCanvas) {
      showToast({
        tone: "error",
        title: "The editor is still starting",
        description: "Try again in a moment.",
      });
      return;
    }

    try {
      const blob = await createAnnotatedFrameBlob(video, overlayCanvas);
      await copyImageBlobToClipboard(blob);
      showToast({
        tone: "success",
        title: "Frame copied to clipboard",
        description: "Paste the annotated frame anywhere.",
      });
    } catch (error) {
      showToast({
        tone: "error",
        title: "Couldn't copy the frame",
        description: describeActionError(error),
      });
    }
  }, [getOverlayCanvas, showToast]);

  const handleDownloadVideo = useCallback((): void => {
    if (!record || abortRef.current) {
      return;
    }

    const video = videoRef.current;
    const overlayCanvas = getOverlayCanvas();
    if (!video || !overlayCanvas) {
      showToast({
        tone: "error",
        title: "The editor is still starting",
        description: "Try again in a moment.",
      });
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setExporting(true);
    setExportRatio(0);

    const run = async (): Promise<void> => {
      try {
        const blob = await exportAnnotatedVideo({
          video,
          overlayCanvas,
          mimeType: pickVideoMimeType(),
          fallbackDurationMs:
            effectiveDurationMs > 0 ? effectiveDurationMs : undefined,
          onProgress: ({ ratio }) => setExportRatio(ratio),
          signal: controller.signal,
        });

        const filename = buildVideoFilename(record.name, "annotated");
        downloadBlob(blob, filename);
        showToast({
          tone: "success",
          title: "Annotated video downloaded",
          description: filename,
        });
      } catch (error) {
        if (isVideoExportCancelled(error)) {
          showToast({
            tone: "info",
            title: "Export cancelled",
            description: "Nothing was saved – your annotations are still here.",
            duration: 3200,
          });
        } else {
          showToast({
            tone: "error",
            title: "Couldn't render the annotated video",
            description: describeActionError(error),
          });
        }
      } finally {
        abortRef.current = null;
        setExporting(false);
        setExportRatio(0);
      }
    };

    void run();
  }, [effectiveDurationMs, getOverlayCanvas, record, showToast]);

  const handleCancelExport = useCallback((): void => {
    abortRef.current?.abort();
  }, []);

  const handleDownloadOriginal = useCallback((): void => {
    if (!record) {
      return;
    }

    try {
      const filename = buildVideoFilename(record.name);
      downloadBlob(record.blob, filename);
      showToast({
        tone: "success",
        title: "Original recording downloaded",
        description: filename,
      });
    } catch (error) {
      showToast({
        tone: "error",
        title: "Couldn't download the recording",
        description: describeActionError(error),
      });
    }
  }, [record, showToast]);

  const handleClearAnnotations = useCallback((): void => {
    if (!api) {
      return;
    }

    if (annotationCount === 0) {
      showToast({
        tone: "info",
        title: "Nothing to clear",
        description: "There are no annotations on this recording yet.",
        duration: 2400,
      });
      return;
    }

    api.updateScene({
      elements: [],
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    showToast({
      tone: "success",
      title: "Annotations cleared",
      description: "The recording is untouched – undo brings your notes back.",
    });
  }, [annotationCount, api, showToast]);

  const handleShowAbout = useCallback((): void => {
    setAboutOpen(true);
  }, []);

  if (screenError) {
    return <VideoErrorScreen screen={screenError} />;
  }

  if (!record || !objectUrl) {
    return <VideoLoadingScreen />;
  }

  return (
    <div className="sd-video">
      <VideoHeader
        record={record}
        durationMs={effectiveDurationMs}
        annotationCount={annotationCount}
        exporting={exporting}
        onCopyFrame={handleCopyFrame}
        onDownloadVideo={handleDownloadVideo}
        onDownloadOriginal={handleDownloadOriginal}
        onClearAnnotations={handleClearAnnotations}
        onShowAbout={handleShowAbout}
      />

      <main className="sd-video__main">
        <VideoStage
          objectUrl={objectUrl}
          videoRef={videoRef}
          overlayRef={overlayRef}
          theme={theme}
          onApiReady={handleApiReady}
          annotationCount={annotationCount}
          onClearAnnotations={handleClearAnnotations}
          onShowAbout={handleShowAbout}
        />

        <TransportBar videoRef={videoRef} durationMs={effectiveDurationMs} />

        {exporting ? (
          <ExportProgressOverlay ratio={exportRatio} onCancel={handleCancelExport} />
        ) : null}
      </main>

      <ToastViewport
        toasts={toasts}
        onDismiss={dismissToast}
        placement="bottom-left"
      />

      <AboutDialog open={aboutOpen} onClose={() => setAboutOpen(false)} />
    </div>
  );
}
