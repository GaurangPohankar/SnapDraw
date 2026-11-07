/**
 * Worker capture pipeline: pure helpers plus the never-throwing capture entry
 * point (chrome is fully mocked; IndexedDB is faked).
 */
import "fake-indexeddb/auto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildScreenshotName,
  captureVisibleViewport,
  classifyTabUrl,
  MAX_CAPTURE_EDGE,
  purgeExpiredSessions,
  toErrorPayload,
} from "../src/services/screenshot.service";
import { getScreenshot, putScreenshot, HISTORY_RETENTION_MS } from "../src/services/storage.service";
import { SnapDrawError } from "../src/utils/messaging";

const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";

const UNKNOWN_PAYLOAD = {
  code: "UNKNOWN",
  message: "SnapDraw hit an unexpected error.",
  hint: "Please try again, or reload SnapDraw from chrome://extensions.",
};

type TabsStub = {
  query: ReturnType<typeof vi.fn>;
  captureVisibleTab: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
};

function installChrome(tabs: Partial<TabsStub> = {}): TabsStub {
  const fullTabs: TabsStub = {
    query: vi.fn().mockResolvedValue([]),
    captureVisibleTab: vi
      .fn()
      .mockResolvedValue("data:image/png;base64,iVBORw0KGgo="),
    create: vi.fn().mockResolvedValue({ id: 99 }),
    ...tabs,
  };
  vi.stubGlobal("chrome", {
    runtime: {
      id: EXTENSION_ID,
      getURL: (path: string) =>
        `chrome-extension://${EXTENSION_ID}/${path.replace(/^\/+/, "")}`,
    },
    tabs: fullTabs,
  });
  return fullTabs;
}

function activeTab(url = "https://example.com/article", title = "Example") {
  return [{ id: 3, windowId: 7, url, title }];
}

