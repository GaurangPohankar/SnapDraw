/**
 * Annotated video export.
 *
 * The recorder leaves an ordinary WebM blob in IndexedDB; this module turns
 * "recording + Excalidraw annotations" into a new local WebM file (or a PNG
 * still). Everything runs in the page and stays local: the current video frame
 * is painted onto an offscreen canvas, the Excalidraw static canvas is
 * composited on top, and `MediaRecorder` captures that canvas (plus the
 * recording's own audio when Web Audio can route it) in real time.
 *
 * No network, no server and no extra permissions are involved.
 */
import { pickVideoMimeType } from "./video.service";

/** Progress callback payload. `ratio` is always clamped to `0…1`. */
export type VideoExportProgress = { ratio: number };

/** Stable, machine readable export failure codes used to pick UI copy. */
export type VideoExportErrorCode =
  | "UNSUPPORTED"
  | "NOT_READY"
  | "PLAYBACK_BLOCKED"
  | "RENDER_FAILED"
  | "CANCELLED";

/** A typed, friendly export failure – raw DOM errors never reach the UI. */
export class VideoExportError extends Error {
  readonly code: VideoExportErrorCode;
  readonly hint?: string;

  constructor(code: VideoExportErrorCode, message: string, hint?: string) {
    super(message);
    this.name = "VideoExportError";
    this.code = code;
    this.hint = hint;
  }
}

/** True for the "user pressed Cancel" error so the UI can stay neutral. */
export function isVideoExportCancelled(error: unknown): boolean {
  return error instanceof VideoExportError && error.code === "CANCELLED";
}

export interface ExportAnnotatedVideoOptions {
  /** The recording that is currently displayed in the editor. */
  video: HTMLVideoElement;
  /**
   * Excalidraw's static canvas (`.excalidraw__canvas.static`). Its backing
   * store is sized to the displayed video rectangle × devicePixelRatio, so it
   * is stretched onto the intrinsic frame to keep annotations 1:1 with video.
   *
   * The canvas must not be visually restyled by CSS filters (Excalidraw inverts
   * its canvas in dark mode): canvas pixels are copied as-is, so the editor
   * disables the overlay's dark-mode filter to keep screen and export identical.
   */
  overlayCanvas: HTMLCanvasElement;
  /** Requested container/codec, e.g. from `pickVideoMimeType()`. */
  mimeType?: string;
  /**
   * Reports rendering progress in real time. `ratio` is clamped and reported in
   * 1% steps (plus a final `1`) so the UI isn't re-rendered on every frame.
   */
  onProgress?: (progress: VideoExportProgress) => void;
  /** Aborting rejects with a `CANCELLED` `VideoExportError`. */
  signal?: AbortSignal;
  /**
   * Recording length from the stored metadata. Used only for progress when the
   * element reports `duration === Infinity` (a known Chrome WebM quirk).
   */
  fallbackDurationMs?: number;
  /** Frames per second requested from `canvas.captureStream`. */
  frameRate?: number;
}

/** Recording framerate: smooth enough for screen content, cheap to encode. */
const DEFAULT_FRAME_RATE = 30;
/** Timeslice: chunk size for `MediaRecorder.start`, in milliseconds. */
const RECORDER_TIMESLICE_MS = 250;
/** `HTMLMediaElement.readyState` value for "a current frame is available". */
const HAVE_CURRENT_DATA = 2;
/** Only report progress when it moves by at least this much (1%). */
const PROGRESS_STEP = 0.01;
const MIN_VIDEO_BITRATE = 2_000_000;
const MAX_VIDEO_BITRATE = 12_000_000;
const AUDIO_BITRATE = 128_000;

// ---------------------------------------------------------------------------
// Frame rendering
// ---------------------------------------------------------------------------

