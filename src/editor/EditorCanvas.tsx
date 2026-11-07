import { useCallback, useEffect, useRef, useState } from "react";
import { Excalidraw, convertToExcalidrawElements } from "@excalidraw/excalidraw";
import type {
  BinaryFiles,
  DataURL,
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
  UIOptions,
} from "@excalidraw/excalidraw/types";
import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";
import type { FileId } from "@excalidraw/excalidraw/element/types";
import type { PreparedScreenshot } from "../services/image.service";
import type { EditorTheme } from "./useColorScheme";

export interface EditorCanvasProps {
  prepared: PreparedScreenshot;
  theme: EditorTheme;
  /** Mirrors the screenshot's lock state for the accessible status line. */
  imagesLocked: boolean;
  /** Called once Excalidraw has mounted so the header can drive the scene. */
  onApiReady: (api: ExcalidrawImperativeAPI) => void;
}

/**
 * Excalidraw UI overrides.
 *
 * The full toolbar and tool set stay untouched; only the file actions that the
 * SnapDraw header owns (export/copy/download/clear) are disabled so there is a
 * single source of truth in our own UI.
 */
const CANVAS_UI_OPTIONS: UIOptions = {
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

function createFileId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `snapdraw-file-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * Builds the initial Excalidraw scene: a single locked image element at the
 * screenshot's natural pixel size (so exports keep full resolution) plus the
 * matching binary file entry.
 */
function buildInitialData(prepared: PreparedScreenshot): ExcalidrawInitialDataState {
  // `FileId` is a branded string in the published types; the id we generate is
  // a plain uuid at runtime, so this is the single boundary cast we need.
  const fileId = createFileId() as FileId;
  const now = Date.now();

  const files: BinaryFiles = {
    [fileId]: {
      id: fileId,
      mimeType: "image/png",
      // The data URL is typed as a branded `DataURL`; the value is exactly the
      // `data:image/png;base64,...` string produced by image.service.
      dataURL: prepared.dataUrl as DataURL,
      created: now,
      lastRetrieved: now,
    },
  };

  // `convertToExcalidrawElements` fills in the internal element fields for us
  // (ids, versions, seeds, fractional index, ...) instead of hand-rolling them.
  const skeleton: ExcalidrawElementSkeleton[] = [
    {
      type: "image",
      x: 0,
      y: 0,
      width: prepared.width,
      height: prepared.height,
      fileId,
      status: "saved",
      locked: true,
      scale: [1, 1],
      crop: null,
    },
  ];

  return {
    elements: convertToExcalidrawElements(skeleton),
    appState: {
      name: prepared.record.name,
      viewBackgroundColor: "#ffffff",
    },
    files,
  };
}

export function EditorCanvas({
  prepared,
  theme,
  imagesLocked,
  onApiReady,
}: EditorCanvasProps) {
  // Built exactly once for the lifetime of this editor session.
  const [initialData] = useState<ExcalidrawInitialDataState>(() =>
    buildInitialData(prepared),
  );

  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const [apiReady, setApiReady] = useState(false);
  const hasFittedOnceRef = useRef(false);

  const handleApiReady = useCallback(
    (api: ExcalidrawImperativeAPI) => {
      apiRef.current = api;
      setApiReady(true);
      onApiReady(api);
    },
    [onApiReady],
  );

  // Fit the scene once, as soon as Excalidraw has restored `initialData` and
  // measured its container. The scene is built asynchronously (`initializeScene`
  // awaits) and the API callback can fire first, so retry briefly instead of
  // assuming the elements exist on the first frame. After the single fit we
  // never touch the viewport again (the user owns pan and zoom; "Reset view" in
  // the header is the explicit way back).
  useEffect(() => {
    if (!apiReady || hasFittedOnceRef.current) {
      return;
    }

    const api = apiRef.current;
    if (!api) {
      return;
    }

    let disposed = false;
    let timer = 0;
    let attempts = 0;
    const MAX_ATTEMPTS = 20;

    const tryFit = (): void => {
      if (disposed || hasFittedOnceRef.current) {
        return;
      }

      const elements = api.getSceneElements();
      if (elements.length > 0) {
        hasFittedOnceRef.current = true;
        api.scrollToContent(elements, { fitToContent: true, animate: false });
        return;
      }

      attempts += 1;
      if (attempts < MAX_ATTEMPTS) {
        timer = window.setTimeout(tryFit, 100);
      }
    };

    const frame = requestAnimationFrame(() => {
      timer = window.setTimeout(tryFit, 32);
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [apiReady]);

  return (
    <Excalidraw
      theme={theme}
      initialData={initialData}
      excalidrawAPI={handleApiReady}
      UIOptions={CANVAS_UI_OPTIONS}
    >
      {/* Screen-reader status: Excalidraw's children slot renders inside its
          container, so the lock state is announced without touching its UI. */}
      <span
        className="sd-sr-only"
        role="status"
        aria-live="polite"
        title={imagesLocked ? "Screenshot locked" : "Screenshot unlocked"}
      >
        {imagesLocked ? "Screenshot locked" : "Screenshot unlocked"}
      </span>
    </Excalidraw>
  );
}
