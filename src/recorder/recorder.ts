/**
 * Screen-share recorder window ("Whole screen").
 *
 * Chrome's screen picker must be answered from a visible extension page, and the
 * page has to stay alive while recording. This window (created by the popup) is
 * that page: it calls `getDisplayMedia()`, records with MediaRecorder, saves the
 * WebM locally and asks the service worker to open the video editor.
 */
import "./recorder.css";
import { formatDuration, pickVideoMimeType } from "../services/video.service";
import { saveRecording } from "../services/recording.service";

const statusEl = document.getElementById("status") as HTMLElement;
const dotEl = document.getElementById("dot") as HTMLElement;
const statusTextEl = document.getElementById("status-text") as HTMLElement;
const timerEl = document.getElementById("timer") as HTMLElement;
const errorEl = document.getElementById("error") as HTMLElement;
const startButton = document.getElementById("start") as HTMLButtonElement;
const stopButton = document.getElementById("stop") as HTMLButtonElement;
const cancelButton = document.getElementById("cancel") as HTMLButtonElement;

const VIDEO_BITS_PER_SECOND = 4_000_000;
const TIMER_INTERVAL_MS = 250;

let recorder: MediaRecorder | null = null;
let stream: MediaStream | null = null;
let chunks: Blob[] = [];
let startedAt = 0;
let timerId: number | null = null;
let finishing = false;

function setStatus(text: string, mode: "idle" | "recording" | "working"): void {
  statusTextEl.textContent = text;
  statusEl.dataset.mode = mode;
  dotEl.classList.toggle("sd-rec__dot--live", mode === "recording");
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

function setButtons(recording: boolean, busy = false): void {
  startButton.hidden = recording || busy;
  stopButton.hidden = !recording;
  cancelButton.hidden = !recording;
  startButton.disabled = busy;
  stopButton.disabled = busy;
  cancelButton.disabled = busy;
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
  setButtons(false, true);
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
    window.close();
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
    window.close();
  } catch (error) {
    finishing = false;
    setButtons(true);
    setStatus("Recording", "recording");
    showError(
      `Couldn't save the recording: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function startRecording(): Promise<void> {
  if (recorder) {
    return;
  }
  showError(null);
  startButton.disabled = true;
  setStatus("Choose a screen or window to share…", "working");

  let displayStream: MediaStream;
  try {
    displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 30 },
      audio: true,
    });
  } catch (audioError) {
    if (audioError instanceof DOMException && audioError.name === "NotAllowedError") {
      // Picker cancelled/denied.
      startButton.disabled = false;
      setStatus("Ready to record", "idle");
      return;
    }
    try {
      displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 30 },
        audio: false,
      });
    } catch (error) {
      startButton.disabled = false;
      setStatus("Ready to record", "idle");
      showError(
        error instanceof DOMException && error.name === "NotAllowedError"
          ? "Screen sharing was cancelled."
          : `Chrome couldn't start screen sharing: ${
              error instanceof Error ? error.message : String(error)
            }`,
      );
      return;
    }
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
    setButtons(true);
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
    startButton.disabled = false;
    setStatus("Ready to record", "idle");
    showError(
      `Couldn't start recording: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

startButton.addEventListener("click", () => {
  void startRecording();
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
