/**
 * Local canvas preferences for SnapDraw's editors.
 *
 * Settings are stored in `localStorage` (same extension origin, local-only) so
 * they survive refreshes, new editor tabs and browser restarts without adding
 * a Chrome storage permission. Everything is validated on read: a corrupt or
 * outdated value falls back to the defaults instead of breaking the editor.
 */

export type ThemePreference = "system" | "light" | "dark";

export interface CanvasPreferences {
  /** "system" follows the OS; otherwise the editor theme is forced. */
  theme: ThemePreference;
  /** Excalidraw scene background; "transparent" leaves the page background visible. */
  background: string;
}

export interface CanvasBackgroundOption {
  value: string;
  label: string;
}

export const DEFAULT_CANVAS_PREFERENCES: CanvasPreferences = {
  theme: "system",
  background: "transparent",
};

export const THEME_OPTIONS: ReadonlyArray<{
  value: ThemePreference;
  label: string;
  hint: string;
}> = [
  { value: "system", label: "System", hint: "Follow the operating system theme" },
  { value: "light", label: "Light", hint: "Always use the light theme" },
  { value: "dark", label: "Dark", hint: "Always use the dark theme" },
];

/**
 * Background choices shown in the preferences dialog. The first entry keeps the
 * current page background visible (the screenshot editor's default); the rest
 * are solid colours that are also used for exported PNG padding.
 */
export const CANVAS_BACKGROUND_OPTIONS: ReadonlyArray<CanvasBackgroundOption> = [
  { value: "transparent", label: "Transparent" },
  { value: "#ffffff", label: "White" },
  { value: "#f1f3f5", label: "Light gray" },
  { value: "#fff9db", label: "Warm" },
  { value: "#e7f5ff", label: "Blue tint" },
  { value: "#1e1e1e", label: "Ink" },
  { value: "#000000", label: "Black" },
];

const STORAGE_KEY = "snapdraw.canvas-preferences.v1";
const CHANGE_EVENT = "snapdraw:canvas-preferences";

function isThemePreference(value: unknown): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

function isBackgroundValue(value: unknown): value is string {
  return (
    typeof value === "string" &&
    CANVAS_BACKGROUND_OPTIONS.some((option) => option.value === value)
  );
}

/** Normalises arbitrary parsed JSON into a safe preferences object. */
export function normalizeCanvasPreferences(value: unknown): CanvasPreferences {
  if (typeof value !== "object" || value === null) {
    return { ...DEFAULT_CANVAS_PREFERENCES };
  }

  const candidate = value as Record<string, unknown>;
  return {
    theme: isThemePreference(candidate.theme)
      ? candidate.theme
      : DEFAULT_CANVAS_PREFERENCES.theme,
    background: isBackgroundValue(candidate.background)
      ? candidate.background
      : DEFAULT_CANVAS_PREFERENCES.background,
  };
}

function getStorage(): Storage | null {
  try {
    if (typeof window === "undefined") {
      return null;
    }
    return window.localStorage;
  } catch {
    // Storage can be unavailable/blocked; the editor still works with defaults.
    return null;
  }
}

/** Reads the saved preferences (defaults when nothing valid is stored). */
export function readCanvasPreferences(): CanvasPreferences {
  const storage = getStorage();
  if (!storage) {
    return { ...DEFAULT_CANVAS_PREFERENCES };
  }

  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) {
      return { ...DEFAULT_CANVAS_PREFERENCES };
    }
    return normalizeCanvasPreferences(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_CANVAS_PREFERENCES };
  }
}

/** Persists preferences and returns the normalised value that was written. */
export function saveCanvasPreferences(
  preferences: CanvasPreferences,
): CanvasPreferences {
  const next = normalizeCanvasPreferences(preferences);
  const storage = getStorage();

  if (storage) {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Quota/private-mode failures must not break the editor.
    }
  }

  if (typeof window !== "undefined") {
    try {
      window.dispatchEvent(new Event(CHANGE_EVENT));
    } catch {
      // Event dispatch is best-effort (non-browser test environments).
    }
  }

  return next;
}

/** Applies a partial update and persists the result. */
export function updateCanvasPreferences(
  patch: Partial<CanvasPreferences>,
): CanvasPreferences {
  return saveCanvasPreferences({ ...readCanvasPreferences(), ...patch });
}

/**
 * Subscribes to preference changes from this tab (custom event) and other
 * extension tabs/windows (`storage` event). Returns an unsubscribe function.
 */
export function subscribeCanvasPreferences(listener: () => void): () => void {
  if (typeof window === "undefined") {
    return () => undefined;
  }

  const handleStorage = (event: StorageEvent): void => {
    if (event.key === STORAGE_KEY || event.key === null) {
      listener();
    }
  };
  const handleLocal = (): void => listener();

  window.addEventListener("storage", handleStorage);
  window.addEventListener(CHANGE_EVENT, handleLocal);

  return () => {
    window.removeEventListener("storage", handleStorage);
    window.removeEventListener(CHANGE_EVENT, handleLocal);
  };
}

/** Resolves a theme preference against the current OS setting. */
export function resolveThemePreference(
  preference: ThemePreference,
  systemPrefersDark: boolean,
): "light" | "dark" {
  if (preference === "system") {
    return systemPrefersDark ? "dark" : "light";
  }
  return preference;
}
