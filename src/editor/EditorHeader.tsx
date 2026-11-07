import { useState } from "react";
import type { RefObject } from "react";
import { CaptureUpdateAction, mutateElement } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { Button } from "../components/Button";
import { Logo } from "../components/Logo";
import type { ShowToastInput } from "../components/Toast";
import type { PreparedScreenshot } from "../services/image.service";
import {
  buildExportFilename,
  downloadBlob,
  exportSceneToPngBlob,
  ExportError,
} from "../services/export.service";
import {
  ClipboardError,
  copyImageBlobToClipboard,
  isClipboardImageCopySupported,
} from "../services/clipboard.service";
import {
  dispatchHistoryShortcut,
  fitSceneToContent,
  readScene,
  type HistoryDirection,
} from "./excalidrawActions";
import {
  CopyIcon,
  DownloadIcon,
  FitViewIcon,
  LockIcon,
  RedoIcon,
  UndoIcon,
  UnlockIcon,
} from "./icons";

export interface EditorHeaderProps {
  prepared: PreparedScreenshot;
  /** Live Excalidraw API; `null` until the canvas has mounted. */
  api: ExcalidrawImperativeAPI | null;
  /** Wrapper around the Excalidraw canvas, used for synthetic history keys. */
  workspaceRef: RefObject<HTMLDivElement>;
  showToast: (toast: ShowToastInput) => string;
  /** Mirrors the image element's lock flag (owned by the editor). */
  imagesLocked: boolean;
  /** True once the screenshot element exists in the scene. */
  sceneReady: boolean;
}

function describeActionError(error: unknown): { message: string; hint?: string } {
  if (error instanceof ExportError || error instanceof ClipboardError) {
    return { message: error.message, hint: error.hint };
  }
  if (error instanceof Error) {
    return { message: error.message };
  }
  return { message: "Something unexpected happened." };
}

function toastDescription(message: string, hint?: string): string {
  return hint ? `${message} ${hint}` : message;
}

/**
 * Editor chrome: brand + document name on the left; history (undo/redo), view
 * (reset view, screenshot lock) and export (copy/download) actions on the right.
 *
 * Drawing tools stay in Excalidraw's own toolbar; SnapDraw's menu (clear
 * annotations, GitHub, about) lives in Excalidraw's main menu.
 */
