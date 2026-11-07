/**
 * Custom playback controls for the recording.
 *
 * The native `controls` attribute is intentionally not used: the transport bar
 * is SnapDraw's own UI, styled with the `--sd-*` tokens, and it keeps working
 * while the Excalidraw overlay sits above the video.
 */
import { useCallback, useEffect, useState } from "react";
import type { ChangeEvent, RefObject } from "react";
import { Button } from "../components/Button";
import { formatDuration } from "../services/video.service";
import { PauseIcon, PlayIcon, VolumeIcon, VolumeMutedIcon } from "./icons";

export interface TransportBarProps {
  videoRef: RefObject<HTMLVideoElement>;
  /**
   * Duration from the stored recording metadata. Used when the element reports
   * `Infinity` (Chrome's MediaRecorder WebM quirk) or before metadata loads.
   */
  durationMs: number;
}

const PLAYBACK_EVENTS = [
  "timeupdate",
  "loadedmetadata",
  "durationchange",
  "play",
  "pause",
  "volumechange",
  "seeked",
  "emptied",
] as const;

export function TransportBar({ videoRef, durationMs }: TransportBarProps) {
  const [currentSeconds, setCurrentSeconds] = useState(0);
  const [elementDuration, setElementDuration] = useState(0);
  const [paused, setPaused] = useState(true);
  const [muted, setMuted] = useState(false);

  // Mirror the element's playback state; the element owns the truth, this bar
  // is just a view of it (the export code also drives the same element).
  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return undefined;
    }

    const sync = (): void => {
      setCurrentSeconds(Number.isFinite(video.currentTime) ? video.currentTime : 0);
      setElementDuration(
        Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0,
      );
      setPaused(video.paused);
      setMuted(video.muted);
    };

    sync();
    for (const eventName of PLAYBACK_EVENTS) {
      video.addEventListener(eventName, sync);
    }
    return () => {
      for (const eventName of PLAYBACK_EVENTS) {
        video.removeEventListener(eventName, sync);
      }
    };
  }, [videoRef, durationMs]);

  const fallbackSeconds = durationMs > 0 ? durationMs / 1000 : 0;
  const totalSeconds = elementDuration > 0 ? elementDuration : fallbackSeconds;
  const totalMs = totalSeconds > 0 ? totalSeconds * 1000 : durationMs;
  const currentMs = currentSeconds * 1000;
  const seekable = totalSeconds > 0;

  const togglePlayback = useCallback((): void => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    if (video.paused) {
      void video.play().catch(() => undefined);
      return;
    }
    video.pause();
  }, [videoRef]);

  const toggleMuted = useCallback((): void => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    video.muted = !video.muted;
  }, [videoRef]);

  const handleSeek = useCallback(
    (event: ChangeEvent<HTMLInputElement>): void => {
      const video = videoRef.current;
      if (!video) {
        return;
      }
      const nextTime = Number(event.target.value);
      if (!Number.isFinite(nextTime)) {
        return;
      }
      try {
        video.currentTime = nextTime;
      } catch {
        // A not-yet-seekable recording keeps its position; the sync effect will
        // put the slider back where the element actually is.
      }
    },
    [videoRef],
  );

  return (
    <div className="sd-video__transport" role="toolbar" aria-label="Playback controls">
      <Button
        variant="icon"
        size="sm"
        aria-label={paused ? "Play" : "Pause"}
        title={paused ? "Play the recording" : "Pause the recording"}
        onClick={togglePlayback}
        className="sd-video__transport-play"
      >
        {paused ? <PlayIcon size={17} /> : <PauseIcon size={17} />}
      </Button>

      <span className="sd-video__time" aria-live="off">
        {formatDuration(currentMs)} / {formatDuration(totalMs)}
      </span>

      <input
        type="range"
        className="sd-video__seek"
        aria-label="Seek"
        min={0}
        max={seekable ? totalSeconds : 0.01}
        step={0.05}
        value={Math.min(currentSeconds, seekable ? totalSeconds : 0.01)}
        disabled={!seekable}
        onChange={handleSeek}
      />

      <Button
        variant="icon"
        size="sm"
        aria-label={muted ? "Unmute" : "Mute"}
        aria-pressed={muted}
        title={muted ? "Unmute the recording" : "Mute the recording"}
        onClick={toggleMuted}
      >
        {muted ? <VolumeMutedIcon size={17} /> : <VolumeIcon size={17} />}
      </Button>

      <span className="sd-video__hint">Annotations cover the whole recording</span>
    </div>
  );
}