/** Throws a friendly `NOT_READY` error when the element can't be painted. */
function resolveVideoSize(video: HTMLVideoElement): {
  width: number;
  height: number;
} {
  const width = Math.floor(video.videoWidth);
  const height = Math.floor(video.videoHeight);

  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new VideoExportError(
      "NOT_READY",
      "The recording isn't ready yet.",
      "Let the video finish loading, then try again.",
    );
  }

  if (video.readyState < HAVE_CURRENT_DATA) {
    throw new VideoExportError(
      "NOT_READY",
      "There isn't a decoded video frame to export yet.",
      "Press play for a moment so a frame is decoded, then try again.",
    );
  }

  return { width, height };
}

/**
 * Paints one composited frame: video first, annotations above it.
 *
 * The export canvas always uses the recording's intrinsic pixel size, so the
 * result keeps the capture's full resolution. The overlay canvas is drawn into
 * that same rectangle – its CSS size is irrelevant because it is already sized
 * to the displayed video rectangle (which is the same visual mapping).
 */
function drawAnnotatedFrame(
  context: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  overlayCanvas: HTMLCanvasElement,
  width: number,
  height: number,
): void {
  context.clearRect(0, 0, width, height);
  context.drawImage(video, 0, 0, width, height);

  if (overlayCanvas.width > 0 && overlayCanvas.height > 0) {
    context.drawImage(overlayCanvas, 0, 0, width, height);
  }
}

/**
 * Renders the current video frame plus the current annotations onto a new
 * canvas at the recording's intrinsic resolution.
 *
 * Used for "Copy frame"; the real-time video export reuses the drawing path
 * without allocating a canvas per frame.
 */
export function renderAnnotatedFrame(
  video: HTMLVideoElement,
  overlayCanvas: HTMLCanvasElement,
): HTMLCanvasElement {
  const { width, height } = resolveVideoSize(video);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d");
  if (!context) {
    throw new VideoExportError(
      "RENDER_FAILED",
      "The annotated frame couldn't be rendered.",
      "Try again, or download the original recording.",
    );
  }

  try {
    drawAnnotatedFrame(context, video, overlayCanvas, width, height);
  } catch {
    throw new VideoExportError(
      "RENDER_FAILED",
      "The video frame couldn't be copied to the canvas.",
      "Play the recording for a moment, then try again.",
    );
  }

  return canvas;
}

/** Encodes the current annotated frame as a PNG blob. */
export async function createAnnotatedFrameBlob(
  video: HTMLVideoElement,
  overlayCanvas: HTMLCanvasElement,
): Promise<Blob> {
  const canvas = renderAnnotatedFrame(video, overlayCanvas);

  return await new Promise<Blob>((resolve, reject) => {
    try {
      canvas.toBlob((blob) => {
        if (blob) {
          resolve(blob);
          return;
        }
        reject(
          new VideoExportError(
            "RENDER_FAILED",
            "The PNG frame couldn't be encoded.",
            "Try again, or download the original recording.",
          ),
        );
      }, "image/png");
    } catch {
      reject(
        new VideoExportError(
          "RENDER_FAILED",
          "The PNG frame couldn't be encoded.",
          "Try again, or download the original recording.",
        ),
      );
    }
  });
}

// ---------------------------------------------------------------------------
// Audio capture
// ---------------------------------------------------------------------------

interface AudioGraph {
  context: AudioContext;
  /** Reused across exports: one `MediaElementAudioSourceNode` per element. */
  source: MediaElementAudioSourceNode;
  /**
   * True while the element source is wired to the default output.
   *
   * `createMediaElementSource` permanently reroutes the element's audio into
   * the graph, so the source must be re-connected to `context.destination`
   * after every export – otherwise the recording would stay silent when the
   * user plays it normally.
   */
  speakerConnected: boolean;
}

interface AudioHandle {
  graph: AudioGraph;
  destination: MediaStreamAudioDestinationNode;
  tracks: MediaStreamTrack[];
}

type AudioContextConstructor = new () => AudioContext;

/**
 * Cached audio graphs.
 *
 * A `MediaElementAudioSourceNode` may only be created once per
 * `<video>` element, so closing the `AudioContext` after every export would
 * make the second export silently video-only. The graph is therefore reused for
 * the lifetime of the editor and explicitly released on unmount via
 * `disposeVideoExportAudio`.
 */
