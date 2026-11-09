import type { ReactNode } from "react";

export interface IconProps {
  /** Rendered width and height in pixels. */
  size?: number;
  className?: string;
}

interface IconBaseProps extends IconProps {
  children: ReactNode;
  viewBox?: string;
}

/**
 * Shared wrapper for the popup's stroke icons.
 *
 * Always inline SVG with `currentColor` so icons inherit text colour and the
 * extension never needs a remote asset.
 */
function IconBase({
  size = 18,
  className,
  children,
  viewBox = "0 0 24 24",
}: IconBaseProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={viewBox}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
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

/** Camera mark used by the primary capture action. */
export function CameraIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M4.75 7.75h2.55l1.32-2.05a.9.9 0 0 1 .76-.42h5.24a.9.9 0 0 1 .76.42l1.32 2.05h2.55A1.75 1.75 0 0 1 21 9.5v8.75A1.75 1.75 0 0 1 19.25 20H4.75A1.75 1.75 0 0 1 3 18.25V9.5a1.75 1.75 0 0 1 1.75-1.75Z" />
      <circle cx="12" cy="13.4" r="3.35" />
    </IconBase>
  );
}

/** Video camera mark used by the "Record video" action. */
export function VideoIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="2.8" y="6.6" width="12.4" height="10.8" rx="2.4" />
      <path d="m15.2 10.4 4.1-2.3a.9.9 0 0 1 1.4.8v6.2a.9.9 0 0 1-1.4.8l-4.1-2.3" />
      <circle cx="6.6" cy="9.3" r="1.15" fill="currentColor" stroke="none" />
    </IconBase>
  );
}

/** Current-tab mark for the "record this tab" segment. */
export function TabIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="3" y="4.6" width="18" height="14.8" rx="2.3" />
      <path d="M3 8.9h18" />
      <circle cx="6.3" cy="6.8" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="9.3" cy="6.8" r="0.9" fill="currentColor" stroke="none" />
    </IconBase>
  );
}

/** Monitor mark for the "record whole screen" segment. */
export function ScreenIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="2.9" y="4.4" width="18.2" height="12.4" rx="2.1" />
      <path d="M8.4 20h7.2" />
      <path d="M12 16.8V20" />
    </IconBase>
  );
}

/** Check mark shown once the editor tab has opened. */
export function CheckIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="m5.2 12.4 4.15 4.15L18.8 7.1" />
    </IconBase>
  );
}

/** Warning mark used by the inline error panel. */
export function AlertIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M12 3.9a1.4 1.4 0 0 1 1.25.73l8.05 14.15A1.4 1.4 0 0 1 20.05 21H3.95a1.4 1.4 0 0 1-1.25-2.22l8.05-14.15A1.4 1.4 0 0 1 12 3.9Z" />
      <path d="M12 9.3v4.4" />
      <path d="M12 16.9h.01" />
    </IconBase>
  );
}

/** Shield mark for the local-only trust line. */
export function ShieldIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M12 3.1 5.25 6v5.25c0 4.3 2.8 7.62 6.75 9.65 3.95-2.03 6.75-5.35 6.75-9.65V6L12 3.1Z" />
      <path d="m9.4 11.9 1.85 1.85 3.5-3.6" />
    </IconBase>
  );
}

/** Info mark used by the preview-mode notice. */
export function InfoIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5" />
      <path d="M12 8.1h.01" />
    </IconBase>
  );
}

/** Keyboard mark for the shortcut row. */
export function KeyboardIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="3" y="6.5" width="18" height="11" rx="2.25" />
      <path d="M6.6 10h.01M9.8 10h.01M13 10h.01M16.2 10h.01M18 10h.01M7.6 13.6h8.8" />
    </IconBase>
  );
}

/** Copy mark for the "Set a shortcut" action. */
export function CopyIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2.5" />
      <path d="M5.5 15.5A2.5 2.5 0 0 1 3.5 13V6.5A2.5 2.5 0 0 1 6 4h6.5a2.5 2.5 0 0 1 2.3 1.4" />
    </IconBase>
  );
}

/** Retry mark used by the error panel action. */
export function RetryIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M20.4 11.5a8.5 8.5 0 1 1-2.55-6.1" />
      <path d="M20.4 4.2v5.4h-5.4" />
    </IconBase>
  );
}

/** Clock mark for the screenshot history entry point. */
export function ClockIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.4V12l3 1.9" />
    </IconBase>
  );
}

/** Back arrow for the history view. */
export function ChevronLeftIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M14.5 5.5 8 12l6.5 6.5" />
    </IconBase>
  );
}

/** Trash mark used to delete a single history entry or clear the history. */
export function TrashIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M4.6 6.6h14.8" />
      <path d="M9.4 6.6V4.9a1.3 1.3 0 0 1 1.3-1.3h2.6a1.3 1.3 0 0 1 1.3 1.3v1.7" />
      <path d="m6.6 6.6.8 12.1a1.6 1.6 0 0 0 1.6 1.5h6a1.6 1.6 0 0 0 1.6-1.5l.8-12.1" />
      <path d="M10.2 10.8v5.4M13.8 10.8v5.4" />
    </IconBase>
  );
}

/** Image placeholder for history entries without a stored thumbnail. */
export function ImageIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="3.4" y="4.8" width="17.2" height="14.4" rx="2.3" />
      <circle cx="8.5" cy="9.6" r="1.5" />
      <path d="m5 17.4 4.6-4.6a1.6 1.6 0 0 1 2.3 0l4.2 4.2" />
      <path d="m13.4 14.2 1.7-1.7a1.6 1.6 0 0 1 2.3 0l3.1 3.1" />
    </IconBase>
  );
}

/** External-link mark for links that leave the popup (history/about). */
export function ExternalLinkIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M10.5 5.2H6.2A2.2 2.2 0 0 0 4 7.4v10.4A2.2 2.2 0 0 0 6.2 20h10.4a2.2 2.2 0 0 0 2.2-2.2v-4.3" />
      <path d="M14.4 4h5.6v5.6" />
      <path d="m19.4 4.6-7.2 7.2" />
    </IconBase>
  );
}
