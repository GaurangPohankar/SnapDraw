import { useCallback, useEffect, useRef, useState } from "react";
import type { CaptureResponse, SnapDrawErrorPayload } from "../types";
import { errorPayload, isExtensionContext, requestCapture } from "../utils/messaging";

/** Where the capture flow currently is. */
export type CaptureStatus = "idle" | "capturing" | "success" | "error";

/** Fine-grained progress inside the capturing state. */
export type CapturePhase = "capturing" | "opening";

/** How long the success state is shown before the popup closes itself. */
const SUCCESS_CLOSE_DELAY_MS = 650;

/** When to switch the status copy from capturing to opening the editor. */
const OPENING_PHASE_DELAY_MS = 900;

export interface UseCaptureResult {
  status: CaptureStatus;
  phase: CapturePhase;
  error: SnapDrawErrorPayload | null;
  /** True when Chrome extension APIs are unavailable (dev-server preview). */
  isPreview: boolean;
  capture: () => Promise<void>;
}

/**
 * Owns the popup's capture state machine.
 *
 * `requestCapture()` never throws by contract, but an unexpected rejection is
 * still caught here so the popup can never crash on an unhandled promise.
 */
export function useCapture(): UseCaptureResult {
  const [status, setStatus] = useState<CaptureStatus>("idle");
  const [phase, setPhase] = useState<CapturePhase>("capturing");
  const [error, setError] = useState<SnapDrawErrorPayload | null>(null);

  const isPreview = !isExtensionContext();
  const inFlightRef = useRef(false);
  const mountedRef = useRef(true);
  const closeTimerRef = useRef<number | null>(null);
  const phaseTimerRef = useRef<number | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current);
      }
      if (phaseTimerRef.current !== null) {
        window.clearTimeout(phaseTimerRef.current);
      }
    };
  }, []);

  // While a capture is in flight, nudge the copy towards the editor-opening
  // stage so the popup never feels frozen on slower captures.
  useEffect(() => {
    if (status !== "capturing") {
      return undefined;
    }

    phaseTimerRef.current = window.setTimeout(
      () => setPhase("opening"),
      OPENING_PHASE_DELAY_MS,
    );

    return () => {
      if (phaseTimerRef.current !== null) {
        window.clearTimeout(phaseTimerRef.current);
        phaseTimerRef.current = null;
      }
    };
  }, [status]);

  const capture = useCallback(async (): Promise<void> => {
    if (isPreview || inFlightRef.current) {
      return;
    }

    inFlightRef.current = true;
    setError(null);
    setPhase("capturing");
    setStatus("capturing");

    let response: CaptureResponse;
    try {
      response = await requestCapture("popup");
    } catch (unexpected) {
      response = {
        ok: false,
        error: errorPayload(
          "UNKNOWN",
          unexpected instanceof Error
            ? unexpected.message
            : "Screenshot capture failed unexpectedly.",
          "Please try again.",
        ),
      };
    }

    if (!mountedRef.current) {
      return;
    }

    inFlightRef.current = false;

    if (response.ok) {
      setStatus("success");
      closeTimerRef.current = window.setTimeout(() => {
        // Closing only makes sense inside the extension popup; in preview mode
        // (dev server tab) window.close() would be a no-op or blocked.
        if (isExtensionContext()) {
          window.close();
        }
      }, SUCCESS_CLOSE_DELAY_MS);
      return;
    }

    setError(response.error);
    setStatus("error");
  }, [isPreview]);

  return { status, phase, error, isPreview, capture };
}