const audioGraphs = new WeakMap<HTMLVideoElement, AudioGraph>();

function getAudioContextConstructor(): AudioContextConstructor | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  const extendedWindow = window as Window & {
    webkitAudioContext?: AudioContextConstructor;
  };
  const constructor = window.AudioContext ?? extendedWindow.webkitAudioContext;
  return typeof constructor === "function" ? constructor : undefined;
}

function getOrCreateAudioGraph(video: HTMLVideoElement): AudioGraph {
  const cached = audioGraphs.get(video);
  if (cached && cached.context.state !== "closed") {
    return cached;
  }

  const AudioContextClass = getAudioContextConstructor();
  if (!AudioContextClass) {
    throw new Error("Web Audio is not available in this browser.");
  }

  const context = new AudioContextClass();
  const graph: AudioGraph = {
    context,
    source: context.createMediaElementSource(video),
    speakerConnected: false,
  };
  audioGraphs.set(video, graph);
  return graph;
}

/** Stops the element source from reaching the speakers (used while exporting). */
function disconnectSpeakers(graph: AudioGraph): void {
  if (!graph.speakerConnected) {
    return;
  }
  try {
    graph.source.disconnect(graph.context.destination);
  } catch {
    // Not connected (already detached).
  }
  graph.speakerConnected = false;
}

/**
 * Restores normal playback audio.
 *
 * The element's audio is already routed through the graph after the first
 * export, so it only reaches the speakers through this connection.
 */
function connectSpeakers(graph: AudioGraph): void {
  if (graph.speakerConnected || graph.context.state === "closed") {
    return;
  }
  try {
    graph.source.connect(graph.context.destination);
    graph.speakerConnected = true;
  } catch {
    // The context/graph is gone – nothing to restore.
  }
}

/**
 * Routes the recording's audio into a `MediaStreamAudioDestinationNode`.
 *
 * While the export runs the element source is only connected to the recorder,
 * never to `audioContext.destination`, so the render is silent through the
 * speakers while the exported file still contains the original audio. Any
 * failure (no Web Audio, blocked context, ...) simply degrades the export to
 * video-only and leaves normal playback untouched.
 */
function attachRecordingAudio(video: HTMLVideoElement): AudioHandle | null {
  let graph: AudioGraph | null = null;

  try {
    graph = getOrCreateAudioGraph(video);
    const destination = graph.context.createMediaStreamDestination();

    // Everything below this point either succeeds (audio captured, speakers
    // silent) or is rolled back so normal playback keeps its sound.
    disconnectSpeakers(graph);
    graph.source.connect(destination);

    // A context created from a click starts running; resume defensively for
    // early/late gestures. No await: a suspended graph only means silent audio.
    if (graph.context.state === "suspended") {
      void graph.context.resume().catch(() => undefined);
    }

    const tracks = destination.stream.getAudioTracks();
    if (tracks.length === 0) {
      graph.source.disconnect(destination);
      connectSpeakers(graph);
      return null;
    }

    return { graph, destination, tracks };
  } catch {
    if (graph) {
      // Never leave the element muted because of a partial audio setup.
      connectSpeakers(graph);
    }
    return null;
  }
}

function stopTrack(track: MediaStreamTrack): void {
  try {
    track.stop();
  } catch {
    // Already ended – nothing to stop.
  }
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    stopTrack(track);
  }
}

function detachAudio(handle: AudioHandle | null): void {
  if (!handle) {
    return;
  }
  try {
    handle.graph.source.disconnect(handle.destination);
  } catch {
    // Already disconnected.
  }
  try {
    handle.destination.disconnect();
  } catch {
    // Already disconnected.
  }
  for (const track of handle.tracks) {
    stopTrack(track);
  }

  // The element's audio is routed through the graph now, so hand it back to the
  // speakers – with one exception: a cancelled/failed export can leave the
  // graph mid-teardown, and `connectSpeakers` is a no-op then.
  connectSpeakers(handle.graph);
}

