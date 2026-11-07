import { useCallback, useEffect, useRef, useState } from "react";
import type { ScreenshotHistoryEntry } from "../types";
import { listScreenshots } from "../services/storage.service";

export interface RecentScreenshot {
  entry: ScreenshotHistoryEntry;
  /** Object URL for the stored thumbnail (revoked automatically). */
  thumbnailUrl?: string;
}

export interface UseRecentScreenshotsResult {
  recent: RecentScreenshot[];
  /** Total captures in the local history. */
  total: number;
  refresh: () => Promise<void>;
}

/** How many thumbnails the compact "Recent" preview shows. */
export const RECENT_PREVIEW_LIMIT = 3;

/**
 * Loads the newest captures for the popup's compact history preview.
 *
 * Only thumbnails are turned into object URLs; the full-size screenshots stay in
 * IndexedDB until the user opens one.
 */
export function useRecentScreenshots(
  limit: number = RECENT_PREVIEW_LIMIT,
): UseRecentScreenshotsResult {
  const [recent, setRecent] = useState<RecentScreenshot[]>([]);
  const [total, setTotal] = useState(0);

  const mountedRef = useRef(true);
  const thumbnailUrlsRef = useRef<string[]>([]);

  const releaseThumbnailUrls = useCallback((): void => {
    for (const url of thumbnailUrlsRef.current) {
      URL.revokeObjectURL(url);
    }
    thumbnailUrlsRef.current = [];
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const entries = await listScreenshots();
      if (!mountedRef.current) {
        return;
      }

      releaseThumbnailUrls();
      const preview = entries.slice(0, Math.max(1, limit)).map((entry) => {
        let thumbnailUrl: string | undefined;
        if (entry.thumbnail instanceof Blob) {
          thumbnailUrl = URL.createObjectURL(entry.thumbnail);
          thumbnailUrlsRef.current.push(thumbnailUrl);
        }
        return { entry, thumbnailUrl };
      });

      setRecent(preview);
      setTotal(entries.length);
    } catch {
      // The history is a convenience: a storage hiccup just hides the preview.
      if (mountedRef.current) {
        setRecent([]);
        setTotal(0);
      }
    }
  }, [limit, releaseThumbnailUrls]);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    return () => {
      mountedRef.current = false;
      releaseThumbnailUrls();
    };
  }, [refresh, releaseThumbnailUrls]);

  return { recent, total, refresh };
}
