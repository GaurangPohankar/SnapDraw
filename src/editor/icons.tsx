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

export function ShareIcon(props: IconProps) {
  return (
    <IconShell {...props}>
      <circle cx="4" cy="8" r="1.7" />
      <circle cx="12" cy="3.9" r="1.7" />
      <circle cx="12" cy="12.1" r="1.7" />
      <path d="m5.5 7.2 5-2.5" />
      <path d="m5.5 8.8 5 2.5" />
    </IconShell>
  );
}

export function MoreIcon(props: IconProps) {
  return (
    <IconShell {...props}>
      <circle cx="3.4" cy="8" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="12.6" cy="8" r="1.15" fill="currentColor" stroke="none" />
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
