import { useEffect, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
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
import { getAvailableShareProviders } from "../services/share.service";
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
  InfoIcon,
  LockIcon,
  MoreIcon,
  RedoIcon,
  ShareIcon,
  TrashIcon,
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
  /** Mirrored scene state owned by `Editor`. */
  imagesLocked: boolean;
  annotationCount: number;
  sceneReady: boolean;
}

const MORE_MENU_ID = "sd-editor-more-menu";

/** Version shown in the About toast (falls back to "dev" outside the extension). */
function getExtensionVersion(): string {
  try {
    if (typeof chrome !== "undefined" && typeof chrome.runtime?.getManifest === "function") {
      return chrome.runtime.getManifest().version;
    }
  } catch {
    // Plain-browser preview.
  }
  return "dev";
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

interface MenuItemProps {
  icon: ReactNode;
  children: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
}

function MenuItem({ icon, children, onSelect, disabled = false }: MenuItemProps) {
  return (
    <button
      type="button"
      role="menuitem"
      className="sd-menu__item"
      onClick={onSelect}
      disabled={disabled}
    >
      <span className="sd-menu__item-icon">{icon}</span>
      <span className="sd-menu__item-label">{children}</span>
    </button>
  );
}

export function EditorHeader({
  prepared,
  api,
  workspaceRef,
  showToast,
  imagesLocked,
  annotationCount,
  sceneReady,
}: EditorHeaderProps) {
  const [pendingAction, setPendingAction] = useState<"copy" | "download" | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  const menuAnchorRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const docName = prepared.record.name.trim() || "Screenshot";
  const clipboardSupported = isClipboardImageCopySupported();
  const busy = pendingAction !== null;

  // Keep keyboard focus inside the menu when the inline confirm replaces the
  // "Clear annotations" item.
  useEffect(() => {
    if (!confirmClear) {
      return;
    }
    menuRef.current
      ?.querySelector<HTMLButtonElement>(".sd-menu__confirm-actions button")
      ?.focus();
  }, [confirmClear]);

  const closeMenu = (): void => {
    setMenuOpen(false);
    setConfirmClear(false);
  };

  const handleMenuToggle = (): void => {
    if (menuOpen) {
      closeMenu();
    } else {
      setMenuOpen(true);
    }
  };

  // Close the More menu on outside click or Escape, restoring focus to the trigger.
  useEffect(() => {
    if (!menuOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (target instanceof Node && menuAnchorRef.current?.contains(target)) {
        return;
      }
      closeMenu();
    };

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      closeMenu();
      menuAnchorRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [menuOpen]);

  // Move focus into the menu when it opens.
  useEffect(() => {
    if (!menuOpen) {
      return;
    }
    const firstItem = menuRef.current?.querySelector<HTMLElement>(
      "[role='menuitem']:not([disabled])",
    );
    firstItem?.focus();
  }, [menuOpen]);

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

  const handleCopy = async (): Promise<void> => {
    if (!api || busy) {
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
    if (!api || busy) {
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

  const handleShare = (): void => {
    closeMenu();
    const providers = getAvailableShareProviders();
    showToast({
      tone: "info",
      title: "Sharing arrives in v2",
      description:
        providers.length === 0
          ? "Your image never leaves this device. Use Copy Image or Download PNG today."
          : "Choose a provider to share your annotated screenshot.",
      duration: 5200,
    });
  };

  const handleResetView = (): void => {
    closeMenu();
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
    closeMenu();
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
        ? "Annotations can be selected; the screenshot stays in place."
        : "Move or resize the screenshot freely, then lock it again from More.",
      duration: 3600,
    });
  };

  const handleClearAnnotations = (): void => {
    closeMenu();
    if (!api) {
      return;
    }

    const elements = api.getSceneElements();
    const imageElements = elements.filter((element) => element.type === "image");
    api.updateScene({
      elements: imageElements,
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });

    showToast({
      tone: "success",
      title: "Annotations cleared",
      description: "The screenshot is untouched – undo brings your notes back.",
    });
  };

  const handleAbout = (): void => {
    closeMenu();
    const version = getExtensionVersion();
    showToast({
      tone: "info",
      title: "About SnapDraw",
      description: `Version ${version} · Screenshots and annotations stay on this device.`,
      duration: 6000,
    });
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
            disabled={!api || !sceneReady}
            onClick={() => handleHistory("undo")}
          >
            <UndoIcon />
          </Button>
          <Button
            variant="icon"
            size="sm"
            title="Redo (Ctrl/Cmd+Shift+Z)"
            aria-label="Redo"
            disabled={!api || !sceneReady}
            onClick={() => handleHistory("redo")}
          >
            <RedoIcon />
          </Button>
        </div>

        <span className="sd-header__divider" aria-hidden="true" />

        <div className="sd-header__group sd-header__group--export">
          <Button
            variant="secondary"
            size="sm"
            leadingIcon={<CopyIcon />}
            loading={pendingAction === "copy"}
            disabled={!api || !sceneReady || pendingAction === "download"}
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
            disabled={!api || !sceneReady || pendingAction === "copy"}
            title="Download the annotated image as a PNG"
            aria-label="Download PNG"
            onClick={() => void handleDownload()}
          >
            <span className="sd-header__action-label">Download</span>
          </Button>

          <Button
            variant="secondary"
            size="sm"
            leadingIcon={<ShareIcon />}
            title="Share (arrives in v2)"
            aria-label="Share"
            onClick={handleShare}
          >
            <span className="sd-header__action-label">Share</span>
          </Button>
        </div>

        <div className="sd-header__menu" ref={menuAnchorRef}>
          <Button
            variant="icon"
            size="sm"
            title="More actions"
            aria-label="More actions"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-controls={menuOpen ? MORE_MENU_ID : undefined}
            disabled={!api || !sceneReady}
            onClick={handleMenuToggle}
          >
            <MoreIcon />
          </Button>

          {menuOpen ? (
            <div
              id={MORE_MENU_ID}
              ref={menuRef}
              className="sd-menu"
              role="menu"
              aria-label="More actions"
            >
              <MenuItem icon={<FitViewIcon />} onSelect={handleResetView}>
                Reset view
              </MenuItem>

              {confirmClear ? (
                <div className="sd-menu__confirm" role="none">
                  <p className="sd-menu__confirm-text">
                    Remove all annotations? The screenshot stays.
                  </p>
                  <div className="sd-menu__confirm-actions">
                    <Button
                      role="menuitem"
                      variant="ghost"
                      size="sm"
                      onClick={() => setConfirmClear(false)}
                    >
                      Cancel
                    </Button>
                    <Button
                      role="menuitem"
                      variant="primary"
                      size="sm"
                      onClick={handleClearAnnotations}
                    >
                      Clear
                    </Button>
                  </div>
                </div>
              ) : (
                <MenuItem
                  icon={<TrashIcon />}
                  onSelect={() => setConfirmClear(true)}
                  disabled={annotationCount === 0}
                >
                  Clear annotations
                </MenuItem>
              )}

              <MenuItem
                icon={imagesLocked ? <UnlockIcon /> : <LockIcon />}
                onSelect={handleToggleLock}
              >
                {imagesLocked ? "Unlock screenshot" : "Lock screenshot"}
              </MenuItem>

              <span className="sd-menu__separator" role="separator" />

              <MenuItem icon={<InfoIcon />} onSelect={handleAbout}>
                About SnapDraw
              </MenuItem>
            </div>
          ) : null}
        </div>
      </div>
    </header>
  );
}
