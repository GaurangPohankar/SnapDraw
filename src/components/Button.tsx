import type { ButtonHTMLAttributes, ReactNode } from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "icon";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Show a spinner and block interactions. */
  loading?: boolean;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
  fullWidth?: boolean;
}

/**
 * The single button primitive used by the popup and the editor header.
 * Styling lives in `styles/global.css` (`.sd-button`).
 */
export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  leadingIcon,
  trailingIcon,
  fullWidth = false,
  className,
  children,
  disabled,
  type = "button",
  ...rest
}: ButtonProps) {
  const classes = [
    "sd-button",
    `sd-button--${variant}`,
    `sd-button--${size}`,
    fullWidth ? "sd-button--full" : null,
    loading ? "sd-button--loading" : null,
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      {...rest}
      type={type}
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
    >
      {loading ? <span className="sd-button__spinner" aria-hidden="true" /> : leadingIcon}
      {children !== undefined && children !== null ? (
        <span className="sd-button__label">{children}</span>
      ) : null}
      {trailingIcon}
    </button>
  );
}
