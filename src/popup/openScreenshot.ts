import { buildEditorUrl, isExtensionContext } from "../utils/messaging";
import type { ShowToastInput } from "../components/Toast";

/**
 * Opens a saved capture in the editor tab and closes the popup.
 *
 * Shared by the history view and the recent-screenshots preview so both behave
 * identically (and both explain the failure if Chrome refuses to open a tab).
 */
export async function openScreenshotInEditor(
  sessionId: string,
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
    await chrome.tabs.create({ url: buildEditorUrl(sessionId), active: true });
    window.close();
  } catch (error) {
    showToast({
      tone: "error",
      title: "Couldn't open the screenshot",
      description: error instanceof Error ? error.message : "Please try again.",
    });
  }
}
