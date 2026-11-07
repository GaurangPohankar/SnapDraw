/**
 * Icons owned by the video editor.
 *
 * The shared editor icons (`src/editor/icons.tsx`) cover the actions both tabs
 * share (copy, download, trash, info, …). Playback, mute and overflow marks are
 * video-specific, so they live here and leave the shared set untouched.
 */
import type { ReactNode } from "react";

export interface VideoIconProps {
  size?: number;
  className?: string;
}

interface IconShellProps extends VideoIconProps {
  children: ReactNode;
}

/** Shared 16px stroke icon shell – every video icon inherits `currentColor`. */
function IconShell({ size = 16, className, children }: IconShellProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function PlayIcon(props: VideoIconProps) {
  return (
    <IconShell {...props}>
      <path d="M5.3 3.1v9.8l7.5-4.9z" fill="currentColor" stroke="none" />
    </IconShell>
  );
}

export function PauseIcon(props: VideoIconProps) {
  return (
    <IconShell {...props}>
      <rect x="4.4" y="3.2" width="2.4" height="9.6" rx="0.9" fill="currentColor" stroke="none" />
      <rect x="9.2" y="3.2" width="2.4" height="9.6" rx="0.9" fill="currentColor" stroke="none" />
    </IconShell>
  );
}

export function VolumeIcon(props: VideoIconProps) {
  return (
    <IconShell {...props}>
      <path d="M2.8 6.1h2.3L8 3.3v9.4L5.1 9.9H2.8z" />
      <path d="M10.6 5.9a3 3 0 0 1 0 4.2" />
      <path d="M12.4 4.3a5.3 5.3 0 0 1 0 7.4" />
    </IconShell>
  );
}

export function VolumeMutedIcon(props: VideoIconProps) {
  return (
    <IconShell {...props}>
      <path d="M2.8 6.1h2.3L8 3.3v9.4L5.1 9.9H2.8z" />
      <path d="m10.7 6.1 3.1 3.1" />
      <path d="m13.8 6.1-3.1 3.1" />
    </IconShell>
  );
}

/** Horizontal ellipsis for the header's overflow menu. */
export function MoreIcon(props: VideoIconProps) {
  return (
    <IconShell {...props}>
      <circle cx="3.4" cy="8" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="12.6" cy="8" r="1.15" fill="currentColor" stroke="none" />
    </IconShell>
  );
}
