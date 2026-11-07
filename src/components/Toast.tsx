import { useCallback, useEffect, useRef, useState } from "react";

export type ToastTone = "success" | "error" | "info";

export interface ToastMessage {
  id: string;
  tone: ToastTone;
  title: string;
  description?: string;
}

export interface ShowToastInput {
  tone: ToastTone;
  title: string;
  description?: string;
  /** Override the auto dismiss delay in ms. `0` keeps it until dismissed. */
  duration?: number;
}

export interface UseToastResult {
  toasts: ToastMessage[];
  showToast: (toast: ShowToastInput) => string;
  dismissToast: (id: string) => void;
}

const MAX_VISIBLE_TOASTS = 3;

/** Tiny local toast queue – no dependency, used by the editor and the popup. */
export function useToast(): UseToastResult {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const timersRef = useRef<Map<string, number>>(new Map());

  const dismissToast = useCallback((id: string) => {
    const timer = timersRef.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timersRef.current.delete(id);
    }
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const showToast = useCallback(
    ({ tone, title, description, duration }: ShowToastInput): string => {
      const id =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `toast-${Date.now()}-${Math.random().toString(16).slice(2)}`;

      setToasts((current) => [
        ...current.slice(-(MAX_VISIBLE_TOASTS - 1)),
        { id, tone, title, description },
      ]);

      const delay = duration ?? (tone === "error" ? 5200 : 3200);
      if (delay > 0) {
        const timer = window.setTimeout(() => dismissToast(id), delay);
        timersRef.current.set(id, timer);
      }

      return id;
    },
    [dismissToast],
  );

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
      timers.clear();
    };
  }, []);

  return { toasts, showToast, dismissToast };
}

function ToastIcon({ tone }: { tone: ToastTone }) {
  if (tone === "success") {
    return (
      <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
        <path
          d="M4.5 10.5l3.2 3.2 7.8-7.8"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  if (tone === "error") {
    return (
      <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
        <path
          d="M10 5.5v5.2"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
        />
        <circle cx="10" cy="14.6" r="1.3" fill="currentColor" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
      <path
        d="M10 9v6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
      <circle cx="10" cy="5.4" r="1.3" fill="currentColor" />
    </svg>
  );
}

export interface ToastViewportProps {
  toasts: ToastMessage[];
  onDismiss: (id: string) => void;
  /** `bottom` suits the popup, `bottom-left` the full screen editor. */
  placement?: "bottom" | "bottom-left" | "bottom-right";
}

export function ToastViewport({
  toasts,
  onDismiss,
  placement = "bottom",
}: ToastViewportProps) {
  return (
    <div
      className={`sd-toast-viewport sd-toast-viewport--${placement}`}
      role="status"
      aria-live="polite"
    >
      {toasts.map((toast) => (
        <div key={toast.id} className={`sd-toast sd-toast--${toast.tone}`}>
          <span className="sd-toast__icon">
            <ToastIcon tone={toast.tone} />
          </span>
          <span className="sd-toast__content">
            <span className="sd-toast__title">{toast.title}</span>
            {toast.description ? (
              <span className="sd-toast__description">{toast.description}</span>
            ) : null}
          </span>
          <button
            type="button"
            className="sd-toast__close"
            aria-label="Dismiss notification"
            onClick={() => onDismiss(toast.id)}
          >
            <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
              <path
                d="M3.5 3.5l9 9M12.5 3.5l-9 9"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
      ))}
    </div>
  );
}
