import { useCallback, useEffect, useRef, useState } from "react";
import type { ScreenshotHistoryEntry } from "../../types";
import { Button } from "../../components/Button";
import type { ShowToastInput } from "../../components/Toast";
import {
  clearScreenshots,
  deleteScreenshot,
  HISTORY_LIMIT,
  listScreenshots,
} from "../../services/storage.service";
import { buildEditorUrl, isExtensionContext } from "../../utils/messaging";
import { ChevronLeftIcon, ImageIcon, TrashIcon } from "./icons";

interface HistoryRow {
  entry: ScreenshotHistoryEntry;
  thumbnailUrl?: string;
}

export interface HistoryPanelProps {
  onBack: () => void;
  /** Called whenever the list changes so the popup can refresh its counter. */
  onChanged: () => void;
  showToast: (toast: ShowToastInput) => string;
}

const DATE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

function formatDate(timestamp: number): string {
  try {
    return DATE_FORMATTER.format(timestamp);
  } catch {
    return new Date(timestamp).toLocaleString();
  }
}

/**
 * Local screenshot history.
 *
 * Lists the captures saved in IndexedDB (newest first), opens any of them in a
 * new editor tab and supports deleting a single entry or clearing everything.
 * Thumbnails are generated at capture time, so the list never has to decode the
 * full-size screenshots.
 */
export function HistoryPanel({ onBack, onChanged, showToast }: HistoryPanelProps) {
  const [rows, setRows] = useState<HistoryRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirmingClear, setConfirmingClear] = useState(false);

  const mountedRef = useRef(true);
  const thumbnailUrlsRef = useRef<string[]>([]);

  const releaseThumbnailUrls = useCallback((): void => {
    for (const url of thumbnailUrlsRef.current) {
      URL.revokeObjectURL(url);
    }
    thumbnailUrlsRef.current = [];
  }, []);

  const load = useCallback(async (): Promise<void> => {
    try {
      const entries = await listScreenshots();
      if (!mountedRef.current) {
        return;
      }

      releaseThumbnailUrls();
      const nextRows = entries.map((entry) => {
        let thumbnailUrl: string | undefined;
        if (entry.thumbnail instanceof Blob) {
          thumbnailUrl = URL.createObjectURL(entry.thumbnail);
          thumbnailUrlsRef.current.push(thumbnailUrl);
        }
        return { entry, thumbnailUrl };
      });

      setRows(nextRows);
      setLoadError(null);
    } catch (error) {
      if (!mountedRef.current) {
        return;
      }
      setLoadError(
        error instanceof Error ? error.message : "Could not read the local history.",
      );
    }
  }, [releaseThumbnailUrls]);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    return () => {
      mountedRef.current = false;
      releaseThumbnailUrls();
    };
  }, [load, releaseThumbnailUrls]);

  const handleOpen = useCallback(
    async (row: HistoryRow): Promise<void> => {
      if (!isExtensionContext()) {
        showToast({
          tone: "info",
          title: "History is available in the extension",
          description: "Load SnapDraw from chrome://extensions to open a capture.",
        });
        return;
      }

      try {
        await chrome.tabs.create({ url: buildEditorUrl(row.entry.id), active: true });
        window.close();
      } catch (error) {
        showToast({
          tone: "error",
          title: "Couldn't open the screenshot",
          description:
            error instanceof Error ? error.message : "Please try again.",
        });
      }
    },
    [showToast],
  );

  const handleDelete = useCallback(
    async (row: HistoryRow): Promise<void> => {
      try {
        await deleteScreenshot(row.entry.id);
        await load();
        onChanged();
        showToast({
          tone: "success",
          title: "Screenshot removed",
          description: row.entry.name,
        });
      } catch {
        showToast({
          tone: "error",
          title: "Couldn't delete the screenshot",
          description: "Please try again.",
        });
      }
    },
    [load, onChanged, showToast],
  );

  const handleClearAll = useCallback(async (): Promise<void> => {
    if (!confirmingClear) {
      setConfirmingClear(true);
      return;
    }

    try {
      await clearScreenshots();
      setConfirmingClear(false);
      await load();
      onChanged();
      showToast({
        tone: "success",
        title: "History cleared",
        description: "Every saved capture was removed from this browser.",
      });
    } catch {
      showToast({
        tone: "error",
        title: "Couldn't clear the history",
        description: "Please try again.",
      });
    }
  }, [confirmingClear, load, onChanged, showToast]);

  const entryCount = rows?.length ?? 0;

  return (
    <section className="sd-history" aria-label="Screenshot history">
      <div className="sd-history__header">
        <button
          type="button"
          className="sd-history__back"
          aria-label="Back to capture"
          title="Back to capture"
          onClick={onBack}
        >
          <ChevronLeftIcon size={18} />
        </button>

        <div className="sd-history__heading">
          <h2 className="sd-history__title">Screenshots</h2>
          <span className="sd-history__count">
            {rows === null ? "Loading…" : `${entryCount} saved`}
          </span>
        </div>

        <button
          type="button"
          className={
            confirmingClear
              ? "sd-history__clear sd-history__clear--confirm"
              : "sd-history__clear"
          }
          onClick={() => void handleClearAll()}
          disabled={entryCount === 0}
        >
          {confirmingClear ? "Confirm clear" : "Clear all"}
        </button>
      </div>

      {loadError ? (
        <p className="sd-history__error" role="alert">
          {loadError}
        </p>
      ) : null}

      {rows === null ? (
        <p className="sd-history__loading" role="status">
          Loading saved screenshots…
        </p>
      ) : rows.length === 0 ? (
        <div className="sd-history__empty">
          <span className="sd-history__empty-icon" aria-hidden="true">
            <ImageIcon size={22} />
          </span>
          <p className="sd-history__empty-title">No screenshots yet</p>
          <p className="sd-history__empty-text">
            Every capture is saved here automatically, on this device — refresh the editor
            or reopen it later and the screenshot is still there.
          </p>
          <Button variant="secondary" size="sm" onClick={onBack}>
            Capture a screenshot
          </Button>
        </div>
      ) : (
        <ul className="sd-history__list">
          {rows.map((row) => (
            <li key={row.entry.id} className="sd-history__item">
              <button
                type="button"
                className="sd-history__open"
                aria-label={`Open ${row.entry.name}`}
                title={`Open ${row.entry.name}`}
                onClick={() => void handleOpen(row)}
              >
                <span className="sd-history__thumb">
                  {row.thumbnailUrl ? (
                    <img src={row.thumbnailUrl} alt="" />
                  ) : (
                    <ImageIcon size={17} />
                  )}
                </span>
                <span className="sd-history__info">
                  <span className="sd-history__name">{row.entry.name}</span>
                  <span className="sd-history__meta">
                    {row.entry.width} × {row.entry.height} · {formatDate(row.entry.createdAt)}
                  </span>
                </span>
              </button>

              <button
                type="button"
                className="sd-history__delete"
                aria-label={`Delete ${row.entry.name}`}
                title="Delete screenshot"
                onClick={() => void handleDelete(row)}
              >
                <TrashIcon size={15} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <p className="sd-history__note">
        Saved locally · up to {HISTORY_LIMIT} most recent · nothing is uploaded
      </p>
    </section>
  );
}
