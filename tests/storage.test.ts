/**
 * Local screenshot storage (IndexedDB) contract.
 *
 * `fake-indexeddb/auto` must be loaded before the storage service touches the
 * global `indexedDB`; importing it first also mirrors the extension ordering.
 */
import "fake-indexeddb/auto";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  closeDatabase,
  countScreenshots,
  deleteScreenshot,
  getScreenshot,
  listScreenshots,
  purgeExpiredScreenshots,
  putScreenshot,
} from "../src/services/storage.service";
import { SESSION_TTL_MS } from "../src/utils/messaging";
import type { ScreenshotRecord } from "../src/types";

const DATABASE_NAME = "snapdraw";
const TTL = 60_000;
const MB = 1024 * 1024;

/** Repeating byte pattern: a truncated/zero-filled clone would be detected. */
function patternedBytes(size: number, seed = 0): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) {
    bytes[index] = (index + seed) % 251;
  }
  return bytes;
}

function blobOf(bytes: Uint8Array, type = "image/png"): Blob {
  // Copy into a plain ArrayBuffer so the Blob owns exactly these bytes.
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return new Blob([buffer], { type });
}

function makeRecord(overrides: Partial<ScreenshotRecord> = {}): ScreenshotRecord {
  const blob = overrides.blob ?? blobOf(patternedBytes(32));
  return {
    id: "session-1",
    name: "Screenshot 2026-11-07 21-55",
    createdAt: 1_700_000_000_000,
    width: 1280,
    height: 720,
    mimeType: blob.type || "image/png",
    size: blob.size,
    ...overrides,
    blob,
  };
}

/**
 * Delete the fake database between tests. `deleteDatabase` is the only reliable
 * reset with fake-indexeddb: closing the cached connection first is required,
 * otherwise the request fires `onblocked`.
 */
function deleteDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () =>
      reject(request.error ?? new Error("Could not delete the test database."));
    request.onblocked = () =>
      reject(new Error("Test database deletion was blocked."));
  });
}

beforeEach(async () => {
  await closeDatabase();
  await deleteDatabase();
});

afterAll(async () => {
  await closeDatabase();
  await deleteDatabase();
});

