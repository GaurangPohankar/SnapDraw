/**
 * Video helpers: duration/filename formatting, record detection and metadata
 * probing that must degrade gracefully outside a DOM.
 */
import "fake-indexeddb/auto";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildVideoFilename,
  formatDuration,
  isVideoRecord,
  loadVideoRecord,
  pickVideoMimeType,
} from "../src/services/video.service";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("formatDuration", () => {
  it.each([
    [0, "0:00"],
    [999, "0:01"],
    [1000, "0:01"],
    [9_000, "0:09"],
    [59_000, "0:59"],
    [60_000, "1:00"],
    [61_500, "1:02"],
    [3_661_000, "1:01:01"],
    [86_400_000, "24:00:00"],
    [-500, "0:00"],
  ])("formats %i ms as %s", (input, expected) => {
    expect(formatDuration(input)).toBe(expected);
  });
});

describe("buildVideoFilename", () => {
  it("creates a safe .webm filename", () => {
    expect(buildVideoFilename("Recording 2026-11-08 at 00.20.00")).toBe(
      "Recording-2026-11-08-at-00.20.00.webm",
    );
  });

  it("adds a suffix and strips unsafe characters", () => {
    expect(buildVideoFilename('a/b:c*?"<>|', "annotated")).toBe("a-b-c-annotated.webm");
  });

  it("falls back when the name is empty", () => {
    expect(buildVideoFilename("   ")).toBe("snapdraw-recording.webm");
  });
});

describe("isVideoRecord", () => {
  it("uses the kind field when present", () => {
    expect(isVideoRecord({ kind: "video", mimeType: "video/webm" })).toBe(true);
    expect(isVideoRecord({ kind: "image", mimeType: "video/webm" })).toBe(false);
  });

  it("falls back to the mime type for legacy records", () => {
    expect(isVideoRecord({ mimeType: "video/webm" })).toBe(true);
    expect(isVideoRecord({ mimeType: "image/png" })).toBe(false);
  });
});

describe("pickVideoMimeType", () => {
  it("returns undefined when MediaRecorder is unavailable", () => {
    expect(pickVideoMimeType()).toBeUndefined();
  });

  it("returns the first supported webm candidate", () => {
    vi.stubGlobal("MediaRecorder", {
      isTypeSupported: (type: string) => type === "video/webm;codecs=vp8,opus",
    });
    expect(pickVideoMimeType()).toBe("video/webm;codecs=vp8,opus");
  });

  it("returns undefined when nothing is supported", () => {
    vi.stubGlobal("MediaRecorder", { isTypeSupported: () => false });
    expect(pickVideoMimeType()).toBeUndefined();
  });
});

describe("loadVideoRecord", () => {
  it("rejects with a friendly error for a missing session", async () => {
    await expect(loadVideoRecord("does-not-exist")).rejects.toThrow(
      /no longer available/i,
    );
  });
});
