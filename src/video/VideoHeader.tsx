/**
 * Video editor chrome: brand + recording name on the left, export actions on
 * the right.
 *
 * The full drawing toolset lives in Excalidraw's own toolbar; this header owns
 * the file actions (copy a still frame, export the annotated video, download the
 * original) so they stay consistent with the screenshot editor.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { ScreenshotRecord } from "../types";
import { Button } from "../components/Button";
import { Logo } from "../components/Logo";
import { CopyIcon, DownloadIcon, InfoIcon, TrashIcon } from "../editor/icons";
import { formatBytes } from "../utils/image-conversion";
import { formatDuration } from "../services/video.service";
import { MoreIcon } from "./icons";

export interface VideoHeaderProps {
  record: ScreenshotRecord;
  /** Effective recording length (stored metadata or the decoded duration). */
  durationMs: number;
  /** Live count of annotations in the Excalidraw scene. */
  annotationCount: number;
  /** True while the annotated video is being rendered. */
  exporting: boolean;
  /** Renders the current frame + annotations and copies it as a PNG. */
  onCopyFrame: () => Promise<void>;
  /** Starts the annotated video export (progress overlay is owned by the tab). */
  onDownloadVideo: () => void;
  /** Downloads the untouched recording blob. */
  onDownloadOriginal: () => void;
  onClearAnnotations: () => void;
  onShowAbout: () => void;
}

export function VideoHeader({
  record,
  durationMs,
  annotationCount,
  exporting,
  onCopyFrame,
  onDownloadVideo,
  onDownloadOriginal,
  onClearAnnotations,
  onShowAbout,
}: VideoHeaderProps) {
  const [copying, setCopying] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const docName = record.name.trim() || "Recording";
  const busy = exporting || copying;

  const handleCopyFrame = useCallback(async (): Promise<void> => {
    if (busy) {
      return;
    }
    setCopying(true);
    try {
      await onCopyFrame();
    } finally {
      setCopying(false);
    }
  }, [busy, onCopyFrame]);

  const runMenuAction = useCallback((action: () => void): void => {
    setMenuOpen(false);
    action();
  }, []);

  // Close the overflow menu on outside clicks and Escape, returning focus to
  // the trigger so keyboard users don't lose their place. Opening the menu moves
  // focus to its first item, which is what `role="menu"` implies.
  useEffect(() => {
    if (!menuOpen) {
      return undefined;
    }

    const focusFirstItem = window.setTimeout(() => {
      menuRef.current
        ?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
        ?.focus();
    }, 0);

    const handlePointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (menuRef.current && target instanceof Node && menuRef.current.contains(target)) {
        return;
      }
      setMenuOpen(false);
    };

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      setMenuOpen(false);
      menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.clearTimeout(focusFirstItem);
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [menuOpen]);

  /** Arrow/Home/End navigation between the overflow menu items. */
  const handleMenuKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>): void => {
      const items = Array.from(
        menuRef.current?.querySelectorAll<HTMLButtonElement>(
          '[role="menuitem"]:not(:disabled)',
        ) ?? [],
      );
      if (items.length === 0) {
        return;
      }

      const currentIndex = items.indexOf(
        document.activeElement as HTMLButtonElement,
      );

      if (event.key === "ArrowDown") {
        event.preventDefault();
        items[(currentIndex + 1) % items.length]?.focus();
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        items[(currentIndex - 1 + items.length) % items.length]?.focus();
      } else if (event.key === "Home") {
        event.preventDefault();
        items[0]?.focus();
      } else if (event.key === "End") {
        event.preventDefault();
        items[items.length - 1]?.focus();
      } else if (event.key === "Tab") {
        setMenuOpen(false);
      }
    },
    [],
  );

  return (
    <header className="sd-header sd-video__header">
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
            {formatDuration(durationMs)} · {record.width} × {record.height} ·{" "}
            {formatBytes(record.size || record.blob.size)}
          </span>
        </span>
      </div>

      <div className="sd-header__actions" role="toolbar" aria-label="Editor actions">
        <div className="sd-header__group sd-header__group--export">
          <Button
            variant="secondary"
            size="sm"
            leadingIcon={<CopyIcon />}
            loading={copying}
            disabled={exporting}
            title="Copy the current frame with your annotations to the clipboard"
            aria-label="Copy frame"
            onClick={() => void handleCopyFrame()}
          >
            <span className="sd-header__action-label">Copy frame</span>
          </Button>

          <Button
            variant="primary"
            size="sm"
            leadingIcon={<DownloadIcon />}
            loading={exporting}
            disabled={copying}
            title="Render and download the annotated video"
            aria-label="Download video"
            onClick={onDownloadVideo}
          >
            <span className="sd-header__action-label">Download video</span>
          </Button>

          <div className="sd-video__menu-wrap" ref={menuRef}>
            <Button
              variant="icon"
              size="sm"
              aria-label="More actions"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              disabled={busy}
              title="More actions"
              onClick={() => setMenuOpen((open) => !open)}
            >
              <MoreIcon />
            </Button>

            {menuOpen ? (
              <div
                className="sd-video__menu"
                role="menu"
                aria-label="More actions"
                onKeyDown={handleMenuKeyDown}
              >
                <button
                  type="button"
                  role="menuitem"
                  className="sd-video__menu-item"
                  onClick={() => runMenuAction(onDownloadOriginal)}
                >
                  <DownloadIcon size={15} />
                  <span>Download original recording</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="sd-video__menu-item"
                  disabled={annotationCount === 0}
                  onClick={() => runMenuAction(onClearAnnotations)}
                >
                  <TrashIcon size={15} />
                  <span>Clear annotations</span>
                </button>
                <span className="sd-video__menu-divider" role="separator" />
                <button
                  type="button"
                  role="menuitem"
                  className="sd-video__menu-item"
                  onClick={() => runMenuAction(onShowAbout)}
                >
                  <InfoIcon size={15} />
                  <span>About SnapDraw</span>
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </header>
  );
}