describe("screenshot storage", () => {
  it("round-trips a 4 MB blob byte-for-byte", async () => {
    const size = 4 * MB;
    const bytes = patternedBytes(size, 7);
    const record = makeRecord({
      id: "big-session",
      createdAt: 1_700_000_000_123,
      width: 3840,
      height: 2160,
      size,
      blob: blobOf(bytes),
      sourceUrl: "https://example.com/article",
      sourceTitle: "An article",
    });

    await putScreenshot(record);
    const stored = await getScreenshot("big-session");

    expect(stored).toBeDefined();
    expect(stored!.id).toBe("big-session");
    expect(stored!.name).toBe(record.name);
    expect(stored!.createdAt).toBe(1_700_000_000_123);
    expect(stored!.width).toBe(3840);
    expect(stored!.height).toBe(2160);
    expect(stored!.mimeType).toBe("image/png");
    expect(stored!.size).toBe(size);
    expect(stored!.sourceUrl).toBe("https://example.com/article");
    expect(stored!.sourceTitle).toBe("An article");

    expect(stored!.blob).toBeInstanceOf(Blob);
    expect(stored!.blob.size).toBe(size);
    expect(stored!.blob.type).toBe("image/png");

    const storedBytes = new Uint8Array(await stored!.blob.arrayBuffer());
    expect(storedBytes.byteLength).toBe(size);
    expect(Array.from(storedBytes.subarray(0, 16))).toEqual(
      Array.from(bytes.subarray(0, 16)),
    );
    expect(Array.from(storedBytes.subarray(size - 16))).toEqual(
      Array.from(bytes.subarray(size - 16)),
    );
    // Spot check the middle so a truncated clone cannot pass on header only.
    expect(storedBytes[Math.floor(size / 2)]).toBe(bytes[Math.floor(size / 2)]);
  });

  it("resolves undefined for a missing id", async () => {
    await expect(getScreenshot("does-not-exist")).resolves.toBeUndefined();
  });

  it("deletes a record and leaves the others alone", async () => {
    await putScreenshot(makeRecord({ id: "a", name: "A" }));
    await putScreenshot(makeRecord({ id: "b", name: "B" }));

    await deleteScreenshot("a");

    await expect(getScreenshot("a")).resolves.toBeUndefined();
    expect((await getScreenshot("b"))?.id).toBe("b");
    await expect(countScreenshots()).resolves.toBe(1);
  });

  it("keeps three concurrent capture sessions isolated", async () => {
    const records = [0, 1, 2].map((index) =>
      makeRecord({
        id: `session-${index}`,
        name: `Capture ${index}`,
        createdAt: 1_700_000_000_000 + index,
        width: 100 + index,
        height: 200 + index,
        blob: blobOf(new Uint8Array(100 + index * 50).fill(index + 1)),
      }),
    );

    await Promise.all(records.map((record) => putScreenshot(record)));

    const stored = await Promise.all(
      records.map((record) => getScreenshot(record.id)),
    );

    expect(stored.map((record) => record?.id)).toEqual([
      "session-0",
      "session-1",
      "session-2",
    ]);

    for (const [index, record] of stored.entries()) {
      expect(record).toBeDefined();
      expect(record!.name).toBe(`Capture ${index}`);
      expect(record!.width).toBe(100 + index);
      expect(record!.height).toBe(200 + index);
      expect(record!.createdAt).toBe(1_700_000_000_000 + index);
      expect(record!.blob.size).toBe(100 + index * 50);
      expect(record!.size).toBe(100 + index * 50);
      // Empty record payloads are filled with the session index: proves the
      // stored blob belongs to this session and not a neighbour.
      const firstByte = new Uint8Array(
        await record!.blob.arrayBuffer(),
      )[0];
      expect(firstByte).toBe(index + 1);
    }

    await expect(listScreenshots()).resolves.toHaveLength(3);
  });

  it("lists metadata only, newest first", async () => {
    await putScreenshot(makeRecord({ id: "oldest", createdAt: 1_000 }));
    await putScreenshot(makeRecord({ id: "newest", createdAt: 3_000 }));
    await putScreenshot(makeRecord({ id: "middle", createdAt: 2_000 }));

    const list = await listScreenshots();

    expect(list.map((meta) => meta.id)).toEqual(["newest", "middle", "oldest"]);
    for (const meta of list) {
      expect(meta).not.toHaveProperty("blob");
      expect(Object.keys(meta).sort()).toEqual([
        "createdAt",
        "height",
        "id",
        "mimeType",
        "name",
        "size",
        "width",
      ]);
      expect(meta.size).toBe(32);
    }
  });

  it("purges only records older than the TTL, using the injected clock", async () => {
    const now = 1_700_000_000_000;
    await putScreenshot(makeRecord({ id: "fresh", createdAt: now }));
    await putScreenshot(
      makeRecord({ id: "boundary", createdAt: now - TTL }),
    );
    await putScreenshot(
      makeRecord({ id: "expired", createdAt: now - TTL - 1 }),
    );
    await putScreenshot(
      makeRecord({ id: "ancient", createdAt: now - 10 * TTL }),
    );

    await expect(purgeExpiredScreenshots(TTL, now)).resolves.toBe(2);

    const remaining = await listScreenshots();
    expect(remaining.map((meta) => meta.id).sort()).toEqual([
      "boundary",
      "fresh",
    ]);
    await expect(countScreenshots()).resolves.toBe(2);
  });

  it("uses the 10 minute session TTL by default", async () => {
    const now = Date.now();
    await putScreenshot(
      makeRecord({
        id: "stale",
        createdAt: now - SESSION_TTL_MS - 10_000,
      }),
    );
    await putScreenshot(makeRecord({ id: "fresh", createdAt: now }));

    await expect(purgeExpiredScreenshots()).resolves.toBe(1);
    const remaining = await listScreenshots();
    expect(remaining.map((meta) => meta.id)).toEqual(["fresh"]);
  });

  it("counts stored screenshots", async () => {
    await expect(countScreenshots()).resolves.toBe(0);

    await putScreenshot(makeRecord({ id: "one" }));
    await putScreenshot(makeRecord({ id: "two" }));

    await expect(countScreenshots()).resolves.toBe(2);
  });

  it("overwrites a record stored under the same id", async () => {
    await putScreenshot(makeRecord({ id: "same", name: "First" }));
    await putScreenshot(makeRecord({ id: "same", name: "Second" }));

    await expect(countScreenshots()).resolves.toBe(1);
    expect((await getScreenshot("same"))?.name).toBe("Second");
  });
});
