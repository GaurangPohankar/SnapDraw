/**
 * Helpers for the live keyboard-shortcut hint.
 *
 * The shortcut is user configurable through Chrome, so the popup never assumes
 * a key combination – it renders whatever `chrome.commands.getAll()` reports.
 */

/** Manifest command name that triggers a capture. */
export const CAPTURE_COMMAND_NAME = "capture-screenshot";

/** Chrome page where the user can assign a shortcut to SnapDraw. */
export const SHORTCUTS_URL = "chrome://extensions/shortcuts";

/**
 * Splits a Chrome shortcut string into individual key labels.
 *
 * Windows/Linux return `"Ctrl+Shift+S"`. macOS returns glyph runs such as
 * `"⇧⌘S"`, which have no separator, so both shapes are handled.
 */
export function splitShortcut(shortcut: string): string[] {
  const value = shortcut.trim();
  if (value.length === 0) {
    return [];
  }

  if (value.includes("+")) {
    return value
      .split("+")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
  }

  const glyphs = value.match(/[⌘⌥⌃⇧⌫⌦⏎↩⎋⇥]|[A-Za-z0-9]+/g);
  return glyphs && glyphs.length > 0 ? glyphs : [value];
}

/** Human readable shortcut used for screen readers, e.g. `"Ctrl + Shift + S"`. */
export function shortcutLabel(keys: readonly string[]): string {
  return keys.join(" + ");
}
