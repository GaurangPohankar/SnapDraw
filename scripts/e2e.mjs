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
const canvasWarnings = [];

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
  const counts = { magenta: 0, teal: 0, dark: 0, white: 0, yellow: 0, sampled: 0 };
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
      else if (r > 200 && g > 170 && b < 90) counts.yellow += 1;
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
      } else if (message.method === "Log.entryAdded") {
        const text = message.params.entry?.text ?? "";
        if (/willReadFrequently|Multiple readback operations/i.test(text)) {
          canvasWarnings.push(`${message.params.entry?.level ?? "warning"}: ${text}`);
        }
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

async function waitForNewDownload(before, label, extension = "png") {
  return waitFor(
    async () => {
      const files = (await listDownloads()).filter((name) =>
        name.endsWith(`.${extension}`),
      );
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
    { label: `${extension.toUpperCase()} download (${label})`, timeoutMs: 30_000 },
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
  // The yellow band gives thumbnails/exports recognisable, non-uniform content.
  "/magenta": `<!doctype html>
<html><head><meta charset="utf-8"><title>SnapDraw E2E – magenta</title>
<style>html,body{margin:0;height:100%;background:#ff00ff;overflow:hidden}
.band{height:22vh;background:#ffcc00}</style></head>
<body><div class="band"></div><div style="height:78vh"></div></body></html>`,
  "/teal": `<!doctype html>
<html><head><meta charset="utf-8"><title>SnapDraw E2E – teal</title>
<style>html,body{margin:0;height:100%;background:#00c2a8;overflow:hidden}
.band{height:22vh;background:#ffcc00}</style></head>
<body><div class="band"></div><div style="height:78vh"></div></body></html>`,
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

/**
 * Page-side script that fabricates a short WebM recording (canvas + MediaRecorder)
 * and stores it as a video history record. Used to test the video editor without
 * depending on tab capture support in headless Chrome.
 */
const SEED_VIDEO_EXPRESSION = `(async () => {
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 180;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("no 2d context");

  const candidates = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
  const mimeType = candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate));
  if (!mimeType) throw new Error("WebM recording is not supported");

  const stream = canvas.captureStream(20);
  const recorder = new MediaRecorder(stream, { mimeType });
  const chunks = [];
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };
  const stopped = new Promise((resolve) => {
    recorder.onstop = resolve;
  });
  recorder.start(100);

  const startedAt = performance.now();
  await new Promise((resolve) => {
    function frame() {
      const elapsed = performance.now() - startedAt;
      context.fillStyle = "#1d4ed8";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = "#f59e0b";
      context.fillRect(20 + (elapsed / 8) % 200, 50, 70, 70);
      if (elapsed < 1500) requestAnimationFrame(frame);
      else resolve();
    }
    frame();
  });

  recorder.stop();
  await stopped;
  stream.getTracks().forEach((track) => track.stop());

  const blob = new Blob(chunks, { type: mimeType.split(";")[0] });

  const thumbnailCanvas = document.createElement("canvas");
  thumbnailCanvas.width = 320;
  thumbnailCanvas.height = 180;
  thumbnailCanvas.getContext("2d").drawImage(canvas, 0, 0, 320, 180);
  const thumbnail = await new Promise((resolve) =>
    thumbnailCanvas.toBlob(resolve, "image/png"),
  );

  const probeUrl = URL.createObjectURL(blob);
  const probe = document.createElement("video");
  probe.preload = "metadata";
  probe.muted = true;
  probe.src = probeUrl;
  await new Promise((resolve, reject) => {
    probe.onloadedmetadata = resolve;
    probe.onerror = () => reject(new Error("could not read the recording"));
    setTimeout(resolve, 4000);
  });
  const width = probe.videoWidth || 320;
  const height = probe.videoHeight || 180;
  const durationMs =
    Number.isFinite(probe.duration) && probe.duration > 0
      ? probe.duration * 1000
      : 1500;
  URL.revokeObjectURL(probeUrl);

  const request = indexedDB.open("snapdraw");
  const database = await new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  const record = {
    id: "e2e-video-session",
    name: "Recording 2026-11-08 at 00.20.00",
    createdAt: Date.now(),
    width: width,
    height: height,
    mimeType: blob.type || "video/webm",
    size: blob.size,
    kind: "video",
    durationMs: durationMs,
    blob: blob,
    thumbnail: thumbnail,
  };

  const transaction = database.transaction("screenshots", "readwrite");
  transaction.objectStore("screenshots").put(record);
  await new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });

  return {
    id: record.id,
    width: width,
    height: height,
    durationMs: durationMs,
    size: blob.size,
  };
})()`;

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
            hasBlankCanvas: Boolean(document.querySelector('button[aria-label="Open blank canvas"]')),
          };
        })()`,
      );
      check("primary action says Capture", /^Capture$/.test(popupState.buttonText), popupState.buttonText);
      check("shortcut hint is rendered", popupState.hasShortcutHint === true);
      check("local-only trust copy is present", popupState.mentionsLocal === true);
      check("version footer is rendered", /^v\d+\.\d+\.\d+$/.test(popupState.version.trim()), popupState.version);
      check(
        "tagline has no dash",
        popupState.tagline === "Capture, annotate, share instantly.",
        popupState.tagline,
      );
      check("screenshot history entry point is rendered", popupState.hasHistory === true);
      check("popup offers a separate blank-canvas action", popupState.hasBlankCanvas === true);

      const actionStyles = await browser.evaluate(
        pages.popup.sessionId,
        `(() => {
          const cards = Array.from(document.querySelectorAll(".sd-popup__cards .sd-popup__card"));
          const rects = cards.map((card) => {
            const rect = card.getBoundingClientRect();
            const styles = getComputedStyle(card);
            return {
              top: Math.round(rect.top),
              left: Math.round(rect.left),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
              label: (card.textContent ?? "").replace(/\\s+/g, " ").trim(),
              ariaLabel: card.getAttribute("aria-label"),
              accent: styles.getPropertyValue("--sd-card-accent").trim(),
            };
          });
          return {
            count: cards.length,
            captureClass: document.querySelector("button.sd-popup__capture")?.className ?? "",
            captureText: (document.querySelector("button.sd-popup__capture")?.textContent ?? "")
              .replace(/\\s+/g, " ")
              .trim(),
            rects,
          };
        })()`,
      );
      check(
        "capture card has no helper text",
        /^Capture$/.test(actionStyles.captureText),
        actionStyles.captureText,
      );
      check(
        "popup actions form a 2×2 grid",
        actionStyles.count === 4 &&
          actionStyles.rects[0].top === actionStyles.rects[1].top &&
          actionStyles.rects[2].top === actionStyles.rects[3].top &&
          actionStyles.rects[0].left === actionStyles.rects[2].left &&
          actionStyles.rects[1].left === actionStyles.rects[3].left &&
          actionStyles.rects.every((rect) => rect.width > 100 && rect.height > 90),
        JSON.stringify(actionStyles.rects),
      );
      check(
        "popup actions use distinct accent colours",
        new Set(actionStyles.rects.map((rect) => rect.accent)).size === 4 &&
          actionStyles.captureClass.includes("sd-popup__card--capture"),
        JSON.stringify(actionStyles.rects.map((rect) => rect.accent)),
      );
      check(
        "popup action labels are concise",
        actionStyles.rects.map((rect) => rect.label).join(",") ===
          "Capture,Tab recording,Whole screen recording,Blank canvas" &&
          actionStyles.rects.map((rect) => rect.ariaLabel).join(",") ===
            "Capture Screenshot,Record this tab,Record whole screen,Open blank canvas",
        JSON.stringify(actionStyles.rects),
      );
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
      check("menu offers Canvas preferences", /Canvas preferences/.test(menu?.text ?? ""));
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
            typeIcons: document.querySelectorAll(".sd-recent__type").length,
            videoIcons: document.querySelectorAll(".sd-recent__type--video").length,
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
        "recent previews show an image type icon for screenshots",
        preview.typeIcons === 2 && preview.videoIcons === 0,
        JSON.stringify({ typeIcons: preview.typeIcons, videoIcons: preview.videoIcons }),
      );

      // Decode the first thumbnail to prove it contains the actual screenshot
      // (the fixture has a yellow band), not a blank/solid placeholder.
      const thumbnailContent = await browser.evaluate(
        previewPopup.sessionId,
        `(async () => {
          const image = document.querySelector(".sd-recent__thumb img");
          if (!image || !image.naturalWidth) return null;
          const canvas = document.createElement("canvas");
          canvas.width = image.naturalWidth;
          canvas.height = image.naturalHeight;
          const context = canvas.getContext("2d");
          context.drawImage(image, 0, 0);
          const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
          let yellow = 0;
          for (let index = 0; index < data.length; index += 16) {
            const r = data[index];
            const g = data[index + 1];
            const b = data[index + 2];
            if (r > 200 && g > 170 && b < 90) yellow += 1;
          }
          return { width: image.naturalWidth, height: image.naturalHeight, yellow };
        })()`,
      );
      check(
        "preview thumbnail shows the captured content",
        Boolean(thumbnailContent) &&
          thumbnailContent.width > 0 &&
          thumbnailContent.yellow > 0,
        JSON.stringify(thumbnailContent),
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

      const recentColors = analyzeColors(
        decodePng(Buffer.from(recentShot.data, "base64")),
      );
      check(
        "recent preview visibly shows the captured page content",
        recentColors.yellow > 20,
        `yellow=${recentColors.yellow}`,
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
            typeIcons: document.querySelectorAll(".sd-history__type").length,
            videoIcons: document.querySelectorAll(".sd-history__type--video").length,
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
        "history shows an image type icon for screenshots",
        history.typeIcons === 2 && history.videoIcons === 0,
        JSON.stringify({ typeIcons: history.typeIcons, videoIcons: history.videoIcons }),
      );
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

      // A capture saved by an older build has no thumbnail. The preview must
      // generate and persist one instead of showing a placeholder forever.
      const seeded = await browser.evaluate(
        second.popup.sessionId,
        `(async () => {
          const request = indexedDB.open("snapdraw");
          const database = await new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          const canvas = document.createElement("canvas");
          canvas.width = 400;
          canvas.height = 300;
          const context = canvas.getContext("2d");
          context.fillStyle = "#f97316";
          context.fillRect(0, 0, 400, 300);
          const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
          const record = {
            id: "legacy-session",
            name: "Legacy capture",
            createdAt: Date.now() - 10_000,
            width: 400,
            height: 300,
            mimeType: "image/png",
            size: blob.size,
            blob,
          };
          const transaction = database.transaction("screenshots", "readwrite");
          transaction.objectStore("screenshots").put(record);
          await new Promise((resolve, reject) => {
            transaction.oncomplete = resolve;
            transaction.onerror = () => reject(transaction.error);
          });
          return { size: blob.size };
        })()`,
      );
      check("legacy capture without a thumbnail was seeded", seeded.size > 0, JSON.stringify(seeded));

      await browser.evaluate(
        second.popup.sessionId,
        `document.querySelector(".sd-history__back")?.click(); true`,
      );
      await waitForSelector(browser, second.popup.sessionId, ".sd-recent");
      const healed = await waitFor(
        async () =>
          browser.evaluate(
            second.popup.sessionId,
            `(() => {
              const thumb = document.querySelector(".sd-recent__thumb");
              const image = thumb?.querySelector("img");
              return image && image.complete && image.naturalWidth > 0
                ? { loaded: true }
                : null;
            })()`,
          ),
        { label: "legacy thumbnail backfill", timeoutMs: 20_000 },
      );
      check("legacy capture gets a real thumbnail in the preview", healed.loaded === true);

      const persistedThumbnail = await browser.evaluate(
        second.popup.sessionId,
        `(async () => {
          const request = indexedDB.open("snapdraw");
          const database = await new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          const record = await new Promise((resolve, reject) => {
            const get = database
              .transaction("screenshots", "readonly")
              .objectStore("screenshots")
              .get("legacy-session");
            get.onsuccess = () => resolve(get.result);
            get.onerror = () => reject(get.error);
          });
          return {
            hasThumbnail: record?.thumbnail instanceof Blob,
            thumbnailSize: record?.thumbnail?.size ?? 0,
          };
        })()`,
      );
      check(
        "backfilled thumbnail is persisted for later popup opens",
        persistedThumbnail.hasThumbnail === true && persistedThumbnail.thumbnailSize > 0,
        JSON.stringify(persistedThumbnail),
      );

      await browser.send("Target.closeTarget", { targetId: second.popup.targetId });
    });

    /* ------------------------------------------------------------------ */
    await step("Video recording, editor and annotated export", async () => {
      // Popup exposes the recording action and Chrome exposes tabCapture.
      const popup = await openExtensionPage(browser, extensionId, "src/popup/popup.html", {
        width: 340,
        height: 640,
      });
      await waitForSelector(browser, popup.sessionId, 'button[aria-label="Record this tab"]');
      await waitForSelector(browser, popup.sessionId, 'button[aria-label="Record whole screen"]');
      const recordApi = await browser.evaluate(
        popup.sessionId,
        `({ tabCapture: typeof chrome.tabCapture?.getMediaStreamId === "function" })`,
      );
      check("popup offers tab and whole-screen recording", true);
      check("tabCapture API is available to the extension", recordApi.tabCapture === true);

      // Recording is orchestrated by the service worker + offscreen document.
      const idleRecording = await browser.evaluate(
        popup.sessionId,
        `chrome.runtime.sendMessage({ type: "RECORDING_STATUS" })`,
      );
      check(
        "service worker reports an idle recording state",
        idleRecording?.ok === true && idleRecording?.status?.recording === false,
        JSON.stringify(idleRecording),
      );

      // "Whole screen" opens the recorder window directly on Chrome's picker.
      // Headless Chrome has no real display picker, so stub getDisplayMedia with
      // a canvas stream to verify the recorder auto-starts without any click.
      const screenPopup = await openExtensionPage(browser, extensionId, "src/popup/popup.html", {
        width: 340,
        height: 640,
      });
      await waitForSelector(
        browser,
        screenPopup.sessionId,
        'button[aria-label="Record whole screen"]',
      );
      const recorderUrl = extensionUrl(extensionId, "src/recorder/recorder.html");
      const recorderPage = await openPage(browser, "about:blank", {
        width: 460,
        height: 400,
      });
      await browser.send(
        "Page.addScriptToEvaluateOnNewDocument",
        {
          source: `
            (() => {
              const canvas = document.createElement("canvas");
              canvas.width = 640;
              canvas.height = 360;
              const context = canvas.getContext("2d");
              let frame = 0;
              setInterval(() => {
                context.fillStyle = frame % 2 ? "#0f172a" : "#1e293b";
                context.fillRect(0, 0, canvas.width, canvas.height);
                context.fillStyle = "#a78bfa";
                context.fillRect(40, 40, 220, 90);
                frame += 1;
              }, 33);
              const stream = canvas.captureStream(30);
              Object.defineProperty(navigator.mediaDevices, "getDisplayMedia", {
                configurable: true,
                value: async () => stream,
              });
            })();
          `,
        },
        recorderPage.sessionId,
      );
      await browser.send(
        "Page.navigate",
        { url: recorderUrl },
        recorderPage.sessionId,
      );
      await waitForSelector(browser, recorderPage.sessionId, "#status-text");
      const recorderState = await waitFor(
        async () => {
          const state = await browser.evaluate(
            recorderPage.sessionId,
            `({
              status: document.querySelector("#status-text")?.textContent?.trim() ?? "",
              hasStart: Boolean(document.querySelector("#start")),
              retryHidden: document.querySelector("#retry")?.hidden === true,
              note: document.querySelector(".sd-rec__note")?.textContent?.trim() ?? "",
            })`,
          );
          return state.status === "Recording your screen" ? state : null;
        },
        { label: "screen recorder auto-start", timeoutMs: 15_000 },
      );
      check(
        "whole-screen recorder opens the picker and starts without a Start step",
        recorderState.hasStart === false &&
          recorderState.retryHidden === true &&
          /locally/i.test(recorderState.note),
        JSON.stringify(recorderState),
      );
      await sleep(250);
      const recorderShot = await browser.send(
        "Page.captureScreenshot",
        { format: "png" },
        recorderPage.sessionId,
      );
      await writeFile(
        path.join(screenshotsDir, "screen-recorder.png"),
        Buffer.from(recorderShot.data, "base64"),
      );
      check(
        "screen recorder screenshot saved",
        existsSync(path.join(screenshotsDir, "screen-recorder.png")),
      );
      await browser.evaluate(
        recorderPage.sessionId,
        `document.querySelector("#cancel")?.click(); true`,
      );
      await sleep(300);
      if (browser.targets.has(recorderPage.targetId)) {
        await browser.send("Target.closeTarget", { targetId: recorderPage.targetId });
      }
      if (browser.targets.has(screenPopup.targetId)) {
        await browser.send("Target.closeTarget", { targetId: screenPopup.targetId });
      }

      // Note: actually starting a capture cannot be exercised in headless Chrome
      // (no capture stream support). The recording handover is a documented
      // manual test; the editor/export/history pipeline below is verified with a
      // real WebM.

      // Seed a real WebM recording so the editor can be tested deterministically.
      const seeded = await browser.evaluate(popup.sessionId, SEED_VIDEO_EXPRESSION);
      check(
        "synthetic WebM recording created",
        seeded.size > 1000 && seeded.width > 0 && seeded.durationMs > 0,
        JSON.stringify(seeded),
      );
      await browser.send("Target.closeTarget", { targetId: popup.targetId });

      const videoUrl = `chrome-extension://${extensionId}/src/video/video.html?session=${seeded.id}`;
      const videoPage = await openPage(browser, videoUrl, { width: 1200, height: 760 });
      await setColorScheme(browser, videoPage.sessionId, "light");
      await browser.send("Log.enable", {}, videoPage.sessionId);
      await waitForSelector(browser, videoPage.sessionId, "video.sd-video__player");
      const videoState = await waitFor(
        async () =>
          browser.evaluate(
            videoPage.sessionId,
            `(() => {
              const video = document.querySelector("video.sd-video__player");
              return video && video.readyState >= 2
                ? { duration: video.duration, width: video.videoWidth, height: video.videoHeight }
                : null;
            })()`,
          ),
        { label: "video metadata", timeoutMs: 20_000 },
      );
      check(
        "video editor loads the recording",
        videoState.width > 0,
        JSON.stringify(videoState),
      );
      await waitForSelector(browser, videoPage.sessionId, ".sd-video__overlay .excalidraw");
      const overlayRect = await browser.evaluate(
        videoPage.sessionId,
        `(() => {
          const element = document.querySelector(".sd-video__overlay");
          if (!element) return null;
          const rect = element.getBoundingClientRect();
          return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
        })()`,
      );
      check(
        "annotations overlay the video area",
        Boolean(overlayRect && overlayRect.width > 100 && overlayRect.height > 60),
        JSON.stringify(overlayRect),
      );
      if (!overlayRect) {
        throw new Error("Video overlay was not rendered");
      }

      // Draw a rectangle in the middle of the video (away from Excalidraw's
      // top-left menu button so the annotation tools get the gesture).
      await browser.send("Target.activateTarget", { targetId: videoPage.targetId });
      const centerX = overlayRect.x + overlayRect.width / 2;
      const centerY = overlayRect.y + overlayRect.height / 2;
      await clickAt(browser, videoPage, centerX, centerY);
      await pressKey(browser, videoPage, "r", "KeyR", 82);
      await sleep(200);
      await dragFromTo(
        browser,
        videoPage,
        { x: centerX - 110, y: centerY - 60 },
        { x: centerX + 110, y: centerY + 60 },
      );
      await sleep(400);

      // The eyedropper reads 1x1 px from Excalidraw's canvas on every pointer
      // move; without the willReadFrequently shim Chrome logs its Canvas2D
      // advisory. Exercise the real eyedropper and assert the log stays clean.
      canvasWarnings.length = 0;
      await pressKey(browser, videoPage, "s", "KeyS", 83);
      await sleep(300);
      const eyedropperReady = await browser.evaluate(
        videoPage.sessionId,
        `Boolean(document.querySelector(".excalidraw-eye-dropper-trigger"))`,
      );
      if (eyedropperReady) {
        await browser.evaluate(
          videoPage.sessionId,
          `document.querySelector(".excalidraw-eye-dropper-trigger")?.click(); true`,
        );
        for (let step = 0; step < 5; step += 1) {
          await browser.send(
            "Input.dispatchMouseEvent",
            {
              type: "mouseMoved",
              x: centerX - 60 + step * 20,
              y: centerY - 40,
              button: "none",
            },
            videoPage.sessionId,
          );
          await sleep(80);
        }
        await sleep(300);
      }
      await pressKey(browser, videoPage, "Escape", "Escape", 27);
      await sleep(150);
      await pressKey(browser, videoPage, "Escape", "Escape", 27);
      await sleep(200);
      check(
        "eyedropper readback does not log Chrome's Canvas2D advisory",
        eyedropperReady === true && canvasWarnings.length === 0,
        eyedropperReady ? canvasWarnings[0] ?? "clean" : "eyedropper trigger not found",
      );

      // "Clear annotations" is only enabled when the scene has annotations.
      await browser.evaluate(
        videoPage.sessionId,
        `document.querySelector('button[aria-label="More actions"]')?.click(); true`,
      );
      await sleep(300);
      const videoMenu = await browser.evaluate(
        videoPage.sessionId,
        `(() => {
          const menu = document.querySelector("[role='menu']");
          if (!menu) return null;
          const items = Array.from(menu.querySelectorAll("button"));
          return items.map((item) => ({
            text: (item.textContent || "").trim(),
            disabled: item.disabled === true,
          }));
        })()`,
      );
      const clearItem = (videoMenu ?? []).find((item) => /Clear annotations/.test(item.text));
      check(
        "annotation is drawn on the video scene",
        Boolean(clearItem) && clearItem.disabled === false,
        JSON.stringify(videoMenu),
      );
      await pressKey(browser, videoPage, "Escape", "Escape", 27);
      await sleep(200);
      await clickAt(browser, videoPage, centerX, centerY + 120);
      await sleep(300);

      // Editor screenshot artifact for the docs.
      const videoShot = await browser.send(
        "Page.captureScreenshot",
        { format: "png" },
        videoPage.sessionId,
      );
      await writeFile(
        path.join(screenshotsDir, "video-editor.png"),
        Buffer.from(videoShot.data, "base64"),
      );
      check(
        "video editor screenshot saved",
        existsSync(path.join(screenshotsDir, "video-editor.png")),
      );

      // Copy the annotated current frame to the clipboard.
      try {
        await browser.send("Browser.grantPermissions", {
          origin: `chrome-extension://${extensionId}`,
          permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
        });
      } catch {
        // Already granted earlier in the run.
      }
      await clickButtonByAriaLabel(browser, videoPage, "Copy frame");
      await waitForToast(browser, videoPage, "Frame copied");
      const frameClipboard = await browser.evaluate(
        videoPage.sessionId,
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
        "video frame with annotations is copied to the clipboard",
        frameClipboard.hasPng === true && frameClipboard.size > 500,
        JSON.stringify(frameClipboard),
      );

      // Export the annotated video (real-time canvas render → WebM).
      const beforeVideo = await snapshotDownloads();
      await clickSelectorWithMouse(browser, videoPage, 'button[aria-label="Download video"]');
      const videoFile = await waitForNewDownload(beforeVideo, "annotated-video", "webm");
      const videoBytes = await readFile(videoFile);
      check(
        "annotated video exports as a WebM file",
        videoBytes.length > 1000 &&
          videoBytes[0] === 0x1a &&
          videoBytes[1] === 0x45 &&
          videoBytes[2] === 0xdf &&
          videoBytes[3] === 0xa3,
        `${videoBytes.length} bytes`,
      );
      await copyFile(videoFile, path.join(resultsDir, "annotated-video.webm"));
      await browser.send("Target.closeTarget", { targetId: videoPage.targetId });

      // History marks videos and reopens them in the video editor.
      const popup2 = await openExtensionPage(browser, extensionId, "src/popup/popup.html", {
        width: 340,
        height: 640,
      });
      await waitForSelector(browser, popup2.sessionId, ".sd-recent");
      const videoPreview = await browser.evaluate(
        popup2.sessionId,
        `({
          thumbs: document.querySelectorAll(".sd-recent__thumb").length,
          playBadge: Boolean(document.querySelector(".sd-recent__type--video")),
        })`,
      );
      check(
        "recent preview marks the recording with a video icon",
        videoPreview.thumbs >= 1 && videoPreview.playBadge === true,
        JSON.stringify(videoPreview),
      );

      const recentVideoShot = await browser.send(
        "Page.captureScreenshot",
        { format: "png" },
        popup2.sessionId,
      );
      await writeFile(
        path.join(screenshotsDir, "popup-recent-video.png"),
        Buffer.from(recentVideoShot.data, "base64"),
      );
      check(
        "video preview screenshot saved",
        existsSync(path.join(screenshotsDir, "popup-recent-video.png")),
      );

      await browser.evaluate(
        popup2.sessionId,
        `document.querySelector('button[aria-label="Open screenshot history"]')?.click(); true`,
      );
      await waitForSelector(browser, popup2.sessionId, ".sd-history__list");
      const videoRow = await browser.evaluate(
        popup2.sessionId,
        `(() => {
          const row = Array.from(document.querySelectorAll(".sd-history__item"))
            .find((element) => element.querySelector(".sd-history__type--video"));
          return row
            ? {
                meta: row.querySelector(".sd-history__meta")?.textContent ?? "",
                name: row.querySelector(".sd-history__name")?.textContent ?? "",
              }
            : null;
        })()`,
      );
      check(
        "history lists the recording with its duration",
        Boolean(videoRow) && /\d:\d\d/.test(videoRow?.meta ?? ""),
        JSON.stringify(videoRow),
      );

      const existingTargets = new Set();
      for (const info of browser.targets.values()) {
        if (info.type === "page") existingTargets.add(info.targetId);
      }
      await browser.evaluate(
        popup2.sessionId,
        `(() => {
          const row = Array.from(document.querySelectorAll(".sd-history__item"))
            .find((element) => element.querySelector(".sd-history__type--video"));
          row?.querySelector(".sd-history__open")?.click();
          return Boolean(row);
        })()`,
      );
      const reopened = await waitFor(
        async () => {
          for (const info of browser.targets.values()) {
            if (info.type !== "page" || existingTargets.has(info.targetId)) {
              continue;
            }
            if (info.url.includes("/src/video/video.html")) {
              return info;
            }
          }
          return null;
        },
        { label: "video editor reopened from history", timeoutMs: 20_000 },
      );
      check(
        "history opens the recording in the video editor",
        new URL(reopened.url).searchParams.get("session") === seeded.id,
        reopened.url,
      );
      await browser.send("Target.closeTarget", { targetId: reopened.targetId });
      if (browser.targets.has(popup2.targetId)) {
        await browser.send("Target.closeTarget", { targetId: popup2.targetId });
      }
    });

    /* ------------------------------------------------------------------ */
    await step("Blank canvas opens as a standalone editor", async () => {
      const blankPopup = await openExtensionPage(browser, extensionId, "src/popup/popup.html", {
        width: 340,
        height: 640,
      });
      await waitForSelector(
        browser,
        blankPopup.sessionId,
        'button[aria-label="Open blank canvas"]',
      );
      await clickButtonByAriaLabel(browser, blankPopup, "Open blank canvas");

      const blankTarget = await browser.waitForTarget(
        (info) =>
          info.type === "page" &&
          info.url.includes("/src/editor/editor.html") &&
          new URL(info.url).searchParams.get("blank") === "1",
        "blank canvas editor tab",
      );
      const blankSession = await browser.attach(blankTarget.targetId);
      await browser.send("Page.enable", {}, blankSession);
      await browser.send("Runtime.enable", {}, blankSession);
      const blankPage = {
        targetId: blankTarget.targetId,
        sessionId: blankSession,
        url: blankTarget.url,
      };
      await waitForSelector(browser, blankSession, ".excalidraw");
      await sleep(700);

      const blankState = await browser.evaluate(
        blankSession,
        `({
          name: document.querySelector(".sd-header__name")?.textContent?.trim() ?? "",
          meta: document.querySelector(".sd-header__dimensions")?.textContent?.trim() ?? "",
          hasLock: Boolean(document.querySelector('button[aria-label="Lock screenshot"]')),
          hasToolbar: Boolean(document.querySelector(".excalidraw .App-toolbar")),
          errorScreen: Boolean(document.querySelector(".sd-screen")),
        })`,
      );
      check(
        "blank canvas opens without a capture session",
        blankState.errorScreen === false && blankState.hasToolbar === true,
        JSON.stringify(blankState),
      );
      check(
        "blank canvas header shows an untitled document",
        blankState.name === "Untitled canvas" && blankState.meta === "Blank canvas",
        JSON.stringify(blankState),
      );
      check(
        "blank canvas has no screenshot lock control",
        blankState.hasLock === false,
        JSON.stringify(blankState),
      );

      // Drawing and exporting on the blank canvas works like a normal capture.
      await clickAt(browser, blankPage, 640, 430);
      await pressKey(browser, blankPage, "r", "KeyR", 82);
      await sleep(200);
      await dragFromTo(
        browser,
        blankPage,
        { x: 480, y: 330 },
        { x: 800, y: 520 },
      );
      await sleep(400);
      const beforeBlankDownload = await snapshotDownloads();
      await clickSelectorWithMouse(browser, blankPage, 'button[aria-label="Download PNG"]');
      const blankFile = await waitForNewDownload(
        beforeBlankDownload,
        "Untitled-canvas",
        "png",
      );
      const blankPng = await readFile(blankFile);
      check(
        "blank canvas exports a PNG",
        blankPng.length > 1000 &&
          blankPng[0] === 0x89 &&
          blankPng[1] === 0x50 &&
          blankPng[2] === 0x4e &&
          blankPng[3] === 0x47,
        `${blankPng.length} bytes`,
      );

      await browser.send("Target.closeTarget", { targetId: blankTarget.targetId });
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

      // Dark mode must not colour-shift the capture or the annotations: the
      // screenshot fixture's yellow band and magenta body have to survive the
      // editor's dark theme exactly as they do in the exported PNG.
      const darkColors = analyzeColors(decodePng(Buffer.from(dark.data, "base64")));
      check(
        "dark editor keeps the capture's true colours",
        darkColors.yellow > 500 && darkColors.magenta > 500,
        `yellow=${darkColors.yellow} magenta=${darkColors.magenta}`,
      );

      // Swatches must show the colour they will actually paint. Excalidraw
      // normally inverts swatches together with its dark canvas filter; SnapDraw
      // keeps the canvas unfiltered, so a filtered swatch would swap black and
      // white and lie about every other colour. Select the annotations with
      // Ctrl+A so the shape/properties panel (and its stroke colour trigger) is
      // mounted.
      const selectAll = {
        key: "a",
        code: "KeyA",
        windowsVirtualKeyCode: 65,
        nativeVirtualKeyCode: 65,
        modifiers: 2,
      };
      await browser.send(
        "Input.dispatchKeyEvent",
        { ...selectAll, type: "rawKeyDown" },
        editorOne.sessionId,
      );
      await browser.send(
        "Input.dispatchKeyEvent",
        { ...selectAll, type: "keyUp" },
        editorOne.sessionId,
      );
      await sleep(300);
      await browser.evaluate(
        editorOne.sessionId,
        `document.querySelector(".excalidraw .properties-trigger")?.click(); true`,
      );
      await sleep(350);
      const palette = await browser.evaluate(
        editorOne.sessionId,
        `(() => {
          const buttons = Array.from(document.querySelectorAll(".excalidraw .color-picker__button"));
          const swatches = buttons
            .map((button) => (button.style.getPropertyValue("--swatch-color") || "").trim())
            .filter(Boolean);
          const filtered = buttons
            .map((button) => getComputedStyle(button).filter)
            .filter((value) => value !== "none");
          return {
            count: buttons.length,
            hasWhite: swatches.includes("#ffffff"),
            hasBlack: swatches.includes("#1e1e1e"),
            filtered: filtered.slice(0, 3),
          };
        })()`,
      );
      check(
        "dark-mode stroke palette shows true black and white swatches",
        palette.count >= 10 && palette.hasWhite === true && palette.hasBlack === true && palette.filtered.length === 0,
        JSON.stringify(palette),
      );
      await pressKey(browser, editorOne, "Escape", "Escape", 27);
      await sleep(300);
      await clickAt(browser, editorOne, 640, 520);
      await sleep(200);

      // Canvas preferences: theme + background, persisted across reloads.
      await browser.evaluate(
        editorOne.sessionId,
        `document.querySelector(".main-menu-trigger")?.click(); true`,
      );
      await waitForSelector(browser, editorOne.sessionId, ".dropdown-menu");
      const openedPreferences = await browser.evaluate(
        editorOne.sessionId,
        `(() => {
          const item = Array.from(
            document.querySelectorAll(".dropdown-menu button, .dropdown-menu a"),
          ).find((element) => /Canvas preferences/i.test(element.textContent ?? ""));
          item?.click();
          return Boolean(item);
        })()`,
      );
      check("menu opens Canvas preferences", openedPreferences === true);
      await waitForSelector(browser, editorOne.sessionId, ".sd-preferences__dialog");
      const preferencesInfo = await browser.evaluate(
        editorOne.sessionId,
        `({
          themes: Array.from(document.querySelectorAll(".sd-preferences__theme")).map(
            (element) => (element.textContent ?? "").trim(),
          ),
          backgrounds: document.querySelectorAll(".sd-preferences__swatch").length,
        })`,
      );
      check(
        "canvas preferences offers theme and background choices",
        preferencesInfo.themes.length === 3 &&
          /System/.test(preferencesInfo.themes.join(" ")) &&
          /Light/.test(preferencesInfo.themes.join(" ")) &&
          /Dark/.test(preferencesInfo.themes.join(" ")) &&
          preferencesInfo.backgrounds >= 6,
        JSON.stringify(preferencesInfo),
      );
      const preferencesShot = await browser.send(
        "Page.captureScreenshot",
        { format: "png" },
        editorOne.sessionId,
      );
      await writeFile(
        path.join(screenshotsDir, "editor-preferences.png"),
        Buffer.from(preferencesShot.data, "base64"),
      );
      check(
        "canvas preferences screenshot saved",
        existsSync(path.join(screenshotsDir, "editor-preferences.png")),
      );
      await browser.evaluate(
        editorOne.sessionId,
        `(() => {
          Array.from(document.querySelectorAll(".sd-preferences__theme"))
            .find((element) => /Dark/.test(element.textContent ?? ""))
            ?.click();
          document.querySelector('[aria-label="White canvas background"]')?.click();
          return true;
        })()`,
      );
      await sleep(400);
      const savedPreferences = await browser.evaluate(
        editorOne.sessionId,
        `localStorage.getItem("snapdraw.canvas-preferences.v1")`,
      );
      check(
        "canvas preferences are stored locally",
        (() => {
          try {
            const parsed = JSON.parse(savedPreferences);
            return parsed.theme === "dark" && parsed.background === "#ffffff";
          } catch {
            return false;
          }
        })(),
        savedPreferences,
      );
      await browser.evaluate(
        editorOne.sessionId,
        `document.querySelector('[aria-label="Close canvas preferences"]')?.click(); true`,
      );
      await sleep(250);

      // Open a fresh blank editor tab: preferences are stored on the extension
      // origin and must survive a new tab (and a browser restart). The capture
      // sessions are gone by now (history was cleared earlier), so use a blank
      // canvas to avoid depending on a stored screenshot.
      const reopenedEditor = await openPage(
        browser,
        extensionUrl(extensionId, "src/editor/editor.html?blank=1"),
        {
          width: 1200,
          height: 760,
        },
      );
      try {
        await waitForSelector(browser, reopenedEditor.sessionId, ".excalidraw");
      } catch (error) {
        const debug = await browser.evaluate(
          reopenedEditor.sessionId,
          `({
            url: location.href,
            ready: document.readyState,
            title: document.title,
            text: (document.body?.innerText ?? "").slice(0, 500),
            hasScreen: Boolean(document.querySelector(".sd-screen")),
            scripts: document.scripts.length,
          })`,
        );
        throw new Error(`${error instanceof Error ? error.message : error} :: ${JSON.stringify(debug)}`);
      }
      await sleep(900);
      const reloadedPreferences = await browser.evaluate(
        reopenedEditor.sessionId,
        `({
          stored: localStorage.getItem("snapdraw.canvas-preferences.v1"),
          dark: Boolean(document.querySelector(".excalidraw.theme--dark")),
        })`,
      );
      check(
        "canvas preferences survive a new editor tab",
        reloadedPreferences.dark === true &&
          /"theme":"dark"/.test(reloadedPreferences.stored ?? ""),
        JSON.stringify(reloadedPreferences),
      );
      await browser.send("Target.closeTarget", { targetId: reopenedEditor.targetId });

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
