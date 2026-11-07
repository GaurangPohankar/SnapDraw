/**
 * Local video recordings.
 *
 * Recordings live in the same IndexedDB store as screenshots (`kind: "video"`),
 * so history, retention and cleanup are shared. Everything is local: the file
 * is a browser-recorded WebM blob and never leaves the device.
 */
import type { ScreenshotRecord } from "../types";
import { getScreenshot } from "./storage.service";

/** Container/codec candidates in order of preference. */
export const VIDEO_MIME_TYPES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
] as const;

/** True for records that hold a video (older records default to images). */
export function isVideoRecord(record: {
  kind?: string;
  mimeType?: string;
}): boolean {
  if (record.kind) {
    return record.kind === "video";
  }
  return record.mimeType === "video/webm";
}

/** Picks the first MediaRecorder mime type the browser supports. */
export function pickVideoMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") {
    return undefined;
  }
  for (const candidate of VIDEO_MIME_TYPES) {
    try {
      if (MediaRecorder.isTypeSupported(candidate)) {
        return candidate;
      }
    } catch {
      // Ignore and try the next candidate.
    }
  }
  return undefined;
}

/** Loads a stored recording, rejecting images/missing blobs with a clear error. */
export async function loadVideoRecord(sessionId: string): Promise<ScreenshotRecord> {
  const record = await getScreenshot(sessionId);
  if (!record || !(record.blob instanceof Blob)) {
    throw new Error("This recording is no longer available in local storage.");
  }
  if (!isVideoRecord(record)) {
    throw new Error("This capture is not a video recording.");
  }
  return record;
}

/** `m:ss` / `h:mm:ss` formatting for durations in milliseconds. */
export function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value: number): string => String(value).padStart(2, "0");

  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${minutes}:${pad(seconds)}`;
}

/** File-system safe `.webm` name derived from the recording name. */
export function buildVideoFilename(
  name: string,
  suffix = "",
  extension = "webm",
): string {
  const base =
    name
      .trim()
      .replace(/\.(webm|mp4|mov|png|jpe?g|gif|webp)$/i, "")
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "")
      .slice(0, 110) || "snapdraw-recording";

  const suffixPart = suffix
    ? `-${suffix.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "")}`
    : "";

  return `${base}${suffixPart}.${extension}`;
}

export interface VideoMetadata {
  width: number;
  height: number;
  durationMs: number;
}

/**
 * Reads dimensions/duration from a video blob URL using a detached `<video>`.
 * Resolves `undefined` if the browser cannot decode the recording.
 */
export async function readVideoMetadata(
  objectUrl: string,
): Promise<VideoMetadata | undefined> {
  if (typeof document === "undefined") {
    return undefined;
  }

  const video = document.createElement("video");
  video.preload = "metadata";
  video.muted = true;
  video.src = objectUrl;

  try {
    return await new Promise<VideoMetadata | undefined>((resolve) => {
      const finish = (value: VideoMetadata | undefined): void => {
        video.removeAttribute("src");
        resolve(value);
      };

      const timeout = window.setTimeout(() => finish(undefined), 10_000);

      video.onloadedmetadata = () => {
        window.clearTimeout(timeout);
        finish({
          width: video.videoWidth,
          height: video.videoHeight,
          durationMs: Number.isFinite(video.duration) ? video.duration * 1000 : 0,
        });
      };
      video.onerror = () => {
        window.clearTimeout(timeout);
        finish(undefined);
      };
    });
  } catch {
    return undefined;
  }
}

/**
 * Grabs a frame from a `<video>` element as a small PNG thumbnail (history).
 * `atSeconds` defaults to the current playback position.
 */
export async function createVideoThumbnail(
  video: HTMLVideoElement,
  atSeconds = 0,
  maxEdge = 320,
): Promise<Blob | undefined> {
  if (typeof document === "undefined") {
    return undefined;
  }

  try {
    if (Number.isFinite(atSeconds) && Math.abs(video.currentTime - atSeconds) > 0.01) {
      video.currentTime = atSeconds;
      await new Promise<void>((resolve) => {
        const timeout = window.setTimeout(() => resolve(), 3000);
        video.onseeked = () => {
          window.clearTimeout(timeout);
          resolve();
        };
      });
    }

    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) {
      return undefined;
    }

    const scale = Math.min(1, maxEdge / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d");
    if (!context) {
      return undefined;
    }
    context.drawImage(video, 0, 0, canvas.width, canvas.height);

    return await new Promise<Blob | undefined>((resolve) => {
      canvas.toBlob((blob) => resolve(blob ?? undefined), "image/png");
    });
  } catch {
    return undefined;
  }
}
