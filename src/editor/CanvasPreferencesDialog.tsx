import { useEffect, useRef } from "react";
import type { CSSProperties } from "react";
import {
  CANVAS_BACKGROUND_OPTIONS,
  THEME_OPTIONS,
  type CanvasPreferences,
  type ThemePreference,
} from "../services/preferences.service";
import {
  CloseIcon,
  MonitorIcon,
  MoonIcon,
  SettingsIcon,
  SunIcon,
} from "./icons";

export interface CanvasPreferencesDialogProps {
  open: boolean;
  onClose: () => void;
  preferences: CanvasPreferences;
  /** Applies a single preference change (already persisted by the hook). */
  onChange: (patch: Partial<CanvasPreferences>) => void;
  /** Hide the background section where it has no effect (video overlay). */
  showBackground?: boolean;
}

function themeIcon(theme: ThemePreference) {
  if (theme === "light") {
    return <SunIcon size={15} />;
  }
  if (theme === "dark") {
    return <MoonIcon size={15} />;
  }
  return <MonitorIcon size={15} />;
}

/**
 * SnapDraw's canvas preferences dialog: editor theme and canvas background.
 *
 * Replaces the Excalidraw 0.18 Preferences panel (not exposed by that version)
 * with the same two choices SnapDraw actually uses, persisted locally by
 * `preferences.service.ts`.
 */
export function CanvasPreferencesDialog({
  open,
  onClose,
  preferences,
  onChange,
  showBackground = true,
}: CanvasPreferencesDialogProps) {
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    closeButtonRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  if (!open) {
    return null;
  }

  return (
    <div
      className="sd-about sd-preferences"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        className="sd-about__dialog sd-preferences__dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sd-preferences-title"
      >
        <div className="sd-about__head">
          <span className="sd-preferences__badge" aria-hidden="true">
            <SettingsIcon size={20} />
          </span>
          <div className="sd-about__identity">
            <h2 id="sd-preferences-title" className="sd-about__title">
              Canvas preferences
            </h2>
            <p className="sd-about__version">Saved in this browser</p>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className="sd-about__close"
            aria-label="Close canvas preferences"
            onClick={onClose}
          >
            <CloseIcon size={14} />
          </button>
        </div>

        <section className="sd-preferences__group" aria-labelledby="sd-preferences-theme">
          <div className="sd-preferences__label-row">
            <h3 id="sd-preferences-theme" className="sd-preferences__label">
              Theme
            </h3>
            <p className="sd-preferences__hint">Applies to every editor tab.</p>
          </div>
          <div
            className="sd-preferences__options sd-preferences__options--theme"
            role="radiogroup"
            aria-label="Editor theme"
          >
            {THEME_OPTIONS.map((option) => {
              const selected = preferences.theme === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  className={
                    selected
                      ? "sd-preferences__theme sd-preferences__theme--selected"
                      : "sd-preferences__theme"
                  }
                  title={option.hint}
                  onClick={() => onChange({ theme: option.value })}
                >
                  {themeIcon(option.value)}
                  <span>{option.label}</span>
                </button>
              );
            })}
          </div>
        </section>

        {showBackground ? (
          <section className="sd-preferences__group" aria-labelledby="sd-preferences-background">
            <div className="sd-preferences__label-row">
              <h3 id="sd-preferences-background" className="sd-preferences__label">
                Canvas background
              </h3>
              <p className="sd-preferences__hint">Also used behind exported PNG padding.</p>
            </div>
            <div
              className="sd-preferences__swatches"
              role="radiogroup"
              aria-label="Canvas background"
            >
              {CANVAS_BACKGROUND_OPTIONS.map((option) => {
                const selected = preferences.background === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    aria-label={`${option.label} canvas background`}
                    title={option.label}
                    className={
                      option.value === "transparent"
                        ? "sd-preferences__swatch sd-preferences__swatch--transparent"
                        : selected
                          ? "sd-preferences__swatch sd-preferences__swatch--selected"
                          : "sd-preferences__swatch"
                    }
                    style={{ "--sd-swatch": option.value } as CSSProperties}
                    onClick={() => onChange({ background: option.value })}
                  >
                    <span className="sd-preferences__swatch-check" aria-hidden="true" />
                  </button>
                );
              })}
            </div>
            <p className="sd-preferences__note">
              Transparent keeps the workspace background; white is what a normal screenshot
              export uses.
            </p>
          </section>
        ) : null}

        <p className="sd-about__footer">
          Stored locally · no account, no upload
        </p>
      </div>
    </div>
  );
}
