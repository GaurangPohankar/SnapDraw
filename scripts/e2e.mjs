#!/usr/bin/env node
/**
 * SnapDraw end-to-end verification harness.
 *
 * Drives the real built extension in headless Chrome over the DevTools protocol
 * and checks the complete Version 1 promise: capture → transfer → editor →
 * annotate → undo/redo → copy → download, plus multi-capture isolation,
 * restricted-page errors, local-only networking and the self-hosted fonts.
 *
 * Requirements
 *   - `npm run build` produced dist/
 *   - Chrome 137+ (uses the CDP `Extensions` domain because branded Chrome no
 *     longer honours --load-extension). Chromium / Chrome for Testing work too.
 *   - Windows, macOS or Linux; pass --chrome="<path>" if autodetection fails.
 *
 * Test-only manifest tweaks: the copy of dist/ used by this harness gets
 * `host_permissions: ["<all_urls>"]` and the `tabs` permission because there is
 * no real toolbar click to grant activeTab to an automated run. The shipped
 * manifest is never modified.
 *
 * Usage:
 *   npm run test:e2e
 *   npm run test:e2e -- --keep --headed      # keep temp dir, show the browser
 *   npm run test:e2e -- --chrome="C:\\path\\chrome.exe"
 *
 * Exit code 0 = every check passed. Artifacts land in test-results/ and
 * docs/screenshots/.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import zlib from "node:zlib";

const root = path.resolve(import.meta.dirname, "..");
const distDir = path.join(root, "dist");
const workDir = path.join(root, ".tmp-e2e");
const extDir = path.join(workDir, "extension");
const profileDir = path.join(workDir, "profile");
const downloadsDir = path.join(workDir, "downloads");
const resultsDir = path.join(root, "test-results");
const screenshotsDir = path.join(root, "docs", "screenshots");

/* -------------------------------------------------------------------------- */
/* CLI                                                                        */
/* -------------------------------------------------------------------------- */

const cli = parseCli(process.argv.slice(2));

function parseCli(argv) {
  const options = {
    keep: false,
    headed: false,
    chromePath: null,
    timeoutMs: 30_000,
  };
  for (const arg of argv) {
    if (arg === "--keep") options.keep = true;
    else if (arg === "--headed") options.headed = true;
    else if (arg.startsWith("--chrome=")) options.chromePath = arg.slice("--chrome=".length);
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: node scripts/e2e.mjs [--keep] [--headed] [--chrome=<path>] [--help]",
      );
      process.exit(0);
    }
  }
  return options;
}

/* -------------------------------------------------------------------------- */
/* Tiny test harness                                                          */
/* -------------------------------------------------------------------------- */

const checks = [];
const consoleErrors = [];

function check(name, condition, detail) {
  const status = condition ? "pass" : "fail";
  checks.push({ name, status, detail: detail === undefined ? "" : String(detail) });
  console.log(`  ${condition ? "PASS" : "FAIL"}  ${name}${condition ? "" : `  (${detail ?? ""})`}`);
  return Boolean(condition);
}

