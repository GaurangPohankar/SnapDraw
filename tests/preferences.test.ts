import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CANVAS_BACKGROUND_OPTIONS,
  DEFAULT_CANVAS_PREFERENCES,
  normalizeCanvasPreferences,
  readCanvasPreferences,
  resolveThemePreference,
  saveCanvasPreferences,
  subscribeCanvasPreferences,
  updateCanvasPreferences,
} from "../src/services/preferences.service";

class FakeStorage {
  private values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.values.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, String(value));
  }
}

class FakeWindow extends EventTarget {
  localStorage = new FakeStorage();
}

let fakeWindow: FakeWindow;

beforeEach(() => {
  fakeWindow = new FakeWindow();
  vi.stubGlobal("window", fakeWindow);
});

describe("canvas preferences", () => {
  it("defaults to the system theme and a transparent canvas", () => {
    expect(readCanvasPreferences()).toEqual(DEFAULT_CANVAS_PREFERENCES);
    expect(DEFAULT_CANVAS_PREFERENCES).toEqual({
      theme: "system",
      background: "transparent",
    });
  });

  it("normalises missing, corrupt and unsupported values", () => {
    expect(normalizeCanvasPreferences(null)).toEqual(DEFAULT_CANVAS_PREFERENCES);
    expect(normalizeCanvasPreferences("dark")).toEqual(DEFAULT_CANVAS_PREFERENCES);
    expect(
      normalizeCanvasPreferences({ theme: "neon", background: "#ff00ff" }),
    ).toEqual(DEFAULT_CANVAS_PREFERENCES);
    expect(normalizeCanvasPreferences({ theme: "dark", background: "#000000" })).toEqual({
      theme: "dark",
      background: "#000000",
    });
  });

  it("persists a valid preferences object and reads it back", () => {
    const saved = saveCanvasPreferences({ theme: "light", background: "#ffffff" });
    expect(saved).toEqual({ theme: "light", background: "#ffffff" });
    expect(readCanvasPreferences()).toEqual(saved);
  });

  it("applies partial updates on top of the current preferences", () => {
    saveCanvasPreferences({ theme: "dark", background: "#1e1e1e" });
    expect(updateCanvasPreferences({ theme: "system" })).toEqual({
      theme: "system",
      background: "#1e1e1e",
    });
    expect(updateCanvasPreferences({ background: "#f1f3f5" })).toEqual({
      theme: "system",
      background: "#f1f3f5",
    });
  });

  it("ignores storage that cannot be parsed", () => {
    fakeWindow.localStorage.setItem("snapdraw.canvas-preferences.v1", "{not json");
    expect(readCanvasPreferences()).toEqual(DEFAULT_CANVAS_PREFERENCES);
  });

  it("notifies subscribers of local changes", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeCanvasPreferences(listener);
    updateCanvasPreferences({ theme: "dark" });
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    updateCanvasPreferences({ theme: "light" });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("resolves the system preference against the OS setting", () => {
    expect(resolveThemePreference("system", true)).toBe("dark");
    expect(resolveThemePreference("system", false)).toBe("light");
    expect(resolveThemePreference("light", true)).toBe("light");
    expect(resolveThemePreference("dark", false)).toBe("dark");
  });

  it("every background option has a value and label", () => {
    expect(CANVAS_BACKGROUND_OPTIONS.length).toBeGreaterThanOrEqual(6);
    for (const option of CANVAS_BACKGROUND_OPTIONS) {
      expect(option.value.trim().length).toBeGreaterThan(0);
      expect(option.label.trim().length).toBeGreaterThan(0);
    }
  });
});
