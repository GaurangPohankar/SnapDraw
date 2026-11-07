import { useCallback, useEffect, useState } from "react";
import { isExtensionContext } from "../../utils/messaging";
import {
  CAPTURE_COMMAND_NAME,
  SHORTCUTS_URL,
  shortcutLabel,
  splitShortcut,
} from "../shortcut";
import { CopyIcon, KeyboardIcon } from "./icons";

type ShortcutState =
  | { kind: "loading" }
  | { kind: "keys"; keys: string[] }
  | { kind: "unset" }
  | { kind: "unavailable" };

export interface ShortcutRowProps {
  /** Reports whether copying the shortcut-settings URL succeeded. */
  onCopyResult: (copied: boolean) => void;
}

/** Copies text, falling back to the legacy selection path when needed. */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Clipboard permission can be denied; fall through to the legacy path.
  }

  try {
    const field = document.createElement("textarea");
    field.value = text;
    field.readOnly = true;
    field.style.position = "fixed";
    field.style.top = "-1000px";
    field.style.opacity = "0";
    document.body.appendChild(field);
    field.select();
    const copied = document.execCommand("copy");
    field.remove();
    return copied;
  } catch {
    return false;
  }
}

/**
 * Live keyboard-shortcut hint.
 *
 * Reads the *real* shortcut from `chrome.commands.getAll()` so user-customised
 * or platform-specific combinations are always reflected. When no shortcut is
 * assigned, the row offers the shortcuts page on the clipboard.
 */
export function ShortcutRow({ onCopyResult }: ShortcutRowProps) {
  const [shortcut, setShortcut] = useState<ShortcutState>({ kind: "loading" });
  const [copying, setCopying] = useState(false);

  useEffect(() => {
    if (!isExtensionContext()) {
      setShortcut({ kind: "unavailable" });
      return undefined;
    }

    let cancelled = false;

    chrome.commands
      .getAll()
      .then((commands) => {
        if (cancelled) {
          return;
        }
        const command = commands.find((entry) => entry.name === CAPTURE_COMMAND_NAME);
        const keys = splitShortcut(command?.shortcut ?? "");
        setShortcut(keys.length > 0 ? { kind: "keys", keys } : { kind: "unset" });
      })
      .catch(() => {
        if (!cancelled) {
          setShortcut({ kind: "unset" });
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const handleSetShortcut = useCallback(async () => {
    setCopying(true);
    const copied = await copyText(SHORTCUTS_URL);
    setCopying(false);
    onCopyResult(copied);
  }, [onCopyResult]);

  return (
    <div className="sd-popup__shortcut">
      <span className="sd-popup__shortcut-label">
        <KeyboardIcon size={14} />
        Shortcut
      </span>

      {shortcut.kind === "loading" ? (
        <span className="sd-popup__shortcut-value">Checking…</span>
      ) : null}

      {shortcut.kind === "unavailable" ? (
        <span className="sd-popup__shortcut-value">Only in Chrome</span>
      ) : null}

      {shortcut.kind === "unset" ? (
        <button
          type="button"
          className="sd-popup__shortcut-action"
          onClick={() => void handleSetShortcut()}
          disabled={copying}
          title={`Copy ${SHORTCUTS_URL}`}
          aria-label={`Set a shortcut — copies ${SHORTCUTS_URL} to the clipboard`}
        >
          {copying ? "Copying…" : "Set a shortcut"}
          <CopyIcon size={13} />
        </button>
      ) : null}

      {shortcut.kind === "keys" ? (
        <>
          <span className="sd-sr-only">{shortcutLabel(shortcut.keys)}</span>
          <span className="sd-popup__keys" aria-hidden="true">
            {shortcut.keys.map((key, index) => (
              <span key={`${key}-${index}`} className="sd-popup__key">
                {index > 0 ? <span className="sd-popup__key-separator">+</span> : null}
                <kbd className="sd-kbd">{key}</kbd>
              </span>
            ))}
          </span>
        </>
      ) : null}
    </div>
  );
}
