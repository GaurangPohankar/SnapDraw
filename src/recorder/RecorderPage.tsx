import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../components/Button";
import { Logo } from "../components/Logo";
import { recorderMimeType, saveRecording } from "../services/recording.service";
import { formatDuration, readVideoMetadata } from "../services/video.service";
import { buildVideoEditorUrl, readRecorderParams } from "../utils/messaging";

type RecorderStatus = "starting" | "recording" | "saving" | "opened" | "error";

interface RecorderProblem {
  title: string;
  message: string;
  hint?: string;
  canRetry?: boolean;
}

const TIMER_INTERVAL_MS = 250;
/** Tab recordings are re-encoded in memory; keep the bitrate reasonable. */
const VIDEO_BITS_PER_SECOND = 4_000_000;

function describeError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return "Something unexpected happened.";
}

/** Opens the tab-capture stream handed over by the popup. */
async function openTabCaptureStream(streamId: string): Promise<MediaStream> {
  if (
    typeof navigator === "undefined" ||
    typeof navigator.mediaDevices?.getUserMedia !== "function"
  ) {
    throw new Error("This browser does not expose tab capture.");
  }

  const video = {
    mandatory: {
      chromeMediaSource: "tab",
      chromeMediaSourceId: streamId,
    },
  } as unknown as MediaTrackConstraints;

  try {
    return await navigator.mediaDevices.getUserMedia({ audio: true, video });
  } catch {
    // Some tabs have no audio track (or the codec is unavailable): record
    // video-only rather than failing the whole recording.
    return await navigator.mediaDevices.getUserMedia({ audio: false, video });
  }
}

/**
 * Recorder tab.
 *
 * The popup obtains a tab-capture stream id with the user gesture and opens this
 * page. Here the stream is consumed with `getUserMedia`, recorded with
 * MediaRecorder, saved to IndexedDB, and the tab is then replaced by the video
 * editor. The original tab can keep being used; recording continues while this
 * tab stays open.
 */
