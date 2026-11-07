/**
 * Recording service: tab-capture stream handover, naming and persisting the
 * finished WebM as a video history record.
 */
import "fake-indexeddb/auto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildRecordingName,
  getTabCaptureStreamId,
  saveRecording,
} from "../src/services/recording.service";
import { getScreenshot, listScreenshots } from "../src/services/storage.service";

function blobOf(bytes: Uint8Array, type = "video/webm"): Blob {
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return new Blob([buffer], { type });
}

beforeEach(() => {
  vi.spyOn(console, "debug").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("buildRecordingName", () => {
  it("formats a filename-safe local timestamp", () => {
    const name = buildRecordingName(new Date(2026, 10, 8, 0, 20, 5));
    expect(name).toBe("Recording 2026-11-08 at 00.20.05");
  });

  it("falls back to the current time for invalid dates", () => {
    expect(buildRecordingName(new Date("nope"))).toMatch(
      /^Recording \d{4}-\d{2}-\d{2} at \d{2}\.\d{2}\.\d{2}$/,
    );
  });
});

describe("getTabCaptureStreamId", () => {
  it("returns the stream id and passes the target tab", async () => {
    const getMediaStreamId = vi.fn((_options: unknown, callback: (id: string) => void) => {
      callback("stream-123");
    });
    vi.stubGlobal("chrome", {
      runtime: { lastError: undefined },
      tabCapture: { getMediaStreamId },
    });

    await expect(getTabCaptureStreamId(7)).resolves.toBe("stream-123");
    expect(getMediaStreamId).toHaveBeenCalledWith(
      { targetTabId: 7 },
      expect.any(Function),
    );
  });

  it("maps chrome.runtime.lastError to a typed SnapDrawError", async () => {
    const runtime: { lastError: { message: string } | undefined } = {
      lastError: undefined,
    };
    vi.stubGlobal("chrome", {
      runtime,
      tabCapture: {
        getMediaStreamId: (_options: unknown, callback: (id: string) => void) => {
          runtime.lastError = { message: "Cannot capture this tab" };
          callback("");
          runtime.lastError = undefined;
        },
      },
    });

    await expect(getTabCaptureStreamId(7)).rejects.toMatchObject({
      name: "SnapDrawError",
      code: "CAPTURE_FAILED",
    });
  });

  it("fails clearly when tabCapture is unavailable", async () => {
    vi.stubGlobal("chrome", { runtime: { lastError: undefined } });

    await expect(getTabCaptureStreamId(7)).rejects.toMatchObject({
      name: "SnapDrawError",
      code: "CAPTURE_FAILED",
    });
  });
});

describe("saveRecording", () => {
  it("stores a video record with kind and duration", async () => {
    const bytes = new Uint8Array(2048).fill(7);
    const blob = blobOf(bytes);
    const saved = await saveRecording({
      blob,
      width: 640,
      height: 360,
      durationMs: 4_200,
    });

    expect(saved.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(saved.name).toMatch(/^Recording /);

    const record = await getScreenshot(saved.id);
    expect(record?.kind).toBe("video");
    expect(record?.durationMs).toBe(4_200);
    expect(record?.width).toBe(640);
    expect(record?.height).toBe(360);
    expect(record?.mimeType).toBe("video/webm");
    expect(record?.blob.size).toBe(bytes.length);

    const history = await listScreenshots();
    expect(history.some((entry) => entry.id === saved.id && entry.kind === "video")).toBe(
      true,
    );
  });
});
