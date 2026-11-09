import { useCallback, useEffect, useMemo, useState } from "react";
import {
  readCanvasPreferences,
  resolveThemePreference,
  subscribeCanvasPreferences,
  updateCanvasPreferences,
  type CanvasPreferences,
  type ThemePreference,
} from "../services/preferences.service";
import type { EditorTheme } from "./useColorScheme";

const DARK_MEDIA_QUERY = "(prefers-color-scheme: dark)";

function systemPrefersDarkNow(): boolean {
  try {
    return (
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia(DARK_MEDIA_QUERY).matches
    );
  } catch {
    return false;
  }
}

export interface UseCanvasPreferencesResult {
  preferences: CanvasPreferences;
  /** Resolved "light" | "dark" after applying the System preference. */
  theme: EditorTheme;
  /** Resolved scene background (may be "transparent"). */
  background: string;
  setTheme: (theme: ThemePreference) => void;
  setBackground: (background: string) => void;
}

/**
 * Shared, persisted editor preferences: theme and canvas background.
 *
 * Reads/writes the local preference store and follows OS theme changes while
 * the preference is "system". Other extension tabs pick up writes through the
 * store's storage-event subscription.
 */
export function useCanvasPreferences(): UseCanvasPreferencesResult {
  const [preferences, setPreferences] = useState<CanvasPreferences>(() =>
    readCanvasPreferences(),
  );
  const [systemPrefersDark, setSystemPrefersDark] = useState(systemPrefersDarkNow);

  useEffect(() => subscribeCanvasPreferences(() => setPreferences(readCanvasPreferences())), []);

  useEffect(() => {
    if (preferences.theme !== "system") {
      return undefined;
    }

    let media: MediaQueryList | null = null;
    try {
      media = window.matchMedia(DARK_MEDIA_QUERY);
    } catch {
      return undefined;
    }

    const handleChange = (): void => setSystemPrefersDark(media?.matches ?? false);
    handleChange();

    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", handleChange);
      return () => media?.removeEventListener("change", handleChange);
    }

    // Safari/older WebKit fallback; Chrome uses addEventListener above.
    media.addListener(handleChange);
    return () => media?.removeListener(handleChange);
  }, [preferences.theme]);

  const setTheme = useCallback((theme: ThemePreference): void => {
    setPreferences(updateCanvasPreferences({ theme }));
  }, []);

  const setBackground = useCallback((background: string): void => {
    setPreferences(updateCanvasPreferences({ background }));
  }, []);

  const theme = useMemo(
    () => resolveThemePreference(preferences.theme, systemPrefersDark),
    [preferences.theme, systemPrefersDark],
  );

  return {
    preferences,
    theme,
    background: preferences.background,
    setTheme,
    setBackground,
  };
}
