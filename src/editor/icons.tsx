import type { ReactNode } from "react";

export interface IconProps {
  size?: number;
  className?: string;
}

interface IconShellProps extends IconProps {
  children: ReactNode;
}

/** Shared 16px stroke icon shell – all editor icons inherit `currentColor`. */
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

export function UndoIcon(props: IconProps) {
  return (
    <IconShell {...props}>
      <path d="M6.4 4.4 3.4 7.4l3 3" />
      <path d="M3.6 7.4h5.1a3.3 3.3 0 0 1 3.3 3.3v.6" />
    </IconShell>
  );
}

export function RedoIcon(props: IconProps) {
  return (
    <IconShell {...props}>
      <path d="m9.6 4.4 3 3-3 3" />
      <path d="M12.4 7.4H7.3A3.3 3.3 0 0 0 4 10.7v.6" />
    </IconShell>
  );
}

export function CopyIcon(props: IconProps) {
  return (
    <IconShell {...props}>
      <rect x="5.6" y="5.6" width="7.9" height="7.9" rx="1.5" />
      <path d="M10.4 5.6V3.9a1.4 1.4 0 0 0-1.4-1.4H3.9a1.4 1.4 0 0 0-1.4 1.4V9a1.4 1.4 0 0 0 1.4 1.4h1.7" />
    </IconShell>
  );
}

export function DownloadIcon(props: IconProps) {
  return (
    <IconShell {...props}>
      <path d="M8 2.6v7.1" />
      <path d="m5.2 7 2.8 2.8L10.8 7" />
      <path d="M3.4 12.7h9.2" />
    </IconShell>
  );
}

export function FitViewIcon(props: IconProps) {
  return (
    <IconShell {...props}>
      <path d="M6 2.6H3.8A1.2 1.2 0 0 0 2.6 3.8V6" />
      <path d="M10 2.6h2.2a1.2 1.2 0 0 1 1.2 1.2V6" />
      <path d="M6 13.4H3.8a1.2 1.2 0 0 1-1.2-1.2V10" />
      <path d="M10 13.4h2.2a1.2 1.2 0 0 0 1.2-1.2V10" />
    </IconShell>
  );
}

/** SnapDraw's own GitHub mark (not Excalidraw's). */
export function GitHubIcon(props: IconProps) {
  return (
    <IconShell {...props}>
      <path d="M6.2 12.2c-2.3.7-2.3-1.2-3.2-1.5" />
      <path d="M9.8 13.6v-1.9c0-.6.1-1-.4-1.4 1.5-.2 2.9-.8 2.9-3.3 0-.7-.3-1.3-.7-1.8.1-.3.3-.9-.1-1.7 0 0-.6-.2-1.9.7a6.3 6.3 0 0 0-3.2 0C5.1 3.2 4.5 3.4 4.5 3.4c-.4.8-.2 1.4-.1 1.7-.4.5-.7 1.1-.7 1.8 0 2.5 1.4 3.1 2.9 3.3-.4.4-.4.8-.4 1.3v2.1" />
    </IconShell>
  );
}

/** Clock mark for the screenshot-history menu item. */
export function ClockIcon(props: IconProps) {
  return (
    <IconShell {...props}>
      <circle cx="8" cy="8" r="5.8" />
      <path d="M8 4.9V8l2.1 1.3" />
    </IconShell>
  );
}

export function ExternalLinkIcon(props: IconProps) {
  return (
    <IconShell {...props}>
      <path d="M6.8 3.2H3.9a1.3 1.3 0 0 0-1.3 1.3v7.6a1.3 1.3 0 0 0 1.3 1.3h7.6a1.3 1.3 0 0 0 1.3-1.3V9.2" />
      <path d="M9.4 2.6h4v4" />
      <path d="m13.2 2.8-5.4 5.4" />
    </IconShell>
  );
}

export function TrashIcon(props: IconProps) {
  return (
    <IconShell {...props}>
      <path d="M2.9 4.4h10.2" />
      <path d="M6.4 4.4V3a1 1 0 0 1 1-1h1.2a1 1 0 0 1 1 1v1.4" />
      <path d="m4.4 4.4.6 8a1 1 0 0 0 1 .9h4a1 1 0 0 0 1-.9l.6-8" />
      <path d="M6.7 7.1v4" />
      <path d="M9.3 7.1v4" />
    </IconShell>
  );
}

export function LockIcon(props: IconProps) {
  return (
    <IconShell {...props}>
      <rect x="3.4" y="6.9" width="9.2" height="6.6" rx="1.3" />
      <path d="M5.5 6.9V5.2a2.5 2.5 0 0 1 5 0v1.7" />
    </IconShell>
  );
}

export function UnlockIcon(props: IconProps) {
  return (
    <IconShell {...props}>
      <rect x="3.4" y="6.9" width="9.2" height="6.6" rx="1.3" />
      <path d="M5.5 6.9V5.2a2.5 2.5 0 0 1 4.8-.8" />
    </IconShell>
  );
}

export function InfoIcon(props: IconProps) {
  return (
    <IconShell {...props}>
      <circle cx="8" cy="8" r="5.7" />
      <path d="M8 7.2v3.6" />
      <circle cx="8" cy="4.9" r="0.85" fill="currentColor" stroke="none" />
    </IconShell>
  );
}

export function WarningIcon(props: IconProps) {
  return (
    <IconShell {...props}>
      <path d="M7.1 2.7a1 1 0 0 1 1.8 0l5.1 9.1a1 1 0 0 1-.9 1.5H2.9a1 1 0 0 1-.9-1.5l5.1-9.1Z" />
      <path d="M8 6.1v3.1" />
      <circle cx="8" cy="11.3" r="0.85" fill="currentColor" stroke="none" />
    </IconShell>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <IconShell {...props}>
      <path d="m4.2 4.2 7.6 7.6" />
      <path d="M11.8 4.2 4.2 11.8" />
    </IconShell>
  );
}

/** Gear mark for the "Canvas preferences" menu item. */
export function SettingsIcon(props: IconProps) {
  return (
    <IconShell {...props}>
      <circle cx="8" cy="8" r="2.1" />
      <path d="M8 1.8v1.5M8 12.7v1.5M1.8 8h1.5M12.7 8h1.5M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1" />
    </IconShell>
  );
}

/** Sun mark for the light theme option. */
export function SunIcon(props: IconProps) {
  return (
    <IconShell {...props}>
      <circle cx="8" cy="8" r="2.7" />
      <path d="M8 1.5v1.2M8 13.3v1.2M1.5 8h1.2M13.3 8h1.2M3.4 3.4l.9.9M11.7 11.7l.9.9M12.6 3.4l-.9.9M4.3 11.7l-.9.9" />
    </IconShell>
  );
}

/** Crescent mark for the dark theme option. */
export function MoonIcon(props: IconProps) {
  return (
    <IconShell {...props}>
      <path d="M13.1 9.8A5.6 5.6 0 0 1 6.2 2.9a5.7 5.7 0 1 0 6.9 6.9Z" />
    </IconShell>
  );
}

/** Monitor mark for the "follow system" theme option. */
export function MonitorIcon(props: IconProps) {
  return (
    <IconShell {...props}>
      <rect x="1.8" y="2.7" width="12.4" height="8.6" rx="1.2" />
      <path d="M5.6 13.5h4.8M8 11.3v2.2" />
    </IconShell>
  );
}
