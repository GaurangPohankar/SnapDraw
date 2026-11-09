/**
 * Screen-share recorder window ("Whole screen").
 *
 * Chrome's screen picker must be answered from a visible extension page, and the
 * page has to stay alive while recording. This window (created by the popup) is
 * that page: it opens Chrome's native picker immediately on load (no extra
 * confirmation click), records with MediaRecorder, saves the WebM locally and
 * asks the service worker to open the video editor.
 */
import "./recorder.css";
import { formatDuration, pickVideoMimeType } from "../services/video.service";
import { saveRecording } from "../services/recording.service";

const statusEl = document.getElementById("status") as HTMLElement;
const dotEl = document.getElementById("dot") as HTMLElement;
const statusTextEl = document.getElementById("status-text") as HTMLElement;
const timerEl = document.getElementById("timer") as HTMLElement;
const errorEl = document.getElementById("error") as HTMLElement;
const retryButton = document.getElementById("retry") as HTMLButtonElement;
const stopButton = document.getElementById("stop") as HTMLButtonElement;
const cancelButton = document.getElementById("cancel") as HTMLButtonElement;

const VIDEO_BITS_PER_SECOND = 4_000_000;
const TIMER_INTERVAL_MS = 250;

type StatusMode = "idle" | "recording" | "working";
type ControlsState = "picking" | "recording" | "finishing" | "error";

let recorder: MediaRecorder | null = null;
let stream: MediaStream | null = null;
let chunks: Blob[] = [];
let startedAt = 0;
let timerId: number | null = null;
let finishing = false;
let requesting = false;
let windowClosing = false;

function setStatus(text: string, mode: StatusMode): void {
  statusTextEl.textContent = text;
  statusEl.dataset.mode = mode;
  dotEl.classList.toggle("sd-rec__dot--live", mode === "recording");
  dotEl.classList.toggle("sd-rec__dot--working", mode === "working");
}

function showError(message: string | null): void {
  if (!message) {
    errorEl.hidden = true;
    errorEl.textContent = "";
    return;
  }
  errorEl.hidden = false;
  errorEl.textContent = message;
}

/**
 * Normal flow: no buttons while Chrome's picker is open; Stop/Cancel while
 * recording; only a failed start offers "Try again" (plus Cancel to close).
 */
function setControls(state: ControlsState): void {
  retryButton.hidden = state !== "error";
  stopButton.hidden = state !== "recording";
  cancelButton.hidden = state !== "error" && state !== "recording";
  retryButton.disabled = false;
  stopButton.disabled = state !== "recording";
  cancelButton.disabled = false;
}

function closeRecorderWindow(): void {
  if (windowClosing) {
    return;
  }
  windowClosing = true;
  window.close();
}

function startTimer(): void {
  timerEl.hidden = false;
  const tick = (): void => {
    timerEl.textContent = formatDuration(Date.now() - startedAt);
  };
  tick();
  timerId = window.setInterval(tick, TIMER_INTERVAL_MS);
}

function stopTimer(): void {
  if (timerId !== null) {
    window.clearInterval(timerId);
    timerId = null;
  }
  timerEl.hidden = true;
}

function stopTracks(target: MediaStream | null): void {
  if (!target) {
    return;
  }
  for (const track of target.getTracks()) {
    try {
      track.stop();
    } catch {
      // Already stopped.
    }
  }
}