async function step(name, run) {
  const startedAt = Date.now();
  console.log(`\n▶ ${name}`);
  try {
    await run();
  } catch (error) {
    checks.push({
      name: `${name} (unexpected error)`,
      status: "fail",
      detail: error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error),
    });
    console.error(`  FAIL  ${name} threw: ${error instanceof Error ? error.message : error}`);
  }
  const elapsed = Date.now() - startedAt;
  console.log(`  done in ${elapsed}ms`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(producer, { timeoutMs = 20_000, intervalMs = 120, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await producer();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`,
  );
}

/* -------------------------------------------------------------------------- */
/* PNG decoding (for pixel assertions on exported screenshots)                */
/* -------------------------------------------------------------------------- */

function decodePng(buffer) {
  if (buffer.length < 8 || buffer.readUInt32BE(0) !== 0x89504e47) {
    throw new Error("Not a PNG file");
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idatChunks = [];

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);

    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") {
      idatChunks.push(data);
    } else if (type === "IEND") {
      break;
    }

    offset += 12 + length;
  }

  if (bitDepth !== 8 || interlace !== 0) {
    throw new Error(`Unsupported PNG (bit depth ${bitDepth}, interlace ${interlace})`);
  }

  const channelsByColorType = { 0: 1, 2: 3, 4: 2, 6: 4 };
  const channels = channelsByColorType[colorType];
  if (!channels) throw new Error(`Unsupported PNG color type ${colorType}`);

  const raw = zlib.inflateSync(Buffer.concat(idatChunks));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  const bpp = channels;
  let position = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = raw[position];
    position += 1;
    const rowStart = y * stride;
    const previousRowStart = rowStart - stride;

    for (let x = 0; x < stride; x += 1) {
      const rawByte = raw[position];
      position += 1;
      const left = x >= bpp ? pixels[rowStart + x - bpp] : 0;
      const up = y > 0 ? pixels[previousRowStart + x] : 0;
      const upLeft = y > 0 && x >= bpp ? pixels[previousRowStart + x - bpp] : 0;

      let value;
      switch (filter) {
        case 0:
          value = rawByte;
          break;
        case 1:
          value = rawByte + left;
          break;
        case 2:
          value = rawByte + up;
          break;
        case 3:
          value = rawByte + ((left + up) >> 1);
          break;
        case 4: {
          const estimate = left + up - upLeft;
          const distanceLeft = Math.abs(estimate - left);
          const distanceUp = Math.abs(estimate - up);
          const distanceUpLeft = Math.abs(estimate - upLeft);
          const predictor =
            distanceLeft <= distanceUp && distanceLeft <= distanceUpLeft
              ? left
              : distanceUp <= distanceUpLeft
                ? up
                : upLeft;
          value = rawByte + predictor;
          break;
        }
        default:
          throw new Error(`Unsupported PNG filter ${filter}`);
      }

      pixels[rowStart + x] = value & 0xff;
    }
  }

  return { width, height, channels, pixels };
}

/** Counts magenta / teal / dark pixels in a decoded PNG (subsampled). */
function analyzeColors(image, stepPx = 2) {
  const counts = { magenta: 0, teal: 0, dark: 0, white: 0, sampled: 0 };
  const { width, height, channels, pixels } = image;

  for (let y = 0; y < height; y += stepPx) {
    for (let x = 0; x < width; x += stepPx) {
      const index = (y * width + x) * channels;
      const r = pixels[index];
      const g = pixels[index + 1] ?? 0;
      const b = pixels[index + 2] ?? 0;
      const a = channels === 4 ? pixels[index + 3] : 255;
      if (a < 200) continue;

      counts.sampled += 1;
      if (r >= 200 && g <= 90 && b >= 200) counts.magenta += 1;
      else if (r <= 70 && g >= 140 && b >= 110) counts.teal += 1;
      else if (r <= 70 && g <= 70 && b <= 70) counts.dark += 1;
      else if (r >= 240 && g >= 240 && b >= 240) counts.white += 1;
    }
  }

  return counts;
}

/* -------------------------------------------------------------------------- */
/* DevTools protocol client                                                   */
/* -------------------------------------------------------------------------- */

class CdpConnection {
  constructor(webSocketUrl) {
    this.socket = new WebSocket(webSocketUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.eventListeners = new Set();
    this.closed = false;

    this.ready = new Promise((resolve, reject) => {
      this.socket.onopen = () => resolve();
      this.socket.onerror = () => reject(new Error("Could not open the DevTools websocket"));
    });

    this.socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) {
          const error = new Error(`${message.error.message} (${message.error.code})`);
          error.cdpCode = message.error.code;
          reject(error);
        } else {
          resolve(message.result);
        }
        return;
      }
      for (const listener of this.eventListeners) {
        try {
          listener(message);
        } catch {
          // Listener errors must never break the RPC channel.
        }
      }
    };

    this.socket.onclose = () => {
      this.closed = true;
      for (const { reject } of this.pending.values()) {
        reject(new Error("DevTools connection closed"));
      }
      this.pending.clear();
    };
  }

  onEvent(listener) {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  async send(method, params = {}, sessionId) {
    await this.ready;
    if (this.closed) throw new Error("DevTools connection is closed");
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.socket.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  close() {
    try {
      this.socket.close();
    } catch {
      // Already closed.
    }
  }
}

class Browser {
  constructor(connection) {
    this.connection = connection;
    this.targets = new Map();
  }

  static async connect(webSocketUrl) {
    const connection = new CdpConnection(webSocketUrl);
    const browser = new Browser(connection);
    await connection.ready;
    connection.onEvent((message) => {
      if (message.method === "Target.targetCreated" || message.method === "Target.targetInfoChanged") {
        browser.targets.set(message.params.targetInfo.targetId, message.params.targetInfo);
      } else if (message.method === "Target.targetDestroyed") {
        browser.targets.delete(message.params.targetId);
      } else if (message.method === "Runtime.exceptionThrown") {
        consoleErrors.push(
          message.params.exceptionDetails?.exception?.description ??
            message.params.exceptionDetails?.text ??
            "uncaught exception",
        );
      } else if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
        consoleErrors.push(
          message.params.args
            .map((arg) => arg.value ?? arg.description ?? arg.type)
            .join(" "),
        );
      }
    });
    await connection.send("Target.setDiscoverTargets", { discover: true });
    const { targetInfos } = await connection.send("Target.getTargets");
    for (const info of targetInfos) browser.targets.set(info.targetId, info);
    return browser;
  }

  send(method, params, sessionId) {
    return this.connection.send(method, params, sessionId);
  }

  async attach(targetId) {
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
    return sessionId;
  }

  async evaluate(sessionId, expression) {
    const result = await this.send(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true, userGesture: true },
      sessionId,
    );
    if (result.exceptionDetails) {
      const description =
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
      throw new Error(`Page evaluation failed: ${description}`);
    }
    return result.result?.value;
  }

  findTarget(predicate) {
    for (const info of this.targets.values()) {
      if (predicate(info)) return info;
    }
    return null;
  }

  async waitForTarget(predicate, label) {
    return waitFor(
      () => {
        const found = this.findTarget(predicate);
        return found ?? null;
      },
      { label },
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Page helpers                                                               */
/* -------------------------------------------------------------------------- */

async function openPage(browser, url, { width = 1280, height = 800, activate = true } = {}) {
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const sessionId = await browser.attach(targetId);
  await browser.send("Page.enable", {}, sessionId);
  await browser.send("Runtime.enable", {}, sessionId);
  if (width && height) {
    await browser.send(
      "Emulation.setDeviceMetricsOverride",
      { width, height, deviceScaleFactor: 1, mobile: false },
      sessionId,
    );
  }
  await browser.send("Page.navigate", { url }, sessionId);
  await waitFor(
    async () => (await browser.evaluate(sessionId, "document.readyState === 'complete'")) === true,
    { label: `page load ${url}` },
  );
  if (activate) {
    await browser.send("Target.activateTarget", { targetId });
  }
  return { targetId, sessionId, url };
}

async function waitForSelector(browser, sessionId, selector, label = selector) {
  return waitFor(
    async () => (await browser.evaluate(sessionId, `Boolean(document.querySelector(${JSON.stringify(selector)}))`)) === true,
    { label },
  );
}

async function waitForSelectorGone(browser, sessionId, selector, label = selector) {
  return waitFor(
    async () => (await browser.evaluate(sessionId, `!document.querySelector(${JSON.stringify(selector)})`)) === true,
    { label },
  );
}

function extensionUrl(extensionId, pagePath) {
  return `chrome-extension://${extensionId}/${pagePath}`;
}

async function openExtensionPage(browser, extensionId, pagePath, options) {
  return openPage(browser, extensionUrl(extensionId, pagePath), options);
}

/** Clicks the popup's primary capture button (the real UI path). */
async function clickCaptureButton(browser, popup) {
  const result = await browser.evaluate(
    popup.sessionId,
    `(() => {
      const button = document.querySelector("button.sd-popup__capture");
      if (!button) return "missing";
      if (button.disabled) return "disabled";
      button.click();
      return "clicked";
    })()`,
  );
  if (result !== "clicked") throw new Error(`Capture button unavailable: ${result}`);
}

/** Waits for the editor tab the service worker opens after a capture. */
async function waitForEditorTab(browser, extensionId) {
  const editorPrefix = `chrome-extension://${extensionId}/src/editor/editor.html`;
  const target = await browser.waitForTarget(
    (info) => info.type === "page" && info.url.startsWith(editorPrefix),
    "editor tab opened by the service worker",
  );
  const parsed = new URL(target.url);
  return {
    target,
    sessionId: parsed.searchParams.get("session"),
    url: target.url,
  };
}

async function waitForEditorReady(browser, page) {
  await waitForSelector(browser, page.sessionId, ".excalidraw", "Excalidraw canvas mount");
  await waitForSelectorGone(browser, page.sessionId, ".sd-screen--loading", "loading screen to disappear");
  await waitFor(
    async () =>
      (await browser.evaluate(
        page.sessionId,
        `document.querySelector('button[aria-label="Download PNG"]')?.disabled === false`,
      )) === true,
    { label: "editor actions to become enabled", timeoutMs: 25_000 },
  );
}

const COLOR_SCAN_EXPRESSION = `(() => {
  const counts = { magenta: 0, teal: 0, dark: 0, canvases: 0 };
  for (const canvas of document.querySelectorAll("canvas")) {
    const context = canvas.getContext("2d");
    if (!context || !canvas.width || !canvas.height) continue;
    let data;
    try {
      data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    } catch (error) {
      continue;
    }
    counts.canvases += 1;
    for (let index = 0; index < data.length; index += 8) {
      const r = data[index];
      const g = data[index + 1];
      const b = data[index + 2];
      const a = data[index + 3];
      if (a < 200) continue;
      if (r >= 200 && g <= 90 && b >= 200) counts.magenta += 1;
      else if (r <= 70 && g >= 140 && b >= 110) counts.teal += 1;
      else if (r <= 70 && g <= 70 && b <= 70) counts.dark += 1;
    }
  }
  return counts;
})()`;

async function scanEditorCanvases(browser, page) {
  return browser.evaluate(page.sessionId, COLOR_SCAN_EXPRESSION);
}

/** Asserts the screenshot itself is rendered on the Excalidraw static canvas. */
async function waitForCanvasColor(browser, page, colorKey) {
  return waitFor(
    async () => {
      const counts = await scanEditorCanvases(browser, page);
      return counts[colorKey] > 200 ? counts : null;
    },
    { label: `screenshot pixels (${colorKey}) to render on the canvas`, timeoutMs: 25_000 },
  );
}

async function getSceneSummary(browser, page) {
  return browser.evaluate(
    page.sessionId,
    `(() => {
      const name = document.querySelector(".sd-header__name")?.textContent?.trim() ?? "";
      const dimensions = document.querySelector(".sd-header__dimensions")?.textContent?.trim() ?? "";
      const toolbar = Boolean(document.querySelector(".excalidraw .App-toolbar"));
      const locked = Boolean(document.querySelector('.excalidraw [title*="Locked" i]'));
      return { name, dimensions, toolbar, locked };
    })()`,
  );
}

/** Number of captures saved in IndexedDB (the local history). */
async function countStoredScreenshots(browser, sessionId) {
  return browser.evaluate(
    sessionId,
    `new Promise((resolve) => {
      const request = indexedDB.open("snapdraw");
      request.onsuccess = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains("screenshots")) { resolve(0); return; }
        const count = database.transaction("screenshots", "readonly").objectStore("screenshots").count();
        count.onsuccess = () => resolve(count.result);
        count.onerror = () => resolve(-1);
      };
      request.onerror = () => resolve(-1);
    })`,
  );
}

/* -------------------------------------------------------------------------- */
/* Input helpers                                                              */
/* -------------------------------------------------------------------------- */

async function pressKey(browser, page, key, code, virtualKeyCode) {
  const base = {
    key,
    code,
    windowsVirtualKeyCode: virtualKeyCode,
    nativeVirtualKeyCode: virtualKeyCode,
  };
  await browser.send("Input.dispatchKeyEvent", { ...base, type: "rawKeyDown" }, page.sessionId);
  await browser.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" }, page.sessionId);
}

async function clickAt(browser, page, x, y) {
  await browser.send(
    "Input.dispatchMouseEvent",
    { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 },
    page.sessionId,
  );
  await browser.send(
    "Input.dispatchMouseEvent",
    { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 },
    page.sessionId,
  );
}

async function dragFromTo(browser, page, from, to) {
  await browser.send(
    "Input.dispatchMouseEvent",
    { type: "mousePressed", x: from.x, y: from.y, button: "left", buttons: 1, clickCount: 1 },
    page.sessionId,
  );
  const steps = 8;
  for (let stepIndex = 1; stepIndex <= steps; stepIndex += 1) {
    const x = from.x + ((to.x - from.x) * stepIndex) / steps;
    const y = from.y + ((to.y - from.y) * stepIndex) / steps;
    await browser.send(
      "Input.dispatchMouseEvent",
      { type: "mouseMoved", x, y, button: "left", buttons: 1 },
      page.sessionId,
    );
    await sleep(16);
  }
  await browser.send(
    "Input.dispatchMouseEvent",
    { type: "mouseReleased", x: to.x, y: to.y, button: "left", buttons: 0, clickCount: 1 },
    page.sessionId,
  );
}

async function clickButtonByAriaLabel(browser, page, ariaLabel) {
  const result = await browser.evaluate(
    page.sessionId,
    `(() => {
      const button = document.querySelector('button[aria-label=' + ${JSON.stringify(JSON.stringify(ariaLabel))} + ']');
      if (!button) return "missing";
      if (button.disabled) return "disabled";
      button.click();
      return "clicked";
    })()`,
  );
  if (result !== "clicked") {
    throw new Error(`Button "${ariaLabel}" could not be clicked: ${result}`);
  }
}

/**
 * Real mouse click on a selector's centre.
 *
 * Chrome blocks *scripted* downloads after the first one ("automatic downloads"
 * policy), so the download button must be clicked with genuine input events.
 */
async function clickSelectorWithMouse(browser, page, selector) {
  const point = await browser.evaluate(
    page.sessionId,
    `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`,
  );
  if (!point) throw new Error(`Cannot click ${selector}: element not visible`);

  await browser.send(
    "Input.dispatchMouseEvent",
    { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1 },
    page.sessionId,
  );
  await browser.send(
    "Input.dispatchMouseEvent",
    { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1 },
    page.sessionId,
  );
}

/** Forces the editor's light/dark media query (the editor follows the OS theme). */
async function setColorScheme(browser, sessionId, scheme) {
  await browser.send(
    "Emulation.setEmulatedMedia",
    { features: [{ name: "prefers-color-scheme", value: scheme }] },
    sessionId,
  );
}

async function waitForToast(browser, page, text, timeoutMs = 15_000) {
  return waitFor(
    async () =>
      (await browser.evaluate(
        page.sessionId,
        `Array.from(document.querySelectorAll(".sd-toast__title")).some((element) =>
          element.textContent.includes(${JSON.stringify(text)}))`,
      )) === true,
    { label: `toast "${text}"`, timeoutMs },
  );
}

/* -------------------------------------------------------------------------- */
/* Downloads                                                                  */
/* -------------------------------------------------------------------------- */

async function listDownloads() {
  try {
    return (await readdir(downloadsDir)).filter((name) => !name.endsWith(".crdownload"));
  } catch {
    return [];
  }
}

/**
 * Snapshots the download directory.
 *
 * Chrome's headless download manager overwrites a file when the suggested name
 * repeats, so "new download" cannot be detected by filename alone – the
 * modification time is compared as well.
 */
async function snapshotDownloads() {
  const snapshot = new Map();
  for (const name of await listDownloads()) {
    try {
      const info = await stat(path.join(downloadsDir, name));
      snapshot.set(name, { size: info.size, mtimeMs: info.mtimeMs });
    } catch {
      // File disappeared while snapshotting.
    }
  }
  return snapshot;
}

async function waitForNewDownload(before, label) {
  return waitFor(
    async () => {
      const files = (await listDownloads()).filter((name) => name.endsWith(".png"));
      for (const name of files) {
        const file = path.join(downloadsDir, name);
        let info;
        try {
          info = await stat(file);
        } catch {
          continue;
        }
        if (info.size === 0) continue;

        const previous = before.get(name);
        const changed = !previous || info.mtimeMs > previous.mtimeMs || info.size !== previous.size;
        if (!changed) continue;

        await sleep(150);
        const again = await stat(file);
        if (again.size === info.size && again.mtimeMs === info.mtimeMs) {
          return file;
        }
      }
      return null;
    },
    { label: `PNG download (${label})`, timeoutMs: 25_000 },
  );
}

async function exportScene(browser, page, label) {
  const before = await snapshotDownloads();
  await clickSelectorWithMouse(browser, page, 'button[aria-label="Download PNG"]');
  const file = await waitForNewDownload(before, label).catch(async (error) => {
    const toasts = await browser
      .evaluate(
        page.sessionId,
        `Array.from(document.querySelectorAll(".sd-toast")).map((toast) => toast.innerText).join(" | ")`,
      )
      .catch(() => "");
    throw new Error(`${error.message}. Editor toasts: ${toasts}`);
  });
  const target = path.join(resultsDir, `${label}.png`);
  await copyFile(file, target);
  const buffer = await readFile(target);
  return {
    path: target,
    filename: path.basename(file),
    png: decodePng(buffer),
  };
}

/* -------------------------------------------------------------------------- */
/* Chrome launch                                                              */
/* -------------------------------------------------------------------------- */

function detectChromePath() {
  const candidates =
    process.platform === "win32"
      ? [
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
          "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
        ]
      : process.platform === "darwin"
        ? [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
          ]
        : [
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
          ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function launchChrome(chromePath) {
  const port = await findFreePort();

  // Pre-seed the profile so Chrome allows several programmatic downloads in one
  // session (the real UI requires a fresh gesture per download anyway, which
  // Chrome can be slow to recognise in a headless run).
  await mkdir(path.join(profileDir, "Default"), { recursive: true });
  await writeFile(
    path.join(profileDir, "Default", "Preferences"),
    JSON.stringify({
      profile: {
        default_content_setting_values: { automatic_downloads: 1 },
      },
    }),
  );

  const args = [
    ...(cli.headed ? [] : ["--headless=new"]),
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-sync",
    "--disable-features=Translate,OptimizationHints,MediaRouter",
    "--hide-scrollbars",
    "--mute-audio",
    "--force-device-scale-factor=1",
    "--enable-unsafe-extension-debugging",
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${port}`,
    "--remote-allow-origins=*",
    "--window-size=1280,800",
    "about:blank",
  ];

  const child = spawn(chromePath, args, { stdio: "ignore" });

  const version = await waitFor(
    async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`);
        if (!response.ok) return null;
        return response.json();
      } catch {
        return null;
      }
    },
    { label: "Chrome DevTools endpoint", timeoutMs: 30_000 },
  );

  return { child, port, version };
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const PAGE_FIXTURES = {
  "/magenta": `<!doctype html>
<html><head><meta charset="utf-8"><title>SnapDraw E2E – magenta</title>
<style>html,body{margin:0;height:100%;background:#ff00ff;overflow:hidden}</style></head>
<body><div style="height:100vh"></div></body></html>`,
  "/teal": `<!doctype html>
<html><head><meta charset="utf-8"><title>SnapDraw E2E – teal</title>
<style>html,body{margin:0;height:100%;background:#00c2a8;overflow:hidden}</style></head>
<body><div style="height:100vh"></div></body></html>`,
};

function startFixtureServer() {
  return new Promise((resolve) => {
    const server = http.createServer((request, response) => {
      const route = (request.url ?? "/").split("?")[0];
      const body = PAGE_FIXTURES[route];
      if (!body) {
        response.writeHead(404, { "Content-Type": "text/plain" });
        response.end("not found");
        return;
      }
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      response.end(body);
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, origin: `http://127.0.0.1:${port}`, port });
    });
  });
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

let chromeProcess = null;
let fixtureServer = null;

async function main() {
  console.log("SnapDraw end-to-end verification");
  console.log("================================");

  if (!existsSync(distDir)) {
    console.error("\ndist/ is missing. Run `npm run build` first.");
    process.exit(1);
  }

  const chromePath = cli.chromePath ?? detectChromePath();
  if (!chromePath) {
    console.error(
      "\nChrome/Edge was not found. Pass --chrome=\"<path to chrome>\" (Chrome 137+).",
    );
    process.exit(1);
  }

  const manifest = JSON.parse(await readFile(path.join(distDir, "manifest.json"), "utf8"));
  if (!manifest.key) {
    console.error("\ndist/manifest.json has no key – cannot compute a stable extension id.");
    process.exit(1);
  }

  const extensionId = [...createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest("hex")]
    .slice(0, 32)
    .map((character) => String.fromCharCode(97 + parseInt(character, 16)))
    .join("");

  await rm(workDir, { recursive: true, force: true });
  await mkdir(downloadsDir, { recursive: true });
  await mkdir(resultsDir, { recursive: true });
  await mkdir(screenshotsDir, { recursive: true });
  await cpDirectory(distDir, extDir);

  // Test-only permissions (see header comment).
  const testManifestPath = path.join(extDir, "manifest.json");
  const testManifest = JSON.parse(await readFile(testManifestPath, "utf8"));
  testManifest.host_permissions = ["<all_urls>"];
  testManifest.permissions = [...new Set([...(testManifest.permissions ?? []), "tabs"])];
  await writeFile(testManifestPath, JSON.stringify(testManifest, null, 2));

  const fontFiles = await readdir(path.join(distDir, "fonts", "Excalifont")).catch(() => []);
  const fontFile = fontFiles.find((name) => name.endsWith(".woff2")) ?? null;

  fixtureServer = await startFixtureServer();
  const launch = await launchChrome(chromePath);
  chromeProcess = launch.child;
  const browser = await Browser.connect(launch.version.webSocketDebuggerUrl);
  await browser.send("Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: downloadsDir,
    eventsEnabled: true,
  });

  console.log(`\nChrome: ${launch.version.Browser}`);
  console.log(`Extension id: ${extensionId}`);
  console.log(`Fixtures: ${fixtureServer.origin}`);

  const pages = {};
  let editorOne = null;
  let editorTwo = null;

  try {
    /* ------------------------------------------------------------------ */
    await step("Extension loads as an unpacked MV3 extension", async () => {
      const loaded = await browser.send("Extensions.loadUnpacked", { path: extDir });
      check(
        "extension id is stable (manifest key)",
        loaded?.id === extensionId,
        `loaded=${loaded?.id} expected=${extensionId}`,
      );

      const workerTarget = await browser.waitForTarget(
        (info) =>
          info.type === "service_worker" &&
          info.url === `chrome-extension://${extensionId}/background/service-worker.js`,
        "background service worker target",
      );
      check("background service worker is running", Boolean(workerTarget));
    });

    /* ------------------------------------------------------------------ */
    await step("Popup renders the one-click capture action", async () => {
      pages.popup = await openExtensionPage(browser, extensionId, "src/popup/popup.html", {
        width: 340,
        height: 640,
      });
      await waitForSelector(browser, pages.popup.sessionId, "button.sd-popup__capture");
      const popupState = await browser.evaluate(
        pages.popup.sessionId,
        `(() => {
          const button = document.querySelector("button.sd-popup__capture");
          const text = document.body.innerText;
          return {
            buttonText: button?.textContent?.trim() ?? "",
            hasShortcutHint: Boolean(document.querySelector(".sd-kbd")),
            mentionsLocal: /local|never leave|nothing is uploaded/i.test(text),
            mentionsShortcut: /shortcut|Ctrl|⌘/i.test(text),
            version: document.querySelector(".sd-popup__version")?.textContent ?? "",
            tagline: document.querySelector(".sd-popup__tagline")?.textContent?.trim() ?? "",
            hasHistory: Boolean(document.querySelector('button[aria-label="Open screenshot history"]')),
          };
        })()`,
      );
      check("primary button says Capture Screenshot", /Capture Screenshot/i.test(popupState.buttonText), popupState.buttonText);
      check("shortcut hint is rendered", popupState.hasShortcutHint === true);
      check("local-only trust copy is present", popupState.mentionsLocal === true);
      check("version footer is rendered", /^v\d+\.\d+\.\d+$/.test(popupState.version.trim()), popupState.version);
      check(
        "tagline has no dash",
        popupState.tagline === "Capture, annotate, share instantly.",
        popupState.tagline,
      );
      check("screenshot history entry point is rendered", popupState.hasHistory === true);
      pages.popupShot = await openExtensionPage(browser, extensionId, "src/popup/popup.html", {
        width: 340,
        height: 560,
        activate: false,
      });
      await waitForSelector(browser, pages.popupShot.sessionId, "button.sd-popup__capture");
      await setColorScheme(browser, pages.popupShot.sessionId, "light");
      await sleep(350);
      const shot = await browser.send(
        "Page.captureScreenshot",
        { format: "png" },
        pages.popupShot.sessionId,
      );
      await writeFile(path.join(screenshotsDir, "popup-light.png"), Buffer.from(shot.data, "base64"));
      await setColorScheme(browser, pages.popupShot.sessionId, "dark");
      await sleep(350);
      const darkShot = await browser.send(
        "Page.captureScreenshot",
        { format: "png" },
        pages.popupShot.sessionId,
      );
      await writeFile(path.join(screenshotsDir, "popup-dark.png"), Buffer.from(darkShot.data, "base64"));
      check("popup screenshot saved", existsSync(path.join(screenshotsDir, "popup-light.png")));
    });

    /* ------------------------------------------------------------------ */
    await step("Capture the visible viewport from the popup", async () => {
      pages.magenta = await openPage(browser, `${fixtureServer.origin}/magenta`, {
        width: 1200,
        height: 760,
      });
      const popup = await openExtensionPage(browser, extensionId, "src/popup/popup.html", {
        width: 340,
        height: 640,
      });
      await browser.send("Target.activateTarget", { targetId: pages.magenta.targetId });
      await sleep(400);

      await clickCaptureButton(browser, popup);

      const state = await waitFor(
        async () => {
          const popupExists = browser.targets.has(popup.targetId);
          if (!popupExists) return { closed: true };
          try {
            return await browser.evaluate(
              popup.sessionId,
              `(() => {
                const status = document.querySelector("#sd-popup-status")?.textContent ?? "";
                const error = document.querySelector(".sd-popup__error-message")?.textContent ?? "";
                return { closed: false, status, error };
              })()`,
            );
          } catch {
            return { closed: true };
          }
        },
        { label: "popup capture feedback", timeoutMs: 20_000 },
      );

      check(
        "popup reports success or closes itself",
        state.closed === true || /Editor opened|Opening the editor|Capturing/i.test(state.status ?? ""),
        JSON.stringify(state),
      );
      check("popup did not show an error", !(state.error && state.error.length > 0), state.error);

      const editor = await waitForEditorTab(browser, extensionId);
      check("editor tab opened automatically", Boolean(editor.target));
      check(
        "editor URL carries the capture session id",
        typeof editor.sessionId === "string" && editor.sessionId.length >= 8,
        editor.sessionId,
      );
      pages.editorOneTarget = editor.target;
      editorOne = { sessionId: await browser.attach(editor.target.targetId), url: editor.url };
      await browser.send("Page.enable", {}, editorOne.sessionId);
      await browser.send("Runtime.enable", {}, editorOne.sessionId);
      await setColorScheme(browser, editorOne.sessionId, "light");
      await browser.send("Target.activateTarget", { targetId: editor.target.targetId });
      await waitForEditorReady(browser, editorOne);
      check("Excalidraw editor is interactive", true);
    });

    /* ------------------------------------------------------------------ */
    await step("Screenshot is loaded from local storage into Excalidraw", async () => {
      const counts = await waitForCanvasColor(browser, editorOne, "magenta");
      check("screenshot pixels visible on canvas", counts.magenta > 200, `magenta=${counts.magenta}`);
      check("canvas is not blank", counts.canvases > 0, `canvases=${counts.canvases}`);

      const scene = await getSceneSummary(browser, editorOne);
      check("document name is shown in the header", /Screenshot/i.test(scene.name), scene.name);
      check(
        "original dimensions preserved",
        scene.dimensions.includes("1200 × 760"),
        scene.dimensions,
      );
      check("Excalidraw toolbar is present", scene.toolbar === true);

      const savedCount = await countStoredScreenshots(browser, editorOne.sessionId);
      check("capture is saved for refresh and history", savedCount >= 1, `records=${savedCount}`);

      // Refreshing the editor must bring the screenshot back – no error screen.
      await browser.send("Page.reload", { ignoreCache: true }, editorOne.sessionId);
      await waitFor(
        async () => {
          try {
            return (
              (await browser.evaluate(editorOne.sessionId, "document.readyState === 'complete'")) === true
            );
          } catch {
            return false;
          }
        },
        { label: "editor reload", timeoutMs: 30_000 },
      );
      await setColorScheme(browser, editorOne.sessionId, "light");
      await waitForEditorReady(browser, editorOne);
      const refreshedCounts = await waitForCanvasColor(browser, editorOne, "magenta");
      check(
        "refreshing the editor keeps the screenshot",
        refreshedCounts.magenta > 200,
        `magenta=${refreshedCounts.magenta}`,
      );
      const refreshErrorText = await browser.evaluate(
        editorOne.sessionId,
        `document.querySelector(".sd-screen--error")?.innerText ?? ""`,
      );
      check(
        "refresh no longer shows a missing-screenshot error",
        refreshErrorText.length === 0,
        refreshErrorText.replace(/\s+/g, " ").slice(0, 120),
      );
      const savedAfterRefresh = await countStoredScreenshots(browser, editorOne.sessionId);
      check("capture is still saved after refresh", savedAfterRefresh >= 1, `records=${savedAfterRefresh}`);

      // The screenshot must survive an accidental delete: it starts locked.
      await browser.send("Target.activateTarget", { targetId: pages.editorOneTarget.targetId });
      await clickAt(browser, editorOne, 900, 640);
      await pressKey(browser, editorOne, "Delete", "Delete", 46);
      await sleep(350);
      const lockedExport = await exportScene(browser, editorOne, "export-0-original-locked");
      const lockedColors = analyzeColors(lockedExport.png);
      check(
        "accidental Delete cannot remove the screenshot (locked by default)",
        lockedColors.magenta > 1000,
        `magenta=${lockedColors.magenta}`,
      );
      check(
        "untouched export is exactly the original viewport plus padding",
        Math.abs(lockedExport.png.width - 1232) <= 2 && Math.abs(lockedExport.png.height - 792) <= 2,
        `${lockedExport.png.width}x${lockedExport.png.height}`,
      );
    });

    /* ------------------------------------------------------------------ */
    await step("SnapDraw links replace Excalidraw links (and header layout)", async () => {
      await browser.send("Target.activateTarget", { targetId: pages.editorOneTarget.targetId });

      const header = await browser.evaluate(
        editorOne.sessionId,
        `(() => {
          const actions = document.querySelector(".sd-header__actions");
          const buttons = actions ? Array.from(actions.querySelectorAll("button")) : [];
          const help = document.querySelector(".help-icon");
          const library = Array.from(document.querySelectorAll(".sidebar-trigger.default-sidebar-trigger"));
          return {
            labels: buttons.map((button) => button.getAttribute("aria-label")),
            hasShare: buttons.some((button) => /share/i.test(button.getAttribute("aria-label") ?? "")),
            helpHidden: help ? getComputedStyle(help).display === "none" : true,
            libraryVisible: library.filter((element) => getComputedStyle(element).display !== "none").length,
          };
        })()`,
      );

      check("Share action is removed from the header", header.hasShare === false);
      check(
        "header order: undo, redo, reset view, lock, copy, download",
        JSON.stringify(header.labels) ===
          JSON.stringify([
            "Undo",
            "Redo",
            "Reset view",
            "Unlock screenshot",
            "Copy image",
            "Download PNG",
          ]),
        JSON.stringify(header.labels),
      );
      check("reset view sits next to undo/redo", header.labels.slice(0, 3).join(",") === "Undo,Redo,Reset view");
      check("screenshot lock toggle sits next to reset view", /lock screenshot/i.test(header.labels[3] ?? ""));
      check("Excalidraw help button is hidden", header.helpHidden === true);
      check("Excalidraw library button is hidden", header.libraryVisible === 0, `${header.libraryVisible} visible`);

      // Open Excalidraw's main menu – SnapDraw replaces its contents.
      const menuOpened = await browser.evaluate(
        editorOne.sessionId,
        `(() => {
          const trigger = document.querySelector(".main-menu-trigger");
          if (!trigger) return false;
          trigger.click();
          return true;
        })()`,
      );
      await sleep(450);
      const menu = await browser.evaluate(
        editorOne.sessionId,
        `(() => {
          const menu = document.querySelector(".dropdown-menu");
          if (!menu) return null;
          return {
            text: (menu.innerText || "").replace(/\\s+/g, " ").trim(),
            anchors: Array.from(menu.querySelectorAll("a[href]")).map((anchor) => anchor.getAttribute("href")),
          };
        })()`,
      );
      check("main menu opens", Boolean(menu), String(menuOpened));
      const excalidrawLinks = (menu?.anchors ?? []).filter((href) =>
        /excalidraw|discord|youtube|x\.com|twitter/i.test(href ?? ""),
      );
      check("no Excalidraw/social links in the menu", excalidrawLinks.length === 0, excalidrawLinks.join(","));
      check("menu offers SnapDraw's GitHub link", /SnapDraw on GitHub/.test(menu?.text ?? ""));
      check("menu offers About SnapDraw", /About SnapDraw/.test(menu?.text ?? ""));
      check(
        "GitHub link points at the SnapDraw repository",
        (menu?.anchors ?? []).includes("https://github.com/GaurangPohankar/SnapDraw"),
        (menu?.anchors ?? []).join(","),
      );

      // About dialog.
      await browser.evaluate(
        editorOne.sessionId,
        `(() => {
          const item = Array.from(document.querySelectorAll(".dropdown-menu button, .dropdown-menu a"))
            .find((element) => /About SnapDraw/i.test(element.textContent ?? ""));
          item?.click();
          return Boolean(item);
        })()`,
      );
      await sleep(500);
      const about = await browser.evaluate(
        editorOne.sessionId,
        `(() => {
          const dialog = document.querySelector(".sd-about__dialog");
          if (!dialog) return null;
          return {
            text: (dialog.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 220),
            anchors: Array.from(dialog.querySelectorAll("a[href]")).map((anchor) => anchor.getAttribute("href")),
            title: dialog.getAttribute("aria-labelledby"),
          };
        })()`,
      );
      check("About SnapDraw dialog opens", Boolean(about), "dialog missing");
      check(
        "About dialog links to the SnapDraw repository",
        (about?.anchors ?? []).some((href) => href === "https://github.com/GaurangPohankar/SnapDraw"),
        (about?.anchors ?? []).join(","),
      );
      check(
        "About dialog states the local-only promise",
        /local|nothing is uploaded|no account/i.test(about?.text ?? ""),
        about?.text ?? "",
      );

      // Close the dialog and any open menu.
      await pressKey(browser, editorOne, "Escape", "Escape", 27);
      await sleep(300);
      await clickAt(browser, editorOne, 640, 500);
      await sleep(300);

      // Excalidraw's "?" shortcut must no longer surface its help dialog.
      await browser.send(
        "Input.dispatchKeyEvent",
        {
          type: "rawKeyDown",
          key: "?",
          code: "Slash",
          windowsVirtualKeyCode: 191,
          nativeVirtualKeyCode: 191,
          modifiers: 8,
        },
        editorOne.sessionId,
      );
      await browser.send(
        "Input.dispatchKeyEvent",
        {
          type: "keyUp",
          key: "?",
          code: "Slash",
          windowsVirtualKeyCode: 191,
          nativeVirtualKeyCode: 191,
          modifiers: 8,
        },
        editorOne.sessionId,
      );
      await sleep(500);
      const helpDialogOpen = await browser.evaluate(
        editorOne.sessionId,
        `Boolean(document.querySelector(".HelpDialog"))`,
      );
      check("Excalidraw help dialog stays out of reach", helpDialogOpen === false);

      const aboutClosed = await browser.evaluate(
        editorOne.sessionId,
        `!document.querySelector(".sd-about__dialog")`,
      );
      check("About dialog closes", aboutClosed === true);
    });

    /* ------------------------------------------------------------------ */
    await step("Annotate: draw a rectangle", async () => {
      await browser.send("Target.activateTarget", { targetId: pages.editorOneTarget.targetId });
      await clickAt(browser, editorOne, 640, 430);
      await pressKey(browser, editorOne, "r", "KeyR", 82);
      await sleep(200);
      await dragFromTo(browser, editorOne, { x: 520, y: 320 }, { x: 760, y: 470 });
      await sleep(400);

      const exported = await exportScene(browser, editorOne, "export-1-rectangle");
      const colors = analyzeColors(exported.png);
      check(
        "exported PNG keeps the screenshot resolution",
        Math.abs(exported.png.width - (1200 + 32)) <= 2 && Math.abs(exported.png.height - (760 + 32)) <= 2,
        `${exported.png.width}x${exported.png.height}`,
      );
      check("exported PNG contains the captured screenshot", colors.magenta > 1000, `magenta=${colors.magenta}`);
      check("exported PNG contains the annotation", colors.dark > 40, `dark=${colors.dark}`);
      check(
        "download filename is derived from the document name",
        /^Screenshot-.*\.png$/.test(exported.filename),
        exported.filename,
      );
      pages.lastRectangleDarkPixels = colors.dark;
    });

    /* ------------------------------------------------------------------ */
    await step("Annotate: add text and load the self-hosted font", async () => {
      await browser.send("Target.activateTarget", { targetId: pages.editorOneTarget.targetId });
      await clickAt(browser, editorOne, 620, 600);
      await pressKey(browser, editorOne, "t", "KeyT", 84);
      await sleep(250);
      await clickAt(browser, editorOne, 600, 600);
      await waitForSelector(
        browser,
        editorOne.sessionId,
        "textarea.excalidraw-wysiwyg",
        "Excalidraw text editing surface",
      );
      await browser.send("Input.insertText", { text: "SnapDraw E2E" }, editorOne.sessionId);
      await sleep(200);
      await pressKey(browser, editorOne, "Escape", "Escape", 27);
      await waitForSelectorGone(
        browser,
        editorOne.sessionId,
        "textarea.excalidraw-wysiwyg",
        "text editing to commit",
      );
      await sleep(400);

      const exported = await exportScene(browser, editorOne, "export-2-text");
      const colors = analyzeColors(exported.png);
      check(
        "text annotation increases inked pixels",
        colors.dark > pages.lastRectangleDarkPixels,
        `before=${pages.lastRectangleDarkPixels} after=${colors.dark}`,
      );

      const fonts = await browser.evaluate(
        editorOne.sessionId,
        `(() => {
          const entries = performance.getEntriesByType("resource").map((entry) => entry.name);
          return {
            woff2: entries.filter((name) => /\.woff2($|\\?)/i.test(name)),
            external: entries.filter((name) => /^https?:\\/\\//i.test(name)),
            loadedFonts: Array.from(document.fonts)
              .filter((face) => face.status === "loaded")
              .map((face) => face.family),
          };
        })()`,
      );
      check(
        "handwriting font is loaded locally",
        fonts.loadedFonts.some((family) => /excalifont|virgil|nunito|comic/i.test(family)),
        fonts.loadedFonts.join(","),
      );
      check(
        "no external resources requested by the editor",
        fonts.external.length === 0,
        `${fonts.external.length} external request(s), e.g. ${fonts.external.slice(0, 2).join(", ")}`,
      );
      check("handwriting font is actually loaded", fonts.loadedFonts.length > 0, fonts.loadedFonts.join(","));

      if (fontFile) {
        const fetchStatus = await browser.evaluate(
          editorOne.sessionId,
          `fetch(chrome.runtime.getURL("fonts/Excalifont/" + ${JSON.stringify(fontFile)}), { cache: "no-store" })
            .then(async (response) => ({ ok: response.ok, status: response.status, size: (await response.blob()).size }))
            .catch((error) => ({ ok: false, error: String(error) }))`,
        );
        check(
          "self-hosted font file is served by the extension",
          fetchStatus.ok === true && fetchStatus.size > 1000,
          JSON.stringify(fetchStatus),
        );
      }
    });

    /* ------------------------------------------------------------------ */
    await step("Undo removes annotations, redo restores them", async () => {
      await browser.send("Target.activateTarget", { targetId: pages.editorOneTarget.targetId });

      // Excalidraw groups some interactions into several history entries (the
      // text tool in particular), so undo until the canvas is clean again.
      let undoCount = 0;
      for (; undoCount < 10; undoCount += 1) {
        const counts = await scanEditorCanvases(browser, editorOne);
        if (counts.dark < 20) break;
        await clickButtonByAriaLabel(browser, editorOne, "Undo");
        await sleep(320);
      }
      const undone = await exportScene(browser, editorOne, "export-3-undone");
      const undoneColors = analyzeColors(undone.png);
      check(
        "undo returns to the untouched screenshot",
        undoneColors.dark <= 10 && undoneColors.magenta > 1000,
        `dark=${undoneColors.dark} magenta=${undoneColors.magenta} after ${undoCount} undo click(s)`,
      );
      check(
        "screenshot dimensions unchanged after undo",
        Math.abs(undone.png.width - 1232) <= 2 && Math.abs(undone.png.height - 792) <= 2,
        `${undone.png.width}x${undone.png.height}`,
      );

      let redoCount = 0;
      for (; redoCount < 10; redoCount += 1) {
        const counts = await scanEditorCanvases(browser, editorOne);
        if (counts.dark >= 20) break;
        await clickButtonByAriaLabel(browser, editorOne, "Redo");
        await sleep(320);
      }
      const redone = await exportScene(browser, editorOne, "export-4-redone");
      const redoneColors = analyzeColors(redone.png);
      check(
        "redo restores the annotations",
        redoneColors.dark > 40,
        `dark=${redoneColors.dark} after ${redoCount} redo click(s)`,
      );
    });

    /* ------------------------------------------------------------------ */
    await step("Copy the annotated image to the clipboard", async () => {
      await browser.send("Target.activateTarget", { targetId: pages.editorOneTarget.targetId });
      try {
        await browser.send("Browser.grantPermissions", {
          origin: `chrome-extension://${extensionId}`,
          permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
        });
      } catch (error) {
        console.warn(`  (clipboard permission grant unavailable: ${error.message})`);
      }

      await clickButtonByAriaLabel(browser, editorOne, "Copy image");
      await waitForToast(browser, editorOne, "Copied to clipboard");
      check("copy shows a success notification", true);

      const clipboard = await browser.evaluate(
        editorOne.sessionId,
        `(async () => {
          try {
            const items = await navigator.clipboard.read();
            let size = 0;
            let hasPng = false;
            for (const item of items) {
              if (item.types.includes("image/png")) {
                hasPng = true;
                size = (await item.getType("image/png")).size;
              }
            }
            return { hasPng, size };
          } catch (error) {
            return { error: String(error) };
          }
        })()`,
      );
      check(
        "clipboard contains a PNG image",
        clipboard.hasPng === true && clipboard.size > 1000,
        JSON.stringify(clipboard),
      );
    });

    /* ------------------------------------------------------------------ */
    await step("Second capture stays isolated from the first", async () => {
      pages.teal = await openPage(browser, `${fixtureServer.origin}/teal`, {
        width: 900,
        height: 600,
      });
      const popup = await openExtensionPage(browser, extensionId, "src/popup/popup.html", {
        width: 340,
        height: 640,
      });
      await browser.send("Target.activateTarget", { targetId: pages.teal.targetId });
      await sleep(400);
      await clickCaptureButton(browser, popup);

      const editor = await waitFor(
        async () => {
          const editorPrefix = `chrome-extension://${extensionId}/src/editor/editor.html`;
          const candidates = [];
          for (const info of browser.targets.values()) {
            if (info.type === "page" && info.url.startsWith(editorPrefix)) candidates.push(info);
          }
          const fresh = candidates.find(
            (info) => !pages.editorOneTarget || info.targetId !== pages.editorOneTarget.targetId,
          );
          return fresh ?? null;
        },
        { label: "second editor tab", timeoutMs: 25_000 },
      );
      check("second editor tab opened", Boolean(editor));

      const secondSessionParam = new URL(editor.url).searchParams.get("session");
      editorTwo = { sessionId: await browser.attach(editor.targetId), url: editor.url };
      await browser.send("Page.enable", {}, editorTwo.sessionId);
      await browser.send("Runtime.enable", {}, editorTwo.sessionId);
      await setColorScheme(browser, editorTwo.sessionId, "light");
      await browser.send("Target.activateTarget", { targetId: editor.targetId });
      await waitForEditorReady(browser, editorTwo);

      const counts = await waitForCanvasColor(browser, editorTwo, "teal");
      check("second screenshot renders teal", counts.teal > 200, `teal=${counts.teal}`);
      check("second editor does not show the first screenshot", counts.magenta < 50, `magenta=${counts.magenta}`);

      const scene = await getSceneSummary(browser, editorTwo);
      check("second screenshot dimensions are correct", scene.dimensions.includes("900 × 600"), scene.dimensions);
      check(
        "second session id differs from the first",
        typeof secondSessionParam === "string" &&
          secondSessionParam.length > 0 &&
          secondSessionParam !== new URL(editorOne.url).searchParams.get("session"),
        `${secondSessionParam}`,
      );

      const exported = await exportScene(browser, editorTwo, "export-5-second-capture");
      const colors = analyzeColors(exported.png);
      check(
        "second export contains only the second screenshot",
        colors.teal > 800 && colors.magenta < 20,
        `teal=${colors.teal} magenta=${colors.magenta}`,
      );
      check(
        "second export dimensions match the second viewport",
        Math.abs(exported.png.width - 932) <= 2 && Math.abs(exported.png.height - 632) <= 2,
        `${exported.png.width}x${exported.png.height}`,
      );

      // The first editor is still intact.
      await browser.send("Target.activateTarget", { targetId: pages.editorOneTarget.targetId });
      const firstCounts = await scanEditorCanvases(browser, editorOne);
      check("first editor keeps its own screenshot", firstCounts.magenta > 200, `magenta=${firstCounts.magenta}`);
    });

    /* ------------------------------------------------------------------ */
    await step("Screenshot history lists saved captures and reopens them", async () => {
      const secondSessionId = new URL(editorTwo.url).searchParams.get("session");

      const openHistoryView = async () => {
        const popup = await openExtensionPage(browser, extensionId, "src/popup/popup.html", {
          width: 340,
          height: 640,
        });
        await setColorScheme(browser, popup.sessionId, "light");
        await waitForSelector(browser, popup.sessionId, 'button[aria-label="Open screenshot history"]');
        const buttonText = await browser.evaluate(
          popup.sessionId,
          `document.querySelector('button[aria-label="Open screenshot history"]')?.textContent?.trim() ?? ""`,
        );
        await browser.evaluate(
          popup.sessionId,
          `document.querySelector('button[aria-label="Open screenshot history"]')?.click(); true`,
        );
        await waitForSelector(browser, popup.sessionId, ".sd-history__list");
        return { popup, buttonText };
      };

      // The capture view shows a compact preview of the most recent captures.
      const previewPopup = await openExtensionPage(browser, extensionId, "src/popup/popup.html", {
        width: 340,
        height: 640,
      });
      await setColorScheme(browser, previewPopup.sessionId, "light");
      await waitForSelector(browser, previewPopup.sessionId, ".sd-recent");
      const preview = await browser.evaluate(
        previewPopup.sessionId,
        `(() => {
          const thumbs = Array.from(document.querySelectorAll(".sd-recent__thumb"));
          return {
            count: thumbs.length,
            names: thumbs.map((thumb) => thumb.getAttribute("aria-label") ?? ""),
            loaded: thumbs.map((thumb) => {
              const image = thumb.querySelector("img");
              return Boolean(image && image.complete && image.naturalWidth > 0);
            }),
            viewAll: document.querySelector(".sd-recent__all")?.textContent?.trim() ?? "",
          };
        })()`,
      );
      check("popup shows a recent-history preview", preview.count === 2, `thumbs=${preview.count}`);
      check(
        "recent preview thumbnails render from local storage",
        preview.loaded.every(Boolean),
        JSON.stringify(preview.loaded),
      );
      check(
        "recent preview links to the full history",
        /View all\s*·\s*2/.test(preview.viewAll),
        preview.viewAll,
      );

      const recentShot = await browser.send(
        "Page.captureScreenshot",
        { format: "png" },
        previewPopup.sessionId,
      );
      await writeFile(
        path.join(screenshotsDir, "popup-recent.png"),
        Buffer.from(recentShot.data, "base64"),
      );
      check(
        "recent preview screenshot saved",
        existsSync(path.join(screenshotsDir, "popup-recent.png")),
      );

      // Clicking a preview opens that capture directly (newest first).
      const previewTargets = new Set();
      for (const info of browser.targets.values()) {
        if (info.type === "page") previewTargets.add(info.targetId);
      }
      await browser.evaluate(
        previewPopup.sessionId,
        `document.querySelector(".sd-recent__thumb")?.click(); true`,
      );
      const fromPreview = await waitFor(
        async () => {
          for (const info of browser.targets.values()) {
            if (info.type !== "page" || previewTargets.has(info.targetId)) continue;
            if (
              info.url.startsWith(
                `chrome-extension://${extensionId}/src/editor/editor.html`,
              )
            ) {
              return info;
            }
          }
          return null;
        },
        { label: "recent preview opens an editor tab", timeoutMs: 20_000 },
      );
      const fromPreviewSession = new URL(fromPreview.url).searchParams.get("session");
      check(
        "recent preview opens the newest capture",
        fromPreviewSession === secondSessionId,
        `${fromPreviewSession} vs ${secondSessionId}`,
      );
      await browser.send("Target.closeTarget", { targetId: fromPreview.targetId });
      if (browser.targets.has(previewPopup.targetId)) {
        await browser.send("Target.closeTarget", { targetId: previewPopup.targetId });
      }

      const first = await openHistoryView();
      check(
        "history entry point shows the number of saved captures",
        first.buttonText.includes("2"),
        first.buttonText,
      );

      const history = await browser.evaluate(
        first.popup.sessionId,
        `(() => {
          const items = Array.from(document.querySelectorAll(".sd-history__item"));
          return {
            count: items.length,
            rows: items.map((item) => {
              const image = item.querySelector(".sd-history__thumb img");
              return {
                name: item.querySelector(".sd-history__name")?.textContent ?? "",
                meta: item.querySelector(".sd-history__meta")?.textContent ?? "",
                thumbLoaded: Boolean(image && image.complete && image.naturalWidth > 0),
                deleteLabel: item.querySelector(".sd-history__delete")?.getAttribute("aria-label") ?? "",
              };
            }),
          };
        })()`,
      );
      check("history lists both captures", history.count === 2, `count=${history.count}`);
      check(
        "history is ordered newest first",
        (history.rows[0]?.meta ?? "").includes("900 × 600") &&
          (history.rows[1]?.meta ?? "").includes("1200 × 760"),
        JSON.stringify(history.rows.map((row) => row.meta)),
      );
      check(
        "history thumbnails render from local storage",
        history.rows.every((row) => row.thumbLoaded === true),
        JSON.stringify(history.rows.map((row) => row.thumbLoaded)),
      );

      const historyShot = await browser.send(
        "Page.captureScreenshot",
        { format: "png" },
        first.popup.sessionId,
      );
      await writeFile(
        path.join(screenshotsDir, "popup-history.png"),
        Buffer.from(historyShot.data, "base64"),
      );
      check(
        "history screenshot saved",
        existsSync(path.join(screenshotsDir, "popup-history.png")),
      );

      // Reopen the newest capture from the history list.
      const existingTargets = new Set();
      for (const info of browser.targets.values()) {
        if (info.type === "page") existingTargets.add(info.targetId);
      }
      await browser.evaluate(
        first.popup.sessionId,
        `document.querySelector(".sd-history__item .sd-history__open")?.click(); true`,
      );
      const reopened = await waitFor(
        async () => {
          for (const info of browser.targets.values()) {
            if (info.type !== "page" || existingTargets.has(info.targetId)) continue;
            if (
              info.url.startsWith(
                `chrome-extension://${extensionId}/src/editor/editor.html`,
              )
            ) {
              return info;
            }
          }
          return null;
        },
        { label: "history row opens an editor tab", timeoutMs: 20_000 },
      );
      const reopenedSession = new URL(reopened.url).searchParams.get("session");
      check(
        "history opens the selected capture in the editor",
        reopenedSession === secondSessionId,
        `${reopenedSession} vs ${secondSessionId}`,
      );
      await browser.send("Target.closeTarget", { targetId: reopened.targetId });
      if (browser.targets.has(first.popup.targetId)) {
        await browser.send("Target.closeTarget", { targetId: first.popup.targetId });
      }

      // Delete one entry, then clear the rest.
      const second = await openHistoryView();
      await browser.evaluate(
        second.popup.sessionId,
        `document.querySelector(".sd-history__item .sd-history__delete")?.click(); true`,
      );
      await waitFor(
        async () =>
          (await browser.evaluate(
            second.popup.sessionId,
            `document.querySelectorAll(".sd-history__item").length`,
          )) === 1,
        { label: "history entry deletion", timeoutMs: 15_000 },
      );
      check("deleting a history entry removes just that capture", true);

      const remainingRow = await browser.evaluate(
        second.popup.sessionId,
        `(() => {
          const item = document.querySelector(".sd-history__item");
          return {
            name: item?.querySelector(".sd-history__name")?.textContent ?? "",
            meta: item?.querySelector(".sd-history__meta")?.textContent ?? "",
          };
        })()`,
      );
      check(
        "the remaining history entry is the older capture",
        (remainingRow.meta ?? "").includes("1200 × 760"),
        `${remainingRow.name} · ${remainingRow.meta}`,
      );

      await browser.evaluate(
        second.popup.sessionId,
        `document.querySelector(".sd-history__clear")?.click(); true`,
      );
      await sleep(200);
      await browser.evaluate(
        second.popup.sessionId,
        `document.querySelector(".sd-history__clear")?.click(); true`,
      );
      await waitForSelector(
        browser,
        second.popup.sessionId,
        ".sd-history__empty",
        "empty history state",
      );
      check("clearing the history empties the list", true);
      const remainingAfterClear = await countStoredScreenshots(
        browser,
        second.popup.sessionId,
      );
      check(
        "clearing the history removes the stored captures",
        remainingAfterClear === 0,
        `records=${remainingAfterClear}`,
      );

      await browser.send("Target.closeTarget", { targetId: second.popup.targetId });
    });

    /* ------------------------------------------------------------------ */
    await step("Restricted pages and missing sessions show friendly errors", async () => {
      // Activating an extension page makes it the active tab: capture must fail
      // with RESTRICTED_PAGE instead of a cryptic Chrome error.
      const popup = await openExtensionPage(browser, extensionId, "src/popup/popup.html", {
        width: 340,
        height: 640,
      });
      await browser.send("Target.activateTarget", { targetId: popup.targetId });
      await sleep(300);
      await clickCaptureButton(browser, popup);
      const errorText = await waitFor(
        async () =>
          browser.evaluate(
            popup.sessionId,
            `document.querySelector(".sd-popup__error-message")?.textContent ?? ""`,
          ),
        { label: "popup error state", timeoutMs: 15_000 },
      );
      check(
        "extension pages produce a friendly error",
        /extension page|captur/i.test(errorText),
        errorText,
      );
      const causes = await browser.evaluate(
        popup.sessionId,
        `Boolean(document.querySelector(".sd-popup__error-causes"))`,
      );
      check("popup lists the pages Chrome blocks", causes === true);

      const missing = await openExtensionPage(
        browser,
        extensionId,
        "src/editor/editor.html?session=00000000-0000-4000-8000-000000000000",
        { width: 1000, height: 700 },
      );
      const missingText = await waitFor(
        async () => {
          const text = await browser.evaluate(
            missing.sessionId,
            `document.querySelector(".sd-screen--error")?.innerText ?? ""`,
          );
          return text.length > 0 ? text : null;
        },
        { label: "missing session error screen", timeoutMs: 15_000 },
      );
      check(
        "missing screenshot data is handled",
        /not found|no longer available|Screenshot not found/i.test(missingText),
        missingText.replace(/\s+/g, " ").slice(0, 120),
      );

      const failedCommand = await openExtensionPage(
        browser,
        extensionId,
        "src/editor/editor.html?error=RESTRICTED_PAGE",
        { width: 1000, height: 700 },
      );
      const failureText = await waitFor(
        async () => {
          const text = await browser.evaluate(
            failedCommand.sessionId,
            `document.querySelector(".sd-screen--error")?.innerText ?? ""`,
          );
          return text.length > 0 ? text : null;
        },
        { label: "keyboard-command error screen", timeoutMs: 15_000 },
      );
      check(
        "keyboard-command failures explain the restriction",
        /can't be captured|chrome:\/\/|protected/i.test(failureText),
        failureText.replace(/\s+/g, " ").slice(0, 120),
      );
    });

    /* ------------------------------------------------------------------ */
    await step("Editor UI artifacts (light + dark)", async () => {
      await browser.send("Target.activateTarget", { targetId: pages.editorOneTarget.targetId });
      await setColorScheme(browser, editorOne.sessionId, "light");
      await sleep(500);
      const light = await browser.send(
        "Page.captureScreenshot",
        { format: "png" },
        editorOne.sessionId,
      );
      await writeFile(path.join(screenshotsDir, "editor-light.png"), Buffer.from(light.data, "base64"));

      // Menu screenshot: SnapDraw's links replace Excalidraw's.
      await browser.evaluate(
        editorOne.sessionId,
        `document.querySelector(".main-menu-trigger")?.click(); true`,
      );
      await sleep(450);
      const menuShot = await browser.send(
        "Page.captureScreenshot",
        { format: "png" },
        editorOne.sessionId,
      );
      await writeFile(path.join(screenshotsDir, "editor-menu.png"), Buffer.from(menuShot.data, "base64"));
      check("menu screenshot saved", existsSync(path.join(screenshotsDir, "editor-menu.png")));
      await pressKey(browser, editorOne, "Escape", "Escape", 27);
      await sleep(300);
      await clickAt(browser, editorOne, 640, 520);
      await sleep(300);

      await setColorScheme(browser, editorOne.sessionId, "dark");
      await sleep(800);
      const dark = await browser.send(
        "Page.captureScreenshot",
        { format: "png" },
        editorOne.sessionId,
      );
      await writeFile(path.join(screenshotsDir, "editor-dark.png"), Buffer.from(dark.data, "base64"));

      const darkTheme = await browser.evaluate(
        editorOne.sessionId,
        `Boolean(document.querySelector(".excalidraw.theme--dark"))`,
      );
      check("dark theme is applied to the canvas", darkTheme === true);
      check("editor screenshots saved", existsSync(path.join(screenshotsDir, "editor-dark.png")));

      await setColorScheme(browser, editorOne.sessionId, "light");
    });

    /* ------------------------------------------------------------------ */
    await step("No console errors during the run", async () => {
      const relevant = consoleErrors.filter(
        (message) => /snapdraw|excalidraw/i.test(message) || /error/i.test(message),
      );
      check("no uncaught console errors", relevant.length === 0, relevant.slice(0, 5).join(" | "));
    });
  } finally {
    /* -------------------------------------------------------------------- */
    const summary = summarize(checks);
    const report = {
      generatedAt: new Date().toISOString(),
      chrome: launch.version.Browser,
      extensionId,
      viewport: { first: "1200x760", second: "900x600" },
      checks,
      summary,
    };
    await writeFile(path.join(resultsDir, "e2e-report.json"), JSON.stringify(report, null, 2));

    console.log("\n================================");
    console.log(`Checks: ${summary.passed} passed, ${summary.failed} failed (${summary.total} total)`);
    console.log(`Report: ${path.relative(root, path.join(resultsDir, "e2e-report.json"))}`);
    console.log(`Screenshots: ${path.relative(root, screenshotsDir)}`);
    if (summary.failed > 0) {
      console.log("\nFailed checks:");
      for (const failure of checks.filter((entry) => entry.status === "fail")) {
        console.log(`  - ${failure.name}${failure.detail ? ` :: ${failure.detail}` : ""}`);
      }
    }

    try {
      browser.connection.close();
    } catch {
      // ignore
    }
    if (chromeProcess && !cli.keep) {
      chromeProcess.kill();
    }
    if (fixtureServer) fixtureServer.server.close();

    if (!cli.keep) {
      await sleep(400);
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    } else {
      console.log(`Temp directory kept: ${path.relative(root, workDir)}`);
    }

    process.exit(summary.failed > 0 ? 1 : 0);
  }
}

function summarize(entries) {
  const passed = entries.filter((entry) => entry.status === "pass").length;
  return { total: entries.length, passed, failed: entries.length - passed };
}

async function cpDirectory(source, target) {
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) {
      await cpDirectory(from, to);
    } else {
      await copyFile(from, to);
    }
  }
}

main().catch(async (error) => {
  console.error("\nE2E harness crashed:", error);
  if (chromeProcess) chromeProcess.kill();
  if (fixtureServer) fixtureServer.server.close();
  if (!cli.keep) {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
  process.exit(1);
});
