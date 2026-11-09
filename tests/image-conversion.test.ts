import { describe, expect, it } from "vitest";

import {
  blobToDataUrl,
  dataUrlMimeType,
  dataUrlToBlob,
  fitWithin,
  formatBytes,
  getImageDimensions,
  wrapImageDataUrlInSvgDataUrl,
} from "../src/utils/image-conversion";

function bytesOf(buffer: ArrayBuffer): number[] {
  return Array.from(new Uint8Array(buffer));
}

function patternBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) {
    bytes[index] = (index * 7 + 13) % 256;
  }
  return bytes;
}

describe("dataUrlMimeType", () => {
  it.each([
    ["data:image/png;base64,iVBORw0KGgo=", "image/png"],
    ["data:image/jpeg;base64,/9j/4AAQSkZJRg==", "image/jpeg"],
    ["data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>", "image/svg+xml"],
    ["data:text/plain,hello", "text/plain"],
    ["not-a-data-url", "image/png"],
    ["", "image/png"],
  ])("extracts %s -> %s", (dataUrl, expected) => {
    expect(dataUrlMimeType(dataUrl)).toBe(expected);
  });
});

describe("dataUrlToBlob", () => {
  it("decodes base64 payloads into a blob with the right type and bytes", async () => {
    const blob = dataUrlToBlob("data:image/png;base64,AAEC/w==");

    expect(blob.type).toBe("image/png");
    expect(blob.size).toBe(4);
    expect(bytesOf(await blob.arrayBuffer())).toEqual([0, 1, 2, 255]);
  });

  it("decodes percent-encoded (non-base64) payloads as UTF-8", async () => {
    const payload = "hello ✓ world!";
    const blob = dataUrlToBlob(
      `data:text/plain,${encodeURIComponent(payload)}`,
    );

    expect(blob.type).toBe("text/plain");
    expect(blob.size).toBe(new TextEncoder().encode(payload).byteLength);
    expect(new TextDecoder().decode(await blob.arrayBuffer())).toBe(payload);
  });

  it("rejects data URLs without a payload", () => {
    expect(() => dataUrlToBlob("data:image/png;base64")).toThrow(
      "Invalid data URL: missing payload",
    );
  });
});

describe("blobToDataUrl", () => {
  it("round-trips a 64 KB binary blob byte-for-byte", async () => {
    // 64 KB crosses the internal 0x8000-byte btoa chunk boundary.
    const bytes = patternBytes(64 * 1024);
    const blob = new Blob([bytes], { type: "image/png" });

    const dataUrl = await blobToDataUrl(blob);

    expect(dataUrl.startsWith("data:image/png;base64,")).toBe(true);
    const restored = dataUrlToBlob(dataUrl);
    expect(restored.type).toBe("image/png");
    expect(restored.size).toBe(bytes.byteLength);
    expect(bytesOf(await restored.arrayBuffer())).toEqual(Array.from(bytes));
  });

  it("encodes an empty blob with the default png type", async () => {
    const dataUrl = await blobToDataUrl(new Blob([]));

    expect(dataUrl).toBe("data:image/png;base64,");
    expect(dataUrlToBlob(dataUrl).size).toBe(0);
  });
});

describe("fitWithin", () => {
  it("scales a large size down inside the box, preserving aspect ratio", () => {
    expect(
      fitWithin({ width: 1920, height: 1080 }, { width: 960, height: 960 }),
    ).toEqual({ width: 960, height: 540 });
    expect(
      fitWithin({ width: 1080, height: 1920 }, { width: 500, height: 500 }),
    ).toEqual({ width: 281, height: 500 });
  });

  it("never scales up", () => {
    expect(
      fitWithin({ width: 100, height: 50 }, { width: 1000, height: 1000 }),
    ).toEqual({ width: 100, height: 50 });
    expect(
      fitWithin({ width: 800, height: 600 }, { width: 800, height: 600 }),
    ).toEqual({ width: 800, height: 600 });
  });

  it("rounds scaled dimensions to whole pixels", () => {
    expect(
      fitWithin({ width: 1000, height: 333 }, { width: 333, height: 333 }),
    ).toEqual({ width: 333, height: 111 });
  });

  it("guards against zero or negative sizes", () => {
    expect(
      fitWithin({ width: 0, height: 100 }, { width: 500, height: 500 }),
    ).toEqual({ width: 0, height: 0 });
    expect(
      fitWithin({ width: 100, height: 0 }, { width: 500, height: 500 }),
    ).toEqual({ width: 0, height: 0 });
    expect(
      fitWithin({ width: -10, height: -20 }, { width: 500, height: 500 }),
    ).toEqual({ width: 0, height: 0 });
  });
});

describe("wrapImageDataUrlInSvgDataUrl", () => {
  it("wraps the capture as a same-size SVG data URL", () => {
    const wrapped = wrapImageDataUrlInSvgDataUrl(
      "data:image/png;base64,AAAB",
      1200,
      760,
    );

    expect(wrapped.startsWith("data:image/svg+xml;base64,")).toBe(true);

    const svg = atob(wrapped.slice("data:image/svg+xml;base64,".length));
    expect(svg).toContain('width="1200" height="760"');
    expect(svg).toContain('viewBox="0 0 1200 760"');
    expect(svg).toContain('href="data:image/png;base64,AAAB"');
    expect(svg).toContain('preserveAspectRatio="none"');
  });
});

describe("formatBytes", () => {
  it.each([
    [0, "0 B"],
    [-1, "0 B"],
    [Number.NaN, "0 B"],
    [Number.POSITIVE_INFINITY, "0 B"],
    [1, "1 B"],
    [512, "512 B"],
    [1023, "1023 B"],
    [1024, "1.0 KB"],
    [1536, "1.5 KB"],
    [10240, "10 KB"],
    [1024 * 1024, "1.0 MB"],
    [5 * 1024 ** 3, "5.0 GB"],
    [1024 ** 4, "1024 GB"],
  ])("formats %s bytes as %s", (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });
});

describe("getImageDimensions", () => {
  it("rejects with an Error in a Node environment instead of hanging", async () => {
    // The node test environment has no createImageBitmap/Image; the helper must
    // fail fast on the fallback path rather than leave a pending promise.
    expect(typeof createImageBitmap).toBe("undefined");
    expect(typeof Image).toBe("undefined");

    const blob = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], {
      type: "image/png",
    });
    const promise = getImageDimensions(blob);

    await expect(promise).rejects.toBeInstanceOf(Error);
    await expect(promise).rejects.toThrow(
      "Could not read the screenshot size.",
    );
  });
});
