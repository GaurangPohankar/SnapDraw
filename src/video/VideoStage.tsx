/**
 * The video stage.
 *
 * The `<video>` is displayed with `object-fit: contain` and the Excalidraw
 * canvas is mounted in a second, absolutely positioned layer that exactly
 * covers the *rendered* video rectangle (letterboxing excluded). Because both
 * layers share the same rectangle, annotations drawn on screen map 1:1 onto the
 * recording, which is what makes the annotated export line up.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Excalidraw, MainMenu } from "@excalidraw/excalidraw";
import type {
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
  UIOptions,
} from "@excalidraw/excalidraw/types";
import type { RefObject } from "react";
import { InfoIcon, TrashIcon } from "../editor/icons";
import type { EditorTheme } from "../editor/useColorScheme";

export interface VideoStageProps {
  /** Object URL of the stored recording. */
  objectUrl: string;
  /** The stage-owned `<video>` element, driven by the transport/export code. */
  videoRef: RefObject<HTMLVideoElement>;
  /** Wrapper around Excalidraw – used to locate its static canvas for export. */
  overlayRef: RefObject<HTMLDivElement>;
  theme: EditorTheme;
  /** Called once Excalidraw has mounted so the editor can drive its scene. */
  onApiReady: (api: ExcalidrawImperativeAPI) => void;
  /** Live annotation count, mirrored into Excalidraw's menu. */
  annotationCount: number;
  onClearAnnotations: () => void;
  onShowAbout: () => void;
}

/**
 * Empty, fully transparent scene: the video is the background, so Excalidraw
 * must not paint a canvas background or a grid. `transparent` is honoured by
 * Excalidraw's renderer (it clears the static canvas instead of filling it).
 *
 * A fresh object is created per mount so Excalidraw never inherits state from a
 * previous instance (e.g. React StrictMode's development remount).
 */
function createOverlayInitialData(): ExcalidrawInitialDataState {
  return {
    elements: [],
    files: {},
    appState: {
      viewBackgroundColor: "transparent",
      // `null` is Excalidraw's "no grid size"; the imported-app-state legacy
      // mapping types the field as `number | undefined`, so the runtime value
      // needs this single boundary cast.
      gridSize: null as unknown as number | undefined,
    },
  };
}

/**
 * The full Excalidraw toolbar stays available (drawing is the point of this
 * screen); only the file/canvas actions owned by SnapDraw's header are hidden
 * so there is a single source of truth for export/clear.
 */
const OVERLAY_UI_OPTIONS: UIOptions = {
  canvasActions: {
    changeViewBackgroundColor: false,
    clearCanvas: false,
    export: false,
    loadScene: false,
    saveAsImage: false,
    saveToActiveFile: false,
    toggleTheme: null,
  },
};

interface Size {
  width: number;
  height: number;
}

interface VideoRect extends Size {
  left: number;
  top: number;
}

const EMPTY_SIZE: Size = { width: 0, height: 0 };

/** Computes the `object-fit: contain` rectangle for a video inside the stage. */
function containRect(stage: Size, video: Size): VideoRect | null {
  if (stage.width <= 0 || stage.height <= 0 || video.width <= 0 || video.height <= 0) {
    return null;
  }

  const scale = Math.min(stage.width / video.width, stage.height / video.height);
  if (!Number.isFinite(scale) || scale <= 0) {
    return null;
  }

  const width = video.width * scale;
  const height = video.height * scale;

  return {
    left: (stage.width - width) / 2,
    top: (stage.height - height) / 2,
    width,
    height,
  };
}

/**
 * Memoised so the export progress overlay's state ticks (up to 100 updates per
 * render) don't re-render Excalidraw while frames are being captured.
 */
export const VideoStage = memo(function VideoStage({
  objectUrl,
  videoRef,
  overlayRef,
  theme,
  onApiReady,
  annotationCount,
  onClearAnnotations,
  onShowAbout,
}: VideoStageProps) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [stageSize, setStageSize] = useState<Size>(EMPTY_SIZE);
  const [videoSize, setVideoSize] = useState<Size>(EMPTY_SIZE);
  // Built exactly once for the lifetime of this editor session.
  const [initialData] = useState<ExcalidrawInitialDataState>(createOverlayInitialData);

  // Track the stage box so the overlay can follow every window/layout change.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) {
      return undefined;
    }

    const measure = (): void => {
      setStageSize({ width: stage.clientWidth, height: stage.clientHeight });
    };

    measure();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }

    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  // The video's intrinsic size drives the displayed rectangle's aspect ratio.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return undefined;
    }

    const sync = (): void => {
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        setVideoSize({ width: video.videoWidth, height: video.videoHeight });
      }
    };

    sync();
    video.addEventListener("loadedmetadata", sync);
    video.addEventListener("resize", sync);
    return () => {
      video.removeEventListener("loadedmetadata", sync);
      video.removeEventListener("resize", sync);
    };
  }, [videoRef, objectUrl]);

  const computedRect = useMemo(
    () => containRect(stageSize, videoSize),
    [stageSize, videoSize],
  );

  // Keep the last valid rectangle if the stage is measured as zero-sized for a
  // frame (window minimised, transient layout): unmounting Excalidraw would
  // throw the user's annotations away.
  const [stickyRect, setStickyRect] = useState<VideoRect | null>(null);
  useEffect(() => {
    if (computedRect) {
      setStickyRect(computedRect);
    }
  }, [computedRect]);

  const rect = computedRect ?? stickyRect;

  const handleApiReady = useCallback(
    (api: ExcalidrawImperativeAPI) => {
      onApiReady(api);
    },
    [onApiReady],
  );

  return (
    <div className="sd-video__stage" ref={stageRef}>
      <video
        ref={videoRef}
        className="sd-video__player"
        src={objectUrl}
        playsInline
        preload="auto"
      />

      {rect ? (
        <div
          ref={overlayRef}
          className="sd-video__overlay"
          style={{
            left: `${rect.left}px`,
            top: `${rect.top}px`,
            width: `${rect.width}px`,
            height: `${rect.height}px`,
          }}
        >
          <Excalidraw
            theme={theme}
            initialData={initialData}
            excalidrawAPI={handleApiReady}
            UIOptions={OVERLAY_UI_OPTIONS}
          >
            {/*
              Replaces Excalidraw's default menu (Help / GitHub / Discord links)
              with SnapDraw's own actions, matching the screenshot editor.
            */}
            <MainMenu>
              <MainMenu.DefaultItems.SearchMenu />
              <MainMenu.Separator />
              <MainMenu.Item
                icon={<TrashIcon />}
                disabled={annotationCount === 0}
                onSelect={onClearAnnotations}
              >
                Clear annotations
              </MainMenu.Item>
              <MainMenu.Separator />
              <MainMenu.Item icon={<InfoIcon />} onSelect={onShowAbout}>
                About SnapDraw
              </MainMenu.Item>
            </MainMenu>
          </Excalidraw>
        </div>
      ) : null}
    </div>
  );
});
