import { createRequire } from "node:module";

// `defineConfig` comes from "vitest/config", but it is loaded through
// `createRequire` rather than a static import on purpose: Vite bundles config
// files with a resolver whose first run shells out (`net use`) on Windows. That
// call is unavailable in restricted/sandboxed environments and makes even
// `npx vitest run` fail before any test executes. The CommonJS entry of
// "vitest/config" is a plain re-export, so requiring it is equivalent.
const require = createRequire(import.meta.url);
const { defineConfig } = require("vitest/config") as typeof import("vitest/config");

/**
 * Unit test runner for SnapDraw's non-DOM logic.
 *
 * Everything tested here runs in plain Node: the storage layer against
 * `fake-indexeddb`, the messaging/image helpers against stubbed globals, and the
 * manifest against the source tree. No browser, no service worker, no network.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Worker threads are cheap and sufficient here: no child processes, no
    // browser globals.
    pool: "threads",
    // Tests import { describe, it, expect } explicitly from "vitest".
    globals: false,
    // Keep test files deterministic and sequential: the IndexedDB suite owns a
    // shared fake database and must not race itself.
    sequence: {
      concurrent: false,
    },
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
