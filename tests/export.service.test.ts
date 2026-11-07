/**
 * PNG export helpers.
 *
 * Excalidraw's canvas renderer is mocked: these tests cover the pure filename
 * helpers, the typed error mapping and the pre-flight guards, not canvas output.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@excalidraw/excalidraw", () => ({
  exportToBlob: vi.fn(),
  getCommonBounds: vi.fn(() => [0, 0, 0, 0]),
}));

import { exportToBlob, getCommonBounds } from "@excalidraw/excalidraw";

import {
  buildExportFilename,
  DEFAULT_EXPORT_PADDING,
  DEFAULT_EXPORT_SCALE,
  downloadBlob,
  ExportError,
  exportSceneToPngBlob,
} from "../src/services/export.service";

const FIXED_DATE = new Date(2026, 10, 7, 21, 55, 12);

function element(id: string, isDeleted = false): { id: string; isDeleted: boolean } {
  return { id, isDeleted };
}

beforeEach(() => {
  vi.mocked(getCommonBounds).mockReturnValue([0, 0, 100, 100] as never);
  vi.mocked(exportToBlob).mockResolvedValue(
    new Blob(["png"], { type: "image/png" }) as never,
  );
});

describe("buildExportFilename", () => {
  it("turns the document name into a .png file name", () => {
    expect(buildExportFilename("Screenshot 2026-11-07 at 21.55.12")).toBe(
      "Screenshot-2026-11-07-at-21.55.12.png",
    );
  });

  it("strips characters that are illegal in Windows and macOS file names", () => {
    const filename = buildExportFilename('Screenshot: 2026/11/07 *draft*?<>|"');

    expect(filename).toBe("Screenshot-2026-11-07-draft.png");
    expect(filename).not.toMatch(/[<>:"/\\|?*]/);
  });

  it("replaces an existing .png extension instead of doubling it", () => {
    expect(buildExportFilename("my capture.png")).toBe("my-capture.png");
    expect(buildExportFilename("my capture.PNG")).toBe("my-capture.png");
  });

  it("trims leading and trailing dots, dashes and spaces", () => {
    expect(buildExportFilename("  ..capture..  ")).toBe("capture.png");
  });

  it("falls back to a timestamp for names that sanitise to nothing", () => {
    expect(buildExportFilename("   ", FIXED_DATE)).toBe(
      "screenshot-2026-11-07-at-21-55-12.png",
    );
    expect(buildExportFilename("///", FIXED_DATE)).toBe(
      "screenshot-2026-11-07-at-21-55-12.png",
    );
  });

  it("truncates very long names to the maximum base length", () => {
    expect(buildExportFilename("a".repeat(200))).toBe(
      `${"a".repeat(120)}.png`,
    );
  });

  it("keeps unicode letters", () => {
    expect(buildExportFilename("Café ☕")).toBe("Café-☕.png");
  });
});

describe("ExportError", () => {
  it("carries the machine readable code and optional hint", () => {
    const error = new ExportError("EMPTY_SCENE", "Nothing to export.", "Try again.");

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ExportError");
    expect(error.code).toBe("EMPTY_SCENE");
    expect(error.message).toBe("Nothing to export.");
    expect(error.hint).toBe("Try again.");
  });
});

describe("exportSceneToPngBlob", () => {
  it("exposes the documented padding and scale defaults", () => {
    expect(DEFAULT_EXPORT_PADDING).toBe(16);
    expect(DEFAULT_EXPORT_SCALE).toBe(1);
  });

  it("rejects an empty scene", async () => {
    await expect(
      exportSceneToPngBlob({ elements: [], files: {}, appState: null }),
    ).rejects.toMatchObject({
      code: "EMPTY_SCENE",
      message: "There is nothing to export yet.",
    });
  });

  it("ignores deleted elements when deciding the scene is empty", async () => {
    await expect(
      exportSceneToPngBlob({
        elements: [element("a", true), element("b", true)] as never,
        files: {},
        appState: null,
      }),
    ).rejects.toMatchObject({ code: "EMPTY_SCENE" });
  });

  it("fails early when the scene exceeds the canvas edge limit", async () => {
    vi.mocked(getCommonBounds).mockReturnValue([0, 0, 20000, 100] as never);

    await expect(
      exportSceneToPngBlob({
        elements: [element("a")] as never,
        files: {},
        appState: null,
      }),
    ).rejects.toMatchObject({
      code: "CANVAS_TOO_LARGE",
      message: "This scene is too large to export as one PNG (20032 × 132px).",
    });
  });

  it("renders only live elements with a light export app state", async () => {
    const blob = new Blob(["png"], { type: "image/png" });
    vi.mocked(exportToBlob).mockResolvedValue(blob as never);

    const result = await exportSceneToPngBlob({
      elements: [element("live"), element("deleted", true)] as never,
      files: {},
      appState: null,
    });

    expect(result).toBe(blob);
    expect(exportToBlob).toHaveBeenCalledTimes(1);
    const options = vi.mocked(exportToBlob).mock.calls[0][0] as {
      elements: { id: string }[];
      appState: Record<string, unknown>;
      files: unknown;
      mimeType: string;
      exportPadding: number;
    };
    expect(options.elements.map((value) => value.id)).toEqual(["live"]);
    expect(options.mimeType).toBe("image/png");
    expect(options.exportPadding).toBe(DEFAULT_EXPORT_PADDING);
    expect(options.appState).toMatchObject({
      exportBackground: true,
      exportWithDarkMode: false,
      viewBackgroundColor: "#ffffff",
      exportScale: DEFAULT_EXPORT_SCALE,
    });
  });

  it("maps canvas render failures to EXPORT_FAILED", async () => {
    vi.mocked(exportToBlob).mockRejectedValue(
      new Error("The canvas is too large to render") as never,
    );

    await expect(
      exportSceneToPngBlob({
        elements: [element("a")] as never,
        files: {},
        appState: null,
      }),
    ).rejects.toMatchObject({
      code: "EXPORT_FAILED",
      message: "The annotated screenshot could not be rendered.",
      hint: "Try again, or capture a smaller window.",
    });
  });

  it("keeps the raw detail for unexpected render failures", async () => {
    vi.mocked(exportToBlob).mockRejectedValue(new Error("boom") as never);

    await expect(
      exportSceneToPngBlob({
        elements: [element("a")] as never,
        files: {},
        appState: null,
      }),
    ).rejects.toMatchObject({ code: "EXPORT_FAILED", hint: "boom" });
  });
});

describe("downloadBlob", () => {
  it("refuses to download without a DOM", () => {
    expect(() => downloadBlob(new Blob(["x"]), "x.png")).toThrow(ExportError);

    try {
      downloadBlob(new Blob(["x"]), "x.png");
    } catch (error) {
      expect((error as ExportError).code).toBe("EXPORT_FAILED");
      expect((error as ExportError).hint).toBe("Use Copy Image instead.");
    }
  });
});
