/**
 * Recording helpers.
 *
 * The popup obtains a short-lived capture stream id (tabCapture for the current
 * tab, desktopCapture for the whole screen) while it owns the user gesture; the
 * service worker forwards it to the offscreen document, which records to WebM
 * and saves the result next to screenshots in IndexedDB.
 */
import type { ScreenshotRecord } from "../types";
import { SnapDrawError } from "../utils/messaging";
import { putScreenshot, trimScreenshots } from "./storage.service";
import { createVideoThumbnail } from "./video.service";

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** `Recording 2026-11-08 at 00.15.12` (local time, filename-safe). */
export function buildRecordingName(date: Date = new Date()): string {
  const safe = Number.isFinite(date.getTime()) ? date : new Date();
  return `Recording ${safe.getFullYear()}-${pad(safe.getMonth() + 1)}-${pad(
    safe.getDate(),
  )} at ${pad(safe.getHours())}.${pad(safe.getMinutes())}.${pad(safe.getSeconds())}`;
}

/**
 * Requests a capture stream id for a tab.
 *
 * Must be called from an extension page in response to a user gesture (the
 * toolbar popup click), which also grants `activeTab` for the target tab.
 */
export async function getTabCaptureStreamId(tabId: number): Promise<string> {
  const tabCapture = chrome.tabCapture as
    | typeof chrome.tabCapture
    | undefined;

  if (!tabCapture?.getMediaStreamId) {
    throw new SnapDrawError(
      "CAPTURE_FAILED",
      "Video recording is not available in this browser.",
      "Update Chrome to a recent version and try again.",
    );
  }

  try {
    // @types/chrome models the promise overload loosely; a callback wrapper
    // works in every MV3 Chrome and surfaces `runtime.lastError` cleanly.
    const streamId = await new Promise<string>((resolve, reject) => {
      tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          reject(new Error(lastError.message));
          return;
        }
        resolve(id);
      });
    });

    if (!streamId) {
      throw new Error("Chrome returned an empty capture stream id.");
    }
    return streamId;
  } catch (error) {
    if (error instanceof SnapDrawError) {
      throw error;
    }
    console.warn(
      `[SnapDraw] tab capture request failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    throw new SnapDrawError(
      "CAPTURE_FAILED",
      "SnapDraw couldn't start recording this tab.",
      "Make sure the tab is a normal website (not chrome:// or the Web Store), then try again.",
    );
  }
}

export interface RecordingSaveInput {
  blob: Blob;
  width: number;
  height: number;
  durationMs: number;
}

/** Renders a history thumbnail from the recorded WebM. */
async function thumbnailFromRecording(blob: Blob): Promise<Blob | undefined> {
  if (typeof document === "undefined") {
    return undefined;
  }

  const objectUrl = URL.createObjectURL(blob);
  const video = document.createElement("video");
  video.preload = "auto";
  video.muted = true;
  video.src = objectUrl;

  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(
        () => reject(new Error("Timed out reading the recording.")),
        8_000,
      );
      video.onloadeddata = () => {
        window.clearTimeout(timeout);
        resolve();
      };
      video.onerror = () => {
        window.clearTimeout(timeout);
        reject(new Error("Could not decode the recording."));
      };
    });

    // A frame slightly into the recording is more representative than frame 0.
    const at = Number.isFinite(video.duration)
      ? Math.min(0.1, Math.max(0, video.duration / 2))
      : 0;
    return await createVideoThumbnail(video, at);
  } catch {
    return undefined;
  } finally {
    video.removeAttribute("src");
    URL.revokeObjectURL(objectUrl);
  }
}

/**
 * Stores a finished recording (with thumbnail/duration) and returns its session
 * id so the caller can open the video editor.
 */
export async function saveRecording(
  input: RecordingSaveInput,
): Promise<{ id: string; name: string }> {
  const recordId = crypto.randomUUID();
  const name = buildRecordingName();
  const thumbnail = await thumbnailFromRecording(input.blob);

  const record: ScreenshotRecord = {
    id: recordId,
    name,
    createdAt: Date.now(),
    width: input.width,
    height: input.height,
    mimeType: input.blob.type || "video/webm",
    size: input.blob.size,
    blob: input.blob,
    kind: "video",
    durationMs: Math.max(0, Math.round(input.durationMs)),
    ...(thumbnail ? { thumbnail } : {}),
  };

  await putScreenshot(record);
  void trimScreenshots();

  return { id: recordId, name };
}
