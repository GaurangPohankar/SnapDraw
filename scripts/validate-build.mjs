/**
 * Verifies that `dist/` is a valid loadable Chrome extension before it is
 * handed to chrome://extensions. Fails with a readable message so CI (or the
 * person building) knows exactly what is missing.
 */
import { readFile, readdir, stat, access } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const dist = path.join(root, "dist");

const problems = [];
const notes = [];

function fail(message) {
  problems.push(message);
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function unique(values) {
  return [...new Set(values)];
}

async function collectFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(full)));
    } else {
      files.push(full);
    }
  }
  return files;
}

async function main() {
  if (!(await exists(dist))) {
    fail("dist/ does not exist – run `npm run build` first.");
    report();
    return;
  }

  const manifestPath = path.join(dist, "manifest.json");
  if (!(await exists(manifestPath))) {
    fail("dist/manifest.json is missing.");
    report();
    return;
  }

  /** @type {Record<string, any>} */
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    fail(`dist/manifest.json is not valid JSON: ${error.message}`);
    report();
    return;
  }

  if (manifest.manifest_version !== 3) {
    fail("manifest_version must be 3.");
  }

  // --- Referenced extension pages -----------------------------------------
  const popupPath = manifest.action?.default_popup;
  if (!popupPath) {
    fail("action.default_popup is not set.");
  } else if (!(await exists(path.join(dist, popupPath)))) {
    fail(`action.default_popup points to a missing file: ${popupPath}`);
  }

  const serviceWorkerPath = manifest.background?.service_worker;
  if (!serviceWorkerPath) {
    fail("background.service_worker is not set.");
  } else if (!(await exists(path.join(dist, serviceWorkerPath)))) {
    fail(`background.service_worker points to a missing file: ${serviceWorkerPath}`);
  } else if (manifest.background?.type !== "module") {
    fail("background.type must be \"module\" for the Vite ES module build.");
  }

  // The editor page is opened programmatically, so it is verified explicitly.
  const editorEntry = path.join(dist, "src", "editor", "editor.html");
  if (!(await exists(editorEntry))) {
    fail("dist/src/editor/editor.html is missing (editor tab would not open).");
  }

  for (const [label, relativePath] of [
    ["video editor", ["src", "video", "video.html"]],
    ["offscreen recorder", ["src", "offscreen", "offscreen.html"]],
    ["screen recorder", ["src", "recorder", "recorder.html"]],
  ]) {
    if (!(await exists(path.join(dist, ...relativePath)))) {
      fail(`dist/${relativePath.join("/")} is missing (${label} page).`);
    }
  }

  // --- Icons --------------------------------------------------------------
  const iconSizes = ["16", "48", "128"];
  for (const size of iconSizes) {
    const iconPath = path.join(dist, "icons", `icon${size}.png`);
    if (!(await exists(iconPath))) {
      fail(`dist/icons/icon${size}.png is missing.`);
      continue;
    }
    const info = await stat(iconPath);
    if (info.size < 100) {
      fail(`dist/icons/icon${size}.png looks empty (${info.size} bytes).`);
    }
  }

  // --- Permissions --------------------------------------------------------
  const permissions = manifest.permissions ?? [];
  const allowed = new Set([
    "activeTab",
    "clipboardWrite",
    "offscreen",
    "tabCapture",
  ]);
  for (const permission of permissions) {
    if (!allowed.has(permission)) {
      fail(`Unexpected permission "${permission}" – keep the permission set minimal.`);
    }
  }
  if (Array.isArray(manifest.host_permissions) && manifest.host_permissions.length > 0) {
    fail("host_permissions must stay empty – capture/recording use activeTab + tabCapture only.");
  }
  if (manifest.content_scripts) {
    fail("content_scripts are not needed for SnapDraw v1.");
  }
  for (const required of [
    "activeTab",
    "clipboardWrite",
    "offscreen",
    "tabCapture",
  ]) {
    if (!permissions.includes(required)) {
      fail(`Missing permission "${required}".`);
    }
  }

  // --- Local-only guarantees ---------------------------------------------
  const pageCsp = manifest.content_security_policy?.extension_pages ?? "";
  for (const directive of ["default-src 'self'", "connect-src 'self'", "script-src 'self'"]) {
    if (!pageCsp.includes(directive)) {
      fail(`content_security_policy.extension_pages should contain ${directive} so no remote requests are possible.`);
    }
  }

  // --- Self hosted fonts --------------------------------------------------
  const fontsDir = path.join(dist, "fonts");
  if (!(await exists(fontsDir))) {
    fail("dist/fonts is missing – Excalidraw fonts would be fetched from a CDN.");
  } else {
    const fontFiles = await collectFiles(fontsDir);
    if (fontFiles.length < 10) {
      fail(`dist/fonts looks incomplete (${fontFiles.length} files).`);
    } else {
      notes.push(`self-hosted fonts: ${fontFiles.length} files`);
    }
  }

  // --- Every asset referenced by the HTML pages must exist ----------------
  const htmlFiles = (await collectFiles(dist)).filter((file) => file.endsWith(".html"));
  for (const htmlFile of htmlFiles) {
    const html = await readFile(htmlFile, "utf8");
    const references = unique([
      ...html.matchAll(/(?:src|href)="([^"]+)"/g),
      ...html.matchAll(/(?:src|href)='([^']+)'/g),
    ].map((match) => match[1]));

    for (const reference of references) {
      if (/^(https?:)?\/\//.test(reference) || reference.startsWith("data:")) {
        fail(
          `${path.relative(dist, htmlFile)} references a remote URL (${reference}); the extension must work offline.`,
        );
        continue;
      }
      const relative = reference.replace(/^\//, "").split("?")[0];
      if (!(await exists(path.join(dist, relative)))) {
        fail(`${path.relative(dist, htmlFile)} references a missing file: ${reference}`);
      }
    }
  }

  for (const htmlFile of htmlFiles) {
    const html = await readFile(htmlFile, "utf8");
    if (!/Content-Security-Policy/i.test(html) && /<script[^>]+src=/.test(html)) {
      // Informational only – extension pages use the manifest CSP.
      notes.push(`${path.relative(dist, htmlFile)} loads scripts via the manifest CSP`);
    }
  }

  // --- Summary ------------------------------------------------------------
  const allFiles = await collectFiles(dist);
  const totalBytes = (
    await Promise.all(allFiles.map(async (file) => (await stat(file)).size))
  ).reduce((sum, size) => sum + size, 0);

  notes.push(`${allFiles.length} files, ${(totalBytes / 1024 / 1024).toFixed(1)} MB`);

  report();

  function report() {
    if (notes.length > 0) {
      for (const note of notes) {
        console.log(`[validate-build] ${note}`);
      }
    }

    if (problems.length > 0) {
      console.error(`\n[validate-build] ${problems.length} problem(s) found:`);
      for (const problem of problems) {
        console.error(`  ✖ ${problem}`);
      }
      process.exitCode = 1;
      return;
    }

    console.log("[validate-build] ✔ dist/ is a valid SnapDraw MV3 extension.");
  }
}

await main();

