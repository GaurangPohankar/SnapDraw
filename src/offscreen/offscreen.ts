/**
 * Offscreen recorder document.
 *
 * MV3 service workers cannot own a MediaRecorder, and the popup closes as soon
 * as it loses focus, so the recording lives here. The popup asks the service
 * worker to start/stop/query; the worker relays typed commands to this document.
 *
 * Local only: the stream comes from `chrome.tabCapture` / `chrome.desktopCapture`
 * and the finished WebM is written to the extension's IndexedDB.
 */
import type {
  OffscreenCommand,
  OffscreenStartResult,
  OffscreenStatusResult,
  OffscreenStopResult,
  RecordingSavedEvent,
  RecordingSource,
} from "../types";
import { OFFSCREEN_TARGET } from "../types";
import { saveRecording } from "../services/recording.service";
import { pickVideoMimeType } from "../services/video.service";

const VIDEO_BITS_PER_SECOND = 4_000_000;

interface ActiveRecording {
  recorder: MediaRecorder;
  stream: MediaStream;
  chunks: Blob[];
  source: RecordingSource;
  startedAt: number;
}

let active: ActiveRecording | null = null;
let callerStopPending = false;
let finalising: Promise<OffscreenStopResult> | null = null;
let lastResult: OffscreenStopResult | null = null;

function describeError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return "SnapDraw couldn't record this source.";
}

/** Rejects a capture request that Chrome never answers (invalid/expired stream). */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function statusResult(): OffscreenStatusResult {
  if (!active) {
    return { ok: true, recording: false, startedAt: null, source: null };
  }
  return {
    ok: true,
    recording: active.recorder.state === "recording",
    startedAt: active.startedAt,
    source: active.source,
  };
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // Already stopped.
    }
  }
}

/** Tab-capture constraints for the offscreen recorder (tab source only). */
async function openCaptureStream(
  streamId: string,
  source: RecordingSource,
): Promise<MediaStream> {
  if (source !== "tab") {
    throw new Error("Screen recording uses the visible screen-share window.");
  }

  const video = {
    mandatory: {
      chromeMediaSource: "tab",
      chromeMediaSourceId: streamId,
    },
  } as unknown as MediaTrackConstraints;

  // Important: request tab audio with explicit `chromeMediaSource` constraints.
  // A bare `audio: true` makes Chrome try to show a microphone-style permission
  // prompt that an offscreen document cannot display, which crashes the
  // extension renderer ("SnapDraw has crashed"). Explicit constraints capture
  // the tab's audio without any prompt.
  const audio = {
    mandatory: {
      chromeMediaSource: "tab",
      chromeMediaSourceId: streamId,
    },
  } as unknown as MediaTrackConstraints;

  try {
    return await navigator.mediaDevices.getUserMedia({ audio, video });
  } catch {
    // Tabs without an audio track record video-only.
    return navigator.mediaDevices.getUserMedia({ audio: false, video });
  }
}

/** Reads duration/dimensions from the recorded blob (Chrome may report Infinity). */
async function readMetadata(
  blob: Blob,
): Promise<{ width: number; height: number; durationMs: number }> {
  const objectUrl = URL.createObjectURL(blob);
  const video = document.createElement("video");
  video.preload = "metadata";
  video.muted = true;
  video.src = objectUrl;

  try {
    await new Promise<void>((resolve) => {
      const timeout = window.setTimeout(resolve, 5000);
      video.onloadedmetadata = () => {
        window.clearTimeout(timeout);
        resolve();
      };
      video.onerror = () => {
        window.clearTimeout(timeout);
        resolve();
      };
    });

    return {
      width: video.videoWidth || 1280,
      height: video.videoHeight || 720,
      durationMs:
        Number.isFinite(video.duration) && video.duration > 0
          ? video.duration * 1000
          : 0,
    };
  } finally {
    video.removeAttribute("src");
    URL.revokeObjectURL(objectUrl);
  }
}

