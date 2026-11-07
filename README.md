# SnapDraw

**Capture your screen → annotate it instantly with Excalidraw → copy or download the finished PNG.**

SnapDraw is a lightweight Chrome extension (Manifest V3) that turns the visible browser viewport into
an editable Excalidraw canvas in a single click. No account, no upload, no backend — the screenshot,
the annotations and every asset live on your machine.

| Popup | Editor (light) |
| --- | --- |
| ![SnapDraw popup](docs/screenshots/popup-light.png) | ![SnapDraw editor in light mode](docs/screenshots/editor-light.png) |

| Editor (dark) | Capture result |
| --- | --- |
| ![SnapDraw editor in dark mode](docs/screenshots/editor-dark.png) | ![Exported annotated PNG](docs/screenshots/export-annotated.png) |

*Screenshots and the exported PNG above are produced automatically by the end-to-end test suite.*

---

## Table of contents

- [Features](#features)
- [How it works](#how-it-works)
- [Quick start](#quick-start)
- [Using SnapDraw](#using-snapdraw)
- [Scripts](#scripts)
- [Project structure](#project-structure)
- [Architecture](#architecture)
- [Local-only guarantees](#local-only-guarantees)
- [Permissions](#permissions)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)
- [Extending SnapDraw (Version 2)](#extending-snapdraw-version-2)
- [Tech stack & credits](#tech-stack--credits)
- [License](#license)

---

## Features

- **One click to capture** – the popup is a single primary action; the visible viewport is captured
  with `chrome.tabs.captureVisibleTab()` in PNG at its native resolution.
- **Editor opens automatically** – a new tab loads the screenshot straight into an Excalidraw canvas.
- **Full Excalidraw toolset** – freehand, arrows, lines, rectangles, diamonds, ellipses, text, colors,
  stroke styles/widths, fill, opacity, layers, zoom/pan, select/move/resize, undo/redo.
- **Screenshot is protected** – inserted as a **locked** image element at its original pixel size, so
  it cannot be moved or deleted by accident. Unlock it from **More → Unlock screenshot** when needed.
- **Copy to clipboard** – exports the annotated PNG and writes it to the clipboard (Slack, Discord,
  mail, docs…), with a confirmation toast and graceful error handling.
- **Download PNG** – full-quality 1:1 export (screenshot + annotations + breathing-room padding).
- **Multi-capture safe** – every capture gets a UUID session; several editor tabs never mix data.
- **Light & dark** – follows the OS colour scheme; the exported PNG is always light/white.
- **Friendly failures** – restricted pages (`chrome://`, Web Store, other extensions, DevTools) get
  an explanation and a retry path instead of a cryptic Chrome error.
- **Keyboard shortcut** – `Ctrl+Shift+S` (`⌘+Shift+S` on macOS), configurable in Chrome.
- **100% local** – no requests, no analytics, no fonts from a CDN. Everything is bundled.

## How it works

```text
  toolbar click / shortcut
          │
          ▼
 ┌────────────────────┐   runtime message    ┌─────────────────────────┐
 │  Popup (React)     │ ───────────────────▶ │  Background service     │
 │  Capture button    │                      │  worker (MV3)           │
 └────────────────────┘                      │  · active tab + URL     │
                                             │  · captureVisibleTab    │
                                             │  · data URL → Blob      │
                                             │  · IndexedDB session    │
                                             └───────────┬─────────────┘
                                                         │ chrome.tabs.create(
                                                         │   editor.html?session=<uuid>)
                                                         ▼
                                             ┌─────────────────────────┐
                                             │  Editor tab (React)     │
                                             │  · read Blob → data URL │
                                             │  · delete temp record   │
                                             │  · Excalidraw initialData│
                                             │  · copy / download PNG  │
                                             └─────────────────────────┘
```

The screenshot never travels through URL query strings or cross-tab in-memory variables: the service
worker writes a `Blob` into IndexedDB and the editor reads it from the same extension origin. The
record is deleted as soon as the editor has decoded it, and a 10-minute TTL sweep removes anything
that was never consumed.

## Quick start

### Prerequisites

- **Node.js 22.12+** (Vite 8 requirement) and npm 10+
- **Google Chrome 116+** (Manifest V3 minimum); Chrome 137+ or Chromium if you want to run the E2E suite

### Build & install

```bash
git clone <your-fork-url> snapdraw
cd snapdraw
npm install
npm run build          # typecheck + vite build + build validation → dist/
```

Then:

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select the generated **`dist/`** folder.
4. Pin SnapDraw to the toolbar (puzzle-piece menu → pin).

### Development

```bash
npm run dev     # vite build --watch --mode development (unminified, source maps)
```

Because Chrome extension pages cannot use a dev server with remote/HMR scripts, `npm run dev`
rebuilds `dist/` on change. After a rebuild, click the **reload** icon for SnapDraw on
`chrome://extensions` (or press `Ctrl+R` on that page) and reopen the popup/editor tab.

`npm run preview` starts a plain Vite dev server for UI work: the popup renders in "preview mode"
and the editor shows its error state, since `chrome.*` APIs are unavailable outside the extension.

## Using SnapDraw

1. Open any normal website.
2. Click the SnapDraw icon → **Capture Screenshot** (or press `Ctrl+Shift+S` / `⌘+Shift+S`).
3. The editor tab opens with the screenshot centred and ready to annotate.
4. Annotate with the Excalidraw toolbar on top.
5. **Copy Image** and paste anywhere, or **Download** to save `<document-name>.png`.
6. The **More** menu has *Reset view*, *Clear annotations*, *Lock/Unlock screenshot* and *About*.

The pointer is the selection tool. Keyboard shortcuts from Excalidraw apply (`1`–`8` / `r`, `o`,
`a`, `t`, `l`, `p`, `d`, `z` for tools; `Ctrl/⌘+Z`, `Shift+Ctrl/⌘+Z` for undo/redo; space-drag to pan).

Change the capture shortcut at `chrome://extensions/shortcuts` (SnapDraw → *Capture the visible
screen…*). The popup always shows the shortcut that is actually registered.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run build` | Copies Excalidraw's fonts into `public/fonts`, typechecks, builds the extension into `dist/`, validates the output. |
| `npm run build:only` | Same as `build` without the TypeScript check (faster iteration). |
| `npm run dev` | Watch-mode development build. |
| `npm run typecheck` | `tsc --noEmit` across the whole project. |
| `npm test` | Vitest unit + invariant suite (147 tests: storage, image conversion, messaging, manifest, capture service, export service). |
| `npm run test:e2e` | Drives the **built** extension in headless Chrome via CDP: capture → editor → annotate → undo/redo → clipboard → download → multi-capture isolation → restricted-page errors → local-only audit. Writes `test-results/e2e-report.json` and `docs/screenshots/*.png`. |
| `npm run verify` | `build` + `test` + `test:e2e`. |
| `npm run icons` | Regenerates `public/icons/icon{16,48,128}.png` from the logo geometry (no image dependency). |
| `npm run clean` | Removes `dist/`. |

## Project structure

```text
snapdraw/
├── public/
│   ├── manifest.json               # MV3 manifest (stable "key", strict CSP)
│   ├── icons/                      # icon16/48/128.png (generated)
│   ├── excalidraw-asset-path.js    # classic script: local font base + CDN fallback rewrite
│   └── fonts/                      # Excalidraw fonts, copied at build time (gitignored)
├── src/
│   ├── background/service-worker.ts
│   ├── popup/                      # Popup.tsx, popup.css, useCapture.ts, shortcut.ts, components/
│   ├── editor/                     # Editor.tsx, EditorCanvas.tsx, EditorHeader.tsx, editor.css,
│   │                               # excalidrawActions.ts, useColorScheme.ts, icons.tsx
│   ├── components/                 # Button, Toast, Logo (shared primitives)
│   ├── services/                   # screenshot, image, storage, export, clipboard, share
│   ├── utils/                      # messaging, image-conversion
│   ├── types/                      # shared contracts + Excalidraw export type shim
│   └── styles/global.css           # design tokens + shared component styles
├── tests/                          # Vitest suites
├── scripts/                        # build/validation/E2E/icon pipelines
├── docs/screenshots/               # generated screenshots used in this README
├── vite.config.ts                  # multi-entry MV3 build (popup, editor, service worker)
├── tsconfig.json
└── package.json
```

## Architecture

### Extension components

| Component | Responsibility |
| --- | --- |
| **Popup** (`src/popup/`) | Renders the single capture action, live shortcut hint, local-only trust copy and inline error states. Sends `{ type: "CAPTURE_SCREENSHOT" }` to the service worker. |
| **Service worker** (`src/background/`) | Resolves the active tab, rejects restricted pages, captures the viewport, stores the screenshot, opens the editor tab, and handles the keyboard command. When a keyboard capture fails there is no popup to show the error, so the worker flags the toolbar icon (`!` badge + tooltip) and opens a short explanation tab. |
| **Screenshot service** (`src/services/screenshot.service.ts`) | The capture pipeline itself; pure helpers (`classifyTabUrl`, `buildScreenshotName`, `toErrorPayload`) are unit-tested. |
| **Editor** (`src/editor/`) | Loads the capture from IndexedDB, deletes the temporary record, builds the Excalidraw scene, provides header actions (copy/download/share/more), loading and error screens. |
| **Excalidraw integration** (`src/editor/EditorCanvas.tsx`, `excalidrawActions.ts`) | One locked image element at natural pixel size + `files` map, `fitToContent` on mount, scene updates for lock/clear, PNG export helpers. |
| **Services** (`src/services/`) | `storage` (IndexedDB), `image` (decode/encode), `export` (PNG blob + download), `clipboard`, `share` (v2 provider registry). |

### Image transfer (no cross-tab memory, no giant URLs)

- Database: **IndexedDB `snapdraw`**, object store `screenshots` (keyPath `id`, index on `createdAt`).
- The service worker stores the PNG as a real `Blob` (`getImageDimensions` uses `createImageBitmap`).
- The editor tab is opened at `src/editor/editor.html?session=<uuid>`; it loads the record, converts it
  to a data URL for Excalidraw's `BinaryFiles`, then deletes the record.
- Any record older than `SESSION_TTL_MS` (10 minutes) is purged on install, startup and after captures.

### Excalidraw integration notes

- Package: `@excalidraw/excalidraw@0.18.1`, React 18.
- `window.EXCALIDRAW_ASSET_PATH` points at the extension's own `fonts/` folder. The classic
  `public/excalidraw-asset-path.js` script runs before the module bundle (Excalidraw reads the value
  at module init) and also rewrites Excalidraw's built-in CDN fallback URLs to local copies. The
  extension's CSP is the final backstop: no remote font can load even if that changes upstream.
- `UIOptions.canvasActions` disables Excalidraw's own export/load/save menus so SnapDraw's header is
  the only source of truth for those actions; the full drawing toolbar stays untouched.
- Excalidraw 0.18 exposes no imperative `undo()`/`redo()`, so the header buttons replay the editor's
  own `Ctrl/⌘+Z`/`Shift+Ctrl/⌘+Z` keyboard action on the Excalidraw container
  (`src/editor/excalidrawActions.ts`). Pressing the keys directly works too.
- The screenshot element uses its natural pixel dimensions and is fitted to the viewport with
  `scrollToContent(..., { fitToContent: true })`, so the exported PNG is 1:1 with the capture.
- Export uses `exportToBlob` with `exportScale: 1`, `exportBackground: true`, white background and
  16px padding (imported in `src/services/export.service.ts`).

## Local-only guarantees

SnapDraw is designed so that no byte of your screen content can leave the machine:

- **No backend, no accounts, no analytics, no telemetry, no external requests in `src/`.**
- **Screenshots live in IndexedDB** inside your Chrome profile and are deleted after the editor loads
  them. Sessions that are never consumed expire after 10 minutes.
- **All Excalidraw fonts are bundled** (`npm run build` copies them from the installed package into
  `public/fonts`, ~12 MB). Nothing is fetched from `esm.sh` or any other CDN at runtime.
- **Strict Manifest V3 CSP** on every extension page:

  ```text
  default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
  img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' data: blob:;
  media-src 'self' blob:; worker-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'
  ```

  Remote scripts, fonts, images, media and network connections are blocked by Chrome itself.
- The **only** file that ever leaves the extension is a PNG you explicitly download or copy.
- `npm run build` fails validation if the manifest gains extra permissions, host permissions,
  content scripts, remote URLs in extension pages, or loses the local-only CSP directives
  (`scripts/validate-build.mjs`).

## Permissions

Only two permissions are requested, and there are **no host permissions**:

| Permission | Why it is needed |
| --- | --- |
| `activeTab` | Grants one-time access to the tab the user just clicked on. `chrome.tabs.captureVisibleTab()` requires it (or broad host permissions we deliberately avoid), and it lets the worker read the tab's URL/title to produce a friendly name and reject restricted pages. Granted by the toolbar popup click and by the keyboard command. |
| `clipboardWrite` | Allows the editor to put the annotated PNG on the clipboard. |

Persistence uses **IndexedDB**, so no `storage` permission is needed. Tabs are opened with
`chrome.tabs.create` (no permission required) and the editor does not need `scripting`.

Chrome refuses to capture a handful of protected pages. SnapDraw detects these up front and explains
the restriction instead of failing with a raw Chrome error: `chrome://` / `chrome-untrusted://` /
`edge://` / `about:` / `view-source:` pages, the Chrome Web Store, DevTools, and other extensions'
pages.

## Testing

### Unit & invariant tests (`npm test`)

147 tests across six suites, no network and no real Chrome:

- `tests/storage.test.ts` – IndexedDB round-trips (multi-MB `Blob` byte-exact), isolation of three
  concurrent sessions, metadata listing, TTL purge.
- `tests/image-conversion.test.ts` – data-URL ↔ Blob conversion, `fitWithin`, `formatBytes`,
  dimension-decoding failure path.
- `tests/messaging.test.ts` – message contracts, URL/session parsing, `requestCapture` error
  normalisation, service-worker listener behaviour (including synchronous throws).
- `tests/manifest.test.ts` – MV3 shape, exact permission set, no host permissions/content scripts,
  local-only CSP, icon files, command binding.
- `tests/screenshot.service.test.ts` – URL classification (22 cases), naming, Chrome error mapping,
  every capture failure path plus the full success path against mocked `chrome` + fake-indexeddb.
- `tests/export.service.test.ts` – filename sanitising, pre-flight size guards, error mapping,
  download guard.

### End-to-end tests (`npm run test:e2e`)

The E2E harness launches real headless Chrome, installs the **built** extension via the DevTools
`Extensions` domain, and drives the actual UX. It requires **Chrome 137+** (branded Chrome ignores
`--load-extension` since 137; the harness uses the CDP extension API instead) or Chromium/Chrome for
Testing. Pass `--chrome="<path>"` if autodetection fails; use `--headed --keep` to watch a run and
keep its temp profile.

It verifies (49 checks, all driven through real input events and real downloads):

- extension + service worker load with a stable ID (manifest `key`);
- popup renders the capture action, shortcut hint, local-only copy and version;
- one click captures a 1200×760 viewport, opens the editor tab with that session, and loads the
  screenshot into Excalidraw at exactly 1232×792 (native size + 16px padding);
- a locked screenshot survives an accidental `Delete`;
- drawing a rectangle + adding text renders both into the exported PNG; the handwriting font is
  loaded locally and **zero external resources** are requested;
- header undo returns to the untouched screenshot and redo restores the annotations;
- copy writes a real `image/png` to the clipboard (with a success toast);
- a second capture (900×600) opens its own tab, shows only its own screenshot, and leaves the first
  editor intact;
- extension pages produce the friendly restricted-page error with retry; missing/expired sessions and
  `?error=` messages show recoverable error screens;
- light + dark editor screenshots are written to `docs/screenshots/`.

Artifacts: `test-results/e2e-report.json`, `test-results/export-*.png`, `docs/screenshots/*.png`.

> The harness copies `dist/` to a temp folder and adds `host_permissions: ["<all_urls>"]` + `tabs` to
> **that copy only**, because there is no real toolbar click to grant `activeTab` in automation. The
> shipped manifest keeps its minimal permission set (and validation enforces it).

## Troubleshooting

**"Chrome doesn't allow capturing this page."**
Chrome protects internal pages. Switch to a normal `http(s)` website and capture again. The same
applies to the Chrome Web Store even though it is a normal URL.

**The keyboard shortcut does nothing.**
Another extension may own `Ctrl+Shift+S`. Assign a free combination at `chrome://extensions/shortcuts`
(SnapDraw → *Capture the visible screen…*). The popup shows the shortcut Chrome actually registered. If
the shortcut fires but capture is impossible (e.g. a `chrome://` tab is focused), SnapDraw flags the
toolbar icon with a red `!` and opens a tab explaining the restriction.

**Nothing happens / the editor says "Screenshot not found".**
Sessions expire after 10 minutes and are consumed on first load. Capture again from the toolbar. If
the editor tab was opened manually without a session, that message is expected.

**Copy Image says the clipboard is unavailable.**
Clipboard writes need a focused window and a user gesture, and some managed Chrome profiles block
them. Use **Download** instead. Reloading the extension after an update also resets clipboard grants.

**Screenshots of very large displays fail.**
Captures above 8192 px per side are rejected with a friendly error (Chrome's canvas limits). Capture a
smaller window (e.g. don't span multiple 4K monitors).

**Build fails with `spawn EPERM` / `net use` on Windows.**
That is Vite's Windows config-file real-path probe being blocked by a restrictive sandbox. Run the
build outside the sandbox, or use the native config loader:
`npx vite build --configLoader native`.

**Fonts look like a system fallback.**
Run `npm run build` (it copies Excalidraw's fonts into `public/fonts`, which is gitignored) and
reload the extension. Check `chrome://extensions` errors if a font file is missing.

**After `git clone`, the extension stops remembering my shortcut.**
The stable extension ID comes from the `key` field in `public/manifest.json`. Remove or replace that
field to get a fresh ID (Chrome derives one from the unpacked path); shortcuts, clipboard grants and
IndexedDB are tied to the ID.

**Chrome won't load `dist/`.** Make sure you selected the `dist` folder itself (the one containing
`manifest.json`), and that `npm run build` completed its validation step.

## Extending SnapDraw (Version 2)

The code is split so the roadmap can be added without reworking version 1:

- **Sharing (links, Slack, Discord, email, cloud).** `src/services/share.service.ts` already defines a
  typed `ShareProvider` interface (`id`, `label`, `isAvailable()`, `share(blob, meta)`) plus a
  registry. The header's Share action reads the registry and cleanly explains that no provider is
  available yet. Add providers (and the matching `host_permissions` / OAuth) and the UI works
  unchanged. Sharing must stay opt-in; version 1 is local-only by design.
- **Saved projects / reopening screenshots.** `src/services/storage.service.ts` holds the IndexedDB
  schema (`snapdraw` DB, version 1). Add a `projects` store in a version-2 upgrade and serialise the
  Excalidraw scene (`serializeAsJSON` + `files`) alongside the capture. `EditorCanvas.tsx` already
  builds its scene from `initialData`; feed restored data the same way.
- **Screenshot history.** `listScreenshots()` returns lightweight metadata (name, dimensions, source
  URL/title, timestamps) and can back a history UI; make retention configurable and stop deleting the
  record when the project is saved.
- **Full-page capture.** `captureVisibleViewport()` in `screenshot.service.ts` is the single entry
  point; implement scrolling + `captureVisibleTab` stitching (or `chrome.debugger` /
  `captureBeyondViewport`) behind the same `CaptureResponse` contract. The editor accepts any
  dimensions up to 8192 px per side.
- **Custom naming / multiple sessions.** The document name comes from `buildScreenshotName()` and is
  editable in the header in a future iteration; session IDs are already per-capture UUIDs.
- **More shortcuts.** Add commands to `public/manifest.json` and handle them in
  `background/service-worker.ts` next to `capture-screenshot`.

Keep the validation rules in `scripts/validate-build.mjs` in mind: new permissions or remote URLs must
be intentional and documented.

## Tech stack & credits

- [Excalidraw](https://github.com/excalidraw/excalidraw) (`@excalidraw/excalidraw@0.18.1`, MIT) – the
  entire drawing engine, UI and export pipeline. SnapDraw embeds the package; it does not fork the app.
- React 18 + TypeScript 5 (strict) + Vite 8 (Rolldown) + Manifest V3.
- Vitest + fake-indexeddb for tests; a dependency-free PNG decoder in the E2E harness.
- Logo and icons are drawn in code (`src/components/Logo.tsx`, `scripts/generate-icons.mjs`) and
  generated as real PNGs — no binary design assets from third parties.
- Excalidraw's bundled fonts are redistributed under their respective licenses as part of the
  `@excalidraw/excalidraw` package (see `node_modules/@excalidraw/excalidraw` in the build).

## License

MIT — see [LICENSE](LICENSE). SnapDraw is an independent project and is not affiliated with
Excalidraw.
