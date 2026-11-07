import type { CaptureKind } from "../types";
import { buildEditorUrl, buildVideoEditorUrl, isExtensionContext } from "../utils/messaging";
import type { ShowToastInput } from "../components/Toast";

/** Minimal shape needed to reopen a capture (image or video). */
export interface OpenableCapture {
  id: string;
  kind?: CaptureKind;
}

/**
 * Opens a saved capture in the matching editor tab and closes the popup.
 *
 * Shared by the history view and the recent-captures preview so both behave
 * identically (and both explain the failure if Chrome refuses to open a tab).
 */
export async function openScreenshotInEditor(
  capture: OpenableCapture,
  showToast: (toast: ShowToastInput) => string,
): Promise<void> {
  if (!isExtensionContext()) {
    showToast({
      tone: "info",
      title: "History is available in the extension",
      description: "Load SnapDraw from chrome://extensions to open a capture.",
    });
    return;
  }

  try {
    const url =
      capture.kind === "video"
        ? buildVideoEditorUrl(capture.id)
        : buildEditorUrl(capture.id);
    await chrome.tabs.create({ url, active: true });
    window.close();
  } catch (error) {
    showToast({
      tone: "error",
      title: "Couldn't open the capture",
      description: error instanceof Error ? error.message : "Please try again.",
    });
  }
}