/** Saves or discards the current recording and cleans everything up. */
async function finaliseRecording(discard: boolean): Promise<OffscreenStopResult> {
  if (finalising) {
    return finalising;
  }

  const recording = active;
  if (!recording) {
    return { ok: true, discarded: discard };
  }

  finalising = (async (): Promise<OffscreenStopResult> => {
    try {
      const elapsedMs = Date.now() - recording.startedAt;
      const blob = new Blob(recording.chunks, {
        type: recording.chunks[0]?.type || "video/webm",
      });
      recording.chunks = [];
      stopTracks(recording.stream);
      active = null;

      if (blob.size === 0 || discard) {
        lastResult = { ok: true, discarded: true };
        return lastResult;
      }

      const metadata = await readMetadata(blob);
      const saved = await saveRecording({
        blob,
        width: metadata.width,
        height: metadata.height,
        durationMs: Math.max(metadata.durationMs, elapsedMs),
      });
      lastResult = {
        ok: true,
        sessionId: saved.id,
        name: saved.name,
        discarded: false,
      };
      return lastResult;
    } catch (error) {
      lastResult = { ok: false, message: describeError(error) };
      return lastResult;
    } finally {
      finalising = null;
    }
  })();

  return finalising;
}

/** Finishes a recording whose stream ended on its own (tab closed / share stopped). */
async function handleUnexpectedEnd(): Promise<void> {
  if (!active || callerStopPending) {
    return;
  }
  const result = await finaliseRecording(false);
  if (result.ok && result.sessionId && result.name) {
    const event: RecordingSavedEvent = {
      target: "snapdraw-sw",
      type: "recording:saved",
      sessionId: result.sessionId,
      name: result.name,
    };
    void chrome.runtime.sendMessage(event).catch(() => undefined);
  }
}

async function startRecording(
  streamId: string,
  source: RecordingSource,
): Promise<OffscreenStartResult> {
  if (active) {
    return { ok: false, message: "A recording is already in progress." };
  }

  try {
    const stream = await withTimeout(
      openCaptureStream(streamId, source),
      5_000,
      "Chrome didn't provide a recording stream. Try again.",
    );
    const mimeType = pickVideoMimeType();
    const recorder = new MediaRecorder(stream, {
      ...(mimeType ? { mimeType } : {}),
      videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
    });
    const chunks: Blob[] = [];

    recorder.ondataavailable = (event: BlobEvent) => {
      if (event.data.size > 0) {
        chunks.push(event.data);
      }
    };
    recorder.onstop = () => {
      if (!callerStopPending) {
        void handleUnexpectedEnd();
      }
    };
    recorder.onerror = () => {
      void handleUnexpectedEnd();
    };

    for (const track of stream.getTracks()) {
      track.addEventListener("ended", () => {
        if (active && active.recorder.state !== "inactive") {
          active.recorder.stop();
        }
      });
    }

    const startedAt = Date.now();
    active = { recorder, stream, chunks, source, startedAt };
    callerStopPending = false;
    lastResult = null;
    recorder.start(250);

    return { ok: true, startedAt, source };
  } catch (error) {
    return { ok: false, message: describeError(error) };
  }
}

async function stopRecording(discard: boolean): Promise<OffscreenStopResult> {
  const recording = active;
  if (!recording) {
    if (lastResult) {
      return lastResult;
    }
    return { ok: true, discarded: true };
  }

  callerStopPending = true;
  const stopped = new Promise<void>((resolve) => {
    recording.recorder.onstop = () => resolve();
  });

  try {
    recording.recorder.stop();
  } catch {
    // Already stopping/stopped.
  }

  await Promise.race([
    stopped,
    new Promise<void>((resolve) => window.setTimeout(resolve, 5000)),
  ]);

  const result = await finaliseRecording(discard);
  callerStopPending = false;
  return result;
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (
    typeof message !== "object" ||
    message === null ||
    (message as { target?: unknown }).target !== OFFSCREEN_TARGET
  ) {
    return undefined;
  }

  const command = message as OffscreenCommand;

  if (command.type === "offscreen:start") {
    void startRecording(command.streamId, command.source).then(sendResponse);
    return true;
  }
  if (command.type === "offscreen:stop") {
    void stopRecording(Boolean(command.discard)).then(sendResponse);
    return true;
  }
  if (command.type === "offscreen:status") {
    sendResponse(statusResult());
    return true;
  }

  return undefined;
});