export function EditorHeader({
  prepared,
  api,
  workspaceRef,
  showToast,
  imagesLocked,
  sceneReady,
}: EditorHeaderProps) {
  const [pendingAction, setPendingAction] = useState<"copy" | "download" | null>(null);

  const docName = prepared.record.name.trim() || "Screenshot";
  const clipboardSupported = isClipboardImageCopySupported();
  const busy = pendingAction !== null;
  const exportReady = Boolean(api) && sceneReady;

  const handleHistory = (direction: HistoryDirection): void => {
    if (dispatchHistoryShortcut(workspaceRef.current, direction)) {
      return;
    }
    showToast({
      tone: "error",
      title: "The editor is still starting",
      description: "Try again in a moment.",
    });
  };

  const handleResetView = (): void => {
    if (!api) {
      return;
    }
    if (fitSceneToContent(api, { animate: true })) {
      showToast({
        tone: "info",
        title: "View reset",
        description: "The whole screenshot is in view again.",
        duration: 2200,
      });
    }
  };

  const handleToggleLock = (): void => {
    if (!api) {
      return;
    }

    const elements = api.getSceneElements();
    const imageElements = elements.filter((element) => element.type === "image");
    if (imageElements.length === 0) {
      return;
    }

    const nextLocked = !imageElements.every((element) => element.locked);
    api.updateScene({
      elements: elements.map((element) =>
        element.type === "image"
          ? mutateElement(element, { locked: nextLocked })
          : element,
      ),
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });

    showToast({
      tone: "info",
      title: nextLocked ? "Screenshot locked" : "Screenshot unlocked",
      description: nextLocked
        ? "The screenshot can't be moved or deleted by accident."
        : "Move or resize the screenshot freely, then lock it again.",
      duration: 3600,
    });
  };

  const handleCopy = async (): Promise<void> => {
    if (!api || !sceneReady || busy) {
      return;
    }
    setPendingAction("copy");
    try {
      const scene = readScene(api);
      const blob = await exportSceneToPngBlob(scene);
      await copyImageBlobToClipboard(blob);
      showToast({
        tone: "success",
        title: "Copied to clipboard",
        description: "Paste your annotated screenshot anywhere.",
      });
    } catch (error) {
      const { message, hint } = describeActionError(error);
      showToast({
        tone: "error",
        title: "Couldn't copy the image",
        description: toastDescription(message, hint),
      });
    } finally {
      setPendingAction(null);
    }
  };

  const handleDownload = async (): Promise<void> => {
    if (!api || !sceneReady || busy) {
      return;
    }
    setPendingAction("download");
    try {
      const scene = readScene(api);
      const blob = await exportSceneToPngBlob(scene);
      const filename = buildExportFilename(prepared.record.name);
      downloadBlob(blob, filename);
      showToast({
        tone: "success",
        title: "PNG downloaded",
        description: filename,
      });
    } catch (error) {
      const { message, hint } = describeActionError(error);
      showToast({
        tone: "error",
        title: "Couldn't download the PNG",
        description: toastDescription(message, hint),
      });
    } finally {
      setPendingAction(null);
    }
  };

  return (
    <header className="sd-header">
      <div className="sd-header__brand">
        <Logo size={26} />
        <h1 className="sd-header__wordmark">SnapDraw</h1>
      </div>

      <span className="sd-header__divider" aria-hidden="true" />

      <div className="sd-header__doc">
        <span className="sd-header__name" title={docName}>
          {docName}
        </span>
        <span className="sd-header__meta">
          <span className="sd-header__badge" title="Stored only in this browser">
            Local
          </span>
          <span className="sd-header__dimensions">
            {prepared.width} × {prepared.height} · {prepared.sizeLabel}
          </span>
        </span>
      </div>

      <div className="sd-header__actions" role="toolbar" aria-label="Editor actions">
        <div className="sd-header__group" role="group" aria-label="History">
          <Button
            variant="icon"
            size="sm"
            title="Undo (Ctrl/Cmd+Z)"
            aria-label="Undo"
            disabled={!api}
            onClick={() => handleHistory("undo")}
          >
            <UndoIcon />
          </Button>
          <Button
            variant="icon"
            size="sm"
            title="Redo (Ctrl/Cmd+Shift+Z)"
            aria-label="Redo"
            disabled={!api}
            onClick={() => handleHistory("redo")}
          >
            <RedoIcon />
          </Button>
        </div>

        <span className="sd-header__divider" aria-hidden="true" />

        <div className="sd-header__group" role="group" aria-label="View">
          <Button
            variant="icon"
            size="sm"
            title="Reset view — fit the screenshot to the screen"
            aria-label="Reset view"
            disabled={!api}
            onClick={handleResetView}
          >
            <FitViewIcon />
          </Button>
          <Button
            variant="icon"
            size="sm"
            title={
              imagesLocked
                ? "Screenshot locked — click to unlock"
                : "Screenshot unlocked — click to lock"
            }
            aria-label={imagesLocked ? "Unlock screenshot" : "Lock screenshot"}
            aria-pressed={imagesLocked}
            disabled={!api}
            onClick={handleToggleLock}
          >
            {imagesLocked ? <LockIcon /> : <UnlockIcon />}
          </Button>
        </div>

        <span className="sd-header__divider" aria-hidden="true" />

        <div className="sd-header__group sd-header__group--export">
          <Button
            variant="secondary"
            size="sm"
            leadingIcon={<CopyIcon />}
            loading={pendingAction === "copy"}
            disabled={!exportReady || pendingAction === "download"}
            title={
              clipboardSupported
                ? "Copy the annotated image to the clipboard"
                : "Clipboard unavailable in this context – use Download PNG"
            }
            aria-label="Copy image"
            onClick={() => void handleCopy()}
          >
            <span className="sd-header__action-label">Copy Image</span>
          </Button>

          <Button
            variant="primary"
            size="sm"
            leadingIcon={<DownloadIcon />}
            loading={pendingAction === "download"}
            disabled={!exportReady || pendingAction === "copy"}
            title="Download the annotated image as a PNG"
            aria-label="Download PNG"
            onClick={() => void handleDownload()}
          >
            <span className="sd-header__action-label">Download</span>
          </Button>
        </div>
      </div>
    </header>
  );
}
