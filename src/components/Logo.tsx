import { useId } from "react";

export interface LogoProps {
  /** Pixel size of the square mark. */
  size?: number;
  /** Show the "SnapDraw" wordmark next to the mark. */
  withWordmark?: boolean;
  className?: string;
}

/**
 * SnapDraw brand mark: a viewfinder frame with a pen stroke – the two halves of
 * "capture" and "annotate". Drawn as inline SVG so it stays crisp at any size
 * and needs no network request.
 */
export function Logo({ size = 32, withWordmark = false, className }: LogoProps) {
  // `useId` keeps the gradient unique when several logos are mounted at once.
  const gradientId = `sd-logo-gradient-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;

  return (
    <span className={["sd-logo", className].filter(Boolean).join(" ")}>
      <svg
        width={size}
        height={size}
        viewBox="0 0 128 128"
        fill="none"
        aria-hidden="true"
        focusable="false"
      >
        <defs>
          <linearGradient id={gradientId} x1="16" y1="8" x2="112" y2="120">
            <stop offset="0%" stopColor="#6366f1" />
            <stop offset="55%" stopColor="#7c5cf0" />
            <stop offset="100%" stopColor="#a855f7" />
          </linearGradient>
        </defs>
        <rect x="4" y="4" width="120" height="120" rx="30" fill={`url(#${gradientId})`} />
        <g
          stroke="#ffffff"
          strokeWidth="9"
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity="0.92"
        >
          <path d="M45 30H33a3 3 0 0 0-3 3v12" />
          <path d="M83 30h12a3 3 0 0 1 3 3v12" />
          <path d="M30 83v12a3 3 0 0 0 3 3h12" />
          <path d="M98 83v12a3 3 0 0 1-3 3H83" />
        </g>
        <path
          d="M48 82 74 56"
          stroke="#ffffff"
          strokeWidth="11"
          strokeLinecap="round"
        />
        <circle cx="84" cy="46" r="8" fill="#ffffff" />
      </svg>
      {withWordmark ? <span className="sd-logo__wordmark">SnapDraw</span> : null}
    </span>
  );
}
