import { useEffect, useState } from "react";

/** Editor theme – matches Excalidraw's own `Theme` union. */
export type EditorTheme = "light" | "dark";

const DARK_QUERY = "(prefers-color-scheme: dark)";

function readTheme(): EditorTheme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return "light";
  }
  return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

/**
 * Follows the OS colour scheme and updates live when the user switches.
 * The header uses the `--sd-*` tokens (already scheme aware) while Excalidraw
 * receives the theme explicitly through its `theme` prop.
 */
export function useColorScheme(): EditorTheme {
  const [theme, setTheme] = useState<EditorTheme>(readTheme);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }

    const query = window.matchMedia(DARK_QUERY);
    const handleChange = (event: MediaQueryListEvent): void => {
      setTheme(event.matches ? "dark" : "light");
    };

    if (typeof query.addEventListener === "function") {
      query.addEventListener("change", handleChange);
      return () => query.removeEventListener("change", handleChange);
    }

    // Older Safari / Chrome fallback.
    query.addListener(handleChange);
    return () => query.removeListener(handleChange);
  }, []);

  return theme;
}
