/**
 * Small, dependency free image helpers shared by the service worker, the popup
 * and the editor. They deliberately avoid DOM-only APIs where possible so the
 * same code runs in a background service worker.
 */

/** Extracts the mime type from a data URL (falls back to `image/png`). */
export function dataUrlMimeType(dataUrl: string): string {
  const match = /^data:([^;,]+)[;,]/.exec(dataUrl);
  return match?.[1] ?? "image/png";
}

/** Converts a base64 data URL into a `Blob` without touching the DOM. */
export function dataUrlToBlob(dataUrl: string): Blob {
  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex === -1) {
    throw new Error("Invalid data URL: missing payload");
  }

  const header = dataUrl.slice(0, commaIndex);
  const payload = dataUrl.slice(commaIndex + 1);
  const mimeType = dataUrlMimeType(dataUrl);
  const isBase64 = /;base64/i.test(header);

  let bytes: Uint8Array;
  if (isBase64) {
    const binary = atob(payload);
    bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
  } else {
    bytes = new TextEncoder().encode(decodeURIComponent(payload));
  }

  // Copy into a plain ArrayBuffer: `Uint8Array<ArrayBufferLike>` is not
  // assignable to `BlobPart` under the newer TypeScript lib definitions.
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;

  return new Blob([buffer], { type: mimeType });
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  // Encode in slices to stay well below the maximum argument count of
  // `String.fromCharCode`.
  const chunkSize = 0x8000;
  let binary = "";
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const slice = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

/**
 * Converts a `Blob` into a data URL. Uses `FileReader` when available and falls
 * back to manual base64 encoding inside service workers.
 */
export async function blobToDataUrl(blob: Blob): Promise<string> {
  if (typeof FileReader !== "undefined") {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () =>
        reject(reader.error ?? new Error("Could not read the screenshot blob."));
      reader.readAsDataURL(blob);
    });
  }

  const base64 = arrayBufferToBase64(await blob.arrayBuffer());
  return `data:${blob.type || "image/png"};base64,${base64}`;
}

export interface ImageDimensions {
  width: number;
  height: number;
}

/**
 * Reads the natural pixel size of an image blob.
 * Uses `createImageBitmap` which is available in both page and worker scopes.
 */
export async function getImageDimensions(blob: Blob): Promise<ImageDimensions> {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(blob);
    const dimensions = { width: bitmap.width, height: bitmap.height };
    if (typeof bitmap.close === "function") {
      bitmap.close();
    }
    if (dimensions.width > 0 && dimensions.height > 0) {
      return dimensions;
    }
  }

  return getImageDimensionsWithImageElement(blob);
}

function getImageDimensionsWithImageElement(blob: Blob): Promise<ImageDimensions> {
  if (typeof Image === "undefined" || typeof URL === "undefined") {
    return Promise.reject(new Error("Could not read the screenshot size."));
  }

  return new Promise<ImageDimensions>((resolve, reject) => {
    const objectUrl = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve({ width: image.naturalWidth, height: image.naturalHeight });
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("Could not decode the screenshot."));
    };
    image.src = objectUrl;
  });
}

/**
 * Scales `size` down so it fits inside `max`, preserving the aspect ratio.
 * Never scales up.
 */
export function fitWithin(
  size: ImageDimensions,
  max: ImageDimensions,
): ImageDimensions {
  if (size.width <= 0 || size.height <= 0) {
    return { width: 0, height: 0 };
  }

  const scale = Math.min(1, max.width / size.width, max.height / size.height);
  return {
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
  };
}

/** Human readable byte size, used in the editor status bar. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB"];
  const exponent = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024)),
  );
  const value = bytes / 1024 ** exponent;
  return `${value >= 10 || exponent === 0 ? Math.round(value) : value.toFixed(1)} ${units[exponent]}`;
}