beforeEach(() => {
  // The pipeline logs diagnostics; keep test output clean.
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "debug").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("classifyTabUrl", () => {
  it.each([
    ["chrome://settings", { restricted: true, reason: "browser-internal" }],
    ["chrome://newtab/", { restricted: true, reason: "browser-internal" }],
    [
      "chrome-untrusted://new-tab-page/",
      { restricted: true, reason: "browser-internal" },
    ],
    [
      "chrome-search://local-ntp/local-ntp.html",
      { restricted: true, reason: "browser-internal" },
    ],
    [
      "chrome-error://chromewebdata/",
      { restricted: true, reason: "browser-internal" },
    ],
    ["edge://settings/privacy", { restricted: true, reason: "browser-internal" }],
    ["brave://settings", { restricted: true, reason: "browser-internal" }],
    ["about:blank", { restricted: true, reason: "browser-internal" }],
    [
      "view-source:https://example.com/",
      { restricted: true, reason: "browser-internal" },
    ],
    [
      "devtools://devtools/bundled/inspector.html",
      { restricted: true, reason: "devtools" },
    ],
    [
      "chrome-extension://abcdefghijklmnop/src/popup/popup.html",
      { restricted: true, reason: "extension-page" },
    ],
    [
      "https://chromewebstore.google.com/detail/abc",
      { restricted: true, reason: "web-store" },
    ],
    [
      "https://www.chromewebstore.google.com/detail/abc",
      { restricted: true, reason: "web-store" },
    ],
    [
      "https://chrome.google.com/webstore/category/extensions",
      { restricted: true, reason: "web-store" },
    ],
    [
      "https://chrome.google.com/webstore",
      { restricted: true, reason: "web-store" },
    ],
    [
      "HTTPS://CHROMEWEBSTORE.GOOGLE.COM/detail/abc",
      { restricted: true, reason: "web-store" },
    ],
    ["https://chrome.google.com/anything-else", { restricted: false }],
    ["https://example.com/article?x=1", { restricted: false }],
    ["http://localhost:3000/", { restricted: false }],
    ["", { restricted: true, reason: "unknown" }],
    ["   ", { restricted: true, reason: "unknown" }],
    [undefined, { restricted: true, reason: "unknown" }],
  ])("classifies %s", (url, expected) => {
    expect(classifyTabUrl(url as string | undefined)).toEqual(expected);
  });
});

describe("buildScreenshotName", () => {
  it("formats the local time as a filename-safe document name", () => {
    const name = buildScreenshotName(new Date(2026, 10, 7, 21, 55, 12));

    expect(name).toBe("Screenshot 2026-11-07 at 21.55.12");
    expect(name).not.toMatch(/[\\/:*?"<>|]/);
  });

  it("zero-pads every component", () => {
    expect(buildScreenshotName(new Date(2026, 0, 5, 3, 4, 9))).toBe(
      "Screenshot 2026-01-05 at 03.04.09",
    );
    expect(buildScreenshotName(new Date(2026, 11, 31, 0, 0, 0))).toBe(
      "Screenshot 2026-12-31 at 00.00.00",
    );
  });

  it("falls back to the current time for an invalid date", () => {
    expect(buildScreenshotName(new Date(Number.NaN))).toMatch(
      /^Screenshot \d{4}-\d{2}-\d{2} at \d{2}\.\d{2}\.\d{2}$/,
    );
  });

  it("uses the current time by default", () => {
    expect(buildScreenshotName()).toMatch(
      /^Screenshot \d{4}-\d{2}-\d{2} at \d{2}\.\d{2}\.\d{2}$/,
    );
  });
});

describe("toErrorPayload", () => {
  it("preserves SnapDrawError code, message and hint", () => {
    const error = new SnapDrawError(
      "RESTRICTED_PAGE",
      "Chrome doesn't allow capturing this page.",
      "Open a normal website tab and try again.",
    );

    expect(toErrorPayload(error)).toEqual({
      code: "RESTRICTED_PAGE",
      message: "Chrome doesn't allow capturing this page.",
      hint: "Open a normal website tab and try again.",
    });
  });

  it("omits the hint when the SnapDrawError has none", () => {
    const payload = toErrorPayload(
      new SnapDrawError("STORAGE_FAILED", "Could not save locally."),
    );

    expect(payload).toEqual({
      code: "STORAGE_FAILED",
      message: "Could not save locally.",
    });
    expect(payload).not.toHaveProperty("hint");
  });

  it("returns UNKNOWN for non-Chrome errors", () => {
    for (const error of [
      new Error("Something odd happened"),
      "plain string",
      null,
      undefined,
      42,
      { some: "object" },
    ]) {
      expect(toErrorPayload(error)).toEqual(UNKNOWN_PAYLOAD);
    }
  });

  it("maps a permission failure to CAPTURE_FAILED", () => {
    const error = new Error(
      "Cannot access contents of the page. Extension manifest must request permission to access this host.",
    );

    expect(toErrorPayload(error)).toEqual({
      code: "CAPTURE_FAILED",
      message: "SnapDraw doesn't have permission to capture this page.",
      hint: "Click the SnapDraw toolbar icon on the page you want to capture, then try again.",
    });
  });

  it("maps a restricted-page capture failure to CAPTURE_FAILED", () => {
    expect(toErrorPayload(new Error("Cannot capture chrome://extensions"))).toEqual(
      {
        code: "CAPTURE_FAILED",
        message: "Chrome doesn't allow capturing this page.",
        hint: "Open a normal website tab and try again.",
      },
    );
  });

  it("maps the capture rate limit to CAPTURE_FAILED", () => {
    expect(
      toErrorPayload(new Error("MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND")),
    ).toEqual({
      code: "CAPTURE_FAILED",
      message: "SnapDraw is capturing too quickly.",
      hint: "Wait a second, then try again.",
    });
  });

  it("maps a hidden-window failure to CAPTURE_FAILED", () => {
    expect(
      toErrorPayload(
        new Error(
          "Failed to capture the page because the window is minimised",
        ),
      ),
    ).toEqual({
      code: "CAPTURE_FAILED",
      message: "SnapDraw couldn't capture the page.",
      hint: "Bring the tab to the front, then try again.",
    });
  });

  it("falls back to generic capture copy and trims the raw message", () => {
    expect(toErrorPayload(new Error("  Failed to capture tab  "))).toEqual({
      code: "CAPTURE_FAILED",
      message: "SnapDraw couldn't capture the page.",
      hint: "Make sure the tab is visible, then try again.",
    });
  });

  it("reads Chrome's plain-object lastError messages", () => {
    expect(
      toErrorPayload({
        message: "Cannot capture this page because permission was denied",
      }),
    ).toEqual({
      code: "CAPTURE_FAILED",
      message: "SnapDraw doesn't have permission to capture this page.",
      hint: "Click the SnapDraw toolbar icon on the page you want to capture, then try again.",
    });
  });
});

describe("captureVisibleViewport", () => {
  it("keeps the documented maximum capture edge", () => {
    expect(MAX_CAPTURE_EDGE).toBe(8192);
  });

  it("never throws when chrome APIs are unavailable", async () => {
    vi.stubGlobal("chrome", undefined);

    await expect(captureVisibleViewport()).resolves.toEqual({
      ok: false,
      error: UNKNOWN_PAYLOAD,
    });
  });

  it("returns NO_ACTIVE_TAB when no tab is found", async () => {
    const tabs = installChrome({ query: vi.fn().mockResolvedValue([]) });

    await expect(captureVisibleViewport()).resolves.toEqual({
      ok: false,
      error: {
        code: "NO_ACTIVE_TAB",
        message: "SnapDraw couldn't find an active tab to capture.",
        hint: "Open a website in Chrome, then try again.",
      },
    });
    expect(tabs.captureVisibleTab).not.toHaveBeenCalled();
  });

  it("returns RESTRICTED_PAGE without attempting the capture", async () => {
    const tabs = installChrome({
      query: vi.fn().mockResolvedValue(activeTab("chrome://settings")),
    });

    await expect(captureVisibleViewport()).resolves.toEqual({
      ok: false,
      error: {
        code: "RESTRICTED_PAGE",
        message: "Chrome doesn't allow capturing this page.",
        hint: "Open a normal website tab and try again.",
      },
    });
    expect(tabs.captureVisibleTab).not.toHaveBeenCalled();
    expect(tabs.create).not.toHaveBeenCalled();
  });

  it("returns a CAPTURE_FAILED permission error when Chrome refuses", async () => {
    const tabs = installChrome({
      query: vi.fn().mockResolvedValue(activeTab()),
      captureVisibleTab: vi.fn().mockRejectedValue(
        new Error(
          "Cannot access contents of the page. Extension manifest must request permission to access this host.",
        ),
      ),
    });

    await expect(captureVisibleViewport()).resolves.toEqual({
      ok: false,
      error: {
        code: "CAPTURE_FAILED",
        message: "SnapDraw doesn't have permission to capture this page.",
        hint: "Click the SnapDraw toolbar icon on the page you want to capture, then try again.",
      },
    });
    expect(tabs.create).not.toHaveBeenCalled();
  });

  it("rejects an empty capture payload", async () => {
    const tabs = installChrome({
      query: vi.fn().mockResolvedValue(activeTab()),
      captureVisibleTab: vi.fn().mockResolvedValue(""),
    });

    await expect(captureVisibleViewport()).resolves.toEqual({
      ok: false,
      error: {
        code: "CAPTURE_FAILED",
        message: "Chrome returned an empty screenshot.",
        hint: "Make sure the page is fully loaded, then try again.",
      },
    });
    expect(tabs.create).not.toHaveBeenCalled();
  });

  it("rejects screenshots larger than MAX_CAPTURE_EDGE", async () => {
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => ({
        width: MAX_CAPTURE_EDGE + 1,
        height: 100,
        close: vi.fn(),
      })),
    );
    const tabs = installChrome({
      query: vi.fn().mockResolvedValue(activeTab()),
    });

    await expect(captureVisibleViewport()).resolves.toEqual({
      ok: false,
      error: {
        code: "CAPTURE_FAILED",
        message: "The captured screenshot is too large for SnapDraw.",
        hint: "Resize the browser window so each side is at most 8192px, then try again.",
      },
    });
    expect(tabs.create).not.toHaveBeenCalled();
  });

  it("stores the capture and opens the editor tab on success", async () => {
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => ({ width: 1280, height: 720, close: vi.fn() })),
    );
    const tabs = installChrome({
      query: vi.fn().mockResolvedValue(activeTab()),
    });

    const response = await captureVisibleViewport("command");

    expect(response.ok).toBe(true);
    if (!response.ok) {
      throw new Error(`expected a successful capture, got ${JSON.stringify(response)}`);
    }
    expect(response.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(response.name).toMatch(
      /^Screenshot \d{4}-\d{2}-\d{2} at \d{2}\.\d{2}\.\d{2}$/,
    );
    expect(response.width).toBe(1280);
    expect(response.height).toBe(720);
    expect(response.editorTabId).toBe(99);

    expect(tabs.captureVisibleTab).toHaveBeenCalledWith(7, { format: "png" });
    expect(tabs.create).toHaveBeenCalledWith({
      url: `chrome-extension://${EXTENSION_ID}/src/editor/editor.html?session=${response.sessionId}`,
      active: true,
    });

    const stored = await getScreenshot(response.sessionId);
    expect(stored).toBeDefined();
    expect(stored!.name).toBe(response.name);
    expect(stored!.width).toBe(1280);
    expect(stored!.height).toBe(720);
    expect(stored!.mimeType).toBe("image/png");
    expect(stored!.size).toBe(8);
    expect(stored!.blob.size).toBe(8);
    expect(stored!.sourceUrl).toBe("https://example.com/article");
    expect(stored!.sourceTitle).toBe("Example");
  });

  it("prunes captures older than the history retention window", async () => {
    await putScreenshot({
      id: "stale-session",
      name: "Stale capture",
      createdAt: Date.now() - HISTORY_RETENTION_MS - 5_000,
      width: 10,
      height: 10,
      mimeType: "image/png",
      size: 4,
      blob: new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/png" }),
    });

    await expect(purgeExpiredSessions()).resolves.toBe(1);
    await expect(getScreenshot("stale-session")).resolves.toBeUndefined();
  });

  it("rejects a second capture while one is in progress", async () => {
    let resolveQuery!: (tabs: unknown[]) => void;
    const tabs = installChrome({
      query: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveQuery = resolve;
          }),
      ),
    });

    const first = captureVisibleViewport();
    const second = await captureVisibleViewport();

    expect(second).toEqual({
      ok: false,
      error: {
        code: "CAPTURE_FAILED",
        message: "A screenshot capture is already in progress.",
        hint: "Wait a moment, then try again.",
      },
    });
    expect(tabs.query).toHaveBeenCalledTimes(1);

    resolveQuery([]);
    await expect(first).resolves.toEqual({
      ok: false,
      error: {
        code: "NO_ACTIVE_TAB",
        message: "SnapDraw couldn't find an active tab to capture.",
        hint: "Open a website in Chrome, then try again.",
      },
    });
  });
});
