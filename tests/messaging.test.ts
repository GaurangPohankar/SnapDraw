import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeRequest } from "../src/types";
import {
  buildEditorErrorUrl,
  buildEditorUrl,
  errorPayload,
  isExtensionContext,
  onRuntimeMessage,
  readEditorErrorParam,
  readSessionId,
  requestCapture,
  SnapDrawError,
} from "../src/utils/messaging";

const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";

type RuntimeMessageListener = (
  message: unknown,
  sender: unknown,
  sendResponse: (response?: unknown) => void,
) => boolean | undefined;

interface ChromeRuntimeStub {
  id?: string;
  getURL: (path: string) => string;
  sendMessage: (message: RuntimeRequest) => Promise<unknown>;
  onMessage: {
    addListener: (listener: RuntimeMessageListener) => void;
  };
}

interface ChromeStub {
  runtime: ChromeRuntimeStub;
}

function makeChrome(
  options: {
    id?: string | null;
    getURL?: (path: string) => string;
    sendMessage?: (message: RuntimeRequest) => Promise<unknown>;
    listeners?: RuntimeMessageListener[];
  } = {},
): ChromeStub {
  const listeners = options.listeners ?? [];
  const id = options.id === undefined ? EXTENSION_ID : options.id;
  const runtime: ChromeRuntimeStub = {
    getURL:
      options.getURL ??
      ((path: string) =>
        `chrome-extension://${EXTENSION_ID}/${path.replace(/^\/+/, "")}`),
    sendMessage: options.sendMessage ?? vi.fn(async () => undefined),
    onMessage: {
      addListener: (listener) => {
        listeners.push(listener);
      },
    },
  };
  if (id) {
    runtime.id = id;
  }
  return { runtime };
}