export function RecorderPage() {
  const [{ streamId, tabId }] = useState(() => readRecorderParams());

  const [status, setStatus] = useState<RecorderStatus>("starting");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [problem, setProblem] = useState<RecorderProblem | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef<number>(0);
  const timerRef = useRef<number | null>(null);
  const finalisingRef = useRef(false);
  const discardRef = useRef(false);

  const clearTimer = useCallback((): void => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const stopStream = useCallback((): void => {
    const stream = streamRef.current;
    streamRef.current = null;
    if (stream) {
      for (const track of stream.getTracks()) {
        try {
          track.stop();
        } catch {
          // Already ended.
        }
      }
    }
  }, []);

  const finalise = useCallback(async (): Promise<void> => {
    if (finalisingRef.current) {
      return;
    }
    finalisingRef.current = true;
    clearTimer();

    try {
      const blob = new Blob(chunksRef.current, {
        type: chunksRef.current[0]?.type || "video/webm",
      });
      chunksRef.current = [];
      stopStream();

      if (blob.size === 0) {
        throw new Error("The recording is empty.");
      }

      if (discardRef.current) {
        window.close();
        return;
      }

      const objectUrl = URL.createObjectURL(blob);
      let metadata: Awaited<ReturnType<typeof readVideoMetadata>>;
      try {
        metadata = await readVideoMetadata(objectUrl);
      } finally {
        URL.revokeObjectURL(objectUrl);
      }

      const durationMs = Math.max(
        metadata?.durationMs ?? 0,
        startedAtRef.current ? Date.now() - startedAtRef.current : 0,
      );
      const saved = await saveRecording({
        blob,
        width: metadata?.width ?? 1280,
        height: metadata?.height ?? 720,
        durationMs,
      });

      setStatus("opened");
      window.location.replace(buildVideoEditorUrl(saved.id));
    } catch (error) {
      setStatus("error");
      setProblem({
        title: "Couldn't save the recording",
        message: describeError(error),
        hint: "Check that Chrome has enough disk space, then record again from the toolbar icon.",
      });
    } finally {
      finalisingRef.current = false;
    }
  }, [clearTimer, stopStream]);

  const start = useCallback(async (): Promise<void> => {
    if (!streamId) {
      setStatus("error");
      setProblem({
        title: "This recorder link is invalid",
        message: "The capture stream was not handed over to this tab.",
        hint: "Close this tab and start a recording from the SnapDraw toolbar icon.",
      });
      return;
    }

    if (streamRef.current) {
      return;
    }

    setStatus("starting");
    setProblem(null);
    setElapsedMs(0);

    try {
      const stream = await openTabCaptureStream(streamId);
      streamRef.current = stream;

      const mimeType = recorderMimeType();
      if (!mimeType) {
        throw new Error("This browser cannot record WebM video.");
      }

      const recorder = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
      });
      recorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };
      recorder.onstop = () => {
        void finalise();
      };
      recorder.onerror = () => {
        setStatus("error");
        setProblem({
          title: "Recording stopped unexpectedly",
          message: "Chrome could not continue capturing this tab.",
          hint: "Close this tab and start a new recording from the toolbar icon.",
        });
      };

      // If Chrome ends the capture (e.g. the user stops sharing), finalise what
      // has been recorded so far instead of losing it silently.
      for (const track of stream.getTracks()) {
        track.addEventListener("ended", () => {
          const active = recorderRef.current;
          if (active && active.state !== "inactive") {
            active.stop();
          }
        });
      }

      startedAtRef.current = Date.now();
      recorder.start(250);
      setStatus("recording");
      timerRef.current = window.setInterval(() => {
        if (startedAtRef.current) {
          setElapsedMs(Date.now() - startedAtRef.current);
        }
      }, TIMER_INTERVAL_MS);
    } catch (error) {
      stopStream();
      setStatus("error");
      setProblem({
        title: "SnapDraw couldn't start recording",
        message: describeError(error),
        hint: "Make sure the tab is a normal website (not chrome:// or the Web Store), then start again from the toolbar icon.",
        canRetry: true,
      });
    }
  }, [streamId, finalise, stopStream]);

  const stop = useCallback((): void => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") {
      return;
    }
    setStatus("saving");
    recorder.stop();
  }, []);

  const cancel = useCallback((): void => {
    discardRef.current = true;
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
      return;
    }
    stopStream();
    window.close();
  }, [stopStream]);

  useEffect(() => {
    void start();
  }, [start]);

  useEffect(() => {
    if (status !== "recording" && status !== "saving") {
      return undefined;
    }

    const warnBeforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = "";
    };

    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [status]);

  // Stop the capture if the tab is closed/navigated away programmatically.
  useEffect(() => {
    return () => {
      clearTimer();
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        recorder.onstop = null;
        try {
          recorder.stop();
        } catch {
          // Already stopped.
        }
      }
      stopStream();
    };
  }, [clearTimer, stopStream]);

  const canRecord = status === "recording";
  const busy = status === "starting" || status === "saving" || status === "opened";

  return (
    <div className="sd-recorder">
      <header className="sd-recorder__header">
        <Logo size={30} withWordmark />
        <span className="sd-recorder__badge">Recorder</span>
      </header>

      <main className="sd-recorder__main">
        {status === "error" && problem ? (
          <section className="sd-recorder__card" role="alert">
            <span className="sd-recorder__card-icon" aria-hidden="true">
              !
            </span>
            <h1 className="sd-recorder__title">{problem.title}</h1>
            <p className="sd-recorder__text">{problem.message}</p>
            {problem.hint ? <p className="sd-recorder__hint">{problem.hint}</p> : null}
            <div className="sd-recorder__actions">
              {problem.canRetry ? (
                <Button variant="primary" onClick={() => void start()}>
                  Try again
                </Button>
              ) : null}
              <Button variant="secondary" onClick={() => window.close()}>
                Close tab
              </Button>
            </div>
          </section>
        ) : (
          <section className="sd-recorder__card">
            <div className="sd-recorder__status">
              <span
                className={
                  canRecord
                    ? "sd-recorder__dot sd-recorder__dot--live"
                    : "sd-recorder__dot"
                }
                aria-hidden="true"
              />
              <span className="sd-recorder__status-label">
                {status === "recording"
                  ? "Recording this tab"
                  : status === "starting"
                    ? "Preparing recording…"
                    : status === "saving"
                      ? "Saving recording…"
                      : "Opening the video editor…"}
              </span>
              <span className="sd-recorder__timer" aria-live="off">
                {formatDuration(elapsedMs)}
              </span>
            </div>

            <p className="sd-recorder__text">
              {canRecord
                ? "You can switch tabs while recording — the capture keeps running. Keep this tab open until you stop."
                : busy
                  ? "Hang tight while SnapDraw prepares the recording."
                  : "Starting the tab capture…"}
            </p>

            {tabId !== null ? (
              <p className="sd-recorder__hint">Recording tab #{tabId}</p>
            ) : null}

            <div className="sd-recorder__actions">
              {status === "recording" ? (
                <Button variant="primary" onClick={stop} autoFocus>
                  Stop and open editor
                </Button>
              ) : null}
              {status === "recording" || status === "starting" ? (
                <Button variant="ghost" onClick={cancel}>
                  Cancel
                </Button>
              ) : null}
            </div>
          </section>
        )}
      </main>

      <footer className="sd-recorder__footer">
        Runs locally · the recording stays on this device
      </footer>
    </div>
  );
}
