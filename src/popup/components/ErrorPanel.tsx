import { Button } from "../../components/Button";
import type { SnapDrawErrorPayload } from "../../types";
import { AlertIcon, RetryIcon } from "./icons";

/** Pages Chrome refuses to let an extension capture. */
const RESTRICTED_CAUSES = [
  "Chrome pages like chrome://settings or a new tab",
  "The Chrome Web Store",
  "SnapDraw's own pages and other extensions",
];

export interface ErrorPanelProps {
  error: SnapDrawErrorPayload;
  onRetry: () => void;
}

/**
 * Compact inline error state. Shown in place of the capture action so the
 * failure, the likely cause and the retry path all sit in one readable block.
 */
export function ErrorPanel({ error, onRetry }: ErrorPanelProps) {
  return (
    <section className="sd-popup__error" role="alert">
      <div className="sd-popup__error-head">
        <span className="sd-popup__error-icon">
          <AlertIcon size={17} />
        </span>
        <div className="sd-popup__error-copy">
          <p className="sd-popup__error-message">{error.message}</p>
          {error.hint ? <p className="sd-popup__error-hint">{error.hint}</p> : null}
        </div>
      </div>

      {error.code === "RESTRICTED_PAGE" ? (
        <div className="sd-popup__error-causes">
          <p className="sd-popup__error-label">Chrome can't capture these pages</p>
          <ul className="sd-popup__error-list">
            {RESTRICTED_CAUSES.map((cause) => (
              <li key={cause}>{cause}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <Button
        variant="secondary"
        size="sm"
        fullWidth
        leadingIcon={<RetryIcon size={14} />}
        onClick={onRetry}
        autoFocus
      >
        Try again
      </Button>
    </section>
  );
}