/**
 * Releases the cached audio graph for a video element.
 *
 * Call this when the editor unmounts: the `AudioContext` is intentionally kept
 * alive between exports (see `audioGraphs`), so this is the single cleanup
 * point that fully closes it.
 */
export async function disposeVideoExportAudio(video: HTMLVideoElement): Promise<void> {
  const graph = audioGraphs.get(video);
  if (!graph) {
    return;
  }
  audioGraphs.delete(video);

  try {
    graph.source.disconnect();
  } catch {
    // Already disconnected.
  }
  try {
    await graph.context.close();
  } catch {
    // Already closed.
  }
}

// ---------------------------------------------------------------------------
// MediaRecorder helpers
// ---------------------------------------------------------------------------

function resolveRecorderMimeType(requested?: string): string | undefined {
  const isSupported = (candidate: string): boolean => {
    if (typeof MediaRecorder === "undefined") {
      return false;
    }
    try {
      return MediaRecorder.isTypeSupported(candidate);
    } catch {
      return false;
    }
  };

  if (requested && isSupported(requested)) {
    return requested;
  }

  const fallback = pickVideoMimeType();
  return fallback && isSupported(fallback) ? fallback : undefined;
}

function resolveVideoBitrate(
  width: number,
  height: number,
  frameRate: number,
): number {
  const pixelsPerSecond = width * height * frameRate;
  return Math.round(
    Math.min(MAX_VIDEO_BITRATE, Math.max(MIN_VIDEO_BITRATE, pixelsPerSecond * 0.08)),
  );
}

/**
 * Creates the `MediaRecorder`.
 *
 * Some Chrome versions reject a mime type that asks for an audio codec when the
 * stream is video-only (no audio graph was available), so the recorder is
 * retried with the browser default before giving up.
 */
function createMediaRecorder(
  stream: MediaStream,
  mimeType: string | undefined,
  videoBitsPerSecond: number,
): MediaRecorder {
  if (mimeType) {
    try {
      return new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond,
        audioBitsPerSecond: AUDIO_BITRATE,
      });
    } catch {
      // Fall through to the browser default container/codec.
    }
  }
  return new MediaRecorder(stream, { videoBitsPerSecond });
}

/**
 * Best-effort duration in seconds.
 *
 * Chrome reports `Infinity` for many `MediaRecorder` WebM files until they have
 * been seeked, so the duration stored at recording time is used as a fallback.
 * (`ended` still fires when playback reaches the end of such files.)
 */