async function readMetadata(blob: Blob): Promise<{
  width: number;
  height: number;
  durationMs: number;
}> {
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

function notifyServiceWorker(message: unknown): void {
  void chrome.runtime.sendMessage(message).catch(() => undefined);
}

async function finishRecording(discard: boolean): Promise<void> {
  if (finishing) {
    return;
  }
  finishing = true;
  setControls("finishing");
  setStatus(discard ? "Cancelling…" : "Saving recording…", "working");

  const activeRecorder = recorder;
  const activeStream = stream;
  const elapsed = startedAt > 0 ? Date.now() - startedAt : 0;

  try {
    if (activeRecorder && activeRecorder.state !== "inactive") {
      await new Promise<void>((resolve) => {
        activeRecorder.addEventListener("stop", () => resolve(), { once: true });
        activeRecorder.stop();
        window.setTimeout(resolve, 3000);
      });
    }
  } catch {
    // Recording already stopped.
  }

  stopTimer();
  stopTracks(activeStream);
  recorder = null;
  stream = null;

  const blob = new Blob(chunks, { type: chunks[0]?.type || "video/webm" });
  chunks = [];

  if (discard || blob.size === 0) {
    notifyServiceWorker({ target: "snapdraw-sw", type: "recording:cancelled" });
    closeRecorderWindow();
    return;
  }

  try {
    const metadata = await readMetadata(blob);
    const saved = await saveRecording({
      blob,
      width: metadata.width,
      height: metadata.height,
      durationMs: Math.max(metadata.durationMs, elapsed),
    });
    notifyServiceWorker({
      target: "snapdraw-sw",
      type: "recording:saved",
      sessionId: saved.id,
      name: saved.name,
    });
    closeRecorderWindow();
  } catch (error) {
    finishing = false;
    setControls("recording");
    setStatus("Recording", "recording");
    showError(
      `Couldn't save the recording: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function isPickerCancelled(error: unknown): boolean {
  return error instanceof DOMException && error.name === "NotAllowedError";
}

/**
 * Existing capture path: ask for audio first, then fall back to video-only. A
 * NotAllowedError means the user dismissed Chrome's picker (or capture is
 * blocked), which callers treat as a quiet cancel.
 */
async function requestDisplayStream(): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 30 },
      audio: true,
    });
  } catch (audioError) {
    if (isPickerCancelled(audioError)) {
      throw audioError;
    }
    return await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 30 },
      audio: false,
    });
  }
}

function showStartFailure(message: string): void {
  setControls("error");
  setStatus("Screen sharing didn't start", "idle");
  showError(message);
}

/**
 * Opens Chrome's picker immediately and starts recording once it is answered.
 * Safe to call again from "Try again" after a failure.
 */
async function requestRecording(): Promise<void> {
  if (requesting || finishing || recorder) {
    return;
  }
  requesting = true;
  showError(null);
  setControls("picking");
  setStatus("Opening Chrome's picker…", "working");

  // Chrome presents the display picker for a focused, visible extension window.
  // The popup creates this window focused, but focus can be stolen during boot.
  try {
    window.focus();
  } catch {
    // Best-effort only.
  }

  let displayStream: MediaStream;
  try {
    displayStream = await requestDisplayStream();
  } catch (error) {
    requesting = false;
    if (isPickerCancelled(error)) {
      // The user cancelled Chrome's picker: close quietly instead of leaving a
      // dead recorder window behind.
      closeRecorderWindow();
      return;
    }
    showStartFailure(
      `Chrome couldn't start screen sharing: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return;
  }

  requesting = false;

  if (windowClosing) {
    stopTracks(displayStream);
    return;
  }

  try {
    const mimeType = pickVideoMimeType();
    const mediaRecorder = new MediaRecorder(displayStream, {
      ...(mimeType ? { mimeType } : {}),
      videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
    });
    chunks = [];
    mediaRecorder.ondataavailable = (event: BlobEvent) => {
      if (event.data.size > 0) {
        chunks.push(event.data);
      }
    };
    mediaRecorder.start(250);

    stream = displayStream;
    recorder = mediaRecorder;
    startedAt = Date.now();
    setControls("recording");
    setStatus("Recording your screen", "recording");
    startTimer();
    notifyServiceWorker({
      target: "snapdraw-sw",
      type: "recording:started",
      source: "desktop",
    });

    displayStream.getVideoTracks()[0]?.addEventListener("ended", () => {
      if (recorder) {
        void finishRecording(false);
      }
    });
  } catch (error) {
    stopTracks(displayStream);
    showStartFailure(
      `Couldn't start recording: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

retryButton.addEventListener("click", () => {
  void requestRecording();
});
stopButton.addEventListener("click", () => {
  void finishRecording(false);
});
cancelButton.addEventListener("click", () => {
  void finishRecording(true);
});

window.addEventListener("beforeunload", (event) => {
  if (recorder) {
    event.preventDefault();
    event.returnValue = "";
  }
});

// Open Chrome's screen picker as soon as the window loads: there is no
// confirmation step, so the first thing the user sees is Chrome's picker.
void requestRecording();
