import { useEffect, useRef } from "react";
import { Logo } from "../components/Logo";
import { CloseIcon, ExternalLinkIcon, GitHubIcon } from "./icons";
import { SNAPDRAW_ISSUES_URL, SNAPDRAW_REPO_URL } from "./links";

export interface AboutDialogProps {
  open: boolean;
  onClose: () => void;
}

/** Extension version, with a dev fallback outside the extension context. */
function getVersion(): string {
  try {
    if (typeof chrome !== "undefined" && typeof chrome.runtime?.getManifest === "function") {
      return chrome.runtime.getManifest().version;
    }
  } catch {
    // Plain-browser preview.
  }
  return "dev";
}

/**
 * "About SnapDraw" dialog: brand, version, the local-only promise and links to
 * the SnapDraw repository / issue tracker.
 */
export function AboutDialog({ open, onClose }: AboutDialogProps) {
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    closeButtonRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  if (!open) {
    return null;
  }

  return (
    <div
      className="sd-about"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        className="sd-about__dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sd-about-title"
        aria-describedby="sd-about-description"
      >
        <div className="sd-about__head">
          <Logo size={34} />
          <div className="sd-about__identity">
            <h2 id="sd-about-title" className="sd-about__title">
              SnapDraw
            </h2>
            <p className="sd-about__version">Version {getVersion()} · local-only</p>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className="sd-about__close"
            aria-label="Close about dialog"
            onClick={onClose}
          >
            <CloseIcon size={14} />
          </button>
        </div>

        <p id="sd-about-description" className="sd-about__text">
          Capture the visible part of any page and annotate it with Excalidraw.
          Screenshots and annotations live only in this browser — nothing is uploaded,
          and there is no account or server.
        </p>

        <div className="sd-about__links">
          <a
            className="sd-about__link"
            href={SNAPDRAW_REPO_URL}
            target="_blank"
            rel="noreferrer noopener"
          >
            <GitHubIcon size={16} />
            <span>SnapDraw on GitHub</span>
            <ExternalLinkIcon size={13} className="sd-about__link-external" />
          </a>
          <a
            className="sd-about__link"
            href={SNAPDRAW_ISSUES_URL}
            target="_blank"
            rel="noreferrer noopener"
          >
            <ExternalLinkIcon size={16} />
            <span>Report an issue</span>
            <ExternalLinkIcon size={13} className="sd-about__link-external" />
          </a>
        </div>

        <p className="sd-about__footer">MIT licensed · Drawing engine by Excalidraw</p>
      </div>
    </div>
  );
}