function resolveDurationSeconds(
  video: HTMLVideoElement,
  fallbackDurationMs?: number,
): number {
  if (Number.isFinite(video.duration) && video.duration > 0) {
    return video.duration;
  }
  if (
    fallbackDurationMs !== undefined &&
    Number.isFinite(fallbackDurationMs) &&
    fallbackDurationMs > 0
  ) {
    return fallbackDurationMs / 1000;
  }
  return 0;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

function createCancelledError(): VideoExportError {
  return new VideoExportError(
    "CANCELLED",
    "Video export was cancelled.",
    "Nothing was saved – your annotations are still here.",
  );
}

function toVideoExportError(
  error: unknown,
  message: string,
  hint: string,
): VideoExportError {
  if (error instanceof VideoExportError) {
    return error;
  }
  return new VideoExportError("RENDER_FAILED", message, hint);
}

function isCaptureStreamSupported(): boolean {
  return (
    typeof HTMLCanvasElement !== "undefined" &&
    typeof HTMLCanvasElement.prototype.captureStream === "function"
  );
}

// ---------------------------------------------------------------------------
// Real-time annotated video export
// ---------------------------------------------------------------------------

/**
 * Renders the annotated video in real time and resolves with the WebM blob.
 *
 * 1. A canvas at the recording's intrinsic size is captured at `frameRate`.
 * 2. The recording's audio is routed into the same `MediaStream` when possible.
 * 3. A `MediaRecorder` writes the combined stream.
 * 4. The video plays from the start while a `requestAnimationFrame` loop paints
 *    video + annotations into the canvas and reports progress.
 * 5. `video.onended` stops the recorder and the finished blob is resolved.
 *
 * Aborting (Cancel) stops everything and rejects with a `CANCELLED` error.
 * The video element's mute/volume/position/paused state is restored on every
 * exit path (success, failure or abort).
 */
export async function exportAnnotatedVideo({
  video,
  overlayCanvas,
  mimeType,
  onProgress,
  signal,
  fallbackDurationMs,
  frameRate = DEFAULT_FRAME_RATE,
}: ExportAnnotatedVideoOptions): Promise<Blob> {
  if (signal?.aborted) {
    throw createCancelledError();
  }

  if (typeof MediaRecorder === "undefined" || !isCaptureStreamSupported()) {
    throw new VideoExportError(
      "UNSUPPORTED",
      "This browser can't render annotated video.",
      "Use Download original recording instead, or update Chrome.",
    );
  }

  const { width, height } = resolveVideoSize(video);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d");
  if (!context) {
    throw new VideoExportError(
      "RENDER_FAILED",
      "The annotated video couldn't be rendered.",
      "Try again, or download the original recording.",
    );
  }

  // Canvas video track (+ the recording's audio when available).
  let canvasStream: MediaStream;
  try {
    canvasStream = canvas.captureStream(frameRate);
  } catch (error) {
    throw toVideoExportError(
      error,
      "The annotated video stream couldn't be created.",
      "Try again, or download the original recording.",
    );
  }

  const audioHandle = attachRecordingAudio(video);
  const audioTracks = audioHandle ? audioHandle.tracks : [];

  let recordStream: MediaStream;
  try {
    recordStream = new MediaStream([
      ...canvasStream.getVideoTracks(),
      ...audioTracks,
    ]);
  } catch (error) {
    stopTracks(canvasStream);
    detachAudio(audioHandle);
    throw toVideoExportError(
      error,
      "The annotated video stream couldn't be combined with the recording audio.",
      "Try again, or download the original recording.",
    );
  }

  const recorderMimeType = resolveRecorderMimeType(mimeType);
  const videoBitsPerSecond = resolveVideoBitrate(width, height, frameRate);

  let recorder: MediaRecorder;
  try {
    recorder = createMediaRecorder(recordStream, recorderMimeType, videoBitsPerSecond);
  } catch (error) {
    stopTracks(recordStream);
    stopTracks(canvasStream);
    detachAudio(audioHandle);
    throw toVideoExportError(
      error,
      "This browser couldn't start the annotated video recorder.",
      "Use Download original recording instead, or update Chrome.",
    );
  }

  const original = {
    muted: video.muted,
    volume: video.volume,
    currentTime: video.currentTime,
    paused: video.paused,
  };

  // Audio only reaches the element source when the element is unmuted, and the
  // graph is never connected to `audioContext.destination` – so the export
  // captures sound while the speakers stay silent. Without a usable audio graph
  // the element is muted so rendering never blasts audio at the user.
  video.muted = audioHandle === null;
  video.volume = 1;

  return await new Promise<Blob>((resolve, reject) => {
    let settled = false;
    let cleanedUp = false;
    let rafId = 0;
    const chunks: BlobPart[] = [];
    const totalSeconds = resolveDurationSeconds(video, fallbackDurationMs);
    let lastProgress = -1;

    const stopRecorder = (): void => {
      try {
        if (recorder.state !== "inactive") {
          recorder.stop();
        }
      } catch {
        // Recorder already stopping/stopped.
      }
    };

    const restoreVideo = (): void => {
      try {
        video.pause();
        video.muted = original.muted;
        video.volume = original.volume;
        if (Number.isFinite(original.currentTime)) {
          video.currentTime = original.currentTime;
        }
        if (!original.paused) {
          void video.play().catch(() => undefined);
        }
      } catch {
        // Best effort – the element may already be torn down.
      }
    };

    const cleanup = (): void => {
      if (cleanedUp) {
        return;
      }
      cleanedUp = true;

      if (rafId !== 0) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
      signal?.removeEventListener("abort", handleAbort);
      video.removeEventListener("ended", handleEnded);
      video.removeEventListener("error", handleVideoError);

      stopTracks(recordStream);
      stopTracks(canvasStream);
      // Pause/restore the element before handing its audio back to the
      // speakers, so the last rendered frames never leak sound.
      restoreVideo();
      detachAudio(audioHandle);
    };

    const fail = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      stopRecorder();
      cleanup();
      reject(error);
    };

    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      onProgress?.({ ratio: 1 });

      const type = recorder.mimeType || recorderMimeType || "video/webm";
      resolve(new Blob(chunks, { type }));
    };

    const handleAbort = (): void => {
      fail(createCancelledError());
    };
    const handleEnded = (): void => {
      stopRecorder();
    };
    const handleVideoError = (): void => {
      fail(
        new VideoExportError(
          "PLAYBACK_BLOCKED",
          "The recording stopped playing during the export.",
          "Try again, or download the original recording.",
        ),
      );
    };

    /** Paints one frame, reports progress and watches for the natural end. */
    const drawLoop = (): void => {
      if (settled) {
        return;
      }

      if (video.readyState >= HAVE_CURRENT_DATA) {
        try {
          drawAnnotatedFrame(context, video, overlayCanvas, width, height);
        } catch {
          // Keep the previous good frame instead of aborting the render.
        }
      }

      if (totalSeconds > 0) {
        const ratio = clamp01(video.currentTime / totalSeconds);
        // Keep React renders cheap: only report 1% steps (plus the final 100%).
        if (ratio - lastProgress >= PROGRESS_STEP || (ratio >= 1 && lastProgress < 1)) {
          lastProgress = ratio;
          onProgress?.({ ratio });
        }
      }

      if (video.ended) {
        stopRecorder();
        return;
      }

      rafId = requestAnimationFrame(drawLoop);
    };

    recorder.ondataavailable = (event: BlobEvent): void => {
      if (event.data && event.data.size > 0) {
        chunks.push(event.data);
      }
    };

    recorder.onerror = (event: ErrorEvent): void => {
      const detail: unknown = event.error;
      fail(
        toVideoExportError(
          detail,
          "The annotated video could not be recorded.",
          "Try again, or download the original recording.",
        ),
      );
    };

    recorder.onstop = (): void => {
      finish();
    };

    signal?.addEventListener("abort", handleAbort, { once: true });
    video.addEventListener("ended", handleEnded);
    video.addEventListener("error", handleVideoError);

    // `signal` may have been aborted between the entry check and the listener
    // registration above; `abort` would not fire in that window.
    if (signal?.aborted) {
      handleAbort();
      return;
    }

    const start = async (): Promise<void> => {
      try {
        recorder.start(RECORDER_TIMESLICE_MS);
      } catch (error) {
        fail(
          toVideoExportError(
            error,
            "The annotated video recorder could not start.",
            "Try again, or download the original recording.",
          ),
        );
        return;
      }

      // Playing from the beginning is what makes the export deterministic.
      // `play()` runs inside the user's click gesture, so unmuted playback
      // (needed for audio capture) is allowed.
      try {
        video.currentTime = 0;
      } catch {
        // A not-yet-seekable recording exports from wherever it starts.
      }

      try {
        await video.play();
      } catch {
        fail(
          new VideoExportError(
            "PLAYBACK_BLOCKED",
            "Chrome blocked playback while rendering the video.",
            "Click anywhere on the page, then try again.",
          ),
        );
        return;
      }

      if (settled) {
        return;
      }
      onProgress?.({ ratio: 0 });
      rafId = requestAnimationFrame(drawLoop);
    };

    void start();
  });
}