function installChrome(
  options: Parameters<typeof makeChrome>[0] = {},
): ChromeStub {
  const stub = makeChrome(options);
  vi.stubGlobal("chrome", stub as unknown as typeof chrome);
  return stub;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("readSessionId", () => {
  it.each([
    ["?session=abc123", "abc123"],
    ["?foo=1&session=abc123&bar=2", "abc123"],
    ["?session=%20%20abc%20", "abc"],
    ["?session=a%26b%3Dc", "a&b=c"],
    ["?session=", null],
    ["?session=%20%20", null],
    ["?other=1", null],
    ["", null],
    ["?session=first&session=second", "first"],
  ])("parses %s -> %s", (search, expected) => {
    expect(readSessionId(search)).toBe(expected);
  });
});

describe("readEditorErrorParam", () => {
  it.each([
    [
      "?error=RESTRICTED_PAGE&message=Not%20available",
      { code: "RESTRICTED_PAGE", message: "Not available" },
    ],
    ["?error=CAPTURE_FAILED", { code: "CAPTURE_FAILED", message: undefined }],
    ["?error=UNKNOWN&message=%E2%9C%93", { code: "UNKNOWN", message: "✓" }],
    ["?message=orphan", null],
    ["?error=", null],
    ["", null],
  ])("parses %s", (search, expected) => {
    expect(readEditorErrorParam(search)).toEqual(expected);
  });
});

describe("errorPayload", () => {
  it("builds an error payload without a hint", () => {
    const payload = errorPayload("CAPTURE_FAILED", "Capture failed.");

    expect(payload).toEqual({ code: "CAPTURE_FAILED", message: "Capture failed." });
    expect(payload).not.toHaveProperty("hint");
  });

  it("includes the hint when provided", () => {
    expect(
      errorPayload("RESTRICTED_PAGE", "Cannot capture this page.", "Try another tab."),
    ).toEqual({
      code: "RESTRICTED_PAGE",
      message: "Cannot capture this page.",
      hint: "Try another tab.",
    });
  });
});

describe("isExtensionContext", () => {
  it("is false when chrome is unavailable", () => {
    vi.stubGlobal("chrome", undefined);
    expect(isExtensionContext()).toBe(false);
  });

  it("is false when chrome.runtime.id is missing or not a string", () => {
    installChrome({ id: null });
    expect(isExtensionContext()).toBe(false);

    vi.stubGlobal("chrome", { runtime: { id: 42 } });
    expect(isExtensionContext()).toBe(false);
  });

  it("is true when chrome.runtime.id is a string", () => {
    installChrome();
    expect(isExtensionContext()).toBe(true);
  });
});

describe("buildEditorUrl", () => {
  it("builds a chrome-extension editor URL with the session parameter", () => {
    installChrome();

    const url = buildEditorUrl("session-123");

    expect(url).toBe(
      `chrome-extension://${EXTENSION_ID}/src/editor/editor.html?session=session-123`,
    );
    expect(url.startsWith("chrome-extension://")).toBe(true);
  });

  it("URL-encodes the session id so it round-trips through readSessionId", () => {
    installChrome();

    const url = buildEditorUrl("a&b=c d");

    expect(url).toContain("session=a%26b%3Dc+d");
    expect(readSessionId(new URL(url).search)).toBe("a&b=c d");
  });

  it("throws a SnapDrawError outside the extension context", () => {
    vi.stubGlobal("chrome", undefined);

    expect(() => buildEditorUrl("session-123")).toThrow(SnapDrawError);
    try {
      buildEditorUrl("session-123");
    } catch (error) {
      expect((error as SnapDrawError).code).toBe("UNKNOWN");
      expect((error as SnapDrawError).message).toBe(
        "SnapDraw needs to run inside Chrome.",
      );
    }
  });
});

describe("buildEditorErrorUrl", () => {
  it("builds an error URL with the code and encoded message", () => {
    installChrome();

    const url = buildEditorErrorUrl(
      "RESTRICTED_PAGE",
      "Cannot capture this page",
    );

    expect(url).toBe(
      `chrome-extension://${EXTENSION_ID}/src/editor/editor.html?error=RESTRICTED_PAGE&message=Cannot+capture+this+page`,
    );
    expect(readEditorErrorParam(new URL(url).search)).toEqual({
      code: "RESTRICTED_PAGE",
      message: "Cannot capture this page",
    });
  });

  it("omits the message parameter when no message is given", () => {
    installChrome();

    const url = buildEditorErrorUrl("CAPTURE_FAILED");

    expect(url.endsWith("?error=CAPTURE_FAILED")).toBe(true);
    expect(readEditorErrorParam(new URL(url).search)).toEqual({
      code: "CAPTURE_FAILED",
      message: undefined,
    });
  });
});

describe("requestCapture", () => {
  it("returns a typed UNKNOWN error when chrome is unavailable", async () => {
    vi.stubGlobal("chrome", undefined);

    await expect(requestCapture()).resolves.toEqual({
      ok: false,
      error: {
        code: "UNKNOWN",
        message: "The SnapDraw extension is not available.",
        hint: "Reload the extension from chrome://extensions and try again.",
      },
    });
  });

  it("returns the worker response unchanged and sends the popup source", async () => {
    const workerResponse = {
      ok: true as const,
      sessionId: "session-1",
      name: "Screenshot 2026-11-07 21-55",
      width: 1280,
      height: 720,
      editorTabId: 42,
    };
    const sendMessage = vi.fn(async () => workerResponse);
    installChrome({ sendMessage });

    await expect(requestCapture()).resolves.toBe(workerResponse);
    expect(sendMessage).toHaveBeenCalledWith({
      type: "CAPTURE_SCREENSHOT",
      source: "popup",
    });
  });

  it("forwards the command source", async () => {
    const sendMessage = vi.fn(async () => ({
      ok: true,
      sessionId: "s",
      name: "n",
      width: 1,
      height: 1,
    }));
    installChrome({ sendMessage });

    await requestCapture("command");

    expect(sendMessage).toHaveBeenCalledWith({
      type: "CAPTURE_SCREENSHOT",
      source: "command",
    });
  });

  it("normalises a rejected sendMessage into a typed error", async () => {
    installChrome({
      sendMessage: vi.fn().mockRejectedValue(new Error("Worker exploded")),
    });

    await expect(requestCapture()).resolves.toEqual({
      ok: false,
      error: { code: "UNKNOWN", message: "Worker exploded" },
    });
  });

  it("maps the disconnected-worker rejection to actionable copy", async () => {
    installChrome({
      sendMessage: vi
        .fn()
        .mockRejectedValue(
          new Error("Could not establish connection. Receiving end does not exist."),
        ),
    });

    await expect(requestCapture()).resolves.toEqual({
      ok: false,
      error: {
        code: "UNKNOWN",
        message: "SnapDraw's background worker is not responding.",
        hint: "Reload the extension from chrome://extensions and try again.",
      },
    });
  });

  it.each([null, undefined, {}, "ok", 42])(
    "treats malformed response %j as UNKNOWN",
    async (malformed) => {
      installChrome({ sendMessage: vi.fn(async () => malformed) });

      await expect(requestCapture()).resolves.toEqual({
        ok: false,
        error: {
          code: "UNKNOWN",
          message: "SnapDraw received an unexpected response.",
          hint: "Please try again.",
        },
      });
    },
  );
});

describe("onRuntimeMessage", () => {
  function registerListener(
    handler: Parameters<typeof onRuntimeMessage>[0],
  ): RuntimeMessageListener {
    const listeners: RuntimeMessageListener[] = [];
    installChrome({ listeners });
    onRuntimeMessage(handler);
    expect(listeners).toHaveLength(1);
    return listeners[0]!;
  }

  function nextResponse(): {
    sendResponse: ReturnType<typeof vi.fn>;
    response: Promise<unknown>;
  } {
    let resolveResponse!: (value: unknown) => void;
    const response = new Promise<unknown>((resolve) => {
      resolveResponse = resolve;
    });
    const sendResponse = vi.fn((value?: unknown) => {
      resolveResponse(value);
    });
    return { sendResponse, response };
  }

  it("ignores messages that are not CAPTURE_SCREENSHOT", () => {
    const handler = vi.fn();
    const listener = registerListener(handler);
    const { sendResponse } = nextResponse();

    expect(listener({ type: "OTHER" }, {}, sendResponse)).toBeUndefined();
    expect(listener(null, {}, sendResponse)).toBeUndefined();
    expect(listener("CAPTURE_SCREENSHOT", {}, sendResponse)).toBeUndefined();
    expect(handler).not.toHaveBeenCalled();
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it("handles CAPTURE_SCREENSHOT and responds asynchronously", async () => {
    const message: RuntimeRequest = {
      type: "CAPTURE_SCREENSHOT",
      source: "popup",
    };
    const handler = vi.fn(async () => ({ ok: true, sessionId: "session-1" }));
    const listener = registerListener(handler);
    const { sendResponse, response } = nextResponse();

    expect(listener(message, {}, sendResponse)).toBe(true);
    // The response must be sent after the handler resolves, not synchronously.
    expect(sendResponse).not.toHaveBeenCalled();

    await expect(response).resolves.toEqual({
      ok: true,
      sessionId: "session-1",
    });
    expect(handler).toHaveBeenCalledWith(message);
  });

  it("converts handler rejections into an error payload", async () => {
    const handler = vi.fn(async () => {
      throw new Error("Capture blew up");
    });
    const listener = registerListener(handler);
    const { sendResponse, response } = nextResponse();

    expect(
      listener({ type: "CAPTURE_SCREENSHOT" }, {}, sendResponse),
    ).toBe(true);

    await expect(response).resolves.toEqual({
      ok: false,
      error: { code: "UNKNOWN", message: "Capture blew up" },
    });
  });

  it("converts a synchronous handler throw into an error payload", async () => {
    const handler = vi.fn(() => {
      throw new Error("Handler threw synchronously");
    });
    const listener = registerListener(handler);
    const { sendResponse, response } = nextResponse();

    expect(
      listener({ type: "CAPTURE_SCREENSHOT" }, {}, sendResponse),
    ).toBe(true);

    await expect(response).resolves.toEqual({
      ok: false,
      error: { code: "UNKNOWN", message: "Handler threw synchronously" },
    });
  });

  it("uses generic copy for non-Error rejections", async () => {
    const handler = vi.fn(async () => {
      throw "not an error";
    });
    const listener = registerListener(handler);
    const { sendResponse, response } = nextResponse();

    expect(
      listener({ type: "CAPTURE_SCREENSHOT" }, {}, sendResponse),
    ).toBe(true);

    await expect(response).resolves.toEqual({
      ok: false,
      error: { code: "UNKNOWN", message: "Capture failed unexpectedly." },
    });
  });
});
